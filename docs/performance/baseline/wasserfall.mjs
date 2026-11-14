// Start-Wasserfall einer Seite in der Wiedergabe: jeder API-Abruf mit Beginn und Ende ab dem Start von /api/v1/me.
// Usage: node wasserfall.mjs <port> <band> <hash> [läufe=3] [latenz=150] [zeit=lebendig] [profil=desktop] [overview-zusatz=0]
// overview-zusatz: so viele ms antwortet /overview später als der Rest (Server p50: /overview 330 ms, rollen 82 ms).
// Ausgabe: je Pfad der Median-Beginn (ms ab /me) und wie oft er je Lauf kam; dazu „Seitendaten ab /me“ wie start-kette.mjs.
import { createRequire } from 'node:module';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [port, bandDatei, hash, laeufeS = '3', latenzS = '150', zeit = 'lebendig', profil = 'desktop', ovZusatzS = '0'] = process.argv.slice(2);
const ovZusatz = Number(ovZusatzS);
const laeufe = Number(laeufeS), latenz = Number(latenzS);
const MOBIL = profil === 'mobil';
const B = bandLaden(bandDatei, zeit);
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext(MOBIL
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
  : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
const page = await ctx.newPage();
if (MOBIL) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
await page.route('**/openid-connect/token', async (r) => { await warte(latenz); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: B.token }); });
let log = [];
await page.route('**/api/**', async (r) => {
  const u = new URL(r.request().url());
  const pfad = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}') + (u.search ? '?' + [...u.searchParams.keys()].join('&') : '');
  const eintrag = [Date.now(), pfad, null];
  log.push(eintrag);
  const e = B.antwort(r.request().url());
  await warte(latenz + (u.pathname === '/api/v1/overview' ? ovZusatz : 0));
  eintrag[2] = Date.now();
  return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' });
});
await page.goto(`http://localhost:${port}/silent-check-sso.html`);
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), B.token);
const laeufeErg = [];
for (let i = 0; i < laeufe + 1; i++) {
  log = [];
  await page.goto(`http://localhost:${port}/silent-check-sso.html`);
  await page.goto(`http://localhost:${port}/${hash}`);
  await page.waitForTimeout(6000);
  if (i === 0) continue; // erster Lauf wärmt den Cache
  const me = log.find(([, p]) => p === '/api/v1/me')?.[0];
  laeufeErg.push(log.map(([t, p, ende]) => ({ p, ab: t - me, bis: ende == null ? null : ende - me })));
}
const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const jePfad = new Map();
for (const lauf of laeufeErg) {
  const n = new Map();
  for (const x of lauf) {
    const k = `${x.p}#${(n.get(x.p) ?? 0) + 1}`; n.set(x.p, (n.get(x.p) ?? 0) + 1);
    (jePfad.get(k) ?? jePfad.set(k, []).get(k)).push(x.ab);
  }
}
const zeilen = [...jePfad.entries()].map(([k, abs]) => [k, med(abs), abs.length]).sort((x, y) => x[1] - y[1]);
const seite = (lauf) => lauf.filter((x) => /^\/api\/v1\/(sites\/\{id\}\/|overview|meldungen\?)/.test(x.p)).map((x) => x.ab);
const ersteSeite = laeufeErg.map((l) => Math.min(...seite(l)));
const letzteSeiteBis4s = laeufeErg.map((l) => Math.max(...l.filter((x) => x.ab < 4000).map((x) => x.bis ?? 0)));
console.log(`## Wasserfall ${hash} · Port ${port} · ${profil} · Latenz ${latenz} ms (+${ovZusatz} /overview) · Zeit ${zeit} · ${laeufe} Läufe · ${(await import('node:child_process')).execSync('uptime').toString().trim()}`);
console.log(`Seitendaten ab /me (Median): ${med(ersteSeite)} ms · letzte Antwort der ersten 4 s (Median): ${med(letzteSeiteBis4s)} ms · Abrufe je Lauf: ${laeufeErg.map((l) => l.length).join('/')}`);
for (const [k, m, n] of zeilen) console.log(`${String(m).padStart(6)} ms  ${n}×  ${k}`);
await b.close();
