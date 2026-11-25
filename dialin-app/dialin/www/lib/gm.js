// Talks to the GaggiMate this page is served from: WebSocket requests/events,
// shot history files, and the Dial-in plugin's HTTP API.
import { parseBinaryIndex, indexToShotList } from './parseBinaryIndex.js';
import { parseBinaryShot } from './parseBinaryShot.js';

export class GaggiMate extends EventTarget {
  constructor(host = location.host) {
    super();
    this.host = host;
    this.ws = null;
    this.pending = new Map();
    this.nextRid = 1;
    this.status = null;
    this.connected = false;
    // One page load asks for the same things from several places (last shot, coffees,
    // feedback). Reading the SD card is slow, so identical GETs within a few seconds
    // share one request. Any write clears it.
    this.cache = new Map();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${this.host}/ws`);
    this.ws = ws;
    ws.onopen = () => this.setConnected(true);
    ws.onclose = () => {
      this.setConnected(false);
      for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
      this.pending.clear();
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = e => this.onMessage(e.data);
  }

  setConnected(value) {
    this.connected = value;
    this.dispatchEvent(new CustomEvent('connection', { detail: value }));
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.rid && this.pending.has(String(msg.rid))) {
      const { resolve, reject, timer } = this.pending.get(String(msg.rid));
      clearTimeout(timer);
      this.pending.delete(String(msg.rid));
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
      return;
    }
    if (msg.tp === 'evt:status') {
      this.status = { ...(this.status || {}), ...msg };
      this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
    } else if (msg.tp) {
      if (msg.tp === 'evt:history-shot-saved') this.forget('recent:'); // a new shot: re-read the index
      this.dispatchEvent(new CustomEvent(msg.tp, { detail: msg }));
    }
  }

  request(tp, payload = {}, timeoutMs = 8000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to the machine'));
    }
    const rid = String(this.nextRid++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`No answer to ${tp}`));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ tp, rid, ...payload }));
    });
  }

  // ---- machine data over WebSocket
  async listProfiles() {
    const res = await this.request('req:profiles:list');
    return res.profiles || [];
  }

  async loadProfile(id) {
    const res = await this.request('req:profiles:load', { id });
    return res.profile;
  }

  async saveNotes(shotId, notes) {
    return this.request('req:history:notes:save', { id: String(shotId), notes });
  }

  async getNotes(shotId) {
    const res = await this.request('req:history:notes:get', { id: String(shotId) });
    return res.notes || null;
  }

  // ---- shot history files
  // Share an in-flight or just-finished GET between callers (default 4 s).
  once(key, make, ttl = 4000) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = make().catch(err => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, { at: Date.now(), promise });
    return promise;
  }

  forget(prefix = '') {
    for (const k of [...this.cache.keys()]) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  // One read covers every caller: the index is small, so always ask for the most we
  // need (50) and hand out the first few when that is all someone wants.
  async recentShots(limit = 8) {
    const all = await this.once('recent', async () => {
      const res = await fetch('/api/history/recent.bin?limit=50', { cache: 'no-store' });
      if (!res.ok) throw new Error(`Shot list unavailable (${res.status})`);
      return indexToShotList(parseBinaryIndex(await res.arrayBuffer()));
    });
    return limit >= 50 ? all : all.slice(0, limit);
  }

  async loadShot(id) {
    const padded = String(id).padStart(6, '0');
    const res = await fetch(`/api/history/${padded}.slog`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Shot ${id} not found (${res.status})`);
    return parseBinaryShot(await res.arrayBuffer(), String(id));
  }

  // ---- Dial-in plugin API
  async api(method, path, body) {
    const res = await fetch(`/api/dialin${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok && !(data && Array.isArray(data.errors))) {
      throw new Error(`Request failed (${res.status})`);
    }
    return { status: res.status, ...(data || {}) };
  }

  getState() {
    return this.api('GET', '/state');
  }
  clearFeedback(shotId) {
    return this.api('POST', '/feedback', { shotId });
  }
  pluginStatus() {
    return this.api('GET', '/status');
  }
  setLimits(limits) {
    return this.api('POST', '/limits', limits);
  }
  checkProfile(profile, { salami = false } = {}) {
    return this.api('POST', '/profile/check', { profile, salami });
  }
  saveProfile(profile, select = false, { salami = false, rebuild = false } = {}) {
    return this.api('POST', '/profile/save', { profile, select, salami, rebuild });
  }

  // ---- records on the SD card (/dialin/data/<collection>/<id>.json)
  async listRecords(collection) {
    const res = await this.api('GET', `/data/${collection}`);
    return res.ids || [];
  }
  getRecord(collection, id) {
    return this.once(`rec:${collection}/${id}`, async () => {
      const res = await fetch(`/api/dialin/data/${collection}/${id}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Could not read ${collection}/${id} (${res.status})`);
      return res.json();
    });
  }
  getAll(collection) {
    return this.once(`all:${collection}`, () => this.fetchAll(collection));
  }

  async fetchAll(collection) {
    // One request for the whole collection (Dial-in plugin 0.4+); older firmware: one per record.
    try {
      const res = await fetch(`/api/dialin/data/${collection}?all=1`, { cache: 'no-store' });
      if (res.ok) {
        const all = await res.json();
        if (Array.isArray(all)) return all.filter(r => r && typeof r === 'object');
      }
    } catch {
      /* fall back below */
    }
    const ids = await this.listRecords(collection);
    const records = await Promise.all(ids.map(id => this.getRecord(collection, id).catch(() => null)));
    return records.filter(Boolean);
  }
  async putRecord(collection, id, record) {
    const res = await this.api('POST', `/data/${collection}/${id}`, record);
    if (!res.ok) throw new Error((res.errors || ['Could not save'])[0]);
    this.forget(`all:${collection}`);
    this.forget(`rec:${collection}/${id}`);
    return record;
  }
  deleteRecord(collection, id) {
    this.forget(`all:${collection}`);
    this.forget(`rec:${collection}/${id}`);
    return this.api('DELETE', `/data/${collection}/${id}`);
  }
}
