// HARNESS · Bewegung P1: die Beweise (b)-(e) in EINEM Lauf.
//
// (a) ist der Frame-Beweis (`shoot.mjs` + `analyze-frames.py`) und laeuft
// getrennt, weil er Bilder auswertet. Hier stehen die Beweise, die eine ZAHL
// zurueckgeben: Aufdecken GENAU EINMAL, Bildrate unter Drosselung, der
// Schalter, und die Frist der Fahne.
//
//   node e2e/motion-lab/proof.mjs --port 5181 [--site UUID] [--reduced] [--vw 375] [--cpu 4]
//
// ⚠ Ein Diagramm deckt sich erst auf, wenn es GEZEICHNET, IM BLICK und BREITER
// ALS NULL ist. Ein festes Warten reicht deshalb nicht: die Flaechen laden ihr
// Stueck nach, und die meisten Diagramme liegen unter dem Falz. Der Ablauf ist
// darum immer: laden -> nach oben -> jedes Diagramm einmal in den Blick holen.
// Nichts davon laeuft in Produktion; der Portal-Code traegt keinen Haken dafuer.
import { chromium } from 'playwright';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const APP = `http://localhost:${arg('port', process.env.VP_PORT || '5173')}`;
const SITE = arg('site', '00000000-0000-0000-0000-000000000012');
const vw = Number(arg('vw', '1440'));
const cpu = Number(arg('cpu', '1'));
const out = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: vw <= 500 ? { width: vw, height: 812 } : { width: vw, height: 900 },
  deviceScaleFactor: vw <= 500 ? 2 : 1,
  isMobile: vw <= 500, hasTouch: vw <= 500,
  ...(has('reduced') ? { reducedMotion: 'reduce' } : {}),
});
// Der Beobachter steht VOR jedem Seiten-Skript und zaehlt je Behaelter, wie oft
// die Maske GESTARTET wurde. Genau darum geht es: einmal, nie wieder.
await ctx.addInitScript(() => {
  performance.setResourceTimingBufferSize(5000);
  window.__reveal = new Map();
  window.__raf = [];
  window.__span = [];
  let n = 0;
  const mo = new MutationObserver((es) => {
    for (const e of es) {
      const el = e.target;
      if (!(el instanceof Element)) continue;
      const jetzt = el.classList.contains('is-entering');
      const vorher = (e.oldValue || '').split(/\s+/).includes('is-entering');
      if (jetzt && !vorher) {
        if (!el.dataset.vpProbe) el.dataset.vpProbe = 'c' + ++n;
        const k = el.dataset.vpProbe;
        window.__reveal.set(k, (window.__reveal.get(k) || 0) + 1);
        window.__span.push([performance.now(), null]);
      }
      if (!jetzt && vorher) { const o = window.__span.find((s) => s[1] === null); if (o) o[1] = performance.now(); }
    }
  });
  const start = () => mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  if (document.documentElement) start(); else addEventListener('DOMContentLoaded', start);
  let t = performance.now();
  window.__rafStart = t;
  const tick = () => { const u = performance.now(); window.__raf.push(u - t); t = u; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });

async function login() {
  await page.goto(`${APP}/`); await page.waitForTimeout(3000);
  const btn = page.getByRole('button', { name: 'Anmelden' });
  if (await btn.count()) await btn.first().click();
  await page.waitForSelector('#username', { timeout: 25000 });
  await page.fill('#username', 'demo'); await page.fill('#password', 'demo');
  await page.click('#kc-login');
  await page.waitForFunction(() => location.hash.startsWith('#/'), null, { timeout: 30000 });
  await page.waitForTimeout(2000);
}
// Je Behaelter der HOECHSTE Startzaehler - die scharfe Aussage. Eine Summe
// koennte "zwei Diagramme je einmal" nicht von "eines zweimal" unterscheiden.
const zaehle = () => page.evaluate(() => {
  const v = [...window.__reveal.values()];
  return { charts: v.length, max: Math.max(0, ...v), summe: v.reduce((a, b) => a + b, 0) };
});
async function oeffne(hash, warten = 7000) {
  await page.goto(`${APP}/#/${hash}`); await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(warten);
  const n = await page.evaluate(() => document.querySelectorAll('.vp-chart-motion').length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => document.querySelectorAll('.vp-chart-motion')[i]?.scrollIntoView({ block: 'center' }), i);
    await page.waitForTimeout(1300);
  }
  await page.waitForTimeout(1200);
  return n;
}
// Fingerabdruck der Leinwand: aendert er sich, hat das Diagramm wirklich neu
// gezeichnet - der Beleg, dass ein Zeitraumwechsel MORPHT statt nichts zu tun.
const leinwand = () => page.evaluate(() => {
  const c = document.querySelector('.vp-chart-motion canvas');
  if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0; for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) >>> 0;
  return h;
});

try {
  await login();
  const n1 = await oeffne(`anlage/${SITE}/erloese`);
  const a = await zaehle();
  out.push(`(b1) erloese        diagramme=${n1} aufgedeckt=${a.charts} hoechster_zaehler=${a.max} ${n1 > 0 && a.charts === n1 && a.max === 1 ? 'OK' : 'FEHLER'}`);

  // (b2) Fenstergroesse: die Sichtbarkeit aendert sich nicht -> kein zweiter
  // Einstieg. (Der Groessen-Beobachter zeichnet neu, deckt aber nie auf.)
  await page.setViewportSize({ width: vw <= 500 ? 360 : 1180, height: vw <= 500 ? 740 : 820 });
  await page.waitForTimeout(1800);
  await page.setViewportSize({ width: vw, height: vw <= 500 ? 812 : 900 });
  await page.waitForTimeout(2500);
  const b = await zaehle();
  out.push(`(b2) resize         hoechster_zaehler=${b.max} (vorher ${a.max}) ${b.max === a.max ? 'OK' : 'FEHLER'}`);

  // (b3) Zeitraum wechseln: MORPH, kein neuer Einstieg. Der Leinwand-Abdruck
  // belegt, dass wirklich neu gezeichnet wurde - sonst ginge ein toter Klick
  // als Erfolg durch.
  const bildVor = await leinwand();
  const geklickt = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, [role=tab], [role=radio]')]
      .find((e) => /^(Woche|Monat|Jahr)$/.test((e.textContent || '').trim()));
    if (b) { b.click(); return (b.textContent || '').trim(); } return null;
  });
  await page.waitForTimeout(5000);
  const c2 = await zaehle();
  const bildNach = await leinwand();
  const gemorpht = bildVor !== null && bildNach !== null && bildVor !== bildNach;
  out.push(`(b3) zeitraum=${(geklickt || '-').padEnd(6)} hoechster_zaehler=${c2.max} neu_gezeichnet=${gemorpht ? 'JA' : 'NEIN'} ${geklickt && c2.max === a.max && gemorpht ? 'OK' : 'HINWEIS'}`);

  // (b4) Unter dem Falz: ohne Blick kein Einstieg, mit Blick genau einer.
  await page.evaluate(() => window.__reveal.clear());
  await page.goto(`${APP}/#/anlage/${SITE}/messwerte`); await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(8000);
  const unten = await page.evaluate(() => { const e = document.querySelector('.vp-chart-motion'); return e ? Math.round(e.getBoundingClientRect().top) : null; });
  const vorBlick = await zaehle();
  await page.evaluate(() => document.querySelector('.vp-chart-motion')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(2500);
  const nachBlick = await zaehle();
  out.push(`(b4) unter_falz     oben_bei=${unten}px vor_blick=${vorBlick.summe} nach_blick=${nachBlick.max} ${vorBlick.summe === 0 && nachBlick.max === 1 ? 'OK' : 'HINWEIS'}`);
} catch (e) { out.push(`(b)  FEHLGESCHLAGEN: ${String(e).slice(0, 88)}`); }

// (c) Bildrate waehrend des Aufdeckens.
try {
  await page.evaluate(() => { window.__raf.length = 0; window.__rafStart = performance.now(); window.__span.length = 0; window.__reveal.clear(); });
  await oeffne(`anlage/${SITE}/erloese`);
  const r = await page.evaluate(() => {
    // ⚠ Gezaehlt werden NUR die Bilder WAEHREND der Masken. Das Laden davor
    // (Stueck holen, ECharts aufsetzen, erstes Zeichnen) ruckelt auf einer
    // gedrosselten Maschine sehr wohl - das ist aber nicht die Bewegung, ueber
    // die hier eine Aussage gemacht wird, und es mitzuzaehlen waere eine Zahl,
    // die etwas anderes misst als sie behauptet.
    const spans = window.__span.filter((x) => x[1] !== null);
    // `__raf` haelt Abstaende; ihre Zeitpunkte rekonstruieren wir kumulativ.
    let t = window.__rafStart || 0; const stempel = [];
    for (const d of window.__raf) { t += d; stempel.push([t, d]); }
    const drin = stempel.filter(([z]) => spans.some(([a, b]) => z >= a && z <= b)).map(([, d]) => d);
    const sortiert = [...drin].sort((a, b) => a - b);
    return { frames: drin.length, lang: drin.filter((d) => d > 33).length,
      p95: sortiert.length ? +sortiert[Math.floor(sortiert.length * 0.95)].toFixed(1) : 0,
      max: sortiert.length ? +sortiert[sortiert.length - 1].toFixed(1) : 0,
      gesamt: window.__raf.length, masken: spans.length,
      dauer: spans.length ? +(spans[0][1] - spans[0][0]).toFixed(0) : 0 };
  });
  out.push(`(c)  ${vw}px cpu${cpu}x    maske: frames=${r.frames} >33ms=${r.lang} p95=${r.p95}ms max=${r.max}ms | masken=${r.masken} dauer=${r.dauer}ms (gesamtlauf ${r.gesamt} frames)`);
} catch (e) { out.push(`(c)  FEHLGESCHLAGEN: ${String(e).slice(0, 88)}`); }

// (d) Der Schalter, aus den Token UND aus den echten ECharts-Optionen.
try {
  const s = await page.evaluate(async () => {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    const el = document.querySelector('.vp-chart-motion');
    let opt = 'nicht gelesen';
    try {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /echarts/.test(n));
      if (url) {
        const m = await import(/* @vite-ignore */ url);
        const ec = m.getInstanceByDom ? m : (m.default || m);
        const i = ec.getInstanceByDom(el);
        const o = i && i.getOption();
        if (o) opt = `animation=${o.animation} durUpdate=${o.animationDurationUpdate} ease=${o.animationEasingUpdate} tooltip=${(o.tooltip || []).map((t) => t.transitionDuration).join('/')}`;
      }
    } catch (e) { opt = 'nicht gelesen (' + String(e).slice(0, 40) + ')'; }
    return { scale: g('--vp-motion-scale'), chart: g('--vp-motion-chart'), update: g('--vp-motion-chart-update'),
      fast: g('--vp-motion-fast'), haengt: document.querySelectorAll('.is-entering').length,
      marken: document.querySelectorAll('.vp-chart-motion').length, opt };
  });
  out.push(`(d1) token          scale=${s.scale} chart=${s.chart} update=${s.update} fast=${s.fast} marken=${s.marken} klasse_haengt=${s.haengt}`);
  out.push(`(d2) echarts_enter  ${s.opt}`);
  // (d3) NACH einem Zeitraumwechsel steht dieselbe Instanz in der Update-Phase:
  // `animation` springt auf `true`, und zwar OHNE dass ein Konsument etwas tut.
  const lesen = () => page.evaluate(async () => {
    try {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /echarts/.test(n));
      const m = await import(/* @vite-ignore */ url);
      const ec = m.getInstanceByDom ? m : (m.default || m);
      const o = ec.getInstanceByDom(document.querySelector('.vp-chart-motion')).getOption();
      return `animation=${o.animation} durUpdate=${o.animationDurationUpdate} ease=${o.animationEasingUpdate} schwelle=${o.animationThreshold}`;
    } catch (e) { return 'nicht gelesen'; }
  });
  const klick = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, [role=tab], [role=radio]')]
      .find((e) => /^(Woche|Monat|Jahr)$/.test((e.textContent || '').trim()));
    if (b) { b.click(); return (b.textContent || '').trim(); } return null;
  });
  await page.waitForTimeout(4000);
  out.push(`(d3) echarts_update ${klick ? await lesen() : 'kein Zeitraum-Schalter gefunden'}`);
  // (e) ECharts schreibt die Frist der Fahne INLINE an ihren Behaelter - und
  // halbiert sie dabei (`assembleTransition`), 0.12s wird also zu 0.06s.
  const box = page.locator('.vp-chart-motion canvas').first();
  await box.scrollIntoViewIfNeeded();
  const bb = await box.boundingBox();
  if (bb) for (const f of [0.3, 0.45, 0.6, 0.75]) {
    await page.mouse.move(bb.x + bb.width * f, bb.y + bb.height * 0.45);
    await page.waitForTimeout(450);
    if (await page.evaluate(() => [...document.querySelectorAll('div')].some((d) => /transition:\s*opacity/.test(d.getAttribute('style') || '')))) break;
  }
  const tip = await page.evaluate(() => {
    const t = [...document.querySelectorAll('div')].find((d) => /transition:\s*opacity/.test(d.getAttribute('style') || ''));
    const m = t && (t.getAttribute('style') || '').match(/opacity\s+([\d.]+)s/);
    return m ? m[1] : null;
  });
  out.push(`(e)  fahne          css=${tip ? tip + 's' : '-'} => transitionDuration=${tip ? (Number(tip) * 2).toFixed(2) + 's' : 'nicht gemessen'} (ECharts halbiert; Werk waere 0.20s)`);
} catch (e) { out.push(`(d/e) FEHLGESCHLAGEN: ${String(e).slice(0, 88)}`); }

console.log(out.join('\n'));
await browser.close();
