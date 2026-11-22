// Budget app UI — ported from the browser version (תקציב אישי 2026.html).
// Data is saved through window.api (local file in the user data folder). No network.
'use strict';
const { num, r2, sumArr, emptyMonth, deriveMonth, clearFlows, yearSummary, recomputeSavings, prevRow, setFundBalance, cumulative, portfolioSeries } = window.BudgetCalc;
const recompute = () => recomputeSavings(S);
const calc = m => window.BudgetCalc.calc(m, S.settings && S.settings.includeFuture);

const MN = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const UNDO_LIMIT = 200;
const COLS = {
  fixed: { t: 'הוצאות קבועות והלוואות', c: '110px 1.3fr 1.2fr 1fr 1fr 1fr 1fr 82px 1fr 28px',
    f: [['kind', 'סוג', 'sel', [['standing', 'הוראת קבע'], ['loan', 'הלוואה']]], ['name', 'שם'], ['desc', 'תיאור'], ['orig', 'סכום מקורי', 'n', '₪'], ['count', 'מס׳ תשלומים', 'n'], ['balance', 'יתרה', 'n', '₪'], ['monthly', 'חיוב חודשי', 'n', '₪'], ['left', 'נותרו', 'calc'], ['day', 'תאריך חיוב']],
    def: () => ({ kind: 'standing', name: '', desc: '', orig: null, count: null, balance: null, monthly: 0, day: '' }) },
  cards: { t: 'כרטיסי אשראי', c: '1.2fr 1fr 1fr 1.6fr 28px',
    f: [['name', 'כרטיס'], ['amount', 'סכום', 'n', '₪'], ['date', 'תאריך'], ['note', 'הערה']],
    def: () => ({ name: '', amount: 0, date: '', note: '' }) },
  transfers: { t: 'העברות והפקדות לשוק ההון', c: '1.2fr 1fr 1fr 1.2fr 1.4fr 28px',
    f: [['name', 'שם'], ['amount', 'סכום', 'n', '₪'], ['date', 'תאריך'], ['cat', 'סוג', 'sel', [['regular', 'הוצאה רגילה'], ['deposit', 'הפקדה לשוק ההון']]], ['note', 'הערה']],
    def: () => ({ name: '', amount: 0, date: '', note: '', cat: 'regular' }) },
  income: { t: 'הכנסות', c: '1.4fr 1.2fr 1fr 1fr 70px 28px',
    f: [['source', 'מקור'], ['type', 'סוג'], ['amount', 'סכום', 'n', '₪'], ['date', 'תאריך'], ['internal', 'העברה פנימית?', 'chk']],
    def: () => ({ source: '', type: '', amount: 0, date: '', internal: false }) },
  future: { t: 'כספים עתידיים (לא נכנסים לחישוב החודשי)', c: '1.3fr 1.3fr 1fr 1.2fr 28px',
    f: [['source', 'מקור'], ['name', 'שם'], ['amount', 'סכום', 'n', '₪'], ['date', 'מועד צפוי']],
    def: () => ({ source: '', name: '', amount: 0, date: '' }) },
  savings: { t: 'חסכונות', c: '1.4fr 1fr 1fr 1fr 1.2fr 1.4fr 28px',
    f: [['name', 'שם'], ['kind', 'סוג', 'sel', [['fund', 'קרן'], ['cash', 'יתרה בבנק']]], ['monthly', 'הפקדה חודשית', 'n', '₪'], ['balance', 'יתרה', 'n', '₪'], ['fee', 'דמי ניהול'], ['note', 'הערה']],
    def: () => ({ name: '', kind: 'fund', monthly: null, balance: 0, gain: 0, open: 0, fee: '', note: '' }) },
  investments: { t: 'השקעות ($)', c: '2fr 1fr 28px',
    f: [['name', 'נכס'], ['usd', 'סכום ב-$', 'n', '$']],
    def: () => ({ name: '', usd: 0, active: true }) }
};
const $ = s => document.querySelector(s);
const fmt = n => { const x = r2(n); return (x === 0 ? 0 : x).toLocaleString('he-IL', { maximumFractionDigits: 2 }); };
const money = n => fmt(n) + ' ₪';
const usd = n => { const x = r2(n); return (x < 0 ? '‎-$' : '$') + fmt(Math.abs(x)); }; // the $ always sits right before the digits
// A number field with its currency sign inside the box, next to the number (the stored value stays a plain number).
const curWrap = (sign, inp) => `<span class="cur" data-cur="${sign}">${inp}</span>`;
const pct = v => (Math.round(v * 10) / 10).toLocaleString('he-IL') + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kpi = (l, v, cls = '', sub = '', id = '') => `<div class="kpi ${cls}"${id ? ` data-kpi="${id}"` : ''}><small>${l}</small><b>${v}</b>${sub ? `<small class="sub">${sub}</small>` : ''}</div>`;

let S = { v: 2, settings: { includeFuture: false }, years: {} };
let ui = { year: 2026, tab: 'summary' };
let prefs = { startLastMonth: false };
let dataDir = '';
let notice = null; // startup message banner
let mirror = null; // cloud (OneDrive) backup folder status
let loaded = false, saveT = null, lastEdit = 0, backups = null;
const UNDO = [], REDO = [];

/* ---------- automatic calculations ("like Excel") ---------- */
// Read-only computed columns.
const CALC_FIELDS = {
  // Loan: payments left = balance / monthly payment, rounded up.
  left: row => {
    if (row.kind !== 'loan' || row.balance == null || row.balance === '' || !(num(row.monthly) > 0)) return '';
    const n = Math.ceil(num(row.balance) / num(row.monthly) - 0.005);
    return n <= 0 ? 'שולמה' : n + ' חודשים';
  }
};
// Loans: when the monthly payment changes, the balance of that month moves by the same difference.
// (Savings are handled by the month-to-month chain in calc.js.)
// Returns the data-k of the balance field that changed (to refresh it on screen), or null.
function linkMonthly(sec, i, row, v) {
  const d = num(v) - num(row.monthly);
  if (!d) return null;
  if (sec === 'fixed' && row.kind === 'loan' && row.balance != null && row.balance !== '') { row.balance = r2(num(row.balance) - d); return `${sec}|${i}|balance`; }
  return null;
}
// Number fields accept simple arithmetic, e.g. "1000+250" or "3*583.33" (evaluated when leaving the field).
function evalExpr(s) {
  s = String(s).replace(/,/g, '').replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[-+*/().\d]+$/.test(s) || !/\d[-+*/]|\)[-+*/(]/.test(s)) return null;
  let p = 0;
  const peek = () => s[p];
  function factor() {
    if (peek() === '-') { p++; return -factor(); }
    if (peek() === '+') { p++; return factor(); }
    if (peek() === '(') { p++; const v = expr(); if (s[p++] !== ')') throw 0; return v; }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(p)); if (!m) throw 0; p += m[0].length; return parseFloat(m[0]);
  }
  function term() { let v = factor(); while (peek() === '*' || peek() === '/') { const o = s[p++], b = factor(); v = o === '*' ? v * b : v / b; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const o = s[p++], b = term(); v = o === '+' ? v + b : v - b; } return v; }
  try { const v = expr(); return p === s.length && isFinite(v) ? r2(v) : null; } catch (_) { return null; }
}

/* ---------- in-app dialogs (replace window.confirm / alert) ---------- */
let dlgResolve = null;
function ask(msg, opts = {}) {
  if (dlgResolve) dlgResolve(false);
  const m = $('#modal'), d = m.querySelector('.dlg');
  $('#dlgMsg').textContent = msg;
  $('#dlgOk').textContent = opts.ok || 'אישור';
  $('#dlgCancel').textContent = opts.cancel || 'ביטול';
  d.classList.toggle('alert', !!opts.alert);
  m.hidden = false;
  setTimeout(() => $('#dlgOk').focus(), 0);
  return new Promise(res => { dlgResolve = res; });
}
const tell = msg => ask(msg, { alert: true, ok: 'סגור' });
function closeDlg(v) { const r = dlgResolve; dlgResolve = null; $('#modal').hidden = true; if (r) r(v); }
$('#dlgOk').addEventListener('click', () => closeDlg(true));
$('#dlgCancel').addEventListener('click', () => closeDlg(false));

/* ---------- data helpers ---------- */
const Y = () => S.years[ui.year];
const curM = () => Y() && typeof ui.tab === 'number' ? Y().months[ui.tab] : null;
const isValid = d => !!d && typeof d === 'object' && !!d.years && typeof d.years === 'object' && !Array.isArray(d.years);

/* ---------- undo / redo ---------- */
function pushUndo(force) {
  const now = Date.now();
  if (force || now - lastEdit > 1500) { UNDO.push(JSON.stringify(S)); if (UNDO.length > UNDO_LIMIT) UNDO.shift(); REDO.length = 0; }
  lastEdit = now; btns();
}
function restore(js) { S = JSON.parse(js); lastEdit = 0; ensureUi(); render(); queueSave(true); btns(); }
function undo() { if (!UNDO.length) return; REDO.push(JSON.stringify(S)); restore(UNDO.pop()); }
function redo() { if (!REDO.length) return; UNDO.push(JSON.stringify(S)); restore(REDO.pop()); }
function btns() { $('#undo').disabled = !UNDO.length; $('#redo').disabled = !REDO.length; }

/* ---------- saving: local file only ---------- */
function setStatus(t, err) { const s = $('#status'); s.textContent = t; s.className = err ? 'err' : ''; }
function queueSave(now) {
  if (!loaded) return;
  clearTimeout(saveT);
  saveT = setTimeout(doSave, now ? 0 : 400);
  setStatus('שומר…');
}
let saving = Promise.resolve();
function doSave() {
  saveT = null;
  const data = JSON.stringify(S);
  saving = saving.then(() => window.api.save(data)).then(r => {
    if (r && r.ok) setStatus((r.note || 'נשמר ✓') + ' ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }));
    else setStatus('⚠ השמירה נכשלה: ' + ((r && r.error) || ''), true);
  }).catch(e => setStatus('⚠ השמירה נכשלה: ' + e.message, true));
  return saving;
}
async function flushSave() { if (saveT) { clearTimeout(saveT); await doSave(); } else await saving; }
window.addEventListener('beforeunload', () => {
  if (saveT) { clearTimeout(saveT); saveT = null; window.api.saveSync(JSON.stringify(S)); }
});

function lastMonthTab() {
  const yr = Y(); if (!yr) return 'summary';
  const ks = Object.keys(yr.months || {}).map(Number).sort((a, b) => a - b);
  return ks.length ? ks[ks.length - 1] : 'summary';
}

async function init() {
  const r = await window.api.load();
  if (r && isValid(r.data)) S = r.data;
  if (!S.settings) S.settings = { includeFuture: false };
  recompute(); // links every month's savings to the month before (stored balances do not change)
  prefs = r.prefs || prefs;
  dataDir = r.dataDir || '';
  ui.year = new Date().getFullYear(); // falls back to the latest year in ensureUi()
  ensureUi();
  if (prefs.startLastMonth) { const ys = Object.keys(S.years).map(Number).sort((a, b) => a - b); if (ys.length) { ui.year = ys[ys.length - 1]; ui.tab = lastMonthTab(); } }
  if (r.ui && S.years[r.ui.year]) { ui.year = r.ui.year; ui.tab = r.ui.tab; } // back from the Google sign-in page
  mirror = r.mirror || null;
  loaded = true;
  applyView();
  render();
  if (r.ui && r.ui.y) scrollTo(0, r.ui.y);
  setStatus(window.__driveOnline && window.__driveOnline() ? 'מחובר ל-Google Drive ✓' : 'עובד מהעותק שבמכשיר');
  window.__onSyncNote = msg => { notice = msg; render(); };
  // Another device saved a newer version: show it (only called when nothing here is waiting to be saved).
  window.__applyRemote = d => {
    if (saveT) return;
    const a = document.activeElement; if (a && a.dataset && a.dataset.k) return; // not while typing
    S = d; if (!S.settings) S.settings = { includeFuture: false };
    recompute(); ensureUi(); UNDO.length = 0; REDO.length = 0; btns(); backups = null;
    const y = scrollY; render(); scrollTo(0, y);
    setStatus('עודכן ממכשיר אחר ✓ ' + new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }));
  };
  if (r.selftest && window.__runSelftest) window.__runSelftest(r.selftest);
  if (r.message) { notice = r.message; render(); setStatus('⚠ בוצע שחזור מגיבוי', true); await tell(r.message); }
  if (r.info) await tell(r.info);
}
// Display: 'auto' (by screen width), 'pc' (full table layout, also on a phone) or 'phone' (cards, also on a PC).
const narrow = window.matchMedia('(max-width: 760px)');
function applyView() {
  const v = prefs.view || 'auto';
  const vp = document.querySelector('meta[name=viewport]');
  if (vp) vp.content = v === 'pc' ? 'width=1200' : 'width=device-width, initial-scale=1, viewport-fit=cover';
  document.body.classList.toggle('mob', v === 'phone' || (v === 'auto' && narrow.matches));
}
narrow.addEventListener('change', () => { if ((prefs.view || 'auto') === 'auto') applyView(); });
function ensureUi() {
  const ys = Object.keys(S.years).map(Number).sort((a, b) => a - b);
  if (!ys.length) { ui.year = new Date().getFullYear(); return; }
  if (!S.years[ui.year]) ui.year = ys[ys.length - 1];
}

/* ---------- rendering ---------- */
function cell(sec, i, f, v, row) {
  const k = `${sec}|${i}|${f[0]}`, lab = f[1], type = f[2];
  let inp;
  if (type === 'sel') inp = `<select data-k="${k}">${f[3].map(o => `<option value="${o[0]}"${v === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  else if (type === 'calc') inp = `<span class="calc" data-calc="${k}" title="מחושב אוטומטית"></span>`;
  else if (type === 'chk') inp = `<input type="checkbox" data-k="${k}"${v ? ' checked' : ''} title="סמן אם זו העברה מחשבון אחר (למשל Blink) ולא הכנסה אמיתית">`;
  else if (type === 'n') {
    inp = `<input inputmode="decimal" class="num" data-k="${k}" data-n="1" placeholder=" " value="${v == null || v === '' ? '' : esc(v)}">`;
    if (f[3]) inp = curWrap(f[3], inp);
  }
  else inp = `<input data-k="${k}" value="${esc(v)}">`;
  return `<div data-l="${lab}">${inp}</div>`;
}
function section(sec, m) {
  const c = COLS[sec], rows = m[sec] || [];
  let h = `<section class="box" data-sec="${sec}"><div class="bh"><h3>${c.t}</h3><span class="tot" data-tot="${sec}"></span></div>`;
  if (sec === 'investments') h += `<div class="det" style="margin-bottom:8px"><span class="muted" id="upd30">עודכן ב-30 לחודש</span></div>`;
  h += `<div class="hd" style="--c:${c.c}">${c.f.map(f => `<div>${f[1]}</div>`).join('')}<div></div></div>`;
  rows.forEach((r, i) => { h += `<div class="r" style="--c:${c.c}">${c.f.map(f => cell(sec, i, f, r[f[0]], r)).join('')}<button class="del" title="מחק שורה" data-del="${sec}|${i}">✕</button></div>`; });
  h += `<button class="add" data-add="${sec}">＋ הוסף שורה</button></section>`;
  return h;
}
function monthSummary(m, c) {
  c = c || calc(m);
  let h = '';
  if (c.remainExt < 0) h += `<div class="banner bad">החודש במינוס: ${money(c.remainExt)} אחרי הפקדות לשוק ההון</div>`;
  else if (c.netExt < 0) h += `<div class="banner warn">ההוצאות גבוהות מההכנסות ב-${money(-c.netExt)}</div>`;
  const incSub = c.internal ? `לא כולל העברה פנימית ${money(c.internal)}` : '';
  const depSub = `אחרי הפקדה ${money(c.depNet)}` + (c.internal && c.deposits ? ` (${money(c.deposits)} פחות העברה פנימית)` : '');
  h += `<div class="kpis k8">${kpi('הכנסות', money(c.incomeExt), '', incSub, 'income')}${kpi('הוצאות', money(c.totalExp), '', `קבועות ${money(c.fixed)} · אשראי ${money(c.cards)} · העברות ${money(c.trReg)}`, 'totalExp')}${kpi('נשאר בנטו', money(c.netExt), c.netExt < 0 ? 'neg' : 'pos', '', 'net')}${kpi('נשאר בפועל', money(c.remainExt), c.remainExt < 0 ? 'neg' : 'pos', depSub, 'remain')}${kpi('שווי תיק', money(c.portILS), '', usd(c.usdT), 'portILS')}${kpi('חובות', money(c.debts), '', '', 'debts')}${kpi('חסכונות', money(c.savings), '', '', 'savings')}${kpi('הון עצמי', money(c.equity), 'pos', S.settings.includeFuture ? 'כולל כספים עתידיים' : c.futureInEquity ? 'חסכונות + השקעות נטו + פיקדון' : 'חסכונות + השקעות נטו', 'equity')}</div>`;
  return h;
}
function renderMonth(k) {
  const m = Y().months[k];
  if (!m) {
    const prev = Y().months[k - 1];
    return `<section class="box"><h3>${MN[k - 1]} ${ui.year} – עדיין לא נפתח</h3>
      <p class="muted">${prev ? `פתיחה מעתיקה מ${MN[k - 2]}: הוצאות קבועות, הכנסות, השקעות וחסכונות. יתרות ההלוואות יורדות בתשלום החודשי, והחסכונות גדלים בהפקדה החודשית. סכומי הכרטיסים וההכנסות מתאפסים (השמות נשמרים), העברות והעברות פנימיות נמחקות.` : 'חודש ריק חדש.'}</p>
      <button class="pri" data-open="${k}">פתח את ${MN[k - 1]}</button></section>`;
  }
  let h = `<div class="top"><h2>${MN[k - 1]} ${ui.year}</h2>
    <div class="det">
      <label>תקופה<input data-k="period" value="${esc(m.period)}"></label>
      <label>שער דולר (₪)${curWrap('₪', `<input class="num" data-k="rate" data-n="1" inputmode="decimal" placeholder=" " value="${m.rate == null ? '' : esc(m.rate)}">`)}</label>
      <button class="sm" data-reset="${k}" title="מאפס כרטיסים, העברות והכנסות. קבועות, חסכונות והשקעות נשארים">↺ אפס חודש</button>
    </div></div>`;
  h += `<div id="sum">${monthSummary(m)}</div>`;
  h += section('fixed', m);
  h += `<div class="two">${section('cards', m)}${section('transfers', m)}</div>`;
  h += `<div class="two">${section('income', m)}${section('future', m)}</div>`;
  h += section('savings', m);
  h += section('investments', m);
  return h;
}
function renderYear() {
  const yr = Y();
  if (!yr) return '<section class="box"><p>אין עדיין שנה פתוחה.</p></section>';
  const y = yearSummary(yr, S.settings.includeFuture);
  if (y.empty) return '<section class="box"><p>עדיין אין חודשים עם נתונים בשנה זו.</p></section>';
  const { act, tInc, tExp, tNet, tDep, depUsd, open, gainUsd, first, e0, e1 } = y;
  let h = `<div class="kpis">
    ${kpi('נשאר השנה אחרי הוצאות', money(tNet), tNet < 0 ? 'neg' : 'pos', `${pct(tInc ? tNet / tInc * 100 : 0)} מההכנסות · לא כולל העברות פנימיות`, 'y-net')}
    ${kpi('הפקדתי לשוק ההון', money(tDep), '', `≈ ${usd(depUsd)}`, 'y-dep')}
    ${(() => {
      // Same number as the portfolio chart: Interactive, real deposits in dollars, up to the last month that has ended.
      // Only without an opening value (or before any month has ended) it falls back to the rough estimate.
      const p = portfolioSeries(yr, ui.year, new Date());
      if (p.gainReal != null) return kpi('רווח מהשוק (בדולרים)', usd(p.gainReal), p.gainReal < 0 ? 'neg' : 'pos', `${pct(p.pctReal || 0)} · אינטראקטיב, עד ${MN[p.lastReal.k - 1]}`, 'y-gain');
      return kpi('רווח מהשוק (בדולרים)', usd(gainUsd), gainUsd < 0 ? 'neg' : 'pos', (open + depUsd > 0 ? pct(gainUsd / (open + depUsd) * 100) : '') + (y.openGiven ? '' : ' · הערכה (לא הוזן שווי פתיחה)'), 'y-gain');
    })()}
    ${kpi('הון עצמי היום', money(e1), 'pos', act.length > 1 ? (e1 >= e0 ? 'עלייה של ' : 'ירידה של ') + money(Math.abs(e1 - e0)) + ' מ' + MN[first.k - 1] : '', 'y-equity')}
  </div>`;
  h += `<section class="box"><div class="bh"><h3>חודש אחרי חודש</h3><span class="muted">לפני הפקדה לשוק ההון · לא כולל העברות פנימיות</span></div><div class="scroll"><table id="ytable">
    <thead><tr><th>חודש</th><th>הכנסות</th><th>הוצאות</th><th>נשאר</th><th>%</th><th style="width:20%"></th><th>הון עצמי</th></tr></thead><tbody>`;
  act.forEach(x => {
    const p = x.inc > 0 ? x.net / x.inc * 100 : 0;
    h += `<tr><td><a href="#" data-tab="${x.k}" style="color:var(--pri)">${MN[x.k - 1]}</a></td><td>${money(x.inc)}</td><td>${money(x.c.totalExp)}</td><td class="${x.net < 0 ? 'neg' : 'pos'}"><b>${money(x.net)}</b></td><td>${pct(p)}</td><td><div class="pbar"><i class="${p < 0 ? 'bad' : ''}" style="width:${Math.min(100, Math.abs(p))}%"></i></div></td><td>${money(x.c.equity)}</td></tr>`;
  });
  h += `<tr class="tot"><td>סה״כ ${act.length} חודשים</td><td>${money(tInc)}</td><td>${money(tExp)}</td><td class="${tNet < 0 ? 'neg' : 'pos'}">${money(tNet)}</td><td>${pct(tInc ? tNet / tInc * 100 : 0)}</td><td></td><td></td></tr></tbody></table></div></section>`;

  const vals = act.map(x => x.c.equity), W = 760, H = 200, pad = 44, lo = Math.min(...vals), hi = Math.max(...vals), rng = (hi - lo) || 1, n = act.length;
  const xs = i => n === 1 ? W / 2 : pad + i * (W - 2 * pad) / (n - 1), ys = v => H - 28 - ((v - lo) / rng) * (H - 60);
  h += `<section class="box"><div class="bh"><h3>הון עצמי לאורך השנה</h3><span class="muted">${S.settings.includeFuture ? 'כולל כספים עתידיים' : 'חסכונות + השקעות נטו'}</span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:240px">
    <polyline fill="none" stroke="var(--pri)" stroke-width="2.5" points="${vals.map((v, i) => xs(i) + ',' + ys(v)).join(' ')}"/>
    ${vals.map((v, i) => `<circle cx="${xs(i)}" cy="${ys(v)}" r="3.5" fill="var(--pri)"><title>${MN[act[i].k - 1]}: ${money(v)}</title></circle><text x="${xs(i)}" y="${H - 8}" text-anchor="middle">${MN[act[i].k - 1].slice(0, 3)}</text>`).join('')}
    <text x="${xs(0)}" y="${ys(vals[0]) - 8}" text-anchor="middle">${money(vals[0])}</text>
    ${n > 1 ? `<text x="${xs(n - 1)}" y="${ys(vals[n - 1]) - 8}" text-anchor="middle">${money(vals[n - 1])}</text>` : ''}</svg></section>`;
  h += renderPortfolio(yr);

  h += `<section class="box"><div class="bh"><h3>הנחות לתיק השוק</h3></div>
    <div class="det"><label>שווי התיק בתחילת השנה ($)${curWrap('$', `<input class="num" data-k="y:openUsd" data-n="1" inputmode="decimal" value="${yr.openUsd == null ? '' : esc(yr.openUsd)}" placeholder="לא הוזן – הערכה">`)}</label></div>
    <p class="muted">הרווח = שינוי השווי פחות ההפקדות (בדולרים). ${y.openGiven ? '' : 'לא הוזן שווי פתיחה, לכן הרווח הוא הערכה.'}</p></section>`;
  return h;
}
// Interactive portfolio: value per month (with what was put in), and the return of each month.
function renderPortfolio(yr) {
  const p = portfolioSeries(yr, ui.year, new Date());
  const R = p.rows;
  if (!R.length) return '';
  const I = s => '⁦' + s + '⁩'; // keeps "-$1,234" and "+5%" in order inside right-to-left text
  const sp = v => I((v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + '%');
  const k$ = v => I('$' + Math.round(v / 1000) + 'K');
  const MS = k => MN[k - 1].slice(0, 3);
  const anyEst = R.some(r => r.est), lr = p.lastReal;
  let h = `<section class="box" data-sec="portfolio"><div class="bh"><h3>תיק אינטראקטיב לאורך השנה</h3><span class="muted">שווי בדולרים${anyEst ? ' · ' + R.filter(r => r.est).map(r => MN[r.k - 1]).join('–') + ' הערכה' : ''}</span></div>
    <div class="kpis">
      ${kpi(lr ? `שווי עכשיו (${MN[lr.k - 1]})` : 'שווי עכשיו', lr ? usd(lr.usd) : '—', '', 'לפי מה שרשום בחודש', 'p-now')}
      ${kpi('שווי בתחילת השנה', p.open == null ? '—' : usd(p.open), '', p.open == null ? 'לא הוזן' : '', 'p-open')}
      ${kpi('הפקדתי השנה', usd(p.depAll), '', `${R.filter(r => r.dep).length} חודשים עם הפקדה`, 'p-dep')}
      ${kpi('תשואה מתחילת השנה', p.gainReal == null ? '—' : I(usd(p.gainReal)), p.gainReal == null ? '' : p.gainReal < 0 ? 'neg' : 'pos', p.pctReal == null ? '' : sp(p.pctReal) + (lr ? ' · עד ' + MN[lr.k - 1] : ''), 'p-gain')}
    </div>`;
  // value line + "what I put in" line (start of year + deposits so far)
  const W = 760, H = 210, pad = 44, n = R.length;
  let cum = p.open == null ? null : p.open;
  const put = R.map(r => cum == null ? null : (cum += r.dep));
  const all = R.map(r => r.usd).concat(put.filter(v => v != null));
  const lo = Math.min(...all), hi = Math.max(...all), rng = (hi - lo) || 1;
  const xs = i => n === 1 ? W / 2 : pad + i * (W - 2 * pad) / (n - 1), ys = v => H - 30 - ((v - lo) / rng) * (H - 62);
  const firstEst = R.findIndex(r => r.est), solidEnd = firstEst < 0 ? n : firstEst;
  const pts = (a, b) => R.slice(a, b).map((r, j) => xs(a + j) + ',' + ys(r.usd)).join(' ');
  h += `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:250px" data-chart="p-value">
    ${put[0] != null ? `<polyline fill="none" stroke="var(--mut)" stroke-width="1.5" stroke-dasharray="5 4" points="${put.map((v, i) => xs(i) + ',' + ys(v)).join(' ')}"/>` : ''}
    <polyline fill="none" stroke="var(--pri)" stroke-width="2.5" points="${pts(0, solidEnd)}"/>
    ${firstEst > 0 ? `<polyline fill="none" stroke="var(--pri)" stroke-width="2.5" stroke-dasharray="3 5" points="${pts(firstEst - 1, n)}"/>` : ''}
    ${R.map((r, i) => `<circle cx="${xs(i)}" cy="${ys(r.usd)}" r="3.5" fill="${r.est ? 'var(--card)' : 'var(--pri)'}" stroke="var(--pri)" stroke-width="1.5"><title>${MN[r.k - 1]}: ${usd(r.usd)}${r.est ? ' (הערכה)' : ''}</title></circle><text x="${xs(i)}" y="${ys(r.usd) - 9}" text-anchor="middle">${k$(r.usd)}</text><text x="${xs(i)}" y="${H - 8}" text-anchor="middle">${MS(r.k)}</text>`).join('')}
  </svg>
  <div class="muted legend"><span style="--c:var(--pri)">שווי התיק</span>${put[0] != null ? '<span class="dash">כמה הפקדתי (תחילת שנה + הפקדות)</span>' : ''}</div>`;
  // monthly return bars
  const G = R.filter(r => r.gain != null);
  if (G.length) {
    const H2 = 220, mx = Math.max(...G.map(r => Math.abs(r.gain)), 1) * 1.25, z = H2 / 2 - 6, ysz = v => z - v / mx * (H2 / 2 - 40);
    h += `<div class="bh" style="margin-top:14px"><h3>תשואה בכל חודש</h3><span class="muted">שינוי השווי פחות ההפקדות של החודש</span></div>
    <svg viewBox="0 0 ${W} ${H2}" width="100%" style="max-height:260px" data-chart="p-return">
      <line x1="${pad - 20}" x2="${W - pad + 20}" y1="${z}" y2="${z}" stroke="var(--line)"/>
      ${R.map((r, i) => {
        if (r.gain == null) return `<text x="${xs(i)}" y="${H2 - 6}" text-anchor="middle">${MS(r.k)}</text>`;
        const c = r.gain >= 0 ? 'var(--ok)' : 'var(--bad)', yy = ysz(r.gain), top = Math.min(yy, z), hh = Math.max(2, Math.abs(yy - z));
        const ty = r.gain >= 0 ? top - 16 : top + hh + 12;
        return `<rect x="${xs(i) - 14}" y="${top}" width="28" height="${hh}" rx="3" fill="${c}"${r.est ? ` fill-opacity=".35" stroke="${c}" stroke-dasharray="3 2"` : ''}><title>${MN[r.k - 1]}: ${usd(r.gain)}${r.est ? ' (הערכה)' : ''}</title></rect>
        <text x="${xs(i)}" y="${ty}" text-anchor="middle" style="fill:${c};font-weight:700">${I(usd(r.gain))}</text><text x="${xs(i)}" y="${ty + 12}" text-anchor="middle">${r.pct == null ? '' : sp(r.pct)}</text>
        <text x="${xs(i)}" y="${H2 - 6}" text-anchor="middle">${MS(r.k)}</text>`;
      }).join('')}
    </svg>`;
  }
  return h + '</section>';
}
function fmtSize(b) { return b < 1024 ? b + ' B' : (b / 1024).toLocaleString('he-IL', { maximumFractionDigits: 1 }) + ' KB'; }
function renderBackups() {
  if (!backups) return '<p class="muted">טוען…</p>';
  if (!backups.length) return '<p class="muted">אין עדיין גיבויים.</p>';
  return `<div class="bklist"><table><tbody>${backups.map(b => `<tr><td>${new Date(b.mtime).toLocaleString('he-IL')}</td><td class="nm">${esc(b.name)}</td><td>${fmtSize(b.size)}</td><td><button class="sm" data-restore="${esc(b.name)}">שחזר</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderMirror() {
  const m = mirror || {};
  const t = x => x ? new Date(x).toLocaleString('he-IL') : 'עדיין לא';
  let h = `<h3>☁ סנכרון וגיבוי</h3>
    <p class="muted">כל שינוי נשמר במכשיר וב-Google Drive, בתיקייה "תקציב שנתי". המחשב והטלפון עובדים על אותם נתונים, ושינוי במכשיר אחד מופיע בשני תוך כחצי דקה. בתיקיית "גיבויים" נשמר קובץ אחד לכל יום, וקובץ נוסף לפני ייבוא, שחזור או עדכון חודשי ובכל התנגשות בין מכשירים. הסדר נשמר לבד: נשארים כל הימים של השבועיים האחרונים, גיבוי אחד מכל חודש שעבר (לתמיד), והגיבויים המיוחדים של 3 החודשים האחרונים. השאר עובר לסל של Drive, ואפשר לשחזר אותו משם במשך 30 יום.</p>
    <p class="${m.ok === false ? 'neg' : 'muted'}" data-mirror-state="${m.ok === false ? 'error' : 'ok'}">${m.ok === false ? '⚠ ' + esc(m.error) : 'סנכרון אחרון: ' + esc(t(m.time))}</p>
    <div class="row"><button class="pri" id="mirNow">☁ גבה וסנכרן עכשיו</button><button class="ghost" id="mirOpen">📂 פתח את התיקייה ב-Drive</button></div>`;
  if (m.localSupported) h += m.localName
    ? `<p class="muted">גיבוי נוסף לתיקייה במחשב: <code>${esc(m.localName)}</code> (גיבוי אחרון: ${esc(t(m.localTime))}). שם נשמר גם <code>budget-latest.json</code> שתמיד מעודכן.</p>
       <div class="row"><button class="ghost" id="mirChoose">חבר מחדש / גבה לשם עכשיו</button><button class="ghost" id="mirOff">הפסק לגבות לתיקייה</button></div>`
    : `<p class="muted">אפשר לשמור כל גיבוי גם בתיקייה במחשב הזה, למשל תיקיית הגיבויים ב-OneDrive.</p><div class="row"><button class="ghost" id="mirChoose">בחר תיקייה במחשב…</button></div>`;
  return h;
}
async function mirrorAction(fn) {
  const r = await fn();
  if (!r || r.canceled) return;
  mirror = r;
  const box = $('#mirrorBox'); if (box) box.innerHTML = renderMirror();
  if (r.error && !r.dir) tell(r.error);
  else if (r.error) tell(r.error);
  else if (r.dir && r.ok === false) tell('הגיבוי לענן נכשל: ' + r.error);
  else if (r.dir && r.ok) setStatus('גיבוי לענן נשמר ✓ ' + new Date(r.time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }));
  else setStatus('הגיבוי לענן כובה');
  backups = null; if (ui.tab === 'settings') refreshBackups();
}
function renderSettings() {
  const ys = Object.keys(S.years).sort();
  return `<section class="box set"><h3>שמירה וגיבוי</h3>
    <p class="muted">הנתונים נשמרים אוטומטית בכל שינוי: במכשיר (לעבודה בלי אינטרנט) וב-Google Drive. בלי חיבור, השינויים ממתינים וימשיכו להישמר כשיחזור החיבור.</p>
    <div class="row"><button class="pri" id="exportBk">⬇ ייצוא גיבוי לקובץ…</button><button class="ghost" data-copy="1">📋 העתק גיבוי (טקסט)</button></div>
    <textarea id="bkout" readonly placeholder="לחץ על ״העתק גיבוי״ כדי לקבל את כל הנתונים כטקסט"></textarea>
  </section>
  <section class="box set" id="mirrorBox">${renderMirror()}</section>
  <section class="box set"><h3>ייבוא מגיבוי</h3>
    <p class="muted">לייבא קובץ גיבוי JSON (מכפתור ״⬇ גיבוי״ או מ״ייצוא גיבוי לקובץ״), או טקסט שהעתקת מכפתור ״העתק גיבוי״. הייבוא מחליף את הנתונים הנוכחיים, ואפשר לבטל אותו עם ↶. לפני הייבוא נשמר עותק של המצב הנוכחי בתיקיית הגיבויים.</p>
    <div class="row"><button class="pri" id="impfile">⬆ ייבוא מקובץ JSON…</button></div>
    <textarea id="impt" placeholder="או הדבק כאן את הטקסט של הגיבוי"></textarea>
    <div><button class="ghost" id="impgo">שחזר מהטקסט</button></div>
  </section>
  <section class="box set"><h3>שחזור מגיבוי אוטומטי</h3>
    <p class="muted">60 הגיבויים האחרונים מתיקיית "גיבויים" ב-Drive, מהחדש לישן.</p>
    <div id="bklist">${renderBackups()}</div>
    <div><button class="ghost" id="bkrefresh">↻ רענן רשימה</button></div>
  </section>
  <section class="box set"><h3>הגדרות</h3>
    <label class="chk">תצוגה: <select id="viewMode">${[['auto', 'אוטומטית (לפי גודל המסך)'], ['pc', 'תצוגת מחשב'], ['phone', 'תצוגת טלפון']].map(o => `<option value="${o[0]}"${(prefs.view || 'auto') === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>
    <p class="muted" id="updInfo">${(() => { const u = Array.isArray(S.updates) && S.updates.length ? S.updates[S.updates.length - 1] : null; return u ? `עדכון נתונים אחרון: מספר ${u.n}, ${esc(u.date)}${u.note ? ' · ' + esc(u.note) : ''}` : 'עדיין לא בוצע עדכון נתונים ממוספר.'; })()}</p>
    <label class="chk"><input type="checkbox" id="incf" ${S.settings.includeFuture ? 'checked' : ''}> כלול כספים עתידיים (פיקדון שחרור, מענקים צפויים) בחישוב ההון העצמי</label>
    <label class="chk"><input type="checkbox" id="startLast" ${prefs.startLastMonth ? 'checked' : ''}> פתח את האפליקציה בחודש האחרון (במקום בסיכום השנתי)</label>
    <div><button class="ghost" id="newyr">＋ פתח שנה חדשה (מועתקת מהאחרונה)</button></div>
    <p class="muted">שנים קיימות: ${ys.length ? ys.join(', ') : 'אין'}</p>
  </section>`;
}
function emptyView() {
  return `<section class="box"><h3>אין עדיין נתונים</h3>
    <p>כדי להעביר נתונים מגיבוי: עבור להגדרות ← ייבוא מגיבוי.</p>
    <div class="row"><button class="pri" data-tab="settings">עבור להגדרות</button><button class="ghost" id="newyr0">פתח שנה ריקה</button></div></section>`;
}
// "עדכון #N · date": the last entry of S.updates, written by the monthly data update (tools/update).
function showUpdate() {
  const el = $('#upd'); if (!el) return;
  const u = loaded && Array.isArray(S.updates) && S.updates.length ? S.updates[S.updates.length - 1] : null;
  el.textContent = u ? `עדכון #${u.n} · ${u.date}` : '';
  el.hidden = !u;
}
function render() {
  renderNav();
  showUpdate();
  const main = $('#main');
  if (!loaded) { main.innerHTML = '<section class="box">טוען…</section>'; return; }
  const nb = notice ? `<div class="banner bad" id="notice">${esc(notice)} <button class="sm" id="noticeX">הבנתי</button></div>` : '';
  if (!Object.keys(S.years).length && ui.tab !== 'settings') { main.innerHTML = nb + emptyView(); return; }
  if (ui.tab === 'summary') main.innerHTML = nb + renderYear();
  else if (ui.tab === 'settings') { main.innerHTML = nb + renderSettings(); if (!backups) refreshBackups(); }
  else main.innerHTML = nb + renderMonth(ui.tab);
  updateTotals();
  btns();
}
function renderNav() {
  let h = `<button class="${ui.tab === 'summary' ? 'on' : ''}" data-tab="summary">📊 סיכום שנתי</button>`;
  for (let k = 1; k <= 12; k++) { const has = !!(Y() && Y().months[k]); h += `<button class="${ui.tab === k ? 'on' : ''}" data-tab="${k}">${MN[k - 1]}${has ? '' : ' ∅'}</button>`; }
  h += `<button class="${ui.tab === 'settings' ? 'on' : ''}" data-tab="settings">⚙ הגדרות</button>`;
  $('#nav').innerHTML = h;
  $('#yr').innerHTML = Object.keys(S.years).sort().map(y => `<option value="${y}"${+y === ui.year ? ' selected' : ''}>${y}</option>`).join('');
}
function updateTotals() {
  const m = curM();
  if (!m) return;
  const c = calc(m);
  const vals = { fixed: c.fixed, cards: c.cards, transfers: c.trReg, income: c.incomeExt, future: c.future, savings: c.savings, investments: c.usdT };
  document.querySelectorAll('[data-tot]').forEach(e => {
    const k = e.dataset.tot;
    if (!(k in vals)) return;
    let t = 'סה״כ: ' + (k === 'investments' ? usd(vals[k]) : money(vals[k]));
    if (k === 'income' && c.internal) t += ` (+ העברה פנימית ${money(c.internal)})`;
    if (k === 'transfers' && c.deposits) t += ` · הפקדות ${money(c.deposits)}` + (num(m.rate) ? ` (≈ ${usd(c.deposits / num(m.rate))})` : '');
    if (k === 'savings') t += ` · הפקדה חודשית: ${money(sumArr((m.savings || []).filter(s => s.kind !== 'cash'), x => x.monthly))}`;
    if (k === 'fixed' && c.debts) t += ` · יתרת הלוואות: ${money(c.debts)}`;
    e.textContent = t;
  });
  document.querySelectorAll('[data-calc]').forEach(e => {
    const [sec, i, f] = e.dataset.calc.split('|');
    const row = (m[sec] || [])[+i];
    e.textContent = row ? CALC_FIELDS[f](row, m, +i) : '';
  });
  const s = $('#sum'); if (s) s.innerHTML = monthSummary(m, c);
}
async function refreshBackups() {
  backups = await window.api.listBackups();
  const el = $('#bklist'); if (el) el.innerHTML = renderBackups();
}

/* ---------- editing ---------- */
// Applies the field's value to the data. Returns the data-k of a linked field that also changed.
function applyEdit(el) {
  const k = el.dataset.k;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.dataset.n) v = el.value.trim() === '' ? null : num(el.value);
  else v = el.value;
  if (k.startsWith('y:')) { Y()[k.slice(2)] = v; return null; }
  const m = curM(); if (!m) return null;
  let linked = null;
  if (k.includes('|')) {
    const [sec, i, f] = k.split('|'); const row = m[sec][+i];
    if (sec === 'savings') {
      // month-to-month chain: this month and all later months follow
      if (f === 'balance' && row.kind !== 'cash') {
        // a typed balance (e.g. from the fund's statement) is kept; an emptied field goes back to "previous + deposit"
        if (v == null) { row.gain = 0; recompute(); } else setFundBalance(S, ui.year, ui.tab, +i, v);
      } else if (f === 'balance') {
        // bank: a typed balance is kept; an emptied field goes back to automatic
        if (v == null) row.manual = false; else { row.manual = true; row.balance = v; }
        recompute();
      } else { row[f] = v; recompute(); }
      linked = 'savings';
    } else {
      if (f === 'monthly') linked = linkMonthly(sec, +i, row, v);
      row[f] = v;
      recompute(); // income / expenses change the automatic bank balance
    }
  } else { m[k] = v; recompute(); }
  return linked;
}
function refreshField(k) {
  if (!k) return;
  if (k === 'savings') { // all savings balances / gains of this month (except the one being typed in)
    (curM().savings || []).forEach((s, i) => ['balance'].forEach(f => {
      const el = document.querySelector(`[data-k="savings|${i}|${f}"]`);
      if (!el || el === document.activeElement) return;
      const v = s[f] == null ? '' : String(s[f]);
      if (el.value !== v) { el.value = v; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }));
    return;
  }
  const el = document.querySelector(`[data-k="${k}"]`);
  if (!el || el === document.activeElement) return;
  const [sec, i, f] = k.split('|'); const v = curM()[sec][+i][f];
  el.value = v == null ? '' : v;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset || !el.dataset.k || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  pushUndo();
  const linked = applyEdit(el);
  refreshField(linked);
  if (linked !== 'savings') refreshField('savings');
  updateTotals();
  queueSave();
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'yr') { ui.year = +el.value; render(); return; }
  if (el.id === 'incf') { pushUndo(true); S.settings.includeFuture = el.checked; render(); queueSave(true); return; }
  if (el.id === 'viewMode') { window.api.setPrefs({ view: el.value }).then(p => { prefs = p; applyView(); render(); setStatus('התצוגה עודכנה ✓'); }); return; }
  if (el.id === 'startLast') { window.api.setPrefs({ startLastMonth: el.checked }).then(p => { prefs = p; setStatus('ההגדרה נשמרה ✓'); }); return; }
  if (!el.dataset || !el.dataset.k) return;
  if (el.tagName === 'SELECT' || el.type === 'checkbox') { pushUndo(true); applyEdit(el); render(); queueSave(true); }
  else {
    if (el.dataset.n) { const x = evalExpr(el.value); if (x != null) el.value = String(x); }
    applyEdit(el); render(); queueSave(true);
  }
});
document.addEventListener('keydown', e => {
  if (!$('#modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDlg(false); }
    else if (e.key === 'Enter') { e.preventDefault(); closeDlg(true); }
    else if (e.ctrlKey || e.metaKey) e.preventDefault();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((k === 'z' || e.code === 'KeyZ') && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || e.code === 'KeyY' || ((k === 'z' || e.code === 'KeyZ') && e.shiftKey)) { e.preventDefault(); redo(); }
});

function rowLabel(r) { return r && (r.name || r.source) ? ' "' + (r.name || r.source) + '"' : ''; }
document.addEventListener('click', async e => {
  const t = e.target.closest('button,a');
  if (!t || t.closest('#modal')) return;
  if (t.id === 'undo') { undo(); return; }
  if (t.id === 'redo') { redo(); return; }
  if (t.id === 'noticeX') { notice = null; render(); return; }
  if (t.id === 'newyr0') { newYear(true); return; }
  if (t.id === 'newyr') { newYear(false); return; }
  if (t.id === 'impgo') { importText($('#impt').value, 'הטקסט שהודבק'); return; }
  if (t.id === 'impfile') { importFile(); return; }
  if (t.id === 'exportBk' || t.id === 'hdrExport') { exportBackup(); return; }
  if (t.id === 'openDir') { const r = await window.api.openDataFolder(); if (!r.ok) tell('לא ניתן לפתוח את התיקייה: ' + (r.error || r.path)); return; }
  if (t.id === 'bkrefresh') { refreshBackups(); return; }
  if (t.id === 'mirNow') { await flushSave(); mirrorAction(window.api.mirrorNow); return; }
  if (t.id === 'mirChoose') { await flushSave(); mirrorAction(window.api.mirrorChoose); return; }
  if (t.id === 'mirDefault') { await flushSave(); mirrorAction(window.api.mirrorDefault); return; }
  if (t.id === 'mirOff') { if (await ask('לכבות את הגיבוי האוטומטי לענן? הגיבויים שכבר נשמרו שם לא יימחקו.', { ok: 'כבה' })) mirrorAction(window.api.mirrorOff); return; }
  if (t.id === 'mirOpen') { const r = await window.api.openMirror(); if (!r.ok) tell('לא ניתן לפתוח את התיקייה: ' + (r.error || '')); return; }
  if (t.dataset.restore) { restoreBackup(t.dataset.restore); return; }
  if (t.dataset.copy) { copyBackup(); return; }
  if (t.tagName === 'A') e.preventDefault();
  if (t.dataset.tab !== undefined) { ui.tab = /^\d+$/.test(t.dataset.tab) ? +t.dataset.tab : t.dataset.tab; render(); scrollTo(0, 0); return; }
  if (t.dataset.open) {
    const k = +t.dataset.open, prev = Y().months[k - 1];
    pushUndo(true);
    Y().months[k] = prev ? deriveMonth(prev) : emptyMonth();
    recompute();
    queueSave(true); render(); return;
  }
  if (t.dataset.add) {
    const m = curM(); if (!m) return;
    pushUndo(true);
    m[t.dataset.add] = m[t.dataset.add] || [];
    m[t.dataset.add].push(COLS[t.dataset.add].def());
    recompute();
    queueSave(true); render(); return;
  }
  if (t.dataset.del) {
    const m = curM(); if (!m) return;
    const [sec, i] = t.dataset.del.split('|');
    const r = m[sec][+i];
    if (await ask('למחוק את השורה' + rowLabel(r) + '?', { ok: 'מחק' })) {
      if (curM() !== m || m[sec][+i] !== r) return; // the data changed while the dialog was open
      pushUndo(true); m[sec].splice(+i, 1); recompute(); queueSave(true); render();
    }
    return;
  }
  if (t.dataset.reset) {
    const k = +t.dataset.reset;
    if (await ask('לאפס את ' + MN[k - 1] + '? מתאפסים כרטיסים, העברות והכנסות. קבועות, חסכונות והשקעות נשארים. אפשר לבטל עם ↶.', { ok: 'אפס' })) {
      pushUndo(true); clearFlows(Y().months[k]); recompute(); queueSave(true); render();
    }
  }
});

async function newYear(empty) {
  const ys = Object.keys(S.years).map(Number);
  const ny = ys.length ? Math.max(...ys) + 1 : new Date().getFullYear();
  let base = null;
  if (ys.length) { const last = S.years[Math.max(...ys)]; for (let k = 12; k >= 1; k--) if (last.months[k]) { base = last.months[k]; break; } }
  if (!(await ask('לפתוח את ' + ny + '?' + (!empty && base ? ' ינואר יועתק מהחודש האחרון של השנה הקודמת.' : ''), { ok: 'פתח' }))) return;
  pushUndo(true);
  S.years[ny] = { months: { 1: (!empty && base) ? deriveMonth(base) : emptyMonth() } };
  recompute();
  ui.year = ny; ui.tab = 1;
  queueSave(true); render();
}
function copyBackup() {
  const txt = JSON.stringify(S);
  const ta = $('#bkout'); ta.value = txt; ta.select();
  try { navigator.clipboard.writeText(txt).then(() => setStatus('הגיבוי הועתק ✓'), () => setStatus('העתק ידנית מהתיבה')); }
  catch (e) { setStatus('העתק ידנית מהתיבה'); }
}
async function exportBackup() {
  await flushSave();
  const r = await window.api.exportBackup(JSON.stringify(S, null, 1));
  if (r.ok) { setStatus('הגיבוי יוצא ✓'); tell('הגיבוי נשמר בקובץ:\n' + r.file); }
  else if (!r.canceled) tell('ייצוא הגיבוי נכשל: ' + r.error);
}
async function importFile() {
  const r = await window.api.importBackup();
  if (r.canceled) return;
  if (!r.ok) { tell('לא ניתן לקרוא את הקובץ: ' + r.error); return; }
  importText(r.text, r.file);
}
async function replaceData(d, what) {
  await flushSave();
  await window.api.backupNow('before-restore');
  pushUndo(true);
  S = { v: 2, settings: d.settings || { includeFuture: false }, years: d.years };
  recompute();
  ensureUi();
  ui.tab = 'summary';
  backups = null;
  queueSave(true); render();
  setStatus('הנתונים שוחזרו מ' + what + ' ✓');
}
async function importText(txt, what) {
  let d;
  try { d = JSON.parse(String(txt || '').replace(/^﻿/, '')); } catch (e) { tell('הטקסט אינו גיבוי תקין.'); return; }
  if (!isValid(d)) { tell('הגיבוי לא מכיל נתוני שנים.'); return; }
  if (!(await ask('לשחזר מהגיבוי (' + what + ')? הנתונים הנוכחיים יוחלפו (אפשר לבטל עם ↶).', { ok: 'שחזר' }))) return;
  await replaceData(d, 'הגיבוי');
}
async function restoreBackup(name) {
  const r = await window.api.readBackup(name);
  if (!r.ok) { tell('לא ניתן לקרוא את הגיבוי: ' + r.error); return; }
  let d; try { d = JSON.parse(r.text); } catch (e) { d = null; }
  if (!isValid(d)) { tell('קובץ הגיבוי ' + name + ' פגום.'); return; }
  if (!(await ask('לשחזר את הגיבוי ' + name + '? הנתונים הנוכחיים יוחלפו (אפשר לבטל עם ↶).', { ok: 'שחזר' }))) return;
  await replaceData(d, 'הגיבוי ' + name);
}

/* ---------- hooks for the automated self-test ---------- */
window.__app = { get S() { return S; }, ui, calc, render, evalExpr, undo, redo, flushSave, refreshBackups, get UNDO() { return UNDO; }, get REDO() { return REDO; }, get dlgOpen() { return !$('#modal').hidden; } };

// On phones the page can be closed without "beforeunload": save as soon as it goes to the background.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && loaded) flushSave(); });

/* ---------- start ---------- */
btns();
render();
init();
