// Mess-Server fuer den P4-Browser-Beweis (untracked, nur Labor).
// Liefert `dist/` statisch auf :5184 und leitet `/api` an die Cloud-API
// weiter — so ist der Ursprung derselbe und CORS spielt keine Rolle.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.argv[3] ?? 'dist');
const PORT = Number(process.argv[2] ?? 5184);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const up = await fetch(`http://localhost:8090${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    }).catch((e) => null);
    if (!up) { res.writeHead(502).end('upstream down'); return; }
    const body = Buffer.from(await up.arrayBuffer());
    const h = {};
    up.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) h[k] = v; });
    res.writeHead(up.status, h).end(body);
    return;
  }
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  try { if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html'); }
  catch { p = path.join(ROOT, 'index.html'); }
  try {
    const buf = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, () => console.log(`proof server on http://localhost:${PORT}`));
