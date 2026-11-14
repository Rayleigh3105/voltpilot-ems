// Welche JS-Stücke lädt eine Seite (Wiedergabe)? Usage: node js-je-route.mjs <port> <band> <hash> <dist> [sek=8] [vorladen=0|1] [desktop|mobil]
// Zählt die Stücke aus /assets/, die in den ersten <sek> s kommen, und summiert ihre gzip-Größe (Stufe 5) aus <dist>.
// vorladen=0 (Vorgabe) schaltet das Leerlauf-Vorladen ab (`saveData`) - die Stückliste der Seite selbst; vorladen=1 lässt
// es an und zählt, was eine OFFENE Seite ohne jede Bedienung zusätzlich holt. mobil: 390 px, Touch, CPU 4×, Fast 4G.
import { createRequire } from 'node:module';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, dist, sekS = '8', vorladenS = '0', profil = 'desktop', bedienenS = ''] = process.argv.slice(2);
// bedienen: nach so vielen ms einmal scrollen (die erste Bedienung), leer = nie.
const MOBIL = profil === 'mobil';
const B = bandLaden(bandDatei, 'lebendig');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext(MOBIL
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
  : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
if (vorladenS !== '1') await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }); } catch {} });
const page = await ctx.newPage();
if (MOBIL) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 });
}
await page.route('**/openid-connect/token', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: B.token }));
await page.route('**/api/**', (r) => { const e = B.antwort(r.request().url()); return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' }); });
const js = [];
let t0 = 0;
page.on('response', async (r) => { if (r.request().resourceType() === 'script' && r.url().includes('/assets/')) js.push([r.url().split('/').pop(), Date.now() - t0]); });
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), B.token);
t0 = Date.now();
await page.goto(`http://localhost:${port}/${hash}`);
if (bedienenS) {
  await page.waitForTimeout(Number(bedienenS));
  await page.mouse.wheel(0, 300).catch(() => undefined);
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(Number(sekS) * 1000 - Number(bedienenS));
} else await page.waitForTimeout(Number(sekS) * 1000);
const { gzipSync } = await import('node:zlib');
const { readFileSync: rf } = await import('node:fs');
const gz = (f) => gzipSync(rf(`${dist}/assets/${f}`), { level: 5 }).length;
const summe = js.reduce((s, [f]) => s + gz(f), 0);
const spaet = js.filter(([, ms]) => ms > 2500);
console.log(JSON.stringify({ port, hash, profil, sek: Number(sekS), vorladen: vorladenS === '1', bedienen: bedienenS || null, dateien: js.length, kbGz: +(summe / 1000).toFixed(1),
  nach2500ms: { dateien: spaet.length, kbGz: +(spaet.reduce((s, [f]) => s + gz(f), 0) / 1000).toFixed(1), erstesMs: spaet.length ? Math.min(...spaet.map(([, ms]) => ms)) : null },
  stuecke: js.map(([f, ms]) => `${f}@${ms}`).sort() }));
await b.close();
