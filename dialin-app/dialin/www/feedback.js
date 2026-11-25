// Per-shot feedback. The machine marks a shot as "needs feedback" when it was pulled
// with the profile of a coffee being dialed in (or a salami). Until the shot is rated
// or skipped, the machine asks for confirmation before brewing, and this full-screen
// prompt opens whenever the app is opened.
import { nextStep, fmtGrind, startingGrind } from './lib/dialin.js';

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function initFeedback({ gm, toast, getSettings, isBusy, onDone }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  document.body.append(overlay);

  let current = null; // { shotId, bean, profile, shot, notes, form }
  let checking = false;

  async function check() {
    if (checking || !overlay.hidden || isBusy()) return;
    checking = true;
    try {
      const state = await gm.getState();
      if (state.pendingShotId >= 0 && !isBusy()) await open(state.pendingShotId, state.beanId);
    } catch {
      /* machine offline: try again later */
    } finally {
      checking = false;
    }
  }

  async function open(shotId, beanId) {
    current = { shotId, beanId };
    overlay.hidden = false;
    document.body.classList.add('locked');
    overlay.innerHTML = '<div class="sheet"><p class="muted">Loading the shot…</p></div>';
    if (beanId === 'salami') return renderSalami();
    try {
      const [shot, bean] = await Promise.all([gm.loadShot(shotId), gm.getRecord('beans', beanId)]);
      current.shot = shot;
      current.bean = bean;
      current.profile = bean?.profileId ? await gm.loadProfile(bean.profileId).catch(() => null) : null;
      const s = getSettings();
      const grinder = s.grinder;
      const grind = bean?.dial?.grind ?? startingGrind(bean, grinder);
      current.form = {
        taste: '',
        rating: 0,
        grind: grind != null ? fmtGrind(grind, grinder?.step) : '',
        dose: String(bean?.start?.dose ?? s.dose ?? 18),
        notes: '',
      };
      renderForm();
    } catch (err) {
      overlay.innerHTML = `<div class="sheet"><h2>Rate your last shot</h2><p class="error">${esc(err.message)}</p>
        <div class="row gap"><button data-fb="retry">Try again</button><button class="link" data-fb="skip">Skip this shot</button></div></div>`;
    }
  }

  function targetYield() {
    const phases = current.profile?.phases || [];
    for (const ph of phases) for (const t of ph.targets || []) if (t.type === 'volumetric') return t.value;
    return current.bean?.start?.yieldG ?? null;
  }

  function shotFacts() {
    const shot = current.shot;
    const seconds = (shot.duration || 0) / 1000;
    const yieldG = shot.volume ?? null;
    const peak = Math.max(0, ...(shot.samples || []).map(x => x.cp || 0));
    return { seconds, yieldG, peak, targetYield: targetYield() };
  }

  function renderForm() {
    const { bean, form } = current;
    const f = shotFacts();
    const dose = Number(form.dose) || null;
    const ratio = dose && f.yieldG ? `1:${(f.yieldG / dose).toFixed(1)}` : '—';
    const timing = f.seconds < 24 ? 'ran fast' : f.seconds > 36 ? 'ran slow' : 'on time';
    overlay.innerHTML = `<div class="sheet">
      <p class="muted small">Shot #${esc(current.shotId)} · ${esc(bean?.name || '')}</p>
      <h2>How was this shot?</h2>
      <div class="stats">
        <div class="stat"><span class="label">Time</span><strong>${f.seconds.toFixed(0)} s</strong></div>
        <div class="stat"><span class="label">Yield</span><strong>${f.yieldG ? f.yieldG.toFixed(1) : '—'} g</strong>${f.targetYield ? `<span class="muted small"> / ${f.targetYield} g</span>` : ''}</div>
        <div class="stat"><span class="label">Ratio</span><strong>${ratio}</strong></div>
        <div class="stat"><span class="label">Peak</span><strong>${f.peak.toFixed(1)} bar</strong></div>
      </div>
      <p class="small muted">The shot ${timing}.</p>
      <p class="q">Taste</p>
      <div class="choice">${['sour', 'balanced', 'bitter']
        .map(t => `<button class="big-chip ${form.taste === t ? 'on' : ''}" data-fb="taste" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`)
        .join('')}</div>
      <p class="q">Overall</p>
      <div class="choice">${[1, 2, 3, 4, 5]
        .map(n => `<button class="dot big ${form.rating === n ? 'on' : ''}" data-fb="rating" data-v="${n}">${n}</button>`)
        .join('')}</div>
      <div class="grid2">
        <label class="field"><span>Grind used</span><input data-ff="grind" inputmode="decimal" value="${esc(form.grind)}" placeholder="e.g. 14.5"/></label>
        <label class="field"><span>Dose (g)</span><input data-ff="dose" inputmode="decimal" value="${esc(form.dose)}"/></label>
      </div>
      <label class="field"><span>Notes (optional)</span><input data-ff="notes" value="${esc(form.notes)}" placeholder="e.g. thin, a bit astringent"/></label>
      <div class="row gap"><button class="primary" data-fb="save" ${form.taste && form.rating ? '' : 'disabled'}>Save and get next step</button>
      <button class="link" data-fb="skip">Skip this shot</button></div></div>`;
    for (const input of overlay.querySelectorAll('[data-ff]')) {
      input.addEventListener('input', e => (current.form[e.target.dataset.ff] = e.target.value));
    }
  }

  function renderSalami() {
    overlay.innerHTML = `<div class="sheet"><h2>Salami shot not tasted</h2>
      <p>The last shot was a salami shot, but its cups weren't rated in the app. Run the salami again from <em>Coffees</em> when you're ready, or dismiss this.</p>
      <button class="primary" data-fb="skip">Dismiss</button></div>`;
  }

  function renderResult(res, applied) {
    const { bean } = current;
    const g = getSettings().grinder;
    const grindLine =
      res.grindDir === 0
        ? res.nextGrind != null
          ? `Keep the grind at <strong>${fmtGrind(res.nextGrind, g?.step)}</strong>`
          : 'Keep the grind the same'
        : res.nextGrind != null
          ? `Grind at <strong>${fmtGrind(res.nextGrind, g?.step)}</strong> (${res.grindDir < 0 ? 'finer' : 'coarser'} by ${res.grindStep})`
          : `Grind ${res.grindStep} ${res.grindDir < 0 ? 'finer' : 'coarser'}`;
    overlay.innerHTML = `<div class="sheet">
      <h2>${res.dialedIn ? `${esc(bean.name)} is dialed in` : 'Next shot'}</h2>
      ${res.dialedIn ? '<p>Two good shots in a row. The rating prompts stop for this coffee; you can turn them back on with <em>Recalibrate</em> in Coffees.</p>' : ''}
      <p class="next">${grindLine}${res.tempDelta ? `, temperature ${res.tempDelta > 0 ? 'up' : 'down'} 1 °C` : ''}.</p>
      <ul class="small">${res.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      ${applied ? `<p class="muted small">${esc(applied)}</p>` : ''}
      <button class="primary" data-fb="close">OK</button></div>`;
  }

  async function save(btn) {
    const { bean, form } = current;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const s = getSettings();
    const f = shotFacts();
    const grindUsed = form.grind.trim() === '' ? null : Number(form.grind);
    const dose = Number(form.dose) || null;
    try {
      // 1. GaggiMate's own shot notes, so the shot shows its rating in Shot History too.
      await gm.saveNotes(current.shotId, {
        rating: form.rating,
        beanType: bean?.name || '',
        doseIn: dose ? dose.toFixed(1) : '',
        doseOut: f.yieldG ? f.yieldG.toFixed(1) : '',
        ratio: dose && f.yieldG ? (f.yieldG / dose).toFixed(2) : '',
        grindSetting: grindUsed != null ? String(grindUsed) : '',
        balanceTaste: form.taste,
        notes: form.notes,
      }).catch(() => {});

      // 2. Next step.
      const res = nextStep({
        shot: { seconds: f.seconds, yieldG: f.yieldG, targetYield: f.targetYield },
        feedback: { taste: form.taste, rating: form.rating },
        dial: { ...(bean.dial || {}), grind: grindUsed ?? bean.dial?.grind ?? null },
        grinder: s.grinder,
        temperature: current.profile?.temperature ?? 93,
        limits: s.limits || {},
        // Judge "fast" and "slow" against the roaster's time when they gave one.
        targetSeconds: bean.start?.targetSeconds ?? bean.recipe?.timeS ?? null,
      });

      // 3. Profile: new temperature if any, and the grind to use shown in its name on the machine.
      let applied = '';
      if (current.profile) {
        const p = structuredClone(current.profile);
        if (res.tempDelta) p.temperature = Math.round((p.temperature + res.tempDelta) * 2) / 2;
        const g = res.nextGrind ?? bean.dial?.grind;
        p.label = (g != null ? `${bean.name} · grind ${fmtGrind(g, s.grinder?.step)}` : bean.name).slice(0, 40);
        if (p.temperature !== current.profile.temperature || p.label !== current.profile.label) {
          const saved = await gm.saveProfile(p, true);
          applied = saved.ok
            ? `Profile updated on the machine${g != null ? `; its name shows the grind (${fmtGrind(g, s.grinder?.step)})` : ''}.`
            : `The machine refused the profile change: ${(saved.errors || []).join(' ')}`;
        }
      }

      // 4. Coffee record.
      const log = [
        ...(bean.shots || []),
        { id: current.shotId, at: new Date().toISOString(), grind: grindUsed, dose, taste: form.taste, rating: form.rating, seconds: Math.round(f.seconds), yieldG: f.yieldG },
      ].slice(-100);
      const updated = { ...bean, dial: res.dial, shots: log, mode: res.dialedIn ? 'dialed' : bean.mode, updatedAt: new Date().toISOString() };
      await gm.putRecord('beans', bean.id, updated);

      // 5. Clear the machine's "rate your shot" warning.
      await gm.clearFeedback(current.shotId);
      renderResult(res, applied);
      onDone?.();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save and get next step';
      toast(err.message, 'error');
    }
  }

  async function skip() {
    try {
      await gm.clearFeedback(current?.shotId ?? -1);
    } catch (err) {
      return toast(err.message, 'error');
    }
    close();
    toast('Skipped. The next shot will ask again.');
  }

  function close() {
    overlay.hidden = true;
    overlay.innerHTML = '';
    document.body.classList.remove('locked');
    current = null;
  }

  overlay.addEventListener('click', async e => {
    const btn = e.target.closest('[data-fb]');
    if (!btn) return;
    const act = btn.dataset.fb;
    if (act === 'taste') {
      current.form.taste = btn.dataset.v;
      renderForm();
    } else if (act === 'rating') {
      current.form.rating = Number(btn.dataset.v);
      renderForm();
    } else if (act === 'save') await save(btn);
    else if (act === 'skip') await skip();
    else if (act === 'retry') await open(current.shotId, current.beanId);
    else if (act === 'close') close();
  });

  gm.addEventListener('connection', e => e.detail && check());
  gm.addEventListener('evt:history-shot-saved', () => setTimeout(check, 1500));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  return { check };
}
