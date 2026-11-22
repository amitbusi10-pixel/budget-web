// Local test server (http://localhost:8080 is an authorized origin of the Google sign-in client).
// /x is a local-only exchange slot for the monthly update: the page posts the Drive data there
// (pull) or reads a prepared file from it (push). It lives in %TEMP%, never in git or OneDrive.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const X = path.join(os.tmpdir(), 'budget-web-x.json');
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/x') {
    if (q.method === 'POST') { const b = []; q.on('data', c => b.push(c)); q.on('end', () => { fs.writeFileSync(X, Buffer.concat(b)); r.end('saved ' + X); }); return; }
    return fs.readFile(X, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); r.end(b); });
  }
  if (p === '/doc' && q.method === 'POST') { // a monthly document pulled from Drive by the page → %TEMP%\budget-web-docs
    const dir = path.join(os.tmpdir(), 'budget-web-docs'); fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(new URL(q.url, 'http://x').searchParams.get('name') || 'doc');
    const b = []; q.on('data', c => b.push(c)); q.on('end', () => { fs.writeFileSync(path.join(dir, name), Buffer.concat(b)); r.end('saved'); }); return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(__dirname, p);
  if (!f.startsWith(__dirname)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end('not found'); } r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(b); });
}).listen(8080, '127.0.0.1', () => console.log('http://localhost:8080'));
