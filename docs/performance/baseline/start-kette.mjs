// Start-Wasserfall in der Wiedergabe: wann beginnen Stammdaten und Seitendaten, gemessen ab dem Start von /api/v1/me?
// Usage: node start-kette.mjs <port> <band> <hash> <läufe> [latenz]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, laeufeS, latenzS] = process.argv.slice(2);
const laeufe = Number(laeufeS ?? 5), latenz = Number(latenzS ?? 150);
const band = JSON.parse(readFileSync(bandDatei, 'utf8'));
const form = (k) => decodeURIComponent(k).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d\d:\d\d)?/g, '{t}');
const nf = new Map(Object.entries(band.api).map(([k, v]) => [form(k), v]));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext();
const page = await ctx.newPage();
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
await page.route('**/openid-connect/token', async (r) => { await warte(latenz); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: band.token }); });
let log = [];
await page.route('**/api/**', async (r) => { const u = new URL(r.request().url()); log.push([Date.now(), u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}')]); const e = band.api[`GET ${u.pathname}${u.search}`] ?? nf.get(form(`GET ${u.pathname}${u.search}`)); await warte(latenz); return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' }); });
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), band.token);
const erg = [];
for (let i = 0; i < laeufe + 1; i++) {
  log = [];
  await page.goto(`http://localhost:${port}/silent-check-sso.html`);
  await page.goto(`http://localhost:${port}/${hash}`);
  await page.waitForTimeout(5000);
  if (i === 0) continue; // erster Lauf wärmt den Cache
  const me = log.find(([, p]) => p === '/api/v1/me')?.[0];
  const sites = log.find(([, p]) => p === '/api/v1/sites')?.[0];
  const seite = log.find(([, p]) => p.startsWith('/api/v1/sites/{id}/') || p === '/api/v1/overview' || p.startsWith('/api/v1/meldungen?'))?.[0];
  erg.push({ sitesAbMe: sites - me, seitendatenAbMe: seite - me });
}
const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor((s.length - 1) / 2)]; };
console.log(JSON.stringify({ port, hash, latenz, laeufe, sitesAbMe: med(erg.map((x) => x.sitesAbMe)), seitendatenAbMe: med(erg.map((x) => x.seitendatenAbMe)), roh: erg }));
await b.close();
