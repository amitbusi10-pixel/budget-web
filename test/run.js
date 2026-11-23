// Full check of the browser budget app. No installs needed (Node 22+ and Chrome).
//   node test/run.js            everything, on demo data and on a read-only copy of the real data
//   node test/run.js --open     same, and shows the live page in a Chrome window (the shortcut uses this)
//   node test/run.js --quick    without the long button-by-button pass
// Nothing real changes: the app runs in a separate headless Chrome, against a fake Google Drive in memory.
// The report is written to "תקציב שנתי\דוחות\בדיקת האפליקציה.html"; exit code 1 when something failed.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os'), { spawn, execFileSync } = require('child_process');
const FakeDrive = require('./fake-drive-server');
const WEB = path.join(__dirname, '..'), APP = path.join(WEB, '..', 'budget-app'), TOPIC = path.join(WEB, '..', '..');
const ARG = a => process.argv.includes(a);
const REPORT = path.join(TOPIC, 'דוחות', 'בדיקת האפליקציה.html');
const REAL_FILE = path.join(process.env.APPDATA || '', 'תקציב שנתי', 'budget.json');
const TOTAL_FILE = path.join(os.tmpdir(), 'budget-web-test-total.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const C = require(path.join(WEB, 'calc.js'));
const MN = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

/* ---------------- results + live page ---------------- */
const events = [], clients = new Set();
function emit(e) { events.push(e); const s = 'data: ' + JSON.stringify(e) + '\n\n'; for (const c of clients) c.write(s); }
let group = '', nFail = 0, nWarn = 0, nPass = 0;
const setGroup = g => { group = g; emit({ type: 'group', group: g }); };
// fn returns: nothing / a string (detail) / { warn: 'text', detail } / { skip: 'why' }. Throwing = failure (message = technical detail).
async function check(name, why, fn) {
  emit({ type: 'now', name: group + ' › ' + name });
  const t0 = Date.now(); let r, status = 'pass', detail = '', tech = '';
  try { r = await fn(); } catch (e) { status = 'fail'; tech = String(e && e.stack || e).split('\n').slice(0, 4).join('\n'); }
  if (r && typeof r === 'object') { if (r.warn) { status = 'warn'; why = r.warn; } if (r.skip) { status = 'skip'; detail = r.skip; } if (r.detail) detail = r.detail; if (r.tech) tech = r.tech; }
  else if (typeof r === 'string') detail = r;
  if (status === 'fail') nFail++; else if (status === 'warn') nWarn++; else if (status === 'pass') nPass++;
  emit({ type: 'result', group, name, status, why, detail, tech, ms: Date.now() - t0 });
  if (!ARG('--silent')) console.log({ pass: '✓', fail: '✗', warn: '⚠', skip: '–' }[status] + ' ' + group + ' › ' + name + (status === 'fail' ? ' — ' + tech.split('\n')[0] : status === 'warn' ? ' — ' + why : ''));
  return status === 'pass';
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const eqJ = (a, b, msg) => must(JSON.stringify(a) === JSON.stringify(b), msg + ': ' + JSON.stringify(a).slice(0, 200) + ' ≠ ' + JSON.stringify(b).slice(0, 200));

/* ---------------- servers ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const readBody = q => new Promise(r => { const a = []; q.on('data', c => a.push(c)); q.on('end', () => r(Buffer.concat(a))); });
// One app server = one origin (fresh browser storage). ?fd pages use the fake Drive; ?demo pages use demo.json.
function appServer(demoText) {
  const fd = FakeDrive.create();
  // The fake Drive has its own origin (like googleapis.com), so the service worker leaves it alone.
  const ds = http.createServer(async (q, r) => {
    r.setHeader('Access-Control-Allow-Origin', '*'); r.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); r.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH');
    if (q.method === 'OPTIONS') { r.writeHead(204); return r.end(); }
    const body = await readBody(q); if (!fd.handle(q, r, body)) { r.writeHead(404); r.end(); }
  }).listen(0, '127.0.0.1');
  return new Promise(res => {
    const s = http.createServer(async (q, r) => {
      const dBase = 'http://127.0.0.1:' + ds.address().port;
      const u = new URL(q.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
      let out = null;
      if (p === '/demo.json') out = demoText;
      else if (p === '/test/selftest.js') out = fs.readFileSync(path.join(APP, 'src', 'renderer', 'selftest.js'));
      else if (p === '/sw.js' && !/[?&]fd/.test(q.headers.referer || '')) out = ''; // the real service worker only in the Drive tests (opening offline)
      else if (p === '/test/fake-drive.js') out = 'window.__FD = ' + JSON.stringify(dBase) + ';\n' + fs.readFileSync(path.join(__dirname, 'fake-drive.js'), 'utf8');
      else if (p === '/index.html' && u.searchParams.has('fd')) out = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace('<script src="calc.js"></script>', '<script src="test/fake-drive.js"></script>\n<script src="calc.js"></script>').replace("connect-src 'self'", "connect-src 'self' " + dBase);
      else { const f = path.join(WEB, p); if (f.startsWith(WEB) && fs.existsSync(f) && fs.statSync(f).isFile()) out = fs.readFileSync(f); }
      if (out == null) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(out);
    }).listen(0, '127.0.0.1', () => res({ s, fd, base: `http://127.0.0.1:${s.address().port}/`, close: () => { s.close(); ds.close(); } }));
  });
}

/* ---------------- headless Chrome (DevTools protocol over WebSocket) ---------------- */
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe'].find(f => fs.existsSync(f));
let chromeProc, chromePort, chromeProf;
async function startChrome() {
  chromeProf = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));
  chromeProc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + chromeProf, '--no-first-run', '--disable-gpu', '--lang=he', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 150 && !chromePort; i++) { await sleep(100); try { chromePort = fs.readFileSync(path.join(chromeProf, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (_) { /* not yet */ } }
  must(chromePort, 'Chrome did not start');
}
async function stopChrome() { try { chromeProc.kill(); } catch (_) { /* gone */ } await sleep(500); try { fs.rmSync(chromeProf, { recursive: true, force: true }); } catch (_) { /* busy */ } }
async function newPage(width = 1280, mobile = false) {
  const t = await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const wait = new Map(), handlers = [];
  const P = { errors: [], badRequests: [], dialogs: [], chooser: null };
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); return; }
    if (d.method === 'Runtime.exceptionThrown') { const x = d.params.exceptionDetails; P.errors.push((x.exception && x.exception.description || x.text || '').split('\n')[0]); }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') P.errors.push('console: ' + d.params.args.map(a => a.value || a.description || '').join(' '));
    if (d.method === 'Network.responseReceived' && d.params.response.status >= 400 && !/\/drive\/v3\//.test(d.params.response.url)) P.badRequests.push(d.params.response.status + ' ' + d.params.response.url);
    if (d.method === 'Page.javascriptDialogOpening') { P.dialogs.push(d.params.message); P.send('Page.handleJavaScriptDialog', { accept: false }); }
    if (d.method === 'Page.fileChooserOpened') P.chooser = d.params;
    for (const h of handlers) h(d);
  };
  P.send = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  P.eval = async expr => {
    const r = await P.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('in page: ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  P.until = async (expr, ms = 8000, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await P.eval(expr); if (v) return v; } catch (_) { /* page loading */ } await sleep(100); } throw new Error('timeout: ' + (what || expr)); };
  P.size = async (w, mob) => P.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: !!mob });
  P.go = async (url, ready = 'window.__app && window.__app.S && document.querySelector("#main") && !/טוען|מתחבר/.test(document.querySelector("#main").textContent.slice(0,30))') => { await P.send('Page.navigate', { url }); await sleep(300); await P.until(ready, 15000, 'the app did not open'); await P.eval(HELPERS); await sleep(300); };
  P.reload = async () => P.go(await P.eval('location.href'));
  P.offline = async off => P.send('Network.emulateNetworkConditions', { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // Picks files in a file field (like the user choosing them), then the field reports the change.
  P.files = async (selector, paths) => P.eval(`(() => { const dt = new DataTransfer(); for (const [n, b] of ${JSON.stringify(paths.map(p => [path.basename(p), [...fs.readFileSync(p)]]))}) dt.items.add(new File([new Uint8Array(b)], n)); const i = document.querySelector(${JSON.stringify(selector)}); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  // A real mouse click (some actions, like opening a file chooser, only work after one).
  P.mouse = async selector => { const r = await P.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`); for (const type of ['mousePressed', 'mouseReleased']) await P.send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 }); await sleep(150); };
  P.close = () => { ws.close(); fetch(`http://127.0.0.1:${chromePort}/json/close/${t.id}`).catch(() => {}); };
  await P.send('Runtime.enable'); await P.send('Network.enable'); await P.send('Page.enable'); await P.send('DOM.enable');
  await P.size(width, mobile);
  return P;
}
// Helpers inside the page (same way the user would act: real clicks, typing, dialogs).
const HELPERS = `window.__t = {
  q: s => document.querySelector(s), qa: s => [...document.querySelectorAll(s)],
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async click(s) { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!e) throw new Error('not found: ' + s); e.click(); await this.sleep(80); },
  async tab(t) { await this.click('nav [data-tab="' + t + '"]'); await this.sleep(60); },
  async dlg(ok) { const t0 = Date.now(); while (document.querySelector('#modal').hidden) { if (Date.now() - t0 > 3000) throw new Error('no dialog'); await this.sleep(30); } const m = document.querySelector('#dlgMsg').textContent; await this.click(ok ? '#dlgOk' : '#dlgCancel'); await this.sleep(100); return m; },
  async closeDlgs() { while (!document.querySelector('#modal').hidden) { (document.querySelector('#dlgCancel:not([hidden])') || document.querySelector('#dlgOk')).click(); await this.sleep(60); } },
  async type(s, v) { const e = document.querySelector(s); if (!e) throw new Error('no field ' + s); e.focus(); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); await this.sleep(80); },
  async saved() { await window.__app.flushSave(); await this.sleep(150); },
  text: () => document.body.innerText
};true`;

/* ---------------- independent calculations (written separately from calc.js, from the rules) ---------------- */
const N = v => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const S_ = (a, f) => (a || []).reduce((s, x) => s + N(f(x)), 0);
function expected(m, incF) {
  const fx = m.fixed || [], tr = m.transfers || [], inc = m.income || [];
  const fixed = S_(fx.filter(x => x.kind !== 'saving'), x => x.monthly), saveDep = S_(fx.filter(x => x.kind === 'saving'), x => x.monthly);
  const cards = S_(m.cards, x => x.amount), trReg = S_(tr.filter(t => t.cat !== 'deposit'), x => x.amount), deposits = S_(tr.filter(t => t.cat === 'deposit'), x => x.amount);
  const internal = S_(inc.filter(x => x.internal), x => x.amount), incomeExt = S_(inc, x => x.amount) - internal;
  const totalExp = fixed + cards + trReg, netExt = incomeExt - totalExp, remainExt = netExt - Math.max(0, deposits - internal) - saveDep;
  const usdT = S_(m.investments, x => x.usd), portILS = usdT * N(m.rate), debts = S_(fx.filter(x => x.kind === 'loan'), x => x.balance);
  const savings = S_(m.savings, x => x.balance), fut = incF ? S_(m.future, x => x.amount) : S_((m.future || []).filter(x => x.inEquity), x => x.amount);
  return { fixed, saveDep, cards, trReg, deposits, internal, incomeExt, totalExp, netExt, remainExt, usdT, portILS, debts, savings, equity: savings + portILS - debts + fut };
}
function months(d) { const out = []; for (const y of Object.keys(d.years || {}).sort()) for (const k of Object.keys(d.years[y].months || {}).map(Number).sort((a, b) => a - b)) out.push({ y, k, m: d.years[y].months[k] }); return out; }

/* ---------------- the checks ---------------- */
async function filesChecks() {
  setGroup('קבצים ואתר');
  for (const f of ['app.js', 'calc.js', 'web-api.js', 'sw.js', 'register-sw.js', 'serve.js', 'test/run.js', 'test/fake-drive.js', 'test/fake-drive-server.js']) {
    await check('הקוד תקין: ' + f, 'יש שגיאת כתיבה בקוד, והאפליקציה עלולה לא להיפתח בכלל.', () => { try { execFileSync(process.execPath, ['--check', path.join(WEB, f)], { stdio: 'pipe' }); } catch (e) { throw new Error(String(e.stderr)); } });
  }
  await check('החישובים זהים בגרסת הדפדפן ובגרסת המחשב', 'קובץ החישובים שונה בין שתי הגרסאות, ולכן הבוט שבודק את המספרים במחשב עלול לחשב אחרת מהאפליקציה.', () => {
    const a = path.join(APP, 'src', 'renderer', 'calc.js'); if (!fs.existsSync(a)) return { skip: 'אין גרסת מחשב' };
    must(fs.readFileSync(a, 'utf8') === fs.readFileSync(path.join(WEB, 'calc.js'), 'utf8'), 'budget-app calc.js differs');
  });
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  await check('כל הקבצים שהדף טוען קיימים', 'חסר קובץ שהדף צריך, וחלק מהאפליקציה לא יעבוד.', () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]); const miss = refs.filter(r => !fs.existsSync(path.join(WEB, r.split("?")[0])));
    must(!miss.length, 'missing: ' + miss.join(', ')); return refs.length + ' קבצים';
  });
  await check('הגדרות האבטחה של הדף מאפשרות רק את Google Drive', 'הגדרות האבטחה של הדף השתנו: או שהחיבור ל-Drive ייחסם, או שהדף פתוח לאתרים אחרים.', () => {
    const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || ''; must(/connect-src 'self' https:\/\/www\.googleapis\.com;/.test(csp), csp); must(/script-src 'self';/.test(csp), 'script-src');
  });
  await check('קובץ ההתקנה בטלפון (manifest) תקין', 'אם הקובץ הזה לא תקין, לא אפשר יהיה להוסיף את האפליקציה למסך הבית בטלפון.', () => {
    const m = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.json'), 'utf8')); must(m.name && m.start_url && m.icons && m.icons.length, 'fields');
    const miss = m.icons.filter(i => !fs.existsSync(path.join(WEB, i.src))); must(!miss.length, 'icons: ' + miss.map(i => i.src));
  });
  await check('העבודה בלי אינטרנט: כל הקבצים לשמירה במכשיר קיימים', 'חסר קובץ ברשימה שנשמרת במכשיר, ולכן בלי אינטרנט האפליקציה עלולה לא להיפתח.', () => {
    const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8'); const list = JSON.parse((sw.match(/const FILES = (\[[^\]]+\])/) || [])[1].replace(/'/g, '"'));
    const miss = list.filter(f => f !== './' && !fs.existsSync(path.join(WEB, f))); must(!miss.length, miss.join(', '));
    const used = ['app.js', 'calc.js', 'web-api.js', 'styles.css', 'web.css']; const notIn = used.filter(f => !list.includes(f)); must(!notIn.length, 'not cached: ' + notIn);
  });
  await check('אין נתונים אישיים בקבצים הציבוריים', 'בקבצים שמתפרסמים באינטרנט נמצאו מספרים מהנתונים האמיתיים שלך, או כתובת מייל. Claude צריך להסיר אותם מיד.', () => {
    let tracked; try { tracked = execFileSync('git', ['ls-files'], { cwd: WEB }).toString().split('\n').filter(Boolean); } catch (_) { return { skip: 'אין git' }; }
    const nums = new Set();
    if (fs.existsSync(REAL_FILE)) JSON.stringify(JSON.parse(fs.readFileSync(REAL_FILE, 'utf8'))).replace(/\d{3,}\.\d{2}\b/g, n => nums.add(n));
    const hits = [];
    for (const f of tracked) {
      if (/\.(png|ico)$/.test(f)) continue; const t = fs.readFileSync(path.join(WEB, f), 'utf8');
      if (/[a-z0-9.]+@(gmail|walla|yahoo|hotmail)\./i.test(t)) hits.push(f + ': email');
      for (const n of nums) if (t.includes(n)) { hits.push(f + ': ' + n); break; }
    }
    must(!hits.length, hits.join(', ')); return `${tracked.length} קבצים נסרקו מול ${nums.size} מספרים`;
  });
  await check('האתר באינטרנט מעודכן לגרסה האחרונה', 'האתר שאתה פותח בטלפון ובמחשב עדיין לא קיבל את השינויים האחרונים. בדרך כלל זה מתעדכן לבד בתוך כמה דקות.', async () => {
    let head; try { head = f => execFileSync('git', ['show', 'HEAD:' + f], { cwd: WEB }).toString(); } catch (_) { return { skip: 'אין git' }; }
    const diff = [], local = [];
    for (const f of ['app.js', 'calc.js', 'web-api.js', 'index.html', 'web.css', 'styles.css', 'sw.js']) {
      const n = s => s.replace(/\r\n/g, '\n');
      let live; try { live = await (await fetch('https://amitbusi10-pixel.github.io/budget-web/' + f, { cache: 'no-store' })).text(); } catch (_) { return { skip: 'אין אינטרנט' }; }
      if (n(live) !== n(head(f))) diff.push(f);
      if (n(fs.readFileSync(path.join(WEB, f), 'utf8')) !== n(head(f))) local.push(f);
    }
    if (local.length) return { warn: 'יש שינויים במחשב שעוד לא פורסמו לאתר: ' + local.join(', ') + '. זה תקין באמצע עבודה, אבל צריך לפרסם אותם בסוף.' };
    if (diff.length) return { warn: 'האתר עוד לא התעדכן: ' + diff.join(', ') + '. בדרך כלל זה מתעדכן לבד בתוך כמה דקות.' };
  });
}

async function calcChecks(sets) {
  setGroup('חישובים');
  await check('בדיקות החישוב הקבועות (מאות מקרים)', 'אחד החישובים הבסיסיים (סיכום חודש, הון עצמי, סיכום שנה) נותן תוצאה אחרת ממה שצריך.', () => {
    if (!fs.existsSync(path.join(APP, 'test', 'calc.test.js'))) return { skip: 'לא נמצא' };
    let r; try { r = execFileSync(process.execPath, ['test/calc.test.js'], { cwd: APP, stdio: 'pipe' }).toString(); } catch (e) { throw new Error(String(e.stdout || e).slice(-500)); }
    const m = r.match(/calc: (\d+) passed, (\d+) failed/); must(m && m[2] === '0', r.slice(-300)); return m[1] + ' מקרים עברו';
  });
  for (const [label, d] of sets) {
    for (const incF of [false, true]) {
      await check(`${label}: כל סיכום בכל חודש, חישוב שני ונפרד` + (incF ? ' (עם כספים עתידיים בהון)' : ''), 'בחודש מסוים הסיכומים (הוצאות, נשאר, הון עצמי וכדומה) לא יוצאים כמו בחישוב ידני של השורות. אז המספר שמוצג לך שגוי.', () => {
        const bad = []; let n = 0;
        for (const { y, k, m } of months(d)) {
          const c = C.calc(m, incF), e = expected(m, incF);
          for (const key of Object.keys(e)) { n++; if (Math.abs(r2(c[key]) - r2(e[key])) > 0.011) bad.push(`${MN[k - 1]} ${y} ${key}: ${r2(c[key])} ≠ ${r2(e[key])}`); }
        }
        must(!bad.length, bad.slice(0, 8).join('\n')); return n + ' מספרים הושוו';
      });
    }
    await check(`${label}: הסיכום השנתי = סכום החודשים`, 'הסיכום השנתי לא שווה לסכום של החודשים. אז המסך "סיכום שנתי" מציג מספרים לא נכונים.', () => {
      const bad = [];
      for (const y of Object.keys(d.years || {})) {
        const s = C.yearSummary(d.years[y], false); if (s.empty) continue;
        const act = s.act; const sum = f => r2(act.reduce((a, x) => a + f(C.calc(x.m, false)), 0));
        if (Math.abs(r2(s.tInc) - sum(c => c.incomeExt)) > 0.02) bad.push(y + ' הכנסות');
        if (Math.abs(r2(s.tExp) - sum(c => c.totalExp)) > 0.02) bad.push(y + ' הוצאות');
        if (Math.abs(r2(s.tDep) - sum(c => c.deposits)) > 0.02) bad.push(y + ' הפקדות');
        if (Math.abs(r2(s.tRemain) - r2(s.tNet - s.tDep - sum(c => c.saveDep || 0))) > 0.02) bad.push(y + ' נשאר');
      }
      must(!bad.length, bad.join(', '));
    });
  }
  await check('תיק אינטראקטיב: "שווי עכשיו" הוא החודש האחרון שעודכן', 'הכרטיס של התיק מציג ערך מחודש ישן, ולא את המספר האחרון שהזנת.', () => {
    const mk = usd => ({ investments: [{ name: 'Interactive', usd }], transfers: [], rate: 3 });
    const p = C.portfolioSeries({ openUsd: 90000, months: { 9: mk(95000), 10: mk(100000), 11: mk(101000), 12: mk(101000) } }, 2026, new Date(2026, 10, 5));
    eqJ([p.lastReal.k, p.lastReal.usd, p.gainReal], [11, 101000, 11000], 'latest');
    const q = C.portfolioSeries({ openUsd: 90000, months: { 9: mk(95000), 10: mk(95000) } }, 2026, new Date(2026, 10, 5));
    eqJ(q.lastReal.k, 9, 'no change → first month with that value');
  });
  await check('הפקדה חודשית לחיסכון לא נספרת כהוצאה', 'העברה לחיסכון (למשל לקופת גמל) נספרת כהוצאה, למרות שהכסף עדיין שלך.', () => {
    const m = { rate: 3, fixed: [{ kind: 'standing', monthly: 100 }, { kind: 'saving', monthly: 1000 }, { kind: 'loan', monthly: 500, balance: 9000 }], cards: [], transfers: [], income: [{ amount: 5000 }], future: [], savings: [], investments: [] };
    const c = C.calc(m, false); eqJ([c.fixed, c.totalExp, c.netExt, c.remainExt, c.saveDep, c.debts], [600, 600, 4400, 3400, 1000, 9000], 'saving');
  });
  await check('העברה פנימית לא נספרת כהכנסה', 'כסף שהעברת בין החשבונות שלך נספר כהכנסה, וזה מנפח את ההכנסות.', () => {
    const m = { rate: 3, fixed: [], cards: [], transfers: [{ cat: 'deposit', amount: 3000 }], income: [{ amount: 10000 }, { amount: 2000, internal: true }], future: [], savings: [], investments: [] };
    const c = C.calc(m, false); eqJ([c.incomeExt, c.netExt, c.remainExt], [10000, 10000, 9000], 'internal');
  });
  await check('פתיחת חודש חדש ממשיכה נכון מהחודש הקודם', 'כשפותחים חודש חדש, יתרות ההלוואות או החסכונות לא ממשיכות נכון מהחודש הקודם.', () => {
    const prev = { rate: 3.2, period: '', asOf: '', fixed: [{ kind: 'loan', name: 'L', monthly: 500, balance: 10000 }], cards: [{ name: 'כ', amount: 900 }], transfers: [{ name: 't', amount: 5 }], income: [{ source: 'x', amount: 7000 }], future: [], savings: [{ name: 'קרן', kind: 'fund', monthly: 300, balance: 2000 }], investments: [{ name: 'IB', usd: 1000 }] };
    const n = C.deriveMonth(prev);
    must(n.fixed[0].balance === 9500, 'loan balance ' + n.fixed[0].balance); must(n.cards[0].amount === 0 || n.cards[0].amount === null || n.cards[0].amount === '', 'card amount kept ' + n.cards[0].amount);
    must(!(n.transfers || []).length, 'transfers kept'); must(N(n.savings[0].balance) === 2000 && n.savings[0].monthly == null, 'savings ' + JSON.stringify(n.savings[0])); must(n.investments[0].usd === 1000, 'investments');
  });
}

function dataChecks(label, d) {
  setGroup('בדיקת הנתונים (' + label + ')');
  const ms = months(d), warn = [];
  return (async () => {
    await check('שער הדולר בכל חודש סביר (בין 2.5 ל-5)', '', () => { const b = ms.filter(x => (x.m.investments || []).length && !(N(x.m.rate) >= 2.5 && N(x.m.rate) <= 5)).map(x => MN[x.k - 1] + ' ' + x.y + ': ' + x.m.rate); if (b.length) return { warn: 'שער דולר חסר או לא סביר ב: ' + b.join(', ') + '. בדוק אותו מול השער היציג.' }; });
    await check('אין סכומים שליליים או לא מספריים', '', () => {
      const b = [];
      for (const { y, k, m } of ms) for (const [sec, f] of [['fixed', 'monthly'], ['cards', 'amount'], ['transfers', 'amount'], ['income', 'amount'], ['savings', 'balance'], ['investments', 'usd']])
        (m[sec] || []).forEach((r, i) => { const v = r[f]; if (v != null && v !== '' && (!isFinite(parseFloat(String(v).replace(/,/g, ''))) || N(v) < 0)) b.push(`${MN[k - 1]} ${y} ${sec} שורה ${i + 1}: ${v}`); });
      if (b.length) return { warn: 'נמצאו ערכים חשודים: ' + b.slice(0, 6).join(' · ') };
      return ms.length + ' חודשים';
    });
    await check('יתרת כל הלוואה יורדת בכל חודש בגובה התשלום', '', () => {
      const b = [];
      for (let i = 1; i < ms.length; i++) for (const L of (ms[i].m.fixed || []).filter(f => f.kind === 'loan' && f.balance != null && f.balance !== '')) {
        const p = (ms[i - 1].m.fixed || []).find(f => f.kind === 'loan' && f.name === L.name); if (!p || p.balance == null || p.balance === '') continue;
        if (Math.abs(r2(N(p.balance) - N(L.monthly)) - r2(N(L.balance))) > 1) b.push(`${L.name || 'הלוואה'} ב${MN[ms[i].k - 1]}: ${p.balance} − ${L.monthly} ≠ ${L.balance}`);
      }
      if (b.length) return { warn: 'יתרת הלוואה לא מסתדרת: ' + b.slice(0, 4).join(' · ') + '. ייתכן שזה בגלל תשלום מיוחד.' };
    });
    await check('הפקדות לחיסכון מסומנות כחיסכון ולא כהוצאה', '', () => {
      const b = []; for (const { y, k, m } of ms) (m.fixed || []).forEach(f => { if (f.kind !== 'saving' && /גמל|השתלמות|פנסיה|חיסכון/.test((f.name || '') + ' ' + (f.desc || ''))) b.push(`${MN[k - 1]} ${y}: ${f.name} ${f.desc || ''}`); });
      if (b.length) return { warn: 'שורות שנראות כמו חיסכון אבל נספרות כהוצאה קבועה: ' + b.slice(0, 5).join(' · ') + '. אפשר לשנות את הסוג שלהן ל"חיסכון".' };
    });
    await check('בכל חודש שנפתח יש הכנסה', '', () => { const b = ms.filter(x => !C.calc(x.m, false).incomeExt && C.calc(x.m, false).totalExp).map(x => MN[x.k - 1] + ' ' + x.y); if (b.length) return { warn: 'חודשים עם הוצאות ובלי הכנסה: ' + b.join(', ') + '. אם זה חודש שעוד לא מולא, זה בסדר.' }; });
    await check('אין שורות כפולות באשראי', '', () => {
      const b = []; for (const { y, k, m } of ms) { const seen = {}; (m.cards || []).forEach(c => { const key = c.name + '|' + c.amount; if (N(c.amount) && seen[key]) b.push(`${MN[k - 1]} ${y}: ${c.name} ${c.amount}`); seen[key] = 1; }); }
      if (b.length) return { warn: 'אותו כרטיס עם אותו סכום מופיע פעמיים: ' + b.join(' · ') };
    });
    void warn;
  })();
}

async function screenChecks(label, dataText, quick) {
  for (const [vw, view, w] of [['מחשב', 'pc', 1280], ['טלפון', 'phone', 500]]) {
    setGroup(`מסך ${vw} (${label})`);
    const srv = await appServer(dataText), P = await newPage(w, view === 'phone');
    try {
      let t0 = Date.now();
      await check('האפליקציה נפתחת', 'האפליקציה לא נפתחת עם הנתונים האלה.', async () => { await P.go(srv.base + `?demo&view=${view}`); return ((Date.now() - t0) / 1000).toFixed(1) + ' שניות'; });
      const tabs = await P.eval(`__t.qa('nav [data-tab]').map(b => b.dataset.tab)`);
      await check('כל הלשוניות נפתחות, בלי "NaN", "undefined" או ריק במקום מספר', 'באחת הלשוניות מופיע מספר שבור (למשל NaN או undefined) במקום ערך.', async () => {
        const bad = [];
        for (const t of tabs) { await P.eval(`__t.tab('${t}')`); const tx = await P.eval(`document.querySelector('#main').innerText`); const m = tx.match(/NaN|undefined|Infinity|\[object Object\]|null ₪/); if (m) bad.push(t + ': ' + m[0]); if (!tx.trim()) bad.push(t + ': ריק'); }
        must(!bad.length, bad.join(', ')); return tabs.length + ' לשוניות';
      });
      await check('אין גלילה לרוחב באף לשונית', 'בחלק מהמסכים התוכן רחב מהמסך, וצריך לגלול הצידה.', async () => {
        const bad = []; for (const t of tabs) { await P.eval(`__t.tab('${t}')`); if (await P.eval('document.documentElement.scrollWidth > innerWidth + 1')) bad.push(t); }
        must(!bad.length, 'tabs: ' + bad.join(', '));
      });
      await check(view === 'phone' ? 'תצוגת טלפון פעילה (כרטיסים)' : 'תצוגת מחשב פעילה (טבלאות)', 'מצב התצוגה לא תואם את ההגדרה.', async () => { must(await P.eval(`document.body.classList.contains('mob')`) === (view === 'phone'), 'body.mob'); });
      await check('כל מספר על המסך זהה לחישוב (כל חודש)', 'המספר שמוצג במסך שונה ממה שהחישוב נותן.', async () => {
        const bad = await P.eval(`(async () => { const bad = []; const fmt = n => { const x = Math.round((n + Number.EPSILON) * 100) / 100; return (x === 0 ? 0 : x).toLocaleString('he-IL', { maximumFractionDigits: 2 }) + ' ₪'; };
          const S = __app.S; for (const k of Object.keys(S.years[__app.ui.year].months)) { await __t.tab(k); const c = __app.calc(S.years[__app.ui.year].months[k]);
            for (const [id, v] of [['totalExp', c.totalExp], ['income', c.incomeExt], ['net', c.netExt], ['remain', c.remainExt], ['equity', c.equity]]) { const e = document.querySelector('[data-kpi="' + id + '"] b'); if (!e) bad.push(k + ' ' + id + ' missing'); else if (e.textContent !== fmt(v)) bad.push(k + ' ' + id + ': ' + e.textContent + ' ≠ ' + fmt(v)); } } return bad; })()`);
        must(!bad.length, bad.slice(0, 6).join('\n'));
      });
      if (!quick) {
        await check('בדיקת כל משבצת, כפתור, ביטול/חזרה, איפוס ושנה חדשה (הבדיקה הארוכה)', 'אחד הכפתורים או אחת המשבצות לא עובדים כמו שצריך.', async () => {
          await P.eval(`(async () => { const s = document.createElement('script'); s.src = 'test/selftest.js'; document.head.appendChild(s); await new Promise(r => s.onload = r); window.api.selftestDone = r => { window.__selftestResult = r; }; __app.flushSave(); window.__runSelftest('audit'); return true; })()`);
          const r = await P.until('window.__selftestResult', 900000, 'self-test');
          const skip = /ייצוא גיבוי|העתקת גיבוי|ייבוא מקובץ|ייבוא טקסט|שחזור מרשימת|פתיחת תיקיית|גיבוי לענן|אין פניות לרשת/; // checked separately with the fake Drive
          const bad = r.results.filter(s => !s.ok && !skip.test(s.name)); must(!bad.length, bad.map(s => s.name + ': ' + s.error).join('\n'));
          return r.results.filter(s => !skip.test(s.name)).length + ' חלקים, כל אחד עם עשרות בדיקות';
        });
        await check('לחיצה על כל כפתור בכל לשונית לא גורמת לשגיאה', 'לחיצה על אחד הכפתורים גורמת לשגיאה באפליקציה.', async () => {
          const r = await P.eval(`(async () => { const tabs = __t.qa('nav [data-tab]').map(b => b.dataset.tab); let n = 0; const before = window.__errs = [];
            window.addEventListener('error', e => before.push(String(e.message)));
            for (const t of tabs) { await __t.tab(t); const ids = __t.qa('#main button, #main input[type=checkbox], header button').filter(b => b.offsetParent && !/mirChoose|gbtn|mirOpen|openDir/.test(b.id)).map((b, i) => i);
              for (const i of ids) { const b = __t.qa('#main button, #main input[type=checkbox], header button').filter(b => b.offsetParent && !/mirChoose|gbtn|mirOpen|openDir/.test(b.id))[i]; if (!b) continue; b.click(); n++; await __t.sleep(40); await __t.closeDlgs(); if (document.querySelector('nav [data-tab="' + t + '"]:not(.on)')) await __t.tab(t); } }
            return { n, errs: before }; })()`);
          must(!r.errs.length, r.errs.join(' | ')); return r.n + ' לחיצות';
        });
      }
      await check('אין שגיאות סקריפט ואין קבצים חסרים', 'בזמן השימוש באפליקציה הופיעה שגיאה פנימית.', () => { must(!P.errors.length && !P.badRequests.length, [...P.errors, ...P.badRequests].slice(0, 5).join('\n')); });
    } finally { P.close(); srv.close(); }
  }
}

// Google Drive, sync, backups, documents, reminders and settings — against the fake Drive.
async function driveChecks(dataText) {
  const data = JSON.parse(dataText);
  const srv = await appServer(dataText), fd = srv.fd;
  const now = new Date(), pad = n => String(n).padStart(2, '0'), day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // Drive as it looks after months of use: data + old backups (to test the automatic cleanup).
  const root = fd.folder('תקציב שנתי'), bk = fd.folder('גיבויים', root.id);
  const dataFile = fd.add({ name: 'budget.json', parents: [root.id], body: Buffer.from(dataText) });
  const old = [];
  for (let i = 1; i <= 200; i++) { const d = new Date(now); d.setDate(d.getDate() - i); old.push(`budget-${day(d)}.json`); }
  for (let i = 5; i <= 200; i += 15) { const d = new Date(now); d.setDate(d.getDate() - i); old.push(`budget-${day(d)}_10-00-00-before-update.json`); }
  old.push('הערות שלי.txt');
  for (const n of old) fd.add({ name: n, parents: [bk.id], body: Buffer.from(dataText) });
  // what must stay (written from the rules, separately from the app's code)
  const keepExp = new Set(old.filter(n => {
    const m = n.match(/^budget-(\d{4}-\d{2}-\d{2})/); if (!m) return true;
    const age = (now - new Date(m[1] + 'T12:00:00')) / 864e5, tagged = !/^budget-\d{4}-\d{2}-\d{2}\.json$/.test(n);
    const firstOfMonth = old.filter(x => /^budget-\d{4}-\d{2}-\d{2}/.test(x) && x.slice(7, 14) === m[1].slice(0, 7)).sort()[0] === n;
    return age <= 14 || (tagged && age <= 90) || firstOfMonth;
  }));
  const driveData = () => JSON.parse(fd.find(dataFile.id).body.toString());
  const bkNames = all => fd.children(bk, all).filter(f => !all || f.trashed).map(f => f.name);
  const P = await newPage(1280);
  const firstMonth = () => P.eval(`Object.keys(__app.S.years[__app.ui.year].months)[0]`);
  const editSel = k => `[data-k="cards|0|amount"]`;
  try {
    setGroup('Google Drive וסנכרון');
    await check('האפליקציה נטענת מה-Drive', 'האפליקציה לא קוראת את הנתונים מה-Drive. אז מכשיר חדש לא יראה את הנתונים שלך.', async () => {
      await P.go(srv.base + '?fd'); const got = JSON.parse(await P.eval('JSON.stringify(__app.S.years)'));
      // the savings chain is recalculated on opening, so compare the rows the user typed
      const pick = d => Object.fromEntries(Object.entries(d).map(([y, v]) => [y, Object.fromEntries(Object.entries(v.months).map(([k, m]) => [k, [m.fixed, m.cards, m.income, m.transfers, m.investments, m.rate]]))]));
      eqJ(pick(got), pick(data.years), 'data');
    });
    await check('מוצג "מחובר ל-Google Drive"', 'שורת המצב לא מראה שהאפליקציה מחוברת.', async () => { must(/מחובר/.test(await P.eval(`document.querySelector('#status').textContent`)), await P.eval(`document.querySelector('#status').textContent`)); });
    const k = await firstMonth();
    await check('שינוי נשמר ב-Drive תוך שניות', 'מה שאתה משנה לא נשמר ב-Drive, ולכן הוא לא יגיע למכשיר השני.', async () => {
      const v0 = fd.find(dataFile.id).version;
      await P.eval(`__t.tab('${k}')`); await P.eval(`__t.tab('${k}').then(() => __t.type('${editSel(k)}', '1234.5'))`); await P.eval('__t.saved()'); await sleep(500);
      const dd = driveData(); must(N(dd.years[Object.keys(dd.years)[0]].months[k].cards[0].amount) === 1234.5, 'value in Drive');
      must(fd.find(dataFile.id).version > v0, 'version');
      must(/נשמר וסונכרן/.test(await P.eval(`document.querySelector('#status').textContent`)), 'status');
    });
    await check('אחרי טעינה מחדש השינוי עדיין שם', 'אחרי סגירה ופתיחה מחדש השינוי נעלם.', async () => { await P.reload(); must(N(await P.eval(`__app.S.years[__app.ui.year].months[${k}].cards[0].amount`)) === 1234.5, 'after reload'); });
    await check('שינוי ממכשיר אחר מופיע כאן לבד', 'שינוי שעשית בטלפון לא מופיע במחשב (או להפך).', async () => {
      const d2 = driveData(); const y = Object.keys(d2.years)[0]; d2.years[y].months[k].cards[0].amount = 777; fd.remoteEdit(fd.find(dataFile.id), JSON.stringify(d2));
      await P.eval(`document.dispatchEvent(new Event('visibilitychange')); true`);
      await P.until(`Number(__app.S.years[__app.ui.year].months[${k}].cards[0].amount) === 777`, 8000, 'remote change');
      must(/ממכשיר אחר/.test(await P.eval(`document.querySelector('#status').textContent`)), 'status');
    });
    await check('בלי אינטרנט: השינוי נשמר במכשיר, ונשלח ל-Drive כשהחיבור חוזר', 'שינוי שנעשה בלי אינטרנט הולך לאיבוד, או לא נשלח כשהחיבור חוזר.', async () => {
      await P.offline(true); await P.eval(`__t.tab('${k}').then(() => __t.type('${editSel(k)}', '555'))`); await P.eval('__t.saved()');
      must(/אין חיבור/.test(await P.eval(`(document.querySelector('#syncbar')||{}).textContent||''`)), 'offline bar');
      must(N(driveData().years[Object.keys(data.years)[0]].months[k].cards[0].amount) === 777, 'Drive must not change while offline');
      await P.reload(); must(N(await P.eval(`__app.S.years[__app.ui.year].months[${k}].cards[0].amount`)) === 555, 'kept on device after reopening offline');
      await P.offline(false); await P.eval(`window.dispatchEvent(new Event('online')); true`);
      const t0 = Date.now(); while (N(driveData().years[Object.keys(data.years)[0]].months[k].cards[0].amount) !== 555) { must(Date.now() - t0 < 8000, 'not synced after coming back online'); await sleep(200); }
    });
    await check('שינוי בשני מכשירים באותו זמן: שני העותקים נשמרים', 'כששני מכשירים משנים באותו זמן, אחד השינויים הולך לאיבוד.', async () => {
      await P.offline(true); await P.eval(`__t.tab('${k}').then(() => __t.type('${editSel(k)}', '111'))`); await P.eval('__t.saved()');
      const d2 = driveData(); d2.years[Object.keys(d2.years)[0]].months[k].cards[0].amount = 222; fd.remoteEdit(fd.find(dataFile.id), JSON.stringify(d2));
      await P.offline(false); await P.eval(`window.dispatchEvent(new Event('online')); true`); await sleep(2000);
      must(N(driveData().years[Object.keys(data.years)[0]].months[k].cards[0].amount) === 111, 'this device wins');
      const cf = fd.children(bk).find(f => /-conflict\.json$/.test(f.name)); must(cf, 'conflict backup'); must(N(JSON.parse(cf.body.toString()).years[Object.keys(data.years)[0]].months[k].cards[0].amount) === 222, 'other copy saved');
      must(/שני העותקים/.test(await P.eval(`document.body.innerText`)), 'message to the user');
      await P.eval(`(document.querySelector('#noticeX')||{click(){}}).click(); true`);
    });
    await check('כשההתחברות ל-Google פגה: הנתונים נשמרים במכשיר ומוצג כפתור התחברות', 'כשההתחברות ל-Google פגה, שינויים הולכים לאיבוד או שלא רואים שצריך להתחבר מחדש.', async () => {
      fd.setMode('401'); await P.eval(`__t.tab('${k}').then(() => __t.type('${editSel(k)}', '333'))`); await P.eval('__t.saved()'); await sleep(300);
      must(/להתחבר/.test(await P.eval(`(document.querySelector('#syncbar')||{}).textContent||''`)), 'sign-in bar');
      fd.setMode('ok'); await P.eval(`localStorage.setItem('bw-tok', JSON.stringify({ t: 'x', exp: Date.now() + 864e5 })); true`); await P.reload(); await sleep(2200);
      must(N(driveData().years[Object.keys(data.years)[0]].months[k].cards[0].amount) === 333, 'synced after signing in again');
    });
    await check('תקלה זמנית ב-Drive לא שוברת את האפליקציה', 'תקלה רגעית אצל Google גורמת לשגיאה או לאיבוד שינוי.', async () => {
      fd.setMode('500'); await P.eval(`__t.tab('${k}').then(() => __t.type('${editSel(k)}', '444'))`); await P.eval('__t.saved()');
      must(/במכשיר|חיבור/.test(await P.eval(`document.querySelector('#status').textContent + ((document.querySelector('#syncbar')||{}).textContent||'')`)), 'status');
      fd.setMode('ok'); await P.eval(`window.dispatchEvent(new Event('online')); true`); await sleep(1500);
      must(N(driveData().years[Object.keys(data.years)[0]].months[k].cards[0].amount) === 444, 'synced after the error');
    });
    // put the data back as it was
    await P.eval(`(async () => { const d = ${JSON.stringify(dataText)}; window.__app.S; return true; })()`);
    fd.remoteEdit(fd.find(dataFile.id), dataText); await P.reload();

    setGroup('גיבויים');
    await check('נוצר גיבוי יומי אחד, עם השם של היום', 'לא נוצר גיבוי של היום. אם משהו יימחק, אין ממה לשחזר.', async () => {
      const t0 = Date.now(); while (!bkNames().includes(`budget-${day(now)}.json`)) { must(Date.now() - t0 < 6000, 'no daily backup'); await sleep(200); }
      return `budget-${day(now)}.json`;
    });
    await check('שמירות נוספות באותו יום לא יוצרות עוד קבצים', 'כל שינוי יוצר קובץ גיבוי חדש, והתיקייה תתמלא בקבצים מיותרים.', async () => {
      await P.eval(`window.api.backupNow(null)`); await P.eval(`window.api.backupNow(null)`); eqJ(bkNames().filter(n => n.includes(day(now)) && !/_/.test(n)).length, 1, 'files of today');
    });
    await check('גיבוי עם תגית לפני עדכון נוצר בנפרד', 'הגיבוי שנשמר לפני העדכון החודשי לא נוצר.', async () => { const r = await P.eval(`window.api.backupNow('before-update')`); must(r.name && /-before-update\.json$/.test(r.name) && bkNames().includes(r.name), JSON.stringify(r)); });
    await check('הניקוי האוטומטי משאיר בדיוק את מה שצריך', 'הניקוי האוטומטי של הגיבויים מוחק גיבוי שצריך לשמור, או משאיר יותר מדי.', async () => {
      const t0 = Date.now(); while (old.some(n => !keepExp.has(n) && bkNames().includes(n))) { must(Date.now() - t0 < 8000, 'cleanup did not run'); await sleep(300); }
      const kept = old.filter(n => bkNames().includes(n)), missing = [...keepExp].filter(n => !kept.includes(n)), extra = kept.filter(n => !keepExp.has(n));
      must(!missing.length && !extra.length, 'missing: ' + missing.slice(0, 5) + ' extra: ' + extra.slice(0, 5));
      return `${old.length} גיבויים ישנים: ${kept.length} נשארו, ${old.length - kept.length} עברו לסל`;
    });
    await check('גיבויים שנמחקו עברו לסל של Drive (אפשר לשחזר 30 יום)', 'הניקוי מוחק גיבויים לגמרי, במקום להעביר אותם לסל.', () => { const trashed = bkNames(true); must(trashed.length === old.length - old.filter(n => keepExp.has(n)).length, trashed.length + ' in trash'); });
    await check('קובץ שלא שייך לאפליקציה בתיקיית הגיבויים לא נמחק', 'הניקוי מחק קובץ שלך שלא קשור לאפליקציה.', () => { must(bkNames().includes('הערות שלי.txt'), 'deleted'); });
    await check('רשימת הגיבויים מוצגת בהגדרות', 'בהגדרות לא רואים את רשימת הגיבויים, ולכן אי אפשר לשחזר.', async () => {
      await P.eval(`__t.tab('settings')`); await P.eval('__app.refreshBackups()'); await sleep(400);
      const n = await P.eval(`__t.qa('[data-restore]').length`); must(n >= 10, n + ' rows'); return n + ' גיבויים ברשימה';
    });
    await check('שחזור מגיבוי: "ביטול" לא משנה, "אישור" משחזר, ו-↶ מחזיר', 'שחזור מגיבוי לא עובד כמו שצריך.', async () => {
      const name = await P.eval(`__t.qa('[data-restore]').map(b => b.dataset.restore).find(n => /-before-update/.test(n))`);
      const f = fd.children(bk).find(x => x.name === name); const alt = JSON.parse(f.body.toString()); const y = Object.keys(alt.years)[0]; alt.years[y].months[k].cards[0].amount = 9999; f.body = Buffer.from(JSON.stringify(alt));
      const before = await P.eval('JSON.stringify(__app.S)');
      await P.eval(`__t.click('[data-restore="${name}"]')`); await P.eval('__t.dlg(false)'); must(await P.eval('JSON.stringify(__app.S)') === before, 'cancel changed data');
      await P.eval(`__t.click('[data-restore="${name}"]')`); await P.eval('__t.dlg(true)'); await sleep(500); await P.eval('__t.closeDlgs()');
      must(N(await P.eval(`__app.S.years[${y}].months[${k}].cards[0].amount`)) === 9999, 'not restored');
      await P.eval(`__t.click('#undo')`); must(await P.eval('JSON.stringify(__app.S)') === before, 'undo');
    });
    await check('ייצוא גיבוי לקובץ: נשמר קובץ תקין עם כל הנתונים', 'כפתור הייצוא לא שומר קובץ גיבוי תקין.', async () => {
      // catches the file the browser would save (name + content)
      await P.eval(`(() => { window.__dl = null; const oc = URL.createObjectURL; URL.createObjectURL = b => { window.__blob = b; return oc(b); }; const o = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { const n = this.download; window.__blob.text().then(t => { window.__dl = { n, t }; }); return; } return o.call(this); }; return true; })()`);
      await P.eval(`__t.tab('settings').then(() => __t.click('#exportBk'))`); const dl = await P.until('window.__dl', 5000, 'no file'); await P.eval('__t.closeDlgs()');
      must(/^budget-.*.json$/.test(dl.n), dl.n); eqJ(JSON.parse(dl.t).years, JSON.parse(await P.eval('JSON.stringify(__app.S)')).years, 'content');
    });
    await check('העתקת גיבוי כטקסט = כל הנתונים', 'הטקסט שמועתק לגיבוי לא שלם.', async () => { await P.eval(`__t.tab('settings').then(() => __t.click('[data-copy]'))`); await P.eval('__t.closeDlgs()'); eqJ(JSON.parse(await P.eval(`document.querySelector('#bkout').value`)).years, JSON.parse(await P.eval('JSON.stringify(__app.S)')).years, 'text'); });
    await check('ייבוא מקובץ: עם אישור, ו-↶ מבטל', 'ייבוא נתונים מקובץ גיבוי לא עובד.', async () => {
      const before = await P.eval('JSON.stringify(__app.S)'); const alt = JSON.parse(before); const y = Object.keys(alt.years)[0]; alt.years[y].months[k].cards[0].amount = 4242;
      const f = path.join(os.tmpdir(), 'bw-import-test.json'); fs.writeFileSync(f, JSON.stringify(alt));
      await P.send('Page.setInterceptFileChooserDialog', { enabled: true }); P.chooser = null;
      await P.eval(`__t.tab('settings')`); await P.mouse('#impfile'); const t0 = Date.now(); while (!P.chooser) { must(Date.now() - t0 < 3000, 'no file chooser'); await sleep(50); }
      await P.send('DOM.setFileInputFiles', { backendNodeId: P.chooser.backendNodeId, files: [f] }); await sleep(400); await P.eval('__t.dlg(true)'); await sleep(400); await P.eval('__t.closeDlgs()');
      must(N(await P.eval(`__app.S.years[${y}].months[${k}].cards[0].amount`)) === 4242, 'not imported');
      await P.eval(`__t.click('#undo')`); must(await P.eval('JSON.stringify(__app.S)') === before, 'undo'); fs.rmSync(f); await P.send('Page.setInterceptFileChooserDialog', { enabled: false });
    });
    await check('ייבוא טקסט לא תקין: הודעה ברורה, בלי שינוי בנתונים', 'הדבקת טקסט שבור מוחקת או משבשת את הנתונים.', async () => {
      const before = await P.eval('JSON.stringify(__app.S)'); await P.eval(`__t.tab('settings')`); await P.eval(`__t.type('#impt', '{ זה לא גיבוי')`); await P.eval(`__t.click('#impgo')`); const msg = await P.eval('__t.dlg(true)'); await P.eval('__t.closeDlgs()');
      must(await P.eval('JSON.stringify(__app.S)') === before, 'data changed'); return 'ההודעה: ' + msg.slice(0, 60);
    });
    await check('כפתור "גבה וסנכרן עכשיו" עובד', 'הכפתור "גבה וסנכרן עכשיו" לא שומר גיבוי.', async () => {
      const f = () => fd.children(bk).find(x => x.name === `budget-${day(now)}.json`); const v0 = f().version;
      await P.eval(`__t.tab('settings').then(() => __t.click('#mirNow'))`); await sleep(1200); await P.eval('__t.closeDlgs()'); must(f().version > v0, 'daily backup not updated');
    });

    setGroup('מסמכים ותזכורות');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-docs-')), f1 = path.join(tmp, 'תלוש אוקטובר.pdf'), f2 = path.join(tmp, 'U1234_report.csv');
    fs.writeFileSync(f1, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 1, 2, 255, 254, 10, 13])); fs.writeFileSync(f2, 'Date,Value\n2026-10-31,100000\n');
    const due = await P.eval(`JSON.stringify(dueReminders(new Date()))`).then(JSON.parse);
    const ym = due.length ? due[0].ym : `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    if (due.length) await check('תזכורת להעלאת מסמכים מוצגת בזמן', 'התזכורת להעלאת המסמכים לא מופיעה, למרות שהגיע המועד.', async () => {
      await P.eval(`refreshReminders()`); await P.eval(`__t.tab('summary')`); must(await P.eval(`__t.qa('[data-rem]').length`) === due.length, 'banners'); return due.map(r => r.text).join(' · ');
    });
    else await check('תזכורת להעלאת מסמכים מוצגת בזמן', '', () => ({ skip: 'היום אין תזכורת פעילה (לפני ה-10 בחודש)' }));
    await check('אין תזכורת למסמכים אם כבר נרשם עדכון נתונים אחרי המועד', 'התזכורת מוצגת גם כשהחודש כבר עודכן (כמו אוקטובר, שעודכן ב-17.11), וזו תזכורת שגויה.', async () => {
      if (!due.some(r => r.kind === 'docs')) return { skip: 'אין תזכורת מסמכים היום' };
      const n = await P.eval(`(async () => { const old = S.updates, d = new Date(); S.updates = [{ n: 1, date: String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getFullYear() % 100), note: 'x' }]; await refreshReminders(); const c = reminders.filter(r => r.kind === 'docs').length; S.updates = old; await refreshReminders(); return c; })()`);
      must(n === 0, 'התזכורת הופיעה אף שנרשם עדכון');
    });
    await check('הכפתור "להעלאה" פותח את המסמכים בחודש הנכון', 'הכפתור בתזכורת לא מוביל למקום הנכון.', async () => {
      if (!due.length) return { skip: 'אין תזכורת היום' };
      await P.eval(`__t.click('[data-remgo="0"]')`); await sleep(300); eqJ(await P.eval(`[__app.ui.tab, document.querySelector('#docMonth').value]`), ['docs', ym], 'tab/month');
    });
    await check('העלאת שני קבצים (גם עם שם בעברית) ל-Drive, בתיקיית החודש', 'העלאת המסמכים לא עובדת, ולכן Claude לא יקבל אותם לעדכון החודשי.', async () => {
      if (!due.length) { await P.eval(`__t.tab('docs')`); await P.eval(`(() => { const s = document.querySelector('#docMonth'); s.value = '${ym}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); }
      await P.files('#docFiles', [f1, f2]); await P.until(`/✓|⚠/.test(document.querySelector('#docMsg').textContent)`, 10000, 'upload message').catch(async e => { throw new Error(e.message + ' | msg=' + await P.eval(`document.querySelector('#docMsg') && document.querySelector('#docMsg').textContent`) + ' tab=' + await P.eval('__app.ui.tab') + ' errs=' + P.errors.join(';') + ' calls=' + fd.calls().slice(-4).join(',')); }); const um = await P.eval(`document.querySelector('#docMsg').textContent`); must(/✓ הועלו 2/.test(um), um);
      const folder = fd.byPath('תקציב שנתי', 'מסמכים', ym); must(folder, 'month folder'); const fs2 = fd.children(folder);
      eqJ(fs2.map(f => f.name).sort(), ['U1234_report.csv', 'תלוש אוקטובר.pdf'].sort(), 'names');
      must(fs2.find(f => f.name.endsWith('.pdf')).body.equals(fs.readFileSync(f1)), 'pdf bytes changed'); must(fs2.find(f => f.name.endsWith('.csv')).body.equals(fs.readFileSync(f2)), 'csv bytes changed');
    });
    await check('הקבצים שהועלו מוצגים ברשימה', 'אחרי העלאה לא רואים את הקבצים ברשימה.', async () => { await P.until(`__t.qa('#doclist [data-docdel]').length === 2`, 5000, 'list'); });
    await check('הקבצים יורדים למחשב בדיוק כמו שהועלו', 'הקבצים שיורדים למחשב בעדכון החודשי לא זהים למקור.', async () => {
      const b = await P.eval(`(async () => { const l = await window.api.docsList('${ym}'); const f = l.files.find(x => x.name.endsWith('.pdf')); return [...new Uint8Array(await (await window.api.docsGet(f.id)).arrayBuffer())]; })()`);
      must(Buffer.from(b).equals(fs.readFileSync(f1)), 'bytes');
    });
    await check('התזכורת נעלמת אחרי ההעלאה', 'גם אחרי שהעלית, התזכורת ממשיכה להופיע.', async () => {
      if (!due.length) return { skip: 'אין תזכורת היום' };
      await P.eval('refreshReminders()'); await sleep(300); must(!(await P.eval(`JSON.stringify(reminders)`)).includes(ym) || due[0].kind === 'ib' && !due.some(r => r.kind === 'docs'), await P.eval('JSON.stringify(reminders)'));
    });
    await check('מחיקת מסמך: "ביטול" משאיר, "אישור" מעביר לסל', 'מחיקת מסמך לא עובדת כמו שצריך.', async () => {
      await P.eval(`__t.click(__t.qa('#doclist [data-docdel]')[0])`); await P.eval('__t.dlg(false)'); await sleep(300); must(fd.children(fd.byPath('תקציב שנתי', 'מסמכים', ym)).length === 2, 'deleted on cancel');
      await P.eval(`__t.click(__t.qa('#doclist [data-docdel]')[0])`); await P.eval('__t.dlg(true)'); await sleep(600);
      const folder = fd.byPath('תקציב שנתי', 'מסמכים', ym); must(fd.children(folder).length === 1 && fd.children(folder, true).length === 2, 'not moved to trash');
      await P.until(`__t.qa('#doclist [data-docdel]').length === 1`, 4000, 'list after delete');
    });
    await check('חודש אחר מציג רשימה ריקה', 'בחירת חודש אחר מציגה קבצים של חודש לא נכון.', async () => {
      await P.eval(`(() => { const s = document.querySelector('#docMonth'); s.selectedIndex = s.options.length - 1; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await P.until(`/עדיין לא הועלו/.test(document.querySelector('#doclist').textContent)`, 4000, 'empty list');
    });
    await check('העלאה בלי אינטרנט: הודעה ברורה, בלי קריסה', 'כשאין אינטרנט, העלאת מסמך גורמת לשגיאה לא ברורה.', async () => {
      await P.offline(true); await P.files('#docFiles', [f2]); await P.until(`/נכשלה/.test(document.querySelector('#docMsg').textContent)`, 6000, 'error message'); await P.offline(false);
      return await P.eval(`document.querySelector('#docMsg').textContent`);
    });
    await check('"כבר טיפלתי" מסתיר את התזכורת, גם אחרי פתיחה מחדש', 'הכפתור "כבר טיפלתי" לא מסתיר את התזכורת.', async () => {
      await P.eval(`reminders = [{ kind: 'test', ym: '2001-01', text: 'בדיקה' }]; render(); true`); await P.eval(`__t.click('[data-remok="0"]')`);
      must(await P.eval(`__t.qa('[data-rem]').length`) === 0, 'still shown'); must(await P.eval(`localStorage.getItem('rem-test-2001-01')`) === '1', 'not remembered');
    });
    await check('מועדי התזכורות: ב-10 מסמכי החודש שעבר, ב-30 (או בסוף החודש) דוח אינטראקטיב', 'התזכורות מופיעות בתאריך הלא נכון.', async () => {
      const r = await P.eval(`JSON.stringify([[2026,10,9],[2026,10,10],[2026,10,29],[2026,10,30],[2026,11,3],[2026,11,31],[2027,0,10],[2027,1,27],[2027,1,28],[2026,11,15]].map(([y,m,d]) => dueReminders(new Date(y,m,d)).map(r => r.kind + ':' + r.ym).join(' ')))`);
      eqJ(JSON.parse(r), ['ib:2026-10', 'docs:2026-10', 'docs:2026-10', 'docs:2026-10 ib:2026-11', 'ib:2026-11', 'docs:2026-11 ib:2026-12', 'docs:2026-12', 'docs:2027-01', 'docs:2027-01 ib:2027-02', 'docs:2026-11'], 'dates');
    });
    fs.rmSync(tmp, { recursive: true, force: true });

    setGroup('הגדרות ותצוגה');
    await check('בחירת "תצוגת טלפון" מחליפה לכרטיסים, ו"מחשב" מחזיר', 'בחירת התצוגה בהגדרות לא משנה את המסך.', async () => {
      const set = v => P.eval(`(async () => { await __t.tab('settings'); const s = document.querySelector('#viewMode'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(300); return document.body.classList.contains('mob'); })()`);
      must(await set('phone') === true, 'phone'); must(await set('pc') === false, 'pc'); await set('auto');
    });
    await check('"אוטומטית" בוחרת לפי רוחב המסך', 'התצוגה האוטומטית לא מתאימה את עצמה לגודל המסך.', async () => {
      await P.size(500, true); await sleep(400); const a = await P.eval(`document.body.classList.contains('mob')`); await P.size(1280); await sleep(400); const b = await P.eval(`document.body.classList.contains('mob')`); eqJ([a, b], [true, false], 'auto');
    });
    await check('ההגדרות נשמרות אחרי פתיחה מחדש', 'ההגדרות חוזרות לברירת המחדל כל פעם שפותחים את האפליקציה.', async () => {
      await P.eval(`(async () => { await __t.tab('settings'); const c = document.querySelector('#startLast'); if (!c.checked) c.click(); await __t.sleep(300); return true; })()`); await P.reload();
      must(/^\d+$/.test(String(await P.eval('__app.ui.tab'))), 'did not open on the last month: ' + await P.eval('__app.ui.tab'));
      await P.eval(`(async () => { await __t.tab('settings'); const c = document.querySelector('#startLast'); if (c.checked) c.click(); await __t.sleep(300); return true; })()`);
    });
    await check('"עדכון נתונים אחרון" מוצג בהגדרות', 'בהגדרות לא רואים מתי היה עדכון הנתונים האחרון.', async () => {
      await P.eval(`__t.tab('settings')`); const t = await P.eval(`(document.querySelector('#updInfo')||{}).textContent||''`);
      if (!(data.updates || []).length) return { skip: 'אין עדכונים בנתונים האלה' }; must(/מספר \d+/.test(t), t);
    });
    await check('אין שגיאות סקריפט בכל הבדיקות של Drive', 'בזמן העבודה מול Drive הופיעה שגיאה פנימית.', () => { must(!P.errors.length && !P.badRequests.length, [...P.errors, ...P.badRequests].slice(0, 6).join('\n')); });
  } finally { P.close(); srv.close(); }
}

/* ---------------- main ---------------- */
(async () => {
  let dash;
  if (ARG('--open')) {
    dash = http.createServer((q, r) => {
      if (q.url.startsWith('/events')) { r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); for (const e of events) r.write('data: ' + JSON.stringify(e) + '\n\n'); clients.add(r); q.on('close', () => clients.delete(r)); return; }
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    });
    await new Promise(res => dash.listen(8772, '127.0.0.1', res).on('error', () => dash.listen(0, '127.0.0.1', res)));
    const url = `http://127.0.0.1:${dash.address().port}/`;
    if (CHROME) spawn(CHROME, ['--app=' + url, '--window-size=900,1000'], { detached: true, stdio: 'ignore' }).unref();
    console.log('הדף החי: ' + url);
  }
  let total = 120; try { total = +fs.readFileSync(TOTAL_FILE, 'utf8') || total; } catch (_) { /* first run */ }
  emit({ type: 'begin', time: Date.now(), total });
  const demoText = fs.readFileSync(path.join(APP, 'src', 'seed.demo.json'), 'utf8');
  const realText = fs.existsSync(REAL_FILE) ? fs.readFileSync(REAL_FILE, 'utf8') : null;
  const sets = [['נתוני דמו', JSON.parse(demoText)]]; if (realText) sets.push(['הנתונים שלך', JSON.parse(realText)]);
  try {
    await filesChecks();
    await calcChecks(sets);
    if (realText) await dataChecks('הנתונים שלך', JSON.parse(realText));
    if (!CHROME) { setGroup('מסך'); await check('Chrome מותקן', 'בלי Chrome אי אפשר לבדוק את המסך.', () => { throw new Error('Chrome not found'); }); }
    else {
      await startChrome();
      try {
        await driveChecks(demoText);
        await screenChecks('נתוני דמו', demoText, ARG('--quick'));
        if (realText) await screenChecks('הנתונים שלך', realText, ARG('--quick'));
      } finally { await stopChrome(); }
    }
  } catch (e) { setGroup('הבדיקה עצמה'); await check('הבדיקה רצה עד הסוף', 'הבדיקה עצמה נעצרה באמצע. צריך להראות ל-Claude את הפרטים הטכניים.', () => { throw e; }); }
  const done = events.filter(e => e.type === 'result').length; try { fs.writeFileSync(TOTAL_FILE, String(done)); } catch (_) { /* ignore */ }
  emit({ type: 'end', time: Date.now() });
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8').replace('<script>\n\'use strict\';', '<script>window.__FINAL = ' + JSON.stringify(events).replace(/</g, '\\u003c') + ';</script>\n<script>\n\'use strict\';');
    fs.writeFileSync(REPORT, page);
  } catch (e) { console.log('הדוח לא נשמר: ' + e.message); }
  console.log(`\n${nFail ? '✗ ' + nFail + ' תקלות' : '✓ הכול תקין'} · ${nPass} עברו · ${nWarn} לתשומת לב · דוח: ${REPORT}`);
  if (dash) setTimeout(() => { dash.close(); process.exit(nFail ? 1 : 0); }, 4000); else process.exit(nFail ? 1 : 0);
})();
