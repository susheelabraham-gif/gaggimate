// Bean research with Claude, called straight from the browser with the user's own
// API key (kept in this browser's localStorage only, never written to the SD card).
import { ROAST_LEVELS } from './dialin.js';

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
Use the photo of the bag and/or the name given. Search the web for the roaster's own product page first, then other sources (reviews, forums such as Reddit, coffee blogs) describing how this coffee behaves as espresso.
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
  "bagSizeG": number|null,
  "recipe": {"dose": number|null, "yield": number|null, "ratio": number|null, "timeS": number|null, "tempC": number|null, "source": string|null} | null,
  "community": [{"summary": string, "source": string}],   // at most 4, about espresso
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
    bagSizeG: num(b.bagSizeG),
    recipe,
    community: Array.isArray(b.community) ? b.community.slice(0, 4) : [],
    confidence: ['low', 'medium', 'high'].includes(b.confidence) ? b.confidence : 'low',
    sources: Array.isArray(b.sources) ? b.sources.filter(s => /^https?:\/\//.test(s?.url || '')).slice(0, 8) : [],
  };
}

export async function researchBean({ name, photoBase64, fetchFn = fetch }) {
  const apiKey = aiSettings.apiKey;
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  const content = [];
  if (photoBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } });
  }
  content.push({
    type: 'text',
    text: name ? `Coffee: ${name}` : 'Identify the coffee in this photo of the bag.',
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
