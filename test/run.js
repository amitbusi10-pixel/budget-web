// Full automatic check of the browser budget app. No dependencies (Node 22+ and Chrome).
//   node test/run.js          demo data (no personal data)
//   node test/run.js --real   also a copy of the real data (%APPDATA%\תקציב שנתי\budget.json, read only)
// Prints one line per check and a short summary; exit code 1 when something failed.
// What it checks: script syntax, both calc.js copies identical, the calculation tests, the logic of the
// portfolio card and the upload reminders, and in headless Chrome (PC width and phone width) the
// button-by-button self-test (every cell, total, button, undo/redo, reset, new year…), script errors
// and horizontal scrolling on every tab. Nothing is saved anywhere: the page runs in demo mode.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { spawn, execFileSync } = require('child_process');
const WEB = path.join(__dirname, '..'), APP = path.join(WEB, '..', 'budget-app');
const REAL = process.argv.includes('--real');
// Steps of the Electron self-test that use Electron-only features (files, folders, the OneDrive backup).
const ELECTRON_ONLY = /ייצוא גיבוי|העתקת גיבוי|ייבוא מקובץ|ייבוא טקסט|שחזור מרשימת|פתיחת תיקיית|גיבוי לענן|אין פניות לרשת/;
const out = []; let fail = 0;
const ok = (name, good, why) => { out.push((good ? '✓ ' : '✗ ') + name + (good || !why ? '' : ' — ' + why)); if (!good) fail++; };

// 1. syntax + the two calc.js copies
for (const f of ['app.js', 'calc.js', 'web-api.js', 'sw.js', 'register-sw.js', 'serve.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(WEB, f)], { stdio: 'pipe' }); ok('תחביר ' + f, true); }
  catch (e) { ok('תחביר ' + f, false, String(e.stderr).split('\n')[0]); }
}
const appCalc = path.join(APP, 'src', 'renderer', 'calc.js');
if (fs.existsSync(appCalc)) ok('calc.js זהה בגרסת הדפדפן ובגרסת המחשב', fs.readFileSync(appCalc, 'utf8') === fs.readFileSync(path.join(WEB, 'calc.js'), 'utf8'), 'צריך להעתיק את השינוי לשני המקומות');

// 2. calculation tests (budget-app/test/calc.test.js, real numbers when seed.json exists)
if (fs.existsSync(path.join(APP, 'test', 'calc.test.js'))) {
  try { const r = execFileSync(process.execPath, ['test/calc.test.js'], { cwd: APP, stdio: 'pipe' }).toString(); const m = r.match(/calc: (\d+) passed, (\d+) failed/); ok(`בדיקות חישוב (${m ? m[1] : '?'})`, !!m && m[2] === '0', r.slice(-300)); }
  catch (e) { ok('בדיקות חישוב', false, String(e.stdout || e).slice(-300)); }
}

// 3. logic: portfolio card = latest month really entered
{
  const C = require(path.join(WEB, 'calc.js'));
  const mk = usd => ({ investments: [{ name: 'Interactive', usd }], transfers: [], rate: 3 });
  const yr = { openUsd: 90000, months: { 9: mk(95000), 10: mk(100000), 11: mk(101000), 12: mk(101000) } };
  const p = C.portfolioSeries(yr, 2026, new Date(2026, 10, 5));
  ok('תיק אינטראקטיב: "שווי עכשיו" לוקח את החודש האחרון שעודכן (גם לפני סוף החודש)', p.lastReal && p.lastReal.k === 11 && p.lastReal.usd === 101000, JSON.stringify(p.lastReal));
  ok('תיק אינטראקטיב: התשואה מחושבת עד אותו חודש', p.gainReal === 11000, String(p.gainReal));
}

// 4. browser checks
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'].find(f => fs.existsSync(f));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function server(dataText) {
  return new Promise(res => {
    const s = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
      let body = null;
      if (p === '/demo.json') body = dataText;
      else if (p === '/test/selftest.js') body = fs.readFileSync(path.join(APP, 'src', 'renderer', 'selftest.js'));
      else if (p === '/sw.js') body = ''; // no service worker during the test
      else { const f = path.join(WEB, p); if (f.startsWith(WEB) && fs.existsSync(f) && fs.statSync(f).isFile()) body = fs.readFileSync(f); }
      if (body == null) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(body);
    }).listen(0, '127.0.0.1', () => res(s));
  });
}
async function cdpPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map(), events = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } else events.push(d); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  return { send, evalJs, events, close: () => ws.close() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function browserRun(label, dataText) {
  const srv = await server(dataText), base = `http://127.0.0.1:${srv.address().port}/`;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));
  const ch = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let port; for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (_) { /* not yet */ } }
    const P = await cdpPage(port);
    await P.send('Runtime.enable');
    for (const [vw, view, w, h] of [['מחשב', 'pc', 1280, 900], ['טלפון', 'phone', 500, 900]]) {
      const tag = `[${label} · ${vw}]`;
      await P.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: view === 'phone' });
      P.events.length = 0;
      await P.send('Page.navigate', { url: base + `?demo&view=${view}&selftest=audit` });
      let r; const t0 = Date.now();
      while (Date.now() - t0 < 600000) { await sleep(1000); r = await P.evalJs('window.__selftestResult'); if (r) break; }
      if (!r) { ok(tag + ' הבדיקה האוטומטית הסתיימה', false, 'לא הסתיימה תוך 10 דקות'); continue; }
      let pass = 0, skipped = 0;
      for (const s of r.results) {
        if (ELECTRON_ONLY.test(s.name)) { skipped++; continue; }
        if (s.ok) pass++; else ok(tag + ' ' + s.name, false, s.error);
      }
      ok(`${tag} ${pass} בדיקות כפתורים, משבצות וסיכומים עברו (${skipped} שייכות רק לגרסת Electron)`, true);
      const exc = P.events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.exception ? e.params.exceptionDetails.exception.description : e.params.exceptionDetails.text);
      ok(tag + ' אין שגיאות סקריפט', !exc.length, exc.slice(0, 3).join(' | '));
      // horizontal scroll + reminders on every tab
      const wide = await P.evalJs(`(async () => { const bad = []; for (const b of [...document.querySelectorAll('nav [data-tab]')]) { b.click(); await new Promise(r => setTimeout(r, 120)); if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(b.textContent.trim()); } return bad; })()`);
      ok(tag + ' אין גלילה לרוחב באף לשונית', !wide.length, (wide || []).join(', '));
    }
    // upload reminders: dates → which reminders are due
    const rem = await P.evalJs(`JSON.stringify([[2026,10,9],[2026,10,10],[2026,10,30],[2026,11,3],[2027,1,28],[2026,11,15]].map(([y,m,d]) => dueReminders(new Date(y,m,d)).map(r => r.kind + ':' + r.ym).join(' ')))`);
    const want = JSON.stringify(['ib:2026-10', 'docs:2026-10', 'docs:2026-10 ib:2026-11', 'ib:2026-11', 'docs:2027-01 ib:2027-02', 'docs:2026-11']);
    ok(`[${label}] תזכורות העלאה: ב-10 מסמכי החודש שעבר, ב-30 (או בסוף החודש) דוח אינטראקטיב`, rem === want, rem);
    P.close();
  } finally { ch.kill(); srv.close(); await sleep(300); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (_) { /* Chrome may still hold a file */ } }
}
(async () => {
  if (!chrome) ok('Chrome נמצא במחשב', false, 'בלי Chrome אין בדיקת מסך');
  else {
    const demo = path.join(APP, 'src', 'seed.demo.json');
    await browserRun('דמו', fs.readFileSync(demo, 'utf8'));
    if (REAL) { const f = path.join(process.env.APPDATA || '', 'תקציב שנתי', 'budget.json'); if (fs.existsSync(f)) await browserRun('נתונים אמיתיים', fs.readFileSync(f, 'utf8')); else ok('נתונים אמיתיים נמצאו', false, f); }
  }
  console.log(out.join('\n'));
  console.log(fail ? `\n✗ ${fail} בעיות` : `\n✓ הכול תקין (${out.length} בדיקות)`);
  process.exit(fail ? 1 : 0);
})();
