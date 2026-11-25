// Bean research with Claude, called straight from the browser with the user's own
// API key (kept in this browser's localStorage only, never written to the SD card).
import { ROAST_LEVELS } from './dialin.js';

export const BREW_METHODS = [
  ['espresso', 'Espresso'],
  ['milk', 'Milk drinks'],
  ['americano', 'Americano / long black'],
  ['pourover', 'Pour-over (V60)'],
  ['chemex', 'Chemex'],
  ['aeropress', 'AeroPress'],
  ['frenchPress', 'French press'],
  ['coldBrew', 'Cold brew'],
];
export const BREW_RATINGS = ['recommended', 'suitable', 'not recommended'];

const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const KEY_STORE = 'dialin.apiKey';
const MODEL_STORE = 'dialin.model';

function storeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storeSet(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: key lives for this page only */
  }
}

let memoryKey = null;
export const aiSettings = {
  get apiKey() {
    return storeGet(KEY_STORE) || memoryKey;
  },
  set apiKey(v) {
    memoryKey = v || null;
    storeSet(KEY_STORE, v);
  },
  get model() {
    return storeGet(MODEL_STORE) || DEFAULT_MODEL;
  },
  set model(v) {
    storeSet(MODEL_STORE, v && v !== DEFAULT_MODEL ? v : null);
  },
};

const INSTRUCTIONS = `You identify specialty coffee beans for an espresso dial-in assistant.
Use the photos of the bag and/or the name given. Several photos may show different sides of the same bag (front with the name, back with roast and use-by dates): combine them. Search the web for the roaster's own product page first, then other sources (reviews, forums such as Reddit, coffee blogs) describing how this coffee behaves as espresso.
Also find which brew methods the roaster recommends this coffee for (espresso, milk drinks, americano/long black, pour-over, Chemex, AeroPress, French press, cold brew) and whether it is an espresso, filter or omni roast. Rate a method "recommended" when the roaster or several sources recommend it, "suitable" when it is reasonable for this roast, "not recommended" when the roaster or sources advise against it.
Only report what the label or sources say; use null for anything unknown. Never invent a roast date.
Reply with ONE JSON object and nothing else, in this shape:
{
  "roaster": string|null,
  "name": string,                       // coffee name as sold
  "origin": {"country": string|null, "region": string|null, "farm": string|null},
  "process": string|null,               // washed, natural, honey, anaerobic...
  "variety": string|null,
  "blend": boolean|null,                // true if a blend of several origins
  "roastLevel": "${ROAST_LEVELS.join('"|"')}",
  "tastingNotes": [string],
  "roastDate": "YYYY-MM-DD"|null,       // only if printed on the bag
  "bestBefore": "YYYY-MM-DD"|null,      // use-by / best-before / expiry date printed on the bag; month-only dates mean the month's last day
  "bagSizeG": number|null,
  "recipe": {"dose": number|null, "yield": number|null, "ratio": number|null, "timeS": number|null, "tempC": number|null, "source": string|null} | null,
                                        // ESPRESSO recipe only. Roasters often print several
                                        // recipes (espresso, filter/V60, batch brew, cold brew);
                                        // take the espresso one, whatever it is called
                                        // (espresso, ristretto, "para espresso"). Never a filter
                                        // recipe: those pour far more water through (1:14 and up,
                                        // yields in the hundreds of grams). If the page has no
                                        // espresso recipe, use null here and put the filter one in
                                        // "brewNote".
  "community": [{"summary": string, "source": string}],   // at most 4, about espresso
  "roastedFor": "espresso"|"filter"|"omni"|null,          // what the roaster says the roast is for
  "brewMethods": {                      // per method: how well this coffee suits it, from the roaster first, then other sources
    "espresso": "recommended"|"suitable"|"not recommended"|null,
    "milk": ...,                        // flat white, cappuccino, latte
    "americano": ...,                   // americano / long black
    "pourover": ...,                    // V60, Kalita and similar
    "chemex": ...,
    "aeropress": ...,
    "frenchPress": ...,
    "coldBrew": ...
  },
  "brewNote": string|null,              // one short sentence on the best way to brew it, with its source
  "logoUrl": string|null,               // direct https link to the roaster's logo image file (png/jpg/webp/svg), ideally square: their site's icon or logo; null if not found
  "confidence": "low"|"medium"|"high",
  "sources": [{"title": string, "url": string}]
}`;

// Resize a photo to keep the request small (long side at most 1568 px).
export async function photoToBase64(file, maxSide = 1568) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI reply had no JSON in it.');
  return JSON.parse(text.slice(start, end + 1));
}

// Does this look like an espresso recipe rather than a filter one?
export function isEspressoRecipe(r) {
  if (!r) return false;
  const ratio = r.ratio || (r.dose && r.yield ? r.yield / r.dose : null);
  if (ratio && ratio > 4) return false;
  if (r.yield && r.yield > 150) return false;
  if (r.timeS && r.timeS > 120) return false; // minutes-long brew = not espresso
  if (r.dose && (r.dose < 5 || r.dose > 30)) return false;
  return !!(ratio || r.dose || r.yield || r.tempC);
}

export function normalizeBean(raw) {
  const b = raw || {};
  const level = ROAST_LEVELS.includes(b.roastLevel) ? b.roastLevel : 'medium';
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const recipe = b.recipe
    ? {
        dose: num(b.recipe.dose),
        yield: num(b.recipe.yield),
        ratio: num(b.recipe.ratio),
        timeS: num(b.recipe.timeS),
        tempC: num(b.recipe.tempC),
        source: b.recipe.source || null,
      }
    : null;
  // Guard against a filter recipe arriving in the espresso field: espresso is
  // roughly 1:1 to 1:4 and tens of grams, filter is 1:14 and up, hundreds of grams.
  const espressoRecipe = isEspressoRecipe(recipe) ? recipe : null;
  return {
    roaster: b.roaster || '',
    name: b.name || '',
    origin: { country: b.origin?.country || '', region: b.origin?.region || '', farm: b.origin?.farm || '' },
    process: b.process || '',
    variety: b.variety || '',
    blend: b.blend === true,
    roastLevel: level,
    roastLevelGuessed: !ROAST_LEVELS.includes(b.roastLevel),
    tastingNotes: Array.isArray(b.tastingNotes) ? b.tastingNotes.slice(0, 8).map(String) : [],
    roastDate: /^\d{4}-\d{2}-\d{2}$/.test(b.roastDate || '') ? b.roastDate : '',
    bestBefore: /^\d{4}-\d{2}-\d{2}$/.test(b.bestBefore || '') ? b.bestBefore : '',
    bagSizeG: num(b.bagSizeG),
    recipe: espressoRecipe,
    community: Array.isArray(b.community) ? b.community.slice(0, 4) : [],
    roastedFor: ['espresso', 'filter', 'omni'].includes(b.roastedFor) ? b.roastedFor : '',
    brewMethods: Object.fromEntries(
      BREW_METHODS.map(([k]) => [k, BREW_RATINGS.includes(b.brewMethods?.[k]) ? b.brewMethods[k] : '']),
    ),
    brewNote: typeof b.brewNote === 'string' ? b.brewNote.slice(0, 300) : '',
    logoUrl: /^https:\/\/\S{4,490}$/.test(b.logoUrl || '') ? b.logoUrl : '',
    confidence: ['low', 'medium', 'high'].includes(b.confidence) ? b.confidence : 'low',
    sources: Array.isArray(b.sources) ? b.sources.filter(s => /^https?:\/\//.test(s?.url || '')).slice(0, 8) : [],
  };
}

function imageBlocks(photos) {
  return photos.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }));
}

export async function researchBean({ name, photoBase64, photos = [], fetchFn = fetch }) {
  const apiKey = aiSettings.apiKey;
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  const all = [...(photoBase64 ? [photoBase64] : []), ...photos].slice(0, 4);
  const content = imageBlocks(all);
  content.push({
    type: 'text',
    text: name
      ? `Coffee: ${name}`
      : all.length > 1
        ? `Identify the coffee in these ${all.length} photos of the same bag.`
        : 'Identify the coffee in this photo of the bag.',
  });

  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: aiSettings.model,
      max_tokens: 4000,
      system: INSTRUCTIONS,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `AI request failed (${res.status})`;
    throw new Error(msg);
  }
  const texts = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    try {
      return normalizeBean(extractJson(texts[i]));
    } catch {
      /* try an earlier text block */
    }
  }
  throw new Error('Could not read the AI reply. Try again or fill in the details by hand.');
}

const BAG_INSTRUCTIONS = `You read the printed details on photos of a coffee bag (possibly several sides of one bag).
Reply with ONE JSON object and nothing else:
{"name": string|null, "roaster": string|null,
 "roastDate": "YYYY-MM-DD"|null,      // roast (or grind) date printed on the bag
 "bestBefore": "YYYY-MM-DD"|null,     // use-by / best-before / expiry; a month-only date means that month's last day
 "bagSizeG": number|null,
 "note": string|null}                 // say here if a date was hard to read or ambiguous (e.g. 03/04/26)
Use null for anything not printed. Never guess a date.`;

// Read just the dates (and name) from bag photos: no web search, so it's quick and cheap.
export async function readBag({ photos, fetchFn = fetch }) {
  const apiKey = aiSettings.apiKey;
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  if (!photos?.length) throw new Error('Add a photo of the bag first.');
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: aiSettings.model,
      max_tokens: 600,
      system: BAG_INSTRUCTIONS,
      messages: [{ role: 'user', content: [...imageBlocks(photos.slice(0, 4)), { type: 'text', text: 'Read this bag.' }] }],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `AI request failed (${res.status})`);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const raw = extractJson(text);
  const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : '');
  return {
    name: raw.name || '',
    roaster: raw.roaster || '',
    roastDate: date(raw.roastDate),
    bestBefore: date(raw.bestBefore),
    bagSizeG: typeof raw.bagSizeG === 'number' && raw.bagSizeG > 0 ? raw.bagSizeG : null,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
  };
}
