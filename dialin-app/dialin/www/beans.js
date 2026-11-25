// Beans tab: add a coffee (photo or name → AI research → review), new-batch
// detection, salami diagnostic (plan → run with cup cues → tasting → recipe),
// and saving the starting profile to the machine.
import { researchBean, readBag, photoToBase64, aiSettings, BREW_METHODS } from './lib/ai.js';
import { makeThumb, nameTile, toDataUrl, uploadProfileThumb } from './lib/thumb.js';
import {
  ROAST_LEVELS,
  planSalami,
  salamiProfile,
  recommend,
  startingProfile,
  startingGrind,
  roastDefaults,
  slug,
  fmtGrind,
  fmtRatio,
  useByFor,
  isExpired,
  localToday,
  bagStock,
  newShotsForBag,
  roasterRecipe,
} from './lib/dialin.js';

const today = () => new Date().toISOString().slice(0, 10);
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function initBeans({ gm, root, toast, getSettings }) {
  const state = { view: 'list', bean: null, batch: null, plan: null, run: null, feedback: null, rec: null };

  // ------------------------------------------------------------ helpers
  const settings = () => getSettings();
  const useBy = batch => useByFor(batch, settings().freshDays ?? 60);
  const doseFor = bean => Number(bean?.start?.dose) || Number(settings().dose) || 18;
  const stockFor = (bean, batch) => bagStock({ batch, dose: doseFor(bean), shots: Number(batch?.countedShots) || 0 });

  // Count shots pulled on each coffee's profile (rated or not) and remember the
  // running total on its current bag, so the estimate survives the 50-shot window.
  async function countShots(beans, batches) {
    const withProfile = beans.filter(b => b.profileId && latestBatch(batches, b.id));
    if (!withProfile.length) return;
    const entries = await gm.recentShots(50).catch(() => null);
    if (!entries) return;
    for (const bean of withProfile) {
      const batch = latestBatch(batches, bean.id);
      const { count, lastShotId } = newShotsForBag(entries, { profileId: bean.profileId, batch });
      if (count || batch.lastShotId !== lastShotId) {
        batch.countedShots = (Number(batch.countedShots) || 0) + count;
        batch.lastShotId = lastShotId;
        await gm.putRecord('batches', batch.id, batch).catch(() => {});
      }
      // Leave the figure on the coffee too: the machine reads it to warn when the
      // bag is nearly finished, counting down the shots pulled since this shot id.
      const st = stockFor(bean, batch);
      const stock = st ? { leftG: st.leftG, dose: st.dose, shotId: lastShotId } : null;
      const old = bean.stock || null;
      if (JSON.stringify(old) !== JSON.stringify(stock)) {
        bean.stock = stock;
        await gm.putRecord('beans', bean.id, bean).catch(() => {});
      }
    }
  }

  function stockLine(bean, batch) {
    const st = stockFor(bean, batch);
    if (!st) return '';
    const label = st.empty
      ? 'Bag looks empty'
      : `≈ ${st.leftG} g left · about ${st.shotsLeft} shot${st.shotsLeft === 1 ? '' : 's'}`;
    const bar = st.percent == null ? '' : `<span class="bar"><span style="width:${st.percent}%"></span></span>`;
    return `<div class="small stock ${st.low ? 'warn-text' : 'muted'}">${bar}${st.low ? '⚠ ' : ''}${esc(label)}${st.low && !st.empty ? ' — running low' : ''}</div>`;
  }

  const latestBatch = (batches, beanId) =>
    batches.filter(x => x.beanId === beanId).sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''))[0];

  // Photos of the bag (several sides), shared by Add and Details.
  function photoPicker(label = 'Photos of the bag') {
    const ph = state.photos || [];
    return `<div class="field"><span>${label} <span class="muted small">(up to 4: front, back, side…)</span></span>
      <div class="photo-strip">${ph.map((p, i) => `<div class="ph"><img src="${p.url}" alt=""/><button class="ph-x" data-act="photo-remove" data-i="${i}" aria-label="Remove">×</button></div>`).join('')}
      ${ph.length < 4 ? `<label class="ph add"><input type="file" accept="image/*" multiple data-photos hidden/><span>＋<br/><small>${ph.length ? 'Add side' : 'Add photo'}</small></span></label>` : ''}</div></div>`;
  }
  root.addEventListener('change', async e => {
    if (!e.target.matches('[data-photos]')) return;
    const files = [...e.target.files].slice(0, 4 - (state.photos || []).length);
    const keep = readForm();
    for (const f of files) {
      try {
        state.photos = [...(state.photos || []), { url: URL.createObjectURL(f), base64: await photoToBase64(f) }];
      } catch {
        toast(`Couldn't read ${f.name}.`, 'error');
      }
    }
    render();
    restoreForm(keep);
  });
  // Keep typed values across a re-render.
  const readForm = () => [...root.querySelectorAll('input[id], input[data-k], input[data-bag], select[data-k]')].map(el => [el.id || el.dataset.k || el.dataset.bag, el.value]);
  const restoreForm = vals => {
    for (const [k, v] of vals) {
      const el = root.querySelector(`#${CSS.escape(k)}`) || root.querySelector(`[data-k="${k}"]`) || root.querySelector(`[data-bag="${k}"]`);
      if (el && el.type !== 'file') el.value = v;
    }
  };
  const show = (view, patch = {}) => {
    Object.assign(state, patch, { view });
    render();
    window.scrollTo({ top: 0 });
  };
  const busy = (btn, label) => {
    if (!btn) return () => {};
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return () => {
      btn.disabled = false;
      btn.textContent = old;
    };
  };

  // Short beep + vibration for cup changes. Audio is unlocked by a button tap.
  let audio = null;
  const unlockAudio = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume?.();
    } catch {
      audio = null;
    }
  };
  const cue = () => {
    navigator.vibrate?.([200, 80, 200]);
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.35);
  };

  // ------------------------------------------------------------ views
  async function renderList() {
    root.innerHTML = `<div class="card"><div class="row spread"><h2>Your coffees</h2>
      <button class="primary" data-act="add">+ Add coffee</button></div>
      <ul class="list" id="bean-list"><li class="muted">Loading…</li></ul></div>`;
    try {
      const [beans, batches] = await Promise.all([gm.getAll('beans'), gm.getAll('batches')]);
      const list = root.querySelector('#bean-list');
      if (!beans.length) {
        list.innerHTML = '<li class="muted">No coffees yet. Add one to get a starting profile.</li>';
        return;
      }
      beans.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      // Keep each coffee's use-by in step with its latest bag (the machine reads it).
      for (const b of beans) {
        const want = useBy(latestBatch(batches, b.id));
        if ((b.useBy || '') !== want) {
          b.useBy = want;
          gm.putRecord('beans', b.id, b).catch(() => {});
        }
      }
      await countShots(beans, batches);
      const today = localToday();
      list.innerHTML = beans
        .map(b => {
          const expired = isExpired(b, today);
          const latest = batches.filter(x => x.beanId === b.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
          const mode = { dialing: 'Dialing in', dialed: 'Dialed in', recalibrate: 'Recalibrate', new: 'New', stored: 'Saved only' }[b.mode] || 'New';
          return `<li class="with-thumb"><img class="thumb" alt="" src="${esc(thumbSrc(b))}"/><div class="grow"><div class="row"><strong>${esc(b.name)}</strong><span class="pill">${mode}</span>${expired ? '<span class="pill alarm">Past use-by</span>' : ''}</div>
            <div class="muted small">${esc([b.roaster, b.origin?.country, b.process, b.roastLevel].filter(Boolean).join(' · '))}</div>
            ${bestFor(b) ? `<div class="small">Best for: ${esc(bestFor(b))}</div>` : ''}
            ${latest ? `<div class="muted small">Bag roasted ${esc(latest.roastDate || 'date unknown')}, opened ${esc(latest.openedDate || '—')}</div>` : ''}
            ${stockLine(b, latest)}
            ${b.dial?.grind != null ? `<div class="small">Next grind: <strong>${esc(fmtGrind(b.dial.grind, settings().grinder?.step))}</strong>${b.shots?.length ? ` · ${b.shots.length} rated shot${b.shots.length > 1 ? 's' : ''}` : ''}</div>` : ''}
            ${b.useBy ? `<div class="small ${expired ? 'warn-text' : 'muted'}">Use by ${esc(b.useBy)}${b.useByIgnored ? ' (you chose to keep using it)' : ''}</div>` : ''}
            ${expired ? `<div class="row gap"><button class="link" data-act="details" data-bag="1" data-id="${esc(b.id)}">New bag? Scan it ›</button><button class="link" data-act="keep-bag" data-id="${esc(b.id)}">Keep using this bag ›</button></div>` : ''}
            <button class="link" data-act="details" data-id="${esc(b.id)}">Details, look up again or delete ›</button>
            ${!b.profileId ? `<button class="link" data-act="resume" data-id="${esc(b.id)}">${b.mode === 'stored' ? 'Make an espresso profile anyway ›' : 'Set up a starting profile ›'}</button>` : ''}
            ${b.profileId && b.mode === 'dialed' ? `<button class="link" data-act="set-mode" data-mode="recalibrate" data-id="${esc(b.id)}">Recalibrate (ask after every shot again) ›</button>` : ''}
            ${b.profileId && (b.mode === 'dialing' || b.mode === 'recalibrate') ? `<button class="link" data-act="set-mode" data-mode="dialed" data-id="${esc(b.id)}">Stop asking, it's dialed in ›</button>` : ''}</div></li>`;
        })
        .join('');
    } catch (err) {
      root.querySelector('#bean-list').innerHTML = `<li class="error">${esc(err.message)}</li>`;
    }
  }

  function renderAdd() {
    const hasKey = !!aiSettings.apiKey;
    root.innerHTML = `<div class="card"><h2>Add a coffee</h2>
      <p class="muted">Take photos of the bag (both sides if the dates are on the back), type its name, or both. The assistant looks it up online.</p>
      ${hasKey ? '' : '<p class="error small">Add your Anthropic API key in Settings to look coffees up. You can still fill in the details by hand.</p>'}
      <label class="field"><span>Coffee name</span><input id="bean-name" placeholder="e.g. Square Mile Red Brick" autocomplete="off"/></label>
      ${photoPicker()}
      <div class="row gap">
        <button class="primary" data-act="research" ${hasKey ? '' : 'disabled'}>Look it up</button>
        <button data-act="manual">Fill in by hand</button>
        <button class="link" data-act="list">Cancel</button>
      </div></div>`;
  }

  function beanField(label, key, value, attrs = '') {
    return `<label class="field"><span>${label}</span><input data-k="${key}" value="${esc(value)}" ${attrs}/></label>`;
  }

  function renderReview() {
    const b = state.bean;
    const r = b.recipe;
    const recipe = r && (r.dose || r.yield || r.tempC)
      ? `<p class="small"><strong>Suggested recipe:</strong> ${[r.dose && `${r.dose} g in`, r.yield && `${r.yield} g out`, r.timeS && `${r.timeS} s`, r.tempC && `${r.tempC} °C`].filter(Boolean).join(', ')}${r.source ? ` <span class="muted">(${esc(r.source)})</span>` : ''}</p>`
      : '';
    const community = b.community?.length
      ? `<p class="small"><strong>What others say</strong></p><ul class="small">${b.community.map(c => `<li>${esc(c.summary)} <span class="muted">${esc(c.source || '')}</span></li>`).join('')}</ul>`
      : '';
    const brew = brewHtml(b);
    const sources = b.sources?.length
      ? `<p class="small muted">Sources: ${b.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join(' · ')}</p>`
      : '';
    const edit = state.view === 'edit';
    const bagFields = edit
      ? ''
      : `<div class="grid2">${beanField('Roast date', 'roastDate', b.roastDate, 'type="date"')}${beanField('Use by / best before', 'bestBefore', b.bestBefore, 'type="date"')}</div>
      ${beanField('Opened on', 'openedDate', b.openedDate || today(), 'type="date"')}
      ${beanField('Bag size (g)', 'bagSizeG', b.bagSizeG ?? 250, 'type="number" inputmode="numeric"')}`;
    const buttons = edit
      ? `<div class="row gap"><button class="primary" data-act="save-edit">Save changes</button>
        <button data-act="relookup" ${aiSettings.apiKey ? '' : 'disabled title="Add your API key in Settings"'}>Look up again</button>
        ${b.profileId ? '<button data-act="rebuild">Rebuild profile from recipe</button>' : ''}
        <button class="link" data-act="list">Cancel</button></div>
        <hr/><button class="danger" data-act="delete-bean">Delete this coffee</button>`
      : `<div class="row gap"><button class="primary" data-act="save-bean">Save coffee</button><button class="link" data-act="list">Cancel</button></div>`;
    root.innerHTML = `<div class="card"><div class="row spread"><h2>${edit ? esc(b.name) : 'Check the details'}</h2>
      ${b.confidence ? `<span class="pill ${b.confidence === 'high' ? 'ok' : b.confidence === 'low' ? 'warn' : ''}">${b.confidence} confidence</span>` : ''}</div>
      ${edit ? thumbBlock(b) : ''}
      ${edit ? bagBlock() : ''}
      ${state.relooked ? '<p class="small ok-text">Looked up again. Check the new details below, then save. Your profile, grind and ratings are kept.</p>' : ''}
      ${state.relooked ? '' : `<p class="muted small">${edit ? 'Edit the details or look the coffee up again. Your profile, grind and rated shots are kept.' : "Correct anything that's wrong. Roast level matters most: it sets the salami plan."}</p>`}
      ${beanField('Coffee name', 'name', b.name, 'required')}
      ${beanField('Roaster', 'roaster', b.roaster)}
      <div class="grid2">${beanField('Country', 'origin.country', b.origin.country)}${beanField('Region', 'origin.region', b.origin.region)}</div>
      <div class="grid2">${beanField('Process', 'process', b.process)}${beanField('Variety', 'variety', b.variety)}</div>
      <label class="field"><span>Roast level${b.roastLevelGuessed ? ' <span class="warn-text">(not found, please check)</span>' : ''}</span>
        <select data-k="roastLevel">${ROAST_LEVELS.map(l => `<option ${l === b.roastLevel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${beanField('Tasting notes', 'tastingNotes', b.tastingNotes.join(', '))}
      ${bagFields}
      <label class="field"><span>Roasted for</span>
        <select data-k="roastedFor">${[['', 'not known'], ['espresso', 'espresso'], ['filter', 'filter'], ['omni', 'both (omni roast)']].map(([v, l]) => `<option value="${v}" ${v === (b.roastedFor || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${brew}${recipe}${community}${sources}
      ${buttons}</div>`;
  }

  function readReview() {
    const b = structuredClone(state.bean);
    for (const el of root.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      let v = el.value.trim();
      if (k === 'tastingNotes') v = v ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
      if (k === 'bagSizeG') v = Number(v) || 250;
      if (k.startsWith('origin.')) b.origin[k.slice(7)] = v;
      else b[k] = v;
    }
    return b;
  }

  function renderDelete() {
    const b = state.bean;
    root.innerHTML = `<div class="card"><h2>Delete ${esc(b.name)}?</h2>
      <p>This removes the coffee from Dial-in: its details, its bags and its rating log${b.shots?.length ? ` (${b.shots.length} rated shot${b.shots.length > 1 ? 's' : ''})` : ''}.</p>
      <p class="muted small">Kept on the machine: its shot profile${b.profileId ? '' : ' (if any)'} and your shot history with notes. Delete the profile in GaggiMate's Profiles page if you no longer want it.</p>
      <div class="row gap"><button class="danger" data-act="delete-confirm">Delete coffee</button>
      <button class="link" data-act="details" data-id="${esc(b.id)}">Keep it</button></div></div>`;
  }

  function renderNewBatch() {
    const b = state.bean;
    root.innerHTML = `<div class="card"><h2>New bag of ${esc(b.name)}?</h2>
      <p>You've had this coffee before${b.profileId ? ' and it has a profile' : ''}. A new bag of the same coffee usually needs only a small adjustment, so no salami shot is needed.</p>
      <div class="row gap"><button class="primary" data-act="batch-yes">Yes, new bag</button>
      <button data-act="batch-no">No, it's a different coffee</button></div></div>`;
  }

  function renderSalamiOffer() {
    const b = state.bean;
    const d = roastDefaults(b.roastLevel);
    if (notForEspresso(b)) {
      root.innerHTML = `<div class="card caution"><h2>⚠ Not recommended for espresso</h2>
        <p>${esc(b.roaster || 'The roaster')} ${b.brewMethods?.espresso === 'not recommended' ? 'advises against espresso for' : 'roasts for filter:'} ${esc(b.name)}.${bestFor(b) ? ` Recommended for: <strong>${esc(bestFor(b))}</strong>.` : ''}</p>
        ${b.brewNote ? `<p class="small">${esc(b.brewNote)}</p>` : ''}
        <p class="small">As espresso it will likely taste sour and need many shots to dial in. You can store its details only and brew it another way.</p>
        <div class="row gap"><button class="primary" data-act="store-only" autofocus>Store data only</button>
        <button data-act="salami-setup">Salami shot anyway</button>
        <button data-act="skip-salami">Standard start anyway</button></div></div>`;
      return;
    }
    root.innerHTML = `<div class="card"><h2>Start with a salami shot?</h2>
      <p>One shot split into ${d.cups} cups shows where ${esc(b.name)} turns from sour to sweet to bitter. Your tasting then sets the starting recipe.</p>
      <p class="muted small">It uses a full dose and takes about 10 minutes including tasting. You sip the cups rather than drink a normal shot.</p>
      <div class="row gap"><button class="primary" data-act="salami-setup">Plan the salami shot</button>
      <button data-act="skip-salami">Skip, use a standard start</button></div></div>`;
  }

  function renderSalamiSetup() {
    const b = state.bean;
    const recipe = roasterRecipe(b);
    const dose = state.plan?.dose ?? (recipe?.dose >= 7 && recipe?.dose <= 25 ? recipe.dose : null) ?? settings().dose ?? 18;
    const plan = planSalami(b, dose);
    state.plan = plan;
    const grind = startingGrind(b, settings().grinder);
    const rows = plan.cups
      .map(c => `<tr><td>Cup ${c.cup}</td><td>${c.water} g</td><td>${c.endGrams} g</td><td>1:${c.endRatio.toFixed(1)}</td></tr>`)
      .join('');
    root.innerHTML = `<div class="card"><h2>Salami plan</h2>
      <label class="field inline"><span>Dose</span><input id="dose" type="number" step="0.5" value="${dose}" inputmode="decimal"/> g</label>
      <table class="plan"><thead><tr><th></th><th>In cup</th><th>Total</th><th>Ratio</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted">${plan.temperature} °C, 3 bar pre-infusion for 8 s, then 9 bar. Each cup ends after its water is pumped.</p>
      <h3>Get ready</h3>
      <ol class="steps">
        <li>Grind ${dose} g${grind != null ? ` at <strong>${grind}</strong> on your ${esc(settings().grinder?.model || 'grinder')}` : ' at your usual espresso setting'}.</li>
        <li>Line up ${plan.cups.length} cups, and an empty one of the same kind for weighing later.</li>
        <li>Tap <em>Load on machine</em>, put cup 1 under the spout and press brew on the machine.</li>
        <li>When the screen shows the next cup (your phone beeps too), swap cups quickly.</li>
      </ol>
      <div class="row gap"><button class="primary" data-act="load-salami">Load on machine</button><button class="link" data-act="list">Cancel</button></div></div>`;
    root.querySelector('#dose').addEventListener('change', e => {
      const v = Number(e.target.value);
      if (v >= 7 && v <= 25) {
        state.plan = { ...plan, dose: v };
        renderSalamiSetup();
      }
    });
  }

  function renderSalamiRun() {
    const run = state.run;
    const cups = state.plan.cups;
    const current = run.cup; // 0 = pre-infusion / waiting
    const items = cups
      .map(c => `<li class="${c.cup === current ? 'now' : c.cup < current ? 'done' : ''}">Cup ${c.cup}<span>${c.water} g</span></li>`)
      .join('');
    const headline = run.saved
      ? 'Shot finished'
      : run.active
        ? current
          ? `Cup ${current}`
          : 'Pre-infusion'
        : 'Press brew on the machine';
    root.innerHTML = `<div class="card run"><p class="muted small">Salami · ${esc(state.bean.name)}</p>
      <div class="big">${headline}</div>
      <ul class="cups">${items}</ul>
      <p class="muted small">${run.active ? 'Swap cups when the machine shows the next cup.' : run.saved ? 'Loading the shot…' : 'Waiting for the shot to start. Cup 1 goes under the spout first.'}</p>
      <button class="link" data-act="list">Cancel</button></div>`;
  }

  function onStatus(s) {
    if (state.view !== 'salami-run' || !s) return;
    const run = state.run;
    const active = !!(s.process && s.process.a);
    const label = s.process?.l || '';
    const m = /^Cup (\d+)$/.exec(label);
    const cup = m ? Number(m[1]) : active ? 0 : run.cup;
    let changed = active !== run.active;
    if (cup !== run.cup) {
      if (cup > 0) cue();
      run.cup = cup;
      changed = true;
    }
    if (active) run.started = true;
    run.active = active;
    if (changed) renderSalamiRun();
  }

  async function onShotSaved(e) {
    if (state.view !== 'salami-run' || !state.run.started) return;
    state.run.saved = true;
    renderSalamiRun();
    const id = e.detail?.id;
    let seconds = null;
    try {
      const shot = await gm.loadShot(id);
      if (shot.duration) seconds = Math.max(1, shot.duration / 1000 - 8);
    } catch {
      /* the recommendation works without timing */
    }
    state.feedback = {
      shotId: id,
      seconds,
      blendBest: null,
      cups: state.plan.cups.map(c => ({ weight: '', sour: false, sweet: false, bitter: false, intensity: 3, body: 'medium' })),
    };
    show('salami-feedback');
  }

  function renderFeedback() {
    const fb = state.feedback;
    const cupCards = fb.cups
      .map(
        (c, i) => `<div class="cupcard" data-i="${i}"><div class="row spread"><strong>Cup ${i + 1}</strong>
        <span class="weigh"><input data-f="weight" type="number" step="0.1" inputmode="decimal" placeholder="g" value="${c.weight}"/> g
        <button class="small-btn" data-act="read-scale" data-i="${i}">Read scale</button></span></div>
        <div class="chips">${['sour', 'sweet', 'bitter'].map(t => `<button class="chip ${c[t] ? 'on' : ''}" data-act="toggle" data-t="${t}" data-i="${i}">${t}</button>`).join('')}</div>
        <div class="row gap small"><span class="muted">Strength</span>${[1, 2, 3, 4, 5].map(n => `<button class="dot ${c.intensity === n ? 'on' : ''}" data-act="intensity" data-n="${n}" data-i="${i}">${n}</button>`).join('')}</div>
        <div class="row gap small"><span class="muted">Body</span>${['thin', 'medium', 'heavy'].map(t => `<button class="chip small ${c.body === t ? 'on' : ''}" data-act="body" data-t="${t}" data-i="${i}">${t}</button>`).join('')}</div></div>`,
      )
      .join('');
    const blends = fb.cups
      .slice(1)
      .map((_, i) => `<option value="${i + 2}" ${fb.blendBest === i + 2 ? 'selected' : ''}>Cups 1–${i + 2}</option>`)
      .join('');
    root.innerHTML = `<div class="card"><h2>Taste each cup</h2>
      <p class="muted small">To weigh, put an empty cup on the scale, tare it, then swap in each cup and tap <em>Read scale</em>. Taste in order; tap everything you notice.</p>
      ${cupCards}
      <label class="field"><span>Blend test (optional): mix cups in order. Which tasted best?</span>
      <select id="blend"><option value="">Didn't try</option>${blends}</select></label>
      <div class="row gap"><button class="primary" data-act="recommend">Get my recipe</button></div></div>`;
    root.querySelector('#blend').addEventListener('change', e => (fb.blendBest = e.target.value ? Number(e.target.value) : null));
    for (const input of root.querySelectorAll('[data-f="weight"]')) {
      input.addEventListener('input', e => {
        const i = Number(e.target.closest('.cupcard').dataset.i);
        fb.cups[i].weight = e.target.value;
      });
    }
  }

  function renderRecommendation() {
    const { rec, bean, plan } = state;
    const grind = startingGrind(bean, settings().grinder);
    const grindLine =
      rec.grindAdvice === 'keep'
        ? `Keep the grind${grind != null ? ` at ${grind}` : ''}.`
        : `Grind a little ${rec.grindAdvice}${grind != null ? ` than ${grind}` : ''}.`;
    const rebuilding = !!state.rebuild && !!bean.profileId;
    root.innerHTML = `<div class="card"><h2>${rebuilding ? `Rebuild ${esc(bean.name)}'s profile` : `Starting recipe for ${esc(bean.name)}`}</h2>
      ${rebuilding ? `<p class="small muted">Replaces the profile on the machine with this recipe${roasterRecipe(bean) ? '' : ' (no roaster recipe found, so this is the standard start for this roast level)'}. Your grind, ratings and shot history are kept.</p>` : ''}
      <div class="stats">
        <div class="stat"><span class="label">Dose</span><strong>${plan.dose} g</strong></div>
        <div class="stat"><span class="label">Yield</span><strong>${rec.yieldG} g</strong></div>
        <div class="stat"><span class="label">Ratio</span><strong>1:${fmtRatio(rec.ratio)}</strong></div>
        <div class="stat"><span class="label">Temperature</span><strong>${rec.temperature} °C</strong></div>
      </div>
      <p><strong>${grindLine}</strong></p>
      <ul class="small">${rec.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      ${recipeSwitch(bean, rec, plan)}
      <div id="rec-errors"></div>
      <div class="row gap"><button class="primary" data-act="save-profile">${rebuilding ? 'Replace the profile on the machine' : 'Save profile and make it active'}</button><button class="link" data-act="list">Not now</button></div></div>`;
  }

  function renderDone() {
    const { bean, rec, plan } = state;
    root.innerHTML = `<div class="card"><h2>Ready for your first shot</h2>
      <p>The profile <strong>${esc(bean.name)}</strong> is active on the machine: ${plan.dose} g in, ${rec.yieldG} g out at ${rec.temperature} °C${rec.targetSeconds ? `, aiming for about ${rec.targetSeconds} s` : ''}.</p>
      ${state.bean.dial?.grind != null ? `<p>Grind at <strong>${esc(fmtGrind(state.bean.dial.grind, settings().grinder?.step))}</strong>. The profile's name on the machine shows the grind to use.</p>` : ''}
      <p class="muted">The coffee is now in <em>Dialing in</em> mode: after each shot you'll be asked to rate it here, and the machine asks before the next shot until you do.</p>
      <button class="primary" data-act="list">Done</button></div>`;
  }

  function render() {
    const views = {
      list: renderList,
      add: renderAdd,
      review: renderReview,
      edit: renderReview,
      delete: renderDelete,
      'new-batch': renderNewBatch,
      'salami-offer': renderSalamiOffer,
      'salami-setup': renderSalamiSetup,
      'salami-run': renderSalamiRun,
      'salami-feedback': renderFeedback,
      recommendation: renderRecommendation,
      done: renderDone,
    };
    (views[state.view] || renderList)();
  }

  // ------------------------------------------------------------ actions
  async function saveBean(btn) {
    const b = readReview();
    if (!b.name) return toast('Give the coffee a name.', 'error');
    const done = busy(btn, 'Saving…');
    try {
      const id = slug(`${b.roaster} ${b.name}`);
      const existing = await gm.getRecord('beans', id);
      const now = new Date().toISOString();
      const batch = {
        id: `${id}-${Date.now().toString(36)}`.slice(0, 40),
        beanId: id,
        roastDate: b.roastDate || '',
        bestBefore: b.bestBefore || '',
        openedDate: b.openedDate || today(),
        bagSizeG: b.bagSizeG || 250,
        createdAt: now,
      };
      state.batch = batch;
      if (existing) {
        delete b.bestBefore;
        state.bean = { ...existing, ...b, id, salami: existing.salami, profileId: existing.profileId, mode: existing.mode, createdAt: existing.createdAt };
        done();
        return show('new-batch');
      }
      const { openedDate, roastDate, bagSizeG, bestBefore, ...beanOnly } = b;
      state.bean = { ...beanOnly, id, mode: 'new', useBy: useBy(batch), createdAt: now, updatedAt: now };
      await gm.putRecord('beans', id, state.bean);
      state.thumbJob = { id, promise: ensureThumb(state.bean).catch(() => null) };
      await gm.putRecord('batches', batch.id, batch);
      done();
      show('salami-offer');
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  async function openDetails(id, focusBag = false) {
    const bean = await gm.getRecord('beans', id);
    if (!bean) throw new Error('That coffee no longer exists.');
    const batch = latestBatch(await gm.getAll('batches').catch(() => []), id) || null;
    show('edit', { bean: { ...emptyBean(), ...bean }, batch, relooked: false, photos: [], bagNote: '' });
    if (focusBag) root.querySelector('#bag-block')?.scrollIntoView({ block: 'start' });
  }

  function readBagFields() {
    const v = k => root.querySelector(`[data-bag="${k}"]`)?.value || '';
    return { roastDate: v('roastDate'), bestBefore: v('bestBefore'), openedDate: v('openedDate'), bagSizeG: Number(v('bagSizeG')) || 0, leftNow: v('leftNow') };
  }

  function bagBlock() {
    const bt = state.batch || {};
    const ub = useBy(bt);
    const expired = isExpired({ useBy: ub });
    return `<div class="bag-card${expired ? ' expired' : ''}" id="bag-block"><div class="row spread"><strong>Current bag</strong>${expired ? '<span class="pill alarm">Past use-by</span>' : ''}</div>
      ${expired ? '<p class="small">Bought a new bag? Add photos of it (both sides) and tap <em>Read dates</em>, then <em>Save as new bag</em>.</p>' : ''}
      <div class="grid2"><label class="field"><span>Roast date</span><input type="date" data-bag="roastDate" value="${esc(bt.roastDate || '')}"/></label>
      <label class="field"><span>Use by / best before</span><input type="date" data-bag="bestBefore" value="${esc(bt.bestBefore || '')}"/></label></div>
      <div class="grid2"><label class="field"><span>Opened on</span><input type="date" data-bag="openedDate" value="${esc(bt.openedDate || '')}"/></label>
      <label class="field"><span>Bag size (g)</span><input type="number" inputmode="numeric" step="1" data-bag="bagSizeG" value="${esc(bt.bagSizeG ?? 250)}"/></label></div>
      ${stockBlock()}
      <p class="small muted">${ub ? `Use by ${esc(ub)}${bt.bestBefore ? ' (printed on the bag)' : ` (${settings().freshDays ?? 60} days after roasting)`}.` : 'No use-by date: add the roast or use-by date to get a warning when it gets old.'}</p>
      ${state.bagNote ? `<p class="small warn-text">${esc(state.bagNote)}</p>` : ''}
      ${photoPicker('Photos of the bag')}
      <div class="row gap"><button class="small-btn" data-act="bag-scan" ${aiSettings.apiKey ? '' : 'disabled title="Add your API key in Settings"'}>Read dates from photos</button>
      <button class="small-btn" data-act="bag-new">Save as new bag</button></div></div>`;
  }

  // Stock estimate plus a way to correct it by weighing what's left.
  function stockBlock() {
    const st = stockFor(state.bean, state.batch);
    if (!st) return '';
    const line = st.empty ? 'Bag looks empty.' : `≈ ${st.leftG} g left, about ${st.shotsLeft} shot${st.shotsLeft === 1 ? '' : 's'} at ${st.dose} g.`;
    return `<div class="stock-box${st.low ? ' low' : ''}">
      <div class="small"><strong>Coffee left</strong> ${st.low ? '<span class="pill alarm">Running low</span>' : ''}</div>
      ${st.percent == null ? '' : `<span class="bar"><span style="width:${st.percent}%"></span></span>`}
      <div class="small ${st.low ? 'warn-text' : 'muted'}">${esc(line)} Counted ${st.shots} shot${st.shots === 1 ? '' : 's'} from this bag.</div>
      <label class="field"><span>Weighed it? Coffee left now (g)</span><input type="number" inputmode="decimal" step="1" data-bag="leftNow" placeholder="leave empty to keep the estimate"/></label>
    </div>`;
  }

  async function scanBag(btn) {
    const photos = (state.photos || []).map(p => p.base64);
    if (!photos.length) return toast('Add a photo of the bag first.', 'error');
    const keep = readForm();
    const done = busy(btn, 'Reading…');
    try {
      const found = await readBag({ photos });
      done();
      render();
      restoreForm(keep);
      const set = (k, v) => {
        const el = root.querySelector(`[data-bag="${k}"]`);
        if (el && v) el.value = v;
      };
      set('roastDate', found.roastDate);
      set('bestBefore', found.bestBefore);
      const got = [found.roastDate && `roasted ${found.roastDate}`, found.bestBefore && `use by ${found.bestBefore}`].filter(Boolean).join(', ');
      toast(got ? `Read: ${got}. Check, then save.` : 'No dates found on the photos.', got ? 'ok' : 'error');
      if (found.note) {
        state.bagNote = found.note;
        const p = document.createElement('p');
        p.className = 'small warn-text';
        p.textContent = found.note;
        root.querySelector('#bag-block .row.gap')?.before(p);
      }
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  // Bag dates changed in Details: update the latest bag (or create the first one).
  async function saveBagEdits(bean) {
    const f = readBagFields();
    const bt = state.batch;
    const { leftNow, ...fields } = f;
    const weighed = leftNow !== '' && Number.isFinite(Number(leftNow));
    const changed = bt
      ? weighed || ['roastDate', 'bestBefore', 'openedDate'].some(k => (bt[k] || '') !== fields[k]) || (Number(bt.bagSizeG) || 0) !== fields.bagSizeG
      : fields.roastDate || fields.bestBefore || weighed;
    if (!changed) return bean;
    const base = bt
      ? { ...bt, ...fields }
      : { id: `${bean.id}-${Date.now().toString(36)}`.slice(0, 40), beanId: bean.id, createdAt: new Date().toISOString(), ...fields, openedDate: fields.openedDate || today() };
    const batch = { ...base, bagSizeG: fields.bagSizeG || base.bagSizeG || 250 };
    if (weighed) batch.calib = { leftG: Number(leftNow), atShots: Number(batch.countedShots) || 0 };
    await gm.putRecord('batches', batch.id, batch);
    state.batch = batch;
    const reset = bt && (bt.bestBefore || '') !== f.bestBefore;
    return { ...bean, useBy: useBy(batch), useByIgnored: reset ? false : bean.useByIgnored };
  }

  async function saveNewBag(btn) {
    const f = readBagFields();
    if (!f.roastDate && !f.bestBefore) return toast('Add the roast or use-by date of the new bag (or read them from photos).', 'error');
    const done = busy(btn, 'Saving…');
    try {
      const bean = await gm.getRecord('beans', state.bean.id);
      const now = new Date().toISOString();
      const entries = await gm.recentShots(50).catch(() => null);
      const lastShotId = entries ? entries.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) : 0;
      const batch = { id: `${bean.id}-${Date.now().toString(36)}`.slice(0, 40), beanId: bean.id, roastDate: f.roastDate, bestBefore: f.bestBefore, openedDate: f.openedDate && f.openedDate !== state.batch?.openedDate ? f.openedDate : today(), bagSizeG: f.bagSizeG || state.batch?.bagSizeG || 250, createdAt: now, countedShots: 0, lastShotId };
      await gm.putRecord('batches', batch.id, batch);
      const updated = { ...bean, useBy: useBy(batch), useByIgnored: false, mode: bean.profileId && bean.mode === 'dialed' ? 'dialing' : bean.mode, updatedAt: now };
      if (updated.dial) updated.dial = { ...updated.dial, goodStreak: 0 };
      await gm.putRecord('beans', bean.id, updated);
      done();
      toast(`New bag of ${bean.name} saved${bean.profileId ? '. Rating prompts are on again for the first shots' : ''}.`, 'ok');
      show('list', { photos: [] });
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  async function saveEdit(btn) {
    const b = readReview();
    if (!b.name) return toast('Give the coffee a name.', 'error');
    const done = busy(btn, 'Saving…');
    try {
      const current = (await gm.getRecord('beans', b.id)) || {};
      // Keep everything the dial-in loop owns; only the descriptive fields change.
      const merged = { ...current, ...b, id: current.id || b.id, profileId: current.profileId, mode: current.mode, dial: current.dial, shots: current.shots, salami: current.salami, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
      delete merged.roastLevelGuessed;
      Object.assign(merged, await saveBagEdits(merged));
      if (!merged.thumb) Object.assign(merged, await thumbFields(merged));
      await gm.putRecord('beans', merged.id, merged);
      let note = '';
      if (merged.profileId) {
        try {
          await uploadProfileThumb(merged.profileId, merged.thumb);
        } catch (err) {
          note = ` The profile picture couldn't be set: ${err.message}`;
        }
      }
      done();
      toast(`Coffee updated.${note}`, note ? 'error' : 'ok');
      show('list', { relooked: false });
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  // Research the coffee again and fold the result into the form (not saved yet).
  async function lookUpAgain(btn) {
    const b = readReview();
    const done = busy(btn, 'Looking it up… (up to a minute)');
    try {
      const found = await researchBean({ name: [b.roaster, b.name].filter(Boolean).join(' ') });
      const merged = mergeResearch(b, found);
      if (found.logoUrl && b.thumbSource !== 'logo') Object.assign(merged, await thumbFields(merged));
      done();
      show('edit', { bean: merged, relooked: true });
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  async function deleteBean(btn) {
    const b = state.bean;
    const done = busy(btn, 'Deleting…');
    try {
      const batches = (await gm.getAll('batches')).filter(x => x.beanId === b.id);
      for (const x of batches) await gm.deleteRecord('batches', x.id);
      await gm.deleteRecord('beans', b.id);
      const st = await gm.getState().catch(() => null);
      if (st?.beanId === b.id && st.pendingShotId >= 0) await gm.clearFeedback(st.pendingShotId).catch(() => {});
      done();
      toast(`${b.name} deleted.`, 'ok');
      show('list');
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  async function thumbFields(b) {
    const t = await makeThumb(b);
    return { thumb: toDataUrl(t.canvas), thumbSource: t.source, error: t.error };
  }

  // Make and store a new coffee's thumbnail (runs in the background).
  async function ensureThumb(bean) {
    if (bean.thumb) return bean;
    const t = await thumbFields(bean);
    delete t.error;
    const current = (await gm.getRecord('beans', bean.id)) || bean;
    const updated = { ...current, ...t };
    await gm.putRecord('beans', bean.id, updated);
    if (state.bean?.id === bean.id) Object.assign(state.bean, t);
    return updated;
  }

  // Give a new profile the coffee's thumbnail. Never blocks or fails the flow.
  async function applyThumb(profileId) {
    try {
      const job = state.thumbJob?.id === state.bean.id ? state.thumbJob.promise : ensureThumb(state.bean);
      const bean = await job;
      await uploadProfileThumb(profileId, bean?.thumb || state.bean.thumb);
    } catch (err) {
      console.warn('profile thumbnail', err);
    }
  }

  async function confirmBatch() {
    const bean = { ...state.bean, mode: state.bean.profileId ? 'dialing' : state.bean.mode, useBy: useBy(state.batch), useByIgnored: false, updatedAt: new Date().toISOString() };
    const { openedDate, roastDate, bagSizeG, bestBefore, ...beanOnly } = bean;
    await gm.putRecord('beans', bean.id, beanOnly);
    await gm.putRecord('batches', state.batch.id, state.batch);
    if (bean.profileId) {
      try {
        await gm.request('req:profiles:select', { id: bean.profileId });
      } catch {
        /* profile may have been deleted on the machine */
      }
      toast(`New bag saved. ${bean.name}'s profile is active; start dialing in.`, 'ok');
      return show('list');
    }
    state.bean = beanOnly;
    show('salami-offer');
  }

  async function loadSalami(btn) {
    unlockAudio();
    const done = busy(btn, 'Loading…');
    try {
      const profile = salamiProfile(state.bean, state.plan);
      const res = await gm.saveProfile(profile, true, { salami: true });
      if (!res.ok) throw new Error(res.errors?.join(' ') || 'The machine refused the salami profile.');
      state.run = { profileId: res.id, cup: 0, active: false, started: false, saved: false };
      applyThumb(res.id);
      done();
      show('salami-run');
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  function makeRecommendation() {
    const fb = state.feedback;
    const cups = fb.cups.map(c => ({ ...c, weight: Number(c.weight) || 0 }));
    if (!cups.some(c => c.sour || c.sweet || c.bitter) && !fb.blendBest) {
      return toast('Tap at least one taste for the cups first.', 'error');
    }
    state.rec = recommend({
      bean: state.bean,
      plan: state.plan,
      cups,
      blendBest: fb.blendBest,
      shotSeconds: fb.seconds,
      limits: settings().limits || {},
    });
    show('recommendation', { rebuild: false });
  }

  // Starting recipe without a salami shot: the roaster's own espresso recipe when
  // the research found one, otherwise the usual start for that roast level.
  function standardStart(force = null) {
    state.rec = recipeStart(state.bean, force);
    show('recommendation', { rebuild: false });
  }

  function recipeStart(bean, force = null) {
    const d = roastDefaults(bean.roastLevel);
    const recipe = roasterRecipe(bean);
    const lim = settings().limits || {};
    const useRoaster = recipe && force !== 'mine';
    const dose = useRoaster && recipe.dose >= 7 && recipe.dose <= 25 ? recipe.dose : settings().dose ?? 18;
    const ceiling = Math.max(d.maxRatio, useRoaster ? recipe.ratio : 0);
    const ratio = Math.min(ceiling, Math.max(1.5, Math.round((useRoaster ? recipe.ratio : d.ratio) * 20) / 20));
    // Keep the roaster's own yield when the dose matches theirs; otherwise scale it.
    const wanted = useRoaster && recipe.yieldG && dose === recipe.dose ? recipe.yieldG : Math.round(dose * ratio * 2) / 2;
    const yieldG = Math.min(wanted, lim.maxYield ?? 60);
    state.plan = { dose, temperature: d.temp, cups: [], expectedFlow: d.flow };
    const reasons = useRoaster
      ? [
          `${recipe.source}: ${recipe.dose ? `${recipe.dose} g in, ` : ''}${recipe.yieldG ? `${recipe.yieldG} g out` : `1:${fmtRatio(recipe.ratio)}`}${recipe.timeS ? ` in ${recipe.timeS} s` : ''}.`,
          yieldG < wanted ? `Yield capped at your ${yieldG} g safety limit.` : 'Starting from their recipe; the shot feedback adjusts it from here.',
        ]
      : [`Standard start for a ${bean.roastLevel} roast${recipe ? `, not the roaster's recipe` : ''}.`];
    return {
      ratio,
      yieldG,
      temperature: Math.min(lim.maxTemperature ?? 96, Math.max(lim.minTemperature ?? 85, (useRoaster && recipe.tempC) || d.temp)),
      preinfusion: 8,
      grindAdvice: 'keep',
      targetSeconds: useRoaster ? recipe.timeS || null : null,
      source: useRoaster ? recipe.source : `standard ${bean.roastLevel} start`,
      reasons,
    };
  }

  // Offer the roaster's recipe when what we propose differs from it.
  function recipeSwitch(bean, rec, plan) {
    const recipe = roasterRecipe(bean);
    if (!recipe) return '';
    const same = Math.abs(recipe.ratio - rec.ratio) < 0.05 && (!recipe.dose || recipe.dose === plan.dose);
    if (same) return `<p class="small muted">This is ${esc(recipe.source)}'s recipe.</p>`;
    return `<div class="row gap small"><span class="muted">${esc(recipe.source)}: ${recipe.dose ? `${recipe.dose} g in, ` : ''}${recipe.yieldG ? `${recipe.yieldG} g out` : `1:${fmtRatio(recipe.ratio)}`}${recipe.timeS ? ` in ${recipe.timeS} s` : ''}</span>
      <button class="small-btn" data-act="use-roaster">Use their recipe</button></div>`;
  }

  async function saveStartingProfile(btn) {
    const done = busy(btn, 'Saving…');
    const box = root.querySelector('#rec-errors');
    try {
      const rebuilding = !!state.rebuild && !!state.bean.profileId;
      const profile = startingProfile(state.bean, state.rec, state.plan.dose);
      if (rebuilding) profile.id = state.bean.profileId;
      const g = settings().grinder;
      let grind = startingGrind(state.bean, g);
      const gstep = g?.step || 0.25;
      if (grind != null && state.rec.grindAdvice !== 'keep') {
        const finer = g?.finerIsLower === false ? 1 : -1;
        grind += (state.rec.grindAdvice === 'finer' ? finer : -finer) * gstep;
      }
      if (grind != null) profile.label = `${state.bean.name} · grind ${fmtGrind(grind, gstep)}`.slice(0, 40);
      const res = await gm.saveProfile(profile, true, { rebuild: rebuilding });
      if (!res.ok) {
        box.innerHTML = `<ul class="errors">${(res.errors || []).map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
        throw new Error('The machine refused this profile.');
      }
      const bean = {
        ...state.bean,
        profileId: res.id,
        mode: 'dialing', // a new recipe is worth rating again, even when it was dialed in
        recipe: state.bean.recipe,
        start: { dose: state.plan.dose, targetSeconds: state.rec.targetSeconds ?? roasterRecipe(state.bean)?.timeS ?? null, ...state.rec },
        salami: state.feedback ? { plan: state.plan, cups: state.feedback.cups, blendBest: state.feedback.blendBest, shotId: state.feedback.shotId } : null,
        // A rebuild keeps the grind you had arrived at; a brand-new profile starts fresh.
        dial: rebuilding
          ? { ...(state.bean.dial || {}), grind: state.bean.dial?.grind ?? grind, step: 2 * gstep, lastDir: 0, goodStreak: 0 }
          : { grind, step: 2 * gstep, lastDir: 0, goodStreak: 0 },
        updatedAt: new Date().toISOString(),
      };
      await gm.putRecord('beans', bean.id, bean);
      state.bean = bean;
      applyThumb(res.id);
      if (state.feedback?.shotId != null) gm.clearFeedback(state.feedback.shotId).catch(() => {});
      if (state.run?.profileId) {
        gm.request('req:profiles:delete', { id: state.run.profileId }).catch(() => {});
      }
      done();
      show('done', { rebuild: false });
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  root.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const i = btn.dataset.i !== undefined ? Number(btn.dataset.i) : null;
    try {
      if (act === 'list') {
        if (state.feedback?.shotId != null && ['salami-feedback', 'recommendation'].includes(state.view)) {
          gm.clearFeedback(state.feedback.shotId).catch(() => {});
        }
        state.run = null;
        show('list');
      }
      else if (act === 'add') show('add', { photos: [] });
      else if (act === 'photo-remove') {
        const keep = readForm();
        state.photos.splice(i, 1);
        render();
        restoreForm(keep);
      } else if (act === 'keep-bag') {
        const bean = await gm.getRecord('beans', btn.dataset.id);
        await gm.putRecord('beans', bean.id, { ...bean, useByIgnored: true, updatedAt: new Date().toISOString() });
        toast("OK, no more use-by warnings for this bag.", 'ok');
        render();
      } else if (act === 'bag-scan') await scanBag(btn);
      else if (act === 'bag-new') await saveNewBag(btn);
      else if (act === 'manual') show('review', { bean: emptyBean(root.querySelector('#bean-name')?.value) });
      else if (act === 'research') {
        const name = root.querySelector('#bean-name').value.trim();
        const photos = (state.photos || []).map(p => p.base64);
        if (!name && !photos.length) return toast('Type a name or add a photo.', 'error');
        const done = busy(btn, 'Looking it up… (up to a minute)');
        try {
          const bean = await researchBean({ name, photos });
          state.photos = [];
          done();
          show('review', { bean });
        } catch (err) {
          done();
          toast(err.message, 'error');
        }
      } else if (act === 'save-bean') await saveBean(btn);
      else if (act === 'store-only') {
        await gm.putRecord('beans', state.bean.id, { ...state.bean, mode: 'stored', updatedAt: new Date().toISOString() });
        toast(`${state.bean.name} saved. No espresso profile was made.`, 'ok');
        show('list');
      }
      else if (act === 'details') await openDetails(btn.dataset.id, !!btn.dataset.bag);
      else if (act === 'thumb-name' || act === 'thumb-logo') {
        const b = readReview();
        const done = busy(btn, act === 'thumb-logo' ? 'Fetching…' : 'Drawing…');
        const t = act === 'thumb-logo' ? await thumbFields(b) : { thumb: toDataUrl(nameTile(b.roaster || b.name)), thumbSource: 'name' };
        done();
        if (act === 'thumb-logo' && t.thumbSource !== 'logo') toast(`No logo could be fetched${t.error ? `: ${t.error}` : ''}. Using a name tile.`, 'error');
        delete t.error;
        show('edit', { bean: { ...b, ...t } });
      }
      else if (act === 'save-edit') await saveEdit(btn);
      else if (act === 'relookup') await lookUpAgain(btn);
      else if (act === 'delete-bean') show('delete', { bean: { ...state.bean, ...readReview() } });
      else if (act === 'delete-confirm') await deleteBean(btn);
      else if (act === 'batch-yes') await confirmBatch();
      else if (act === 'batch-no') {
        state.bean = { ...state.bean, name: `${state.bean.name} (2)` };
        show('review');
      } else if (act === 'resume') {
        state.bean = await gm.getRecord('beans', btn.dataset.id);
        show('salami-offer');
      } else if (act === 'set-mode') {
        const bean = await gm.getRecord('beans', btn.dataset.id);
        const mode = btn.dataset.mode;
        await gm.putRecord('beans', bean.id, { ...bean, mode, dial: { ...(bean.dial || {}), goodStreak: 0 }, updatedAt: new Date().toISOString() });
        if (mode === 'dialed') gm.clearFeedback(-1).catch(() => {});
        toast(mode === 'dialed' ? 'Prompts off for this coffee.' : 'Rating prompts are back on for this coffee.', 'ok');
        render();
      } else if (act === 'salami-setup') show('salami-setup', { plan: null });
      else if (act === 'skip-salami') standardStart();
      else if (act === 'rebuild') {
        const fresh = (await gm.getRecord('beans', state.bean.id)) || state.bean;
        state.bean = { ...emptyBean(), ...fresh };
        standardStart(roasterRecipe(state.bean) ? 'roaster' : null);
        state.rebuild = true;
        render();
      } else if (act === 'use-roaster') standardStart('roaster');
      else if (act === 'use-mine') standardStart('mine');
      else if (act === 'load-salami') await loadSalami(btn);
      else if (act === 'toggle') {
        state.feedback.cups[i][btn.dataset.t] = !state.feedback.cups[i][btn.dataset.t];
        btn.classList.toggle('on');
      } else if (act === 'intensity') {
        state.feedback.cups[i].intensity = Number(btn.dataset.n);
        btn.parentElement.querySelectorAll('.dot').forEach(d => d.classList.toggle('on', d === btn));
      } else if (act === 'body') {
        state.feedback.cups[i].body = btn.dataset.t;
        btn.parentElement.querySelectorAll('.chip').forEach(d => d.classList.toggle('on', d === btn));
      } else if (act === 'read-scale') {
        const w = gm.status?.bw;
        if (!(w > 0)) return toast('No weight from the scale. Is the Bookoo connected to the machine?', 'error');
        state.feedback.cups[i].weight = w.toFixed(1);
        btn.closest('.cupcard').querySelector('[data-f="weight"]').value = w.toFixed(1);
      } else if (act === 'recommend') makeRecommendation();
      else if (act === 'save-profile') await saveStartingProfile(btn);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  gm.addEventListener('status', e => onStatus(e.detail));
  gm.addEventListener('evt:history-shot-saved', onShotSaved);

  return {
    render,
    show,
    refreshList: () => state.view === 'list' && render(),
    // The salami flow handles its own tasting; the per-shot prompt waits meanwhile.
    isBusy: () => ['salami-run', 'salami-feedback', 'recommendation'].includes(state.view),
  };
}

function emptyBean(name = '') {
  return {
    roaster: '',
    name,
    origin: { country: '', region: '', farm: '' },
    process: '',
    variety: '',
    blend: false,
    roastLevel: 'medium',
    roastLevelGuessed: false,
    tastingNotes: [],
    roastDate: '',
    bagSizeG: 250,
    recipe: null,
    community: [],
    roastedFor: '',
    brewMethods: {},
    brewNote: '',
    logoUrl: '',
    confidence: '',
    sources: [],
  };
}

// Brew methods the research found, e.g. "Espresso, Milk drinks".
function bestFor(b) {
  return BREW_METHODS.filter(([k]) => b.brewMethods?.[k] === 'recommended')
    .map(([, l]) => l)
    .join(', ');
}

function brewHtml(b) {
  const rated = BREW_METHODS.filter(([k]) => b.brewMethods?.[k]);
  if (!rated.length && !b.brewNote && !b.roastedFor) return '';
  const cls = { recommended: 'ok', suitable: '', 'not recommended': 'warn' };
  const chips = rated
    .map(([k, l]) => `<span class="pill ${cls[b.brewMethods[k]]}" title="${esc(b.brewMethods[k])}">${b.brewMethods[k] === 'not recommended' ? '✕ ' : b.brewMethods[k] === 'recommended' ? '★ ' : ''}${esc(l)}</span>`)
    .join(' ');
  const filterWarn =
    b.roastedFor === 'filter' || b.brewMethods?.espresso === 'not recommended'
      ? '<p class="small warn-text">This looks like a filter roast. As espresso it tends to taste sour: expect a finer grind, a hotter and longer shot, and more dial-in shots.</p>'
      : '';
  return `<p class="small"><strong>Brew methods</strong> <span class="muted">★ recommended · ✕ not recommended</span></p>
    <div class="brew-chips">${chips}</div>${b.brewNote ? `<p class="small muted">${esc(b.brewNote)}</p>` : ''}${filterWarn}`;
}

// Fold a fresh lookup into an existing coffee: new brew-method, recipe, community and
// source info replace the old; descriptive fields the user already has are kept.
export function mergeResearch(bean, found) {
  const keepOr = (a, b) => (a && (!Array.isArray(a) || a.length) ? a : b);
  return {
    ...bean,
    origin: {
      country: keepOr(bean.origin?.country, found.origin.country),
      region: keepOr(bean.origin?.region, found.origin.region),
      farm: keepOr(bean.origin?.farm, found.origin.farm),
    },
    process: keepOr(bean.process, found.process),
    variety: keepOr(bean.variety, found.variety),
    tastingNotes: keepOr(bean.tastingNotes, found.tastingNotes),
    roastedFor: found.roastedFor || bean.roastedFor || '',
    brewMethods: found.brewMethods,
    brewNote: found.brewNote || bean.brewNote || '',
    logoUrl: found.logoUrl || bean.logoUrl || '',
    recipe: found.recipe || bean.recipe || null,
    community: found.community.length ? found.community : bean.community || [],
    sources: found.sources.length ? found.sources : bean.sources || [],
    confidence: found.confidence,
  };
}

// The roaster or sources advise against espresso, or it is a filter roast.
export function notForEspresso(b) {
  return b?.brewMethods?.espresso === 'not recommended' || b?.roastedFor === 'filter';
}

const tileCache = new Map();
export function thumbSrc(b) {
  if (b.thumb) return b.thumb;
  const key = b.roaster || b.name || '?';
  if (!tileCache.has(key)) tileCache.set(key, nameTile(key, 96).toDataURL('image/png'));
  return tileCache.get(key);
}

function thumbBlock(b) {
  const label = { logo: "Roaster's logo", name: 'Name tile' }[b.thumbSource] || 'Not set yet (made when you save)';
  return `<div class="thumb-edit"><img class="thumb big" alt="" src="${esc(thumbSrc(b))}"/>
    <div><div class="small"><strong>Picture</strong> <span class="muted">${label}</span></div>
    <div class="small muted">Shown here and on the machine's profile.</div>
    <div class="row gap small"><button class="small-btn" data-act="thumb-logo" ${b.logoUrl ? '' : 'disabled title="Look the coffee up again to find a logo"'}>Use logo</button>
    <button class="small-btn" data-act="thumb-name">Use name tile</button></div></div></div>`;
}
