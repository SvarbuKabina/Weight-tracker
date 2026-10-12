'use strict';

// Gym log: a routine of workouts (Push, Pull, …), each a list of exercise slots with
// optional substitutes; logged sessions of sets (weight × reps); progress per exercise.
// Loaded before app.js and uses its helpers ($, h, s, state, save, toast, …) when called.

const SERIES_MAX = 3; // lines on one progress chart (positions, or a lift and what replaced it)
const BODYWEIGHT_HINT = /pull[- ]?ups?|chin[- ]?ups?|\bdips?\b|push[- ]?ups?|muscle[- ]?ups?|pistol|plank|inverted row|bodyweight/i;

function defaultGym() {
  return {
    exercises: {}, // id → { id, name, bodyweight }
    workouts: [], // { id, name, slots: [{ id, main: exerciseId, subs: [exerciseId] }] }
    sessions: [], // { id, date, workoutId, name, note, entries: [{ id, slotId, exerciseId, sets: [{ kg, reps }] }] }, sorted by date
  };
}

function normalizeGym(g) {
  if (!g || typeof g !== 'object') return defaultGym();
  return {
    exercises: g.exercises && typeof g.exercises === 'object' ? g.exercises : {},
    workouts: (Array.isArray(g.workouts) ? g.workouts : []).filter(w => w && Array.isArray(w.slots)),
    sessions: (Array.isArray(g.sessions) ? g.sessions : [])
      .filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.date) && Array.isArray(x.entries))
      .sort(byDate),
  };
}

// ---------- Lookups ----------

const G = () => state.gym;
const exById = id => G().exercises[id] || null;
const exName = id => (exById(id) ? exById(id).name : 'Deleted exercise');
const exerciseNames = () => Object.values(G().exercises).map(e => e.name).sort((a, b) => a.localeCompare(b));
const cleanName = str => String(str || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function findExercise(name) {
  const n = cleanName(name).toLowerCase();
  return Object.values(G().exercises).find(e => e.name.toLowerCase() === n) || null;
}

// Existing exercise with that name, or a new one.
function ensureExercise(name, bodyweight) {
  const found = findExercise(name);
  if (found) return found;
  const ex = { id: newId(), name: cleanName(name), bodyweight: bodyweight || BODYWEIGHT_HINT.test(name) };
  G().exercises[ex.id] = ex;
  return ex;
}

const validSets = en => en.sets.filter(st => st.reps >= 1);

// Where in the routine a lift was done: its routine slot (a workout's numbered exercise),
// or for extras, the workout it was added to. Slots keep their id when moved, so a
// position's history follows it.
const posKey = (ses, en) => en.slotId || `x-${ses.workoutId || 'none'}`;

// Labels for a position, from the lift's point of view (it may be the slot's substitute).
function positionInfo(key, ses, exId) {
  const g = G();
  if (!key.startsWith('x-')) {
    for (let wi = 0; wi < g.workouts.length; wi++) {
      const w = g.workouts[wi];
      const i = w.slots.findIndex(sl => sl.id === key);
      if (i < 0) continue;
      const main = w.slots[i].main;
      return {
        short: `${w.name} #${i + 1}`,
        long: `${w.name} · exercise ${i + 1}${main !== exId ? ` (instead of ${exName(main)})` : ''}`,
        order: wi * 1000 + i,
      };
    }
    return { short: `${ses.name} (old)`, long: `${ses.name} · no longer in your routine`, order: 1e6 };
  }
  return { short: `${ses.name} extra`, long: `${ses.name} · added as an extra`, order: 2e6 };
}

// Every logged appearance of an exercise, oldest first.
function historyOf(exId) {
  const out = [];
  for (const ses of G().sessions) {
    for (const en of ses.entries) {
      if (en.exerciseId !== exId) continue;
      const sets = validSets(en);
      if (sets.length) out.push({ ses, sets, exId, pos: posKey(ses, en) });
    }
  }
  return out;
}

// The positions a lift has history in, in routine order.
function positionsOf(exId, hist) {
  const first = new Map();
  for (const x of hist) if (!first.has(x.pos)) first.set(x.pos, x.ses);
  return [...first].map(([key, ses]) => ({ key, ...positionInfo(key, ses, exId) }))
    .sort((a, b) => a.order - b.order || a.long.localeCompare(b.long));
}

// Other lifts logged in the same position (what you did there instead), by exercise.
function othersInPosition(pos, exId) {
  const by = new Map();
  for (const ses of G().sessions) {
    for (const en of ses.entries) {
      if (en.exerciseId === exId || posKey(ses, en) !== pos) continue;
      const sets = validSets(en);
      if (!sets.length) continue;
      if (!by.has(en.exerciseId)) by.set(en.exerciseId, []);
      by.get(en.exerciseId).push({ ses, sets, exId: en.exerciseId, pos });
    }
  }
  return by;
}

// The newest earlier time a lift was done; with `pos`, only in that position.
function lastTime(exId, current, pos) {
  const list = G().sessions;
  for (let i = list.length - 1; i >= 0; i--) {
    const ses = list[i];
    if (ses === current || ses.date > current.date) continue;
    for (const en of ses.entries) {
      if (en.exerciseId !== exId || !validSets(en).length) continue;
      if (pos && posKey(ses, en) !== pos) continue;
      return { ses, sets: validSets(en), pos: posKey(ses, en) };
    }
  }
  return null;
}

function slotFor(ses, en) {
  const w = G().workouts.find(x => x.id === ses.workoutId);
  return w && en.slotId ? w.slots.find(sl => sl.id === en.slotId) || null : null;
}

function agoText(iso) {
  const diff = dayNum(todayISO()) - dayNum(iso);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return `${diff} days ago`;
}

// ---------- Formatting & metrics ----------

const fmtLoad = kg => String(+toDisplay(kg).toFixed(2));

function loadText(kg, ex) {
  if (ex && ex.bodyweight) return kg > 0 ? `BW+${fmtLoad(kg)} ${unit()}` : 'BW';
  return `${fmtLoad(kg)} ${unit()}`;
}

const fmtOneSet = (st, ex) => `${loadText(st.kg, ex)} × ${st.reps}`;

// "80 kg × 8, 8, 7 · 85 kg × 5": runs of the same weight share one label.
function fmtSets(sets, ex) {
  const groups = [];
  for (const st of sets) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.kg - st.kg) < 1e-6) g.reps.push(st.reps);
    else groups.push({ kg: st.kg, reps: [st.reps] });
  }
  return groups.map(g => `${loadText(g.kg, ex)} × ${g.reps.join(', ')}`).join(' · ');
}

const e1rm = st => (st.reps <= 1 ? st.kg : st.kg * (1 + st.reps / 30)); // Epley

const METRICS = {
  e1rm: { label: 'Est. 1RM', load: true, of: sets => Math.max(...sets.map(e1rm)) },
  top: { label: 'Heaviest', load: true, of: sets => Math.max(...sets.map(st => st.kg)) },
  volume: { label: 'Volume', load: true, of: sets => sets.reduce((a, st) => a + st.kg * st.reps, 0) },
  reps: { label: 'Most reps', load: false, of: sets => Math.max(...sets.map(st => st.reps)) },
  totalReps: { label: 'Total reps', load: false, of: sets => sets.reduce((a, st) => a + st.reps, 0) },
  added: { label: 'Added weight', load: true, of: sets => Math.max(...sets.map(st => st.kg)) },
};
const metricKeys = ex => (ex.bodyweight ? ['reps', 'totalReps', 'added'] : ['e1rm', 'top', 'volume']);
const metricValue = (key, v) => (METRICS[key].load ? toDisplay(v) : v);

function fmtMetric(key, v) {
  if (!METRICS[key].load) return String(Math.round(v));
  if (key === 'volume') return `${Math.round(toDisplay(v)).toLocaleString('en-GB')} ${unit()}`;
  return `${+toDisplay(v).toFixed(1)} ${unit()}`;
}

// ---------- Saving while typing ----------

let gymSaveTimer = null;
function saveSoon() {
  clearTimeout(gymSaveTimer);
  gymSaveTimer = setTimeout(() => { gymSaveTimer = null; save(); }, 400);
}
function flushSave() {
  if (!gymSaveTimer) return;
  clearTimeout(gymSaveTimer);
  gymSaveTimer = null;
  save();
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

// ---------- Sessions ----------

// Drop sets without reps and exercises without sets; delete the session if nothing is left.
function pruneSession(ses) {
  for (const en of ses.entries) en.sets = validSets(en);
  ses.entries = ses.entries.filter(en => en.sets.length);
  if (!ses.entries.length && !(ses.note || '').trim()) {
    G().sessions.splice(G().sessions.indexOf(ses), 1);
    return false;
  }
  return true;
}

function pruneAllSessions(exceptId) {
  for (const ses of [...G().sessions]) if (ses.id !== exceptId) pruneSession(ses);
}

// Show every exercise of the workout, in routine order, plus any extras.
function ensureSlotEntries(ses) {
  const w = G().workouts.find(x => x.id === ses.workoutId);
  if (!w) return;
  const bySlot = new Map(ses.entries.filter(en => en.slotId).map(en => [en.slotId, en]));
  const ordered = w.slots.map(sl => bySlot.get(sl.id) || { id: newId(), slotId: sl.id, exerciseId: sl.main, sets: [] });
  ses.entries = [...ordered, ...ses.entries.filter(en => !ordered.includes(en))];
}

function startWorkout(workoutId) {
  const w = G().workouts.find(x => x.id === workoutId) || null;
  // Already started this workout today? Carry on with it.
  const open = w && G().sessions.find(x => x.workoutId === w.id && x.date === todayISO());
  if (open) { location.hash = `#gym/w/${open.id}`; return; }
  const ses = { id: newId(), date: todayISO(), workoutId: w ? w.id : null, name: w ? w.name : 'Workout', note: '', entries: [] };
  G().sessions.push(ses);
  G().sessions.sort(byDate);
  save();
  location.hash = `#gym/w/${ses.id}`;
}

// Called by the router when leaving a page: tidy up the workout that was open.
function leaveGymRoute(prevHash, nextHash) {
  if (!prevHash || !prevHash.startsWith('#gym') || prevHash === nextHash) return;
  const r = parseGymRoute(prevHash);
  if (r.page !== 'session') return;
  const ses = G().sessions.find(x => x.id === r.id);
  if (!ses) return;
  flushSave();
  pruneSession(ses);
  save();
}

// ---------- Routes ----------

// #gym · #gym/routine · #gym/w/<sessionId> · #gym/x/<exerciseId>[/<position>]
function parseGymRoute(hash) {
  const [, page, id, pos] = String(hash).split('/');
  if (page === 'routine') return { page: 'routine' };
  if (page === 'w' && id) return { page: 'session', id };
  if (page === 'x' && id) return { page: 'exercise', id, pos: pos || null };
  return { page: 'home' };
}

function renderGym(hash = location.hash) {
  const box = $('#view-gym');
  box.textContent = '';
  const r = parseGymRoute(hash);
  if (r.page === 'routine') return renderRoutine(box);
  if (r.page === 'session') {
    const ses = G().sessions.find(x => x.id === r.id);
    if (ses) return renderSession(box, ses);
  }
  if (r.page === 'exercise') {
    const ex = exById(r.id);
    if (ex) return renderExercise(box, ex, r.pos);
  }
  if (r.page !== 'home') history.replaceState(null, '', '#gym');
  setTitle('Gym', false);
  renderGymHome(box);
}

// ---------- Small building blocks ----------

function chevron() {
  const svg = s('svg', { viewBox: '0 0 24 24', class: 'chev', 'aria-hidden': 'true' });
  svg.append(s('path', { d: 'M9 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

const sectionHead = (title, ...actions) => h('div', { class: 'section-head' },
  h('h3', { class: 'section-title' }, title),
  actions.length ? h('span', { class: 'section-actions' }, ...actions) : null);

const linkBtn = (label, onclick, cls = '') => h('button', { type: 'button', class: `btn-link ${cls}`, onclick }, label);

const listRow = (title, sub, onclick, ...end) => h('button', { type: 'button', class: 'row', onclick },
  h('span', { class: 'row-main' }, h('span', { class: 'row-day' }, title), sub ? h('span', { class: 'row-note' }, sub) : null),
  ...end, chevron());

// A form in a dialog. Resolves with { action, values } or null when cancelled.
// Field types: text (with exercise-name suggestions when `suggest`), checkbox, chips (a list of names).
function formDialog({ title, fields, submitLabel = 'Save', actions = [], validate }) {
  const dlg = $('#form-dialog');
  dlg.textContent = '';
  const getters = {};
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const body = fields.map(f => {
    if (f.type === 'checkbox') {
      const cb = h('input', { type: 'checkbox', checked: !!f.value });
      getters[f.key] = () => cb.checked;
      return h('label', { class: 'check' }, cb, h('span', {}, f.label));
    }
    if (f.type === 'chips') {
      const items = [...(f.value || [])];
      const list = h('div', { class: 'chips' });
      const input = h('input', { class: 'input', list: 'dl-exercises', placeholder: f.placeholder || '', autocomplete: 'off', maxlength: 60, 'aria-label': f.label });
      const draw = () => {
        list.textContent = '';
        items.forEach((name, i) => list.append(h('span', { class: 'chip' }, name,
          h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${name}`, onclick: () => { items.splice(i, 1); draw(); } }, '×'))));
      };
      const add = () => {
        const v = cleanName(input.value);
        if (v && !items.some(x => x.toLowerCase() === v.toLowerCase())) items.push(v);
        input.value = '';
        draw();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      draw();
      getters[f.key] = () => { add(); return items; }; // include a name typed but not yet added
      return h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.label), list,
        h('div', { class: 'chip-add' }, input, h('button', { type: 'button', class: 'btn', onclick: add }, 'Add')));
    }
    const id = `fd-${f.key}`;
    const input = h('input', { class: 'input', id, value: f.value || '', placeholder: f.placeholder || '', autocomplete: 'off', maxlength: 60, list: f.suggest ? 'dl-exercises' : null });
    getters[f.key] = () => cleanName(input.value);
    return h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, f.label), input);
  });

  let result = null;
  const collect = () => Object.fromEntries(Object.entries(getters).map(([k, get]) => [k, get()]));
  const form = h('form', { class: 'sheet', novalidate: true },
    h('h2', {}, title),
    ...body,
    h('datalist', { id: 'dl-exercises' }, exerciseNames().map(n => h('option', { value: n }))),
    err,
    actions.length ? h('div', { class: 'sheet-extra' }, actions.map(a => h('button', {
      type: 'button',
      class: `btn ${a.cls || ''}`,
      onclick: () => { result = { action: a.key, values: collect() }; dlg.close(); },
    }, a.label))) : null,
    h('div', { class: 'sheet-actions' },
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, submitLabel)));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const values = collect();
    const problem = validate && validate(values);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    result = { action: 'save', values };
    dlg.close();
  });
  dlg.append(form);
  dlg.showModal();
  const first = form.querySelector('input:not([type=checkbox])');
  if (first) first.focus();
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(result), { once: true }));
}

const needName = v => (v.name ? null : 'Enter a name.');

// ---------- Gym home ----------

function renderGymHome(box) {
  const g = G();

  if (!g.workouts.length) {
    box.append(h('div', { class: 'card intro-card' },
      h('h2', {}, 'Set up your routine'),
      h('p', { class: 'help' }, 'Add your workouts (for example Push, Pull and Legs) and the exercises in each. You can give an exercise substitutes, like pec deck for incline bench, and pick whichever you did when you log.'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn primary', href: '#gym/routine' }, 'Set up routine'),
        h('button', { type: 'button', class: 'btn', onclick: () => startWorkout(null) }, 'Log a workout'))));
  } else {
    const list = h('div', { class: 'card list' });
    for (const w of g.workouts) {
      const done = [...g.sessions].reverse().find(x => x.workoutId === w.id);
      const today = g.sessions.some(x => x.workoutId === w.id && x.date === todayISO());
      list.append(listRow(w.name,
        `${plural(w.slots.length, 'exercise')}${done ? ` · last done ${agoText(done.date)}` : ''}`,
        () => startWorkout(w.id),
        today ? h('span', { class: 'badge' }, 'Today') : null));
    }
    list.append(h('button', { type: 'button', class: 'row row-add', onclick: () => startWorkout(null) }, h('span', { class: 'row-main' }, '+ Workout outside your routine')));
    box.append(sectionHead('Start a workout', h('a', { class: 'btn-link', href: '#gym/routine' }, 'Edit routine')), list);
  }

  // Recent workouts
  const recent = [...g.sessions].reverse();
  if (recent.length) {
    const list = h('div', { class: 'card list' });
    let shown = 0;
    const more = h('button', { type: 'button', class: 'row row-add', onclick: () => showMore() }, h('span', { class: 'row-main' }, 'Show more'));
    const showMore = () => {
      for (const ses of recent.slice(shown, shown + 5)) {
        const sets = ses.entries.reduce((a, en) => a + validSets(en).length, 0);
        list.insertBefore(listRow(`${ses.name} · ${fmtDate(ses.date, { weekday: 'short', day: 'numeric', month: 'short' })}`,
          `${plural(ses.entries.length, 'exercise')} · ${plural(sets, 'set')}`,
          () => { location.hash = `#gym/w/${ses.id}`; }), more);
      }
      shown += 5;
      more.hidden = shown >= recent.length;
    };
    list.append(more);
    showMore();
    box.append(sectionHead('Recent workouts'), list);
  }

  // Lifts with history, most recently done first
  const lifts = Object.values(g.exercises)
    .map(ex => ({ ex, hist: historyOf(ex.id) }))
    .filter(x => x.hist.length)
    .sort((a, b) => byDate(b.hist[b.hist.length - 1].ses, a.hist[a.hist.length - 1].ses));
  if (lifts.length) {
    const list = h('div', { class: 'card list' });
    for (const { ex, hist } of lifts) {
      const last = hist[hist.length - 1];
      const best = last.sets.reduce((a, b) => (ex.bodyweight ? b.reps > a.reps : e1rm(b) > e1rm(a)) ? b : a);
      list.append(listRow(ex.name, `${fmtOneSet(best, ex)} · ${agoText(last.ses.date)}`, () => { location.hash = `#gym/x/${ex.id}`; }));
    }
    box.append(sectionHead('Your lifts'), list);
  }
}

// ---------- Routine editor ----------

function renderRoutine(box) {
  setTitle('Routine', true);
  box.append(h('p', { class: 'help intro' }, 'Tap an exercise to rename it, add substitutes or move it. Substitutes are lifts you sometimes do instead, like pec deck for incline bench.'));
  for (const w of G().workouts) {
    const list = h('div', { class: 'card list' });
    w.slots.forEach((sl, i) => list.append(h('button', { type: 'button', class: 'row', onclick: () => editSlot(w, sl) },
      h('span', { class: 'slot-num' }, String(i + 1)),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-day' }, exName(sl.main)),
        sl.subs.length ? h('span', { class: 'row-note' }, `or ${sl.subs.map(exName).join(', ')}`) : null),
      chevron())));
    list.append(h('button', { type: 'button', class: 'row row-add', onclick: () => addSlot(w) }, h('span', { class: 'row-main' }, '+ Add exercise')));
    box.append(sectionHead(w.name, linkBtn('Rename', () => renameWorkout(w)), linkBtn('Delete', () => deleteWorkout(w), 'danger-link')), list);
  }
  box.append(h('button', { type: 'button', class: 'btn primary block', onclick: addWorkout }, 'Add workout'));
}

async function addWorkout() {
  const res = await formDialog({
    title: 'Add workout',
    fields: [{ key: 'name', label: 'Name', placeholder: 'Push' }],
    submitLabel: 'Add',
    validate: needName,
  });
  if (!res) return;
  const w = { id: newId(), name: res.values.name, slots: [] };
  G().workouts.push(w);
  save();
  renderGym();
  addSlot(w);
}

async function renameWorkout(w) {
  const res = await formDialog({ title: 'Rename workout', fields: [{ key: 'name', label: 'Name', value: w.name }], validate: needName });
  if (!res) return;
  w.name = res.values.name;
  save();
  renderGym();
}

function deleteWorkout(w) {
  if (!confirm(`Delete “${w.name}” from your routine?\n\nWorkouts you already logged stay in your history.`)) return;
  G().workouts.splice(G().workouts.indexOf(w), 1);
  save();
  renderGym();
  toast(`${w.name} deleted`);
}

// Turn substitute names into exercise ids, skipping the main lift and duplicates.
function subIds(names, mainId) {
  const ids = [];
  for (const n of names) {
    const id = ensureExercise(n).id;
    if (id !== mainId && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const slotFields = (name, bodyweight, subs) => [
  { key: 'name', label: 'Exercise', value: name, placeholder: 'Incline bench press', suggest: true },
  { key: 'bw', label: 'Bodyweight exercise (log added weight only)', type: 'checkbox', value: bodyweight },
  { key: 'subs', label: 'Substitutes', type: 'chips', value: subs, placeholder: 'Pec deck' },
];

async function addSlot(w) {
  const res = await formDialog({ title: `Add exercise to ${w.name}`, fields: slotFields('', false, []), submitLabel: 'Add', validate: needName });
  if (!res) return;
  const ex = ensureExercise(res.values.name, res.values.bw);
  w.slots.push({ id: newId(), main: ex.id, subs: subIds(res.values.subs, ex.id) });
  save();
  renderGym();
}

async function editSlot(w, sl) {
  const i = w.slots.indexOf(sl);
  const main = exById(sl.main);
  const actions = [];
  if (i > 0) actions.push({ key: 'up', label: 'Move up' });
  if (i < w.slots.length - 1) actions.push({ key: 'down', label: 'Move down' });
  actions.push({ key: 'remove', label: 'Remove', cls: 'danger' });
  const res = await formDialog({
    title: 'Edit exercise',
    fields: slotFields(main ? main.name : '', main ? main.bodyweight : false, sl.subs.map(exName)),
    actions,
    validate: needName,
  });
  if (!res) return;
  if (res.action === 'remove') {
    w.slots.splice(i, 1);
    save();
    renderGym();
    toast(`Removed from ${w.name}. Its history is kept.`);
    return;
  }
  const { name, bw, subs } = res.values;
  if (name) {
    // A different name picks (or creates) a different exercise; the old one keeps its history.
    const ex = ensureExercise(name, bw);
    ex.bodyweight = bw;
    sl.main = ex.id;
    sl.subs = subIds(subs, ex.id);
  }
  if (res.action === 'up' || res.action === 'down') {
    const j = res.action === 'up' ? i - 1 : i + 1;
    [w.slots[i], w.slots[j]] = [w.slots[j], w.slots[i]];
  }
  save();
  renderGym();
}

// ---------- Logging a workout ----------

function renderSession(box, ses) {
  setTitle(ses.name, true);
  ensureSlotEntries(ses);

  box.append(h('div', { class: 'card session-head' },
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'ses-date' }, 'Date'),
      h('input', {
        class: 'input', type: 'date', id: 'ses-date', value: ses.date, max: todayISO(),
        onchange: e => {
          if (!e.target.value) return;
          ses.date = e.target.value;
          G().sessions.sort(byDate);
          save();
          renderGym();
        },
      })),
    h('p', { class: 'help small' }, `Weights in ${unit()}. Empty sets and exercises you skip aren’t saved.`)));

  for (const en of ses.entries) box.append(entryCard(ses, en));

  box.append(h('button', { type: 'button', class: 'btn block', onclick: () => addExtraExercise(ses) }, '+ Add exercise'));
  box.append(h('div', { class: 'card' },
    h('label', { class: 'field-label', for: 'ses-note' }, 'Note'),
    h('textarea', { class: 'input', id: 'ses-note', rows: 2, maxlength: 500, placeholder: 'How did it go?', oninput: e => { ses.note = e.target.value; saveSoon(); } }, ses.note || '')));
  box.append(h('div', { class: 'btn-row session-actions' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => finishSession(ses) }, 'Finish workout'),
    h('button', { type: 'button', class: 'btn danger', onclick: () => deleteSession(ses) }, 'Delete')));
}

function entryCard(ses, en) {
  const slot = slotFor(ses, en);
  const choices = slot ? [slot.main, ...slot.subs] : [en.exerciseId];
  if (!choices.includes(en.exerciseId)) choices.push(en.exerciseId);
  const ex = exById(en.exerciseId) || { id: en.exerciseId, name: 'Deleted exercise', bodyweight: false };
  const pos = posKey(ses, en);
  // Same position first (last Upper 2 #1 for Upper 2 #1), so rep schemes match.
  const lastHere = lastTime(en.exerciseId, ses, pos);
  const lastAny = lastTime(en.exerciseId, ses);
  const last = lastHere || lastAny; // reference for placeholders and new sets
  const card = h('div', { class: 'card ex-card' });

  const redraw = focusNewSet => {
    const next = entryCard(ses, en);
    card.replaceWith(next);
    if (focusNewSet) {
      const reps = next.querySelectorAll('.set-reps');
      const el = reps[reps.length - 1];
      if (el) { el.focus(); el.select(); }
    }
  };

  const title = choices.length > 1
    ? h('select', {
      class: 'input ex-select', 'aria-label': 'Exercise',
      onchange: e => { en.exerciseId = e.target.value; save(); redraw(); },
    }, choices.map((id, i) => h('option', { value: id, selected: id === en.exerciseId }, i === 0 ? exName(id) : `${exName(id)} (substitute)`)))
    : h('h2', { class: 'ex-title' }, ex.name);

  card.append(h('div', { class: 'ex-head' }, title,
    h('a', { class: 'btn-link', href: `#gym/x/${ex.id}/${pos}` }, 'Progress'),
    slot ? null : linkBtn('Remove', () => { ses.entries.splice(ses.entries.indexOf(en), 1); save(); card.remove(); }, 'danger-link')));

  const lines = [];
  if (lastHere) lines.push(`Last time here (${fmtShortDate(lastHere.ses.date)}): ${fmtSets(lastHere.sets, ex)}`);
  if (lastAny && (!lastHere || lastAny.ses !== lastHere.ses)) {
    const where = positionInfo(lastAny.pos, lastAny.ses, en.exerciseId).short;
    lines.push(`${lastHere ? 'Most recent' : 'Last time'} (${where}, ${fmtShortDate(lastAny.ses.date)}): ${fmtSets(lastAny.sets, ex)}`);
  }
  if (!lines.length) lines.push('No history yet for this exercise.');
  card.append(h('div', { class: 'last-time' }, lines.map(t => h('p', {}, t))));

  if (en.sets.length) {
    const sets = h('div', { class: 'sets' },
      h('div', { class: 'set-row set-head' },
        h('span', {}, 'Set'), h('span', {}, ex.bodyweight ? `+${unit()}` : unit()), h('span', {}), h('span', {}, 'Reps'), h('span', {})));
    en.sets.forEach((st, i) => {
      const ref = last && (last.sets[i] || last.sets[last.sets.length - 1]);
      sets.append(h('div', { class: 'set-row' },
        h('span', { class: 'set-num' }, String(i + 1)),
        h('input', {
          class: 'input set-in', inputmode: 'decimal', autocomplete: 'off', 'aria-label': `Weight, set ${i + 1}`,
          value: st.kg > 0 ? fmtLoad(st.kg) : '', placeholder: ref ? fmtLoad(ref.kg) : '0',
          oninput: e => { const v = parseWeight(e.target.value); st.kg = Number.isFinite(v) ? fromDisplay(v) : 0; saveSoon(); },
        }),
        h('span', { class: 'set-x' }, '×'),
        h('input', {
          class: 'input set-in set-reps', inputmode: 'numeric', autocomplete: 'off', 'aria-label': `Reps, set ${i + 1}`,
          value: st.reps > 0 ? String(st.reps) : '', placeholder: ref ? String(ref.reps) : '',
          oninput: e => { const v = parseInt(e.target.value, 10); st.reps = v > 0 ? Math.min(v, 999) : 0; saveSoon(); },
        }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove set ${i + 1}`, onclick: () => { en.sets.splice(i, 1); save(); redraw(); } }, '×')));
    });
    card.append(sets);
  }

  const addSet = () => {
    // Start from the previous set, or the matching set from last time.
    const ref = en.sets[en.sets.length - 1] || (last && (last.sets[en.sets.length] || last.sets[last.sets.length - 1]));
    en.sets.push({ kg: ref ? ref.kg : 0, reps: ref ? ref.reps : 0 });
    save();
    redraw(true);
  };
  card.append(h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: 'btn', onclick: addSet }, '+ Add set'),
    !en.sets.length && lastHere ? h('button', {
      type: 'button', class: 'btn',
      onclick: () => { en.sets = lastHere.sets.map(st => ({ kg: st.kg, reps: st.reps })); save(); redraw(); },
    }, 'Same as last time') : null));
  return card;
}

async function addExtraExercise(ses) {
  const res = await formDialog({
    title: 'Add exercise',
    fields: [
      { key: 'name', label: 'Exercise', placeholder: 'Cable fly', suggest: true },
      { key: 'bw', label: 'Bodyweight exercise (log added weight only)', type: 'checkbox', value: false },
    ],
    submitLabel: 'Add',
    validate: needName,
  });
  if (!res) return;
  const ex = ensureExercise(res.values.name, res.values.bw);
  ses.entries.push({ id: newId(), slotId: null, exerciseId: ex.id, sets: [] });
  save();
  renderGym();
  const cards = $$('#view-gym .ex-card');
  if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'center' });
}

function finishSession(ses) {
  flushSave();
  const kept = pruneSession(ses);
  save();
  const sets = kept ? ses.entries.reduce((a, en) => a + en.sets.length, 0) : 0;
  toast(kept ? `Workout saved: ${plural(sets, 'set')}` : 'Nothing logged, so the workout wasn’t saved');
  goBack();
}

function deleteSession(ses) {
  const hasSets = ses.entries.some(en => validSets(en).length);
  if (hasSets && !confirm('Delete this workout and all its sets?')) return;
  const i = G().sessions.indexOf(ses);
  G().sessions.splice(i, 1);
  save();
  goBack();
  if (hasSets) {
    toast('Workout deleted', {
      label: 'Undo',
      run: () => {
        G().sessions.push(ses);
        G().sessions.sort(byDate);
        save();
        if (currentView === 'gym') renderGym();
      },
    });
  }
}

// ---------- Exercise progress ----------

function renderExercise(box, ex, posParam) {
  setTitle(ex.name, true);
  const settings = state.settings;
  const allHist = historyOf(ex.id);
  const positions = positionsOf(ex.id, allHist);
  // One position: nothing to choose. Several: all of them, unless the address names one.
  const pos = positions.length === 1 ? positions[0].key
    : positions.some(p => p.key === posParam) ? posParam : 'all';
  const hist = pos === 'all' ? allHist : allHist.filter(x => x.pos === pos);
  const posShort = key => (positions.find(p => p.key === key) || {}).short || '';
  const keys = metricKeys(ex);
  const kind = ex.bodyweight ? 'bw' : 'w';
  const metric = keys.includes((settings.gymMetric || {})[kind]) ? settings.gymMetric[kind] : keys[0];

  if (positions.length > 1) {
    box.append(h('div', { class: 'card pos-card' },
      h('label', { class: 'field-label', for: 'pos-select' }, 'Position in your routine'),
      h('select', {
        class: 'input', id: 'pos-select',
        onchange: e => {
          const v = e.target.value;
          history.replaceState(null, '', v === 'all' ? `#gym/x/${ex.id}` : `#gym/x/${ex.id}/${v}`);
          renderGym();
        },
      },
      h('option', { value: 'all', selected: pos === 'all' }, 'All positions'),
      positions.map(p => h('option', { value: p.key, selected: p.key === pos },
        `${p.long} · ${plural(allHist.filter(x => x.pos === p.key).length, 'session')}`)))));
  }

  if (!allHist.length) {
    box.append(h('div', { class: 'card' }, h('p', { class: 'help' }, 'No sets logged for this exercise yet. Its progress shows up here after your first workout with it.')));
  } else {
    const all = hist.flatMap(x => x.sets.map(st => ({ st, date: x.ses.date })));
    const pick = better => all.reduce((a, b) => (better(b.st, a.st) ? b : a));
    const tile = (label, value, sub, cls = '') => h('div', { class: 'card stat' },
      h('div', { class: 'stat-label' }, label), h('div', { class: `stat-value ${cls}` }, value), h('div', { class: 'stat-sub' }, sub));
    const lastH = hist[hist.length - 1];
    const tiles = [];
    if (ex.bodyweight) {
      const most = pick((b, a) => b.reps > a.reps || (b.reps === a.reps && b.kg > a.kg));
      tiles.push(tile('Most reps', String(most.st.reps), `${loadText(most.st.kg, ex)} · ${fmtShortDate(most.date)}`));
      const loaded = all.filter(x => x.st.kg > 0);
      if (loaded.length) {
        const heavy = loaded.reduce((a, b) => (b.st.kg > a.st.kg || (b.st.kg === a.st.kg && b.st.reps > a.st.reps) ? b : a));
        tiles.push(tile('Most added weight', `+${fmtLoad(heavy.st.kg)} ${unit()}`, `× ${heavy.st.reps} · ${fmtShortDate(heavy.date)}`));
      } else {
        tiles.push(tile('Most added weight', '—', 'Bodyweight only so far'));
      }
    } else {
      const best = pick((b, a) => e1rm(b) > e1rm(a));
      tiles.push(tile('Best est. 1RM', fmtMetric('e1rm', e1rm(best.st)), `${fmtOneSet(best.st, ex)} · ${fmtShortDate(best.date)}`));
      const heavy = pick((b, a) => b.kg > a.kg || (b.kg === a.kg && b.reps > a.reps));
      tiles.push(tile('Heaviest set', `${fmtLoad(heavy.st.kg)} ${unit()}`, `× ${heavy.st.reps} · ${fmtShortDate(heavy.date)}`));
    }
    tiles.push(tile('Last time', fmtSets(lastH.sets, ex), relDay(lastH.ses.date), 'small'));
    tiles.push(tile('Sessions', String(hist.length), `since ${fmtShortDate(hist[0].ses.date)}`));
    box.append(h('div', { class: 'stats' }, tiles));

    // Chart lines: one per position (all positions), or this lift in one position plus,
    // optionally, the other lifts done in that position.
    const series = [];
    const left = [];
    let others = new Map();
    if (pos === 'all') {
      positions.forEach((p, k) => {
        if (k < SERIES_MAX) series.push({ name: p.short, list: allHist.filter(x => x.pos === p.key), ex });
        else left.push(`${p.short} (pick it above to see it)`);
      });
    } else {
      series.push({ name: ex.name, list: hist, ex });
      others = othersInPosition(pos, ex.id);
      if (settings.gymIncludeSubs) {
        for (const [id, list] of others) {
          const other = exById(id) || { name: 'Deleted exercise', bodyweight: false };
          // Weight-based measures don't compare between bodyweight and loaded lifts.
          if (METRICS[metric].load && other.bodyweight !== ex.bodyweight) left.push(`${other.name} (weights of bodyweight and loaded lifts don’t compare)`);
          else if (series.length < SERIES_MAX) series.push({ name: other.name, list, ex: other });
          else left.push(other.name);
        }
      }
    }
    series.forEach((sr, k) => {
      sr.cls = `s${k + 1}`;
      sr.points = sr.list.map(x => ({
        day: dayNum(x.ses.date), date: x.ses.date, value: metricValue(metric, METRICS[metric].of(x.sets)),
        text: fmtMetric(metric, METRICS[metric].of(x.sets)), detail: fmtSets(x.sets, sr.ex),
      }));
    });
    const hasOthersSomewhere = pos === 'all' && positions.some(p => othersInPosition(p.key, ex.id).size);

    const chartBox = h('div', { class: 'chart gym-chart', tabindex: 0 });
    const card = h('div', { class: 'card chart-card' },
      h('div', { class: 'seg seg-metric', role: 'group', 'aria-label': 'Measure' }, keys.map(k => h('button', {
        type: 'button', 'aria-pressed': String(k === metric),
        onclick: () => { settings.gymMetric = { ...(settings.gymMetric || {}), [kind]: k }; save(); renderGym(); },
      }, METRICS[k].label))),
      others.size ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: !!settings.gymIncludeSubs, onchange: e => { settings.gymIncludeSubs = e.target.checked; save(); renderGym(); } }),
        h('span', {}, `Include what you did here instead (${[...others.keys()].map(exName).join(', ')})`)) : null,
      chartBox,
      series.length > 1 ? h('div', { class: 'legend' }, series.map(sr => h('span', {}, h('span', { class: `key-line ${sr.cls}` }), sr.name))) : null,
      left.length ? h('p', { class: 'help small' }, `Not shown: ${left.join(', ')}.`) : null,
      hasOthersSomewhere ? h('p', { class: 'help small' }, 'Pick a position above to compare with the lifts you sometimes do there instead.') : null,
      metric === 'e1rm' ? h('p', { class: 'help small' }, 'Estimated one-rep max from your best set each session (Epley formula).') : null);
    box.append(card);
    gymChart(chartBox, series);

    // Log: this lift (tagged with its position when showing all), plus included lifts
    const rows = [
      ...hist.map(x => ({ x, tag: pos === 'all' ? posShort(x.pos) : null })),
      ...series.slice(pos === 'all' ? series.length : 1).flatMap(sr => sr.list.map(x => ({ x, tag: sr.name }))),
    ].sort((a, b) => byDate(b.x.ses, a.x.ses));
    const list = h('div', { class: 'card list' });
    for (const { x, tag } of rows) {
      list.append(listRow(
        `${fmtDate(x.ses.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${tag ? ` · ${tag}` : ''}`,
        fmtSets(x.sets, exById(x.exId)),
        () => { location.hash = `#gym/w/${x.ses.id}`; },
        h('span', { class: 'row-weight' }, fmtMetric(metric, METRICS[metric].of(x.sets)))));
    }
    box.append(sectionHead('History'), list);
  }

  box.append(sectionHead('Exercise'), h('div', { class: 'card' },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!ex.bodyweight, onchange: e => { ex.bodyweight = e.target.checked; save(); renderGym(); } }),
      h('span', {}, 'Bodyweight exercise (log added weight only)')),
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => renameExercise(ex) }, 'Rename'))));
}

async function renameExercise(ex) {
  const res = await formDialog({ title: 'Rename exercise', fields: [{ key: 'name', label: 'Name', value: ex.name }], validate: needName });
  if (!res || res.values.name === ex.name) return;
  const other = findExercise(res.values.name);
  if (other && other.id !== ex.id) {
    if (!confirm(`“${other.name}” already exists. Merge “${ex.name}” into it?\n\nAll sets from both will show under “${other.name}”.`)) return;
    mergeExercise(ex.id, other.id);
    save();
    history.replaceState(null, '', `#gym/x/${other.id}`);
    renderGym();
    toast('Exercises merged');
    return;
  }
  ex.name = res.values.name;
  save();
  renderGym();
}

function mergeExercise(fromId, toId) {
  const g = G();
  for (const w of g.workouts) {
    for (const sl of w.slots) {
      if (sl.main === fromId) sl.main = toId;
      sl.subs = [...new Set(sl.subs.map(id => (id === fromId ? toId : id)))].filter(id => id !== sl.main);
    }
  }
  for (const ses of g.sessions) for (const en of ses.entries) if (en.exerciseId === fromId) en.exerciseId = toId;
  delete g.exercises[fromId];
}

// ---------- Progress chart ----------

// Lines over time, one per exercise; tap or hover snaps to the nearest session.
function gymChart(box, series) {
  const W = box.clientWidth;
  if (!W) return;
  const H = 220;
  const m = { l: 44, r: 14, t: 14, b: 26 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const pts = series.flatMap((sr, k) => sr.points.map(p => ({ ...p, k })));
  if (!pts.length) return;

  let x1 = Math.max(...pts.map(p => p.day));
  let x0 = Math.min(...pts.map(p => p.day));
  if (x1 - x0 < 6) x0 = x1 - 6;
  let lo = Math.min(...pts.map(p => p.value));
  let hi = Math.max(...pts.map(p => p.value));
  if (hi - lo < 2) { const c = (hi + lo) / 2; lo = c - 1; hi = c + 1; }
  const padY = (hi - lo) * 0.1;
  const step = niceStep(hi - lo + 2 * padY, 4);
  const y0 = Math.max(0, Math.floor((lo - padY) / step) * step);
  const y1 = Math.ceil((hi + padY) / step) * step;
  const X = d => m.l + ((d - x0) / (x1 - x0)) * iw;
  const Y = v => m.t + ((y1 - v) / (y1 - y0)) * ih;

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  const decimals = step < 1 ? 1 : 0;
  for (let i = 0, n = Math.round((y1 - y0) / step); i <= n; i++) {
    const v = y0 + i * step;
    svg.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
    svg.append(s('text', { class: 'axis-label', x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' },
      v >= 10000 ? `${+(v / 1000).toFixed(1)}k` : v.toFixed(decimals)));
  }
  const span = x1 - x0;
  const nX = Math.max(2, Math.min(4, Math.floor(iw / 90)));
  const xFmt = span > 300 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };
  for (let i = 0; i <= nX; i++) {
    const d = Math.round(x0 + (span * i) / nX);
    svg.append(s('text', { class: 'axis-label', x: X(d), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle' }, fmtDate(isoFromDay(d), xFmt)));
  }

  for (const sr of series) {
    const xy = sr.points.map(p => [X(p.day), Y(p.value)]);
    if (xy.length > 1) svg.append(s('path', { class: `series-line ${sr.cls}`, d: xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') }));
    if (xy.length <= iw / 6) for (const [x, y] of xy) svg.append(s('circle', { class: `series-dot ${sr.cls}`, cx: x, cy: y, r: 4 }));
  }

  const cross = s('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  const hot = s('circle', { class: 'series-dot dot-hot', r: 6, visibility: 'hidden' });
  const hit = s('rect', { class: 'hit', x: m.l - 10, y: 0, width: iw + 20, height: H, fill: 'transparent' });
  svg.append(cross, hot, hit);
  box.textContent = '';
  box.append(svg);
  const tip = h('div', { class: 'tooltip', hidden: true });
  box.append(tip);

  const order = [...pts].sort((a, b) => a.day - b.day || a.k - b.k);
  let sel = -1;
  const show = i => {
    sel = i;
    const p = order[i];
    const px = X(p.day);
    const py = Y(p.value);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    hot.setAttribute('class', `series-dot dot-hot ${series[p.k].cls}`);
    hot.setAttribute('cx', px);
    hot.setAttribute('cy', py);
    hot.setAttribute('visibility', 'visible');
    tip.textContent = '';
    tip.append(h('strong', {}, p.text),
      series.length > 1 ? h('span', { class: 'tip-series' }, h('span', { class: `key-line ${series[p.k].cls}` }), series[p.k].name) : null,
      h('span', { class: 'tip-detail' }, p.detail),
      fmtDate(p.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(px - tip.offsetWidth / 2, 0), W - tip.offsetWidth)}px`;
    tip.style.top = `${py - tip.offsetHeight - 12 >= 0 ? py - tip.offsetHeight - 12 : py + 14}px`;
  };
  const hide = () => {
    sel = -1;
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    hot.setAttribute('visibility', 'hidden');
  };
  // Nearest session by date; among sessions on the same day, the one closest to the pointer.
  const nearest = e => {
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = 0;
    let bestScore = Infinity;
    order.forEach((p, i) => {
      const score = Math.abs(X(p.day) - x) * 1000 + Math.abs(Y(p.value) - y);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  };
  hit.addEventListener('pointerdown', e => show(nearest(e)));
  hit.addEventListener('pointermove', e => show(nearest(e)));
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  box.onkeydown = e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = sel < 0 ? order.length - 1 : sel + (e.key === 'ArrowRight' ? 1 : -1);
      show(Math.min(order.length - 1, Math.max(0, next)));
    } else if (e.key === 'Escape') hide();
  };
  box.onblur = hide;
  box.setAttribute('aria-label', `Progress chart: ${series.map(sr => `${sr.name}, ${plural(sr.points.length, 'session')}`).join('; ')}. Use left and right arrow keys to read values.`);
  gymTip = { box, hide };
}

// One listener for every chart render: tapping elsewhere hides the tooltip.
let gymTip = null;
document.addEventListener('pointerdown', ev => { if (gymTip && !gymTip.box.contains(ev.target)) gymTip.hide(); });
