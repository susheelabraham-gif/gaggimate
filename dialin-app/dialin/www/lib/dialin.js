// Dial-in planning logic: salami plan from bean data, the salami and starting
// profiles (GaggiMate profile JSON), and turning cup-by-cup tasting into a recipe.
// Pure functions, no DOM: tested with `node --test dialin-app/test`.

export const ROAST_LEVELS = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'];

// Defaults per roast level. ratio = best expected brew ratio; cups and maxRatio
// shape the salami; temp is the brew temperature in °C; flow the expected g/s at 9 bar.
const ROAST = {
  light: { cups: 5, maxRatio: 3.5, ratio: 2.5, temp: 94.5, flow: 1.4, grindOffset: -1 },
  'medium-light': { cups: 5, maxRatio: 3.25, ratio: 2.3, temp: 93.5, flow: 1.5, grindOffset: -0.5 },
  medium: { cups: 4, maxRatio: 3.0, ratio: 2.0, temp: 92.5, flow: 1.6, grindOffset: 0 },
  'medium-dark': { cups: 4, maxRatio: 2.75, ratio: 1.9, temp: 91, flow: 1.7, grindOffset: 0.5 },
  dark: { cups: 3, maxRatio: 2.5, ratio: 1.8, temp: 89, flow: 1.8, grindOffset: 1 },
};

const PREINFUSION_S = 8;
const PREINFUSION_BAR = 3;
const BREW_BAR = 9;
const MAX_SHOT_S = 60;
const MAX_CUP_WATER = 30; // ml, machine hard limit per salami cup
const MAX_SALAMI_WATER = 100; // ml, machine hard limit per salami shot

// Round to a step without floating-point noise (0.05 steps gave 3.0500000000000003).
const round = (v, step = 0.5) => parseFloat((Math.round(v / step) * step).toFixed(6));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function roastDefaults(level) {
  return ROAST[level] || ROAST.medium;
}

// Brew ratio suggested by research (roaster recipe or community), if usable.
export function researchRatio(bean) {
  const r = bean?.recipe;
  if (!r) return null;
  if (r.ratio && r.ratio >= 1.2 && r.ratio <= 4) return r.ratio;
  if (r.dose && r.yield && r.dose > 0) {
    const ratio = r.yield / r.dose;
    if (ratio >= 1.2 && ratio <= 4) return ratio;
  }
  return null;
}

// Starting grind on the user's grinder, from their usual medium-roast setting.
export function startingGrind(bean, grinder) {
  if (!grinder || typeof grinder.baseline !== 'number') return null;
  const step = grinder.step || 0.25;
  const finerIsLower = grinder.finerIsLower !== false;
  const offsetSteps = roastDefaults(bean?.roastLevel).grindOffset * 2; // offsets are in half-steps of the baseline step
  const delta = offsetSteps * step * (finerIsLower ? 1 : -1);
  return round(grinder.baseline + delta, step);
}

// Salami plan: number of cups, cumulative ratio at the end of each cup, water and time cap per cup.
export function planSalami(bean, dose) {
  const d = roastDefaults(bean?.roastLevel);
  const best = researchRatio(bean) ?? d.ratio;
  // Go about one cup past the expected best ratio, within the roast's range.
  let maxRatio = clamp(Math.max(d.maxRatio, best + 0.75), 2.0, 3.5);
  let cups = d.cups;
  // Respect the machine's water limits.
  maxRatio = Math.min(maxRatio, MAX_SALAMI_WATER / dose);
  let cupYield = (dose * maxRatio) / cups;
  while (cupYield > MAX_CUP_WATER && cups < 6) {
    cups += 1;
    cupYield = (dose * maxRatio) / cups;
  }
  cupYield = Math.min(cupYield, MAX_CUP_WATER);
  // Cups run at a controlled flow so each lasts about 10 s or more: slow enough to swap
  // cups by hand. The flow is set so the whole shot fits the time limit.
  const usable = MAX_SHOT_S - PREINFUSION_S - 4;
  const cupFlow = round(clamp((cupYield * cups) / usable, 1.0, 2.0), 0.1);
  const cupCap = Math.floor(Math.min((MAX_SHOT_S - PREINFUSION_S) / cups, (1.5 * cupYield) / cupFlow));
  const temperature = clamp(bean?.recipe?.tempC ?? d.temp, 85, 96);
  const list = [];
  for (let i = 1; i <= cups; i++) {
    list.push({
      cup: i,
      water: round(cupYield, 0.5),
      endRatio: round((cupYield * i) / dose, 0.05),
      endGrams: round(cupYield * i, 0.5),
      timeCap: cupCap,
    });
  }
  return { dose, temperature, cups: list, cupFlow, expectedBestRatio: round(best, 0.05), expectedFlow: d.flow };
}

export function salamiProfile(bean, plan) {
  const name = bean?.name || 'New coffee';
  return {
    label: `Salami · ${name}`.slice(0, 40),
    type: 'pro',
    description: `Salami diagnostic, ${plan.cups.length} cups at ${plan.cupFlow ?? ''} g/s, ${plan.dose} g dose`,
    temperature: plan.temperature,
    phases: [
      {
        name: 'Pre-infusion',
        phase: 'preinfusion',
        valve: 1,
        duration: PREINFUSION_S,
        pump: { target: 'pressure', pressure: PREINFUSION_BAR, flow: 0 },
        targets: [],
      },
      ...plan.cups.map(c => ({
        name: `Cup ${c.cup}`,
        phase: 'brew',
        valve: 1,
        duration: c.timeCap,
        // Flow-controlled with a 9 bar ceiling (the machine requires a pressure cap).
        pump: plan.cupFlow
          ? { target: 'flow', pressure: BREW_BAR, flow: plan.cupFlow }
          : { target: 'pressure', pressure: BREW_BAR, flow: 0 },
        targets: [{ type: 'pumped', operator: 'gte', value: c.water }],
      })),
    ],
  };
}

// cups: [{ weight, sour, sweet, bitter, intensity, body: 'thin'|'medium'|'heavy' }]
// blendBest: number of cups in the best-tasting blend (e.g. 2 = cups 1+2), or null.
// shotSeconds: time from end of pre-infusion to end of shot, if known.
export function recommend({ bean, plan, cups, blendBest = null, shotSeconds = null, limits = {} }) {
  const reasons = [];
  const dose = plan.dose;
  const weights = cups.map((c, i) => (c.weight > 0 ? c.weight : plan.cups[i]?.water ?? 0));
  const cumulative = weights.reduce((acc, w) => [...acc, (acc.at(-1) ?? 0) + w], []);
  const ratioAt = k => cumulative[k - 1] / dose;

  let temperature = plan.temperature;
  let preinfusion = PREINFUSION_S;
  let stopCup;

  const good = cups.map(c => c.sweet && !c.bitter);
  const lastGood = good.lastIndexOf(true) + 1; // 0 if none
  const firstBitter = cups.findIndex(c => c.bitter) + 1; // 0 if none
  const lastSour = cups.map(c => c.sour).lastIndexOf(true) + 1;

  if (blendBest) {
    stopCup = blendBest;
    reasons.push(`You liked the blend of cups 1–${blendBest} best, so the yield stops there.`);
  } else if (lastGood) {
    stopCup = lastGood;
    reasons.push(`Cup ${lastGood} was the last one still sweet without bitterness, so the yield stops there.`);
  } else if (firstBitter && firstBitter <= 2) {
    stopCup = 1;
    reasons.push('Bitterness came early, so the yield stops after the first cup.');
  } else {
    stopCup = cups.length;
    reasons.push('No cup tasted sweet; the yield uses the whole shot and the temperature goes up.');
  }

  if (firstBitter && firstBitter <= 2) {
    temperature -= 1.5;
    reasons.push(`Bitter by cup ${firstBitter}: this coffee extracts fast, temperature down 1.5 °C.`);
  } else if (lastSour >= 3 || (!lastGood && !firstBitter)) {
    temperature += 1.5;
    reasons.push(`Still sour in cup ${Math.max(lastSour, 1)}: this coffee extracts slowly, temperature up 1.5 °C.`);
  }

  if (cups.length && cups.every(c => c.body === 'thin')) {
    preinfusion = 12;
    reasons.push('Thin body in every cup: longer pre-infusion (12 s) for more body.');
  }

  const minT = limits.minTemperature ?? 85;
  const maxT = limits.maxTemperature ?? 96;
  temperature = clamp(round(temperature, 0.5), minT, maxT);

  const roast = roastDefaults(bean?.roastLevel);
  const recipe = roasterRecipe(bean);
  // A roaster who publishes a wider ratio for this coffee raises the ceiling.
  const ceiling = Math.max(roast.maxRatio, recipe?.ratio ?? 0);
  const ratio = clamp(round(ratioAt(stopCup), 0.05), 1.5, ceiling);
  if (recipe) {
    const diff = Math.abs(ratio - recipe.ratio);
    reasons.push(
      diff <= 0.15
        ? `That matches ${recipe.source} (1:${fmtRatio(recipe.ratio)}).`
        : `${recipe.source} suggests 1:${fmtRatio(recipe.ratio)}${recipe.dose && recipe.yieldG ? ` (${recipe.dose} g in, ${recipe.yieldG} g out${recipe.timeS ? ` in ${recipe.timeS} s` : ''})` : ''}; your tasting pointed to 1:${fmtRatio(ratio)}.`,
    );
  }
  const maxYield = limits.maxYield ?? 60;
  const yieldG = Math.min(round(dose * ratio, 0.5), maxYield);

  // Flow during the salami says something about grind.
  let grindAdvice = 'keep';
  if (shotSeconds && cumulative.at(-1)) {
    const flow = cumulative.at(-1) / shotSeconds;
    const expected = plan.cupFlow || plan.expectedFlow;
    if (flow > expected * 1.35) {
      grindAdvice = 'finer';
      reasons.push(`Coffee ran fast (${flow.toFixed(1)} g/s): grind a little finer.`);
    } else if (flow < expected * 0.65) {
      grindAdvice = 'coarser';
      reasons.push(`Coffee ran slowly (${flow.toFixed(1)} g/s): grind a little coarser.`);
    }
  }

  return { ratio, yieldG, temperature, preinfusion, grindAdvice, reasons, stopCup };
}

export function startingProfile(bean, rec, dose) {
  const name = bean?.name || 'New coffee';
  const brewCap = MAX_SHOT_S - rec.preinfusion - 2;
  const from = rec.source ? ` (${rec.source})` : '';
  return {
    label: name.slice(0, 40),
    type: 'pro',
    dose,
    description: `1:${fmtRatio(rec.ratio)} · ${dose} g in, ${rec.yieldG} g out${rec.targetSeconds ? ` in ~${rec.targetSeconds} s` : ''}${from}`,
    temperature: rec.temperature,
    phases: [
      {
        name: 'Pre-infusion',
        phase: 'preinfusion',
        valve: 1,
        duration: rec.preinfusion,
        pump: { target: 'pressure', pressure: PREINFUSION_BAR, flow: 0 },
        targets: [],
      },
      {
        name: 'Brew',
        phase: 'brew',
        valve: 1,
        duration: brewCap,
        pump: { target: 'pressure', pressure: BREW_BAR, flow: 0 },
        targets: [{ type: 'volumetric', operator: 'gte', value: rec.yieldG }],
      },
    ],
  };
}

export function slug(text) {
  return (
    String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'coffee'
  );
}

// ------------------------------------------------------------------ per-shot loop

export const SHOT_WINDOW = { fast: 24, slow: 36 }; // total shot seconds, pre-infusion included

// 1:3 stays "3.0", 1:3.05 keeps its second decimal instead of reading as 3.0.
export function fmtRatio(v) {
  const n = Number(v) || 0;
  return Math.abs(n * 10 - Math.round(n * 10)) < 0.001 ? n.toFixed(1) : n.toFixed(2);
}

// The roaster's own espresso recipe, filled out: ratio from dose and yield (or the
// other way round) so every field we need is there. Null when the research found none.
export function roasterRecipe(bean) {
  const r = bean?.recipe;
  if (!r) return null;
  const n = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const dose = n(r.dose);
  const yieldG = n(r.yield);
  let ratio = n(r.ratio);
  if (!ratio && dose && yieldG) ratio = yieldG / dose;
  if (!ratio) return null;
  return {
    dose,
    yieldG: yieldG || (dose ? round(dose * ratio, 0.5) : null),
    ratio: round(ratio, 0.05),
    timeS: n(r.timeS),
    tempC: n(r.tempC),
    source: r.source || 'the roaster',
  };
}

// Shot-time window for "fast" and "slow", around the roaster's target when known.
export function shotWindow(targetSeconds = null) {
  const t = Number(targetSeconds);
  if (!Number.isFinite(t) || t < 15 || t > 60) return { ...SHOT_WINDOW, target: null };
  return { fast: Math.round(t - 5), slow: Math.round(t + 6), target: Math.round(t) };
}

// Grind on the dial as text, rounded to the grinder's step.
export function fmtGrind(v, step = 0.25) {
  return String(parseFloat(round(v, step).toFixed(2)));
}

// After a rated shot: what to change for the next one. Grind and temperature are never
// changed together (one variable per shot).
// shot: { seconds, yieldG, targetYield }  feedback: { taste: 'sour'|'balanced'|'bitter', rating }
// dial: { grind, step, lastDir, goodStreak }  grinder: { step, finerIsLower }
export function nextStep({ shot, feedback, dial, grinder, temperature, limits = {}, targetSeconds = null }) {
  const minStep = grinder?.step || 0.25;
  const finer = grinder?.finerIsLower === false ? 1 : -1; // dial direction for "finer"
  const reasons = [];
  const t = shot.seconds;
  const win = shotWindow(targetSeconds);
  const fast = t > 0 && t < win.fast;
  const slow = t > win.slow;
  const short = shot.targetYield && shot.yieldG && shot.yieldG < shot.targetYield * 0.85;
  const timing = fast ? 'fast' : slow || short ? 'slow' : 'on time';
  let grindDir = 0; // -1 = finer, +1 = coarser, in taste terms
  let tempDelta = 0;
  const taste = feedback.taste;

  if (taste === 'sour' && timing === 'fast') {
    grindDir = -1;
    reasons.push(`Sour and fast (${t.toFixed(0)} s): grind finer.`);
  } else if (taste === 'bitter' && timing === 'slow') {
    grindDir = 1;
    reasons.push(`Bitter and slow (${t.toFixed(0)} s): grind coarser.`);
  } else if (taste === 'sour') {
    tempDelta = 1;
    reasons.push(`Sour but ${timing === 'slow' ? 'slow' : 'on time'}: keep the grind, temperature up 1 °C.`);
  } else if (taste === 'bitter' && timing === 'fast') {
    reasons.push('Bitter but fast: usually uneven extraction. Check distribution and tamp; grind unchanged.');
  } else if (taste === 'bitter') {
    tempDelta = -1;
    reasons.push('Bitter but on time: keep the grind, temperature down 1 °C.');
  } else if (timing === 'fast') {
    grindDir = -1;
    reasons.push(`Tastes fine but ran fast (${t.toFixed(0)} s): grind a touch finer for more body.`);
  } else if (timing === 'slow') {
    grindDir = 1;
    reasons.push(`Tastes fine but ran slow (${t.toFixed(0)} s): grind a touch coarser.`);
  } else {
    reasons.push('Balanced and on time: no change.');
  }

  // Temperature within limits.
  const minT = limits.minTemperature ?? 85;
  const maxT = limits.maxTemperature ?? 96;
  if (tempDelta && (temperature + tempDelta > maxT || temperature + tempDelta < minT)) {
    reasons.push(`Temperature is already at the ${tempDelta > 0 ? 'upper' : 'lower'} limit, so the grind changes instead.`);
    grindDir = tempDelta > 0 ? -1 : 1;
    tempDelta = 0;
  }

  // Step size: start at two grinder steps, halve whenever the direction flips.
  let step = dial?.step || 2 * minStep;
  if (grindDir && dial?.lastDir && grindDir !== dial.lastDir) step = Math.max(minStep, step / 2);
  step = Math.max(minStep, round(step, minStep));
  const fromGrind = typeof dial?.grind === 'number' ? dial.grind : null;
  const nextGrind = fromGrind != null ? round(fromGrind + (grindDir ? (grindDir === -1 ? finer : -finer) * step : 0), minStep) : null;

  const good = taste === 'balanced' && (feedback.rating ?? 0) >= 4 && timing === 'on time';
  const goodStreak = good ? (dial?.goodStreak || 0) + 1 : 0;
  return {
    timing,
    grindDir,
    grindStep: grindDir ? step : 0,
    nextGrind,
    tempDelta,
    good,
    goodStreak,
    dialedIn: goodStreak >= 2,
    reasons,
    dial: { grind: nextGrind ?? fromGrind, step, lastDir: grindDir || dial?.lastDir || 0, goodStreak },
  };
}

// The date a bag should be used by: the printed use-by/best-before date, else
// roast date + freshDays (0 = off). Returns 'YYYY-MM-DD' or ''.
export function useByFor(batch, freshDays = 60) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(batch?.bestBefore || '')) return batch.bestBefore;
  if (!freshDays || !/^\d{4}-\d{2}-\d{2}$/.test(batch?.roastDate || '')) return '';
  const d = new Date(`${batch.roastDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(freshDays));
  return d.toISOString().slice(0, 10);
}

export function localToday(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function isExpired(bean, today = localToday()) {
  return !!bean?.useBy && !bean.useByIgnored && bean.useBy < today;
}

// --- Bag stock -------------------------------------------------------------
// How much coffee is left in the bag: bag size minus (shots pulled x dose),
// or counted down from the last amount the user weighed/entered.
export function bagStock({ batch, dose = 18, shots = 0, lowShots = 4 }) {
  const size = Number(batch?.bagSizeG) || 0;
  const d = Number(dose) > 0 ? Number(dose) : 18;
  const cal = batch?.calib;
  let leftG;
  if (cal && Number.isFinite(Number(cal.leftG))) {
    leftG = Number(cal.leftG) - Math.max(0, shots - (Number(cal.atShots) || 0)) * d;
  } else if (size > 0) {
    leftG = size - shots * d;
  } else {
    return null; // no bag size and never weighed: nothing to estimate from
  }
  leftG = Math.max(0, Math.round(leftG));
  const shotsLeft = Math.floor(leftG / d);
  return {
    bagSizeG: size,
    dose: d,
    shots,
    leftG,
    shotsLeft,
    usedG: size > 0 ? Math.max(0, size - leftG) : null,
    percent: size > 0 ? Math.max(0, Math.min(100, Math.round((leftG / size) * 100))) : null,
    low: shotsLeft < lowShots,
    empty: shotsLeft < 1,
  };
}

// Shots on this coffee's profile that this bag hasn't counted yet (newest-first index).
export function newShotsForBag(entries, { profileId, batch }) {
  if (!profileId || !batch) return { count: 0, lastShotId: Number(batch?.lastShotId) || 0 };
  const seen = Number(batch.lastShotId) || 0;
  const startedAt = Date.parse(batch.createdAt || '') / 1000 || 0;
  let count = 0;
  let lastShotId = seen;
  for (const e of entries || []) {
    const id = Number(e.id);
    if (!Number.isFinite(id) || e.deleted || e.profileId !== profileId) continue;
    if (id <= seen) continue;
    // Before this bag's first count, ignore shots pulled before the bag was opened.
    if (!seen && e.timestamp > 0 && startedAt && e.timestamp < startedAt) continue;
    count++;
    if (id > lastShotId) lastShotId = id;
  }
  return { count, lastShotId };
}

// --- Machine calibration ----------------------------------------------------
// The temperature offset decides what a profile's temperature means at the puck,
// so a change to it changes the taste of every coffee. The plugin logs each change;
// these helpers say which offset a shot was pulled on, and whether a coffee was
// dialed in on a different one.

export function sortCalibrations(records = []) {
  return [...records].filter(r => r && typeof r.offset === 'number').sort((a, b) => (Number(a.epoch) || 0) - (Number(b.epoch) || 0));
}

// The offset in force when a shot was pulled (by shot id, else by time).
export function offsetForShot(records, { id = null, timestamp = null } = {}, current = null) {
  const log = sortCalibrations(records);
  if (!log.length) return current;
  let offset = log[0].previous ?? log[0].offset;
  for (const r of log) {
    const afterId = Number(r.afterShotId);
    const started = Number.isFinite(Number(id)) && Number.isFinite(afterId) && afterId >= 0
      ? Number(id) > afterId
      : Number(timestamp) > (Number(r.epoch) || 0);
    if (started) offset = r.offset;
  }
  return offset;
}

// Where a calibration change falls between two shots, newest-first, for the divider.
export function calibrationBetween(records, newer, older) {
  const log = sortCalibrations(records);
  for (let i = log.length - 1; i >= 0; i--) {
    const r = log[i];
    const a = offsetForShot([r], newer, r.offset);
    const b = offsetForShot([r], older, r.offset);
    if (a !== b) return r;
  }
  return null;
}
