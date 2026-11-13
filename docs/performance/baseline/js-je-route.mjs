// Welche JS-Stücke lädt eine Seite (Wiedergabe, ohne Vorladen)? Usage: node js-je-route.mjs <port> <band> <hash> <dist>
// Zählt die Stücke aus /assets/, die in den ersten 8 s kommen, und summiert ihre gzip-Größe (Stufe 5) aus <dist>.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, dist] = process.argv.slice(2);
const band = JSON.parse(readFileSync(bandDatei, 'utf8'));
const form = (k) => decodeURIComponent(k).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d\d:\d\d)?/g, '{t}');
const nf = new Map(Object.entries(band.api).map(([k, v]) => [form(k), v]));
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext();
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }); } catch {} });
const page = await ctx.newPage();
await page.route('**/openid-connect/token', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: band.token }));
await page.route('**/api/**', (r) => { const u = new URL(r.request().url()); const e = band.api[`GET ${u.pathname}${u.search}`] ?? nf.get(form(`GET ${u.pathname}${u.search}`)); return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' }); });
const js = [];
page.on('response', async (r) => { if (r.request().resourceType() === 'script' && r.url().includes('/assets/')) js.push(r.url().split('/').pop()); });
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), band.token);
await page.goto(`http://localhost:${port}/${hash}`);
await page.waitForTimeout(8000);
const { gzipSync } = await import('node:zlib');
const { readFileSync: rf } = await import('node:fs');
const gz = (f) => gzipSync(rf(`${dist}/assets/${f}`), { level: 5 }).length;
const summe = js.reduce((s, f) => s + gz(f), 0);
console.log(JSON.stringify({ hash, dateien: js.length, kbGz: +(summe / 1000).toFixed(1), stuecke: js.sort() }));
await b.close();
