// Statische Auslieferung eines Portal-Builds wie die Prod-nginx.conf, soweit es für Messungen zählt:
// gzip (Stufe 5) für Text, `/assets/` „public, max-age=31536000, immutable“, alles andere `no-cache`.
// /api und /auth fängt die Messung im Browser ab (Wiedergabe); hier antworten sie 502.
// Usage: node serve-dist.mjs <port> <dist>
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const PORT = Number(process.argv[2]);
const ROOT = path.resolve(process.argv[3]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
const cache = new Map();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth')) { res.writeHead(502).end('nicht im Labor'); return; }
  let p = path.join(ROOT, decodeURIComponent(url.pathname));
  try { if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html'); } catch { p = path.join(ROOT, 'index.html'); }
  try {
    const ext = path.extname(p);
    let e = cache.get(p);
    if (!e) {
      const buf = await readFile(p);
      e = { buf, gz: TEXT.has(ext) ? gzipSync(buf, { level: 5 }) : null };
      cache.set(p, e);
    }
    const kopf = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      vary: 'Accept-Encoding',
    };
    if (e.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) { kopf['content-encoding'] = 'gzip'; res.writeHead(200, kopf).end(e.gz); }
    else res.writeHead(200, kopf).end(e.buf);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, () => console.log(`dist ${ROOT} auf http://localhost:${PORT}`));
