import { GaggiMate } from './lib/gm.js';
import { shotChart } from './lib/chart.js';
import { aiSettings, DEFAULT_MODEL } from './lib/ai.js';
import { initBeans, thumbSrc } from './beans.js';
import { fetchProfileThumb } from './lib/thumb.js';
import { initFeedback } from './feedback.js';

const gm = new GaggiMate();
const $ = sel => document.querySelector(sel);
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let pluginInfo = null;
let appSettings = {
  dose: 18,
  freshDays: 60,
  grinder: { brand: 'DF64', model: 'DF64 Gen 2', step: 0.5, baseline: null, finerIsLower: true },
};
const GRINDER_PRESETS = { 'DF64 Gen 2': 0.5 };
let currentTab = 'shot';

// ---------------------------------------------------------------- tabs
for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
}
function showTab(name) {
  if (!document.getElementById(`tab-${name}`)) name = 'shot';
  currentTab = name;
  for (const btn of document.querySelectorAll('[data-tab]')) btn.setAttribute('aria-selected', btn.dataset.tab === name);
  for (const sec of document.querySelectorAll('.tab')) sec.hidden = sec.id !== `tab-${name}`;
  if (name === 'profiles') renderProfiles();
  if (name === 'beans') beans.render();
  if (name === 'settings') renderSettings();
  history.replaceState(null, '', `#${name}`);
}

function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 4000);
}

// ---------------------------------------------------------------- connection + machine
gm.addEventListener('connection', e => {
  const el = $('#conn');
  el.textContent = e.detail ? 'Connected' : 'Offline';
  el.className = `conn ${e.detail ? 'on' : 'off'}`;
  if (e.detail) {
    loadLastShot();
    loadAppSettings();
    if (currentTab === 'profiles') renderProfiles();
    if (currentTab === 'beans') beans.refreshList();
  }
});

gm.addEventListener('status', e => renderMachine(e.detail));
gm.addEventListener('evt:history-shot-saved', () => {
  toast('New shot saved');
  loadLastShot();
});

function renderMachine(s) {
  if (!s) return;
  const temp = typeof s.ct === 'number' ? `${s.ct.toFixed(1)} °C` : '—';
  const target = typeof s.tt === 'number' ? ` / ${Math.round(s.tt)} °C` : '';
  const busy = s.process && s.process.a ? '<span class="pill busy">Brewing</span>' : '';
  $('#machine').innerHTML = `
    <div><span class="label">Active profile</span><strong>${esc(s.p || '—')}</strong> ${busy}</div>
    <div><span class="label">Boiler</span><strong>${temp}${target}</strong></div>`;
}

// ---------------------------------------------------------------- last shot
async function loadLastShot() {
  const el = $('#shot');
  try {
    const shots = await gm.recentShots(1);
    if (!shots.length) {
      el.innerHTML = '<h2>Last shot</h2><p class="muted">No shots yet. Pull one and it will appear here.</p>';
      return;
    }
    const meta = shots[0];
    const shot = await gm.loadShot(meta.id);
    let notes = null;
    try {
      notes = await gm.getNotes(meta.id);
    } catch {
      /* notes are optional */
    }
    el.innerHTML = renderShot(meta, shot, notes);
  } catch (err) {
    el.innerHTML = `<h2>Last shot</h2><p class="error">${esc(err.message)}</p>`;
  }
}

function seconds(ms) {
  return ms ? (ms / 1000).toFixed(1) : '—';
}

function renderShot(meta, shot, notes) {
  const when = meta.timestamp ? new Date(meta.timestamp * 1000).toLocaleString() : '';
  const samples = shot.samples || [];
  const peak = samples.length ? Math.max(...samples.map(s => s.cp || 0)) : 0;
  const yieldG = shot.volume ?? meta.volume;
  const dose = notes?.doseIn ? Number(notes.doseIn) : null;
  const ratio = dose && yieldG ? `1:${(yieldG / dose).toFixed(1)}` : '—';
  const stats = [
    ['Time', `${seconds(shot.duration || meta.duration)} s`],
    ['Yield', yieldG ? `${yieldG.toFixed(1)} g` : '—'],
    ['Ratio', ratio],
    ['Peak pressure', `${peak.toFixed(1)} bar`],
  ]
    .map(([k, v]) => `<div class="stat"><span class="label">${k}</span><strong>${v}</strong></div>`)
    .join('');
  const noteRows = notes
    ? [
        ['Bean', notes.beanType],
        ['Grind', notes.grindSetting],
        ['Dose', notes.doseIn && `${notes.doseIn} g`],
        ['Taste', notes.balanceTaste],
        ['Rating', notes.rating ? '★'.repeat(notes.rating) : ''],
        ['Notes', notes.notes],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
        .join('')
    : '';
  return `
    <div class="shot-head"><h2>Last shot</h2><span class="muted">#${esc(meta.id)} · ${esc(when)}</span></div>
    <p class="profile-name">${esc(shot.profile || meta.profile || '')}</p>
    <div class="stats">${stats}</div>
    ${shotChart(shot)}
    ${noteRows ? `<dl class="facts notes">${noteRows}</dl>` : '<p class="muted">No tasting notes for this shot yet.</p>'}
    ${shot.incomplete ? '<p class="muted">This shot log is incomplete.</p>' : ''}`;
}

// ---------------------------------------------------------------- profiles
async function renderProfiles() {
  const list = $('#profiles');
  if (!gm.connected) {
    list.innerHTML = '<li class="muted">Waiting for the machine…</li>';
    return; // re-rendered when the connection opens
  }
  list.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const profiles = (await gm.listProfiles()).filter(p => !p.utility);
    if (!profiles.length) {
      list.innerHTML = '<li class="muted">No brew profiles found.</li>';
      return;
    }
    const selectedId = gm.status?.puid;
    const [checks, beans] = await Promise.all([
      Promise.all(
        profiles.map(p => {
          const copy = { ...p };
          delete copy.id; // check the values themselves, not the change from the stored copy
          return gm.checkProfile(copy).catch(err => ({ ok: false, errors: [err.message] }));
        }),
      ),
      gm.getAll('beans').catch(() => []),
    ]);
    const beanFor = Object.fromEntries(beans.filter(b => b.profileId).map(b => [b.profileId, b]));
    const blank = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><text x="24" y="31" font-size="22" text-anchor="middle">☕</text></svg>');
    list.innerHTML = profiles
      .map((p, i) => {
        const c = checks[i];
        const bean = beanFor[p.id];
        const status = c.ok
          ? '<span class="ok-mark" title="Within the safety limits">✓</span>'
          : `<details class="limits"><summary><span class="pill alarm">⚠ Limits</span></summary>
              <p class="small muted">Outside the safety limits. It still brews normally; Dial-in just won't create or edit profiles like it.</p>
              <ul class="errors">${c.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>`;
        const meta = [bean?.roaster, p.temperature ? `${p.temperature} °C` : '', `${p.phases?.length || 0} phase${p.phases?.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
        return `<li class="with-thumb"><img class="thumb" alt="" data-pid="${esc(p.id)}" src="${esc(bean ? thumbSrc(bean) : blank)}"/>
          <div class="grow"><div class="row"><strong class="clip">${esc(p.label)}</strong>${p.id === selectedId ? '<span class="pill">Active</span>' : ''}${c.ok ? status : ''}</div>
          <div class="muted small">${esc(meta)}</div>${c.ok ? '' : status}</div></li>`;
      })
      .join('');
    // Profiles not made by Dial-in: show their GaggiMate picture, if any (one at a time).
    for (const p of profiles.filter(p => !beanFor[p.id])) {
      if (currentTab !== 'profiles') break;
      const url = await fetchProfileThumb(p.id).catch(() => null);
      const img = list.querySelector(`img[data-pid="${CSS.escape(p.id)}"]`);
      if (url && img) img.src = url;
    }
  } catch (err) {
    list.innerHTML = `<li class="error">${esc(err.message)}</li>`;
  }
}

// ---------------------------------------------------------------- settings
const LIMIT_FIELDS = [
  ['maxPressure', 'Max brew pressure', 'bar', 0.5],
  ['maxPreinfusionPressure', 'Max pre-infusion pressure', 'bar', 0.5],
  ['minTemperature', 'Min temperature', '°C', 0.5],
  ['maxTemperature', 'Max temperature', '°C', 0.5],
  ['minFlow', 'Min flow', 'g/s', 0.1],
  ['maxFlow', 'Max flow', 'g/s', 0.1],
  ['maxTotalDuration', 'Max shot time', 's', 1],
  ['maxPhaseDuration', 'Max time for one phase', 's', 1],
  ['maxYield', 'Max yield', 'g', 1],
  ['maxTemperatureStep', 'Max temperature change per shot', '°C', 0.5],
  ['maxPressureStep', 'Max pressure change per shot', 'bar', 0.5],
  ['maxYieldStep', 'Max yield change per shot', 'g', 1],
];

async function renderSettings() {
  try {
    pluginInfo = await gm.pluginStatus();
  } catch (err) {
    $('#limits').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  renderAppSettings();
  const { limits, hardLimits } = pluginInfo;
  $('#limits').innerHTML =
    LIMIT_FIELDS.map(([key, label, unit, step]) => {
      const hard = hardLimits[key];
      const hint =
        hard === undefined
          ? ''
          : `<span class="muted small">${key.startsWith('min') ? 'Machine allows no lower than' : 'Machine allows no higher than'} ${hard} ${unit}</span>`;
      return `<label><span>${label}</span>
        <span class="input"><input type="number" name="${key}" step="any" value="${limits[key]}" inputmode="decimal"/><span class="unit">${unit}</span></span>${hint}</label>`;
    }).join('') + '<button type="submit" class="primary">Save limits</button>';

  const gb = b => (b / 1024 ** 3).toFixed(1);
  const rows = [
    ['Dial-in plugin', pluginInfo.version],
    ['SD card', pluginInfo.sdCard ? 'Fitted' : 'Not found'],
    ['Space used', pluginInfo.totalBytes ? `${gb(pluginInfo.usedBytes)} of ${gb(pluginInfo.totalBytes)} GB` : '—'],
    ['App files', pluginInfo.appInstalled ? 'On SD card' : 'Missing'],
  ];
  $('#storage').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

async function loadAppSettings() {
  try {
    const saved = await gm.getRecord('settings', 'app');
    if (saved) appSettings = { ...appSettings, ...saved, grinder: { ...appSettings.grinder, ...(saved.grinder || {}) } };
  } catch {
    /* defaults */
  }
  try {
    pluginInfo = pluginInfo || (await gm.pluginStatus());
  } catch {
    /* limits default inside the logic */
  }
  if (currentTab === 'settings') renderAppSettings();
}

function renderAppSettings() {
  const g = appSettings.grinder;
  $('#appsettings').innerHTML = `
    <label><span>Grinder</span><span class="input"><input name="model" value="${esc(g.model)}" style="width:150px;text-align:left"/></span>
      <span class="muted small">Change this if you get a new grinder. A new grinder starts a fresh grind history.</span></label>
    <label><span>Smallest step you use</span><span class="input"><input name="step" type="number" step="0.05" value="${g.step}" inputmode="decimal"/><span class="unit"></span></span>
      <span class="muted small">DF64 Gen 2: 0.5. Other grinders start at 0.25.</span></label>
    <label><span>Your usual espresso grind (medium roast)</span><span class="input"><input name="baseline" type="number" step="0.25" value="${g.baseline ?? ''}" inputmode="decimal"/><span class="unit"></span></span>
      <span class="muted small">Used to suggest a starting grind for new coffees.</span></label>
    <label class="check"><input type="checkbox" name="finerIsLower" ${g.finerIsLower ? 'checked' : ''}/> <span>Lower numbers are finer</span></label>
    <label><span>Usual dose</span><span class="input"><input name="dose" type="number" step="0.5" value="${appSettings.dose}" inputmode="decimal"/><span class="unit">g</span></span></label>
    <label><span>Coffee keeps for</span><span class="input"><input name="freshDays" type="number" step="1" min="0" value="${appSettings.freshDays ?? 60}" inputmode="numeric"/><span class="unit">days</span></span>
      <span class="muted small">Days after roasting, used when the bag has no use-by date printed. 0 = only warn on printed dates.</span></label>
    <button type="submit" class="primary">Save</button>`;
  $('#aisettings').innerHTML = `
    <label><span>Anthropic API key</span><span class="input"><input name="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(aiSettings.apiKey || '')}" style="width:170px;text-align:left"/></span></label>
    <label><span>Model</span><span class="input"><input name="model" value="${esc(aiSettings.model)}" style="width:170px;text-align:left"/></span>
      <span class="muted small">Default ${DEFAULT_MODEL}.</span></label>
    <button type="submit" class="primary">Save</button>`;
}

$('#appsettings').addEventListener('submit', async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  const model = f.model.trim() || 'Grinder';
  const changedGrinder = model !== appSettings.grinder.model;
  appSettings = {
    ...appSettings,
    dose: Number(f.dose) || 18,
    freshDays: f.freshDays === '' ? 60 : Math.max(0, Math.round(Number(f.freshDays) || 0)),
    grinder: {
      ...appSettings.grinder,
      model,
      step: Number(f.step) || GRINDER_PRESETS[model] || 0.25,
      baseline: f.baseline === '' ? null : Number(f.baseline),
      finerIsLower: !!f.finerIsLower,
      since: changedGrinder ? new Date().toISOString().slice(0, 10) : appSettings.grinder.since,
    },
  };
  if (changedGrinder && !f.step) appSettings.grinder.step = GRINDER_PRESETS[model] || 0.25;
  try {
    await gm.putRecord('settings', 'app', appSettings);
    toast('Saved.', 'ok');
    renderAppSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#aisettings').addEventListener('submit', e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  aiSettings.apiKey = f.apiKey.trim();
  aiSettings.model = f.model.trim();
  toast('Saved in this browser.', 'ok');
});

$('#limits').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(
    [...new FormData(e.target).entries()].map(([k, v]) => [k, Number(v)]),
  );
  try {
    const res = await gm.setLimits(data);
    const clamped = Object.entries(data).filter(([k, v]) => res.limits[k] !== v);
    toast(clamped.length ? 'Saved. Some values were capped at the hard limits.' : 'Limits saved.', 'ok');
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------------------------------------------------------------- start
const beans = initBeans({
  gm,
  root: $('#tab-beans'),
  toast,
  getSettings: () => ({ ...appSettings, limits: pluginInfo?.limits }),
});
initFeedback({
  gm,
  toast,
  getSettings: () => ({ ...appSettings, limits: pluginInfo?.limits }),
  isBusy: () => beans.isBusy(),
  onDone: () => {
    if (currentTab === 'beans') beans.refreshList();
    loadLastShot();
  },
});
gm.connect();
showTab((location.hash || '#shot').slice(1).replace(/[^a-z]/g, '') || 'shot');
