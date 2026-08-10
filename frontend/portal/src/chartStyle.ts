/**
 * Das GEOMETRIE-Gegenstück zu `chartTheme.ts`.
 *
 * `chartTheme()` teilt seit jeher die FARBEN aller ECharts-Flächen; jede Zahl
 * dahinter (Strichstärke, Flächen-Alpha, Balkenbreite, Jetzt-Linie, Achsentypo)
 * war dagegen Privatsache der Komponente — gemessen sechs Werte für „Hauptlinie"
 * (1,2 · 1,5 · 1,6 · 1,8 · 2,0 · 2,4 · 2,5), drei Jetzt-Linien-Stile und vier
 * Balken-Regime. Genau daraus entstand der Eindruck „grob" (Scout
 * `vp-charts-filigran-c7` §4). Hier wird die Geometrie erstmals tokenisiert.
 *
 * Wer eine Chart-Fläche anfasst, nimmt die Werte VON HIER — ein neuer Zahlwert
 * in einer Komponente ist der Rückfall in den Zustand, den diese Datei beendet.
 *
 * Die Regeln, aus denen die Zahlen stammen, stehen als F1–F10 in
 * `vp-charts-filigran-c7` §5b und als K1–K11 in `vp-charts-verstaendlich-r2`
 * §3; wo beide kollidieren, gewinnt die VERSTÄNDLICHKEIT (r2 §4).
 */

/* ---------------------------------------------------------------------------
 * F1 · Strichstärken — HIERARCHIE, nicht Gleichmaß
 *
 * Die Revision 1 schrieb ein gleichmäßiges Trio (1,5 / 1,25 / 1) vor. Gemessen
 * wurde daraufhin (r2 §2 Befund ①), dass eine durchgehend dünne Fläche beim
 * Verkleinern überproportional verliert: bei 0,55× Darstellungsmaßstab landet
 * eine 1-px-Linie bei 0,55 px, also im Subpixel, wo sie zu blassem Grau wird.
 * Filigranität entsteht deshalb aus dem KONTRAST der Stärken, nicht daraus,
 * dass alles dünn ist — die Serie, die die Kernaussage trägt, wird kräftiger.
 * ------------------------------------------------------------------------- */
export const STROKE = {
  /** Die Serie, die die KERNAUSSAGE der Fläche trägt (r2 §4, F1-Hierarchie). */
  lead: 2.2,
  /** Kontext-Serie (Prognose, Vergleich, zweite Größe) — obere Kontext-Stufe. */
  context: 1.7,
  /** Die ruhigste Kontext-Stufe (Vergleichs-Overlay, Ladestand, Baseline). */
  contextSoft: 1.4,
  /** Referenz: Nulllinie, Ziel-/Grenzlinie, Jetzt-Linie, Raster. */
  ref: 1,
} as const;

/* ---------------------------------------------------------------------------
 * F3 · Flächen sind Hauch — mit EINER benannten Ausnahme
 *
 * Standard-Wash 0,08 unter der einen Hauptserie; Bänder (Min/Max, Spanne) 0,14.
 * Wo die FLÄCHE selbst die Aussage trägt (die Preisspanne IST der Grund fürs
 * Laden), sind 0,10–0,16 erlaubt — dann aber mit Namensschild im Bild (K10),
 * sonst ist sie eine Kodierung mit Bedienungsanleitung.
 * ------------------------------------------------------------------------- */
export const FILL = {
  /** Hauch unter der EINEN Hauptserie. */
  wash: 0.08,
  /** Min/Max- und Spannenbänder. */
  band: 0.14,
  /** Vergangenheits-Schattierung (F5) — noch zarter als ein Wash. */
  past: 0.05,
  /**
   * Eine Fläche, die die AUSSAGE trägt (F3-Ausnahme, r2 §4). Nur zusammen mit
   * einem Namensschild im Bild verwenden.
   */
  speaking: 0.16,
  /** Ereignis-Bänder (`markArea`) — die bestehende Historie-Semantik. */
  event: 0.2,
} as const;

/**
 * Eine Token-Farbe mit Alpha — für die wenigen ECharts-Felder, die KEIN
 * separates `opacity` kennen (`dataZoom.fillerColor`, `markArea`-Verläufe).
 *
 * Es ist ausdrücklich der Ersatz für hartkodierte `rgba(...)`-Literale: die
 * Farbe bleibt ein Token, nur ihre Deckkraft entsteht hier. Ein Wert, den wir
 * nicht als `#rrggbb` erkennen (z. B. schon ein `rgb()` aus `getComputedStyle`),
 * wird unverändert durchgereicht — lieber ohne Alpha als falsch geparst.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  // eslint-disable-next-line no-bitwise
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ---------------------------------------------------------------------------
 * F9 · Balken werden Säulenstäbe
 *
 * Bei 96 Viertelstunden-Slots ergab `barCategoryGap: '8%'` einen durchgehenden
 * Farb-Block statt ablesbarer Stäbe. Der Deckel (14 px) hält auch eine
 * 12-Balken-Monatsreihe schlank, die Fuge macht die Einzelwerte zählbar.
 * ------------------------------------------------------------------------- */
export const BAR = {
  /** Breiten-Deckel JEDER Balkenreihe. */
  maxWidth: 14,
  /** Fuge zwischen den Kategorien — aus dem Farb-Block werden Stäbe. */
  categoryGap: '35%',
  /** Fuge zwischen zwei Reihen DERSELBEN Kategorie (gruppierte Balken). */
  seriesGap: '18%',
  /** Kappe: eine Spur Radius, damit der Stab kein Rechteck-Klotz ist. */
  radius: 1.5,
  /** Mindest-Fuge in Pixeln, wenn eine Fläche in px statt Prozent rechnet. */
  gapPx: 2,
} as const;

/* ---------------------------------------------------------------------------
 * F5 · EINE Jetzt-Linie
 *
 * Vorher drei Stile (solid 2 px in Preis-Blau · dashed 1,5 · gar keine). Die
 * Jetzt-Linie ist eine REFERENZ, keine Datenreihe — sie ist deshalb dünn,
 * gestrichelt und in Ink, nie in einer Serienfarbe.
 *
 * ⚠ Auf einer Fläche, die AUSSCHLIESSLICH Vergangenheit zeigt (Live-Verlauf,
 * Messwerte), entfällt sie SAMT Vergangenheits-Wash: der rechte Rand IST jetzt,
 * und ein Wash über das ganze Bild ist reines Rauschen.
 * ------------------------------------------------------------------------- */
export const NOW = {
  width: STROKE.ref,
  /** Strichmuster der Jetzt-Linie. */
  dash: [3, 3] as [number, number],
  /** Deckkraft der Ink-Farbe (`chartTheme().ink`) für die Linie. */
  inkOpacity: 0.55,
} as const;

/**
 * Der `lineStyle` JEDER Jetzt-Linie. Die Fläche baut nur noch ihren
 * `markLine`-Datensatz (Index oder Zeitwert) drumherum.
 *
 * ⚠ `rotate: 0` am Label ist Pflicht: auf einer Kategorie-Achse rendert ECharts
 * ein innenliegendes markLine-Label sonst GEDREHT entlang der Linie (die
 * dokumentierte Kanten-Falle).
 */
export function nowLineStyle(t: { ink: string }) {
  return {
    color: t.ink,
    width: NOW.width,
    type: NOW.dash as unknown as number[],
    opacity: NOW.inkOpacity,
  };
}

/** Das Label der Jetzt-Linie — K9: der Zeit-Anker ist ein WORT. */
export function nowLabel(
  t: { axis: string },
  /**
   * `'start'` ist das UNTERE Ende einer senkrechten `markLine` (ECharts baut
   * sie von yAxis-min nach -max) — der Ort, an dem K9 die Fahne haben will:
   * an der Zeitachse, nicht neben einer Panel-Überschrift.
   */
  position: 'insideEndTop' | 'insideStartTop' | 'start',
) {
  return {
    formatter: 'Jetzt',
    color: t.axis,
    fontSize: AXIS.fontSize,
    position,
    rotate: 0,
  } as const;
}

/* ---------------------------------------------------------------------------
 * F4 · Raster sind Haarlinien, Achsen haben keine Linie
 *
 * `splitLine` bleibt (waagerecht, 1 px), `axisLine`/`axisTick` verschwinden
 * überall — sie rahmen das Bild ein, statt es zu erklären.
 * ------------------------------------------------------------------------- */
export const AXIS = {
  /** Achsen- und Beschriftungsgröße (vorher 10–12 gemischt). */
  fontSize: 11,
  /** Größe einer Achsen-NAMENS-Beschriftung („Leistung (kW)"). */
  nameFontSize: 11,
} as const;

/**
 * Die eine Achsen-Grundform: keine Achslinie, keine Ticks, 11-px-Text.
 * In `xAxis`/`yAxis` hineinspreizen und nur ergänzen, was die Fläche braucht.
 */
export function axisBase(t: { axis: string }) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.axis, fontSize: AXIS.fontSize, hideOverlap: true },
  } as const;
}

/* ---------------------------------------------------------------------------
 * F6 (KORRIGIERT durch r2 §4) · gepunktet heißt PROGNOSE, nicht Zukunft
 *
 * Der Börsenpreis für morgen STEHT FEST — ihn zu punkten behauptet eine
 * Unsicherheit, die es nicht gibt. Gepunktet wird also nur, was wirklich
 * vorhergesagt ist (PV-/Verbrauchsprognose, Wetter, Prognose-Kandidat); ein
 * feststehender Zukunftswert bleibt durchgezogen und die Tagesgrenze trägt ein
 * Datum.
 * ------------------------------------------------------------------------- */
export const FORECAST = {
  /** Strichmuster einer PROGNOSE-Reihe. */
  dash: [2, 3] as [number, number],
  /** Eine Prognose ist Kontext, nie die Leitserie. */
  width: STROKE.contextSoft,
} as const;

/* ---------------------------------------------------------------------------
 * K5 · Der SPEICHER ist EINE Farbe — die Richtung trägt Position + Form + Wort
 *
 * Messung (r2 §5): das frühere Entladen-Blau `#2C5282` liegt gegen das
 * Haus-Blau `#1D6FD8` bei ΔE 14,8 — unter der Normalsicht-Untergrenze 15 und
 * damit ein harter FAIL, den auch eine Zweitkodierung nicht entschuldigt.
 * Beide werden im Messwerte-Tag UND im Fahrplan gemeinsam gezeichnet.
 *
 * Die Antwort ist nicht ein dritter Blau-Ton, sondern der Verzicht auf einen
 * eigenen Kategorie-Platz: Laden und Abgeben sind DERSELBE Gegenstand in zwei
 * Zuständen. Die Richtung trägt seither
 *   · die POSITION (über / unter der betonten Nulllinie),
 *   · die FORM (gefüllt = lädt, Umriss = gibt ab) und
 *   · das WORT (Legende, Tooltip, Filmzeile).
 * Ergebnis ΔE 26,2 gegen das Haus-Blau, und der Graustich des alten Tons
 * (Chroma 0,091, unter dem Zierboden) verschwindet mit.
 *
 * ⚠ Netzladen (`gridCharge`, türkis) bleibt ein EIGENER Ton: die Unterscheidung
 * Solarladen ↔ Netzladen ist compliance-tragend (EEG) und behält zusätzlich
 * ihre Haus-Auflage „Wort + Icon tragen die Identität".
 * ------------------------------------------------------------------------- */
export type StorageForm = 'filled' | 'outline';

/** Die drei Zustände, in denen der Speicher gezeichnet wird. */
export type StorageState = 'laden' | 'netzladen' | 'entladen';

/** Wie ein Speicher-Zustand gezeichnet wird: Farbe + Form. */
export interface StorageMark {
  color: string;
  form: StorageForm;
}

/**
 * Die EINE Zuordnung Speicher-Zustand → Marke. Jede Fläche, die den Speicher
 * zeichnet (Fahrplan-Balken, Messwerte-Linie, Summen-Kachel, Filmzeile,
 * Phasen-Karte, Legende), geht hier durch — sonst behaupten zwei Flächen
 * verschiedene Dinge über dieselbe Handlung.
 */
export function storageMark(
  state: StorageState,
  t: { charge: string; gridCharge: string },
): StorageMark {
  if (state === 'netzladen') return { color: t.gridCharge, form: 'filled' };
  if (state === 'entladen') return { color: t.charge, form: 'outline' };
  return { color: t.charge, form: 'filled' };
}

/**
 * Der ECharts-`itemStyle` einer Speicher-Marke. Ein Umriss zeichnet den Rand in
 * der Serienfarbe und lässt die Füllung leer — bei einem 14-px-Stab ist das
 * ablesbar, ohne einen zweiten Farbton zu erfinden.
 *
 * ⚠ Er gehört an das DATENELEMENT (`data: [{ value, itemStyle }]`), nicht als
 * Callback an die Serie. ECharts wertet auf `series.itemStyle` nur einen Teil
 * der Felder als Funktion aus — `color` ja, `borderWidth` NICHT: eine Funktion
 * dort ergibt eine ungültige Breite, und die Serie zeichnet dann GAR NICHTS
 * (im Browser aufgefallen: der ganze Balken-Satz des Fahrplans fehlte, nicht
 * nur der Rand). Per-Item-Stil ist der unterstützte Weg.
 */
export function storageItemStyle(mark: StorageMark, surface: string) {
  if (mark.form === 'filled') {
    return { color: mark.color, borderRadius: BAR.radius, borderWidth: 0 };
  }
  return {
    color: surface,
    borderColor: mark.color,
    borderWidth: 1.2,
    borderRadius: BAR.radius,
  };
}

/** Ein Balken-Datenelement mit seiner Speicher-Marke - `null` bleibt eine Lücke. */
export function storageBar(value: number | null, mark: StorageMark, surface: string) {
  if (value == null) return null;
  return { value, itemStyle: storageItemStyle(mark, surface) };
}

/* ---------------------------------------------------------------------------
 * Glättung — gering und monoton, nie überschwingend
 *
 * `smooth: true` ist in ECharts der Faktor 0,5. Auf 15-Minuten-Daten erzeugt
 * das sichtbare Sinus-Überschwinger zwischen zwei Punkten: eine PV-Kurve
 * schwingt nachts unter Null, eine Ladestandslinie über 100 %. Beides
 * BEHAUPTET Messwerte, die nie gemessen wurden. Ein kleiner Faktor plus
 * `smoothMonotone` hält die Kurve zwischen ihren Stützstellen.
 * ------------------------------------------------------------------------- */
export const SMOOTH = 0.2;

/** Der Glättungs-Satz einer Messreihe — nie über die Stützstellen hinaus. */
export const SMOOTH_SERIES = { smooth: SMOOTH, smoothMonotone: 'x' } as const;

/* ---------------------------------------------------------------------------
 * K2/M12 · Direktbeschriftung — Name + Wert AM Kurvenende
 *
 * Eine Legende ist eine Zuordnungsaufgabe, ein Etikett am Kurvenende ist eine
 * Antwort. Und sie kann strukturell nicht mehr lügen: in Revision 1 stand in
 * der Legende „PV 11,2 kW", während die Kurve an der Jetzt-Linie bei ~4 kW lag
 * (r2 §2 Befund ④) — steht der Wert AN der Kurve, ist das unmöglich.
 *
 * Umgesetzt mit ECharts-Bordmitteln: `endLabel` schreibt das Etikett an den
 * letzten Datenpunkt, `labelLayout.moveOverlap: 'shiftY'` schiebt zwei zu nah
 * beieinander liegende Etiketten vertikal auseinander (die geforderte
 * Kollisionsauflösung). WANN direkt beschriftet wird, entscheidet die reine
 * `useDirectLabels` in `chartKopf.ts` — nicht diese Funktion.
 * ------------------------------------------------------------------------- */

/**
 * Der `endLabel`-Satz EINER Reihe. `formatter` bekommt den Punkt und gibt den
 * fertigen Text — die Fläche formatiert ihre Zahl selbst (`format.ts`), damit
 * hier keine zweite Zahlen-Formatierung entsteht.
 *
 * ⚠ Der Text ist KUNDENCOPY und läuft durch ECharts' Label-Renderer, nicht
 * durch `innerHTML` — anders als die Tooltip-Formatter. Trotzdem gilt: nur
 * statische Reihennamen plus formatierte Zahlen, nie ein API-String.
 */
export function directLabel(
  color: string,
  formatter: (p: { value: unknown; seriesName: string }) => string,
) {
  return {
    endLabel: {
      show: true,
      distance: 6,
      color,
      fontSize: AXIS.fontSize,
      fontWeight: 600 as const,
      formatter,
    },
    labelLayout: { moveOverlap: 'shiftY' as const },
  };
}

/**
 * Wie viel Rand eine direkt beschriftete Fläche rechts braucht. Ohne das
 * schneidet ECharts das Etikett am Canvas-Rand ab — der Baufehler, den die
 * Revision-1-Mockups vorführten (r2 §2 Befund ⑥).
 */
export const DIRECT_LABEL_GUTTER_PX = 108;

/* ---------------------------------------------------------------------------
 * K3 · Detailtiefe — drei Serien im Grundzustand
 * ------------------------------------------------------------------------- */

/**
 * Wie viele Reihen eine Fläche im Grundzustand zeigt. Alles darüber (Ladestand,
 * Prognosen, Vergleiche) liegt hinter „Mehr anzeigen ▾" — das ist zugleich die
 * vom dataviz-Validator vorgeschriebene Antwort auf nicht trennbare Farbpaare
 * („cut series or facet instead").
 */
export const BASE_SERIES_LIMIT = 3;

/* ---------------------------------------------------------------------------
 * K11 · Im Maßstab der Anzeige entwerfen
 * ------------------------------------------------------------------------- */

/**
 * Unterhalb dieser Container-Breite ist eine Fläche „schmal": Achsennamen
 * kürzen, Ränder straffen, Zweitachsen fallen lassen. Die Zahl war bisher in
 * jeder Chart-Datei einzeln als `width < 480` einkopiert.
 */
export const NARROW_PX = 480;

/* ---------------------------------------------------------------------------
 * F8 VERSCHÄRFT · Mehr als zwei Größen ⇒ PANELS, nicht Achsen
 *
 * Die geduldete Ausnahme „Preis-Rechtsachse im Fahrplan" ist gestrichen (r2 §4):
 * sie war die Ursache des Dual-Axis-Fehllesens UND der zwei gemessenen
 * Farb-Kollisionen (Grün×Grün: Ladebalken in kW gegen Einspeisewert in ct ·
 * Blau×Blau: Verbrauchslinie gegen Preislinie, ΔE 1,3). Zwei Panels über EINER
 * Zeitachse lösen beide STRUKTURELL auf, statt sie umzufärben.
 *
 * Die Geometrie steht hier, weil sie kein Fahrplan-Sonderfall ist: das
 * Tagesbild (Stufe 3) und der Admin-PlanChart bekommen dieselbe Aufteilung.
 *
 * ⚠ Beide Panels MÜSSEN denselben linken und rechten Rand bekommen, sonst
 * liegen ihre Zeitachsen nicht übereinander — und eine geteilte Zeitachse ist
 * der ganze Zweck. Deshalb wird `containLabel` hier NICHT benutzt (es misst je
 * Grid die eigene Beschriftungsbreite und verschiebt die Plots gegeneinander);
 * die Ränder sind feste Pixel.
 * ------------------------------------------------------------------------- */
export const PANELS = {
  /** Kopfraum über dem ersten Panel — dort steht sein Achsen-Name. */
  topPx: 26,
  /** Höhe des flachen KOPF-Panels (Preis) als Anteil der Bildhöhe. */
  headPct: 23,
  /** Wo das große Panel beginnt — die Luft dazwischen trägt seinen Namen. */
  bodyTopPct: 40,
  /**
   * Fußraum: zweizeilige Datums-Beschriftung plus die „Jetzt"-Fahne DARUNTER
   * (K9). Die Fahne braucht die zweite Zeile - im Browser gemessen lag sie
   * ohne sie auf den Achsen-Beschriftungen.
   */
  bottomPx: 66,
  /**
   * Abstand der „Jetzt"-Fahne vom unteren Ende ihrer Linie. Er muss die
   * zweizeilige Datums-Beschriftung ÜBERSPRINGEN - deshalb hängt er an
   * {@link bottomPx} und wird nicht getrennt geraten.
   */
  nowFlagDistancePx: 40,
  /** Linker Rand: Platz für drei Ziffern Achsen-Beschriftung bei 11 px. */
  leftPx: 38,
  /** Derselbe Rand am Telefon (dort trägt die Achse zwei Ziffern). */
  leftNarrowPx: 30,
  /** Rechter Rand ohne Zweitachse. */
  rightPx: 20,
  /**
   * Rechter Rand MIT der Ladestand-Miniskala (F8-Ausnahme, `offset` 44).
   * ⚠ 76 px reichten nicht: das oberste Label „100 %" wurde am Canvas-Rand um
   * ~2 px beschnitten (im Browser bei 1440 px gemessen). Der Wert gilt für
   * jede Fläche mit dieser Miniskala.
   */
  rightWithSocPx: 86,
} as const;

/* ---------------------------------------------------------------------------
 * DREI Panels — das Tagesbild (Stufe 3, r2 §6 A · Mockup `vn-tagesbild`)
 *
 * Dieselbe Bauart wie {@link PANELS}, nur eine Fläche mehr: Preis · Leistung ·
 * Ertrag über EINER Zeitachse. Die Werte stehen HIER und nicht in der
 * Komponente, weil sie kein Tagesbild-Sonderfall sind — sie sind die
 * Drei-Panel-Stufe derselben Geometrie, und der nächste Dreiteiler nimmt sie.
 *
 * ⚠ Es gelten Wort für Wort die zwei Auflagen der Zwei-Panel-Stufe: ALLE Grids
 * tragen denselben linken/rechten Rand (sonst lägen die Zeitachsen nicht
 * übereinander, und genau das ist der Zweck), und `containLabel` bleibt aus (es
 * misst je Grid die eigene Beschriftungsbreite und verschiebt die Plots
 * gegeneinander).
 *
 * Die Prozentwerte sind aus dem abgenommenen Mockup abgeleitet (Panel 2 ist die
 * größte Fläche — dort steht die Handlung; Panel 3 die flachste — eine
 * monotone Summenkurve braucht keine Höhe) und lassen zwischen den Panels je
 * eine Zeile für die Überschrift in Aussageform frei.
 * ------------------------------------------------------------------------- */
export const PANELS3 = {
  /** Panel 1 „Was Strom kostet". */
  preis: { topPct: 4, heightPct: 23 },
  /** Panel 2 „Was die Anlage macht" — die größte Fläche. */
  leistung: { topPct: 32.5, heightPct: 34 },
  /** Panel 3 „Was dabei herauskommt" — bis zum Fußraum von {@link PANELS}. */
  ertrag: { topPct: 72 },
  /**
   * Wie weit die Überschrift ÜBER ihrem Panel sitzt (Anteil der Bildhöhe).
   * Sie steht über der Fläche, nicht daneben — eine Überschrift NEBEN der
   * Fläche liest sich als Achsenname, und genau das war Befund ③ (r2 §2).
   * Weil sie am Panel hängt, wandert sie mit, wenn ein Panel entfällt.
   *
   * ⚠ Der Abstand ist so gewählt, dass die Überschrift ZWISCHEN zwei Flächen
   * steht und keine berührt - im Browser bei 420 px und 560 px Bildhöhe
   * eingestellt. Wer die Panel-Anteile ändert, misst ihn neu.
   */
  titelGapPct: 4.5,
  /**
   * Wo das Leistungs-Panel endet, wenn es KEIN Ertrags-Panel gibt (kein
   * gemessenes Geld für diesen Tag). Die Anzahl der Grids bleibt trotzdem drei,
   * damit Achsen- und Serien-INDIZES stabil sind — der Ertrag schrumpft auf
   * Höhe 0, statt einen zweiten Codepfad zu erzwingen.
   */
  ohneErtragBottomPx: PANELS.bottomPx,
} as const;
