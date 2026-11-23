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

const round = (v, step = 0.5) => Math.round(v / step) * step;
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
  const cupCap = Math.floor(Math.min((MAX_SHOT_S - PREINFUSION_S) / cups, Math.max(6, (2 * cupYield) / d.flow)));
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
  return { dose, temperature, cups: list, expectedBestRatio: round(best, 0.05), expectedFlow: d.flow };
}

export function salamiProfile(bean, plan) {
  const name = bean?.name || 'New coffee';
  return {
    label: `Salami · ${name}`.slice(0, 40),
    type: 'pro',
    description: `Salami diagnostic, ${plan.cups.length} cups, ${plan.dose} g dose`,
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
        pump: { target: 'pressure', pressure: BREW_BAR, flow: 0 },
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

  const ratio = clamp(round(ratioAt(stopCup), 0.05), 1.5, 3.0);
  const maxYield = limits.maxYield ?? 60;
  const yieldG = Math.min(round(dose * ratio, 0.5), maxYield);

  // Flow during the salami says something about grind.
  let grindAdvice = 'keep';
  if (shotSeconds && cumulative.at(-1)) {
    const flow = cumulative.at(-1) / shotSeconds;
    const expected = plan.expectedFlow;
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
  return {
    label: name.slice(0, 40),
    type: 'pro',
    description: `1:${rec.ratio.toFixed(1)} · ${dose} g in, ${rec.yieldG} g out (from salami)`,
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
