// node --test dialin-app/test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planSalami,
  salamiProfile,
  recommend,
  startingProfile,
  startingGrind,
  slug,
} from '../dialin/www/lib/dialin.js';

const light = { name: 'Ethiopia Guji', roastLevel: 'light' };
const dark = { name: 'Italian Blend', roastLevel: 'dark' };

test('light roast gets more cups and a longer range than dark', () => {
  const a = planSalami(light, 18);
  const b = planSalami(dark, 18);
  assert.equal(a.cups.length, 5);
  assert.equal(b.cups.length, 3);
  assert.ok(a.cups.at(-1).endRatio > b.cups.at(-1).endRatio);
  assert.ok(a.temperature > b.temperature);
});

test('salami plan stays inside machine limits', () => {
  for (const level of ['light', 'medium', 'dark']) {
    for (const dose of [14, 18, 22]) {
      const p = planSalami({ roastLevel: level }, dose);
      const water = p.cups.reduce((s, c) => s + c.water, 0);
      const time = 8 + p.cups.reduce((s, c) => s + c.timeCap, 0);
      assert.ok(water <= 100, `${level} ${dose}: ${water} ml`);
      assert.ok(p.cups.every(c => c.water <= 30));
      assert.ok(time <= 60, `${level} ${dose}: ${time} s`);
    }
  }
});

test('roaster recipe moves the salami range', () => {
  const withRecipe = planSalami({ roastLevel: 'dark', recipe: { dose: 18, yield: 54 } }, 18);
  assert.ok(withRecipe.cups.at(-1).endRatio >= 3.0);
});

test('salami profile has one pumped-water phase per cup', () => {
  const plan = planSalami(light, 18);
  const p = salamiProfile(light, plan);
  assert.equal(p.type, 'pro');
  assert.equal(p.phases.length, plan.cups.length + 1);
  assert.deepEqual(p.phases.slice(1).map(ph => ph.name), ['Cup 1', 'Cup 2', 'Cup 3', 'Cup 4', 'Cup 5']);
  assert.ok(p.phases.slice(1).every(ph => ph.targets[0].type === 'pumped' && ph.pump.pressure <= 10));
});

test('yield stops at the last sweet cup before bitterness', () => {
  const plan = planSalami(light, 18);
  const cups = [
    { weight: 12, sour: true, sweet: false },
    { weight: 13, sweet: true },
    { weight: 13, sweet: true },
    { weight: 12, sweet: true, bitter: true },
    { weight: 12, bitter: true },
  ];
  const rec = recommend({ bean: light, plan, cups });
  assert.equal(rec.stopCup, 3);
  assert.equal(rec.yieldG, 38);
  assert.equal(rec.ratio, 2.1);
});

test('blend choice overrides single cups', () => {
  const plan = planSalami(light, 18);
  const cups = plan.cups.map(c => ({ weight: c.water, sweet: true }));
  assert.equal(recommend({ bean: light, plan, cups, blendBest: 2 }).stopCup, 2);
});

test('early bitterness lowers temperature, late sourness raises it', () => {
  const plan = planSalami({ roastLevel: 'medium' }, 18);
  const bitter = recommend({ plan, cups: [{ weight: 13, sweet: true }, { weight: 13, bitter: true }, { weight: 13, bitter: true }, { weight: 13, bitter: true }] });
  assert.ok(bitter.temperature < plan.temperature);
  const sour = recommend({ plan, cups: [{ weight: 13, sour: true }, { weight: 13, sour: true, sweet: true }, { weight: 13, sour: true, sweet: true }, { weight: 13, sweet: true }] });
  assert.ok(sour.temperature > plan.temperature);
});

test('recommendation respects limits', () => {
  const plan = planSalami(light, 18);
  plan.temperature = 96;
  const cups = plan.cups.map(c => ({ weight: c.water, sour: true }));
  const rec = recommend({ plan, cups, limits: { maxTemperature: 96, maxYield: 40 } });
  assert.ok(rec.temperature <= 96);
  assert.ok(rec.yieldG <= 40);
});

test('fast salami suggests finer grind', () => {
  const plan = planSalami({ roastLevel: 'medium' }, 18);
  const cups = plan.cups.map(c => ({ weight: c.water, sweet: true }));
  const total = cups.reduce((s, c) => s + c.weight, 0);
  assert.equal(recommend({ plan, cups, shotSeconds: total / 3 }).grindAdvice, 'finer');
  assert.equal(recommend({ plan, cups, shotSeconds: total / 0.5 }).grindAdvice, 'coarser');
});

test('starting profile stops on yield within 60 s', () => {
  const p = startingProfile(light, { ratio: 2.2, yieldG: 39.5, temperature: 94, preinfusion: 8 }, 18);
  const brew = p.phases[1];
  assert.equal(brew.targets[0].type, 'volumetric');
  assert.equal(brew.targets[0].value, 39.5);
  assert.ok(p.phases.reduce((s, ph) => s + ph.duration, 0) <= 60);
});

test('starting grind follows roast and grinder direction', () => {
  const df64 = { baseline: 15, step: 0.5, finerIsLower: true };
  assert.equal(startingGrind({ roastLevel: 'light' }, df64), 14);
  assert.equal(startingGrind({ roastLevel: 'dark' }, df64), 16);
  assert.equal(startingGrind({ roastLevel: 'medium' }, df64), 15);
  assert.equal(startingGrind({ roastLevel: 'light' }, null), null);
});

test('slug makes safe record ids', () => {
  assert.equal(slug('Café Ñandú — Lot #4'), 'cafe-nandu-lot-4');
  assert.match(slug('x'.repeat(80)), /^[a-z0-9-]{1,40}$/);
});

import { nextStep, fmtGrind } from '../dialin/www/lib/dialin.js';
const df64 = { step: 0.5, finerIsLower: true };
const base = { dial: { grind: 15, step: 1, lastDir: 0, goodStreak: 0 }, grinder: df64, temperature: 93 };

test('sour and fast grinds finer by the step', () => {
  const r = nextStep({ ...base, shot: { seconds: 18, yieldG: 36, targetYield: 36 }, feedback: { taste: 'sour', rating: 2 } });
  assert.equal(r.grindDir, -1);
  assert.equal(r.nextGrind, 14);
  assert.equal(r.tempDelta, 0);
});

test('bitter and slow grinds coarser; higher-is-finer grinders move the other way', () => {
  const r = nextStep({ ...base, shot: { seconds: 42, yieldG: 36, targetYield: 36 }, feedback: { taste: 'bitter', rating: 2 } });
  assert.equal(r.nextGrind, 16);
  const r2 = nextStep({ ...base, grinder: { step: 0.5, finerIsLower: false }, shot: { seconds: 42 }, feedback: { taste: 'bitter' } });
  assert.equal(r2.nextGrind, 14);
});

test('sour on time changes temperature, not grind', () => {
  const r = nextStep({ ...base, shot: { seconds: 30, yieldG: 36, targetYield: 36 }, feedback: { taste: 'sour', rating: 3 } });
  assert.equal(r.tempDelta, 1);
  assert.equal(r.grindDir, 0);
  assert.equal(r.nextGrind, 15);
});

test('temperature at the limit falls back to grind', () => {
  const r = nextStep({ ...base, temperature: 96, shot: { seconds: 30 }, feedback: { taste: 'sour' }, limits: { maxTemperature: 96 } });
  assert.equal(r.tempDelta, 0);
  assert.equal(r.grindDir, -1);
});

test('step halves when the direction flips, never below the grinder step', () => {
  const dial = { grind: 14, step: 1, lastDir: -1, goodStreak: 0 };
  const r = nextStep({ ...base, dial, shot: { seconds: 40, yieldG: 36, targetYield: 36 }, feedback: { taste: 'bitter' } });
  assert.equal(r.grindStep, 0.5);
  assert.equal(r.nextGrind, 14.5);
  const r2 = nextStep({ ...base, dial: { ...r.dial }, shot: { seconds: 18 }, feedback: { taste: 'sour' } });
  assert.equal(r2.grindStep, 0.5);
});

test('two good shots in a row mean dialed in', () => {
  const good = { shot: { seconds: 29, yieldG: 36, targetYield: 36 }, feedback: { taste: 'balanced', rating: 4 } };
  const a = nextStep({ ...base, ...good });
  assert.equal(a.dialedIn, false);
  const b = nextStep({ ...base, dial: a.dial, ...good });
  assert.equal(b.dialedIn, true);
  const c = nextStep({ ...base, dial: b.dial, shot: { seconds: 29 }, feedback: { taste: 'sour', rating: 2 } });
  assert.equal(c.goodStreak, 0);
});

test('short yield counts as slow', () => {
  const r = nextStep({ ...base, shot: { seconds: 30, yieldG: 25, targetYield: 36 }, feedback: { taste: 'bitter' } });
  assert.equal(r.timing, 'slow');
  assert.equal(r.grindDir, 1);
});

test('salami cups are flow-controlled and last long enough to swap', () => {
  for (const level of ['light', 'medium', 'dark']) {
    const plan = planSalami({ roastLevel: level }, 18);
    const prof = salamiProfile({ name: 'x' }, plan);
    for (const ph of prof.phases.slice(1)) {
      assert.equal(ph.pump.target, 'flow');
      assert.ok(ph.pump.pressure > 0 && ph.pump.pressure <= 10);
    }
    const cupSeconds = plan.cups[0].water / plan.cupFlow;
    assert.ok(cupSeconds >= 9, `${level}: ${cupSeconds.toFixed(1)} s per cup`);
  }
  assert.equal(fmtGrind(14.5, 0.5), '14.5');
  assert.equal(fmtGrind(15, 0.5), '15');
});

test('use-by: printed date wins, else roast date + days, else none', async () => {
  const { useByFor, isExpired } = await import('../dialin/www/lib/dialin.js');
  assert.equal(useByFor({ roastDate: '2026-09-01', bestBefore: '2027-03-31' }, 60), '2027-03-31');
  assert.equal(useByFor({ roastDate: '2026-09-01' }, 60), '2026-10-31');
  assert.equal(useByFor({ roastDate: '2026-09-01' }, 0), '');
  assert.equal(useByFor({}, 60), '');
  assert.equal(useByFor(undefined, 60), '');
  assert.equal(isExpired({ useBy: '2026-11-24' }, '2026-11-25'), true);
  assert.equal(isExpired({ useBy: '2026-11-25' }, '2026-11-25'), false);
  assert.equal(isExpired({ useBy: '2026-11-01', useByIgnored: true }, '2026-11-25'), false);
  assert.equal(isExpired({ useBy: '' }, '2026-11-25'), false);
});

test('bag stock: estimate from bag size, dose and shots; low under 4 shots', async () => {
  const { bagStock } = await import('../dialin/www/lib/dialin.js');
  const a = bagStock({ batch: { bagSizeG: 250 }, dose: 18, shots: 5 });
  assert.equal(a.leftG, 160);
  assert.equal(a.shotsLeft, 8);
  assert.equal(a.low, false);
  assert.equal(a.percent, 64);
  const b = bagStock({ batch: { bagSizeG: 250 }, dose: 18, shots: 11 });
  assert.equal(b.shotsLeft, 2);
  assert.equal(b.low, true);
  assert.equal(bagStock({ batch: { bagSizeG: 250 }, dose: 18, shots: 20 }).empty, true);
  assert.equal(bagStock({ batch: {}, dose: 18, shots: 1 }), null);
  // after weighing: count down from the weighed amount
  const c = bagStock({ batch: { bagSizeG: 250, calib: { leftG: 120, atShots: 6 } }, dose: 18, shots: 8 });
  assert.equal(c.leftG, 84);
});

test('bag shot counting is incremental and ignores other profiles', async () => {
  const { newShotsForBag } = await import('../dialin/www/lib/dialin.js');
  const batch = { createdAt: '2026-11-01T00:00:00.000Z', countedShots: 3, lastShotId: 40 };
  const entries = [
    { id: '42', profileId: 'P1', timestamp: 1764300000 },
    { id: '41', profileId: 'P1', timestamp: 1764200000 },
    { id: '39', profileId: 'P1', timestamp: 1764100000 }, // already counted
    { id: '43', profileId: 'OTHER', timestamp: 1764300000 },
  ];
  const r = newShotsForBag(entries, { profileId: 'P1', batch });
  assert.equal(r.count, 2);
  assert.equal(r.lastShotId, 42);
  // first count on a fresh bag ignores shots pulled before it was opened
  const fresh = { createdAt: '2026-11-20T00:00:00.000Z' };
  const r2 = newShotsForBag([{ id: '10', profileId: 'P1', timestamp: 1763000000 }, { id: '11', profileId: 'P1', timestamp: 1795900000 }], { profileId: 'P1', batch: fresh });
  assert.equal(r2.count, 1);
  assert.equal(r2.lastShotId, 11);
});

test("the roaster's espresso recipe drives the starting ratio, not a 1:3 cap", async () => {
  const { roasterRecipe, shotWindow, recommend } = await import('../dialin/www/lib/dialin.js');
  // Hola Coffee San Isidro: 17 g in, 52 g out in 29 s
  const bean = { roastLevel: 'medium', recipe: { dose: 17, yield: 52, ratio: null, timeS: 29, tempC: null, source: 'Hola Coffee' } };
  const r = roasterRecipe(bean);
  assert.equal(r.dose, 17);
  assert.equal(r.yieldG, 52);
  assert.equal(r.ratio, 3.05);
  assert.equal(r.timeS, 29);
  // ratio from a yield-only recipe
  assert.equal(roasterRecipe({ recipe: { dose: 18, yield: 48, timeS: 27 } }).ratio, 2.65);
  assert.equal(roasterRecipe({ recipe: {} }), null);
  // "fast" and "slow" follow the roaster's target time
  assert.deepEqual(shotWindow(29), { fast: 24, slow: 35, target: 29 });
  assert.deepEqual(shotWindow(45), { fast: 40, slow: 51, target: 45 });
  assert.equal(shotWindow(null).slow, 36);
  // a salami tasting that points past 1:3 is no longer clamped to 1:3
  const rec = recommend({
    bean,
    plan: { dose: 17, temperature: 93, cups: [{ water: 17 }, { water: 17 }, { water: 18 }], cupFlow: 1.5 },
    cups: [{ weight: 17, sour: true }, { weight: 17, sweet: true }, { weight: 18, sweet: true }],
  });
  assert.equal(rec.ratio, 3.05);
  assert.ok(rec.reasons.some(x => x.includes('Hola Coffee')));
});

test('calibration log: which offset a shot was pulled on, and where it changed', async () => {
  const { offsetForShot, calibrationBetween } = await import('../dialin/www/lib/dialin.js');
  const log = [
    { id: '1', at: '2026-11-25T18:30:00', epoch: 1795617000, offset: 13, previous: 0, afterShotId: 10 },
  ];
  assert.equal(offsetForShot(log, { id: 11, timestamp: 1795617600 }, 13), 13); // after the change
  assert.equal(offsetForShot(log, { id: 9, timestamp: 1795600000 }, 13), 0); // before it
  assert.equal(offsetForShot([], { id: 9 }, 13), 13); // no log: assume today's value
  // the divider falls between shot 11 and shot 9, not between 11 and 12
  assert.equal(calibrationBetween(log, { id: 11 }, { id: 9 })?.offset, 13);
  assert.equal(calibrationBetween(log, { id: 12 }, { id: 11 }), null);
  // two changes: the newest one that applies wins
  const two = [...log, { id: '2', at: '2026-11-26T09:00:00', epoch: 1795670000, offset: 11, previous: 13, afterShotId: 14 }];
  assert.equal(offsetForShot(two, { id: 15 }, 11), 11);
  assert.equal(offsetForShot(two, { id: 12 }, 11), 13);
});
