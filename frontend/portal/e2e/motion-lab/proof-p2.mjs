// HARNESS · Bewegung P2: die Beweise (a)-(g) der Chart-Familien in EINEM Lauf.
//
//   node e2e/motion-lab/proof-p2.mjs --port 5182 [--reduced] [--vw 375] [--cpu 4]
//
// ⚠ WARUM DIE LEINWAND UND NICHT DER SCHIRM: ein Sprung ist keine Frage der
// Bilddatei, sondern der Zwischenzustaende. Gemessen wird deshalb IN der Seite
// alle ~40 ms der Pixelstand des Canvas; ein MORPH zeigt eine Kette kleiner
// Aenderungen, ein SPRUNG genau ein Bild, in dem fast alles anders ist. Das ist
// schaerfer als ein Screenshot-Vergleich und kostet keine Datei.
import { chromium } from 'playwright';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const APP = `http://localhost:${arg('port', process.env.VP_PORT || '5182')}`;
const SITE = arg('site', '00000000-0000-0000-0000-000000000012');
const vw = Number(arg('vw', '1440'));
const cpu = Number(arg('cpu', '1'));
const out = [];
const sag = (s) => { out.push(s); };

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: vw <= 500 ? { width: vw, height: 812 } : { width: vw, height: 900 },
  deviceScaleFactor: vw <= 500 ? 2 : 1,
  isMobile: vw <= 500, hasTouch: vw <= 500,
  ...(has('reduced') ? { reducedMotion: 'reduce' } : {}),
});
// Aufdeck-Zaehler aus P1: er muss ueber einen Zeitraumwechsel hinweg auf 1
// stehen bleiben - genau das beweist "gemischt, nicht neu gebaut".
await ctx.addInitScript(() => {
  window.__reveal = new Map();
  let n = 0;
  const beobachter = new MutationObserver((es) => {
    for (const e of es) {
      const el = e.target;
      if (!(el instanceof Element)) continue;
      const jetzt = el.classList.contains('is-entering');
      const vorher = (e.oldValue || '').split(/\s+/).includes('is-entering');
      if (jetzt && !vorher) {
        if (!el.dataset.vpk) el.dataset.vpk = String(++n);
        const k = el.dataset.vpk;
        window.__reveal.set(k, (window.__reveal.get(k) || 0) + 1);
      }
    }
  });
  // ⚠ Der Beobachter wird erst gehaengt, wenn es einen Baum gibt: beim
  // Dokument-Start kann `documentElement` noch fehlen, und ein Wurf hier
  // risse die Film-Funktionen weiter unten mit ins Nichts.
  const haenge = () => beobachter.observe(document.documentElement, {
    subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true,
  });
  if (document.documentElement) haenge();
  else document.addEventListener('readystatechange', haenge, { once: true });
  // Der Leinwand-Mitschnitt: ~40 ms Takt, je Bild ein Streifen Pixel.
  window.__film = null;
  window.__filmStart = (sel) => {
    // ⚠ Die Leinwand wird JE BILD neu gesucht: baut die Flaeche ihren Behaelter
    // um, zeigt eine festgehaltene Referenz auf ein abgehaengtes Element und
    // liefert ewig dasselbe Bild — ein Sprung saehe dann aus wie Stillstand.
    if (!document.querySelector(sel + ' canvas')) return false;
    const bilder = [];
    const t0 = performance.now();
    const tick = () => {
      const c = document.querySelector(sel + ' canvas');
      if (c) {
        const g = c.getContext('2d', { willReadFrequently: true });
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const p = [];
        let tinte = 0;
        for (let i = 0; i < d.length; i += 400) {
          p.push(d[i]);
          // „Tinte" = eine Probe, die sich vom hellen Grund abhebt. Sie faellt,
          // wenn eine Serie blasser wird — der gerenderte Beleg des Dimmens.
          if (d[i + 3] > 8 && d[i] < 235) tinte++;
        }
        bilder.push({ t: performance.now() - t0, p, tinte });
      }
      if (bilder.length < 60) window.__film.id = setTimeout(tick, 40);
    };
    window.__film = { bilder, id: null };
    tick();
    return true;
  };
  // Der ECharts-Griff: der Dev-Server liefert die Abhaengigkeit unter einer
  // festen Adresse mit Versions-Marke. GENAU DIESE Adresse zu importieren gibt
  // dieselbe Modul-Instanz, die auch die Seite geladen hat — nur so findet
  // `getInstanceByDom` das Diagramm wieder (ein zweiter Import waere ein
  // zweites Register und faende nichts). Der Portal-Code traegt keinen Haken.
  window.__ec = async () => {
    if (window.__ecm) return window.__ecm;
    const v = (performance.getEntriesByType('resource').map((r) => r.name)
      .find((n) => /deps\/react\.js\?v=/.test(n)) || '').split('v=')[1] || '';
    window.__ecm = await import(/* @vite-ignore */ `/node_modules/.vite/deps/echarts.js?v=${v}`);
    return window.__ecm;
  };
  window.__inst = async (i = 0) => {
    const m = await window.__ec();
    const el = document.querySelectorAll('.vp-chart-motion')[i];
    return el ? m.getInstanceByDom(el) : null;
  };
  // Auswertung: je Bildpaar der Anteil GEAENDERTER Proben.
  window.__filmStop = () => {
    if (!window.__film) return null;
    clearTimeout(window.__film.id);
    const b = window.__film.bilder;
    const diffs = [];
    for (let i = 1; i < b.length; i++) {
      let n = 0;
      for (let j = 0; j < b[i].p.length; j++) if (b[i].p[j] !== b[i - 1].p[j]) n++;
      diffs.push({ t: Math.round(b[i].t), d: n / b[i].p.length });
    }
    const bewegt = diffs.filter((x) => x.d > 0.002);
    // ⚠ „Sprung" heisst: das Diagramm war in EINEM Bild fertig. Ein grosser
    // Einzelschritt MITTEN in einer Kette ist dagegen Teil eines Morphs — bei
    // einem Formwechsel (Linie → Balken) aendert sich zwangslaeufig viel auf
    // einmal. Gezaehlt wird deshalb der ISOLIERTE Knall: viel Aenderung, und
    // davor wie danach Ruhe.
    const knall = diffs.filter((x, i) => x.d > 0.5
      && (diffs[i - 1]?.d ?? 0) < 0.01 && (diffs[i + 1]?.d ?? 0) < 0.01);
    return {
      bilder: b.length,
      spruenge: knall.length,
      stufen: bewegt.length,
      von: bewegt.length ? bewegt[0].t : null,
      bis: bewegt.length ? bewegt[bewegt.length - 1].t : null,
      groesster: diffs.length ? Math.max(...diffs.map((x) => x.d)) : 0,
      tinteVon: b.length ? b[0].tinte : null,
      tinteBis: b.length ? b[b.length - 1].tinte : null,
    };
  };
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
async function oeffne(hash, warten = 6000) {
  await page.goto(`${APP}/#/${hash}`); await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(warten);
  // ⚠ Der Dev-Bestand endet vor HEUTE: die Flaeche zeigt dann ehrlich „keine
  // Messwerte" und zeichnet gar kein Diagramm. Der Beweis braucht echte Daten,
  // also nimmt er den Weg, den die Flaeche selbst anbietet.
  const letzter = page.getByText(/Zum letzten Tag mit Daten/);
  if (await letzter.count()) {
    await letzter.first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(5000);
  }
  const n = await page.evaluate(() => document.querySelectorAll('.vp-chart-motion').length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((i) => document.querySelectorAll('.vp-chart-motion')[i]?.scrollIntoView({ block: 'center' }), i);
    await page.waitForTimeout(1100);
  }
  await page.waitForTimeout(900);
  return n;
}
const zaehle = () => page.evaluate(() => {
  const v = [...window.__reveal.values()];
  return { charts: v.length, max: Math.max(0, ...v) };
});
/** Einen Knopf druecken und dabei die Leinwand filmen. */
async function filme(sel, klick) {
  const ok = await page.evaluate((s) => window.__filmStart(s), sel);
  if (!ok) return null;
  const getroffen = await klick();
  await page.waitForTimeout(2400);
  const f = await page.evaluate(() => window.__filmStop());
  return f ? { ...f, getroffen } : f;
}
// ⚠ Die Zeitraum-Schalter sind `role="tab"`, nicht `button` (Haus-Muster der
// Umschalt-Gruppen). Beide Rollen werden gesucht, sonst greift der Beweis ins
// Leere und meldet faelschlich „kein Sprung".
const knopf = async (name) => {
  for (const rolle of ['tab', 'button']) {
    const b = page.getByRole(rolle, { name, exact: true });
    if (await b.count()) {
      await b.first().click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
};

try {
  await login();

  if (vw > 500 && !has('reduced')) {
    // --- (a) Zeitraumwechsel ---------------------------------------------
    // ⚠ Der Dev-Bestand endet vor HEUTE, und heute ist der Einstieg jeder
    // Flaeche. Messwerte springt per Verweis auf den letzten Tag mit Daten
    // (in `oeffne`); die Erloese-Flaeche bietet den Verweis nicht an, dort
    // wird zuerst auf einen Zeitraum MIT Daten gestellt. Sonst filmte der
    // Beweis ein leeres Bild und meldete faelschlich „kein Sprung".
    for (const [flaeche, hash, vorlauf, folge] of [
      ['Messwerte', `anlage/${SITE}/messwerte`, null, ['Woche', 'Monat']],
      // ⚠ Die Erloese-Flaeche steht hier NICHT: sie zeigt ein Diagramm nur in
      // der Tages-Ansicht, Woche/Monat sind ein Kontoauszug. Ein Zeitraum-
      // wechsel nimmt das Diagramm dort also ganz weg — es gibt nichts zu
      // morphen. Marktpreise ist die zweite Flaeche mit einem Diagramm ueber
      // ALLE Zeitraeume (im Browser nachgesehen).
      ['Marktpreise', `anlage/${SITE}/marktpreise`, null, ['Woche', 'Monat']],
    ]) {
      await oeffne(hash);
      if (vorlauf) {
        await knopf(vorlauf);
        await page.waitForTimeout(4500);
        // Der Zeitraumwechsel kann den Behaelter neu montieren; er deckt sich
        // erst auf, wenn er IM BLICK ist (P1).
        await page.evaluate(() => document.querySelector('.vp-chart-motion')
          ?.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(2500);
      }
      await page.evaluate(() => window.__reveal.clear());
      const r = [];
      for (const z of folge) {
        const f = await filme('.vp-chart-motion', () => knopf(z));
        const vorher = (await zaehle()).max;
        r.push(f ? `${z}: ${f.stufen} Stufen ${f.von}-${f.bis}ms, Knall ${f.spruenge}` : `${z}: kein Diagramm`);
        void vorher;
        await page.waitForTimeout(1300);
      }
      const z = await zaehle();
      // ⚠ „neu aufgedeckt 0x" heisst: DASSELBE Diagramm hat gemorpht. Steht da
      // 1x, wurde der Behaelter neu montiert — dann ist der Einstieg die
      // CSS-Maske aus P1, und die kann dieser Film gar nicht sehen (er liest
      // die LEINWAND, die Maske liegt darueber). Ein „Knall" ist in dem Fall
      // der Wechsel auf ein neues, fertig gezeichnetes Bild, kein Sprung aus
      // der Null — genau das „Einblenden", das die Spec fuer einen nicht
      // morphbaren Wechsel verlangt.
      sag(`(a) ${flaeche}: ${r.join(' | ')} | neu aufgedeckt ${z.max}x ${z.max ? '(neu montiert ⇒ Maske blendet ein)' : '(gemorpht)'}`);
    }

    // --- (b) Eine Serie kommt und geht ----------------------------------
    // ⚠ Einen „Vergleich ein/aus"-Schalter gibt es auf diesen Flaechen nicht:
    // der Vorperioden-Vergleich laeuft immer mit (im Browser nachgesehen).
    // Dieselbe Frage stellt der LEGENDEN-Umschalter — eine Serie verschwindet
    // und kommt zurueck. Genau der Fall, fuer den `replaceMerge` gebaut ist.
    await oeffne(`anlage/${SITE}/messwerte`);
    await page.evaluate(() => window.__reveal.clear());
    const legendeKlick = () => page.evaluate(() => {
      const z = document.querySelectorAll('.vp-chart-legend .vp-cl-item.is-toggle');
      if (z.length < 2) return false;
      const label = z[1].textContent?.trim().split('\n')[0] || 'Serie';
      z[1].click();
      return label;
    });
    const weg = await filme('.vp-chart-motion', legendeKlick);
    await page.waitForTimeout(900);
    const wieder = await filme('.vp-chart-motion', legendeKlick);
    const zv = await zaehle();
    sag(weg?.getroffen === false
      ? `(b) kein Legenden-Umschalter auf dieser Flaeche | neu aufgedeckt ${zv.max}x`
      : `(b) Serie "${weg?.getroffen}" aus: ${weg?.stufen} Stufen, Knall ${weg?.spruenge} | wieder an: ${wieder?.stufen} Stufen, Knall ${wieder?.spruenge} | neu aufgedeckt ${zv.max}x`);

    // --- (c) Legenden-Hover dimmt die anderen ----------------------------
    await oeffne(`anlage/${SITE}/messwerte`);
    const vertrag = await page.evaluate(async () => {
      const inst = await window.__inst();
      if (!inst) return { instanz: false };
      const o = inst.getOption();
      const s = (o.series || [])[0] || {};
      const eins = (v) => (Array.isArray(v) ? v[0] : v);
      return {
        instanz: true,
        serien: (o.series || []).length,
        focus: s.emphasis?.focus, scope: s.emphasis?.blurScope,
        blur: s.blur?.lineStyle?.opacity ?? s.blur?.itemStyle?.opacity,
        id: s.id,
        state: eins(o.stateAnimation)?.duration,
        update: eins(o.animationDurationUpdate),
      };
    });
    // Der GERENDERTE Beleg. ⚠ Gezaehlt wird der PIXEL-UNTERSCHIED, nicht
    // „Tinte": eine Linie auf einem Viertel Deckkraft ist ueber hellem Grund
    // immer noch dunkler als der Grund, ein Schwellenwert saehe also fast
    // nichts (gemessen: -1 %). Der Unterschied sagt WIE VIEL sich geaendert
    // hat, die mittlere Helligkeit in WELCHE RICHTUNG (dimmen macht heller),
    // und die Ruecknahme muss das Bild EXAKT wiederherstellen.
    // ⚠ ECHTES Schweben mit dem Zeiger, nicht ein gesendetes `mouseenter`:
    // React haengt `onMouseEnter` an eine Delegation ueber `mouseover`, ein
    // von Hand erzeugtes Ereignis erreicht den Handler also gar nicht
    // (gemessen: 0 von 4097 Proben aenderten sich). Nur der echte Zeiger
    // beweist, dass die Legende des Portals das Dimmen ausloest.
    const probeF = () => page.evaluate(() => {
      const c = document.querySelector('.vp-chart-motion canvas');
      if (!c) return null;
      const d = c.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height).data;
      const a = []; for (let i = 0; i < d.length; i += 400) a.push(d[i]);
      return a;
    });
    const zeilen = page.locator('.vp-chart-legend .vp-cl-item');
    const hatLegende = (await zeilen.count()) > 0;
    let dim = { keineLegende: !hatLegende };
    if (hatLegende) {
      const vor = await probeF();
      await zeilen.first().hover();
      await page.waitForTimeout(400);
      const nach = await probeF();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      const zurueck = await probeF();
      const mittel = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const anders = (a, b2) => a.reduce((n, v, i) => n + (v !== b2[i] ? 1 : 0), 0);
      dim = {
        proben: vor.length,
        geaendert: anders(vor, nach),
        heller: +(mittel(nach) - mittel(vor)).toFixed(2),
        rest: anders(vor, zurueck),
      };
    }
    sag(dim?.keineLegende
      ? '(c) gerendert: keine HTML-Legende auf dieser Flaeche'
      : `(c) Legenden-Schweben: ${dim?.geaendert}/${dim?.proben} Proben aendern sich, Bild ${dim?.heller} heller (= dimmen), Zeiger weg stellt her (${dim?.rest} Abweichungen)`);
    sag(`(c) Uhr: update=${vertrag.update}ms (P1-Token), Kennung stabil: ${vertrag.id}`);

    // --- (e) Fahrplan: ein Re-Plan bewegt nur die geaenderten Slots -------
    await oeffne(`anlage/${SITE}/fahrplan`);
    const rp = await page.evaluate(async () => {
      const inst = await window.__inst();
      if (!inst) return { instanz: false };
      const o = inst.getOption();
      const s = (o.series || []).filter((x) => Array.isArray(x.data) && x.data.length > 8);
      if (!s.length) return { instanz: true, serien: 0 };
      const ziel = s[0];
      const idsVorher = (o.series || []).map((x) => x.id);
      const alt = JSON.parse(JSON.stringify(ziel.data));
      const zahl = (d) => (d && typeof d === 'object' && 'value' in d ? d.value : d);
      const setze = (d, w) => (d && typeof d === 'object' && 'value' in d ? { ...d, value: w } : w);
      // Ein Re-Plan: DREI Slots anders, alle anderen Zeichen fuer Zeichen gleich.
      const geaendert = [5, 6, 7];
      const neu = alt.map((d, i) => {
        const w = zahl(d);
        if (!geaendert.includes(i)) return d;
        if (typeof w === 'number') return setze(d, w + 2.5);
        if (Array.isArray(w) && typeof w[1] === 'number') return setze(d, [w[0], w[1] + 2.5]);
        return d;
      });
      const wirklich = neu.filter((d, i) => JSON.stringify(d) !== JSON.stringify(alt[i])).length;
      // ⚠ Es MUESSEN alle Serien mitreisen: `replaceMerge` entfernt jede
      // Komponente, die das neue Bild nicht nennt. Genau so tut es die Flaeche
      // auch (sie baut ihre Optionen bei jedem Bild komplett neu).
      inst.setOption(
        { series: (o.series || []).map((x) => (x.id === ziel.id ? { ...x, data: neu } : x)) },
        { replaceMerge: ['series'] },
      );
      const nach = inst.getOption();
      const idsNachher = (nach.series || []).map((x) => x.id);
      const zurueck = (nach.series || []).find((x) => x.id === ziel.id)?.data || [];
      const gleich = zurueck.filter((d, i) => JSON.stringify(d) === JSON.stringify(alt[i])).length;
      return {
        instanz: true, serien: s.length, slots: alt.length,
        idsBleiben: idsVorher.every((i) => idsNachher.includes(i)),
        geaendert: wirklich, unveraendert: gleich,
        elementMorph: (nach.series || []).some((x) => x.universalTransition?.enabled),
      };
    });
    sag(`(e) Fahrplan Re-Plan: ${rp.serien} Serien / ${rp.slots} Slots, Kennungen bleiben ${rp.idsBleiben}, geaendert ${rp.geaendert}, unveraendert ${rp.unveraendert}, Element-Morph ${rp.elementMorph}`);
  }

  if (vw <= 500 && !has('reduced')) {
    // --- (d) Telefon: Tipp = Fahne, kein Zustand haengt -------------------
    await oeffne(`anlage/${SITE}/messwerte`);
    const t = await page.evaluate(async () => {
      const inst = await window.__inst();
      if (!inst) return { instanz: false };
      const o = inst.getOption();
      const s = (o.series || [])[0] || {};
      const tt = Array.isArray(o.tooltip) ? o.tooltip[0] : o.tooltip || {};
      return {
        instanz: true,
        breite: document.documentElement.clientWidth,
        focus: s.emphasis?.focus, blur: s.blur !== undefined,
        triggerOn: tt.triggerOn, confine: tt.confine,
      };
    });
    const box = await page.locator('.vp-chart-motion').first().boundingBox();
    if (box) {
      await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.waitForTimeout(700);
    }
    const haengt = await page.evaluate(async () => {
      const inst = await window.__inst();
      if (!inst) return null;
      const blass = inst.getModel().getSeries().some((sm) => {
        const el = sm.getData()?.getItemGraphicEl?.(0);
        return el?.currentStates?.includes?.('blur');
      });
      const fahne = [...document.querySelectorAll('.vp-chart-motion div')]
        .some((d) => /position:\s*absolute/.test(d.getAttribute('style') || '')
          && (d.textContent || '').trim().length > 3);
      return { blass, fahne };
    });
    sag(`(d) Telefon ${t.breite}px: focus=${t.focus} blur=${t.blur} triggerOn=${t.triggerOn} confine=${t.confine} | nach Tipp blass=${haengt?.blass} Fahne=${haengt?.fahne}`);
  }

  if (has('reduced')) {
    // --- (f) reduced: nichts morpht -------------------------------------
    await oeffne(`anlage/${SITE}/messwerte`);
    const r = await page.evaluate(async () => {
      const inst = await window.__inst();
      if (!inst) return { instanz: false };
      const o = inst.getOption();
      const s = (o.series || [])[0] || {};
      return {
        echarts: true,
        animation: o.animation,
        update: o.animationDurationUpdate,
        state: o.stateAnimation?.[0]?.duration ?? o.stateAnimation?.duration,
        markLine: s.markLine?.animationDurationUpdate,
      };
    });
    const f = await filme('.vp-chart-motion', () => knopf('Woche'));
    sag(`(f) reduced: animation=${r.animation} update=${r.update}ms state=${r.state}ms markLine=${r.markLine} | Wechsel: Stufen ${f ? f.stufen : '-'} (steht sofort)`);
  }

  if (cpu > 1) {
    // --- (g) 375 + CPU-Drossel: lange Bilder beim Morph ------------------
    await oeffne(`anlage/${SITE}/messwerte`);
    await page.evaluate(() => {
      window.__lang = []; let last = performance.now();
      const t = () => { const n = performance.now(); window.__lang.push(n - last); last = n; requestAnimationFrame(t); };
      requestAnimationFrame(t);
    });
    await knopf('Woche'); await page.waitForTimeout(1600);
    const g = await page.evaluate(() => {
      const a = window.__lang.slice(5);
      return { n: a.length, ueber33: a.filter((x) => x > 33).length, max: Math.round(Math.max(0, ...a)) };
    });
    sag(`(g) 375px CPU ${cpu}x: ${g.ueber33}/${g.n} Bilder ueber 33ms, laengstes ${g.max}ms`);
  }
} catch (e) {
  sag(`FEHLER: ${String(e).slice(0, 160)}`);
} finally {
  await browser.close();
}
console.log(out.join('\n'));
