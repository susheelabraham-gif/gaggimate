import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage for node.
globalThis.localStorage = {
  m: new Map(),
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  },
  setItem(k, v) {
    this.m.set(k, String(v));
  },
  removeItem(k) {
    this.m.delete(k);
  },
};

const { researchBean, aiSettings, normalizeBean, extractJson } = await import('../dialin/www/lib/ai.js');

test('builds a web-search request with the browser header and parses the last JSON text', async () => {
  aiSettings.apiKey = 'sk-test';
  let sent;
  const fetchFn = async (url, opts) => {
    sent = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Searching…' },
          { type: 'server_tool_use', name: 'web_search' },
          {
            type: 'text',
            text: 'Here you go: {"roaster":"Square Mile","name":"Red Brick","roastLevel":"medium-dark","tastingNotes":["chocolate"],"recipe":{"dose":18,"yield":36},"confidence":"high","sources":[{"title":"x","url":"https://example.com"},{"title":"bad","url":"javascript:1"}]}',
          },
        ],
      }),
    };
  };
  const bean = await researchBean({ name: 'Red Brick', fetchFn });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(sent.opts.headers['x-api-key'], 'sk-test');
  assert.equal(sent.body.model, 'claude-sonnet-5-5');
  assert.equal(sent.body.tools[0].type, 'web_search_20250305');
  assert.equal(bean.roaster, 'Square Mile');
  assert.equal(bean.roastLevel, 'medium-dark');
  assert.equal(bean.recipe.yield, 36);
  assert.equal(bean.sources.length, 1); // non-http link dropped
});

test('sends the photo as a base64 image block', async () => {
  aiSettings.apiKey = 'sk-test';
  let body;
  await researchBean({
    photoBase64: 'AAAA',
    fetchFn: async (u, o) => {
      body = JSON.parse(o.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"name":"X"}' }] }) };
    },
  });
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[0].source.data, 'AAAA');
});

test('API errors and missing key are reported clearly', async () => {
  aiSettings.apiKey = '';
  await assert.rejects(researchBean({ name: 'x', fetchFn: async () => ({}) }), /API key/);
  aiSettings.apiKey = 'sk-test';
  await assert.rejects(
    researchBean({ name: 'x', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) }) }),
    /invalid x-api-key/,
  );
});

test('normalizeBean guards unknown values and fake dates', () => {
  const b = normalizeBean({ name: 'Y', roastLevel: 'blonde', roastDate: 'last week', recipe: { ratio: 'two' } });
  assert.equal(b.roastLevel, 'medium');
  assert.equal(b.roastLevelGuessed, true);
  assert.equal(b.roastDate, '');
  assert.equal(b.recipe.ratio, null);
  assert.throws(() => extractJson('no json here'));
});

test('normalizeBean keeps known brew-method ratings and drops the rest', () => {
  const b = normalizeBean({
    name: 'Z',
    roastedFor: 'filter',
    brewMethods: { espresso: 'not recommended', pourover: 'recommended', chemex: 'great', bogus: 'recommended' },
    brewNote: 'Roaster suggests V60 at 1:16.',
  });
  assert.equal(b.roastedFor, 'filter');
  assert.equal(b.brewMethods.espresso, 'not recommended');
  assert.equal(b.brewMethods.pourover, 'recommended');
  assert.equal(b.brewMethods.chemex, '');
  assert.equal(b.brewMethods.bogus, undefined);
  assert.equal(normalizeBean({ roastedFor: 'turkish' }).roastedFor, '');
});

test('looking a coffee up again keeps its own details and adds the brew methods', async () => {
  const { mergeResearch } = await import('../dialin/www/beans.js');
  const bean = { id: 'hola-san-isidro', name: 'San Isidro', roaster: 'Hola', process: 'washed', tastingNotes: ['plum'],
    origin: { country: 'Colombia', region: '', farm: '' }, profileId: 'abc', dial: { grind: 14 }, shots: [{ id: 1 }], community: [] };
  const found = normalizeBean({ name: 'San Isidro', process: 'natural', origin: { country: 'Colombia', region: 'Huila' },
    tastingNotes: ['cherry'], roastedFor: 'omni', brewMethods: { espresso: 'recommended', chemex: 'suitable' }, confidence: 'high' });
  const m = mergeResearch(bean, found);
  assert.equal(m.process, 'washed');
  assert.deepEqual(m.tastingNotes, ['plum']);
  assert.equal(m.origin.region, 'Huila');
  assert.equal(m.brewMethods.espresso, 'recommended');
  assert.equal(m.roastedFor, 'omni');
  assert.equal(m.profileId, 'abc');
  assert.equal(m.dial.grind, 14);
  assert.equal(m.shots.length, 1);
});

test('a coffee the roaster advises against for espresso is flagged', async () => {
  const { notForEspresso } = await import('../dialin/www/beans.js');
  assert.equal(notForEspresso({ brewMethods: { espresso: 'not recommended' } }), true);
  assert.equal(notForEspresso({ roastedFor: 'filter', brewMethods: {} }), true);
  assert.equal(notForEspresso({ roastedFor: 'omni', brewMethods: { espresso: 'suitable' } }), false);
  assert.equal(notForEspresso({}), false);
});
