// CPU-Profil einer OFFENEN Seite in der Wiedergabe: wo geht die Hauptthread-Zeit hin, während der Takt läuft?
// Braucht einen unminifizierten Build (Funktionsnamen). Usage:
//   node cpu-profil.mjs <port> <band> <hash> <out.json> [sek=60] [zeit=lebendig] [desktop|mobil] [wurzel=AnlageSeite]
// Druckt: Selbstzeit je Funktion (gesamt) und - innerhalb der Aufrufe von <wurzel> - die inklusive Zeit je Funktion.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, out, sekS = '60', zeit = 'lebendig', profil = 'desktop', wurzel = 'AnlageSeite'] = process.argv.slice(2);
const MOBIL = profil === 'mobil';
const B = bandLaden(bandDatei, zeit);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext(MOBIL
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
  : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (MOBIL) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.route('**/openid-connect/token', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: B.token }));
await page.route('**/api/**', async (r) => {
  if (r.request().method() !== 'GET') return r.fulfill({ status: 204, body: '' });
  const e = B.antwort(r.request().url());
  await new Promise((res) => setTimeout(res, 150));
  return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' });
});
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), B.token);
await page.goto(`http://localhost:${port}/${hash}`);
await page.waitForTimeout(8000);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
const t0 = Date.now();
await page.waitForTimeout(Number(sekS) * 1000);
const { profile } = await cdp.send('Profiler.stop');
const dauer = Date.now() - t0;
writeFileSync(out, JSON.stringify(profile));
// Auswertung: Zeit je Knoten aus den Stichproben (timeDeltas).
const knoten = new Map(profile.nodes.map((n) => [n.id, n]));
const eltern = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) eltern.set(c, n.id);
const zeitJe = new Map();
profile.samples.forEach((id, i) => zeitJe.set(id, (zeitJe.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const name = (n) => `${n.callFrame.functionName || '(anonym)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
const selbst = new Map();
let gesamt = 0, leer = 0;
for (const [id, us] of zeitJe) {
  const n = knoten.get(id); gesamt += us;
  if (['(idle)', '(program)', '(garbage collector)'].includes(n.callFrame.functionName)) { if (n.callFrame.functionName === '(idle)') leer += us; }
  selbst.set(name(n), (selbst.get(name(n)) ?? 0) + us);
}
// Inklusive Zeit unter <wurzel>: je Stichprobe den Stapel hochgehen; liegt <wurzel> darauf, zählt jede Funktion darüber einmal.
const unter = new Map();
let wurzelUs = 0;
for (const [id, us] of zeitJe) {
  const stapel = [];
  for (let k = id; k != null; k = eltern.get(k)) stapel.push(knoten.get(k));
  const wi = stapel.findIndex((n) => n.callFrame.functionName === wurzel);
  if (wi < 0) continue;
  wurzelUs += us;
  const gesehen = new Set();
  for (const n of stapel.slice(0, wi)) { const k = name(n); if (gesehen.has(k)) continue; gesehen.add(k); unter.set(k, (unter.get(k) ?? 0) + us); }
}
const ms = (us) => (us / 1000).toFixed(1).padStart(8);
console.log(`## CPU-Profil ${hash} · ${profil} · Zeit ${zeit} · ${dauer} ms offen · ${execSync('uptime').toString().trim()}`);
console.log(`gesamt ${ms(gesamt)} ms, davon Leerlauf ${ms(leer)} ms; unter ${wurzel} (inklusive): ${ms(wurzelUs)} ms`);
console.log('\n# Selbstzeit (ohne Leerlauf), Top 25');
for (const [k, us] of [...selbst].filter(([k]) => !k.startsWith('(idle)')).sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`${ms(us)} ms  ${k}`);
console.log(`\n# Inklusive Zeit innerhalb ${wurzel}, Top 30`);
for (const [k, us] of [...unter].sort((x, y) => y[1] - x[1]).slice(0, 30)) console.log(`${ms(us)} ms  ${k}`);
await b.close();
