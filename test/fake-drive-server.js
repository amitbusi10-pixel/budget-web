// A small in-memory Google Drive (only the calls web-api.js makes), for test/run.js.
// Files: { id, name, mimeType, parents, trashed, version, createdTime, body (Buffer) }.
'use strict';
const FOLDER = 'application/vnd.google-apps.folder';

function create() {
  let files = [], seq = 0, mode = 'ok', calls = [];
  const add = (f, at) => { const x = { id: 'f' + (++seq), parents: [], trashed: false, version: 1, mimeType: 'application/octet-stream', createdTime: new Date(at || Date.now()).toISOString(), body: Buffer.alloc(0), ...f }; files.push(x); return x; };
  const find = id => files.find(f => f.id === id);
  const meta = f => ({ id: f.id, name: f.name, version: String(f.version), size: String(f.body.length), createdTime: f.createdTime, mimeType: f.mimeType, parents: f.parents, trashed: f.trashed });

  // q examples: name='budget.json' and trashed=false and 'f1' in parents and mimeType='…'
  function match(f, q) {
    if (!q) return true;
    for (const part of q.split(/\s+and\s+/)) {
      let m;
      if ((m = part.match(/^name='(.*)'$/))) { if (f.name !== m[1].replace(/\\'/g, "'")) return false; }
      else if ((m = part.match(/^trashed=(true|false)$/))) { if (String(f.trashed) !== m[1]) return false; }
      else if ((m = part.match(/^'(.+)' in parents$/))) { if (!f.parents.includes(m[1])) return false; }
      else if ((m = part.match(/^mimeType='(.*)'$/))) { if (f.mimeType !== m[1]) return false; }
      else throw new Error('fake drive: unknown query part ' + part);
    }
    return true;
  }
  function multipart(buf, ctype) {
    const b = '--' + ctype.match(/boundary=(.+)$/)[1];
    const parts = []; let i = buf.indexOf(b);
    while (i >= 0) { const j = buf.indexOf(b, i + b.length); if (j < 0) break; parts.push(buf.slice(i + b.length + 2, j - 2)); i = j; }
    return parts.map(p => { const h = p.indexOf('\r\n\r\n'); return { head: p.slice(0, h).toString(), body: p.slice(h + 4) }; });
  }

  // Handles /drive/v3/... and /upload/drive/v3/...; returns true when it answered.
  function handle(req, res, body) {
    const u = new URL(req.url, 'http://x');
    if (!/^\/(upload\/)?drive\/v3\//.test(u.pathname)) return false;
    calls.push(req.method + ' ' + u.pathname);
    const send = (code, obj, raw) => { res.writeHead(code, { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }); res.end(raw || JSON.stringify(obj)); };
    if (mode === '401') return send(401, { error: 'auth' }), true;
    if (mode === '500') return send(500, { error: 'server' }), true;
    const upload = u.pathname.startsWith('/upload/');
    const id = (u.pathname.match(/\/files\/([^/]+)$/) || [])[1];
    try {
      if (u.pathname.endsWith('/about')) return send(200, { user: { emailAddress: 'test@example.com' } }), true;
      if (!upload && req.method === 'GET' && !id) {
        let list = files.filter(f => match(f, u.searchParams.get('q')));
        const ob = u.searchParams.get('orderBy') || '';
        if (ob.startsWith('name')) list.sort((a, b) => a.name.localeCompare(b.name));
        if (ob.startsWith('createdTime')) list.sort((a, b) => a.createdTime.localeCompare(b.createdTime) || (+a.id.slice(1) - +b.id.slice(1)));
        if (/desc/.test(ob)) list.reverse();
        return send(200, { files: list.slice(0, +(u.searchParams.get('pageSize') || 100)).map(meta) }), true;
      }
      if (!upload && req.method === 'GET' && id) {
        const f = find(id); if (!f) return send(404, { error: 'not found' }), true;
        return u.searchParams.get('alt') === 'media' ? send(200, null, f.body) : send(200, meta(f)), true;
      }
      if (!upload && req.method === 'POST') { const j = JSON.parse(body.toString() || '{}'); return send(200, meta(add({ name: j.name, mimeType: j.mimeType || 'application/octet-stream', parents: j.parents || [] }))), true; }
      if (!upload && req.method === 'PATCH' && id) {
        const f = find(id); if (!f) return send(404, {}), true;
        const j = JSON.parse(body.toString() || '{}'); if ('trashed' in j) f.trashed = !!j.trashed; if (j.name) f.name = j.name;
        return send(200, meta(f)), true;
      }
      if (upload) {
        const [m, c] = multipart(body, req.headers['content-type']); const j = JSON.parse(m.body.toString());
        if (req.method === 'POST') return send(200, meta(add({ name: j.name, parents: j.parents || [], body: c.body }))), true;
        const f = find(id); if (!f) return send(404, {}), true;
        f.body = c.body; f.version++; if (j.name) f.name = j.name;
        return send(200, meta(f)), true;
      }
    } catch (e) { send(400, { error: String(e.message) }); return true; }
    send(404, {}); return true;
  }
  return {
    handle,
    reset() { files = []; seq = 0; mode = 'ok'; calls = []; },
    setMode(m) { mode = m; },
    calls: () => calls,
    add, find,
    folder: (name, parent) => add({ name, mimeType: FOLDER, parents: parent ? [parent] : [] }),
    byPath(...names) { // e.g. byPath('תקציב שנתי', 'גיבויים')
      let cur = null;
      for (const n of names) { cur = files.find(f => !f.trashed && f.name === n && (cur ? f.parents.includes(cur.id) : !f.parents.length)); if (!cur) return null; }
      return cur;
    },
    children: (parent, all) => files.filter(f => f.parents.includes(parent.id) && (all || !f.trashed)),
    // Another device saved: new content, version + 1.
    remoteEdit(file, text) { file.body = Buffer.from(text); file.version++; },
  };
}
module.exports = { create };
