// Bildschirmfoto einer Seite in der Wiedergabe (Sichtprüfung: frische Daten, Aussehen vorher = nachher).
// Usage: node blick.mjs <port> <band> <hash> <png> [desktop|mobil] [zeit] [warte-ms]
import { createRequire } from 'node:module';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, png, profil = 'desktop', zeit = 'lebendig', warteS = '6000'] = process.argv.slice(2);
const B = bandLaden(bandDatei, zeit);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext(profil === 'mobil'
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
  : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
const page = await ctx.newPage();
const fehlt = new Set();
const konsole = [];
page.on('console', (m) => { if (m.type() === 'error') konsole.push(m.text().slice(0, 160)); });
await page.route('**/openid-connect/token', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: B.token }));
await page.route('**/api/**', (r) => {
  if (r.request().method() !== 'GET') return r.fulfill({ status: 204, body: '' });
  const e = B.antwort(r.request().url());
  if (!e) { fehlt.add(new URL(r.request().url()).pathname); return r.fulfill({ status: 404, body: '{}' }); }
  return r.fulfill({ status: e.status, contentType: e.typ, body: e.body });
});
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), B.token);
await page.goto(`http://localhost:${port}/${hash}`);
await page.waitForTimeout(Number(warteS));
await page.screenshot({ path: png, fullPage: true });
console.log(JSON.stringify({ png, fehlt: [...fehlt], konsole: konsole.slice(0, 6) }));
await b.close();
