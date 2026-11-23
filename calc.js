// Calculations — ported from the browser version (תקציב אישי 2026.html).
// Shared by the app (window.BudgetCalc) and the Node tests (module.exports).
(function (root) {
  'use strict';
  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
  const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
  const sumArr = (a, f) => (a || []).reduce((s, x) => s + num(f(x)), 0);

  // Monthly totals. The first block is identical to the browser version's calc().
  // The *Ext fields exclude internal income ("העברה פנימית") and are what the UI shows
  // for "הכנסות", "נשאר בנטו" and "נשאר בפועל".
  function calc(m, includeFuture) {
    const tr = m.transfers || [];
    const reg = tr.filter(t => t.cat !== 'deposit'), dep = tr.filter(t => t.cat === 'deposit');
    const fixed = sumArr(m.fixed, x => x.monthly), cards = sumArr(m.cards, x => x.amount);
    const trReg = sumArr(reg, x => x.amount), deposits = sumArr(dep, x => x.amount);
    const income = sumArr(m.income, x => x.amount), future = sumArr(m.future, x => x.amount);
    const totalExp = fixed + cards + trReg, net = income - totalExp, remain = net - deposits;
    const usdT = sumArr(m.investments, x => x.usd), portILS = usdT * num(m.rate);
    const debts = sumArr((m.fixed || []).filter(f => f.kind === 'loan'), x => x.balance), netInv = portILS - debts;
    const savings = sumArr(m.savings, x => x.balance), cash = sumArr((m.savings || []).filter(s => s.kind === 'cash'), x => x.balance);
    // future money: all of it when the setting is on, otherwise only rows marked inEquity (the release deposit)
    const futureInEquity = includeFuture ? future : sumArr((m.future || []).filter(x => x.inEquity), x => x.amount);
    const equity = savings + netInv + futureInEquity;
    // Internal income (e.g. money moved from Blink) is not real income. A deposit funded by it
    // is not a new deposit either — same rule as the year summary of the browser version.
    const internal = sumArr((m.income || []).filter(x => x.internal), x => x.amount);
    const incomeExt = income - internal;
    const depNet = Math.max(0, deposits - internal);
    const netExt = incomeExt - totalExp;
    const remainExt = netExt - depNet;
    return { fixed, cards, trReg, deposits, income, future, totalExp, net, remain, usdT, portILS, debts, netInv, savings, cash, equity,
      monthlyFunds: sumArr(m.savings, x => x.monthly), internal, incomeExt, depNet, netExt, remainExt, futureInEquity };
  }

  function emptyMonth() {
    return { period: '', rate: 3.1, asOf: '', fixed: [], cards: [], transfers: [], income: [], future: [], savings: [], investments: [], checked30: null };
  }

  // Opening a month copies the previous one.
  function deriveMonth(prev) {
    const m = JSON.parse(JSON.stringify(prev));
    m.period = ''; m.asOf = ''; m.checked30 = null;
    m.cards = (prev.cards || []).map(c => ({ name: c.name, amount: 0, date: '', note: '' }));
    m.transfers = [];
    (m.fixed || []).forEach(f => { if (f.kind === 'loan' && f.balance != null) f.balance = Math.max(0, r2(num(f.balance) - num(f.monthly))); });
    m.income = (m.income || []).filter(x => !x.internal).map(x => Object.assign({}, x, { amount: 0, date: '' }));
    (m.savings || []).forEach(s => {
      // the monthly deposit changes every month, so a new month starts with it empty
      if (s.kind !== 'cash') { s.monthly = null; s.gain = 0; delete s.open; s.balance = r2(num(s.balance)); }
      // the bank balance of a new month is calculated (previous month + what is left this month)
      else { s.manual = false; }
    });
    return m;
  }

  /* ---------- savings chain: every month continues from the previous month ----------
     For a fund/pension row (kind != cash):
       balance = previous month's balance of the same row (matched by name) + monthly deposit + gain
     "gain" (רווח/שינוי) is the market change of that month. For a row with no previous month
     (the first month, or a new row) the starting balance is the row's own "open" field.
     Existing data is migrated without changing any balance: the missing gain is derived from it. */
  const fund = s => s && s.kind !== 'cash';
  const nameKey = s => String(s.name == null ? '' : s.name).trim();

  // All months of all years, in time order: [{ y, k, m }]
  function chainMonths(S) {
    const out = [];
    Object.keys(S.years || {}).map(Number).sort((a, b) => a - b).forEach(y => {
      const ms = (S.years[y] || {}).months || {};
      Object.keys(ms).map(Number).sort((a, b) => a - b).forEach(k => out.push({ y, k, m: ms[k] }));
    });
    return out;
  }
  // For each savings row of month m, the matching row of the same type in month prev (same name, same occurrence), or null.
  function matchRows(m, prev) {
    const used = new Set();
    return (m.savings || []).map(s => {
      if (!s || !prev) return null;
      const key = nameKey(s), isFund = fund(s);
      const i = (prev.savings || []).findIndex((p, j) => !used.has(j) && p && fund(p) === isFund && nameKey(p) === key);
      if (i < 0) return null;
      used.add(i);
      return prev.savings[i];
    });
  }
  // Recompute every fund balance through the whole chain. Idempotent. Never loses a value:
  // a row whose link is missing keeps its current balance (its "open" is fixed from it).
  function recomputeSavings(S) {
    const list = chainMonths(S);
    list.forEach(({ m }, idx) => {
      const prev = idx > 0 ? list[idx - 1].m : null;
      // only chain to the directly preceding month when it is the calendar month before
      const p = idx > 0 && isPrevMonth(list[idx - 1], list[idx]) ? prev : null;
      const links = matchRows(m, p);
      (m.savings || []).forEach((s, i) => {
        const pr = links[i];
        if (!fund(s)) {
          // Bank: a balance you typed (manual) stays as is. Otherwise it is calculated:
          // previous month's bank + this month's "נשאר בפועל" (all income − expenses − deposits).
          if (s.manual == null) s.manual = true; // existing data: keep the stored value
          if (!s.manual && pr) s.balance = r2(num(pr.balance) + calc(m, false).remain);
          return;
        }
        if (s.gain == null || s.gain === '') {
          // migration of old data: derive the gain so the stored balance stays exactly the same
          if (pr) s.gain = r2(num(s.balance) - num(pr.balance) - num(s.monthly));
          else { s.gain = 0; if (s.open == null || s.open === '') s.open = r2(num(s.balance) - num(s.monthly)); }
        }
        if (pr) { s.balance = r2(num(pr.balance) + num(s.monthly) + num(s.gain)); delete s.open; }
        else {
          if (s.open == null || s.open === '') s.open = r2(num(s.balance) - num(s.monthly) - num(s.gain));
          s.balance = r2(num(s.open) + num(s.monthly) + num(s.gain));
        }
      });
    });
    return S;
  }
  function isPrevMonth(a, b) { return (a.y === b.y && a.k === b.k - 1) || (a.y === b.y - 1 && a.k === 12 && b.k === 1); }
  // The matching row in the previous month for row i of month (y,k), or null.
  function prevRow(S, y, k, i) {
    const list = chainMonths(S);
    const idx = list.findIndex(x => x.y === +y && x.k === +k);
    if (idx <= 0 || !isPrevMonth(list[idx - 1], list[idx])) return null;
    return matchRows(list[idx].m, list[idx - 1].m)[i] || null;
  }
  // Editing the balance of a fund row directly: keep the chain, put the difference into "gain".
  function setFundBalance(S, y, k, i, balance) {
    const m = S.years[y].months[k], s = m.savings[i];
    const pr = prevRow(S, y, k, i);
    const start = pr ? num(pr.balance) : num(s.open);
    s.gain = r2(num(balance) - start - num(s.monthly));
    return recomputeSavings(S);
  }
  // Running totals from the first month of the year up to month k (inclusive).
  function cumulative(yr, k, includeFuture) {
    let net = 0, remain = 0;
    Object.keys(yr.months || {}).map(Number).filter(x => x <= k).forEach(x => { const c = calc(yr.months[x], includeFuture); net += c.netExt; remain += c.remainExt; });
    return { net, remain };
  }

  // "אפס חודש": cards, transfers and income are cleared; fixed, savings and investments stay.
  function clearFlows(m) {
    (m.cards || []).forEach(c => { c.amount = 0; c.date = ''; c.note = ''; });
    m.transfers = [];
    m.income = (m.income || []).filter(x => !x.internal).map(x => Object.assign({}, x, { amount: 0, date: '' }));
  }

  // Year summary — same rules as the browser version's renderYear(), except "הפקדתי" (dep):
  // it counts ALL deposits (the browser version subtracted internal income from them).
  function yearSummary(yr, includeFuture) {
    const act = Object.keys(yr.months || {}).map(Number).sort((a, b) => a - b).map(k => {
      const m = yr.months[k], c = calc(m, includeFuture);
      return { k, m, c, inc: c.incomeExt, net: c.netExt, dep: c.deposits };
    }).filter(x => x.c.income || x.c.totalExp || x.c.deposits);
    if (!act.length) return { act, empty: true };
    const sum = f => act.reduce((s, x) => s + f(x), 0);
    const tInc = sum(x => x.inc), tExp = sum(x => x.c.totalExp), tNet = tInc - tExp, tDep = sum(x => x.dep);
    const first = act[0], last = act[act.length - 1];
    const depUsd = tDep / (num(last.m.rate) || 1);
    const openGiven = yr.openUsd != null && yr.openUsd !== '';
    const open = openGiven ? num(yr.openUsd) : (first.c.usdT - first.dep / (num(first.m.rate) || 1));
    const gainUsd = last.c.usdT - open - depUsd;
    return { act, empty: false, tInc, tExp, tNet, tDep, depUsd, open, openGiven, gainUsd, first, last,
      tRemain: tNet - tDep, e0: first.c.equity, e1: last.c.equity };
  }

  // The Interactive portfolio month by month (dollars): value, deposits, and the market return of each month
  // (= change in value minus that month's deposits). A deposit's dollars come from its note when written there
  // (e.g. "הומר ל 1306$"), otherwise shekels ÷ the month's rate. Months that have not ended by `today` are estimates.
  function depositUsd(t, rate) {
    const m = String(t.note || '').match(/(\d[\d,]*(?:\.\d+)?)\s*\$/g) || [];
    const vals = m.map(s => num(s.replace(/[$,\s]/g, ''))).filter(v => v >= 50); // skips rates like "3.10$"
    return vals.length ? vals[vals.length - 1] : num(t.amount) / (num(rate) || 1);
  }
  function portfolioSeries(yr, y, today) {
    const ks = Object.keys(yr.months || {}).map(Number).sort((a, b) => a - b);
    const rows = [];
    let prev = (yr.openUsd != null && yr.openUsd !== '') ? num(yr.openUsd) : null;
    const open = prev;
    ks.forEach(k => {
      const m = yr.months[k];
      const inv = (m.investments || []).find(r => /אינטרא|interactive|IB/i.test(r.name || ''));
      if (!inv || inv.usd == null || inv.usd === '') return;
      const usdV = num(inv.usd);
      const dep = (m.transfers || []).filter(t => t.cat === 'deposit').reduce((s, t) => s + depositUsd(t, m.rate), 0);
      const est = today ? new Date(+y, k, 1) > today : false; // the 1st of the next month is still ahead
      const gain = prev == null ? null : usdV - prev - dep;
      const base = prev == null ? 0 : prev + dep;
      rows.push({ k, usd: r2(usdV), dep: r2(dep), gain: gain == null ? null : r2(gain), pct: base ? gain / base * 100 : null, est });
      prev = usdV;
    });
    // "Now" = the latest month whose value was really entered: months opened ahead copy the previous value,
    // so the last row whose value differs from the row before it (whether or not that month has ended).
    let li = rows.length - 1;
    while (li > 0 && rows[li].usd === rows[li - 1].usd) li--;
    const lastReal = rows[li] || null;
    const real = rows.slice(0, li + 1);
    const depAll = rows.reduce((s, r) => s + r.dep, 0);
    const depReal = real.reduce((s, r) => s + r.dep, 0);
    const gainReal = lastReal && open != null ? lastReal.usd - open - depReal : null;
    return { rows, open, depAll: r2(depAll), lastReal, gainReal: gainReal == null ? null : r2(gainReal),
      pctReal: gainReal == null || !(open + depReal) ? null : gainReal / (open + depReal) * 100 };
  }

  const api = { num, r2, sumArr, calc, emptyMonth, deriveMonth, clearFlows, yearSummary, portfolioSeries, depositUsd,
    recomputeSavings, prevRow, setFundBalance, cumulative, chainMonths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BudgetCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
