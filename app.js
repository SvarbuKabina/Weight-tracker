'use strict';

const APP_VERSION = '1.0.0';
const STORE_KEY = 'weight-tracker/v1';
const KG_PER_LB = 0.45359237;
const DAY_MS = 86400000;
const MIN_KG = 20;
const MAX_KG = 500;
const RANGES = {
  '1m': { days: 30, label: 'Last month' },
  '3m': { days: 91, label: 'Last 3 months' },
  '6m': { days: 182, label: 'Last 6 months' },
  '1y': { days: 365, label: 'Last year' },
  all: { days: Infinity, label: 'All time' },
};

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// ---------- State & storage ----------

function defaultState() {
  return {
    entries: [], // { id, date: 'YYYY-MM-DD', kg, note }, kept sorted by date
    settings: {
      unit: 'kg',
      goal: null, // { kg, startKg }
      reminderTime: '08:00',
      range: '3m',
      lastExport: null, // ISO timestamp
    },
  };
}

function validEntry(e) {
  return e && typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(e.kg);
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const base = defaultState();
    return {
      entries: (Array.isArray(data.entries) ? data.entries : []).filter(validEntry).sort(byDate),
      settings: { ...base.settings, ...(data.settings || {}) },
    };
  } catch (err) {
    console.error('Could not read saved data', err);
    // Keep the unreadable copy instead of overwriting it on the next save.
    try { if (raw) localStorage.setItem(`${STORE_KEY}/unreadable-${Date.now()}`, raw); } catch {}
    return defaultState();
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error(err);
    toast('Couldn’t save. Your browser is blocking storage.');
    return false;
  }
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
  renderStorageStatus();
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const sortEntries = () => state.entries.sort(byDate);
const latest = () => state.entries[state.entries.length - 1] || null;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let state = load();

// ---------- Dates ----------

const pad = n => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Whole days since the epoch; avoids DST surprises in date arithmetic.
function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function isoFromDay(n) {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const dateFormats = new Map();
function fmtDate(iso, opts) {
  const key = JSON.stringify(opts);
  if (!dateFormats.has(key)) dateFormats.set(key, new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }));
  return dateFormats.get(key).format(new Date(dayNum(iso) * DAY_MS));
}

function fmtShortDate(iso) {
  const sameYear = iso.slice(0, 4) === todayISO().slice(0, 4);
  return fmtDate(iso, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function relDay(iso) {
  const diff = dayNum(todayISO()) - dayNum(iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return fmtDate(iso, { weekday: 'long' });
  return fmtShortDate(iso);
}

// ---------- Units ----------

const unit = () => state.settings.unit;
const toDisplay = kg => (unit() === 'lb' ? kg / KG_PER_LB : kg);
const fromDisplay = v => (unit() === 'lb' ? v * KG_PER_LB : v);
const fmtW = kg => toDisplay(kg).toFixed(1);
const fmtWU = kg => `${fmtW(kg)} ${unit()}`;

function fmtDelta(kg) {
  const v = toDisplay(kg);
  if (Math.abs(v) < 0.05) return `0.0 ${unit()}`;
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} ${unit()}`;
}

// Accepts "80.4", "80,4", "80.4 kg".
function parseWeight(str) {
  const m = String(str ?? '').match(/\d+(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(',', '.')) : NaN;
}

// ---------- Trend maths ----------

function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const den = n * sxx - sx * sx;
  return den === 0 ? null : (n * sxy - sx * sy) / den;
}

// kg per day from a least-squares line, or null with less than a week of data.
function pace(entries) {
  if (entries.length < 2) return null;
  if (dayNum(entries[entries.length - 1].date) - dayNum(entries[0].date) < 7) return null;
  return slope(entries.map(e => [dayNum(e.date), e.kg]));
}

function goalStart() {
  const g = state.settings.goal;
  if (!g) return null;
  return g.startKg ?? (state.entries[0] ? state.entries[0].kg : null);
}

// -1 if the goal is to lose, +1 to gain, 0 if no goal.
function goalDirection() {
  const g = state.settings.goal;
  const start = goalStart();
  if (!g || start == null) return 0;
  return g.kg < start ? -1 : g.kg > start ? 1 : 0;
}

// A change gets the "good" colour only when it moves toward the goal.
function toneFor(deltaKg) {
  const dir = goalDirection();
  if (deltaKg == null || !dir || Math.abs(toDisplay(deltaKg)) < 0.05) return '';
  return Math.sign(deltaKg) === dir ? 'good' : '';
}

function rangeEntries() {
  const { days } = RANGES[state.settings.range] || RANGES['3m'];
  if (days === Infinity) return state.entries.slice();
  const start = dayNum(todayISO()) - days;
  return state.entries.filter(e => dayNum(e.date) >= start);
}

// ---------- DOM helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.textContent = '';
  t.append(h('span', {}, msg));
  const hide = () => t.classList.remove('show');
  if (action) {
    t.append(h('button', { class: 'toast-action', type: 'button', onclick: () => { hide(); action.run(); } }, action.label));
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 6000 : 2500);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Navigation ----------

const VIEWS = { '': 'home', '#history': 'history', '#settings': 'settings' };
const TITLES = { home: 'Weight', history: 'History', settings: 'Settings' };
let currentView = 'home';

function route() {
  if (location.hash === '#add') {
    history.replaceState(null, '', location.pathname + location.search);
    showView('home');
    openEntry();
    return;
  }
  showView(VIEWS[location.hash] || 'home');
}

function showView(name) {
  const changed = name !== currentView;
  currentView = name;
  for (const v of Object.values(VIEWS)) $(`#view-${v}`).hidden = v !== name;
  $$('.tab').forEach(t => (t.dataset.view === name ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  $('#view-title').textContent = TITLES[name];
  $('#add-btn').hidden = name === 'settings';
  if (name === 'home') renderChart();
  if (changed) window.scrollTo(0, 0);
}

// ---------- Rendering: home ----------

function renderAll() {
  renderHome();
  renderHistory();
  renderSettings();
}

function renderHome() {
  renderHero();
  renderBackupNudge();
  const has = state.entries.length > 0;
  $('#home-data').hidden = !has;
  if (!has) return;
  $$('#range button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === state.settings.range)));
  renderChart();
  renderStats(rangeEntries());
}

function renderHero() {
  const hero = $('#hero');
  hero.textContent = '';
  const last = latest();
  if (!last) {
    hero.classList.add('hero-empty');
    hero.append(
      h('h2', {}, 'Welcome!'),
      h('p', {}, 'Log your first weigh-in to start tracking your trend.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openEntry() }, 'Add your weight'),
    );
    return;
  }
  hero.classList.remove('hero-empty');
  const prev = state.entries[state.entries.length - 2];
  const diff = prev ? last.kg - prev.kg : null;
  hero.append(
    h('div', { class: 'hero-label' }, 'Current weight'),
    h('div', { class: 'hero-value' }, fmtW(last.kg), h('small', {}, unit())),
    h('div', { class: 'hero-sub' },
      relDay(last.date),
      diff != null ? h('span', { class: 'sep' }, '·') : null,
      diff != null ? h('span', { class: toneFor(diff) }, `${fmtDelta(diff)} vs previous`) : null,
    ),
    renderGoal(last),
  );
}

function renderGoal(last) {
  const g = state.settings.goal;
  if (!g) {
    return h('div', { class: 'goal' },
      h('a', { class: 'link', href: '#settings', onclick: () => setTimeout(() => $('#goal-input').focus(), 100) }, 'Set a goal weight →'));
  }
  const start = goalStart();
  const dir = g.kg < start ? -1 : 1;
  const remaining = g.kg - last.kg;
  const reached = dir < 0 ? last.kg <= g.kg : last.kg >= g.kg;
  const frac = start === g.kg ? 1 : Math.min(1, Math.max(0, (start - last.kg) / (start - g.kg)));

  let eta;
  if (reached) {
    eta = 'You’ve reached your goal. Nice work!';
  } else {
    const today = dayNum(todayISO());
    const p = pace(state.entries.filter(e => dayNum(e.date) >= today - 28));
    if (p == null) eta = 'Keep logging for a week to see when you’ll get there.';
    else if (Math.sign(p) !== Math.sign(remaining) || Math.abs(p) < 0.005) eta = 'Your 4-week trend isn’t heading toward your goal right now.';
    else {
      const daysLeft = remaining / p;
      eta = daysLeft > 730
        ? 'At your 4-week pace: more than 2 years.'
        : `At your 4-week pace: around ${fmtDate(isoFromDay(today + Math.ceil(daysLeft)), { day: 'numeric', month: 'short', year: 'numeric' })}.`;
    }
  }

  return h('div', { class: 'goal' },
    h('div', { class: 'goal-row' },
      h('span', {}, `Goal ${fmtWU(g.kg)}`),
      h('strong', {}, reached ? 'Reached' : `${fmtW(Math.abs(remaining))} ${unit()} to go`)),
    h('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Progress toward goal', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(frac * 100) },
      h('span', { style: `width:${(frac * 100).toFixed(1)}%` })),
    h('div', { class: 'goal-eta' }, eta),
  );
}

function renderBackupNudge() {
  const n = state.entries.length;
  const last = state.settings.lastExport ? Date.parse(state.settings.lastExport) : null;
  const daysSinceExport = last ? (Date.now() - last) / DAY_MS : Infinity;
  const tracking = n ? dayNum(todayISO()) - dayNum(state.entries[0].date) : 0;
  $('#backup-nudge').hidden = !(n >= 5 && daysSinceExport > 30 && (last || tracking >= 14));
}

function renderStats(data) {
  const grid = $('#stats');
  grid.textContent = '';
  if (!data.length) return;
  const tile = (label, value, sub, cls) => h('div', { class: 'card stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: `stat-value ${cls || ''}` }, value),
    h('div', { class: 'stat-sub' }, sub));

  const first = data[0];
  const last = data[data.length - 1];
  const change = data.length > 1 ? last.kg - first.kg : null;
  const p = pace(data);
  const kgs = data.map(e => e.kg);
  const avg = kgs.reduce((a, b) => a + b, 0) / kgs.length;

  grid.append(
    tile('Change', change == null ? '—' : fmtDelta(change),
      change == null ? 'Needs 2 weigh-ins' : `since ${fmtShortDate(first.date)}`, toneFor(change)),
    tile('Weekly pace', p == null ? '—' : fmtDelta(p * 7),
      p == null ? 'Needs a week of data' : 'per week, trend line', p == null ? '' : toneFor(p * 7)),
    tile('Average', fmtWU(avg), `${data.length} weigh-in${data.length === 1 ? '' : 's'}`),
    tile('Lowest – highest', `${fmtW(Math.min(...kgs))}–${fmtW(Math.max(...kgs))}`, unit()),
  );
}

// ---------- Rendering: chart ----------

let hideChartTip = () => {};

function niceStep(span, targetTicks) {
  const raw = span / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

function renderChart() {
  const box = $('#chart');
  const W = box.clientWidth;
  if (!W || !state.entries.length) return; // hidden; drawn when shown
  box.textContent = '';
  box.onkeydown = null;
  box.onblur = null;
  hideChartTip = () => {};
  const range = RANGES[state.settings.range] || RANGES['3m'];
  $('#chart-sub').textContent = range.label;

  const data = rangeEntries();
  if (!data.length) {
    box.removeAttribute('aria-label');
    box.append(h('p', { class: 'chart-empty' }, 'No weigh-ins in this period.'));
    return;
  }

  const H = box.clientHeight || 230;
  const m = { l: 40, r: unit() === 'lb' ? 46 : 40, t: 14, b: 26 }; // right margin holds the latest-value label
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  // X domain: the selected range, starting no earlier than the first weigh-in.
  const today = dayNum(todayISO());
  const firstDay = dayNum(data[0].date);
  const lastDay = dayNum(data[data.length - 1].date);
  const x1 = Math.max(today, lastDay);
  let x0 = range.days === Infinity ? firstDay : Math.max(today - range.days, firstDay);
  if (x1 - x0 < 6) x0 = x1 - 6;

  // Y domain: the data, plus the goal when it is close enough not to flatten the line.
  const vals = data.map(e => toDisplay(e.kg));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const minSpan = unit() === 'lb' ? 2 : 1;
  const goalV = state.settings.goal ? toDisplay(state.settings.goal.kg) : null;
  let showGoal = false;
  if (goalV != null) {
    const dist = goalV < lo ? lo - goalV : goalV > hi ? goalV - hi : 0;
    if (dist <= Math.max(hi - lo, minSpan) * 1.5) {
      lo = Math.min(lo, goalV);
      hi = Math.max(hi, goalV);
      showGoal = true;
    }
  }
  if (hi - lo < minSpan) {
    const c = (hi + lo) / 2;
    lo = c - minSpan / 2;
    hi = c + minSpan / 2;
  }
  const padY = (hi - lo) * 0.1;
  const step = niceStep(hi - lo + 2 * padY, 4);
  const y0 = Math.floor((lo - padY) / step) * step;
  const y1 = Math.ceil((hi + padY) / step) * step;

  const X = d => m.l + ((d - x0) / (x1 - x0)) * iw;
  const Y = v => m.t + ((y1 - v) / (y1 - y0)) * ih;

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });

  const decimals = step < 1 ? 1 : 0;
  const nY = Math.round((y1 - y0) / step);
  for (let i = 0; i <= nY; i++) {
    const v = y0 + i * step;
    const y = Y(v);
    svg.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y, y2: y }));
    svg.append(s('text', { class: 'axis-label', x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, v.toFixed(decimals)));
  }

  const span = x1 - x0;
  const nX = Math.max(2, Math.min(4, Math.floor(iw / 90)));
  const xFmt = span > 300 ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' };
  for (let i = 0; i <= nX; i++) {
    const d = Math.round(x0 + (span * i) / nX);
    const anchor = i === 0 ? 'start' : i === nX ? 'end' : 'middle';
    svg.append(s('text', { class: 'axis-label', x: X(d), y: H - 6, 'text-anchor': anchor }, fmtDate(isoFromDay(d), xFmt)));
  }

  if (showGoal) {
    const gy = Y(goalV);
    svg.append(s('line', { class: 'goal-line', x1: m.l, x2: W - m.r, y1: gy, y2: gy }));
    svg.append(s('text', { class: 'goal-label', x: m.l + 6, y: gy - m.t > 18 ? gy - 6 : gy + 15 }, `Goal ${goalV.toFixed(1)}`));
  }

  const pts = data.map((e, i) => [X(dayNum(e.date)), Y(vals[i])]);
  if (pts.length > 1) {
    svg.append(s('path', { class: 'line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') }));
  }
  const showDots = pts.length <= iw / 8;
  pts.forEach((p, i) => {
    if (showDots || i === pts.length - 1) svg.append(s('circle', { class: 'dot', cx: p[0], cy: p[1], r: 4 }));
  });

  // Label only the latest value, just right of its dot; the axis and tooltip carry the rest.
  const [ex, ey] = pts[pts.length - 1];
  svg.append(s('text', { class: 'end-label', x: ex + 8, y: ey + 4 }, vals[vals.length - 1].toFixed(1)));

  // Hover / touch layer: a crosshair that snaps to the nearest weigh-in.
  const cross = s('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  const hot = s('circle', { class: 'dot dot-hot', r: 6, visibility: 'hidden' });
  const hit = s('rect', { class: 'hit', x: m.l - 10, y: 0, width: iw + 20, height: H, fill: 'transparent' });
  svg.append(cross, hot, hit);
  box.append(svg);
  const tip = h('div', { class: 'tooltip', hidden: true });
  box.append(tip);

  let sel = -1;
  const show = i => {
    sel = i;
    const [px, py] = pts[i];
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    hot.setAttribute('cx', px);
    hot.setAttribute('cy', py);
    hot.setAttribute('visibility', 'visible');
    tip.textContent = '';
    tip.append(h('strong', {}, fmtWU(data[i].kg)), fmtDate(data[i].date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), W - tw)}px`;
    tip.style.top = `${py - th - 12 >= 0 ? py - th - 12 : py + 14}px`;
  };
  const hide = () => {
    sel = -1;
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    hot.setAttribute('visibility', 'hidden');
  };
  hideChartTip = hide;

  const nearest = clientX => {
    const x = clientX - svg.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < Math.abs(pts[best][0] - x)) best = i;
    return best;
  };
  hit.addEventListener('pointerdown', e => show(nearest(e.clientX)));
  hit.addEventListener('pointermove', e => show(nearest(e.clientX)));
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  box.onkeydown = e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = sel < 0 ? pts.length - 1 : sel + (e.key === 'ArrowRight' ? 1 : -1);
      show(Math.min(pts.length - 1, Math.max(0, next)));
    } else if (e.key === 'Escape') hide();
  };
  box.onblur = hide;
  box.setAttribute('aria-label',
    `Weight chart, ${range.label.toLowerCase()}: ${data.length} weigh-ins, from ${fmtWU(data[0].kg)} to ${fmtWU(data[data.length - 1].kg)}. Use left and right arrow keys to read values.`);
}

// ---------- Rendering: history ----------

function renderHistory() {
  const list = $('#history-list');
  list.textContent = '';
  if (!state.entries.length) {
    list.append(h('div', { class: 'empty' }, h('h2', {}, 'No weigh-ins yet'), h('p', {}, 'Tap + to add your first one.')));
    return;
  }
  let month = '';
  let group = null;
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    const prev = state.entries[i - 1];
    if (e.date.slice(0, 7) !== month) {
      month = e.date.slice(0, 7);
      group = h('div', { class: 'card list' });
      list.append(h('h3', { class: 'month-title' }, fmtDate(e.date, { month: 'long', year: 'numeric' })), group);
    }
    const diff = prev ? e.kg - prev.kg : null;
    group.append(h('button', { class: 'row', type: 'button', onclick: () => openEntry(e) },
      h('span', { class: 'row-main' },
        h('span', { class: 'row-day' }, fmtDate(e.date, { weekday: 'short', day: 'numeric', month: 'short' })),
        e.note ? h('span', { class: 'row-note' }, e.note) : null),
      h('span', { class: `row-diff ${toneFor(diff)}` }, diff == null ? '' : fmtDelta(diff).replace(/ \w+$/, '')),
      h('span', { class: 'row-weight' }, fmtW(e.kg), h('small', {}, ` ${unit()}`)),
    ));
  }
}

// ---------- Rendering: settings ----------

let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderSettings() {
  $$('#unit-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.unit === unit())));
  $$('[data-unit-text]').forEach(el => (el.textContent = unit()));

  const g = state.settings.goal;
  if (document.activeElement !== $('#goal-input')) $('#goal-input').value = g ? fmtW(g.kg) : '';
  $('#goal-clear').hidden = !g;

  $('#reminder-time').value = state.settings.reminderTime;
  $('#gcal-link').href = googleCalendarUrl(state.settings.reminderTime);

  const n = state.entries.length;
  const le = state.settings.lastExport;
  $('#backup-status').textContent = `${n} weigh-in${n === 1 ? '' : 's'} saved on this device. ` +
    (le ? `Last export: ${new Date(le).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'Not exported yet.');

  $('#app-version').textContent = APP_VERSION;
  renderInstall();
  renderStorageStatus();
}

function renderInstall() {
  const card = $('#install-card');
  if (isStandalone()) { card.hidden = true; return; }
  card.hidden = false;
  const btn = $('#install-btn');
  btn.hidden = !installPrompt;
  if (installPrompt) {
    $('#install-text').textContent = 'Install Weight Tracker so it opens like a normal app and works offline.';
  } else if (isIOS()) {
    $('#install-text').textContent = 'In Safari, tap the Share button, then “Add to Home Screen”. Do this before you start logging: on iPhone the Home Screen app keeps its own data, and Safari can clear data for websites you haven’t opened in a week.';
  } else {
    $('#install-text').textContent = 'Open your browser menu (⋮) and choose “Install app” or “Add to Home screen”, so it opens like a normal app and works offline.';
  }
}

async function renderStorageStatus() {
  let text = 'Storage: standard';
  try {
    if (navigator.storage && navigator.storage.persisted) {
      text = (await navigator.storage.persisted()) ? 'Storage: persistent' : 'Storage: best effort, back up regularly';
    }
  } catch {}
  $('#storage-status').textContent = text;
}

// ---------- Entry dialog ----------

let editing = null;

function openEntry(entry) {
  editing = entry || null;
  const dlg = $('#entry-dialog');
  $('#entry-title').textContent = entry ? 'Edit weigh-in' : 'Add weigh-in';
  $('#entry-date').max = todayISO();
  $('#entry-date').value = entry ? entry.date : todayISO();
  const prefill = entry || latest();
  $('#entry-weight').value = prefill ? fmtW(prefill.kg) : '';
  $('#entry-weight').placeholder = unit() === 'lb' ? '170.0' : '75.0';
  $('#entry-note').value = entry ? entry.note || '' : '';
  $('#entry-delete').hidden = !entry;
  $('#entry-error').hidden = true;
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => {
    const input = $('#entry-weight');
    input.focus();
    input.select();
  });
}

function entryError(msg) {
  const el = $('#entry-error');
  el.textContent = msg;
  el.hidden = false;
}

function saveEntry(ev) {
  ev.preventDefault();
  const date = $('#entry-date').value;
  const v = parseWeight($('#entry-weight').value);
  if (!date) return entryError('Pick a date.');
  if (date > todayISO()) return entryError('The date can’t be in the future.');
  if (!Number.isFinite(v)) return entryError(`Enter your weight, for example ${unit() === 'lb' ? '170.4' : '80.4'}.`);
  // Keep the exact stored value if the shown number wasn't changed (avoids lb rounding drift).
  const kg = editing && v.toFixed(1) === fmtW(editing.kg) ? editing.kg : fromDisplay(v);
  if (kg < MIN_KG || kg > MAX_KG) return entryError(`That doesn’t look right. Enter a weight between ${fmtWU(MIN_KG)} and ${fmtWU(MAX_KG)}.`);
  const note = $('#entry-note').value.trim().slice(0, 200);

  const clash = state.entries.find(e => e.date === date && e !== editing);
  if (clash && !confirm(`You already have ${fmtWU(clash.kg)} on ${fmtShortDate(date)}. Replace it?`)) return;
  if (clash) state.entries.splice(state.entries.indexOf(clash), 1);

  const wasEditing = !!editing;
  if (editing) Object.assign(editing, { date, kg, note });
  else state.entries.push({ id: newId(), date, kg, note });
  sortEntries();

  const g = state.settings.goal;
  if (g && g.startKg == null) g.startKg = kg;

  if (!save()) return;
  $('#entry-dialog').close();
  editing = null;
  renderAll();
  toast(wasEditing ? 'Weigh-in updated' : 'Weigh-in saved');
  requestPersistentStorage();
}

function deleteEntry() {
  const entry = editing;
  if (!entry) return;
  state.entries.splice(state.entries.indexOf(entry), 1);
  save();
  $('#entry-dialog').close();
  editing = null;
  renderAll();
  toast('Weigh-in deleted', {
    label: 'Undo',
    run: () => {
      state.entries.push(entry);
      sortEntries();
      save();
      renderAll();
    },
  });
}

function stepWeight(dir) {
  const input = $('#entry-weight');
  const cur = parseWeight(input.value);
  const base = Number.isFinite(cur) ? cur : latest() ? toDisplay(latest().kg) : unit() === 'lb' ? 170 : 75;
  input.value = Math.max(0, Math.round((base + dir * 0.1) * 10) / 10).toFixed(1);
}

// ---------- Goal ----------

function saveGoal(ev) {
  ev.preventDefault();
  const v = parseWeight($('#goal-input').value);
  if (!Number.isFinite(v)) return toast('Enter a goal weight first.');
  const kg = fromDisplay(v);
  if (kg < MIN_KG || kg > MAX_KG) return toast('That goal doesn’t look right.');
  const old = state.settings.goal;
  const current = latest() ? latest().kg : null;
  // Keep the starting point if the goal still points the same way, so progress isn't reset by a small tweak.
  let startKg = current;
  if (old && old.startKg != null && current != null && Math.sign(old.kg - old.startKg) === Math.sign(kg - old.startKg)) startKg = old.startKg;
  state.settings.goal = { kg, startKg };
  save();
  $('#goal-input').blur();
  renderAll();
  toast('Goal saved');
}

function clearGoal() {
  state.settings.goal = null;
  save();
  renderAll();
  toast('Goal cleared');
}

// ---------- Reminder ----------

function nextOccurrence(time) {
  const [hh, mm] = time.split(':').map(Number);
  const d = new Date();
  d.setHours(hh || 0, mm || 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}

const calStamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');

function googleCalendarUrl(time) {
  const start = nextOccurrence(time);
  const end = new Date(start.getTime() + 5 * 60000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Weigh in',
    details: `Log today’s weight: ${appUrl()}`,
    dates: `${calStamp(start)}/${calStamp(end)}`,
    recur: 'RRULE:FREQ=DAILY',
  });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) params.set('ctz', tz);
  return `https://calendar.google.com/calendar/render?${params}`;
}

function downloadICS() {
  const esc = t => t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const fold = line => line.match(/.{1,73}/g).join('\r\n ');
  const start = nextOccurrence(state.settings.reminderTime);
  const now = new Date();
  const utc = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Weight Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:weigh-in-${Date.now()}@weight-tracker`,
    `DTSTAMP:${utc}`,
    `DTSTART:${calStamp(start)}`, // floating local time: stays at the same clock time across DST
    'DURATION:PT5M',
    'RRULE:FREQ=DAILY',
    'SUMMARY:Weigh in',
    `DESCRIPTION:${esc(`Log today’s weight: ${appUrl()}`)}`,
    `URL:${appUrl()}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Time to weigh in',
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  download(new Blob([lines.map(fold).join('\r\n') + '\r\n'], { type: 'text/calendar' }), 'weigh-in-reminder.ics');
}

// ---------- CSV export / import ----------

const csvFileName = () => `weight-tracker-${todayISO()}.csv`;

function csvCell(value) {
  const str = String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildCSV() {
  const rows = [['date', 'weight_kg', 'weight_lb', 'note']];
  for (const e of state.entries) {
    let note = e.note || '';
    if (/^[=+\-@]/.test(note)) note = `'${note}`; // stop spreadsheets treating notes as formulas
    rows.push([e.date, +e.kg.toFixed(2), +(e.kg / KG_PER_LB).toFixed(1), note]);
  }
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function markExported() {
  state.settings.lastExport = new Date().toISOString();
  save();
  renderSettings();
  renderBackupNudge();
}

function exportCSV() {
  if (!state.entries.length) return toast('Nothing to export yet.');
  download(new Blob([buildCSV()], { type: 'text/csv;charset=utf-8' }), csvFileName());
  markExported();
}

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] }));
  } catch {
    return false;
  }
}

async function shareCSV() {
  if (!state.entries.length) return toast('Nothing to export yet.');
  const file = new File([buildCSV()], csvFileName(), { type: 'text/csv' });
  try {
    await navigator.share({ files: [file], title: 'Weight Tracker backup' });
    markExported();
  } catch (err) {
    if (err.name !== 'AbortError') toast('Sharing didn’t work. Try Export CSV instead.');
  }
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Accepts YYYY-MM-DD (optionally with a time after it) and DD.MM.YYYY / DD/MM/YYYY.
function parseDate(str) {
  const t = String(str ?? '').trim();
  let y, mo, d, x;
  if ((x = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, mo, d] = x;
  else if ((x = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) [, d, mo, y] = x;
  else return null;
  y = +y; mo = +mo; d = +d;
  if (mo > 12 && d <= 12) [mo, d] = [d, mo]; // clearly month-first
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function parseImport(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { error: 'That file is empty.' };
  const head = rows[0].map(c => c.trim().toLowerCase());
  let iDate = head.findIndex(c => /date|^day$/.test(c));
  const hasHeader = iDate !== -1;
  let iKg = -1, iLb = -1, iW = -1, iUnit = -1, iNote = -1;
  if (hasHeader) {
    head.forEach((c, i) => {
      if (i === iDate) return;
      if (iKg < 0 && /kg|kilo/.test(c)) iKg = i;
      else if (iLb < 0 && /lb|pound/.test(c)) iLb = i;
      else if (iW < 0 && /weight|mass/.test(c)) iW = i;
      else if (iUnit < 0 && /^unit/.test(c)) iUnit = i;
      else if (iNote < 0 && /note|comment|memo/.test(c)) iNote = i;
    });
    if (iKg < 0 && iLb < 0 && iW < 0) return { error: 'Couldn’t find a weight column in that file.' };
  } else {
    [iDate, iW, iNote] = [0, 1, 2]; // no header: assume date, weight, note
  }

  const byDay = new Map();
  let skipped = 0;
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const date = parseDate(r[iDate]);
    let kg = iKg >= 0 ? parseWeight(r[iKg]) : NaN;
    if (!Number.isFinite(kg) && iLb >= 0) kg = parseWeight(r[iLb]) * KG_PER_LB;
    if (!Number.isFinite(kg) && iW >= 0) {
      const v = parseWeight(r[iW]);
      const u = iUnit >= 0 ? String(r[iUnit] || '').trim().toLowerCase() : unit();
      kg = /^(lb|pound)/.test(u) ? v * KG_PER_LB : v;
    }
    if (!date || !Number.isFinite(kg) || kg < MIN_KG || kg > MAX_KG) { skipped++; continue; }
    let note = iNote >= 0 ? String(r[iNote] || '').trim() : '';
    if (/^'[=+\-@]/.test(note)) note = note.slice(1);
    byDay.set(date, { id: newId(), date, kg, note: note.slice(0, 200) });
  }
  if (!byDay.size) return { error: 'Couldn’t read any weigh-ins from that file.' };
  return { entries: [...byDay.values()], skipped };
}

async function importCSV(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast('That file is too big to be a weight backup.');
  const result = parseImport(await file.text());
  if (result.error) return toast(result.error);

  const existing = new Map(state.entries.map(e => [e.date, e]));
  const replaced = result.entries.filter(e => existing.has(e.date)).length;
  let msg = `Import ${result.entries.length} weigh-in${result.entries.length === 1 ? '' : 's'}?`;
  if (replaced) msg += `\n\n${replaced} date${replaced === 1 ? '' : 's'} you already have will be replaced with the file’s values.`;
  if (result.skipped) msg += `\n\n${result.skipped} row${result.skipped === 1 ? '' : 's'} couldn’t be read and will be skipped.`;
  if (!confirm(msg)) return;

  for (const e of result.entries) existing.set(e.date, e);
  state.entries = [...existing.values()].sort(byDate);
  const g = state.settings.goal;
  if (g && g.startKg == null && state.entries.length) g.startKg = latest().kg;
  if (!save()) return;
  renderAll();
  toast(`Imported ${result.entries.length} weigh-in${result.entries.length === 1 ? '' : 's'}`);
  requestPersistentStorage();
}

function wipeAll() {
  if (!confirm('Delete all weigh-ins and settings from this device? This can’t be undone.\n\nExport a CSV first if you might want them later.')) return;
  state = defaultState();
  save();
  renderAll();
  showView('home');
  toast('All data deleted');
}

// ---------- Init ----------

function init() {
  $('#add-btn').addEventListener('click', () => openEntry());
  $('#entry-form').addEventListener('submit', saveEntry);
  $('#entry-cancel').addEventListener('click', () => $('#entry-dialog').close());
  $('#entry-delete').addEventListener('click', deleteEntry);
  $('#entry-dialog').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('#entry-dialog').addEventListener('close', () => { editing = null; });
  $$('.step-btn').forEach(b => b.addEventListener('click', () => stepWeight(Number(b.dataset.step))));

  $$('#range button').forEach(b => b.addEventListener('click', () => {
    state.settings.range = b.dataset.range;
    save();
    hideChartTip();
    renderHome();
  }));
  $$('#unit-seg button').forEach(b => b.addEventListener('click', () => {
    state.settings.unit = b.dataset.unit;
    save();
    renderAll();
  }));

  $('#goal-form').addEventListener('submit', saveGoal);
  $('#goal-clear').addEventListener('click', clearGoal);
  $('#reminder-time').addEventListener('change', e => {
    if (!e.target.value) return;
    state.settings.reminderTime = e.target.value;
    save();
    $('#gcal-link').href = googleCalendarUrl(state.settings.reminderTime);
  });
  // Recompute on click so "next occurrence" is never stale.
  $('#gcal-link').addEventListener('click', e => { e.currentTarget.href = googleCalendarUrl(state.settings.reminderTime); });
  $('#ics-btn').addEventListener('click', downloadICS);

  $('#export-btn').addEventListener('click', exportCSV);
  $('#share-btn').hidden = !canShareFiles();
  $('#share-btn').addEventListener('click', shareCSV);
  $('#import-input').addEventListener('change', importCSV);
  $('#wipe-btn').addEventListener('click', wipeAll);

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstall();
  });
  $('#install-btn').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    renderInstall();
  });

  document.addEventListener('pointerdown', e => { if (!$('#chart').contains(e.target)) hideChartTip(); });

  let chartWidth = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w && w !== chartWidth) { chartWidth = w; renderChart(); }
  }).observe($('#chart'));

  // The date may have rolled over while the app sat in the background.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
  window.addEventListener('hashchange', route);

  renderAll();
  route();
  if (state.entries.length) requestPersistentStorage();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(err => console.error('Service worker failed', err));
  }
}

init();
