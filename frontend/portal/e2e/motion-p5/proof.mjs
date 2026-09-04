/* Browser-Beweis · Bewegungs-Programm P5 (Seitenwechsel)
 *
 * jsdom kennt die View-Transitions-API nicht — die sechs Zusagen von P5 lassen
 * sich deshalb NUR im echten Browser messen. Dieses Skript ist Werkzeug, kein
 * Testlauf (keine CI-Verdrahtung, kein PNG im Repo).
 *
 * Aufruf (Dev-Server + Demo-Stack müssen laufen):
 *   VP_BASE=http://localhost:5185/ node e2e/motion-p5/proof.mjs
 *
 * ⚠ VP_BASE muss `localhost` sein, nicht `127.0.0.1` — die Keycloak-Weiche des
 *   Realms lässt nur `http://localhost:<port>` als Ursprung zu.
 * ⚠ Echte 375 werden über `document.documentElement.clientWidth` nachgewiesen,
 *   nie über `window.innerWidth` (das zählt die Bildlaufleiste mit).
 */
import { chromium } from 'playwright';

const BASE = process.env.VP_BASE || 'http://localhost:5185/';
const SITE = process.env.VP_SITE || '00000000-0000-0000-0000-000000000012';
const out = { a: null, b: null, c: null, d: null, e: null, f: null };

/** Fängt die Animationen JEDES Übergangs ab — der einzige belastbare Weg an
 *  die Dauer/Richtung der `::view-transition-*`-Pseudos. */
const SPY = `
window.__vt = [];
window.__err = [];
addEventListener('error', (e) => window.__err.push(String(e.message)));
if (document.startViewTransition && !document.__vtPatched) {
  document.__vtPatched = true;
  const orig = document.startViewTransition.bind(document);
  document.startViewTransition = (cb) => {
    const t = orig(cb);
    t.ready.then(() => {
      const cls = (document.documentElement.className.match(/vp-vt-\\w+/) || [])[0] || null;
      window.__vt.push({
        cls,
        anims: document.getAnimations().map((a) => {
          const kf = (a.effect.getKeyframes ? a.effect.getKeyframes() : [])
            .map((k) => k.transform || null).filter(Boolean);
          return {
            name: a.animationName || null,
            pseudo: a.effect.pseudoElement || null,
            dur: a.effect.getComputedTiming().duration,
            transforms: kf,
          };
        }),
      });
    }, () => {});
    return t;
  };
}`;

/** Verschiebt sich in dieser Animationsmenge irgendetwas in X? */
function xShift(anims) {
  let max = 0;
  for (const a of anims) {
    for (const t of a.transforms) {
      const m = /translateX\(\s*(-?[\d.]+)(px|%)\s*\)/.exec(t);
      if (m) max = Math.max(max, Math.abs(parseFloat(m[1])));
    }
  }
  return max;
}

const rootAnims = (rec) => rec.anims.filter((a) => /\(root\)/.test(a.pseudo || ''));

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (await page.locator('#username').count()) {
    await page.fill('#username', 'demo');
    await page.fill('#password', 'demo');
    await page.click('#kc-login');
  }
  await page.waitForFunction(() => !document.querySelector('#username'), { timeout: 30000 });
  await page.waitForTimeout(2500);
}

/** Eine Adresse setzen, wie ein Link es tut (`hashchange` → die EINE Hülle). */
async function go(page, hash, settle = 900) {
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await page.waitForTimeout(settle);
}

async function chain(page) {
  await page.evaluate(() => { window.__vt.length = 0; });
  await go(page, '/uebersicht');
  await page.evaluate(() => { window.__vt.length = 0; });
  const steps = {};
  await go(page, `/anlage/${SITE}`);                 steps.portfolioZuAnlage = 1;
  await go(page, `/anlage/${SITE}/messwerte`);       steps.anlageZuReiter = 2;
  await go(page, `/anlage/${SITE}/erloese`);         steps.reiterZuGeschwister = 3;
  await page.goBack();  await page.waitForTimeout(900);
  await page.goBack();  await page.waitForTimeout(900);
  const rec = await page.evaluate(() => window.__vt);
  return rec;
}

const run = async () => {
  const browser = await chromium.launch();

  /* ---- (a) 375: schiebt, und in der richtigen Richtung -------------------- */
  {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true,
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await login(page);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const rec = await chain(page);
    // Die Schale NACH der Kette messen: die Telefon-Fußleiste rendert die
    // Flotten-Ebene gar nicht, auf der Anlagen-Ebene sehr wohl.
    await go(page, `/anlage/${SITE}`);
    const shell = await page.evaluate(() => {
      const n = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).viewTransitionName : null; };
      return { kopf: n('.vp-topbar'), seite: n('.vp-sidebar'), fuss: n('.vp-bottombar') };
    });
    out.a = {
      clientWidth, shell,
      schritte: rec.map((r) => ({
        klasse: r.cls,
        namen: rootAnims(r).map((x) => x.name).sort(),
        dauer: rootAnims(r).map((x) => x.dur).sort((p, q) => p - q),
        xVerschiebung: xShift(rootAnims(r)),
      })),
    };
    await ctx.close();
  }

  /* ---- (b) 1440: blendet nur, X bleibt exakt 0 ---------------------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await login(page);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const rec = await chain(page);
    out.b = {
      clientWidth,
      schritte: rec.map((r) => ({
        klasse: r.cls,
        namen: rootAnims(r).map((x) => x.name).sort(),
        dauer: rootAnims(r).map((x) => x.dur).sort((p, q) => p - q),
        xVerschiebung: xShift(rootAnims(r)),
      })),
    };
    await ctx.close();
  }

  /* ---- (c) 375 + CPU 4×: Bilder und Long Tasks, VORHER gegen NACHHER -----
   *  „Vorher" ist der Schnitt von heute: OHNE `document.startViewTransition`
   *  läuft `commit` byte-identisch den Pfad, den main fährt (siehe (e)) — das
   *  ist der faire Vergleich auf DEMSELBEN Stand. */
  {
    const messen = async (mitAPI) => {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
      await ctx.addInitScript((mitAPI ? '' : 'delete Document.prototype.startViewTransition;') + SPY);
      const page = await ctx.newPage();
      await login(page);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await go(page, `/anlage/${SITE}`, 1600);
      await page.evaluate(() => {
        window.__frames = []; window.__long = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
          .observe({ entryTypes: ['longtask'] });
        let last = performance.now();
        const tick = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 240) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await go(page, `/anlage/${SITE}/messwerte`, 2500);
      const m = await page.evaluate(() => {
        const f = window.__frames.slice(1);
        return {
          bilder: f.length,
          maxBild: Math.round(Math.max(...f)),
          ueber33: f.filter((x) => x > 33).length,
          longTasks: window.__long.length,
          longMax: window.__long.length ? Math.max(...window.__long) : 0,
          longSumme: window.__long.reduce((a, b) => a + b, 0),
        };
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await ctx.close();
      return m;
    };
    out.c = { vorher: await messen(false), nachher: await messen(true) };
  }

  /* ---- (d) reduzierte Bewegung ⇒ Schnitt (jede Dauer 0) ------------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await login(page);
    await go(page, '/uebersicht');
    await page.evaluate(() => { window.__vt.length = 0; });
    await go(page, `/anlage/${SITE}`);
    const rec = await page.evaluate(() => window.__vt);
    out.d = {
      uebergaenge: rec.length,
      dauern: rec.flatMap((r) => r.anims.map((a) => a.dur)),
      route: await page.evaluate(() => window.location.hash),
    };
    await ctx.close();
  }

  /* ---- (e) ohne die API ⇒ der Schnitt von heute, keine Fehler ------------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript('delete Document.prototype.startViewTransition;' + SPY);
    const page = await ctx.newPage();
    const konsole = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const u = (m.location() && m.location().url) || '';
      konsole.push(`${m.text()} <${u}>`);
    });
    page.on('pageerror', (e) => konsole.push(String(e)));
    await login(page);
    await go(page, '/uebersicht');
    await go(page, `/anlage/${SITE}`);
    await go(page, `/anlage/${SITE}/messwerte`);
    out.e = {
      apiDa: await page.evaluate(() => typeof document.startViewTransition),
      uebergaenge: await page.evaluate(() => window.__vt.length),
      route: await page.evaluate(() => window.location.hash),
      inhalt: await page.evaluate(() => document.body.innerText.length),
      konsolenfehler: konsole,
    };
    await ctx.close();
  }

  /* ---- (f) zwei schnelle Wechsel ⇒ nichts hängt, das Ziel stimmt ---------- */
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    await ctx.addInitScript(SPY);
    const page = await ctx.newPage();
    await login(page);
    await go(page, `/anlage/${SITE}`);
    await page.evaluate(() => { window.__vt.length = 0; });
    await page.evaluate((s) => {
      window.location.hash = `/anlage/${s}/messwerte`;
      setTimeout(() => { window.location.hash = `/anlage/${s}/erloese`; }, 60);
    }, SITE);
    await page.waitForTimeout(3000);
    out.f = {
      route: await page.evaluate(() => window.location.hash),
      offeneAnimationen: await page.evaluate(() => document.getAnimations().filter((a) => /view-transition/.test(a.effect.pseudoElement || '')).length),
      uebergaenge: await page.evaluate(() => window.__vt.length),
      inhalt: await page.evaluate(() => document.body.innerText.length),
      fehler: await page.evaluate(() => window.__err),
    };
    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(out, null, 1));
};

run().catch((e) => { console.error('FEHLER', e); process.exit(1); });
