// Browser-Beweis für Bewegungs-Programm P4 (App-Start + Login-Bühne).
//
// Er misst gegen einen PRODUKTIONS-Build (`serve-proof.mjs` liefert `dist*`
// statisch und leitet `/api` an die Cloud-API weiter) — der Dev-Server mit
// seinem Modul-Wasserfall verfälschte jede LCP-Zahl.
//
//   node e2e/motion-p4/proof.mjs            # (a)-(e), Zusammenfassung nach OUT
//   node e2e/motion-p4/proof.mjs a d        # nur einzelne Abschnitte
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = Number(process.env.P4_PORT ?? 5173); // 5173: die EINZIGE Rueckleit-URL, die der Dev-Realm kennt
const BASE = `http://localhost:${PORT}/`;
const OUT = process.env.P4_OUT
  ?? '/Users/mvogt/IdeaProjects/firstmate/data/vp-motion-p4-start-login/proof.txt';
const only = process.argv.slice(2);
const want = (k) => only.length === 0 || only.includes(k);
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

// --- Der Mess-Server -------------------------------------------------------
let server;
async function serve(root) {
  if (server) { server.kill(); await new Promise((r) => setTimeout(r, 300)); }
  server = spawn('node', ['e2e/motion-p4/serve-proof.mjs', String(PORT), root], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE); if (r.ok) return; } catch { /* noch nicht da */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Mess-Server auf ${root} kam nicht hoch`);
}

// --- Der Aufzeichner IM Dokument -------------------------------------------
// Er läuft ab dem ersten Byte des NEUEN Dokuments und überlebt damit den
// Wechsel, den ein Polling von aussen nicht sieht: während des
// Navigations-Commits gibt es keinen Kontext, den man befragen könnte.
const RECORDER = `(() => {
  window.__p4 = [];
  const sichtbar = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tick = () => {
    const sk = document.getElementById('vp-boot-skeleton');
    const root = document.getElementById('root');
    window.__p4.push({
      t: Math.round(performance.now()),
      skelett: sichtbar(sk),
      inhalt: !!root && root.childElementCount > 0 && sichtbar(root),
    });
  };
  tick();
  setInterval(tick, 40);
})()`;

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const btn = page.getByRole('button', { name: 'Anmelden' });
  await btn.first().waitFor({ timeout: 30000 });
  await btn.first().click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', 'demo');
  await page.fill('#password', 'demo');
  await page.click('#kc-login');
  await page.waitForTimeout(4000);
}

async function oeffneCockpit(page) {
  await page.waitForSelector('.vp-at-zeile, .vp-at-karte, .vp-cockpit-stack', { timeout: 30000 });
  if (!(await page.locator('.vp-cockpit-stack').count())) {
    await page.locator('.vp-at-zeile, .vp-at-karte').first().click();
    await page.waitForSelector('.vp-cockpit-stack', { timeout: 30000 });
  }
  await page.waitForTimeout(1500);
  return page.url();
}

// --- (a) Start bei 375, CPU 4x, Fast 3G ------------------------------------
async function abschnittA(browser) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await login(page);
  const url = await oeffneCockpit(page);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });

  await page.addInitScript(RECORDER);
  // ⚠ `goto` auf dieselbe Adresse ist eine SELBE-DOKUMENT-Navigation (nur der
  //   Hash wechselt): kein neues Dokument, also läuft KEIN `addInitScript`
  //   und das Boot-Skelett erscheint gar nicht erst. Nur `reload` startet
  //   den App-Start wirklich neu — genau das, was hier gemessen wird.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
  await page.waitForTimeout(1500);

  const breite = await page.evaluate(() => document.documentElement.clientWidth);
  const frames = await page.evaluate(() => window.__p4 ?? []);
  // ⚠ Der Aufzeichner tickt schon beim ersten Byte — da steht das Skelett noch
  //   gar nicht im Dokument (es kommt weiter unten im `body`). Dieser eine
  //   Frame ist der Zustand VOR dem ersten Bild, kein Flackern. Gezaehlt wird
  //   deshalb erst ab dem Frame, der das Skelett zum ersten Mal gesehen hat.
  const ab = frames.findIndex((f) => f.skelett);
  const luecken = frames.slice(ab < 0 ? 0 : ab).filter((f) => !f.skelett && !f.inhalt);
  const doppel = frames.filter((f) => f.skelett && f.inhalt);

  // Die Staffel des ersten Bildes — gemessen an dem, was der Browser rechnet.
  const staffel = await page.evaluate(() => {
    const stack = document.querySelector('.vp-cockpit-stack');
    if (!stack) return null;
    const kinder = [...stack.children];
    const verz = kinder.map((k) => getComputedStyle(k).animationDelay);
    return {
      klasse: stack.className.includes('vp-stagger'),
      n: kinder.length,
      // ⚠ Nicht jedes Kind laeuft mit: der Kopf traegt `data-vp-no-stagger`,
      //   und die ersten zwei Kinder stehen seit der CLS-Korrektur still
      //   (Begruendung am Selektor in `src/index.css`). Die Dauer wird
      //   deshalb am ersten Kind gelesen, das WIRKLICH animiert - sonst
      //   stuende hier 0s und saegte die Aussage ab.
      dauer: getComputedStyle(kinder.find((k) => parseFloat(getComputedStyle(k).animationDuration) > 0) ?? kinder[0]).animationDuration,
      verz,
      stehen: kinder.filter((k) => !(parseFloat(getComputedStyle(k).animationDuration) > 0)).length,
      ausgenommen: kinder.filter((k) => k.hasAttribute('data-vp-no-stagger')).length,
    };
  });

  // Der Deckel laesst sich am echten Stapel nicht zeigen — er hat nur 8 Karten.
  // Also wird die AUSGELIEFERTE Regel an einem Behaelter gemessen, der genug
  // Kinder hat: 12 leere Kinder in einen `.vp-stagger`, Verzoegerung ablesen.
  // Gemessen wird damit der Browser, nicht der Quelltext.
  const deckel = await page.evaluate(() => {
    const box = document.createElement('div');
    box.className = 'vp-stagger';
    box.style.cssText = 'position:fixed;left:-9999px;top:0';
    for (let i = 0; i < 12; i++) box.appendChild(document.createElement('div'));
    document.body.appendChild(box);
    const v = [...box.children].map((k) => getComputedStyle(k).animationDelay);
    box.remove();
    return v;
  });

  say(`(a) 375 px real: clientWidth=${breite} · CPU 4x + Fast 3G`);
  say(`    Frames a 40 ms: ${frames.length} (Skelett ab Frame ${ab}) · Luecke ohne Skelett UND ohne Inhalt: ${luecken.length} · Ueberblendung (beide zugleich): ${doppel.length} Frames = ${doppel.length * 40} ms`);
  if (staffel) {
    const echte = staffel.verz.filter((_, i) => i >= staffel.stehen);
    say(`    Staffel: Klasse=${staffel.klasse} · ${staffel.n} Kinder, davon ${staffel.stehen} stehend (erste Bildschirmhoehe) · Dauer ${staffel.dauer} · Versatz ab dem ${staffel.stehen + 1}. Kind ${echte.slice(0, 11).join(' ')}`);
  }
  {
    const zahl = deckel.map((v) => Math.round(parseFloat(v) * 1000));
    say(`    Deckel an 12 Kindern: ${zahl.join(' ')} ms — ab dem 9. konstant ${zahl[8]} ms (8 x 30)`);
  }
  await ctx.close();
  return url;
}

// --- (b) LCP/FCP vorher gegen nachher, PAARWEISE ---------------------------
// ⚠ Ein Block „erst 9x nachher, dann 9x vorher" misst hier NICHTS: LCP faellt
//   auf `li`/`p` der Cockpit-Liste, also auf Inhalt, der erst NACH der Antwort
//   der Cloud-API erscheint — die Streuung des Backends (100…870 ms) ist um
//   ein Vielfaches groesser als alles, was ein 160-ms-Ausblenden bewirken
//   koennte. Zwei Blockmessungen hintereinander lieferten deshalb erst −116 ms
//   und dann +368 ms fuer denselben Code. Gemessen wird darum PAARWEISE in
//   EINER Sitzung: derselbe Tab, dieselbe Anmeldung, abwechselnd der eine und
//   der andere Build, sodass jede Drift beide Seiten gleich trifft.
const MESSER = () => {
  window.__lcp = 0; window.__fcp = 0; window.__cls = 0; window.__lcpEl = '-';
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      window.__lcp = Math.round(e.startTime);
      const el = e.element;
      // Zusaetzlich: sitzt das LCP-Element IN einer gestaffelten Karte, und
      // mit welcher Verzoegerung? Nur so laesst sich der Unterschied aus (b)
      // einer Ursache zuordnen statt ihn zu vermuten.
      const karte = el ? el.closest('.vp-stagger > *') : null;
      window.__lcpEl = el
        ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${karte ? ` in Karte ${[...karte.parentElement.children].indexOf(karte) + 1} (Versatz ${getComputedStyle(karte).animationDelay})` : ' (nicht gestaffelt)'}`
        : 'kein Element';
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__fcp = Math.round(e.startTime);
  }).observe({ type: 'paint', buffered: true });
  // ⚠ Die SUMME allein sagt nicht, WER springt. Der groesste Einzel-Sprung
  //   samt seinem Verursacher ist die Auskunft, mit der man ihn abstellen
  //   kann — `sources[0].node` nennt das Element, das seinen Platz gewechselt
  //   hat, nicht das, was daneben stand.
  window.__clsMax = 0; window.__clsWer = '-';
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls += e.value;
      if (e.value > window.__clsMax) {
        window.__clsMax = e.value;
        const n = e.sources?.[0]?.node;
        const el = n && n.nodeType === 1 ? n : n?.parentElement;
        window.__clsWer = el
          ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''} bei ${Math.round(e.startTime)} ms`
          : 'ohne benannte Quelle';
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

async function abschnittB(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await login(page);
  await oeffneCockpit(page);
  await page.addInitScript(MESSER);

  const nimm = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
    await page.waitForTimeout(2500);
    return page.evaluate(() => ({
      lcp: window.__lcp, fcp: window.__fcp, el: window.__lcpEl,
      cls: Math.round(window.__cls * 1000) / 1000,
      clsMax: Math.round(window.__clsMax * 1000) / 1000, clsWer: window.__clsWer,
    }));
  };

  const vor = []; const nach = [];
  for (let i = 0; i < 9; i++) {
    await serve('dist_vor'); vor.push(await nimm());
    await serve('dist_nach'); nach.push(await nimm());
  }
  await ctx.close();
  await serve('dist_nach');

  const zeig = (k, xs) => JSON.stringify(xs.map((x) => x[k]));
  const m = (k, xs) => median(xs.map((x) => x[k]));
  say(`(b) FCP Median 9 Paare (das Skelett selbst — die saubere Start-Zahl):`);
  say(`    vorher ${m('fcp', vor)} ms ${zeig('fcp', vor)}`);
  say(`    nachher ${m('fcp', nach)} ms ${zeig('fcp', nach)} · Delta ${m('fcp', nach) - m('fcp', vor)} ms`);
  say(`    LCP Median: vorher ${m('lcp', vor)} ms · nachher ${m('lcp', nach)} ms · Delta ${m('lcp', nach) - m('lcp', vor)} ms`);
  say(`    LCP-Element (nie das Skelett, immer Cockpit-Inhalt): ${[...new Set([...vor, ...nach].map((x) => x.el))].join(' ')}`);
  // Je Seite den groessten Einzelsprung nennen: nur so ist zu sehen, ob eine
  // Quelle NEU ist oder auf beiden Seiten gleich springt.
  const spitze = (xs) => [...xs].sort((a, b) => b.clsMax - a.clsMax)[0];
  say(`    CLS Median: vorher ${m('cls', vor)} · nachher ${m('cls', nach)}`);
  say(`    groesster Einzelsprung — vorher ${spitze(vor).clsMax} durch ${spitze(vor).clsWer}`);
  say(`                            nachher ${spitze(nach).clsMax} durch ${spitze(nach).clsWer}`);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// --- (f) Diagnose: WOHER kommt ein LCP-Unterschied? ------------------------
// Der Verdacht nach (b): nicht das Ausblenden des Skeletts, sondern die
// Staffel selbst — sie startet jede Karte bei `opacity: 0` (`backwards`), und
// Chrome nimmt ein vollstaendig durchsichtiges Element als LCP-Kandidaten
// NICHT an. Der Beweis ist ein dritter Arm: derselbe „nachher"-Build, nur die
// Staffel per Stylesheet stillgelegt. Kommt LCP dann auf den Vorher-Wert
// zurueck, ist die Ursache benannt und das Skelett entlastet.
async function abschnittF(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await login(page);
  await oeffneCockpit(page);
  await page.addInitScript(MESSER);
  await page.addInitScript((css) => {
    const st = document.createElement('style');
    st.textContent = css;
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
  }, process.env.P4_F_CSS ?? '.vp-stagger > * { animation: none !important; }');
  const werte = [];
  for (let i = 0; i < 9; i++) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
    await page.waitForTimeout(2500);
    werte.push(await page.evaluate(() => ({ lcp: window.__lcp, fcp: window.__fcp, cls: Math.round(window.__cls * 1000) / 1000, clsWer: window.__clsWer })));
  }
  await ctx.close();
  say(`(f) Diagnose [${process.env.P4_F_LABEL ?? 'MIT Skelett-Ausblenden, OHNE Staffel'}]:`);
  say(`    LCP Median ${median(werte.map((x) => x.lcp))} ms ${JSON.stringify(werte.map((x) => x.lcp))} · FCP ${median(werte.map((x) => x.fcp))} ms`);
  say(`    CLS Median ${median(werte.map((x) => x.cls))} · groesster Verursacher ${werte.sort((a, b) => b.cls - a.cls)[0].clsWer}`);
}

// --- (c) reduzierte Bewegung ----------------------------------------------
async function abschnittC(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await login(page);
  await oeffneCockpit(page);
  await page.addInitScript(RECORDER);
  // ⚠ `goto` auf dieselbe Adresse ist eine SELBE-DOKUMENT-Navigation (nur der
  //   Hash wechselt): kein neues Dokument, also läuft KEIN `addInitScript`
  //   und das Boot-Skelett erscheint gar nicht erst. Nur `reload` startet
  //   den App-Start wirklich neu — genau das, was hier gemessen wird.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vp-cockpit-stack', { timeout: 60000 });
  await page.waitForTimeout(1200);
  const frames = await page.evaluate(() => window.__p4 ?? []);
  const mitSkelett = frames.filter((f) => f.skelett);
  const letzte = mitSkelett.length ? mitSkelett[mitSkelett.length - 1].t : -1;
  const ersteInhalt = frames.find((f) => f.inhalt)?.t ?? -1;
  const still = await page.evaluate(() => {
    const stack = document.querySelector('.vp-cockpit-stack');
    const kind = stack?.children[1] ?? stack?.children[0];
    const spoke = document.querySelector('.vp-auth-flow .spoke');
    return {
      kartenDauer: kind ? getComputedStyle(kind).animationDuration : 'n/a',
      exitToken: getComputedStyle(document.documentElement).getPropertyValue('--vp-motion-exit').trim(),
      spoke: spoke ? getComputedStyle(spoke).animationName : 'nicht auf dieser Flaeche',
    };
  });
  say(`(c) reduced: Skelett in keinem 40-ms-Frame erwischt (${letzte} = nie) — es ist vor dem ersten Frame weg; Inhalt ab ${ersteInhalt} ms · --vp-motion-exit=${still.exitToken}`);
  say(`    Staffel-Dauer der Karten: ${still.kartenDauer} (0s = keine Staffel)`);
  await ctx.close();
}

// --- (d) Login-Bühne bei 1440 ----------------------------------------------
async function abschnittD(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vp-auth-card', { timeout: 30000 });
  const m = await page.evaluate(() => {
    const karte = document.querySelector('.vp-auth-card');
    const spoke = document.querySelector('.vp-auth-flow .spoke');
    const cs = karte ? getComputedStyle(karte) : null;
    return {
      karteName: cs?.animationName, karteDauer: cs?.animationDuration, karteEase: cs?.animationTimingFunction,
      spokeDauer: spoke ? getComputedStyle(spoke).animationDuration : 'Buehne nicht sichtbar',
      buehne: !!document.querySelector('.vp-auth-flow'),
    };
  });
  say(`(d) Login 1440: Karte ${m.karteName} ${m.karteDauer} ${m.karteEase}`);
  say(`    Bühne sichtbar=${m.buehne} · Laufpunkte ${m.spokeDauer} (1,8 s = Ruhetempo des Energieflusses)`);
  const red = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const rp = await red.newPage();
  await rp.goto(BASE, { waitUntil: 'domcontentloaded' });
  await rp.waitForSelector('.vp-auth-card', { timeout: 30000 });
  const r = await rp.evaluate(() => {
    const spoke = document.querySelector('.vp-auth-flow .spoke');
    const karte = document.querySelector('.vp-auth-card');
    return {
      spoke: spoke ? getComputedStyle(spoke).animationName : 'n/a',
      strich: spoke ? getComputedStyle(spoke).strokeDasharray : 'n/a',
      karte: karte ? getComputedStyle(karte).animationDuration : 'n/a',
    };
  });
  say(`    reduced: Laufpunkte animation-name=${r.spoke} · Karte ${r.karte} · Speichen weiterhin gezeichnet (${r.strich})`);
  await red.close(); await ctx.close();
}

// --- (e) zweiter Besuch ----------------------------------------------------
async function abschnittE(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page);
  await oeffneCockpit(page);
  const erst = await page.evaluate(() => document.querySelector('.vp-cockpit-stack')?.className ?? '');
  // Weg (Verlauf) und zurueck — dieselbe Sitzung, kein Neustart.
  await page.goto(`${BASE}#/anlagen`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // ⚠ HIER ist `goto` richtig: es ist eine Hash-Navigation IN derselben
  //   Sitzung — genau der zweite Besuch, den (e) beweisen soll. Ein
  //   `reload` waere ein Neustart und duerfte legitim wieder staffeln.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vp-cockpit-stack', { timeout: 30000 });
  await page.waitForTimeout(800);
  const zweit = await page.evaluate(() => {
    const stack = document.querySelector('.vp-cockpit-stack');
    const kind = stack?.children[0];
    return { klasse: stack?.className ?? '', dauer: kind ? getComputedStyle(kind).animationDuration : 'n/a' };
  });
  say(`(e) 1. Besuch: class="${erst.trim()}"`);
  say(`    2. Besuch: class="${zweit.klasse.trim()}" · Karten-Animationsdauer ${zweit.dauer}`);
  await ctx.close();
}

// --- Lauf ------------------------------------------------------------------
try {
  await serve('dist_nach');
  const browser = await chromium.launch({ headless: true });
  let url = `${BASE}#/uebersicht`;
  if (want('a')) url = await abschnittA(browser);
  else { const c = await browser.newContext(); const p = await c.newPage(); await login(p); url = await oeffneCockpit(p); await c.close(); }

  if (want('b')) await abschnittB(browser, url);
  if (want('f')) await abschnittF(browser, url);
  if (want('c')) await abschnittC(browser, url);
  if (want('d')) await abschnittD(browser);
  if (want('e')) await abschnittE(browser, url);
  await browser.close();
} finally {
  if (server) server.kill();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${lines.join('\n')}\n`);
}
