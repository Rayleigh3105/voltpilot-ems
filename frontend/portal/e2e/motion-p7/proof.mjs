/* Browser-Beweis · Bewegungs-Programm P7 (Feinschliff + die GESAMTMESSUNG).
 *
 * Er wiederholt am Ende des Programms die Messungen der einzelnen Pakete an
 * EINEM Stand — auf den Rigs von P1 (`motion-lab`), P4 (`motion-p4`) und P5
 * (`motion-p5`) aufbauend, aber gebündelt: EIN Aufruf, EINE Zusammenfassung.
 *
 * Gemessen wird gegen einen PRODUKTIONS-Build (`e2e/motion-p4/serve-proof.mjs`
 * liefert `dist/` statisch und leitet `/api` an die lokale Cloud-API weiter).
 * Der Dev-Server mit seinem Modul-Wasserfall verfälscht jede Start-Zahl.
 *
 *   (cd frontend/portal && npx vite build && node e2e/motion-p7/proof.mjs)
 *   node e2e/motion-p7/proof.mjs a d      # nur einzelne Abschnitte
 *
 * ⚠ PORT 5173 IST PFLICHT, nicht Bequemlichkeit: der Dev-Realm von Keycloak
 *   kennt nur `http://localhost:5173/*` als Rückleit-Adresse. Läuft dort ein
 *   fremder Server, ist der Beweis über fremden Code geführt — das Skript
 *   bricht dann ab, statt eine Zahl zu erfinden.
 * ⚠ Echte 375 px werden über `documentElement.clientWidth` nachgewiesen, nie
 *   über `window.innerWidth` (das zählt die Bildlaufleiste mit).
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const PORT = Number(process.env.P7_PORT ?? 5173);
const BASE = `http://localhost:${PORT}/`;
// ⚠ DIE ANLAGE MIT DATEN. `…0012` (Solarpark Dachau, die Adresse aus dem
//   P5-Rig) trägt im lokalen Stack KEINE Messwerte — dort ist jede Fläche leer
//   und jede Chart-Messung wäre eine Messung des Nichts. `…0002` („Demo Site
//   Berlin", `infra/local/timescale/01-init.sql`) hat einen Fahrplan.
const SITE = process.env.VP_SITE || '00000000-0000-0000-0000-000000000002';
const OUT = process.env.P7_OUT
  ?? '/Users/mvogt/IdeaProjects/firstmate/data/vp-motion-p7-feinschliff/proof.txt';
const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes(k);
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// --- (a) Inventar: reine Dateiprüfung, kein Browser -------------------------
const LOOPS = ['vp-spin', 'vp-boot-spin', 'vp-skeleton-shimmer', 'vp-fleet-pulse-ok',
  'vp-fleet-pulse-warn', 'vp-flowport-pulse', 'vp-ustate-pulse', 'vp-auth-flow', 'vp-flow'];
function blaetter(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'guidelines') blaetter(p, out); }
    else if (e.endsWith('.css')) out.push(p);
  }
  return out;
}
function schichten(w) {
  const out = []; let t = 0; let a = '';
  for (const c of w) {
    if (c === '(') t++; else if (c === ')') t--;
    if (c === ',' && t === 0) { out.push(a); a = ''; } else a += c;
  }
  out.push(a);
  return out.filter((x) => x.trim());
}
function inventar() {
  const css = [...blaetter('src'), ...blaetter('designsystem')];
  let alle = 0; let nackt = 0; const loops = new Map();
  for (const f of css) {
    const t = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of t.matchAll(/transition\s*:\s*([^;{}]*)/g)) {
      for (const s of schichten(m[1])) if (/(^|[\s,])all([\s,]|$)/.test(s)) alle++;
    }
    for (const m of t.matchAll(/(transition|animation)(-duration)?\s*:\s*([^;{}]*)/g)) {
      for (const s of schichten(m[3])) {
        const loop = /\binfinite\b/.test(s) && LOOPS.find((n) => s.split(/[\s,]+/).includes(n));
        if (loop) { loops.set(loop, (loops.get(loop) ?? 0) + 1); continue; }
        const ohne = s.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, ' ');
        if (/(^|[\s,(])-?[\d.]+m?s([\s,)]|$)/.test(ohne)) nackt++;
      }
    }
  }
  say(`(a) Inventar über ${css.length} Blätter: \`transition: all\` = ${alle} · nackte Dauern = ${nackt}`);
  say(`    benannte Loops (${loops.size}, je mit Grund im Wächter): ${[...loops.keys()].sort().join(' ')}`);
}

// --- Mess-Server ------------------------------------------------------------
let server;
let bedient = null;
async function serve(root = 'dist') {
  if (bedient === root) return;
  if (server) { server.kill(); await new Promise((r) => setTimeout(r, 350)); }
  else {
    const frei = await fetch(BASE).then(() => false).catch(() => true);
    if (!frei) throw new Error(`Auf ${BASE} antwortet schon jemand — Port ${PORT} ist belegt.`);
  }
  server = spawn('node', ['e2e/motion-p4/serve-proof.mjs', String(PORT), root], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE); if (r.ok) { bedient = root; return; } } catch { /* noch nicht da */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Mess-Server auf ${root} kam nicht hoch`);
}
/** Der VORHER-Stand, falls jemand ihn gebaut hat (`dist_vor`, ungetrackt). */
const VOR = existsSync('dist_vor') ? 'dist_vor' : null;

async function login(page, user = 'demo', pass = 'demo') {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const btn = page.getByRole('button', { name: 'Anmelden' });
  await btn.first().waitFor({ timeout: 30000 });
  await btn.first().click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('#kc-login');
  await page.waitForFunction(() => !document.querySelector('#username'), { timeout: 30000 });
  await page.waitForTimeout(3500);
}
const go = async (page, hash, settle = 1800) => {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(settle);
};

const FLAECHEN = [
  ['Cockpit', `/anlage/${SITE}`],
  ['Messwerte', `/anlage/${SITE}/messwerte`],
  ['Erlöse', `/anlage/${SITE}/erloese`],
  ['Marktpreise', `/anlage/${SITE}/marktpreise`],
  ['Steuerung', `/anlage/${SITE}/steuerung`],
  ['Portfolio', '/portfolio'],
];

// --- (b) reduced-motion-Sweep bei 375 ---------------------------------------
async function abschnittB(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await login(page);
  const breite = await page.evaluate(() => document.documentElement.clientWidth);
  const zaehl = () => page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running')
    .map((a) => a.animationName || a.transitionProperty || '?'));
  const fund = [];
  for (const [name, hash] of [...FLAECHEN, ['Geräteseite', null]]) {
    if (hash === null) {
      // Die Geräteseite hat keine feste Adresse — sie hängt an einer echten
      // Komponente. Die Liste der Zentrale ist der Ort, an dem ihre Links
      // stehen (`nav.ts` `zentraleAnsichtHash`).
      await go(page, `/anlage/${SITE}/modell?ansicht=geraete`, 2600);
      // `…/geraet/{ref}` ODER `…/box/{ref}`: die BOX ist eine Tor-Seite mit
      // derselben Machart (Geräteseiten Stufe 1), und in der Demo-Anlage ist
      // sie der Weg, den die Zentrale anbietet.
      const href = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/geraet/"], a[href*="/box/"]')]
          .map((a) => a.getAttribute('href'))[0] ?? null);
      if (!href) { fund.push(`${name}: nicht gemessen, weil kein Gerätelink in der Zentrale stand`); continue; }
      await go(page, href.replace(/^#/, ''), 2600);
    } else await go(page, hash);
    const l = await zaehl();
    fund.push(`${name}: ${l.length === 0 ? '0' : l.join(',')}`);
  }
  // Login: abmelden ist der einzige Weg zur Bühne — ein frischer Kontext tut es auch.
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  const loginAnim = await p2.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running').map((a) => a.animationName || '?'));
  fund.push(`Login: ${loginAnim.length === 0 ? '0' : loginAnim.join(',')}`);
  await ctx2.close(); await ctx.close();
  say(`(b) reduced-Sweep bei ${breite} px — laufende Animationen je Fläche:`);
  say(`    ${fund.join(' · ')}`);
}

// --- (c) Bildrate bei 375 / CPU 4x ------------------------------------------
const RAF = `(() => { window.__f = []; let l = performance.now();
  const t = (n) => { window.__f.push(Math.round(n - l)); l = n; requestAnimationFrame(t); };
  requestAnimationFrame(t);
  window.__lt = [];
  try { new PerformanceObserver((x) => { for (const e of x.getEntries()) window.__lt.push(Math.round(e.duration)); })
    .observe({ type: 'longtask', buffered: true }); } catch { /* ohne longtask-API */ }
})()`;
async function abschnittC(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await login(page);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(RAF);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const zeilen = [];
  const nimm = async () => {
    const { f, lt } = await page.evaluate(() => ({ f: window.__f, lt: window.__lt }));
    return { lang: f.filter((x) => x > 33), f, lt };
  };
  for (const [name, hash] of FLAECHEN) {
    // ⚠ JEDE FLÄCHE WIRD BETRETEN, nicht nur betrachtet: derselbe Hash noch
    //   einmal zu setzen löst gar keinen Wechsel aus, und die Messung wäre
    //   Leerlauf. Deshalb steht vor jeder Fläche das Portfolio.
    await go(page, '/portfolio', 1800);
    await page.evaluate(() => { window.__f.length = 0; window.__lt.length = 0; });
    await go(page, hash, 2600);
    const { lang, f, lt } = await nimm();
    zeilen.push(`${name} ${f.length}F/${lang.length}>33ms${lt.length ? ` (${lt.length} LT ${Math.max(...lt)}ms)` : ''}`);
  }
  // Der ZEITRAUM-Wechsel: derselbe Chart, andere Daten — die Familie, in der
  // ein Sprung am ehesten sichtbar wäre (P1/P2).
  await go(page, `/anlage/${SITE}/messwerte`, 2600);
  // `.vp-seg` ist der BEHÄLTER; klickbar sind die Reiter darin.
  const seg = page.locator('.vp-seg [role="tab"], .vp-seg button').nth(1);
  if (await seg.count()) {
    await page.evaluate(() => { window.__f.length = 0; window.__lt.length = 0; });
    await seg.click();
    await page.waitForTimeout(2200);
    const { lang, f, lt } = await nimm();
    zeilen.push(`Zeitraumwechsel ${f.length}F/${lang.length}>33ms${lt.length ? ` (${lt.length} LT ${Math.max(...lt)}ms)` : ''}`);
  } else zeilen.push('Zeitraumwechsel nicht gemessen, weil kein Segment-Schalter da war');
  await ctx.close();
  say('(c) Bildrate 375 px · CPU 4× — Frames / davon über 33 ms (LT = Nachlade-Long-Task):');
  say(`    ${zeilen.join(' · ')}`);
}

// --- (d) Start-Metriken Cockpit ---------------------------------------------
const MESSER = `(() => {
  window.__lcp = 0; window.__fcp = 0; window.__cls = 0; window.__clsMax = 0; window.__clsWer = '-';
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = Math.round(e.startTime); })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries())
    if (e.name === 'first-contentful-paint') window.__fcp = Math.round(e.startTime); })
    .observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) {
    if (e.hadRecentInput) continue;
    window.__cls += e.value;
    if (e.value > window.__clsMax) {
      window.__clsMax = e.value;
      const n = e.sources?.[0]?.node; const el = n?.nodeType === 1 ? n : n?.parentElement;
      window.__clsWer = el ? el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/)[0] : '') : '-';
    }
  } }).observe({ type: 'layout-shift', buffered: true });
})()`;
async function abschnittD(browser) {
  // ⚠ ZWEI PÄSSE, UND DAS IST KEINE DOPPELUNG. P4s Zahlen (b) sind
  //   UNGEDROSSELT gemessen (sein Rig drosselt nur in (a)) — FCP 20 ms ist
  //   ohne Netzbremse gar nicht anders zu erklären. Die ABNAHME von P7
  //   verlangt dagegen ausdrücklich 375 / CPU 4× / Fast 3G. Ein einziger Pass
  //   könnte nur eine der beiden Fragen beantworten und müsste die andere
  //   gegen fremde Bedingungen vergleichen.
  const messe = async (gedrosselt) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await login(page);
    await go(page, `/anlage/${SITE}`, 2500);
    if (gedrosselt) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
    }
    await page.addInitScript(MESSER);
    const w = [];
    for (let i = 0; i < 9; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
      await page.waitForTimeout(2500);
      w.push(await page.evaluate(() => ({
        lcp: window.__lcp, fcp: window.__fcp,
        cls: Math.round(window.__cls * 1000) / 1000,
        clsMax: Math.round(window.__clsMax * 1000) / 1000, wer: window.__clsWer,
      })));
    }
    await ctx.close();
    return { w, spitze: [...w].sort((a, b) => b.clsMax - a.clsMax)[0] };
  };
  const brems = await messe(true);
  const m = (o, k) => median(o.w.map((x) => x[k]));
  say('(d) Cockpit-Start bei 375 px, je 9 Läufe:');
  say(`    CPU 4× + Fast 3G (die ABNAHME, Grenze je 0,05): CLS Median ${m(brems, 'cls')} · größter Einzelsprung ${brems.spitze.clsMax} durch ${brems.spitze.wer}`);
  if (!VOR) {
    const frei = await messe(false);
    say(`    ohne Bremse (P4-Zahlen in Klammern): FCP ${m(frei, 'fcp')} ms (20) · LCP ${m(frei, 'lcp')} ms (148) · CLS ${m(frei, 'cls')} (0,05) · größter Sprung ${frei.spitze.clsMax} (0,308 durch div.vp-anlage-pending)`);
    say('    kein `dist_vor` gebaut — die P4-Zahlen stammen von einem ANDEREN Tag und Rechner');
  } else {
    // ⚠ VORHER UND NACHHER AM SELBEN RECHNER, IM SELBEN MOMENT. Die P4-Zahlen
    //   sind an einem anderen Tag entstanden; ein LCP-Vergleich gegen sie misst
    //   auch die Maschinenlast von damals. Deshalb baut dieser Abschnitt, wenn
    //   `dist_vor` (origin/main) daneben liegt, beide Stände abwechselnd.
    const paare = { vor: [], nach: [] };
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await serve('dist'); await login(page); await go(page, `/anlage/${SITE}`, 2500);
    await page.addInitScript(MESSER);
    const nimm = async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
      await page.waitForTimeout(2500);
      return page.evaluate(() => ({ lcp: window.__lcp, fcp: window.__fcp,
        cls: Math.round(window.__cls * 1000) / 1000,
        clsMax: Math.round(window.__clsMax * 1000) / 1000, wer: window.__clsWer }));
    };
    for (let i = 0; i < 9; i++) {
      await serve(VOR); paare.vor.push(await nimm());
      await serve('dist'); paare.nach.push(await nimm());
    }
    await ctx.close();
    const md = (xs, k) => median(xs.map((x) => x[k]));
    const sp = (xs) => [...xs].sort((a, b) => b.clsMax - a.clsMax)[0];
    say(`    ohne Bremse, 9 PAARE gegen origin/main: FCP ${md(paare.vor, 'fcp')} → ${md(paare.nach, 'fcp')} ms · LCP ${md(paare.vor, 'lcp')} → ${md(paare.nach, 'lcp')} ms`);
    say(`    CLS ${md(paare.vor, 'cls')} → ${md(paare.nach, 'cls')} · größter Sprung ${sp(paare.vor).clsMax} durch ${sp(paare.vor).wer} → ${sp(paare.nach).clsMax} durch ${sp(paare.nach).wer}`);
  }
}

// --- (e) 1440: Hover-Lift und der blendende Seitenwechsel --------------------
async function abschnittE(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // Fängt die Animationen des Übergangs ab — der einzige belastbare Weg an die
  // `::view-transition-*`-Pseudos (Machart von `e2e/motion-p5/proof.mjs`).
  await page.addInitScript(() => {
    window.__vt = [];
    if (!document.startViewTransition || document.__p7) return;
    document.__p7 = 1;
    const o = document.startViewTransition.bind(document);
    document.startViewTransition = (cb) => {
      const t = o(cb);
      t.ready.then(() => window.__vt.push({
        cls: (document.documentElement.className.match(/vp-vt-\w+/) || [])[0] || 'ohne Klasse',
        anims: document.getAnimations()
          .filter((a) => /\(root\)/.test(a.effect.pseudoElement || ''))
          .map((a) => a.animationName + '@' + Math.round(a.effect.getComputedTiming().duration) + 'ms'),
      }));
      return t;
    };
  });
  await login(page);
  await go(page, '/portfolio', 2500);
  // ⚠ DIE ZIEL-KARTE IST `.vp-card--interactive` — sie trägt die Hausregel
  //   „Lift = 1 px in 120 ms" (`designsystem/components/core/core.css`). Eine
  //   beliebige `.vp-card` hat gar keinen Hover und misst 0 px, ohne dass
  //   etwas fehlte.
  const ziel = page.locator('.vp-card--interactive, .vp-btn:not(:disabled)').first();
  let lift = 'keine Ziel-Karte gefunden';
  if (await ziel.count()) {
    await ziel.scrollIntoViewIfNeeded();
    const vor = await ziel.evaluate((el) => el.getBoundingClientRect().top);
    await ziel.hover();
    await page.waitForTimeout(260);
    const m = await ziel.evaluate((el) => {
      const cs = getComputedStyle(el);
      // `transitionDuration` listet EINE Zahl je Eigenschaft — die erste
      // genügt, sie gehören ohnehin alle derselben Familie an.
      return { top: el.getBoundingClientRect().top, dauer: cs.transitionDuration.split(',')[0].trim(), tf: cs.transform };
    });
    const px = Math.round((vor - m.top) * 10) / 10;
    lift = `${px} px, ${m.dauer} (${m.tf})`;
  }
  await page.evaluate(() => { window.__vt.length = 0; });
  await go(page, `/anlage/${SITE}`, 1600);
  const vt = await page.evaluate(() => window.__vt);
  await ctx.close();
  say(`(e) 1440 px · Hover-Lift auf .vp-card--interactive: ${lift}`);
  const t = vt[0];
  say(`    Seitenwechsel Portfolio → Anlage: Klasse ${t?.cls ?? '—'} · ${t?.anims?.length ? t.anims.join(' ') : 'ohne eigene Animation (Browser-Überblendung)'}`);
}

// --- (g) Admin-Charts: der P1-Hebel greift, das Bild bleibt ----------------
// ⚠ WARUM NICHT `chart.getOption()`: das Portal legt ECharts NICHT global aus
//   (kein `window.echarts`), und eine Instanz hängt nicht am DOM-Knoten —
//   `getInstanceByDom` braucht das Modul. Ein Produktions-Haken nur für diesen
//   Beweis wäre der falsche Preis. Gemessen wird deshalb das ERGEBNIS der
//   Optionen: die gezeichnete Leinwand, als Prüfsumme. Sind zwei Stände
//   bildgleich, tragen sie dieselben Serien-Daten — und anders als ein
//   Options-Vergleich fällt das auch auf, wenn sich nur die Darstellung ändert.
// ⚠ EIN MutationObserver AUF `class` REICHT NICHT: `useEChart` hängt die Marke
//   im selben Takt an, in dem der Knoten einzieht — dann meldet der Beobachter
//   eine Kind-, keine Attribut-Änderung, und der Zähler bliebe auf 0 stehen
//   (nachgemessen). Deshalb wird gepollt und die STEIGENDE FLANKE gezählt: so
//   ist auch belegt, dass der Einstieg EINMAL läuft und nicht bei jedem
//   `setOption` wieder.
const REVEAL_SPION = () => {
  window.__rev = {};
  let n = 0;
  const tick = () => {
    for (const el of document.querySelectorAll('.vp-chart-motion')) {
      if (!el.hasAttribute('data-p7')) el.setAttribute('data-p7', String(n++));
      const k = el.getAttribute('data-p7');
      const an = el.classList.contains('is-entering');
      const s = (window.__rev[k] ??= { flanken: 0, zuletzt: false });
      if (an && !s.zuletzt) s.flanken++;
      s.zuletzt = an;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
async function optimizerOeffnen(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(REVEAL_SPION);
  await login(page, process.env.VP_ADMIN ?? 'admin', process.env.VP_ADMIN_PW ?? 'admin');
  await go(page, '/optimizer', 3000);
  // Die Seite zeichnet erst, wenn Mandant UND Anlage gewählt sind. Eintrag 0
  // ist jeweils der Platzhalter („… wählen"), also der zweite.
  for (const label of ['Mandant wählen', 'Anlage wählen']) {
    const ausl = page.locator('.vp-picker-ausloeser', { hasText: label }).first();
    await ausl.waitFor({ timeout: 20000 });
    await ausl.click();
    await page.waitForTimeout(1000);
    await page.locator('[role="option"], .vp-picker-eintrag, .vp-picker-liste button').nth(1).click();
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector('.vp-chart-motion canvas', { timeout: 30000 });
  // ⚠ ERST SICHTBAR MACHEN. Der Aufdeck-Haken hängt an einem
  //   `IntersectionObserver` (Schwelle 0,15) — auf der Optimizer-Seite steht
  //   das Diagramm unter Pickern und Eingabe-Tafel, also anfangs unter der
  //   Falz. Ohne Scrollen misst man „kein Reveal" und meint „kaputt".
  await page.locator('.vp-chart-motion').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000);
  // Der ZWEITE Admin-Chart (`WhatIfCompareChart`) entsteht erst mit einem
  // What-if-Lauf. Er ist eine reine SIMULATION („es wird nichts an die Anlage
  // gesendet", Hinweis auf der Seite selbst) — deshalb darf der Beweis ihn
  // auslösen. Fehlt der Knopf (Anlage ohne Speicher), bleibt es bei einem.
  const rechnen = page.locator('button', { hasText: /Neu rechnen/ }).first();
  if (await rechnen.count()) {
    await rechnen.scrollIntoViewIfNeeded();
    await rechnen.click();
    await page.waitForTimeout(12000);
    const zweit = page.locator('.vp-chart-motion').nth(1);
    if (await zweit.count()) { await zweit.scrollIntoViewIfNeeded(); await page.waitForTimeout(2500); }
  }
  const stand = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.vp-chart-motion')];
    return {
      anzahl: els.length,
      reveals: Object.values(window.__rev).map((x) => x.flanken),
      bilder: els.map((el) => el.querySelector('canvas')?.toDataURL() ?? null),
      groessen: els.map((el) => {
        const c = el.querySelector('canvas');
        return c ? `${c.width}x${c.height}` : '-';
      }),
    };
  });
  await ctx.close();
  return stand;
}
const kurz = (s) => (s === null ? 'ohne Leinwand' : `#${[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`);
async function abschnittG(browser) {
  await serve('dist');
  const a = await optimizerOeffnen(browser);
  // ⚠ ZWEITE MESSUNG AM SELBEN STAND ZUERST. Wäre das Bild schon zwischen zwei
  //   Läufen desselben Builds verschieden (Live-Marker, Nachladen), verglichen
  //   die zwei Stände darunter diese Unruhe und nicht die Änderung. Dieselbe
  //   Disziplin wie das zweite Endbild in `analyze-frames.py`.
  const a2 = await optimizerOeffnen(browser);
  const stabil = JSON.stringify(a.bilder) === JSON.stringify(a2.bilder);
  say(`(g) Admin-Charts · Optimizer bei 1440: ${a.anzahl} Diagramm(e) über \`useEChart\` (${a.groessen.join(' ')}), Aufdeck-Flanken je Chart ${a.reveals.join('/')}`);
  if (!VOR) { say('    kein `dist_vor` gebaut — Bildvergleich vorher/nachher nicht gemessen'); return; }
  await serve(VOR);
  const v = await optimizerOeffnen(browser);
  await serve('dist');
  const gleich = JSON.stringify(v.bilder) === JSON.stringify(a.bilder);
  say(`    gegen origin/main: ${v.anzahl} Diagramm(e), Bild ${v.bilder.map(kurz).join(' ')} gegen ${a.bilder.map(kurz).join(' ')} → ${!stabil ? 'NICHT GEMESSEN, weil das Bild schon zwischen zwei Läufen desselben Standes wechselt' : gleich ? 'IDENTISCH' : 'VERSCHIEDEN'}`);
}

// --- (f) Die Ehrlichkeits-Stichprobe (Rig aus P1) ---------------------------
// Sie beantwortet die EINE Frage, die das Konzept an jeden Chart-Einstieg
// stellt (§3 Punkt 4): steht eine aufgedeckte Spalte schon auf ihrem WAHREN
// Wert, oder wächst sie aus der Null? Gemessen wird mit dem Rig von P1 —
// `e2e/motion-lab/shoot.mjs` hält die Maske an definierten Zeitpunkten AN und
// fotografiert, `analyze-frames.py` vergleicht jede aufgedeckte Spalte mit dem
// Endbild. Ein einziges „zu niedrig" wäre ein lesbarer Falschwert.
//
// ⚠ `analyze-frames.py` braucht Pillow. Ist es nicht da, wird das GESAGT und
//   nicht geschätzt (`P7_PY=/pfad/zu/python`).
function lauf(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24 });
  return { ok: r.status === 0, aus: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
async function abschnittF() {
  await serve('dist');
  const PY = process.env.P7_PY ?? 'python3';
  const dir = process.env.P7_FRAMES ?? '/tmp/vp-p7-frames';
  mkdirSync(dir, { recursive: true });
  const b = lauf('node', ['e2e/motion-lab/shoot.mjs', '--port', String(PORT), '--vw', '375',
    '--cpu', '4', '--out', dir, '--name', 'balken', '--frames', `balken=anlage/${SITE}/fahrplan`,
    '--sel', '.vp-chart-motion', '--times', '0,80,160,240,320,400', '--wait', '9000']);
  if (!b.ok) { say('(f) Ehrlichkeits-Stichprobe nicht gemessen, weil die Frames nicht entstanden:'); say(`    ${b.aus.trim().split('\n').slice(-1)[0]}`); return; }
  const a = lauf(PY, ['e2e/motion-lab/analyze-frames.py', `${dir}/balken-t*.png`]);
  const zeilen = a.aus.trim().split('\n');
  if (!a.ok) { say('(f) Ehrlichkeits-Stichprobe nicht gemessen, weil die Auswertung scheiterte:'); say(`    ${zeilen.slice(-1)[0]}`); return; }
  const daten = zeilen.filter((l) => /^balken-t/.test(l));
  const urteil = zeilen.find((l) => /zu niedrig ueber alle Frames/.test(l)) ?? '?';
  say(`(f) Ehrlichkeit des Chart-Einstiegs (Balken-Chart „Fahrplan", 375 px · CPU 4×, Rig aus P1):`);
  say(`    ${daten.map((l) => { const t = l.split(/\s+/); return `${t[0].replace('balken-t', '').replace('.png', '')}ms ${t[1]}/${t[2]}`; }).join(' · ')}  (Zeit → aufgedeckt/auf Endhöhe)`);
  say(`    ${urteil.trim()}`);
  say('    Erlöse-Balken und Minis: nicht gemessen — der lokale Stack hat für diese Anlage keine Messwerte, also gibt es die Flächen nicht.');
}

// --- Lauf -------------------------------------------------------------------
if (want('a')) inventar();
if (['b', 'c', 'd', 'e', 'f', 'g'].some(want)) {
  await serve();
  const browser = await chromium.launch();
  try {
    if (want('b')) await abschnittB(browser);
    if (want('c')) await abschnittC(browser);
    if (want('d')) await abschnittD(browser);
    if (want('e')) await abschnittE(browser);
    if (want('f')) await abschnittF();
    if (want('g')) await abschnittG(browser);
  } finally { await browser.close(); server?.kill(); }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\n→ ${OUT} (${lines.length} Zeilen)`);
process.exit(0);
