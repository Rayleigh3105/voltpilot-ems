/**
 * **Die CHART-FAMILIEN** (Bewegungs-Programm P2).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §5 (Spec-Quelle, Zeilen A–D),
 * §7.3 (Schwelle), §9 Zeile P2; Captain-Entscheid 04.09.2026.
 *
 * P1 gab den 16 Diagrammen EINE Uhr. P2 gibt ihnen drei Verhaltensweisen, und
 * jede sitzt an genau EINER Stelle, weil sie sonst 14-mal vergessen werden
 * könnte:
 *
 * 1. **Interaktion** — `emphasis.focus: 'series'` + `blurScope` + ein `blur`,
 *    das die EIGENE Deckkraft der Serie viertelt.
 * 2. **Übergang** — `replaceMerge` statt `notMerge`, damit ECharts die Serie
 *    MISCHT (das ist der Morph) statt sie neu zu bauen; dazu eine stabile
 *    Kennung, ohne die `replaceMerge` gar nicht abbilden kann.
 * 3. **Live** — die Marker-Bausteine (`markLine` & Geschwister) erben die Uhr,
 *    damit der Jetzt-Marker WANDERT statt zu springen.
 *
 * Dazu die Kehrseite des Mischens, die es ohne P2 nicht gäbe: ein Feld, das
 * der Aufrufer nicht mehr nennt, muss ausdrücklich verschwinden.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLUR_FAKTOR,
  REPLACE_MERGE,
  mergeArt,
  mergeMotion,
  motionOptions,
  fokusGriff,
  serienMitBewegung,
  zeigerSchwebt,
  type ChartMotion,
  type TypSpur,
} from './chartMotion';

const M: ChartMotion = { scale: 1, enter: 400, update: 300, base: 200, fast: 120 };
const AUS: ChartMotion = { scale: 0, enter: 0, update: 0, base: 0, fast: 0 };
const mo = (m = M) => motionOptions(m, 'update');
const spur = (): TypSpur => ({ serien: new Map() });

/** Eine Serie durch die Bewegung schicken und die erste zurückbekommen. */
function eine(s: Record<string, unknown>, sp?: TypSpur, m = M): Record<string, unknown> {
  const raus = serienMitBewegung([s], mo(m), sp) as Record<string, unknown>[];
  return raus[0];
}

describe('Interaktion: Fokus und Dimmen (Spec §5, alle Familien)', () => {
  it('jede Serie trägt Fokus auf die Serie und Dimmen im Koordinatensystem', () => {
    const s = eine({ type: 'line', name: 'PV', data: [] });
    expect(s.emphasis).toEqual({ focus: 'series', blurScope: 'coordinateSystem' });
  });

  it('gedimmt wird auf ein Viertel — und zwar der EIGENEN Deckkraft', () => {
    // Die Geister-Reihe des Vergleichs zeichnet schon blass (0,45). Stünde hier
    // ein fester Wert 0,25, würde sie beim Dimmen HELLER als vorher — das
    // Gegenteil der Aussage.
    const geist = eine({ type: 'line', name: 'Vorjahr', lineStyle: { opacity: 0.45 } });
    // Auf drei Stellen gerundet — ein Options-Objekt trägt keine
    // Fließkomma-Schwänze.
    expect((geist.blur as Record<string, Record<string, number>>).lineStyle.opacity).toBe(0.113);
    const voll = eine({ type: 'bar', name: 'Bezug' });
    expect((voll.blur as Record<string, Record<string, number>>).itemStyle.opacity).toBeCloseTo(
      BLUR_FAKTOR,
      3,
    );
  });

  it('eine Fläche wird mitgedimmt — sonst bleibt sie hell über einer blassen Linie', () => {
    const s = eine({ type: 'line', name: 'PV', areaStyle: { opacity: 0.1 } });
    const blur = s.blur as Record<string, Record<string, number>>;
    expect(blur.areaStyle.opacity).toBeCloseTo(0.1 * BLUR_FAKTOR, 4);
    expect(blur.lineStyle.opacity).toBeCloseTo(BLUR_FAKTOR, 3);
  });

  it('kein Diagramm trägt eine eigene nackte Dauer — die Uhr kommt aus P1', () => {
    // Die Interaktions-Dauer ist `stateAnimation` (120 ms) und steht EINMAL in
    // `motionOptions`. Eine Serie, die sie selbst mitbrächte, wäre der zweite
    // Ort, an dem sie beim Schalter 0 vergessen würde.
    const s = eine({ type: 'line', name: 'PV' });
    expect(Object.keys(s)).not.toContain('animationDuration');
    expect(mo().stateAnimation).toEqual({ duration: 120, easing: 'cubicOut' });
    expect(motionOptions(AUS, 'update').stateAnimation.duration).toBe(0);
  });

  it('was die Fläche selbst sagt, gewinnt', () => {
    const s = eine({ type: 'line', name: 'PV', emphasis: { disabled: true } });
    expect(s.emphasis).toEqual({ disabled: true });
  });
});

describe('Übergang: mischen statt neu bauen (Spec §5 Zeile A/B)', () => {
  it('`notMerge: true` wird zu `replaceMerge` — die Serien überleben und morphen', () => {
    expect(mergeArt([true])).toEqual([
      { replaceMerge: [...REPLACE_MERGE], lazyUpdate: false },
    ]);
  });

  it('die Ersetz-Liste ist so breit wie das frühere `notMerge`', () => {
    // Eine Anlage ohne Ladestand hat eine y-Achse weniger, ein Zeitraum ohne
    // Vergleich eine Legende weniger. Würden die MISCHEN, blieben Geister
    // stehen — genau der Grund, aus dem die Flächen einst `notMerge` setzten.
    for (const k of ['series', 'xAxis', 'yAxis', 'grid', 'legend']) {
      expect(REPLACE_MERGE).toContain(k);
    }
  });

  it('eine Fläche mit eigenem `replaceMerge` behält ihres, `lazyUpdate` reist mit', () => {
    expect(mergeArt([{ notMerge: true, replaceMerge: ['series'] }])).toEqual([
      { replaceMerge: ['series'] },
    ]);
    expect(mergeArt([])).toEqual([]);
    expect(mergeArt([{ lazyUpdate: true }])).toEqual([{ lazyUpdate: true }]);
  });

  it('die Kennung ist stabil und trägt den Formtyp NICHT', () => {
    // Messwerte zeichnen denselben „Hausverbrauch" am Tag als Linie und ab der
    // Woche als Balken. Stünde der Typ in der Kennung, wären das zwei Serien —
    // `replaceMerge` würfe die eine weg, und Linie → Balken könnte nie morphen.
    const tag = eine({ type: 'line', name: 'Hausverbrauch' });
    const woche = eine({ type: 'bar', name: 'Hausverbrauch' });
    expect(tag.id).toBe(woche.id);
  });

  it('zwei namensgleiche Serien bekommen trotzdem verschiedene Kennungen', () => {
    const raus = serienMitBewegung(
      [{ type: 'line', name: 'PV' }, { type: 'line', name: 'PV' }],
      mo(),
    ) as Record<string, unknown>[];
    expect(raus[0].id).not.toBe(raus[1].id);
  });

  it('Linie → Balken morpht; ein bloßer Datenwechsel nicht', () => {
    const sp = spur();
    expect(eine({ type: 'line', name: 'Haus', data: [1] }, sp).universalTransition).toBeUndefined();
    // Zeitraumwechsel Tag → Woche: derselbe Name, anderer Formtyp.
    expect(eine({ type: 'bar', name: 'Haus', data: [2] }, sp).universalTransition).toEqual({
      enabled: true,
    });
    // Und danach wieder aus: ein Live-Punkt soll die eingebaute Datenanimation
    // fahren, nicht einen Element-Morph.
    expect(eine({ type: 'bar', name: 'Haus', data: [3] }, sp).universalTransition).toBeUndefined();
  });

  it('ohne Vorbild wird nichts behauptet — die erste Zeichnung morpht nie', () => {
    expect(eine({ type: 'bar', name: 'Haus' }, spur()).universalTransition).toBeUndefined();
  });
});

describe('Die Kehrseite des Mischens: was nicht mehr genannt wird, verschwindet', () => {
  it('ein weggelassener Jetzt-Marker wird ausdrücklich genullt', () => {
    const sp = spur();
    eine({ type: 'line', name: 'Plan', data: [], markLine: { data: [{ xAxis: 3 }] } }, sp);
    const ohne = eine({ type: 'line', name: 'Plan', data: [] }, sp);
    // Ohne diese Zeile bliebe der Marker eines vergangenen Tages stehen —
    // `replaceMerge` mischt, und Mischen kennt kein Weglassen.
    expect(ohne.markLine).toBeNull();
  });

  it('was weiter genannt wird, bleibt unangetastet', () => {
    const sp = spur();
    eine({ type: 'line', name: 'PV', areaStyle: { opacity: 0.1 }, data: [] }, sp);
    const s = eine({ type: 'line', name: 'PV', areaStyle: { opacity: 0.1 }, data: [] }, sp);
    expect(s.areaStyle).toEqual({ opacity: 0.1 });
    expect(s.data).toEqual([]);
  });

  it('die eigenen Zutaten werden nie genullt — sonst fiele der Fokus aus', () => {
    const sp = spur();
    eine({ type: 'bar', name: 'A' }, sp); // schreibt id/emphasis/blur
    const s = eine({ type: 'bar', name: 'A' }, sp);
    expect(s.emphasis).toEqual({ focus: 'series', blurScope: 'coordinateSystem' });
    expect(s.blur).not.toBeNull();
    expect(s.id).toBe('vp:A');
  });
});

describe('Live: der Jetzt-Marker wandert (Spec §5 Zeile C)', () => {
  it('`markLine` erbt die Uhr des Diagramms', () => {
    const s = eine({ type: 'line', name: 'Plan', markLine: { data: [{ xAxis: 3 }] } });
    expect(s.markLine).toMatchObject({
      animation: true,
      animationDurationUpdate: 300,
      animationEasingUpdate: 'cubicInOut',
      data: [{ xAxis: 3 }],
    });
  });

  it('beim Schalter 0 steht er sofort', () => {
    const s = eine({ type: 'line', name: 'Plan', markLine: { data: [] } }, undefined, AUS);
    expect(s.markLine).toMatchObject({ animation: false, animationDurationUpdate: 0 });
  });

  it('ein Marker, den die Fläche selbst taktet, behält sein Wort', () => {
    const s = eine({
      type: 'line',
      name: 'Plan',
      markArea: { animationDurationUpdate: 0, data: [] },
    });
    expect((s.markArea as Record<string, unknown>).animationDurationUpdate).toBe(0);
  });
});

describe('Die Zahlen ändern sich nicht', () => {
  it('Serien-Daten reisen unverändert durch die Bewegung', () => {
    const daten = [1.5, null, 3.25];
    const opt = { series: [{ type: 'bar', name: 'Bezug', data: daten }] };
    const raus = mergeMotion(opt as Record<string, unknown>, M, 'update', spur());
    const s = (raus.series as Record<string, unknown>[])[0];
    expect(s.data).toBe(daten);
    expect(s.name).toBe('Bezug');
    expect(s.type).toBe('bar');
  });

  it('die Schwelle bleibt bei 2000 — dichte Verläufe schalten den Morph selbst ab', () => {
    expect(mo().animationThreshold).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Die RATSCHEN: was den Morph strukturell unmöglich macht
// ---------------------------------------------------------------------------

const src = resolve(dirname(fileURLToPath(import.meta.url)));

/** Jede `.ts`/`.tsx` unter `src/`, ohne Tests. */
function quellen(): string[] {
  const raus: string[] = [];
  const gehe = (d: string) => {
    for (const e of readdirSync(d)) {
      const pfad = join(d, e);
      if (statSync(pfad).isDirectory()) {
        if (e !== 'node_modules' && e !== '__snapshots__') gehe(pfad);
      } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
        raus.push(pfad);
      }
    }
  };
  gehe(src);
  return raus;
}

/** Treffer je Datei, Kommentare vorher entfernt (sie NENNEN die Verstöße). */
function treffer(muster: RegExp): string[] {
  const raus: string[] = [];
  for (const datei of quellen()) {
    const text = readFileSync(datei, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    if (muster.test(text)) raus.push(relative(src, datei));
  }
  return raus;
}

describe('Telefon: der Tipp ist die Fahne, kein Schwebe-Zustand bleibt hängen (Spec §5)', () => {
  const zeiger = (schwebt: boolean) => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
      matches: q === '(hover: hover)' ? schwebt : false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    });
  };
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('ohne Schweben trägt KEINE Serie einen Dimm-Zustand', () => {
    zeiger(false);
    const raus = mergeMotion({ series: [{ name: 'PV', type: 'line' }] }, M, 'update');
    const s = (raus.series as Record<string, unknown>[])[0];
    // Ein Tipp auf dem Touchscreen hebt hervor und nimmt nie zurück: ein
    // gesetztes `blur` bliebe auf einem Viertel stehen und läse sich als
    // Aussage über die Zahlen.
    expect(s.blur).toBeUndefined();
    expect(s.emphasis).toEqual({ focus: 'none' });
  });

  it('mit Schweben bleibt alles wie am Schreibtisch', () => {
    zeiger(true);
    const raus = mergeMotion({ series: [{ name: 'PV', type: 'line' }] }, M, 'update');
    const s = (raus.series as Record<string, unknown>[])[0];
    expect(s.emphasis).toEqual({ focus: 'series', blurScope: 'coordinateSystem' });
    expect(s.blur).toBeTruthy();
  });

  it('ohne Schweben erscheint die Fahne auf einen ABSICHTLICHEN Tipp', () => {
    zeiger(false);
    const raus = mergeMotion({ tooltip: { trigger: 'axis', confine: true } }, M, 'update');
    // Werkseitig (`mousemove|click`) blitzt sie schon beim Wischen auf.
    expect((raus.tooltip as Record<string, unknown>).triggerOn).toBe('click');
    expect((raus.tooltip as Record<string, unknown>).confine).toBe(true);
  });

  it('am Schreibtisch wird der Auslöser NICHT angefasst', () => {
    zeiger(true);
    const raus = mergeMotion({ tooltip: { trigger: 'axis' } }, M, 'update');
    // Sonst verlöre die Maus ihren Schwebe-Tooltip.
    expect((raus.tooltip as Record<string, unknown>).triggerOn).toBeUndefined();
  });

  it('was die Fläche selbst über den Auslöser sagt, gewinnt', () => {
    zeiger(false);
    const raus = mergeMotion({ tooltip: { trigger: 'axis', triggerOn: 'none' } }, M, 'update');
    expect((raus.tooltip as Record<string, unknown>).triggerOn).toBe('none');
  });

  it('ohne `matchMedia` gilt die Maus-Fassung — kein Test verliert seinen Fokus', () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    expect(zeigerSchwebt()).toBe(true);
  });
});

describe('Live: ein Re-Plan bewegt nur die geänderten Slots (Spec §5 Zeile C)', () => {
  /** Zwei Fahrplan-Stände: derselbe Tag, ein Re-Plan hat drei Slots geändert. */
  const vorher = [0, 0, 4.2, 4.2, -1.1, -1.1, 0, 0];
  const nachher = [0, 0, 4.2, 6.8, -3.5, -1.1, 0, 0];

  it('dieselbe Serie behält ihre Kennung — ECharts mischt, statt neu zu bauen', () => {
    const sp = spur();
    const a = eine({ name: 'Batterie', type: 'bar', data: vorher }, sp);
    const b = eine({ name: 'Batterie', type: 'bar', data: nachher }, sp);
    // Gleiche Kennung ⇒ `replaceMerge` bildet Slot auf Slot ab; ECharts
    // interpoliert dann je Datenpunkt, und ein Punkt, dessen Wert gleich
    // bleibt, hat nichts zu interpolieren — er steht still.
    expect(a.id).toBe(b.id);
    expect(b.data).toEqual(nachher);
  });

  it('ein Re-Plan ist KEIN Formwechsel — der teure Element-Morph bleibt aus', () => {
    const sp = spur();
    eine({ name: 'Batterie', type: 'bar', data: vorher }, sp);
    const b = eine({ name: 'Batterie', type: 'bar', data: nachher }, sp);
    expect(b.universalTransition).toBeUndefined();
  });

  it('der Jetzt-Marker wandert mit derselben Uhr wie die Balken', () => {
    const sp = spur();
    eine({ name: 'Batterie', type: 'bar', data: vorher, markLine: { data: [{ xAxis: 2 }] } }, sp);
    const b = eine(
      { name: 'Batterie', type: 'bar', data: nachher, markLine: { data: [{ xAxis: 3 }] } },
      sp,
    );
    const ml = b.markLine as Record<string, unknown>;
    expect(ml.animationDurationUpdate).toBe(M.update);
    expect((ml.data as unknown[])[0]).toEqual({ xAxis: 3 });
  });
});

describe('Der Fokus-Griff verbindet die HTML-Legende mit ihrem Diagramm', () => {
  /** Karte: Legende und Diagramm sind GESCHWISTER, nicht Vorfahr und Kind. */
  const karte = (griff?: unknown) => {
    const wurzel = document.createElement('div');
    const legende = document.createElement('div');
    const chart = document.createElement('div');
    chart.className = 'vp-chart-motion';
    if (griff) (chart as unknown as Record<string, unknown>).__vpFokus = griff;
    wurzel.append(legende, chart);
    return { wurzel, legende, chart };
  };

  it('findet das Diagramm derselben Karte', () => {
    const gerufen: (string | null)[] = [];
    const { legende } = karte((n: string | null) => gerufen.push(n));
    fokusGriff(legende)?.('PV');
    fokusGriff(legende)?.(null);
    expect(gerufen).toEqual(['PV', null]);
  });

  it('greift NICHT in eine fremde Karte', () => {
    // Zwei Karten nebeneinander: die Legende der einen darf die Serien der
    // anderen nicht blass machen.
    const a = karte(() => {});
    const b = karte(() => {});
    const seite = document.createElement('div');
    seite.append(a.wurzel, b.wurzel);
    a.chart.remove(); // Karte A hat (noch) kein Diagramm
    expect(fokusGriff(a.legende, 1)).toBeNull();
  });

  it('ohne Griff wird nichts behauptet', () => {
    const { legende } = karte();
    expect(fokusGriff(legende)).toBeNull();
  });
});

describe('Ratschen — nur kleiner werden (Konzept §9 Zeile P2)', () => {
  it('kein Diagramm ruft `clear()` — das verliert den Morph', () => {
    // `chart.clear()` wirft JEDE Komponente weg; das darauffolgende
    // `setOption` baut alles neu, also läuft die Einstiegsanimation statt
    // eines Übergangs. Die Hülle kann das NICHT reparieren — sie sieht nur
    // `setOption`. Deshalb ist es hier eine Ratsche und keine Übersetzung.
    expect(treffer(/\bchart(\.current)?\.clear\(\)/)).toEqual([]);
  });

  it('nur die Hülle legt ein Diagramm an', () => {
    // Wer selbst `echarts.init` ruft, hat keine Hülle: kein `replaceMerge`,
    // keine stabile Kennung, keine Maske. Das Diagramm sähe richtig aus und
    // spränge — die leise Sorte Fehler.
    expect(treffer(/\becharts\.init\(/).filter((f) => f !== 'useEChart.ts')).toEqual([]);
    expect(treffer(/\bchart(\.current)?\.dispose\(\)/).filter((f) => f !== 'useEChart.ts')).toEqual(
      [],
    );
  });
});
