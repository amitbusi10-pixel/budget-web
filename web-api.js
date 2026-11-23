// Browser replacement for the Electron preload API (window.api).
// Data lives in the user's own Google Drive (scope drive.file: only files this app created),
// with an offline copy in IndexedDB. No server of ours, no secrets: the Client ID is public.
// Sign-in uses Google's full-page redirect (no popups, works the same on phone and PC);
// when the 1-hour token runs out, a silent redirect (prompt=none) renews it.
'use strict';
(function () {
  const CLIENT_ID = '615679539234-etot0iad88shn339bcuvph6p697hgles.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = 'תקציב שנתי', BK_FOLDER = 'גיבויים', DATA = 'budget.json', LATEST = 'budget-latest.json';
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  const POLL = 30000;

  /* ---------- storage helpers ---------- */
  const idb = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('budget-web', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
    return { get: k => tx('readonly', s => s.get(k)).catch(() => undefined), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => undefined), del: k => tx('readwrite', s => s.delete(k)).catch(() => undefined) };
  })();
  const mk = st => ({ get(k) { try { return st.getItem(k); } catch (_) { return null; } }, set(k, v) { try { st.setItem(k, v); } catch (_) { /* ignore */ } }, del(k) { try { st.removeItem(k); } catch (_) { /* ignore */ } } });
  const ls = mk(window.localStorage), ss = mk(window.sessionStorage);

  const isValid = d => !!d && typeof d === 'object' && !Array.isArray(d) && !!d.years && typeof d.years === 'object' && !Array.isArray(d.years);
  const pad = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const $ = s => document.querySelector(s);

  /* ---------- sign-in (redirect flow) ---------- */
  let token = null, tokenExp = 0;
  try { const t = JSON.parse(ls.get('bw-tok') || 'null'); if (t && t.exp > Date.now()) { token = t.t; tokenExp = t.exp; } } catch (_) { /* ignore */ }
  let authError = null;
  (function takeHash() {
    if (!location.hash) return;
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('state') !== 'bw') return;
    if (h.get('access_token')) {
      token = h.get('access_token'); tokenExp = Date.now() + (+h.get('expires_in') - 120) * 1000;
      ls.set('bw-tok', JSON.stringify({ t: token, exp: tokenExp })); ls.set('budget-signed', '1'); ss.del('bw-silent');
    } else if (h.get('error')) authError = h.get('error');
    history.replaceState(null, '', location.pathname + location.search);
  })();
  const hasToken = () => !!token && Date.now() < tokenExp;
  // Keeps the screen the user was on across the redirect.
  function keepUi() { const a = window.__app; if (a) ss.set('bw-ui', JSON.stringify({ year: a.ui.year, tab: a.ui.tab, y: scrollY })); }
  function signIn(silent) {
    keepUi();
    const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: location.origin + location.pathname, response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: 'bw' });
    const hint = ls.get('bw-hint'); if (hint) p.set('login_hint', hint);
    if (silent) { p.set('prompt', 'none'); ss.set('bw-silent', String(Date.now())); }
    location.replace('https://accounts.google.com/o/oauth2/v2/auth?' + p);
  }
  // A silent renewal is tried at most once a minute (no loops if Google needs the user).
  const silentAllowed = () => !!ls.get('budget-signed') && navigator.onLine && Date.now() - (+ss.get('bw-silent') || 0) > 60000;
  // Renew without the user when it is safe: page visible, nothing being typed, local copy saved.
  async function renewWhenIdle() {
    if (!silentAllowed() || document.visibilityState !== 'visible') return false;
    const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return false;
    if (window.__app) await window.__app.flushSave();
    if (pendingText != null) await idb.set('state', { text: pendingText, baseVer, dirty: true });
    signIn(true); return true;
  }

  /* ---------- Drive helpers ---------- */
  class NeedAuth extends Error {}
  async function drive(path, opt = {}) {
    if (!hasToken()) throw new NeedAuth('auth');
    let r;
    try { r = await fetch(path.startsWith('http') ? path : API + path, { ...opt, headers: { Authorization: 'Bearer ' + token, ...(opt.headers || {}) } }); }
    catch (e) { throw new Error('offline'); }
    if (r.status === 401) { token = null; ls.del('bw-tok'); throw new NeedAuth('auth'); }
    if (!r.ok) throw new Error('Drive ' + r.status);
    return r;
  }
  const q = s => encodeURIComponent(s);
  async function findOne(name, parent, mime) {
    const qq = `name='${name}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '') + (mime ? ` and mimeType='${mime}'` : '');
    const j = await (await drive(`/files?q=${q(qq)}&fields=files(id,name,version)&orderBy=createdTime&pageSize=5`)).json();
    return (j.files || [])[0] || null;
  }
  async function ensureFolder(name, parent) {
    const f = await findOne(name, parent, 'application/vnd.google-apps.folder');
    if (f) return f.id;
    const body = { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) };
    return (await (await drive('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).id;
  }
  async function upload(meta, text, id) {
    const b = '-------bw' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`;
    const url = `${UP}/files${id ? '/' + id : ''}?uploadType=multipart&fields=id,version`;
    return (await drive(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body })).json();
  }
  const download = async id => (await drive(`/files/${id}?alt=media`)).text();

  /* ---------- state ---------- */
  let folderId = ls.get('budget-folder') || null, bkId = null, fileId = null, baseVer = null;
  let lastBackup = +ls.get('budget-lastbk') || 0, lastSync = 0, pendingText = null, syncing = null, bkCache = [];
  const prefs = (() => { try { return Object.assign({ startLastMonth: false, view: 'auto' }, JSON.parse(ls.get('budget-prefs') || '{}')); } catch (_) { return { startLastMonth: false, view: 'auto' }; } })();

  function bar(msg, action) {
    let el = $('#syncbar');
    if (!el) { el = document.createElement('div'); el.id = 'syncbar'; document.body.insertBefore(el, document.body.firstChild); }
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg + ' ';
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.fn; el.appendChild(b); }
  }
  const status = t => { const s = $('#status'); if (s && window.__app && window.__app.loaded) { s.textContent = t; s.className = ''; } };
  const needSignInBar = () => bar('צריך להתחבר שוב ל-Google. השינויים שמורים במכשיר ויסונכרנו אחרי ההתחברות.', { label: 'התחבר', fn: () => { if (window.__app) window.__app.flushSave().then(() => signIn(false)); else signIn(false); } });

  async function setupFolders() {
    if (!folderId || !bkId) {
      folderId = await ensureFolder(FOLDER, null);
      bkId = await ensureFolder(BK_FOLDER, folderId);
      ls.set('budget-folder', folderId);
    }
  }
  const docIds = {};
  async function docsFolder(ym, create) {
    await setupFolders();
    if (!docIds._root) { const f = await findOne('מסמכים', folderId, 'application/vnd.google-apps.folder'); if (f) docIds._root = f.id; else if (create) docIds._root = await ensureFolder('מסמכים', folderId); else return null; }
    if (!docIds[ym]) { const f = await findOne(ym, docIds._root, 'application/vnd.google-apps.folder'); if (f) docIds[ym] = f.id; else if (create) docIds[ym] = await ensureFolder(ym, docIds._root); else return null; }
    return docIds[ym];
  }
  async function remoteMeta() {
    await setupFolders();
    const f = await findOne(DATA, folderId);
    if (f) fileId = f.id;
    return f;
  }

  /* ---------- extra backup to a folder on this computer (e.g. OneDrive), Chrome/Edge only ---------- */
  let dirHandle = null;
  const localDirSupported = () => typeof window.showDirectoryPicker === 'function';
  async function localDirOk(ask) {
    if (!dirHandle) dirHandle = await idb.get('bkdir');
    if (!dirHandle) return false;
    try {
      let p = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && ask) p = await dirHandle.requestPermission({ mode: 'readwrite' });
      return p === 'granted';
    } catch (_) { return false; }
  }
  async function writeLocal(name, text) {
    if (!(await localDirOk(false))) return false;
    try {
      for (const n of [name, LATEST]) { const f = await dirHandle.getFileHandle(n, { create: true }); const w = await f.createWritable(); await w.write(text); await w.close(); }
      ls.set('bw-localbk', String(Date.now())); return true;
    } catch (_) { return false; }
  }

  // Backups: ONE file per day (budget-YYYY-MM-DD.json, overwritten during the day), plus a separate file
  // before an import/restore/monthly update or on a conflict between devices (budget-<time>-<tag>.json).
  // Saving does not create backups (Drive itself keeps the recent versions of budget.json).
  const today = () => stamp().slice(0, 10);
  async function backupText(text, tag) {
    await setupFolders();
    const name = tag ? `budget-${stamp()}-${tag}.json` : `budget-${today()}.json`;
    const same = tag ? null : await findOne(name, bkId);
    await upload(same ? { name } : { name, parents: [bkId] }, text, same && same.id);
    await writeLocal(name, text);
    if (!tag) { lastBackup = Date.now(); ls.set('budget-lastbk', String(lastBackup)); } // a tagged backup does not replace the daily one
    pruneBackups().catch(() => {});
    return name;
  }
  // Which backups to keep (the rest go to the Drive trash, recoverable for 30 days):
  // every day of the last 14 days, the first backup of every older month (kept forever),
  // and the special backups (before import / update / conflict) of the last 90 days.
  function keepSet(names, now = new Date()) {
    const day = n => (n.match(/^budget-(\d{4}-\d{2}-\d{2})/) || [])[1];
    const age = d => (now - new Date(d + 'T12:00:00')) / 864e5;
    const keep = new Set(), firstOfMonth = {};
    for (const n of names.filter(day).sort()) { const m = day(n).slice(0, 7); if (!firstOfMonth[m]) firstOfMonth[m] = n; }
    for (const n of names) {
      const d = day(n); if (!d) { keep.add(n); continue; } // not ours: never touched
      const tagged = !/^budget-\d{4}-\d{2}-\d{2}\.json$/.test(n);
      if (age(d) <= 14 || (tagged && age(d) <= 90) || firstOfMonth[d.slice(0, 7)] === n) keep.add(n);
    }
    return keep;
  }
  async function pruneBackups() {
    if (ls.get('bw-pruned') === today()) return; // once a day is enough
    const j = await (await drive(`/files?q=${q(`'${bkId}' in parents and trashed=false`)}&fields=files(id,name)&pageSize=1000`)).json();
    const files = j.files || [], keep = keepSet(files.map(f => f.name));
    for (const f of files) if (!keep.has(f.name)) await drive(`/files/${f.id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    // the folder on this computer: only the daily files this app wrote (never the old app's backups there)
    if (await localDirOk(false)) {
      const daily = []; for await (const [n] of dirHandle.entries()) if (/^budget-\d{4}-\d{2}-\d{2}\.json$/.test(n)) daily.push(n);
      const k = keepSet(daily); for (const n of daily) if (!k.has(n)) await dirHandle.removeEntry(n).catch(() => {});
    }
    ls.set('bw-pruned', today());
  }

  // Push the local copy. If Drive changed since our base version (another device), keep both:
  // the other device's copy goes to the backups (tag "conflict"), and the newest local edits win.
  async function push(text) {
    const meta = await remoteMeta();
    let note = null;
    if (meta && baseVer != null && String(meta.version) !== String(baseVer)) {
      const remoteText = await download(fileId);
      if (remoteText !== text) { const nm = await backupText(remoteText, 'conflict'); note = `נמצא שינוי ממכשיר אחר באותו זמן. שני העותקים נשמרו: העותק של המכשיר השני נמצא בגיבויים בשם ${nm}.`; }
    }
    const r = await upload(fileId ? { name: DATA } : { name: DATA, parents: [folderId] }, text, fileId);
    fileId = r.id; baseVer = r.version;
    await idb.set('state', { text, baseVer, dirty: false });
    if (pendingText === text) pendingText = null;
    ls.del('budget-pending'); lastSync = Date.now();
    return note;
  }

  function syncNow() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        if (pendingText == null) { const st = await idb.get('state'); if (st && st.dirty) pendingText = st.text; }
        if (pendingText != null) { const note = await push(pendingText); if (note && window.__onSyncNote) window.__onSyncNote(note); }
        bar('');
        return { ok: true, time: lastSync };
      } catch (e) {
        if (e instanceof NeedAuth) { if (!(await renewWhenIdle())) needSignInBar(); return { ok: false, error: 'auth' }; }
        bar('אין חיבור לאינטרנט. השינויים נשמרים במכשיר ויסונכרנו כשהחיבור יחזור.'); return { ok: false, error: 'offline' };
      } finally { syncing = null; }
    })();
    return syncing;
  }

  // Another device changed the data: take it (when nothing here is waiting to be saved).
  async function pullIfChanged() {
    if (!hasToken() || !fileId || pendingText != null || syncing) return;
    try {
      const m = await remoteMeta();
      if (!m || String(m.version) === String(baseVer)) return;
      const t = await download(fileId); const d = JSON.parse(t.replace(/^﻿/, ''));
      if (!isValid(d) || pendingText != null) return;
      baseVer = m.version; await idb.set('state', { text: t, baseVer, dirty: false }); lastSync = Date.now();
      if (window.__applyRemote) window.__applyRemote(d);
    } catch (_) { /* next time */ }
  }
  window.addEventListener('online', () => syncNow().then(pullIfChanged));
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!hasToken()) { renewWhenIdle(); return; }
    if (pendingText != null) syncNow(); else pullIfChanged().then(() => { // app left open past midnight: today's backup
      if (fileId && stamp(new Date(lastBackup)).slice(0, 10) !== today()) download(fileId).then(t => backupText(t, null)).catch(() => {});
    });
  }, POLL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!hasToken()) { renewWhenIdle(); return; }
    if (pendingText != null) syncNow(); else pullIfChanged();
  });

  /* ---------- first sign-in screen ---------- */
  function gate(msg) {
    $('#main').innerHTML = `<section class="box" style="max-width:520px;margin:40px auto;text-align:center">
      <h3>כניסה לתקציב</h3>
      <p class="muted">הנתונים נשמרים ב-Google Drive שלך, בתיקייה "תקציב שנתי". לאפליקציה יש גישה רק לקבצים שהיא עצמה יצרה.</p>
      <p><button class="pri" id="gbtn">התחבר עם Google</button></p>
      <p class="muted">${msg || 'בפעם הראשונה Google תציג אזהרה "האפליקציה לא מאומתת": לוחצים "מתקדם" ואז "המשך".'}</p></section>`;
    $('#gbtn').onclick = () => signIn(false);
    return new Promise(() => {}); // the page leaves for Google
  }

  /* ---------- the API the app expects ---------- */
  async function load() {
    const out = { prefs, dataDir: 'Google Drive › ' + FOLDER };
    // Local layout test only (?demo with a git-ignored demo.json next to the page): no Google, nothing saved.
    if (/[?&]demo\b/.test(location.search)) {
      window.api.save = async () => ({ ok: true, note: 'הדגמה, לא נשמר' });
      const v = new URLSearchParams(location.search).get('view'); if (v) prefs.view = v;
      try { out.data = await (await fetch('demo.json')).json(); } catch (_) { out.data = { years: {} }; }
      const tab = new URLSearchParams(location.search).get('tab'); if (tab) out.ui = { year: +Object.keys(out.data.years)[0], tab: /^\d+$/.test(tab) ? +tab : tab };
      if (/[?&]measure\b/.test(location.search)) setTimeout(() => { // reports elements wider than the screen (for the layout test)
        const W = document.documentElement.clientWidth, wide = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().width > W + 1 && !e.closest('.box > *, .box')).slice(0, 8);
        document.title = 'W=' + W + ' sw=' + document.documentElement.scrollWidth + ' ' + wide.map(e => e.tagName + '.' + e.className + '#' + e.id + ':' + Math.round(e.getBoundingClientRect().width)).join(' | ');
      }, 1500);
      const st = new URLSearchParams(location.search).get('selftest'); // automatic check (test/run.js): load the button-by-button test
      if (st) { out.selftest = st; window.api.selftestDone = r => { window.__selftestResult = r; };
        await new Promise(res => { const e = document.createElement('script'); e.src = 'test/selftest.js'; e.onload = e.onerror = res; document.head.appendChild(e); }); }
      out.mirror = mirrorInfo(); return out;
    }
    let local = await idb.get('state');
    const pend = ls.get('budget-pending');
    if (pend) { try { if (isValid(JSON.parse(pend))) local = { text: pend, baseVer: local ? local.baseVer : null, dirty: true }; } catch (_) { /* ignore */ } }
    if (local) { baseVer = local.baseVer; if (local.dirty) pendingText = local.text; }
    const hasLocal = !!(local && local.text);

    if (!hasToken() && navigator.onLine) {
      if (silentAllowed()) { $('#main').innerHTML = '<section class="box">מתחבר ל-Google…</section>'; signIn(true); return new Promise(() => {}); }
      if (!hasLocal) await gate(authError ? 'צריך לאשר את ההתחברות ב-Google.' : '');
    }
    if (hasToken()) {
      try {
        if (!ls.get('bw-hint')) drive('/about?fields=user(emailAddress)').then(r => r.json()).then(j => { if (j.user) ls.set('bw-hint', j.user.emailAddress); }).catch(() => {});
        const meta = await remoteMeta();
        if (meta) {
          const same = hasLocal && baseVer != null && String(meta.version) === String(baseVer);
          if (!same && pendingText == null) { // Drive is newer (or this device is new): take Drive's copy
            const t = await download(fileId); const d = JSON.parse(t.replace(/^﻿/, ''));
            if (isValid(d)) { baseVer = meta.version; await idb.set('state', { text: t, baseVer, dirty: false }); local = { text: t }; }
          } else if (!same && pendingText != null) { // both changed: keep both
            const nm = await backupText(await download(fileId), 'conflict');
            out.message = `גם במכשיר הזה וגם במכשיר אחר נעשו שינויים. שני העותקים נשמרו: העותק מהמכשיר האחר נמצא בגיבויים בשם ${nm}, וכאן נשארו השינויים של המכשיר הזה.`;
            baseVer = meta.version;
          }
        }
      } catch (e) { if (!(e instanceof NeedAuth) && e.message !== 'offline') out.message = 'שגיאה בקריאה מ-Drive: ' + e.message; }
    } else if (hasLocal) needSignInBar();
    if (local && local.text) { try { const d = JSON.parse(local.text.replace(/^﻿/, '')); if (isValid(d)) out.data = d; } catch (_) { /* ignore */ } }
    if (!out.data) { out.data = { v: 2, settings: { includeFuture: false }, years: {} }; if (hasToken()) out.info = 'אין עדיין נתונים ב-Drive. אפשר לייבא קובץ גיבוי דרך ההגדרות ← ייבוא מקובץ JSON.'; }
    try { out.ui = JSON.parse(ss.get('bw-ui') || 'null'); ss.del('bw-ui'); } catch (_) { /* ignore */ }
    out.mirror = mirrorInfo();
    setTimeout(async () => { // first sync of this session + a backup every 6 hours
      try {
        if (pendingText != null) await syncNow();
        if (fileId && hasToken() && stamp(new Date(lastBackup)).slice(0, 10) !== today()) await backupText(await download(fileId), null);
      } catch (_) { /* later */ }
    }, 1500);
    return out;
  }
  async function save(text) {
    try { if (!isValid(JSON.parse(text))) return { ok: false, error: 'invalid data' }; } catch (e) { return { ok: false, error: 'invalid data' }; }
    pendingText = text;
    await idb.set('state', { text, baseVer, dirty: true });
    const r = await syncNow();
    return { ok: true, time: Date.now(), note: r.ok ? 'נשמר וסונכרן ✓' : 'נשמר במכשיר, יסונכרן בהמשך' };
  }
  function saveSync(text) { ls.set('budget-pending', text); }
  function mirrorInfo() {
    return { dir: 'Google Drive › ' + FOLDER, ok: true, time: lastSync || null, localSupported: localDirSupported(), localName: dirHandle ? dirHandle.name : (ls.get('bw-localname') || null), localTime: +ls.get('bw-localbk') || null };
  }

  function downloadFile(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const currentText = async () => pendingText != null ? pendingText : (fileId && hasToken() ? await download(fileId) : ((await idb.get('state')) || {}).text);
  window.api = {
    load, save, saveSync,
    exportBackup: async text => { const f = `budget-${stamp()}.json`; downloadFile(f, text); return { ok: true, file: f + ' (בתיקיית ההורדות)' }; },
    importBackup: () => new Promise(res => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json'; i.style.display = 'none';
      i.onchange = async () => { const f = i.files[0]; i.remove(); if (!f) return res({ ok: false, canceled: true }); try { res({ ok: true, file: f.name, text: (await f.text()).replace(/^﻿/, '') }); } catch (e) { res({ ok: false, error: e.message }); } };
      i.addEventListener('cancel', () => { i.remove(); res({ ok: false, canceled: true }); });
      document.body.appendChild(i); i.click();
    }),
    listBackups: async () => {
      try {
        await setupFolders();
        const j = await (await drive(`/files?q=${q(`'${bkId}' in parents and trashed=false`)}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=60`)).json();
        bkCache = (j.files || []).map(f => ({ id: f.id, name: f.name, size: +f.size || 0, mtime: Date.parse(f.createdTime) }));
      } catch (_) { /* keep the last list */ }
      return bkCache;
    },
    readBackup: async name => {
      try { const f = bkCache.find(b => b.name === name); if (!f) return { ok: false, error: 'הגיבוי לא נמצא' }; return { ok: true, text: (await download(f.id)).replace(/^﻿/, '') }; }
      catch (e) { return { ok: false, error: e instanceof NeedAuth ? 'צריך להתחבר ל-Google' : e.message }; }
    },
    backupNow: async tag => {
      try { const t = await currentText(); if (!t) return { name: null }; return { name: await backupText(t, tag && /^[a-z-]+$/.test(tag) ? tag : null) }; }
      catch (e) { return { name: null, error: e.message }; }
    },
    openDataFolder: async () => { if (!folderId) return { ok: false, error: 'התיקייה עדיין לא נוצרה' }; window.open('https://drive.google.com/drive/folders/' + folderId, '_blank', 'noopener'); return { ok: true, path: FOLDER }; },
    setPrefs: async p => { for (const k of ['startLastMonth', 'view']) if (p && k in p) prefs[k] = p[k]; ls.set('budget-prefs', JSON.stringify(prefs)); return prefs; },
    mirrorStatus: async () => mirrorInfo(),
    mirrorNow: async () => { const r = await window.api.backupNow(null); await syncNow(); return Object.assign(mirrorInfo(), r.name ? { time: Date.now() } : { ok: false, error: r.error || 'צריך להתחבר ל-Google' }); },
    // Choose / reconnect the folder on this computer for the extra backup copy.
    mirrorChoose: async () => {
      try {
        if (dirHandle && await localDirOk(true)) { await writeLocal(`budget-${stamp()}.json`, await currentText()); return mirrorInfo(); }
        dirHandle = await window.showDirectoryPicker({ id: 'budget-backups', mode: 'readwrite' });
        await idb.set('bkdir', dirHandle); ls.set('bw-localname', dirHandle.name);
        const t = await currentText(); if (t) await writeLocal(`budget-${stamp()}.json`, t);
        return mirrorInfo();
      } catch (e) { return e && e.name === 'AbortError' ? { canceled: true } : Object.assign(mirrorInfo(), { error: 'לא ניתן להשתמש בתיקייה: ' + e.message }); }
    },
    mirrorOff: async () => { dirHandle = null; await idb.del('bkdir'); ls.del('bw-localname'); ls.del('bw-localbk'); return mirrorInfo(); },
    // Monthly documents: תקציב שנתי › מסמכים › YYYY-MM (the files keep their names).
    docsList: async ym => {
      try {
        const id = await docsFolder(ym, false); if (!id) return { ok: true, files: [] };
        const j = await (await drive(`/files?q=${q(`'${id}' in parents and trashed=false`)}&fields=files(id,name,size,createdTime)&orderBy=name&pageSize=200`)).json();
        return { ok: true, files: (j.files || []).map(f => ({ id: f.id, name: f.name, size: +f.size || 0, time: Date.parse(f.createdTime) })) };
      } catch (e) { return { ok: false, error: e instanceof NeedAuth ? 'צריך להתחבר ל-Google (כפתור "התחבר" למעלה).' : e.message === 'offline' ? 'אין חיבור לאינטרנט.' : e.message }; }
    },
    docsUpload: async (ym, file) => {
      try {
        const id = await docsFolder(ym, true), b = '-------bw' + Math.random().toString(36).slice(2);
        const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: file.name, parents: [id] })}\r\n--${b}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`, file, `\r\n--${b}--`]);
        await drive(`${UP}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
        return { ok: true };
      } catch (e) { return { ok: false, error: e instanceof NeedAuth ? 'צריך להתחבר ל-Google' : e.message === 'offline' ? 'אין חיבור לאינטרנט' : e.message }; }
    },
    docsDelete: async id => { try { await drive(`/files/${id}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    docsGet: async id => (await drive(`/files/${id}?alt=media`)).blob(), // used by the monthly update on the PC
    mirrorDefault: async () => ({ canceled: true }),
    openMirror: async () => window.api.openDataFolder(),
    selftestDone: () => {}
  };
  localDirOk(false); // loads the saved folder handle
  window.__driveOnline = hasToken;
})();
