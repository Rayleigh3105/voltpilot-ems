// Verzahnte Wiedergabe-Messung: alle Varianten zugleich ausgeliefert (je ein Port), je Seite und Lauf kommen die
// Varianten direkt nacheinander dran - eine Lastschwankung der Maschine trifft alle gleich.
// Usage: node wechsel.mjs --user demo2 --band <band.json> --profil mobil --varianten "base=15861;buendel=15862;boot=15863"
//        --seiten "cockpit=#/anlage/<id>;…" [--runs 4] [--kalt 1] [--latenz 150] [--label x]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => {
  if (x.startsWith('--')) acc.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const user = a.user || 'demo2';
const profil = a.profil || 'mobil';
const MOBIL = profil === 'mobil';
const runs = Number(a.runs ?? 4), kalt = Number(a.kalt ?? 1), latenz = Number(a.latenz ?? 150);
const label = a.label || 'wechsel';
const out = a.out || `${process.env.TMPDIR ?? '/tmp'}/vp-perf-labor/wechsel`;
const varianten = a.varianten.split(';').map((x) => x.split('=')).map(([n, p]) => ({ n, base: `http://localhost:${p}` }));
const seiten = a.seiten.split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; });
mkdirSync(out, { recursive: true });
const band = JSON.parse(readFileSync(a.band, 'utf8'));
const form = (k) => decodeURIComponent(k).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d\d:\d\d)?/g, '{t}').replace(/\b1[78]\d{11}\b/g, '{ms}');
const nachForm = new Map(Object.entries(band.api).map(([k, v]) => [form(k), v]));
const verz = (bytes) => latenz + (MOBIL ? Math.round(bytes / 1000) : 0);

const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });

async function aufbauen(v) {
  const ctx = await browser.newContext(MOBIL
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'de-DE', timezoneId: 'Europe/Berlin' }
    : { viewport: { width: 1440, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  await ctx.addInitScript(() => {
    const m = { lcp: null, bereit: null, longtasks: [] };
    window.__m = m;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longtasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
    } catch {}
    const LADER = '.vp-loader-boot, .vp-skeleton, .vp-anlage-pending, .vp-lazy-page, [aria-busy="true"], .vp-boot';
    let stabilSeit = null;
    const loop = () => {
      const main = document.querySelector('main'); const text = main?.innerText || '';
      const ok = !!main && !document.querySelector(LADER) && !/wird geladen|werden geladen|Lädt…|Laden …|Anmeldung wird geprüft/i.test(text) && text.trim().length > 40;
      const t = performance.now();
      if (ok) { if (stabilSeit == null) stabilSeit = t; if (m.bereit == null && t - stabilSeit >= 300) m.bereit = stabilSeit; } else { stabilSeit = null; m.bereit = null; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await page.route('**/openid-connect/token', async (route) => {
    await new Promise((r) => setTimeout(r, verz(3000)));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*', 'access-control-allow-credentials': 'true' }, body: band.token });
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fulfill({ status: 204, body: '' });
    const u = new URL(req.url()); const k = `GET ${u.pathname}${u.search}`;
    const e = band.api[k] ?? nachForm.get(form(k));
    if (!e) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    await new Promise((r) => setTimeout(r, verz(e.body.length)));
    await route.fulfill({ status: e.status, contentType: e.typ, body: e.body });
  });
  if (MOBIL) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 });
  }
  await page.goto(v.base + '/silent-check-sso.html');
  await page.evaluate((t) => sessionStorage.setItem('vp.auth.tokens', t), JSON.stringify(JSON.parse(band.token)));
  const netz = new Map();
  cdp.on('Network.requestWillBeSent', (e) => netz.set(e.requestId, { url: e.request.url, typ: e.type, start: e.timestamp, bytes: 0, cache: false }));
  cdp.on('Network.responseReceived', (e) => { const r = netz.get(e.requestId); if (r) { r.typ = e.type; r.cache = e.response.fromDiskCache; } });
  cdp.on('Network.loadingFinished', (e) => { const r = netz.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
  return { ...v, ctx, page, cdp, netz };
}

const vs = [];
for (const v of varianten) vs.push(await aufbauen(v));
const erg = { label, user, profil, runs, kalt, latenz, start: execSync('uptime').toString().trim(), seiten: {} };
async function laden(v, hash, istKalt) {
  await v.page.goto(v.base + '/silent-check-sso.html');
  if (istKalt) await v.cdp.send('Network.clearBrowserCache');
  v.netz.clear();
  await v.page.goto(v.base + '/' + hash);
  try { await v.page.waitForFunction(() => window.__m && window.__m.bereit != null, null, { timeout: 60000, polling: 50 }); }
  catch { return { kalt: istKalt, fehler: 'nicht bereit' }; }
  await v.page.waitForTimeout(800);
  const m = await v.page.evaluate(() => ({ bereit: window.__m.bereit, lcp: window.__m.lcp, tbt: Math.round(window.__m.longtasks.reduce((s, [, d]) => s + Math.max(0, d - 50), 0)), url: location.hash }));
  if (!m.url.split('?')[0].startsWith(hash.split('?')[0])) return { kalt: istKalt, fehler: `nicht am Ziel ${m.url}` };
  const alle = [...v.netz.values()];
  const t0 = Math.min(...alle.map((x) => x.start));
  const js = alle.filter((x) => x.typ === 'Script' && !x.cache);
  const bis = js.filter((x) => (x.start - t0) * 1000 <= m.bereit);
  return { kalt: istKalt, ...m, jsKbBisBereit: +(bis.reduce((s, x) => s + x.bytes, 0) / 1000).toFixed(1), last: (await import('node:os')).loadavg()[0] };
}
for (const [name, hash] of seiten) {
  erg.seiten[name] = {};
  for (const v of vs) erg.seiten[name][v.n] = [];
  for (let r = 0; r < kalt + runs; r++) {
    const reihenfolge = r % 2 === 0 ? vs : [...vs].reverse();
    for (const v of reihenfolge) erg.seiten[name][v.n].push(await laden(v, hash, r < kalt));
  }
}
erg.ende = execSync('uptime').toString().trim();
writeFileSync(`${out}/${label}-${user}-${profil}.json`, JSON.stringify(erg, null, 1));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const f = (x, d = 0) => (x == null ? '–' : Number(x).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
console.log(`## Verzahnt ${label} · ${user} · ${profil} · Latenz ${latenz} ms · ${erg.start} → ${erg.ende.replace(/.*load/, 'load')}`);
const kopf = ['Seite', ...vs.map((v) => `${v.n} bereit warm`), ...vs.map((v) => `${v.n} bereit kalt`), ...vs.map((v) => `${v.n} TBT warm`), ...vs.map((v) => `${v.n} JS bis bereit kalt kB`)];
console.log(`| ${kopf.join(' | ')} |`); console.log(`|---|${kopf.slice(1).map(() => '---:').join('|')}|`);
for (const [name, je] of Object.entries(erg.seiten)) {
  const g = (n, kaltWahl, sel, d = 0) => f(med(je[n].filter((x) => !x.fehler && x.kalt === kaltWahl).map(sel)), d);
  console.log(`| ${name} | ${[...vs.map((v) => g(v.n, false, (x) => x.bereit)), ...vs.map((v) => g(v.n, true, (x) => x.bereit)), ...vs.map((v) => g(v.n, false, (x) => x.tbt)), ...vs.map((v) => g(v.n, true, (x) => x.jsKbBisBereit, 1))].join(' | ')} |`);
}
const fehl = Object.values(erg.seiten).flatMap((je) => Object.values(je).flat()).filter((x) => x.fehler).length;
if (fehl) console.log('Fehlversuche:', fehl);
await browser.close();
