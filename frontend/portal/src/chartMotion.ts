import { zeigerSchwebt } from './chartFokus';

/**
 * **Der Bewegungs-Leser der Diagramme** (Bewegungs-Programm P1).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §4.3 + §5, Captain-Entscheid
 * 04.09.2026 („alle Empfehlungen nehmen", E1–E10 = a).
 *
 * Das Bewegungs-Gegenstueck zu {@link chartTheme} (Farben) und `chartStyle.ts`
 * (Geometrie): Canvas loest kein `var()` auf, also werden die Bewegungs-Tokens
 * aus dem `:root` GELESEN und als Zahlen an ECharts gereicht — dieselbe Technik,
 * derselbe Grund.
 *
 * ## ⚠ EINSTIEG IST NIE ECHARTS-WACHSTUM (E1 a, Ehrlichkeitsregel)
 *
 * Der Einstieg laeuft mit `animation: false`: jeder Balken, jede Linie steht ab
 * dem ERSTEN Bild auf ihrem wahren Wert. Aufgebaut wird nur die FORM — von einer
 * CSS-Maske am Container (`useEChart`, `@keyframes vp-chart-reveal`). Werkseitig
 * waechst ECharts aus der Null (gemessen: 0 % Tinte bis 126 ms, 26 % bei 405 ms),
 * und ein Balken auf halber Hoehe ist ein LESBARER FALSCHWERT. Deshalb ist der
 * Einstieg hier ausgeschaltet und nicht bloss verkuerzt.
 *
 * ## ⚠ MORPH NUR ZWISCHEN ZWEI ECHTEN ZUSTAENDEN
 *
 * Die Update-Phase darf morphen: der Zwischenwert ist die Interpolation zweier
 * GEMESSENER Zustaende (Zeitraumwechsel, neuer Live-Punkt) und liest sich als
 * Bewegung, nicht als Zahl. Ein Nullstart waere dagegen ein erfundener Wert —
 * genau der Unterschied, den {@link motionOptions} mit `phase` ausdrueckt.
 *
 * ## ⚠ NICHT GEMERKT (anders als `chartTheme()`)
 *
 * `chartTheme()` merkt sich seine Farben, weil Farben nach dem ersten Bild
 * feststehen. Der Bewegungs-Schalter `--vp-motion-scale` steht NICHT fest: er
 * haengt an `prefers-reduced-motion`, und das darf der Nutzer waehrend der
 * Sitzung umlegen. Ein Zwischenspeicher wuerde die Bewegung dann weiterlaufen
 * lassen, obwohl das System sie abbestellt hat. Kosten: EIN
 * `getComputedStyle`-Aufruf je `setOption` (gemessen unter 0,1 ms).
 */

/** Die vier Zahlen, die ein Diagramm aus der Bewegungs-Familie braucht. */
export interface ChartMotion {
  /** Einstieg: die Maske, die das Bild von links freigibt (ms, `--vp-motion-chart`). */
  enter: number;
  /** Uebergang zwischen zwei ECHTEN Zustaenden (ms, `--vp-motion-chart-update`). */
  update: number;
  /** Interaktion: Fokus/Dimmen, Tooltip, Achsen-Fahne (ms, `--vp-motion-fast`). */
  fast: number;
  /** 0 = Bewegung ist aus (`prefers-reduced-motion`) — alles steht sofort. */
  scale: number;
}

/**
 * Eine Token-Zahl aus einem schon gelesenen `CSSStyleDeclaration` holen.
 *
 * ⚠ Die Tokens sind per `@property` als `<time>` registriert (P0,
 * `designsystem/tokens/effects.css`), deshalb liefert `getComputedStyle` die
 * AUFGELOESTE Dauer (`"0.4s"` oder `"400ms"`), nie das `calc(...)` aus dem
 * Stylesheet. Beide Schreibweisen muessen gelesen werden: Chrome antwortet in
 * Sekunden, andere Maschinen in Millisekunden.
 */
function tokenMs(styles: CSSStyleDeclaration | null, name: string, fallback: number): number {
  if (!styles) return fallback;
  const roh = styles.getPropertyValue(name).trim();
  if (!roh) return fallback;
  const n = parseFloat(roh);
  if (!Number.isFinite(n)) return fallback;
  if (/ms$/i.test(roh)) return n;
  if (/s$/i.test(roh)) return n * 1000;
  return n; // dimensionslos: der Schalter selbst
}

/**
 * Die Bewegungs-Zahlen des laufenden Dokuments.
 *
 * Liest `getComputedStyle(document.documentElement)` GENAU EINMAL je Aufruf und
 * zieht alle vier Werte daraus (vier getrennte Aufrufe waeren vier Layout-
 * Abfragen fuer dieselbe Antwort). Ohne DOM (Server, Testlauf) gelten die
 * Initialwerte der Familie — dieselben Zahlen wie in `effects.css` und
 * `motionPresets.ts`.
 */
export function chartMotion(): ChartMotion {
  const styles =
    typeof window !== 'undefined' && typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement)
      : null;
  return {
    enter: tokenMs(styles, '--vp-motion-chart', 400),
    update: tokenMs(styles, '--vp-motion-chart-update', 300),
    fast: tokenMs(styles, '--vp-motion-fast', 120),
    scale: tokenMs(styles, '--vp-motion-scale', 1),
  };
}

/** Die zwei Phasen eines Diagramms: erstes Bild vs. jeder spaetere Zustand. */
export type ChartPhase = 'enter' | 'update';

/** Die Bewegungs-Optionen, die {@link motionOptions} unter die Konsumenten legt. */
export interface MotionOptions {
  animation: boolean;
  /**
   * ⚠ 0 in BEIDEN Phasen — die Dauer der ERSTEN Zeichnung einer Serie.
   *
   * Sie wird gebraucht, seit der Uebergang mischt statt neu zu bauen (P2): eine
   * Serie, die MITTEN im Leben dazukommt (Vergleich an, eine Reihe wieder
   * eingeblendet), ist fuer ECharts brandneu und liefe sonst die
   * WERKS-Einstiegsanimation — 1000 ms aus der Null. Genau der lesbare
   * Falschwert, den P1 fuer das erste Bild abgeschafft hat. Eine dazukommende
   * Serie steht deshalb sofort auf ihrem wahren Wert.
   */
  animationDuration: number;
  animationEasing: 'cubicOut';
  animationDurationUpdate: number;
  animationEasingUpdate: 'cubicInOut';
  animationDelayUpdate: 0;
  animationThreshold: number;
  stateAnimation: { duration: number; easing: 'cubicOut' };
  /**
   * Nur ergaenzt, wo das Diagramm selbst einen Tooltip erklaert — siehe
   * {@link mergeMotion}.
   *
   * ⚠ `triggerOn` reist NUR auf einem Beruehrungs-Bildschirm mit: dort ist der
   * Tooltip die einzige Geste, und die Werks-Einstellung `'mousemove|click'`
   * laesst ihn schon beim Wischen ueber das Diagramm aufblitzen. `'click'`
   * macht ihn zu dem, was er am Telefon sein soll — eine Fahne, die auf einen
   * ABSICHTLICHEN Tipp erscheint. Am Schreibtisch bleibt die Werks-Einstellung,
   * sonst verloere die Maus ihren Schwebe-Tooltip.
   */
  tooltip: { transitionDuration: number; triggerOn?: 'click' };
  /** dito fuer die Achsen-Fahne. */
  axisPointer: { animationDurationUpdate: number };
}

/**
 * Die ECharts-Optionen einer Phase.
 *
 * - **`enter`** ⇒ `animation: false`. Der Wert steht, die Maske baut die Form.
 * - **`update`** ⇒ Morph in `--vp-motion-chart-update` mit `cubicInOut`
 *   (E3: bewegen/morphen nimmt die Zwischen-Kurve, nicht die Ankommen-Kurve).
 * - **Schalter 0** ⇒ jede Dauer 0 und `animation: false`. Der Endzustand wird
 *   trotzdem gesetzt, nur eben sofort (Konzept §7.4).
 *
 * ⚠ `animationThreshold` bleibt bei 2000 (Werk, Konzept §7.3): der dichteste
 * Chart im Umfang hat 576 Punkte, und ueber der Schwelle schaltet ECharts den
 * Morph selbst ab — richtig so, das ist der Schutz vor einem Ruckler bei einem
 * Jahres-Explorer, keine Bewegungs-Entscheidung von uns.
 */
export function motionOptions(
  m: ChartMotion,
  phase: ChartPhase,
  schwebt = true,
): MotionOptions {
  const aus = m.scale === 0;
  const update = aus ? 0 : m.update;
  const fast = aus ? 0 : m.fast;
  return {
    animation: phase === 'update' && !aus,
    animationDuration: 0,
    animationEasing: 'cubicOut',
    animationDurationUpdate: update,
    animationEasingUpdate: 'cubicInOut',
    animationDelayUpdate: 0,
    animationThreshold: 2000,
    stateAnimation: { duration: fast, easing: 'cubicOut' },
    tooltip: { transitionDuration: fast / 1000, ...(schwebt ? {} : { triggerOn: 'click' as const }) },
    axisPointer: { animationDurationUpdate: fast },
  };
}

/** Ein Wert, den wir flach mit unseren Vorgaben mischen duerfen. */
function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Die Optionen EINES Konsumenten mit der Bewegung der Phase unterlegen.
 *
 * ## ⚠ DER KONSUMENT GEWINNT — IMMER
 *
 * Die Bewegung liegt UNTER den Optionen des Diagramms, nie darueber. Drei
 * Flaechen setzen `animation: false` selbst (`BeobachteteRegister`,
 * `SiteMeasurementComparison`, `WhatIfCompareChart`) — die bleiben still, und
 * das ist gewollt (Konzept §2.2 „3 Stellen"). So bleiben alle 16 Konsumenten
 * unveraendert; der Hebel sitzt in {@link useEChart}.
 *
 * ## ⚠ TOOLTIP UND ACHSEN-FAHNE WERDEN NIE ERFUNDEN
 *
 * `tooltip` und `axisPointer` sind eigene ECharts-KOMPONENTEN: wer sie in die
 * Optionen schreibt, schaltet sie EIN. Ein Diagramm, das bewusst keinen Tooltip
 * hat, bekaeme durch eine Bewegungs-Dauer plötzlich einen. Deshalb werden die
 * zwei nur ERGAENZT, wo das Diagramm sie selbst erklaert — und dort flach
 * gemischt, damit `axisPointer.link` und der ganze Tooltip-Inhalt stehen bleiben.
 */
export function mergeMotion<T extends Record<string, unknown>>(
  opt: T,
  m: ChartMotion,
  phase: ChartPhase,
  spur?: TypSpur,
): T {
  // EINMAL je `setOption` gefragt und an beide Stellen gereicht, die davon
  // abhaengen (Tooltip-Ausloeser und Serien-Fokus) — zwei Abfragen fuer
  // dieselbe Antwort koennten sich mitten im Bild widersprechen.
  const schwebt = zeigerSchwebt();
  const mo = motionOptions(m, phase, schwebt);
  const { tooltip, axisPointer, ...basis } = mo;
  const gemischt: Record<string, unknown> = { ...basis, ...opt };
  if (istObjekt(opt.tooltip)) gemischt.tooltip = { ...tooltip, ...opt.tooltip };
  if (istObjekt(opt.axisPointer)) gemischt.axisPointer = { ...axisPointer, ...opt.axisPointer };
  if (opt.series !== undefined) {
    gemischt.series = serienMitBewegung(opt.series, mo, spur, schwebt);
  }
  return gemischt as T;
}

// ---------------------------------------------------------------------------
// P2 · je Serie: Fokus/Dimmen, stabile Kennung, Morph statt Neubau
// ---------------------------------------------------------------------------

/**
 * Die Komponenten, die ein Update ERSETZT statt zu mischen.
 *
 * ## ⚠ WARUM ES DIESE LISTE UEBERHAUPT GIBT
 *
 * Bis P2 rief JEDE Flaeche `setOption(option, true)` — die alte Stellungs-Form
 * von `notMerge`. Damit war jeder Zustandswechsel ein NEUBAU: ECharts warf alle
 * Serien weg und legte sie als brandneu wieder an, also lief die
 * Einstiegsanimation statt eines Uebergangs (gemessen: Balken wachsen 1000 ms
 * aus der Null, bei JEDEM Zeitraumwechsel und bei JEDEM Live-Takt). Der Morph
 * war damit strukturell unmoeglich — nicht abgeschaltet, sondern nie gebaut.
 *
 * `replaceMerge` ist die Antwort: Komponenten mit GLEICHER Kennung werden
 * gemischt (und morphen), verschwundene werden entfernt. Deshalb bekommt jede
 * Serie hier eine stabile Kennung — ohne sie faellt `replaceMerge` auf
 * „alles brandneu" zurueck (echarts `mappingToExists`: im `replaceMerge`-Modus
 * gibt es KEIN Abbilden ueber den Namen, nur ueber `id`).
 *
 * ⚠ Die Liste ist bewusst so BREIT wie das frueher gesetzte `notMerge`: eine
 * Anlage ohne Ladestand hat eine y-Achse weniger, ein Zeitraum ohne Vergleich
 * eine Legende weniger. Wuerden die MISCHEN, blieben Geister stehen — genau
 * der Grund, aus dem die Flaechen einst `notMerge` gesetzt haben.
 *
 * `visualMap` steht NICHT mehr darin (UX-Review V-01): kein Diagramm setzt ihn,
 * und `echarts.ts` registriert das Bauteil deshalb nicht mehr. Ein Name hier
 * ohne Registrierung wäre ein Absturz (`chartRegistrierung.test.ts`).
 */
export const REPLACE_MERGE = [
  'series',
  'xAxis',
  'yAxis',
  'grid',
  'legend',
  'graphic',
  'dataZoom',
  'title',
] as const;

/** Wie stark eine NICHT fokussierte Serie zurueckgenommen wird (Spec §5). */
export const BLUR_FAKTOR = 0.25;

/**
 * Was eine Serie im LETZTEN Bild war — je Diagramm gehalten.
 *
 * Gehalten von {@link useEChart} je Instanz, gelesen und fortgeschrieben von
 * {@link mergeMotion}. Es beantwortet zwei Fragen, die nur der Vergleich mit
 * dem Vorbild beantworten kann:
 *
 * 1. Hat DIESE Serie ihren Formtyp gewechselt (Linie ↔ Balken)? Nur dann wird
 *    `universalTransition` eingeschaltet — siehe {@link serienMitBewegung}.
 * 2. Welche Felder hatte sie, die sie jetzt NICHT mehr hat? Siehe unten.
 *
 * ## ⚠ WARUM DER FELDBESTAND MITWANDERT — DIE KEHRSEITE DES MISCHENS
 *
 * `notMerge` warf eine Serie weg und baute sie neu; ein weggelassenes Feld war
 * damit weg. `replaceMerge` MISCHT (das ist der Morph), und Mischen kennt kein
 * Weglassen: eine `markLine`, die es gestern gab und heute nicht mehr, bliebe
 * stehen — der Jetzt-Marker eines vergangenen Tages, die Flaeche einer Linie,
 * die keine mehr sein will. Ein Feld, das der Aufrufer NICHT MEHR nennt, wird
 * deshalb ausdruecklich auf `null` gesetzt; ECharts liest das als „gibt es
 * nicht". Die Aufrufer bauen ihr Serien-Objekt bei jedem Bild komplett neu
 * (reine Render-Funktionen), also heisst „nicht genannt" hier wirklich
 * „nicht gewollt".
 */
export interface TypSpur {
  serien: Map<string, { typ: string; felder: readonly string[] }>;
}

function opazitaet(stil: unknown, fallback = 1): number {
  if (istObjekt(stil) && typeof stil.opacity === 'number') return stil.opacity;
  return fallback;
}

/** 0,25 × die EIGENE Deckkraft der Serie — nie ein fester Wert. */
function gedimmt(stil: unknown): { opacity: number } {
  return { opacity: Math.round(opazitaet(stil) * BLUR_FAKTOR * 1000) / 1000 };
}

/**
 * Der Dimm-Zustand einer Serie, passend zu ihrem Formtyp.
 *
 * ## ⚠ 0,25 IST EIN FAKTOR, KEIN ABSOLUTWERT
 *
 * Eine Geister-Reihe des Vergleichs zeichnet schon bei 0,45; eine Flaeche liegt
 * bei 0,10. Wuerde hier stur `opacity: 0.25` stehen, wuerden diese beim Dimmen
 * HELLER — das Gegenteil der Aussage. Deshalb wird die eigene Deckkraft
 * gelesen und multipliziert.
 */
function blurFuer(s: Record<string, unknown>): Record<string, unknown> {
  const typ = typeof s.type === 'string' ? s.type : 'line';
  const blur: Record<string, unknown> = { itemStyle: gedimmt(s.itemStyle) };
  if (typ === 'line') blur.lineStyle = gedimmt(s.lineStyle);
  // Nur ergaenzen, was es gibt: `areaStyle`/`endLabel` sind eigene Bausteine,
  // und wer sie in den Dimm-Zustand schreibt, ohne dass die Serie sie hat,
  // erfindet nichts — aber wer sie AUSLAESST, laesst eine Flaeche hell stehen,
  // waehrend ihre Linie verblasst.
  if (istObjekt(s.areaStyle)) blur.areaStyle = gedimmt(s.areaStyle);
  if (istObjekt(s.label)) blur.label = gedimmt(s.label);
  if (istObjekt(s.endLabel)) blur.endLabel = gedimmt(s.endLabel);
  return blur;
}

/**
 * Die stabile Kennung EINER Serie — bewusst OHNE ihren Formtyp.
 *
 * ⚠ Der Formtyp darf nicht in die Kennung: Messwerte zeichnen denselben
 * „Hausverbrauch" am Tag als Linie und ab der Woche als Balken. Stuende der Typ
 * darin, waeren das zwei verschiedene Serien — `replaceMerge` warfe die eine weg
 * und legte die andere neu an, und der Uebergang Linie → Balken koennte gar
 * nicht morphen. Genau dafuer gibt es sie.
 */
function stabileId(
  s: Record<string, unknown>,
  ohneNamen: { n: number },
  benutzt: Set<string>,
): string {
  const name = typeof s.name === 'string' && s.name ? s.name : '';
  let id = name ? `vp:${name}` : `vp:#${ohneNamen.n++}`;
  // Zwei Serien duerfen denselben Namen tragen (Legende blendet sie zusammen).
  // Eine doppelte Kennung waere fuer ECharts eine Warnung und ein Abbildungs-
  // Fehler, also bekommt die zweite ihre eigene.
  let k = 2;
  while (benutzt.has(id)) id = `${name ? `vp:${name}` : `vp:#${ohneNamen.n}`}~${k++}`;
  benutzt.add(id);
  return id;
}

/** Die Marker-Bausteine einer Serie erben die Bewegung der Phase. */
function markerMitBewegung(
  s: Record<string, unknown>,
  ziel: Record<string, unknown>,
  mo: MotionOptions,
): void {
  for (const schluessel of ['markLine', 'markArea', 'markPoint'] as const) {
    const v = s[schluessel];
    if (!istObjekt(v)) continue;
    ziel[schluessel] = {
      animation: mo.animation,
      animationDuration: mo.animationDuration,
      animationDurationUpdate: mo.animationDurationUpdate,
      animationEasingUpdate: mo.animationEasingUpdate,
      ...v,
    };
  }
}

/**
 * Jede Serie bekommt Fokus/Dimmen, eine stabile Kennung und ihre Marker-Uhr.
 *
 * ## ⚠ DER KONSUMENT GEWINNT AUCH HIER
 *
 * `emphasis`, `blur`, `id` und `universalTransition` werden nur ERGAENZT. Eine
 * Flaeche, die selbst etwas dazu sagt, behaelt ihr Wort — dieselbe Regel wie
 * bei {@link mergeMotion} eine Ebene hoeher.
 *
 * ## ⚠ `universalTransition` NUR BEIM FORMWECHSEL
 *
 * Sie ist die einzige Technik, mit der eine Linie in einen Balken morpht
 * (Spec §5 Zeile A: „Tag↔Woche"). Sie DAUERHAFT einzuschalten waere aber
 * teuer und riskant: ECharts ersetzt dann bei JEDEM Update seine eingebaute
 * Datenanimation durch einen Element-Morph, auch dort, wo bloss ein Live-Punkt
 * dazukommt. Deshalb haengt sie an der {@link TypSpur}: eingeschaltet genau
 * fuer die Serien, deren Formtyp sich seit dem letzten Bild GEAENDERT hat.
 */
export function serienMitBewegung(
  series: unknown,
  mo: MotionOptions,
  spur?: TypSpur,
  schwebt = true,
): unknown {
  const liste = Array.isArray(series) ? series : [series];
  const ohneNamen = { n: 0 };
  const benutzt = new Set<string>();
  const gesehen: TypSpur['serien'] = new Map();
  const heraus = liste.map((roh) => {
    if (!istObjekt(roh)) return roh;
    const s = roh as Record<string, unknown>;
    const id = typeof s.id === 'string' && s.id ? s.id : stabileId(s, ohneNamen, benutzt);
    const typ = typeof s.type === 'string' ? s.type : '';
    const felder = Object.keys(s);
    gesehen.set(id, { typ, felder });
    const vorbild = spur?.serien.get(id);
    const formwechsel = Boolean(vorbild && typ && vorbild.typ && vorbild.typ !== typ);
    const ziel: Record<string, unknown> = {
      id,
      // Ohne Schweben KEIN Fokus und KEIN Dimm-Zustand — siehe
      // {@link zeigerSchwebt}. `focus: 'none'` ist dabei ausdruecklich gesetzt
      // statt bloss weggelassen: die Serie selbst darf ihre Hervorhebung
      // behalten, nur die ANDEREN duerfen nicht blass zurueckbleiben.
      emphasis: schwebt
        ? { focus: 'series', blurScope: 'coordinateSystem' }
        : { focus: 'none' },
      ...(schwebt ? { blur: blurFuer(s) } : {}),
      ...(formwechsel ? { universalTransition: { enabled: true } } : {}),
      ...vergesseneFelder(vorbild?.felder, s),
      ...s,
    };
    markerMitBewegung(s, ziel, mo);
    return ziel;
  });
  if (spur) spur.serien = gesehen;
  return Array.isArray(series) ? heraus : heraus[0];
}

/**
 * Die Felder des Vorbilds, die diesmal fehlen — jedes ausdruecklich auf `null`.
 *
 * ⚠ Betrachtet werden NUR die Felder des Aufrufers. Was {@link serienMitBewegung}
 * selbst dazulegt (`id`, `emphasis`, `blur`, `universalTransition`), steht in
 * jedem Bild und kann gar nicht verschwinden; es zu nullen wuerde den Fokus
 * beim naechsten Zustand abschalten.
 */
function vergesseneFelder(
  vorher: readonly string[] | undefined,
  jetzt: Record<string, unknown>,
): Record<string, null> {
  if (!vorher) return {};
  const weg: Record<string, null> = {};
  for (const k of vorher) if (!(k in jetzt)) weg[k] = null;
  return weg;
}

// ---------------------------------------------------------------------------
// P2 · Mischen statt Neubauen: die Uebersetzung von `notMerge`
// ---------------------------------------------------------------------------

/** Die zweite Stellung von `setOption` — positionell `true` oder ein Objekt. */
type MergeArt = boolean | { notMerge?: boolean; replaceMerge?: unknown; lazyUpdate?: boolean };

/**
 * `notMerge: true` in ein `replaceMerge` uebersetzen — die EINE Stelle.
 *
 * ## ⚠ SIE SITZT IN DER HUELLE, NICHT IN DEN 14 FLAECHEN
 *
 * Jede Flaeche rief `setOption(option, true)`. Dieselbe Zeile 17-mal zu aendern
 * hiesse, 17 Gelegenheiten zu schaffen, sie beim naechsten Chart zu vergessen —
 * und ein vergessenes `notMerge` ist NICHT laut: das Diagramm zeigt weiter die
 * richtigen Zahlen, es springt nur wieder. Die Huelle laesst das gar nicht erst
 * zu; ein neuer Chart bekommt den Morph, ohne davon zu wissen.
 *
 * Was uebrig bleibt, bleibt: eine Flaeche, die selbst ein `replaceMerge` nennt,
 * behaelt ihres, und `lazyUpdate` reist unveraendert mit.
 */
export function mergeArt(rest: readonly unknown[]): unknown[] {
  const erste = rest[0] as MergeArt | undefined;
  if (erste === true) return [{ replaceMerge: [...REPLACE_MERGE], lazyUpdate: rest[1] === true }];
  if (istObjekt(erste) && erste.notMerge === true) {
    const { notMerge: _weg, ...rest0 } = erste as Record<string, unknown>;
    return [{ ...rest0, replaceMerge: rest0.replaceMerge ?? [...REPLACE_MERGE] }, ...rest.slice(1)];
  }
  return [...rest];
}
