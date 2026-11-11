// Core Web Vitals (LCP, CLS, INP) plus FCP/TTFB von Portal-Seiten im Labor (CSP-echt, Prod-nginx).
// Usage: node vitals.mjs --user demo2 --vp desktop|phone --pages "cockpit=;anlage=#/anlage/<id>" --runs 3 --label x
//        [--interact "<css>"] [--shifts]   (--shifts druckt die verschiebenden Elemente je Lauf)
// Ein Login je Viewport, dann je Lauf ein voller Dokument-Load jeder Seite (die Tokens bleiben im sessionStorage).
// INP stammt aus genau der einen Interaktion --interact; ohne sie bleibt die Spalte leer.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../../frontend/portal/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => { if (x.startsWith('--')) acc.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']); return acc; }, []));
const BASE = `http://localhost:${process.env.VP_PERF_PORTS ?? '157'}44`;
const user = a.user || 'demo2', vp = a.vp || 'desktop', runs = Number(a.runs || 3), label = a.label || 'vitals';
const pages = (a.pages || 'landing=').split(';').map((p) => p.split('='));
const interact = a.interact || null;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
const ctxOpts = vp === 'phone'
  ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
  : { viewport: { width: 1440, height: 900 } };
const ctx = await browser.newContext(ctxOpts);
await ctx.addInitScript(() => {
  const m = { lcp: null, fcp: null, shifts: [], events: [], firstInputAt: null };
  window.__vitals = m;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') m.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (m.firstInputAt == null) m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
      const src = (e.sources || []).map((s) => { const n = s.node; const d = n && n.nodeType === 1 ? `${n.tagName.toLowerCase()}.${[...n.classList].join('.')}` : (n ? '#text:' + (n.textContent || '').slice(0, 30) : '?');
        return `${d} y${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}->${Math.round(s.currentRect.height)}`; });
      m.shifts.push([e.startTime, e.value, src]); } }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.interactionId) m.events.push([e.name, e.duration, e.interactionId]); } }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (m.firstInputAt == null) m.firstInputAt = e.startTime; m.events.push([e.name, e.duration, -1]); } }).observe({ type: 'first-input', buffered: true });
  } catch {}
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });
await page.goto(BASE + '/');
await page.waitForSelector('#username', { timeout: 60000 });
await page.fill('#username', user); await page.fill('#password', user);
await Promise.all([page.waitForURL(`${BASE}/**`, { timeout: 60000 }), page.click('#kc-login')]);
await page.waitForSelector('main', { timeout: 90000 });
async function settle() {
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('.vp-loader-boot, .vp-skeleton, .vp-anlage-pending')
    && !/wird geladen/.test(document.querySelector('main')?.innerText || ''), null, { timeout: 90000, polling: 100 });
  await page.waitForTimeout(2500);
}
await settle();
const out = { label, user, vp, runs, at: Date.now(), results: {}, consoleErrors };
for (const [name, hash] of pages) {
  out.results[name] = [];
  for (let r = 0; r < runs; r++) {
    await page.goto('about:blank');
    const t0 = Date.now();
    await page.goto(BASE + '/' + hash);
    await settle();
    const settledMs = Date.now() - t0 - 2500;
    let interacted = false;
    if (interact) {
      const el = await page.$(interact);
      if (el) { await el.click(); interacted = true; await page.waitForTimeout(1200); }
    }
    const v = await page.evaluate(() => {
      const m = window.__vitals; const nav = performance.getEntriesByType('navigation')[0];
      let cls = 0, win = 0, start = -1, last = -1;
      for (const [t, val] of m.shifts) { if (start < 0 || t - last > 1000 || t - start > 5000) { win = 0; start = t; } win += val; last = t; cls = Math.max(cls, win); }
      const inp = m.events.reduce((x, e) => Math.max(x, e[1]), 0);
      return { ttfb: nav?.responseStart, fcp: m.fcp, lcp: m.lcp, cls, inp: m.events.length ? inp : null, events: m.events.length, url: location.hash, shifts: m.shifts.filter((x) => x[1] > 0.005).map((x) => [Math.round(x[0]), +x[1].toFixed(4), x[2]]) };
    });
    out.results[name].push({ ...v, settledMs, interacted });
  }
}
const med = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
console.log(`## ${label} user=${user} vp=${vp} runs=${runs} load=${(await import('node:os')).loadavg()[0].toFixed(0)}`);
console.log('| Seite | TTFB ms | FCP ms | LCP ms | CLS | INP ms | bereit ms | Hash |');
console.log('|---|---:|---:|---:|---:|---:|---:|---|');
for (const [name, rs] of Object.entries(out.results)) {
  const f = (k, d = 0) => { const x = med(rs.map((r) => r[k])); return x == null ? '-' : x.toFixed(d); };
  console.log(`| ${name} | ${f('ttfb')} | ${f('fcp')} | ${f('lcp')} | ${f('cls', 3)} | ${f('inp')} | ${f('settledMs')} | ${rs[0].url} |`);
}
if (a.shifts) for (const [name, rs] of Object.entries(out.results)) for (const r of rs) console.log(name, JSON.stringify(r.shifts));
if (consoleErrors.length) console.log('console errors:', consoleErrors.length, consoleErrors.slice(0, 5));
writeFileSync(`${label}.json`, JSON.stringify(out, null, 1));
await ctx.close(); await browser.close();
