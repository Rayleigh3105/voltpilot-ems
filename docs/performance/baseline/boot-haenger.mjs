// E2E: the boot call /api/v1/sites hangs (a stalled connection: the request is never answered).
// Before the fix the boot curtain stays forever; with it the portal ends the call after 20 s and shows
// "Daten konnten nicht geladen werden" + "Erneut laden"; the retry (connection healthy again) loads the cockpit.
// Usage: node boot-haenger.mjs <label> [watchSeconds]   (Labor-nginx, CSP-echt, Nutzer demo2; Bilder und JSON ins aktuelle Verzeichnis)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const label = process.argv[2] || 'haenger'; const watch = Number(process.argv[3] || 40);
const dir = './';
const BASE = `http://localhost:${process.env.VP_PERF_PORTS ?? '157'}44`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const csp = []; page.on('console', (m) => { if (/Content Security Policy|CSP/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
let haengt = true; const gehalten = [];
await page.route('**/api/v1/sites', (route) => { if (haengt) { gehalten.push(route); return; } return route.continue(); });
await page.goto(`${BASE}/`);
await page.waitForSelector('#username', { timeout: 60000 });
await page.fill('#username', 'demo2'); await page.fill('#password', 'demo2');
await page.click('#kc-login');
const t0 = Date.now(); const verlauf = []; let fehlerAb = null;
while (Date.now() - t0 < watch * 1000) {
  const z = await page.evaluate(() => ({
    lader: !!document.querySelector('.vp-loader-boot'),
    fehler: /Daten konnten nicht geladen werden/.test(document.body?.innerText || ''),
    knopf: [...document.querySelectorAll('button')].some((b) => /Erneut laden/.test(b.innerText)),
  })).catch(() => ({ lader: null, fehler: null, knopf: null }));
  const s = Math.round((Date.now() - t0) / 1000);
  verlauf.push({ s, ...z });
  if (z.fehler && fehlerAb == null) fehlerAb = s;
  if (s === 25) await page.screenshot({ path: `${dir}${label}-25s.png` });
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: `${dir}${label}-ende.png` });
let erneut = null;
if (fehlerAb != null) {
  haengt = false;
  const t1 = Date.now();
  await page.click('button:has-text("Erneut laden")');
  await page.waitForSelector('.vp-cockpit-health', { timeout: 90000 });
  erneut = { cockpitNachMs: Date.now() - t1, hash: await page.evaluate(() => location.hash) };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}${label}-erneut.png` });
}
const out = { label, watchSeconds: watch, gehalteneAnfragen: gehalten.length, fehlerNachS: fehlerAb, laderNochDaAmEnde: verlauf.at(-1)?.lader, erneut, csp, verlauf };
writeFileSync(`${dir}${label}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, verlauf: verlauf.filter((v, i) => i % 5 === 0).map((v) => `${v.s}s lader=${v.lader} fehler=${v.fehler}`) }, null, 1));
await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.close(); await browser.close();
