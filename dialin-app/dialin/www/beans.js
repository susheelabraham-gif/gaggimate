// Beans tab: add a coffee (photo or name → AI research → review), new-batch
// detection, salami diagnostic (plan → run with cup cues → tasting → recipe),
// and saving the starting profile to the machine.
import { researchBean, photoToBase64, aiSettings } from './lib/ai.js';
import {
  ROAST_LEVELS,
  planSalami,
  salamiProfile,
  recommend,
  startingProfile,
  startingGrind,
  roastDefaults,
  slug,
} from './lib/dialin.js';

const today = () => new Date().toISOString().slice(0, 10);
const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function initBeans({ gm, root, toast, getSettings }) {
  const state = { view: 'list', bean: null, batch: null, plan: null, run: null, feedback: null, rec: null };

  // ------------------------------------------------------------ helpers
  const settings = () => getSettings();
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
      list.innerHTML = beans
        .map(b => {
          const latest = batches.filter(x => x.beanId === b.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
          const mode = { dialing: 'Dialing in', dialed: 'Dialed in', recalibrate: 'Recalibrate', new: 'New' }[b.mode] || 'New';
          return `<li><div class="row"><strong>${esc(b.name)}</strong><span class="pill">${mode}</span></div>
            <div class="muted small">${esc([b.roaster, b.origin?.country, b.process, b.roastLevel].filter(Boolean).join(' · '))}</div>
            ${latest ? `<div class="muted small">Bag roasted ${esc(latest.roastDate || 'date unknown')}, opened ${esc(latest.openedDate || '—')}</div>` : ''}
            ${!b.profileId ? `<button class="link" data-act="resume" data-id="${esc(b.id)}">Set up a starting profile ›</button>` : ''}</li>`;
        })
        .join('');
    } catch (err) {
      root.querySelector('#bean-list').innerHTML = `<li class="error">${esc(err.message)}</li>`;
    }
  }

  function renderAdd() {
    const hasKey = !!aiSettings.apiKey;
    root.innerHTML = `<div class="card"><h2>Add a coffee</h2>
      <p class="muted">Take a photo of the bag, type its name, or both. The assistant looks it up online.</p>
      ${hasKey ? '' : '<p class="error small">Add your Anthropic API key in Settings to look coffees up. You can still fill in the details by hand.</p>'}
      <label class="field"><span>Coffee name</span><input id="bean-name" placeholder="e.g. Square Mile Red Brick" autocomplete="off"/></label>
      <label class="field"><span>Photo of the bag</span><input id="bean-photo" type="file" accept="image/*" capture="environment"/></label>
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
    const sources = b.sources?.length
      ? `<p class="small muted">Sources: ${b.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join(' · ')}</p>`
      : '';
    root.innerHTML = `<div class="card"><div class="row spread"><h2>Check the details</h2>
      ${b.confidence ? `<span class="pill ${b.confidence === 'high' ? 'ok' : b.confidence === 'low' ? 'warn' : ''}">${b.confidence} confidence</span>` : ''}</div>
      <p class="muted small">Correct anything that's wrong. Roast level matters most: it sets the salami plan.</p>
      ${beanField('Coffee name', 'name', b.name, 'required')}
      ${beanField('Roaster', 'roaster', b.roaster)}
      <div class="grid2">${beanField('Country', 'origin.country', b.origin.country)}${beanField('Region', 'origin.region', b.origin.region)}</div>
      <div class="grid2">${beanField('Process', 'process', b.process)}${beanField('Variety', 'variety', b.variety)}</div>
      <label class="field"><span>Roast level${b.roastLevelGuessed ? ' <span class="warn-text">(not found, please check)</span>' : ''}</span>
        <select data-k="roastLevel">${ROAST_LEVELS.map(l => `<option ${l === b.roastLevel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${beanField('Tasting notes', 'tastingNotes', b.tastingNotes.join(', '))}
      <div class="grid2">${beanField('Roast date', 'roastDate', b.roastDate, 'type="date"')}${beanField('Opened on', 'openedDate', b.openedDate || today(), 'type="date"')}</div>
      ${beanField('Bag size (g)', 'bagSizeG', b.bagSizeG ?? 250, 'type="number" inputmode="numeric"')}
      ${recipe}${community}${sources}
      <div class="row gap"><button class="primary" data-act="save-bean">Save coffee</button><button class="link" data-act="list">Cancel</button></div></div>`;
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
    root.innerHTML = `<div class="card"><h2>Start with a salami shot?</h2>
      <p>One shot split into ${d.cups} cups shows where ${esc(b.name)} turns from sour to sweet to bitter. Your tasting then sets the starting recipe.</p>
      <p class="muted small">It uses a full dose and takes about 10 minutes including tasting. You sip the cups rather than drink a normal shot.</p>
      <div class="row gap"><button class="primary" data-act="salami-setup">Plan the salami shot</button>
      <button data-act="skip-salami">Skip, use a standard start</button></div></div>`;
  }

  function renderSalamiSetup() {
    const b = state.bean;
    const dose = state.plan?.dose ?? settings().dose ?? 18;
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
    root.innerHTML = `<div class="card"><h2>Starting recipe for ${esc(bean.name)}</h2>
      <div class="stats">
        <div class="stat"><span class="label">Dose</span><strong>${plan.dose} g</strong></div>
        <div class="stat"><span class="label">Yield</span><strong>${rec.yieldG} g</strong></div>
        <div class="stat"><span class="label">Ratio</span><strong>1:${rec.ratio.toFixed(1)}</strong></div>
        <div class="stat"><span class="label">Temperature</span><strong>${rec.temperature} °C</strong></div>
      </div>
      <p><strong>${grindLine}</strong></p>
      <ul class="small">${rec.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      <div id="rec-errors"></div>
      <div class="row gap"><button class="primary" data-act="save-profile">Save profile and make it active</button><button class="link" data-act="list">Not now</button></div></div>`;
  }

  function renderDone() {
    const { bean, rec, plan } = state;
    root.innerHTML = `<div class="card"><h2>Ready for your first shot</h2>
      <p>The profile <strong>${esc(bean.name)}</strong> is active on the machine: ${plan.dose} g in, ${rec.yieldG} g out at ${rec.temperature} °C.</p>
      <p class="muted">The coffee is now in <em>Dialing in</em> mode. After each shot, rate it and the next step will be suggested.</p>
      <button class="primary" data-act="list">Done</button></div>`;
  }

  function render() {
    const views = {
      list: renderList,
      add: renderAdd,
      review: renderReview,
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
        openedDate: b.openedDate || today(),
        bagSizeG: b.bagSizeG || 250,
        createdAt: now,
      };
      state.batch = batch;
      if (existing) {
        state.bean = { ...existing, ...b, id, salami: existing.salami, profileId: existing.profileId, mode: existing.mode, createdAt: existing.createdAt };
        done();
        return show('new-batch');
      }
      const { openedDate, roastDate, bagSizeG, ...beanOnly } = b;
      state.bean = { ...beanOnly, id, mode: 'new', createdAt: now, updatedAt: now };
      await gm.putRecord('beans', id, state.bean);
      await gm.putRecord('batches', batch.id, batch);
      done();
      show('salami-offer');
    } catch (err) {
      done();
      toast(err.message, 'error');
    }
  }

  async function confirmBatch() {
    const bean = { ...state.bean, mode: state.bean.profileId ? 'dialing' : state.bean.mode, updatedAt: new Date().toISOString() };
    const { openedDate, roastDate, bagSizeG, ...beanOnly } = bean;
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
    show('recommendation');
  }

  function standardStart() {
    const d = roastDefaults(state.bean.roastLevel);
    const dose = settings().dose ?? 18;
    state.plan = { dose, temperature: d.temp, cups: [], expectedFlow: d.flow };
    const ratio = state.bean.recipe?.ratio || (state.bean.recipe?.yield && state.bean.recipe?.dose ? state.bean.recipe.yield / state.bean.recipe.dose : d.ratio);
    const r = Math.min(3, Math.max(1.5, Math.round(ratio * 20) / 20));
    state.rec = {
      ratio: r,
      yieldG: Math.round(dose * r * 2) / 2,
      temperature: Math.min(96, Math.max(85, state.bean.recipe?.tempC || d.temp)),
      preinfusion: 8,
      grindAdvice: 'keep',
      reasons: [`Standard start for a ${state.bean.roastLevel} roast${state.bean.recipe?.source ? `, using the recipe from ${state.bean.recipe.source}` : ''}.`],
    };
    show('recommendation');
  }

  async function saveStartingProfile(btn) {
    const done = busy(btn, 'Saving…');
    const box = root.querySelector('#rec-errors');
    try {
      const profile = startingProfile(state.bean, state.rec, state.plan.dose);
      if (state.bean.profileId) profile.id = undefined; // always a fresh profile from a salami
      const res = await gm.saveProfile(profile, true);
      if (!res.ok) {
        box.innerHTML = `<ul class="errors">${(res.errors || []).map(e => `<li>${esc(e)}</li>`).join('')}</ul>`;
        throw new Error('The machine refused this profile.');
      }
      const bean = {
        ...state.bean,
        profileId: res.id,
        mode: 'dialing',
        recipe: state.bean.recipe,
        start: { dose: state.plan.dose, ...state.rec },
        salami: state.feedback ? { plan: state.plan, cups: state.feedback.cups, blendBest: state.feedback.blendBest, shotId: state.feedback.shotId } : null,
        updatedAt: new Date().toISOString(),
      };
      await gm.putRecord('beans', bean.id, bean);
      state.bean = bean;
      if (state.run?.profileId) {
        gm.request('req:profiles:delete', { id: state.run.profileId }).catch(() => {});
      }
      done();
      show('done');
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
      if (act === 'list') show('list');
      else if (act === 'add') show('add');
      else if (act === 'manual') show('review', { bean: emptyBean(root.querySelector('#bean-name')?.value) });
      else if (act === 'research') {
        const name = root.querySelector('#bean-name').value.trim();
        const file = root.querySelector('#bean-photo').files[0];
        if (!name && !file) return toast('Type a name or add a photo.', 'error');
        const done = busy(btn, 'Looking it up… (up to a minute)');
        try {
          const photoBase64 = file ? await photoToBase64(file) : null;
          const bean = await researchBean({ name, photoBase64 });
          done();
          show('review', { bean });
        } catch (err) {
          done();
          toast(err.message, 'error');
        }
      } else if (act === 'save-bean') await saveBean(btn);
      else if (act === 'batch-yes') await confirmBatch();
      else if (act === 'batch-no') {
        state.bean = { ...state.bean, name: `${state.bean.name} (2)` };
        show('review');
      } else if (act === 'resume') {
        state.bean = await gm.getRecord('beans', btn.dataset.id);
        show('salami-offer');
      } else if (act === 'salami-setup') show('salami-setup', { plan: null });
      else if (act === 'skip-salami') standardStart();
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

  return { render, show, refreshList: () => state.view === 'list' && render() };
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
    confidence: '',
    sources: [],
  };
}
