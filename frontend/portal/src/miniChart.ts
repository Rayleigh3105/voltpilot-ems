/**
 * Das Mini-Chart-System (Chart-Redesign Stufe 5) — die REINE Hälfte.
 *
 * Das Portal hatte 16 Mini-Visualisierungen ohne gemeinsame Formensprache:
 * sieben Balkenhöhen für dieselbe „Anteil"-Idee, drei Jetzt-Marker — und zwei
 * ehrlichkeitskritische Fehler, die in `vp-charts-filigran-c7` §4 Befund 9
 * gemessen wurden und hier strukturell verschwinden:
 *
 *  1. **Mindesthöhen-Fälschung.** `Math.max(12%, …)` (Ministreifen) und
 *     `Math.max(8, …)` (Flotten-Spark) zogen kleine Werte auf eine erfundene
 *     Höhe. Hier bekommt ein Wert, der unter {@link VISIBILITY_PX} rendern
 *     würde, eine EIGENE FORM (`tick` — ein 2-px-Strich an der Nulllinie),
 *     nie einen hochgezogenen Balken. Die Form sagt „hier ist etwas, aber es
 *     ist klein"; ein Balken hätte „so groß ist es" behauptet.
 *  2. **Geklemmte Verlusttage.** Der Flotten-Spark rechnete `Math.max(0, eur)`
 *     — ein Verlusttag wurde damit zum Nulltag, also unsichtbar. Hier ist die
 *     Nulllinie ECHT und negative Werte hängen darunter.
 *
 * Dazu die zwei Regeln, die die Vorbilder des Hauses schon richtig machten und
 * die jetzt für alle gelten: **Lücken bleiben Lücken** (`null` zeichnet NICHTS,
 * nie einen Nullbalken — die Haus-Ehrlichkeitsregel) und **Null ist immer im
 * Bild** (`MiniTrend`-Verhalten, hier verallgemeinert).
 *
 * Gerendert wird in `components/MiniChart.tsx`; die Zahlen kommen von hier.
 * Regeln: F9 (`vp-charts-filigran-c7` §5b) und K5/K6/K8 (`…-verstaendlich-r2`
 * §3); die Zielbilder sind die Mockups `ministreifen.svg` / `sparks.svg`.
 */

/* ---------------------------------------------------------------------------
 * F9 · EIN Höhen-Set — statt der sieben gemessenen
 * ------------------------------------------------------------------------- */

/** Die drei erlaubten Höhen eines Mini-Charts (px). */
export const MINI_HEIGHT = {
  /** Der Zeilen-Begleiter (SoC-Mini, Abdeckung) — Größe, sonst nichts. */
  micro: 4,
  /** Die Sparkline (Flotten-Geld, Portfolio-Trend, Monats-Chip). */
  spark: 18,
  /** Der Streifen mit Richtung (Cockpit-Fahrplan) — trägt eine Nulllinie. */
  streifen: 40,
} as const;

export type MiniHeight = keyof typeof MINI_HEIGHT;

/**
 * Unterhalb dieser Höhe ist ein Balken nicht mehr zu sehen. Statt ihn
 * hochzuziehen (die gemessene Fälschung) bekommt er die Form `tick`.
 */
export const VISIBILITY_PX = 2;

/* ---------------------------------------------------------------------------
 * Der Wertebereich — Null ist IMMER im Bild
 * ------------------------------------------------------------------------- */

export interface MiniDomain {
  min: number;
  max: number;
  /** Ob überhaupt ein negativer Wert vorkommt — dann TRÄGT die Nulllinie. */
  hasNegative: boolean;
}

/**
 * Der Wertebereich einer Mini-Reihe. Null liegt immer darin, damit ein Balken
 * seine Richtung überhaupt zeigen KANN und zwei Reihen nebeneinander denselben
 * Bezugspunkt haben. `null`, wenn kein einziger endlicher Wert vorliegt — dann
 * gibt es nichts zu zeichnen und die Fläche sagt das (nie eine leere Achse mit
 * erfundener Skala).
 */
export function miniDomain(values: readonly (number | null | undefined)[]): MiniDomain | null {
  const finite = values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  if (finite.length === 0) return null;
  return {
    min: Math.min(0, ...finite),
    max: Math.max(0, ...finite),
    hasNegative: finite.some((v) => v < 0),
  };
}

/* ---------------------------------------------------------------------------
 * Balken
 * ------------------------------------------------------------------------- */

/** Ein Punkt einer Mini-Reihe. `value === null` ist eine LÜCKE, keine Null. */
export interface MiniPoint {
  /** Stabiler Schlüssel (Tag, Monat, Stunde) — auch der React-Key. */
  key: string;
  value: number | null;
  /** Klartext für den Ableseweg („12.08." / „Aug" / „14 Uhr"). */
  label?: string;
  /**
   * Ein freier Zustands-Name, den die FLÄCHE vergibt und als CSS-Modifier
   * wiederfindet (`is-<tone>`). Der Baustein weiß nichts über Batterien —
   * so kann der Cockpit-Streifen trotzdem die Haus-Regel „der Speicher ist
   * EINE Farbe, die Richtung trägt Form + Wort" (K5) anwenden, ohne dass
   * sie hier hineinwandert.
   */
  tone?: string;
}

/**
 * Wie ein Wert gezeichnet wird.
 *  - `bar`  — ein echter Balken, seine Höhe IST sein Anteil am Bereich.
 *  - `tick` — der 2-px-Sichtbarkeits-Strich: zu klein für einen Balken. Eine
 *             eigene Form, damit die Höhe nichts Falsches behauptet.
 *  - `gap`  — nichts. Eine Lücke bleibt eine Lücke.
 */
export type MiniBarForm = 'bar' | 'tick' | 'gap';

export interface MiniBar {
  key: string;
  label: string | null;
  value: number | null;
  form: MiniBarForm;
  /** Der Zustands-Name des Punktes (siehe {@link MiniPoint.tone}). */
  tone: string | null;
  /** Oberkante in px, von oben. */
  y: number;
  /** Höhe in px. */
  h: number;
  /** +1 über der Nulllinie · −1 darunter · 0 genau darauf. */
  sign: -1 | 0 | 1;
  /** Der betonte Punkt („heute", der gewählte Monat) — volle Deckkraft. */
  emphasis: boolean;
  /** Ob der Punkt VOR dem Jetzt-Punkt liegt (gedimmt: „schon vorbei"). */
  past: boolean;
}

export interface MiniBarsView {
  bars: MiniBar[];
  /** y der Nulllinie in px. */
  zeroY: number;
  /** Ob die Nulllinie etwas trennt (dann wird sie GEZEICHNET). */
  hasNegative: boolean;
  domain: MiniDomain;
}

export interface MiniBarsOptions {
  /** Höhe der Zeichenfläche in px. */
  height: number;
  /** Der Schlüssel des betonten Punktes („heute"). */
  emphasisKey?: string | null;
  /**
   * Der Schlüssel, ab dem die Reihe die ZUKUNFT ist. Alles davor ist
   * „schon vorbei" und wird gedimmt (der Ministreifen-Fall).
   */
  nowKey?: string | null;
}

/**
 * Die Balken-Geometrie einer Mini-Reihe, in Pixeln der übergebenen Höhe.
 *
 * ⚠ Es gibt hier ABSICHTLICH keinen Weg, einen kleinen Wert groß zu zeichnen:
 * `h` ist immer der echte Anteil, und wer darunter fällt, wechselt die FORM.
 */
export function miniBars(
  points: readonly MiniPoint[],
  opts: MiniBarsOptions,
): MiniBarsView | null {
  const height = Math.max(1, opts.height);
  const raw = miniDomain(points.map((p) => p.value));
  if (!raw) return null;
  const domain = reserveTickRoom(raw, height);

  const span = domain.max - domain.min;
  // Eine Reihe aus lauter Nullen hat keine Spanne: die Nulllinie liegt mittig
  // und jeder Wert ist ein Strich darauf. Ein „Balken" wäre hier eine Lüge.
  const zeroY = span > 0 ? ((domain.max - 0) / span) * height : height / 2;

  const nowIdx = opts.nowKey ? points.findIndex((p) => p.key === opts.nowKey) : -1;

  const bars = points.map((p, i) => {
    const past = nowIdx >= 0 && i < nowIdx;
    const emphasis = opts.emphasisKey != null && p.key === opts.emphasisKey;
    const base = {
      key: p.key,
      label: p.label ?? null,
      value: p.value,
      tone: p.tone ?? null,
      emphasis,
      past,
    };
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
      return { ...base, form: 'gap' as const, y: zeroY, h: 0, sign: 0 as const };
    }
    const sign: -1 | 0 | 1 = p.value > 0 ? 1 : p.value < 0 ? -1 : 0;
    const yVal = span > 0 ? ((domain.max - p.value) / span) * height : zeroY;
    const top = Math.min(yVal, zeroY);
    const h = Math.abs(yVal - zeroY);
    if (h >= VISIBILITY_PX) {
      return { ...base, form: 'bar' as const, y: top, h, sign };
    }
    return { ...base, form: 'tick' as const, y: tickY(zeroY, sign, height), h: VISIBILITY_PX, sign };
  });

  return { bars, zeroY, hasNegative: domain.hasNegative, domain };
}

/**
 * Wo der Sichtbarkeits-Strich sitzt: an der Nulllinie, auf der SEITE seines
 * Wertes — ein winziger Gewinn liegt darüber, ein winziger Verlust darunter,
 * eine echte Null mittig auf der Linie. So trägt selbst der Strich noch seine
 * Richtung, ohne eine Größe zu behaupten.
 */
function tickY(zeroY: number, sign: -1 | 0 | 1, height: number): number {
  const raw = sign > 0 ? zeroY - VISIBILITY_PX : sign < 0 ? zeroY : zeroY - VISIBILITY_PX / 2;
  return Math.min(Math.max(raw, 0), height - VISIBILITY_PX);
}

/**
 * ⚠ Die Nulllinie behält auf JEDER Seite, die Daten trägt, Platz für ihren
 * Sichtbarkeits-Strich.
 *
 * Ohne das entsteht genau die Lüge, gegen die der Strich gebaut ist: bei
 * 14 Tagen mit Gewinnen bis 3,60 € und EINEM Verlusttag von −0,40 € liegt die
 * Nulllinie auf einem 18-px-Spark bei y ≈ 16,2 — für den 2-px-Strich des
 * Verlusttages bleiben darunter 1,8 px, er würde an den Rand geklemmt und
 * säße damit ÜBER der Nulllinie. Ein Verlust läse sich als Gewinn.
 *
 * Die Antwort ist eine Reserve im WERTEBEREICH, nicht im Pixelraum: die Achse
 * bekommt etwas Luft, alle Balken skalieren mit demselben Faktor. Das VERHÄLTNIS
 * der Balken zueinander — die einzige Aussage, die eine Sparkline überhaupt
 * trifft — bleibt damit exakt; nur die absolute Pixelhöhe schrumpft ein wenig.
 *
 * Höchstens eine der beiden Bedingungen kann verletzt sein (beide zugleich
 * hieße k² > 1), ein Durchgang genügt also. Unter 4 px Höhe gibt es die
 * Reserve nicht — ein `micro`-Balken ist für POSITIVE Grössen gedacht
 * (Ladestand, Abdeckung), und dort ist die Nulllinie ohnehin der Rand.
 */
function reserveTickRoom(d: MiniDomain, height: number): MiniDomain {
  if (height <= 2 * VISIBILITY_PX) return d;
  const k = VISIBILITY_PX / (height - VISIBILITY_PX);
  let { min, max } = d;
  if (max > 0 && max < -min * k) max = -min * k;
  else if (min < 0 && -min < max * k) min = -max * k;
  return { min, max, hasNegative: d.hasNegative };
}

/* ---------------------------------------------------------------------------
 * Linien
 * ------------------------------------------------------------------------- */

export interface MiniLineView {
  /**
   * Zusammenhängende Polylinien-Punkte („x,y x,y"). Eine Lücke BEENDET das
   * laufende Segment, statt darüber hinwegzuzeichnen — sonst behauptete die
   * Linie Messwerte, die es nie gab.
   */
  segments: string[];
  zeroY: number;
  hasNegative: boolean;
  domain: MiniDomain;
  /** Die x-Position je Punkt (für Marken und den Ableseweg). */
  xs: number[];
}

export interface MiniLineOptions {
  width: number;
  height: number;
  /**
   * Rand oben/unten, damit eine Linie ihrer Strichstärke nicht am Rand
   * abgeschnitten wird (der `MiniTrend`-Präzedenzfall: 1 px).
   */
  inset?: number;
}

/** Die Polylinien-Geometrie einer Mini-Reihe — Null immer im Bild. */
export function miniLine(
  points: readonly MiniPoint[],
  opts: MiniLineOptions,
): MiniLineView | null {
  const { width, height } = opts;
  const inset = opts.inset ?? 1;
  const domain = miniDomain(points.map((p) => p.value));
  if (!domain) return null;
  const span = domain.max - domain.min || 1;
  const usable = Math.max(1, height - 2 * inset);
  const dx = points.length > 1 ? width / (points.length - 1) : width;
  const yOf = (v: number) => height - inset - ((v - domain.min) / span) * usable;

  const segments: string[] = [];
  const xs: number[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    const x = i * dx;
    xs.push(x);
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${x.toFixed(1)},${yOf(p.value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));
  if (segments.length === 0) return null;

  return { segments, zeroY: yOf(0), hasNegative: domain.hasNegative, domain, xs };
}

/* ---------------------------------------------------------------------------
 * Anteils-/Fortschrittsbalken — der zweite Baustein
 *
 * Vier unabhängige Stile (10 / 18 / 8 / 5 px) für dieselbe Idee, dazu zwei
 * fast identische Komposition-Balken (7 px r4 vs. 6 px r3 α 0,75). Hier ist
 * die Geometrie EINE; die Fläche wählt nur noch ihre Größe.
 *
 * ⚠ Warum ein Anteils-Segment eine Mindestbreite haben DARF, ein Balken aber
 * keine Mindesthöhe: ein Sparkline-Balken ist eine GRÖSSEN-Aussage gegen eine
 * gemeinsame Skala — ihn hochzuziehen behauptet eine falsche Größe. Ein
 * Anteils-Segment ist ein TEIL EINES GANZEN ohne eigene Skala, und seine Zahl
 * steht in der Zeile daneben; ein 2-px-Splitter sagt dort „diesen Teil gibt
 * es", nicht „so groß ist er". Weglassen wäre die schlechtere Lüge.
 * ------------------------------------------------------------------------- */

export type ShareSize = 'micro' | 'md' | 'lg';

/** Die drei erlaubten Höhen eines Anteils-/Fortschrittsbalkens (px). */
export const SHARE_HEIGHT: Record<ShareSize, number> = {
  /** Zeilen-Begleiter (Datenabdeckung). */
  micro: MINI_HEIGHT.micro,
  /** Der Normalfall (Erlös-Komposition, Fortschritt, Rückgrat). */
  md: 8,
  /** Die Fläche, die für sich steht (€-Wasserfall). */
  lg: MINI_HEIGHT.spark,
};

/** Mindestbreite eines Segments, damit ein vorhandener Teil sichtbar bleibt. */
export const SHARE_MIN_PX = VISIBILITY_PX;
