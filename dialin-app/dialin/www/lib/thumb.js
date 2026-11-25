// Roaster thumbnails for coffees and their GaggiMate profiles (GaggiMate 1.10+).
// A logo is fetched by the browser when the site allows it (CORS), otherwise by the
// display (/api/dialin/logo). Without a logo, a tile with the roaster's initials and
// name is drawn instead. Thumbnails are stored on the coffee as a small WebP data URL
// and uploaded to the profile in GaggiMate's format (LVGL header + 300x300 RGB565).

export const SIZE = 300;
const HEADER = 4 | (SIZE << 10) | (SIZE << 21); // LV_IMG_CF_TRUE_COLOR, 300x300
const sleep = ms => new Promise(r => setTimeout(r, ms));

function canvas(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

// Stable colour per roaster name.
export function tileColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 32%)`;
}

export function initials(name) {
  const words = String(name || '?')
    .replace(/\b(coffee|roasters?|roastery|co\.?|company|the)\b/gi, ' ')
    .split(/[\s&+\-–·.]+/)
    .filter(Boolean);
  const pick = words.length ? words : String(name || '?').split(/\s+/);
  return pick
    .slice(0, 2)
    .map(w => [...w][0].toUpperCase())
    .join('');
}

// Square tile: big initials with the roaster's name underneath.
export function nameTile(roaster, size = SIZE) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = tileColor(roaster);
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.font = `700 ${Math.round(size * 0.4)}px ${font}`;
  ctx.fillText(initials(roaster), size / 2, size * 0.42);
  const label = String(roaster || '').trim();
  if (label) {
    let px = Math.round(size * 0.1);
    ctx.font = `600 ${px}px ${font}`;
    while (px > 10 && ctx.measureText(label).width > size * 0.86) {
      px -= 1;
      ctx.font = `600 ${px}px ${font}`;
    }
    ctx.globalAlpha = 0.9;
    ctx.fillText(label, size / 2, size * 0.8);
  }
  return c;
}

// Draw any image blob (PNG, JPEG, WebP, SVG...) centred on white with a margin, so
// wide wordmarks stay whole instead of being cropped.
export async function blobToTile(blob, size = SIZE, margin = 0.84) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('The logo could not be read as an image.'));
      el.src = url;
    });
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const c = canvas(size);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    const box = size * margin;
    const scale = Math.min(box / w, box / h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function browserFetch(url) {
  const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error('That link is not an image');
  return blob;
}

async function deviceFetch(url, timeoutMs = 30000) {
  const start = await fetch('/api/dialin/logo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  }).then(r => r.json());
  if (!start.ok) throw new Error(start.error || 'Logo download failed');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(700);
    const st = await fetch('/api/dialin/logo', { cache: 'no-store' }).then(r => r.json());
    if (st.state === 'error') throw new Error(st.error || 'Logo download failed');
    if (st.state === 'done') {
      const res = await fetch('/api/dialin/logo/data', { cache: 'no-store' });
      if (!res.ok) throw new Error('Logo download failed');
      return res.blob();
    }
  }
  throw new Error('The logo download timed out');
}

// Fetch a logo by URL: browser first, then the display. Returns a 300x300 canvas.
export async function logoTile(url) {
  let blob;
  try {
    blob = await browserFetch(url);
  } catch {
    blob = await deviceFetch(url);
  }
  return blobToTile(blob);
}

// Best thumbnail for a coffee: its roaster's logo, or a name tile.
// Returns { canvas, source: 'logo' | 'name', error? }.
export async function makeThumb(bean) {
  if (bean.logoUrl) {
    try {
      return { canvas: await logoTile(bean.logoUrl), source: 'logo' };
    } catch (err) {
      return { canvas: nameTile(bean.roaster || bean.name), source: 'name', error: err.message };
    }
  }
  return { canvas: nameTile(bean.roaster || bean.name), source: 'name' };
}

// Small enough to keep on the coffee's record (records are capped at 64 KB).
export function toDataUrl(c) {
  for (const q of [0.85, 0.7, 0.5]) {
    const url = c.toDataURL('image/webp', q);
    if (url.length < 40000) return url;
  }
  const small = canvas(150);
  small.getContext('2d').drawImage(c, 0, 0, 150, 150);
  return small.toDataURL('image/webp', 0.7);
}

export async function dataUrlToTile(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return blobToTile(blob, SIZE, 1); // already a finished square tile
}

// GaggiMate's on-device profile image format.
export function toDeviceImage(c) {
  const px = c.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
  const out = new DataView(new ArrayBuffer(4 + SIZE * SIZE * 2));
  out.setUint32(0, HEADER, true);
  for (let i = 0, o = 4; i < px.length; i += 4, o += 2) {
    out.setUint16(o, ((px[i] & 0xf8) << 8) | ((px[i + 1] & 0xfc) << 3) | (px[i + 2] >> 3), true);
  }
  return out.buffer;
}

export function deviceImageToDataUrl(buffer, size = 96) {
  const view = new DataView(buffer);
  const c = canvas();
  const ctx = c.getContext('2d');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let i = 0, o = 4; o + 1 < buffer.byteLength; i += 4, o += 2) {
    const v = view.getUint16(o, true);
    image.data[i] = (((v >> 11) & 0x1f) * 255) / 31;
    image.data[i + 1] = (((v >> 5) & 0x3f) * 255) / 63;
    image.data[i + 2] = ((v & 0x1f) * 255) / 31;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const small = canvas(size);
  small.getContext('2d').drawImage(c, 0, 0, size, size);
  return small.toDataURL('image/webp', 0.8);
}

// Put a coffee's thumbnail on a GaggiMate profile. Needs GaggiMate 1.10+ and an SD card.
export async function uploadProfileThumb(profileId, dataUrl) {
  if (!profileId || !dataUrl) return false;
  const tile = await dataUrlToTile(dataUrl);
  const res = await fetch(`/api/profiles/image?id=${encodeURIComponent(profileId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new File([toDeviceImage(tile)], 'image.bin', { type: 'application/octet-stream' }),
  });
  if (!res.ok) throw new Error((await res.text()) || 'Could not set the profile image');
  return true;
}

// A profile's GaggiMate picture is 180 KB; keep the small version in this browser
// for a day so the Profiles tab doesn't download every picture on each visit.
const THUMB_TTL = 24 * 3600 * 1000;
export async function fetchProfileThumb(profileId) {
  const key = `dialin.pthumb.${profileId}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < THUMB_TTL) return hit.url;
  } catch {
    /* no storage */
  }
  const res = await fetch(`/api/profiles/image?id=${encodeURIComponent(profileId)}`, { cache: 'no-store' });
  const url = res.ok ? deviceImageToDataUrl(await res.arrayBuffer()) : null;
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), url }));
  } catch {
    /* full or unavailable: fine */
  }
  return url;
}
