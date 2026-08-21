/**
 * K1/M11 · Der Kernaussage-Slot — und K2/K3, die zwei Mechaniken daneben.
 *
 * Der Befund, aus dem alles drei folgt (Scout `vp-charts-verstaendlich-r2`
 * §2 Befund ③): KEINE Chart-Fläche des Portals sagte in Worten, was sie zeigt.
 * Die Überschriften nannten Größen und Einheiten („Preis (ct/kWh)"), also
 * blieb das Diagramm die AUFGABE statt der Antwort. Diese Datei hält die drei
 * reinen Regeln dafür; gerendert wird in `components/ChartExplain.tsx`.
 *
 * ⚠ DIE WICHTIGSTE REGEL DER GANZEN STUFE (r2 §10): der Kernaussage-Satz ist
 * ABGELEITET, nie handgeschrieben. Ein falsch abgeleiteter Satz wäre schlimmer
 * als kein Satz — deshalb gibt es hier keinen Weg, einen Satz ohne Grundlage zu
 * setzen, und ein fehlender Satz endet als „—" MIT Grund, nie als Leerstelle.
 * Die Ableitungsschicht existiert längst (`planSentence`, `idleReason`,
 * `proofLine`, `composeFleetSentence`, `erloesErgebnis`, `energieBilanz`) — der
 * Slot konsumiert sie, er rechnet nichts nach.
 */

/** Der Ton der Kernaussage — dieselben drei, die das Portal überall benutzt. */
export type KernTon = 'ok' | 'warn' | 'calm';

/** Was über einem Diagramm steht: die Zahl, die zählt, und ihr Satz. */
export interface Kernaussage {
  /**
   * Die Zahl, die zählt — SCHON FORMATIERT (`format.ts`), damit hier keine
   * zweite Zahlen-Formatierung entsteht. `null` = es gibt keine.
   */
  wert: string | null;
  /** Der abgeleitete Satz. `null` = keine belegbare Aussage. */
  satz: string | null;
  /**
   * Der ehrliche Grund, WARUM kein Satz da ist („Für heute liegt noch kein
   * Fahrplan vor."). Pflicht, sobald `satz` null ist.
   */
  grund: string | null;
  ton: KernTon;
  /** K8: der Vergleichsanker („ohne Speicher wären es 3,10 €"). Optional. */
  anker?: string | null;
  /**
   * Das BESTANDSKONTO daneben (Diagnose `vp-tagesbild-minus-f3` §6): was am
   * Ende MEHR im Speicher steckt als am Anfang, und was der Plan es wert
   * findet. Es steht NEBEN der Zahl, nie darin — die Zahl bleibt die gemessene
   * Kasse. Optional; `null` = nichts zu sagen.
   *
   * Strukturell getippt (nicht importiert), damit `erloesKomposition` und
   * dieser Slot sich nicht gegenseitig importieren müssen.
   */
  bestand?: KernBestand | null;
}

/** Die drei Teile, die der Kopf von einer Bestandszeile rendert. */
export interface KernBestand {
  text: string;
  /** Das Etikett, das die Zahl als PLAN kennzeichnet; null ohne Bewertung. */
  badge: string | null;
  /** Womit bewertet wurde (Titel-Text); null ohne Bewertung. */
  titel: string | null;
}

/**
 * Was der Kopf WIRKLICH rendert. Drei Ausgänge, und der dritte ist der Grund,
 * warum es diese Funktion gibt:
 *  - `aussage`  — Satz (+ Zahl, + Anker) vorhanden.
 *  - `grund`    — kein Satz, aber ein ehrlicher Grund. Der Kopf sagt ihn.
 *  - `nichts`   — weder Satz noch Grund: der Kopf rendert GAR NICHTS, statt ein
 *                 nacktes „—" hinzustellen, das nichts erklärt.
 */
export type KopfModus = 'aussage' | 'grund' | 'nichts';

export interface KopfView {
  modus: KopfModus;
  wert: string | null;
  text: string | null;
  anker: string | null;
  /** Die Bestandszeile — nur im Modus `aussage`, wie der Anker. */
  bestand: KernBestand | null;
  ton: KernTon;
}

/** Die eine Entscheidung, wie ein Kernaussage-Kopf aussieht. */
export function kopfView(k: Kernaussage | null | undefined): KopfView {
  const leer: KopfView = {
    modus: 'nichts', wert: null, text: null, anker: null, bestand: null, ton: 'calm',
  };
  if (!k) return leer;
  const satz = trimOrNull(k.satz);
  if (satz) {
    return {
      modus: 'aussage',
      wert: trimOrNull(k.wert),
      text: satz,
      anker: trimOrNull(k.anker ?? null),
      bestand: k.bestand ?? null,
      ton: k.ton,
    };
  }
  const grund = trimOrNull(k.grund);
  if (grund) {
    // Ohne Satz gibt es auch keine Zahl zu betonen: eine Zahl neben einem
    // Grund läse sich, als belege sie ihn — und ein Bestand ohne Kasse
    // daneben wäre eine Aussage ohne ihren Bezug.
    return { ...leer, modus: 'grund', text: grund };
  }
  return leer;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/* ---------------------------------------------------------------------------
 * K2/M12 · Direktbeschriftung — und wann die Legende zurückkommt
 *
 * Ein Etikett AM Kurvenende ist eine Antwort, eine Legende ist eine
 * Zuordnungsaufgabe. Zwei Fälle machen das Etikett aber unlesbar, und dann ist
 * die Legende der bessere Rückfall (K2 nennt beide):
 *   1. zu viele Reihen — ab 5 stapeln sich die Etiketten am rechten Rand,
 *   2. zusammenfallende Enden — zwei Kurven, die am selben Punkt enden,
 *      bekämen zwei Etiketten übereinander.
 * Dazu kommt der gemessene dritte Fall: am Telefon ist rechts schlicht kein
 * Platz (K11 — im Maßstab der Anzeige entwerfen).
 * ------------------------------------------------------------------------- */

/** Ab so vielen gleichzeitig gezeichneten Reihen gewinnt die Legende (K2). */
export const DIRECT_LABEL_MAX_SERIES = 4;

/**
 * Unter dieser Container-Breite wird nicht direkt beschriftet: die Etiketten
 * brauchen rechts Rand, den ein 375-px-Bild nicht hat.
 */
export const DIRECT_LABEL_MIN_PX = 560;

/**
 * Ob eine Fläche direkt beschriftet (K2) oder auf die Legende zurückfällt.
 * `endsCollide` meldet die Fläche selbst — nur sie kennt ihre letzten Werte.
 */
export function useDirectLabels(
  seriesCount: number,
  width: number,
  endsCollide = false,
): boolean {
  if (seriesCount <= 0) return false;
  if (seriesCount > DIRECT_LABEL_MAX_SERIES) return false;
  if (width < DIRECT_LABEL_MIN_PX) return false;
  return !endsCollide;
}

/**
 * Ob zwei Kurvenenden auf der gemeinsamen Achse zu nah beieinander liegen, um
 * zwei Etiketten zu tragen. Gemessen wird im WERTE-Raum gegen die Spannweite
 * der Achse, weil die Fläche ihre Pixel-Höhe hier nicht kennt.
 */
export function endsCollide(lastValues: (number | null)[], axisSpan: number): boolean {
  const vals = lastValues.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2 || !(axisSpan > 0)) return false;
  const sorted = [...vals].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if ((sorted[i] - sorted[i - 1]) / axisSpan < LABEL_MIN_GAP_RATIO) return true;
  }
  return false;
}

/** Zwei Etiketten brauchen mindestens diesen Anteil der Achsenhöhe Abstand. */
export const LABEL_MIN_GAP_RATIO = 0.08;
