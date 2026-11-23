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
