// Keycloak-Runden vor /me gegen ein ECHTES Keycloak (Anmeldung echt, API aus dem Band der Wiedergabe).
// Je Lauf und Variante ein frischer Browser-Kontext: Tokens per Passwort-Grant holen, in den Tab legen wie nach einer
// Anmeldung, dann die Seite laden. Gezählt werden die Token-Abrufe vor dem Start von /api/v1/me und die Zeit vom
// Laden der Seite bis /me; dazu, mit welchem Token /me hinausging (Alter, Lebensdauer, scope).
// Usage: node keycloak-runde.mjs <keycloak-basis> <varianten "vorher=15961;nachher=15962"> <band> <hash> [läufe=5]
//        [profil=desktop|mobil] [latenz=150] [nutzer=demo2]
// Keycloak-Basis z. B. http://localhost:15944/auth (Realm voltpilot, Client voltpilot-frontend mit den Ports der
// Varianten in redirectUris/webOrigins). Varianten laufen verzahnt; ein Lauf zählt nur, wenn /me wirklich kam.
// Keycloak-Basis `band`: die Wiedergabe - der Token-Endpunkt antwortet nach `latenz` mit dem Token des Bands (feste
// Latenz, keine Keycloak-Last); das Alter des Tokens bei /me ist dann das des Bands.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [kcBasis, variantenS, bandDatei, hash, laeufeS = '5', profil = 'desktop', latenzS = '150', nutzer = 'demo2'] = process.argv.slice(2);
const laeufe = Number(laeufeS), latenz = Number(latenzS);
const MOBIL = profil === 'mobil';
const varianten = variantenS.split(';').map((v) => v.split('='));
const B = bandLaden(bandDatei, 'lebendig');
const BAND = kcBasis === 'band';
const TOKEN = BAND ? null : `${kcBasis.replace(/\/$/, '')}/realms/voltpilot/protocol/openid-connect/token`;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const nutzlast = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

async function anmelden() {
  if (BAND) return JSON.parse(B.token);
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'voltpilot-frontend', scope: 'openid', username: nutzer, password: nutzer }),
  });
  if (!res.ok) throw new Error(`Anmeldung ${res.status}: ${await res.text()}`);
  return res.json();
}

const b = await chromium.launch({ channel: 'chrome', headless: true });
async function lauf(port) {
  const ctx = await b.newContext(MOBIL
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
    : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await ctx.newPage();
  if (MOBIL) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 });
  }
  const log = [];
  page.on('request', (r) => { if (r.url().includes('/openid-connect/token')) log.push({ art: 'token', ab: Date.now(), r }); });
  page.on('requestfinished', (r) => { const e = log.find((x) => x.r === r); if (e) e.bis = Date.now(); });
  if (BAND) {
    await page.route('**/openid-connect/token', async (r) => {
      await warte(latenz);
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': r.request().headers().origin, 'access-control-allow-credentials': 'true' }, body: B.token });
    });
  }
  await page.route('**/api/**', async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/v1/me') log.push({ art: 'me', ab: Date.now(), auth: r.request().headers()['authorization'] });
    const e = B.antwort(r.request().url());
    await warte(latenz);
    return e ? r.fulfill({ status: e.status, contentType: e.typ, body: e.body }) : r.fulfill({ status: 404, body: '{}' });
  });
  const tokens = await anmelden();
  await page.goto(`http://localhost:${port}/silent-check-sso.html`);
  await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', JSON.stringify(t)), tokens);
  const start = Date.now();
  await page.goto(`http://localhost:${port}/${hash}`);
  for (let i = 0; i < 100 && !log.some((x) => x.art === 'me'); i++) await warte(100);
  await warte(500);
  await ctx.close();
  const me = log.find((x) => x.art === 'me');
  if (!me) return null;
  const vorMe = log.filter((x) => x.art === 'token' && x.ab < me.ab);
  const t = nutzlast(me.auth.replace(/^Bearer /, ''));
  return {
    tokenVorMe: vorMe.length,
    meAbLaden: me.ab - start,
    meAbErstemToken: vorMe.length ? me.ab - vorMe[0].ab : null,
    tokenDauer: vorMe.map((x) => (x.bis ?? me.ab) - x.ab),
    tokenAlterBeiMe: Math.round(me.ab / 1000 - t.iat),
    lebensdauer: t.exp - t.iat,
    scope: t.scope,
    rollen: (t.realm_access?.roles ?? []).length,
  };
}

const erg = Object.fromEntries(varianten.map(([n]) => [n, []]));
let verworfen = 0;
for (let i = 0; i < laeufe + 1; i++) {
  for (const [name, port] of i % 2 ? [...varianten].reverse() : varianten) {
    const r = await lauf(port);
    if (i === 0) continue; // erster Lauf wärmt Keycloak und den Cache
    if (r) erg[name].push(r); else verworfen++;
  }
}
await b.close();
const med = (xs) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
console.log(`## Keycloak-Runden ${hash} · ${profil} · API-Latenz ${latenz} ms · ${laeufe} Läufe je Variante · verworfen ${verworfen} · ${execSync('uptime').toString().trim()}`);
for (const [name, rs] of Object.entries(erg)) {
  console.log(`${name}: Token-Abrufe vor /me ${rs.map((r) => r.tokenVorMe).join('/')} · /me ab Laden Median ${med(rs.map((r) => r.meAbLaden))} ms (${rs.map((r) => r.meAbLaden).join('/')}) · /me ab erstem Token-Abruf Median ${med(rs.map((r) => r.meAbErstemToken))} ms (${rs.map((r) => r.meAbErstemToken).join('/')}) · Token-Abruf Median erster ${med(rs.map((r) => r.tokenDauer[0]))} ms, zweiter ${med(rs.map((r) => r.tokenDauer[1]).filter((x) => x != null))} ms · Token bei /me: Alter ${rs.map((r) => r.tokenAlterBeiMe).join('/')} s, Lebensdauer ${[...new Set(rs.map((r) => r.lebensdauer))].join('/')} s, scope „${[...new Set(rs.map((r) => r.scope))].join('“ / „')}“, Rollen ${[...new Set(rs.map((r) => r.rollen))].join('/')}`);
}
console.log(JSON.stringify(erg));
