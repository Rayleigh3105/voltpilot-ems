// Wiedergabe-Messung des Portals (Abschnitt „Portal-Reaktivität“ in ../perf-baseline.md): API- und Token-Antworten
// einmal von der Labor-API aufzeichnen (`labor.sh`), danach für jede Variante mit FESTER Antwortzeit wiedergeben.
// Server- und Keycloak-Last fallen heraus; was bleibt, ist die Arbeit des Portals (JS laden/ausführen, Abruf-Ketten,
// Rendern). Ausgeliefert wird der Build über den Labor-nginx oder `serve-dist.mjs` (gzip/Cache wie Prod).
//
//   node wiedergabe.mjs aufnehmen   --user demo2 --seiten "cockpit=#/anlage/<id>;…" --band <datei.json>
//   node wiedergabe.mjs messen      --user demo2 --seiten "…" --band <datei.json> --label base --profil desktop|mobil
//                                   [--runs 5] [--kalt 2] [--latenz 150] [--ohneVorladen] [--base http://localhost:15861]
//                                   [--zeit ruhig|frisch|lebendig]   (Zeitpunkte im Band, siehe band.mjs; Vorgabe ruhig)
//   node wiedergabe.mjs takt        … --sek 65        (Abrufe einer OFFENEN Seite je Pfad zählen)
//   node wiedergabe.mjs interaktion … --schritte "Verlauf Tag → Monat;…" [--kaltKlick n]   (Klick → Seite steht wieder)
//   node wiedergabe.mjs profil      … --sek 60        (React-Übergaben je Komponente; braucht einen Profiling-Build,
//                                   react-dom → react-dom/profiling)
//
// Wiedergabe: jede /api/-Antwort kommt nach `latenz` ms (mobil zusätzlich: Größe / 1 MB/s), Token-Abrufe ebenso.
// Mobil: CPU 4× gedrosselt, Netz „Fast 4G“ für alles, was NICHT aus dem Band kommt (JS, CSS, HTML).
// Die Bänder enthalten Labor-Tokens und Labor-Daten: nie einchecken, nach dem Lauf löschen.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { execSync } from 'node:child_process';
import { bandLaden } from './band.mjs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');

const modus = process.argv[2];
const a = Object.fromEntries(process.argv.slice(3).reduce((acc, x, i, arr) => {
  if (x.startsWith('--')) acc.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const BASE = a.base || `http://localhost:${process.env.VP_PERF_PORTS ?? '157'}44`;
const user = a.user || 'demo';
const profil = a.profil || 'desktop';
const MOBIL = profil === 'mobil';
const runs = Number(a.runs ?? 5);
const kalt = Number(a.kalt ?? 2);
const latenz = Number(a.latenz ?? 150);
const label = a.label || 'replay';
const zeit = a.zeit || 'ruhig'; // ruhig | frisch | lebendig (band.mjs)
const bandDatei = a.band;
const out = a.out || `${process.env.TMPDIR ?? '/tmp'}/vp-perf-labor/wiedergabe`;
const seiten = (a.seiten || 'start=').split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
const ctx = await browser.newContext(MOBIL
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
  : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
if (a.ohneVorladen === 'true') await ctx.addInitScript(() => {
  try { Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, effectiveType: '4g' } }); } catch {}
});
await ctx.addInitScript(() => {
  const m = { fcp: null, lcp: null, bereit: null, longtasks: [] };
  window.__m = m;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') m.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longtasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const LADER = '.vp-loader-boot, .vp-skeleton, .vp-anlage-pending, .vp-lazy-page, [aria-busy="true"], .vp-boot';
  let stabilSeit = null;
  const loop = () => {
    const main = document.querySelector('main');
    const text = main?.innerText || '';
    const ok = !!main && !document.querySelector(LADER) && !/wird geladen|werden geladen|Lädt…|Laden …|Anmeldung wird geprüft/i.test(text) && text.trim().length > 40;
    const t = performance.now();
    if (ok) { if (stabilSeit == null) stabilSeit = t; if (m.bereit == null && t - stabilSeit >= 300) m.bereit = stabilSeit; }
    else { stabilSeit = null; m.bereit = null; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
if (modus === 'profil') await ctx.addInitScript(() => {
  const P = { an: false, commits: 0, commitMs: 0, je: {} };
  window.__prof = P;
  const name = (f) => { const t = f.type; if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null; };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!P.an) return;
      P.commits++; P.commitMs += root.current.actualDuration || 0;
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        if ((f.flags & 1) === 1) { const n = name(f); if (n) { const e = P.je[n] ?? (P.je[n] = { n: 0, ms: 0 }); e.n++; e.ms += f.selfBaseDuration || 0; } }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    },
  };
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const schluessel = (url, method) => { const u = new URL(url); return `${method} ${u.pathname}${u.search}`; };

async function anmelden() {
  await page.goto(BASE + '/');
  await page.waitForFunction(() => document.querySelector('#username') || [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Anmelden'), null, { timeout: 90000 });
  if (!(await page.$('#username'))) await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForSelector('#username', { timeout: 90000 });
  await page.fill('#username', user); await page.fill('#password', user);
  await Promise.all([page.waitForURL(`${BASE}/#/**`, { timeout: 90000 }), page.click('#kc-login')]);
}

if (modus === 'aufnehmen') {
  const band = existsSync(bandDatei) ? JSON.parse(readFileSync(bandDatei, 'utf8')) : { api: {}, token: null };
  band.aufgenommen = new Date().toISOString();
  page.on('response', async (r) => {
    const url = r.url();
    try {
      if (url.includes('/openid-connect/token') && r.status() === 200) band.token = await r.text();
      else if (url.includes('/api/') && r.request().method() === 'GET') {
        const k = schluessel(url, 'GET');
        band.api[k] = { status: r.status(), typ: r.headers()['content-type'] ?? 'application/json', body: r.status() === 204 ? '' : await r.text() };
      }
    } catch {}
  });
  await anmelden();
  await page.waitForTimeout(6000);
  for (const [, hash] of seiten) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(9000);
    await page.goto('about:blank');
    await page.goto(BASE + '/' + hash);
    await page.waitForTimeout(12000);
  }
  writeFileSync(bandDatei, JSON.stringify(band));
  console.log(`Band ${bandDatei}: ${Object.keys(band.api).length} API-Antworten, Token ${band.token ? 'ja' : 'nein'}`);
  await browser.close();
  process.exit(0);
}

// ---- messen / interaktion ----
const B = bandLaden(bandDatei, zeit);
const band = B.band;
const tokens = JSON.parse(band.token);
const fehlend = new Set();
const verzoegern = (bytes) => latenz + (MOBIL ? Math.round(bytes / 1000) : 0); // mobil: ≈ 1 MB/s wie Fast 4G
await page.route('**/openid-connect/token', async (route) => {
  await new Promise((r) => setTimeout(r, verzoegern(3000)));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' }, body: band.token });
});
let apiOffen = 0, apiSeit = 0;
await page.route('**/api/**', async (route) => {
  const req = route.request();
  if (req.method() !== 'GET') return route.fulfill({ status: 204, body: '' });
  const k = schluessel(req.url(), 'GET');
  const e = B.antwort(req.url());
  if (!e) { fehlend.add(k); return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"nicht im Band"}' }); }
  apiOffen++; apiSeit++;
  try {
    await new Promise((r) => setTimeout(r, verzoegern(e.body.length)));
    await route.fulfill({ status: e.status, contentType: e.typ, body: e.body });
  } finally { apiOffen--; }
});
if (MOBIL) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 });
}
// Anmeldung ohne Formular: die Tokens liegen im Tab, wie nach einer Anmeldung (`initAuth` frischt sie über das Band auf).
await page.goto(BASE + '/silent-check-sso.html');
await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', JSON.stringify(t)), tokens);

const netz = new Map();
cdp.on('Network.requestWillBeSent', (e) => netz.set(e.requestId, { url: e.request.url, typ: e.type, start: e.timestamp, ende: null, bytes: 0, cache: false }));
cdp.on('Network.responseReceived', (e) => { const r = netz.get(e.requestId); if (r) { r.typ = e.type; r.cache = e.response.fromDiskCache; } });
cdp.on('Network.loadingFinished', (e) => { const r = netz.get(e.requestId); if (r) { r.ende = e.timestamp; r.bytes = e.encodedDataLength; } });

if (modus === 'profil') {
  // Was rendert, während die Seite OFFEN steht (Takte, Uhr), und wie teuer (Profiling-Build nötig).
  const sek = Number(a.sek ?? 60);
  const erg = { label, user, profil, zeit, sek, uptime: execSync('uptime').toString().trim(), seiten: {} };
  for (const [name, hash] of seiten) {
    await page.goto(BASE + '/silent-check-sso.html');
    await page.goto(BASE + '/' + hash);
    await page.waitForFunction(() => window.__m && window.__m.bereit != null, null, { timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.evaluate(() => { const P = window.__prof; P.an = true; P.commits = 0; P.commitMs = 0; P.je = {}; });
    await page.waitForTimeout(sek * 1000);
    const p = await page.evaluate(() => { const P = window.__prof; P.an = false; return { commits: P.commits, commitMs: P.commitMs, je: P.je }; });
    erg.seiten[name] = { hash, commits: p.commits, commitMs: Math.round(p.commitMs), komponenten: Object.keys(p.je).length,
      top: Object.entries(p.je).sort((x, y) => y[1].ms - x[1].ms).slice(0, 30) };
  }
  writeFileSync(`${out}/${label}-profil-${user}-${profil}.json`, JSON.stringify(erg, null, 1));
  console.log(`## Profiler ${label} · ${user} · ${profil} · Zeit ${zeit} · ${sek} s offen · ${erg.uptime}`);
  for (const [n, x] of Object.entries(erg.seiten)) {
    console.log(`\n${n}: ${x.commits} Übergaben, ${x.commitMs} ms Renderzeit gesamt, ${x.komponenten} Komponenten-Arten gerendert`);
    for (const [k, v] of x.top.slice(0, 12)) console.log(`   ${v.ms.toFixed(1).padStart(8)} ms  ${String(v.n).padStart(5)}×  ${k}`);
  }
  await ctx.close(); await browser.close();
  process.exit(0);
}

if (modus === 'takt') {
  // Was eine OFFENE Seite nachlädt: nach „bereit“ `sek` Sekunden mitschreiben (Zahl und Bytes je Pfad).
  const sek = Number(a.sek ?? 65);
  const erg = { label, user, profil, zeit, sek, uptime: execSync('uptime').toString().trim(), seiten: {} };
  for (const [name, hash] of seiten) {
    await page.goto(BASE + '/silent-check-sso.html');
    await page.goto(BASE + '/' + hash);
    await page.waitForFunction(() => window.__m && window.__m.bereit != null, null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    const je = {};
    const mit = (req) => { if (!req.url().includes('/api/')) return; const u = new URL(req.url()); const k = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}') + (u.search ? '?' + [...u.searchParams.keys()].join('&') : ''); je[k] = (je[k] ?? 0) + 1; };
    page.on('request', mit);
    await page.waitForTimeout(sek * 1000);
    page.off('request', mit);
    erg.seiten[name] = { hash, je, summe: Object.values(je).reduce((x, y) => x + y, 0) };
  }
  writeFileSync(`${out}/${label}-takt-${user}-${profil}.json`, JSON.stringify(erg, null, 1));
  console.log(`## Takt ${label} · ${user} · ${profil} · Zeit ${zeit} · ${sek} s offen · ${erg.uptime}`);
  for (const [n, x] of Object.entries(erg.seiten)) console.log(`${n}: ${x.summe} Abrufe – ${Object.entries(x.je).sort((p, q) => q[1] - p[1]).map(([k, z]) => `${k} ×${z}`).join('; ')}`);
  await ctx.close(); await browser.close();
  process.exit(0);
}

if (modus === 'interaktion') {
  await ctx.addInitScript(() => {
    window.__ev = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__ev.push(e.duration); }).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch {}
  });
  const skriptOffen = new Set();
  cdp.on('Network.requestWillBeSent', (e) => { if (e.type === 'Script') skriptOffen.add(e.requestId); });
  cdp.on('Network.loadingFinished', (e) => skriptOffen.delete(e.requestId));
  cdp.on('Network.loadingFailed', (e) => skriptOffen.delete(e.requestId));
  const lader = () => page.evaluate(() => { const main = document.querySelector('main'); const t = main?.innerText || '';
    return !main || !!document.querySelector('.vp-loader-boot, .vp-skeleton, .vp-anlage-pending, .vp-lazy-page, [aria-busy="true"]') || /wird geladen|werden geladen|Lädt…|Laden …/i.test(t); });
  const steht = async (t0, ziel, max = 30000) => {
    let ruhig = null;
    while (Date.now() - t0 < max) {
      const ok = !(await lader()) && apiOffen === 0 && skriptOffen.size === 0 && (!ziel || (await ziel()));
      if (ok) { ruhig ??= Date.now(); if (Date.now() - ruhig >= 300) return ruhig - t0; } else ruhig = null;
      await page.waitForTimeout(20);
    }
    return null;
  };
  const S2 = '10000000-0000-0000-0000-000000000002';
  const A = `#/anlage/${a.site || S2}`;
  const gehe = (h) => async () => { await page.goto(BASE + '/' + h); await page.waitForFunction(() => window.__m && window.__m.bereit != null, null, { timeout: 60000 }); };
  const sichtbar = (sel) => async () => (await page.locator(sel).first().isVisible().catch(() => false));
  const SCHRITTE = {
    'Bereich Cockpit → Verlauf': [gehe(A), () => page.getByRole('button', { name: 'Verlauf', exact: true }).first().click(), null],
    'Bereich Verlauf → Steuerung': [gehe(`${A}/messwerte`), () => page.getByRole('button', { name: 'Steuerung', exact: true }).first().click(), null],
    'Bereich Steuerung → Anlage': [gehe(`${A}/steuerung`), () => page.getByRole('button', { name: 'Anlage', exact: true }).first().click(), null],
    'Bereich Anlage → Cockpit': [gehe(`${A}/modell`), () => page.getByRole('button', { name: 'Cockpit', exact: true }).first().click(), null],
    'Verlauf Tag → Monat': [gehe(`${A}/messwerte?z=tag`), () => page.getByRole('tab', { name: 'Monat', exact: true }).first().click(), null],
    'Verlauf Monat → Tag': [gehe(`${A}/messwerte?z=monat`), () => page.getByRole('tab', { name: 'Tag', exact: true }).first().click(), null],
    'Verlauf Vortag': [gehe(`${A}/messwerte?z=tag`), () => page.getByRole('button', { name: 'Vorheriger Zeitraum' }).first().click(), null],
    'Steuerung: Gerätezeile öffnen': [gehe(`${A}/steuerung`), () => page.locator('button.dev').first().click(), sichtbar('[role=dialog]')],
    'Aufbau: Gerätezeile öffnen': [gehe(`${A}/modell`), () => page.locator('.vp-auf-t-zeile.is-geraet .vp-auf-t-titel').first().click(), sichtbar('[role=dialog]')],
    'Aufbau: Gerät hinzufügen': [gehe(`${A}/modell`), () => page.getByRole('button', { name: 'Gerät hinzufügen' }).first().click(), sichtbar('[role=dialog]')],
  };
  const wahl = (a.schritte || Object.keys(SCHRITTE).join(';')).split(';');
  const erg = { label, user, profil, zeit, latenz, uptime: execSync('uptime').toString().trim(), schritte: {} };
  for (const name of wahl) {
    const [vorher, klick, ziel] = SCHRITTE[name];
    const liste = [];
    for (let r = 0; r < runs; r++) {
      try {
        await page.goto(BASE + '/silent-check-sso.html');
        // --kaltKlick n: die ersten n Läufe mit leerem Cache (Erstbesuch nach einem Deploy) - was das Ziel des Klicks
        // dann noch laden muss, zählt mit.
        if (r < Number(a.kaltKlick ?? 0)) await cdp.send('Network.clearBrowserCache');
        await vorher();
        await steht(Date.now(), null);
        await page.waitForTimeout(800);
        await page.evaluate(() => { window.__ev = []; });
        apiSeit = 0;
        const t0 = Date.now();
        await klick();
        const ms = await steht(t0, ziel);
        const ev = await page.evaluate(() => Math.round(Math.max(0, ...window.__ev)));
        liste.push({ ms, ereignis: ev, api: apiSeit });
      } catch (e) { liste.push({ fehler: String(e).slice(0, 120) }); }
    }
    erg.schritte[name] = liste;
  }
  writeFileSync(`${out}/${label}-interaktion-${user}-${profil}.json`, JSON.stringify(erg, null, 1));
  const med = (xs) => { const q = xs.filter((x) => x != null).sort((p, q2) => p - q2); return q.length ? q[Math.floor((q.length - 1) / 2)] : null; };
  console.log(`## Interaktion ${label} · ${user} · ${profil} · Zeit ${zeit} · Latenz ${latenz} ms · ${erg.uptime}`);
  console.log('| Schritt | steht ms (Median) | Ereignis ms | API n | n (Fehl) |');
  for (const [n, l] of Object.entries(erg.schritte)) {
    const ok = l.filter((x) => !x.fehler);
    console.log(`| ${n} | ${med(ok.map((x) => x.ms)) ?? '–'} | ${med(ok.map((x) => x.ereignis)) ?? '–'} | ${med(ok.map((x) => x.api)) ?? '–'} | ${ok.length} (${l.length - ok.length}) |`);
  }
  await ctx.close(); await browser.close();
  process.exit(0);
}

const ergebnis = { label, user, profil, zeit, runs, kalt, latenz, uptime: execSync('uptime').toString().trim(), load: loadavg()[0], seiten: {} };
for (const [name, hash] of seiten) {
  const liste = [];
  for (let r = 0; r < kalt + runs; r++) {
    const istKalt = r < kalt;
    await page.goto(BASE + '/silent-check-sso.html');
    if (istKalt) await cdp.send('Network.clearBrowserCache');
    netz.clear();
    await page.goto(BASE + '/' + hash);
    try { await page.waitForFunction(() => window.__m && window.__m.bereit != null, null, { timeout: 60000, polling: 50 }); }
    catch { liste.push({ kalt: istKalt, fehler: 'nicht bereit' }); continue; }
    await page.waitForTimeout(1500);
    const v = await page.evaluate(() => {
      const m = window.__m;
      return { fcp: m.fcp, lcp: m.lcp, bereit: m.bereit, tbt: Math.round(m.longtasks.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)), url: location.hash,
        ziel: !document.querySelector('#username') && !/Willkommen zurück|Sitzung ist abgelaufen/.test(document.body.innerText) };
    });
    if (!v.ziel || !v.url.split('?')[0].startsWith(hash.split('?')[0])) { liste.push({ kalt: istKalt, fehler: `nicht am Ziel ${v.url}` }); continue; }
    const alle = [...netz.values()];
    const t0 = Math.min(...alle.map((x) => x.start));
    const bisBereit = (x) => (x.start - t0) * 1000 <= v.bereit;
    const js = alle.filter((x) => x.typ === 'Script' && !x.cache);
    const api = alle.filter((x) => x.url.includes('/api/'));
    liste.push({ kalt: istKalt, ...v,
      jsKb: +(js.reduce((s, x) => s + x.bytes, 0) / 1000).toFixed(1), jsKbBisBereit: +(js.filter(bisBereit).reduce((s, x) => s + x.bytes, 0) / 1000).toFixed(1),
      apiBisBereit: api.filter(bisBereit).length, api: api.length });
  }
  ergebnis.seiten[name] = { hash, laeufe: liste };
}
ergebnis.fehlend = [...fehlend];
writeFileSync(`${out}/${label}-${user}-${profil}.json`, JSON.stringify(ergebnis, null, 1));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const f = (x, d = 0) => (x == null ? '–' : Number(x).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
console.log(`## Wiedergabe ${label} · ${user} · ${profil} · Zeit ${zeit} · Latenz ${latenz} ms · ${ergebnis.uptime}`);
console.log('| Seite | JS bis bereit kalt kB | bereit kalt ms | bereit warm ms | LCP warm ms | TBT warm ms | API bis bereit | n (Fehl) |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const [name, s] of Object.entries(ergebnis.seiten)) {
  const k = s.laeufe.filter((x) => x.kalt && !x.fehler), w = s.laeufe.filter((x) => !x.kalt && !x.fehler);
  console.log(`| ${name} | ${f(med(k.map((x) => x.jsKbBisBereit)), 1)} | ${f(med(k.map((x) => x.bereit)))} | ${f(med(w.map((x) => x.bereit)))} | ${f(med(w.map((x) => x.lcp)))} | ${f(med(w.map((x) => x.tbt)))} | ${f(med(w.map((x) => x.apiBisBereit)))} | ${k.length + w.length} (${s.laeufe.filter((x) => x.fehler).length}) |`);
}
if (fehlend.size) console.log('nicht im Band:', [...fehlend].slice(0, 8).join(' | '));
await ctx.close(); await browser.close();
