// Small dependency-free SVG chart of a shot: pressure and flow (left axis, shared
// 0–12 scale) and weight (right axis), against time.

const SERIES = [
  { key: 'cp', label: 'Pressure', unit: 'bar', axis: 'left', cls: 's-pressure' },
  { key: 'tp', label: 'Target pressure', unit: 'bar', axis: 'left', cls: 's-target', dashed: true },
  { key: 'pf', label: 'Flow', unit: 'g/s', axis: 'left', cls: 's-flow' },
  { key: 'v', label: 'Weight', unit: 'g', axis: 'right', cls: 's-weight' },
];

function niceMax(v, step) {
  return Math.max(step, Math.ceil(v / step) * step);
}

export function shotChart(shot) {
  const W = 640,
    H = 300,
    m = { l: 40, r: 44, t: 16, b: 34 };
  const samples = shot.samples || [];
  if (samples.length < 2) return '<p class="muted">Not enough data to draw this shot.</p>';
  const tMax = samples[samples.length - 1].t / 1000;
  const leftMax = 12;
  const weightMax = niceMax(Math.max(...samples.map(s => s.v || 0), 1), 20);
  const x = t => m.l + (t / tMax) * (W - m.l - m.r);
  const yL = v => H - m.b - (Math.min(v, leftMax) / leftMax) * (H - m.t - m.b);
  const yR = v => H - m.b - (v / weightMax) * (H - m.t - m.b);

  let grid = '';
  for (let v = 0; v <= leftMax; v += 3) {
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yL(v)}" y2="${yL(v)}"/>`;
    grid += `<text class="tick" x="${m.l - 6}" y="${yL(v) + 4}" text-anchor="end">${v}</text>`;
  }
  for (let v = 0; v <= weightMax; v += weightMax / 4) {
    grid += `<text class="tick" x="${W - m.r + 6}" y="${yR(v) + 4}">${Math.round(v)}</text>`;
  }
  const tStep = tMax > 40 ? 10 : 5;
  for (let t = 0; t <= tMax; t += tStep) {
    grid += `<text class="tick" x="${x(t)}" y="${H - m.b + 16}" text-anchor="middle">${t}s</text>`;
  }

  let phases = '';
  for (const tr of shot.phaseTransitions || []) {
    const s = samples[tr.sampleIndex];
    if (!s || tr.sampleIndex === 0) continue;
    phases += `<line class="phase" x1="${x(s.t / 1000)}" x2="${x(s.t / 1000)}" y1="${m.t}" y2="${H - m.b}"/>`;
  }

  const paths = SERIES.map(sr => {
    const y = sr.axis === 'left' ? yL : yR;
    const pts = samples
      .filter(s => typeof s[sr.key] === 'number' && !Number.isNaN(s[sr.key]))
      .map(s => `${x(s.t / 1000).toFixed(1)},${y(Math.max(0, s[sr.key])).toFixed(1)}`);
    if (pts.length < 2) return '';
    return `<polyline class="${sr.cls}${sr.dashed ? ' dashed' : ''}" points="${pts.join(' ')}"/>`;
  }).join('');

  const legend = SERIES.map(
    sr => `<span class="key"><i class="${sr.cls}${sr.dashed ? ' dashed' : ''}"></i>${sr.label} (${sr.unit})</span>`,
  ).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pressure, flow and weight over the shot">
    ${grid}${phases}${paths}
    <text class="axis" x="${m.l}" y="${m.t - 4}">bar · g/s</text>
    <text class="axis" x="${W - m.r}" y="${m.t - 4}" text-anchor="end">g</text>
  </svg><div class="legend">${legend}</div>`;
}
