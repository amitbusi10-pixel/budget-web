// Browser replacement for the Electron preload API (window.api).
// Data lives in the user's own Google Drive (scope drive.file: only files this app created),
// with an offline copy in IndexedDB. No server of ours, no secrets: the Client ID is public.
'use strict';
(function () {
  const CLIENT_ID = '615679539234-etot0iad88shn339bcuvph6p697hgles.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = 'תקציב שנתי', BK_FOLDER = 'גיבויים', DATA = 'budget.json';
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';
  const BACKUP_EVERY = 6 * 3600 * 1000;

  /* ---------- tiny IndexedDB key/value ---------- */
  const idb = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('budget-web', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
    return { get: k => tx('readonly', s => s.get(k)).catch(() => undefined), set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => undefined) };
  })();
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } }, del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } } };

  const isValid = d => !!d && typeof d === 'object' && !Array.isArray(d) && !!d.years && typeof d.years === 'object' && !Array.isArray(d.years);
  const pad = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const $ = s => document.querySelector(s);

  /* ---------- sign-in (Google Identity Services, token flow) ---------- */
  let token = null, tokenExp = 0, tokenClient = null, gsiP = null;
  function loadGsi() {
    return gsiP || (gsiP = new Promise((res, rej) => {
      if (window.google && google.accounts && google.accounts.oauth2) return res();
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res(); s.onerror = () => { gsiP = null; rej(new Error('offline')); };
      document.head.appendChild(s);
    }));
  }
  // interactive=false tries without a popup (works when the user already granted access and is signed in to Google).
  function requestToken(interactive) {
    return loadGsi().then(() => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), interactive ? 120000 : 8000);
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, prompt: interactive ? '' : 'none',
        hint: ls.get('budget-hint') || undefined,
        callback: r => {
          clearTimeout(t);
          if (r && r.access_token) { token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000; ls.set('budget-signed', '1'); res(token); }
          else rej(new Error((r && r.error) || 'denied'));
        },
        error_callback: e => { clearTimeout(t); rej(new Error((e && e.type) || 'denied')); }
      });
      tokenClient.requestAccessToken();
    }));
  }
  // Fallback when the popup is blocked: full-page redirect to Google, which returns the token in the URL hash.
  const redirectUri = () => location.origin + location.pathname;
  function redirectSignIn() {
    const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: 'bw' });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  }
  (function takeHashToken() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('access_token') && h.get('state') === 'bw') {
      token = h.get('access_token'); tokenExp = Date.now() + (+h.get('expires_in') - 60) * 1000; ls.set('budget-signed', '1');
      history.replaceState(null, '', location.pathname + location.search);
    }
  })();
  async function getToken(interactive) {
    if (token && Date.now() < tokenExp) return token;
    return requestToken(!!interactive);
  }

  /* ---------- Drive helpers ---------- */
  class NeedAuth extends Error {}
  async function drive(path, opt = {}, retry = true) {
    let tk; try { tk = await getToken(false); } catch (e) { if (!navigator.onLine) throw new Error('offline'); throw new NeedAuth('auth'); }
    let r;
    try { r = await fetch(path.startsWith('http') ? path : API + path, { ...opt, headers: { Authorization: 'Bearer ' + tk, ...(opt.headers || {}) } }); }
    catch (e) { throw new Error('offline'); }
    if (r.status === 401 && retry) { token = null; return drive(path, opt, false); }
    if (r.status === 401 || r.status === 403) throw new NeedAuth('auth');
    if (!r.ok) throw new Error('Drive ' + r.status);
    return r;
  }
  const q = s => encodeURIComponent(s);
  async function findOne(name, parent, mime) {
    const qq = `name='${name}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '') + (mime ? ` and mimeType='${mime}'` : '');
    const j = await (await drive(`/files?q=${q(qq)}&fields=files(id,name,version,modifiedTime,size)&orderBy=createdTime&pageSize=5`)).json();
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
    const url = id ? `${UP}/files/${id}?uploadType=multipart&fields=id,version,modifiedTime` : `${UP}/files?uploadType=multipart&fields=id,version,modifiedTime`;
    return (await drive(url, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body })).json();
  }
  const download = async id => (await drive(`/files/${id}?alt=media`)).text();

  /* ---------- state ---------- */
  let folderId = null, bkId = null, fileId = null, baseVer = null;
  let lastBackup = 0, lastSync = 0, online = true, dirty = false, pendingText = null, syncing = null, bkCache = [];
  const prefs = (() => { try { return Object.assign({ startLastMonth: false }, JSON.parse(ls.get('budget-prefs') || '{}')); } catch (_) { return { startLastMonth: false }; } })();

  function bar(msg, kind, action) {
    let el = $('#syncbar');
    if (!el) { el = document.createElement('div'); el.id = 'syncbar'; document.body.insertBefore(el, document.body.firstChild); }
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.className = kind || '';
    el.innerHTML = ''; el.append(msg + ' ');
    if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.fn; el.appendChild(b); }
  }
  const reconnectBtn = () => ({ label: 'התחבר מחדש', fn: () => syncNow(true) });

  async function setupFolders() {
    if (folderId && bkId) return;
    folderId = await ensureFolder(FOLDER, null);
    bkId = await ensureFolder(BK_FOLDER, folderId);
    ls.set('budget-folder', folderId);
  }
  async function remoteMeta() {
    await setupFolders();
    const f = await findOne(DATA, folderId);
    if (f) { fileId = f.id; return f; }
    return null;
  }

  // Writes a backup copy into Drive (never deleted automatically).
  async function backupText(text, tag) {
    await setupFolders();
    const name = `budget-${stamp()}${tag ? '-' + tag : ''}.json`;
    await upload({ name, parents: [bkId] }, text);
    lastBackup = Date.now(); ls.set('budget-lastbk', String(lastBackup));
    return name;
  }

  // Push the local copy to Drive. If Drive changed since our base version (another device), keep both:
  // the other copy goes to the backups folder (tag "conflict"), and the newest local edits win.
  async function push(text) {
    const meta = await remoteMeta();
    let conflictNote = null;
    if (meta && baseVer != null && String(meta.version) !== String(baseVer)) {
      try {
        const remoteText = await download(fileId);
        if (remoteText !== text) { const nm = await backupText(remoteText, 'conflict'); conflictNote = `נמצא שינוי ממכשיר אחר. שני העותקים נשמרו: העותק של המכשיר השני נשמר בגיבויים בשם ${nm}.`; }
      } catch (e) { if (e instanceof NeedAuth || e.message === 'offline') throw e; }
    }
    const r = await upload(fileId ? { name: DATA } : { name: DATA, parents: [folderId] }, text, fileId);
    fileId = r.id; baseVer = r.version;
    await idb.set('state', { text, baseVer, dirty: false });
    dirty = false; pendingText = null; ls.del('budget-pending'); lastSync = Date.now();
    return conflictNote;
  }

  function syncNow(interactive) {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        if (interactive) { await getToken(true); }
        if (pendingText == null) { const st = await idb.get('state'); if (st && st.dirty) pendingText = st.text; }
        if (pendingText != null) {
          const note = await push(pendingText);
          if (note && window.__onSyncNote) window.__onSyncNote(note);
        }
        if (!lastBackup) lastBackup = +ls.get('budget-lastbk') || 0;
        online = true; bar('');
        return { ok: true, time: lastSync };
      } catch (e) {
        if (interactive && /popup/i.test(e.message)) { redirectSignIn(); return { ok: false, error: 'auth' }; }
        if (e instanceof NeedAuth || /denied|popup|timeout|access/i.test(e.message)) { bar('ההתחברות ל-Google פגה. השינויים נשמרים במכשיר, וישוחזר הסנכרון אחרי התחברות.', 'warn', reconnectBtn()); return { ok: false, error: 'auth' }; }
        online = false; bar('אין חיבור. השינויים נשמרים במכשיר ויסונכרנו כשיחזור החיבור.', 'warn'); return { ok: false, error: 'offline' };
      } finally { syncing = null; }
    })();
    return syncing;
  }
  window.addEventListener('online', () => { if (dirty || pendingText != null) syncNow(false); });
  setInterval(() => { if (dirty || pendingText != null) syncNow(false); }, 60000);
  // When the app comes back to the foreground, check whether another device changed the data.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !fileId) return;
    if (dirty) { syncNow(false); return; }
    remoteMeta().then(m => { if (m && baseVer != null && String(m.version) !== String(baseVer) && window.__onRemoteChange) window.__onRemoteChange(); }).catch(() => {});
  });

  /* ---------- sign-in gate ---------- */
  function gate() {
    return new Promise(res => {
      const main = $('#main');
      main.innerHTML = `<section class="box" id="gate" style="max-width:520px;margin:40px auto;text-align:center">
        <h3>כניסה לתקציב</h3>
        <p class="muted">הנתונים נשמרים בחשבון Google Drive שלך, בתיקייה "תקציב שנתי". לאפליקציה יש גישה רק לקבצים שהיא עצמה יצרה.</p>
        <p><button class="pri" id="gbtn">התחבר עם Google</button></p>
        <p class="muted" id="gmsg">בפעם הראשונה Google תציג אזהרה "האפליקציה לא מאומתת": לוחצים "מתקדם" ואז "המשך".</p></section>`;
      $('#gbtn').onclick = async () => {
        $('#gmsg').textContent = 'מתחבר…';
        try { await getToken(true); res(); } catch (e) {
          if (/popup/i.test(e.message)) { $('#gmsg').textContent = 'החלון הקופץ נחסם, עובר להתחברות בדף מלא…'; redirectSignIn(); return; }
          $('#gmsg').textContent = 'ההתחברות לא הושלמה (' + e.message + '). אפשר ללחוץ שוב.';
        }
      };
    });
  }

  /* ---------- the API the app expects ---------- */
  async function load() {
    const out = { prefs, dataDir: 'Google Drive › ' + FOLDER, mirror: null };
    let local = await idb.get('state');
    const pend = ls.get('budget-pending');
    if (pend) { try { if (isValid(JSON.parse(pend))) { local = { text: pend, baseVer: local ? local.baseVer : null, dirty: true }; } } catch (_) { /* ignore */ } }
    if (local) { baseVer = local.baseVer; dirty = !!local.dirty; if (dirty) pendingText = local.text; }
    folderId = ls.get('budget-folder') || null;

    // Sign in: silently if possible, otherwise show the gate (first time / expired).
    let signedIn = false;
    if (ls.get('budget-signed')) { try { await getToken(false); signedIn = true; } catch (_) { /* gate below */ } }
    const hasLocal = !!(local && local.text);
    if (!signedIn && !hasLocal && navigator.onLine) { await gate(); signedIn = true; }
    // Data on this device: open right away; sign-in is offered in the bar instead of blocking.
    if (!signedIn && hasLocal) bar('לא מחובר ל-Google, ההצגה מהעותק שבמכשיר. הסנכרון יתחדש אחרי התחברות.', 'warn', { label: 'התחבר', fn: () => syncNow(true).then(r => { if (r.ok) location.reload(); }) });

    if (signedIn) {
      try {
        const meta = await remoteMeta();
        if (meta) {
          const same = local && baseVer != null && String(meta.version) === String(baseVer);
          if (!same && !dirty) { // Drive is newer (or this device is new): take Drive's copy
            const t = await download(fileId);
            const d = JSON.parse(t.replace(/^﻿/, ''));
            if (isValid(d)) { baseVer = meta.version; await idb.set('state', { text: t, baseVer, dirty: false }); local = { text: t }; }
          } else if (dirty && !same) { // both changed: keep both
            const t = await download(fileId);
            const nm = await backupText(t, 'conflict');
            out.message = `גם במכשיר הזה וגם במכשיר אחר נעשו שינויים. שני העותקים נשמרו: העותק מהמכשיר האחר נמצא בגיבויים בשם ${nm}, וכאן נשארו השינויים של המכשיר הזה.`;
            baseVer = meta.version;
          }
        }
      } catch (e) { if (!(e instanceof NeedAuth) && e.message !== 'offline') out.message = 'שגיאה בקריאה מ-Drive: ' + e.message; }
    }
    if (local && local.text) { try { const d = JSON.parse(local.text.replace(/^﻿/, '')); if (isValid(d)) out.data = d; } catch (_) { /* ignore */ } }
    if (!out.data) out.data = { v: 2, settings: { includeFuture: false }, years: {} };
    if (!fileId && signedIn && !local) out.info = 'זה השימוש הראשון. אפשר לייבא את הנתונים הקיימים דרך ההגדרות ← ייבוא מקובץ JSON (קובץ הגיבוי מגרסת המחשב).';
    out.mirror = { dir: 'Google Drive › ' + FOLDER, ok: true, time: lastSync || null };
    // first sync of this session + periodic backup (every 6 hours)
    setTimeout(async () => {
      try {
        if (dirty || pendingText != null) await syncNow(false);
        lastBackup = +ls.get('budget-lastbk') || 0;
        if (fileId && Date.now() - lastBackup > BACKUP_EVERY) { const t = await download(fileId); await backupText(t, null); }
      } catch (_) { /* later */ }
    }, 1500);
    return out;
  }
  async function save(text) {
    try {
      const d = JSON.parse(text); if (!isValid(d)) return { ok: false, error: 'invalid data' };
    } catch (e) { return { ok: false, error: 'invalid data' }; }
    pendingText = text; dirty = true;
    await idb.set('state', { text, baseVer, dirty: true });
    const r = await syncNow(false);
    return r.ok ? { ok: true, time: Date.now(), note: 'סונכרן ל-Drive ✓' } : { ok: true, time: Date.now(), note: r.error === 'auth' ? 'נשמר במכשיר, ממתין לחיבור ל-Google' : 'נשמר במכשיר, ממתין לחיבור' };
  }
  function saveSync(text) { ls.set('budget-pending', text); }

  function download_(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  window.api = {
    load, save, saveSync,
    exportBackup: async text => { const f = `budget-${stamp()}.json`; download_(f, text); return { ok: true, file: f + ' (בתיקיית ההורדות)' }; },
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
        return bkCache;
      } catch (_) { return bkCache; }
    },
    readBackup: async name => {
      try { const f = bkCache.find(b => b.name === name); if (!f) return { ok: false, error: 'הגיבוי לא נמצא' }; return { ok: true, text: (await download(f.id)).replace(/^﻿/, '') }; }
      catch (e) { return { ok: false, error: e.message }; }
    },
    backupNow: async tag => {
      try { const t = pendingText != null ? pendingText : (fileId ? await download(fileId) : null); if (!t) return { name: null }; return { name: await backupText(t, tag && /^[a-z-]+$/.test(tag) ? tag : null) }; }
      catch (e) { return { name: null, error: e.message }; }
    },
    openDataFolder: async () => { const id = folderId || ls.get('budget-folder'); if (!id) return { ok: false, error: 'התיקייה עדיין לא נוצרה' }; window.open('https://drive.google.com/drive/folders/' + id, '_blank', 'noopener'); return { ok: true, path: FOLDER }; },
    setPrefs: async p => { Object.assign(prefs, { startLastMonth: !!(p && p.startLastMonth) }); ls.set('budget-prefs', JSON.stringify(prefs)); return prefs; },
    mirrorStatus: async () => ({ dir: 'Google Drive › ' + FOLDER, ok: true, time: lastSync || null }),
    mirrorNow: async () => { await window.api.backupNow(null); await syncNow(false); return { dir: 'Google Drive › ' + FOLDER, ok: true, time: Date.now() }; },
    mirrorOff: async () => ({ dir: 'Google Drive › ' + FOLDER, ok: true, time: lastSync || null }),
    mirrorChoose: async () => ({ canceled: true }), mirrorDefault: async () => ({ canceled: true }),
    openMirror: async () => window.api.openDataFolder(),
    selftestDone: () => {}
  };
  window.__syncNow = syncNow;
  window.__driveOnline = () => !!token && Date.now() < tokenExp;
})();
