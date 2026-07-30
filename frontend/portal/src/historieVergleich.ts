/**
 * **Δ zur Vorperiode** — die reine Wahrheit hinter der Vergleichszeile jeder
 * Kennzahl der Karte 1 beider Historie-Welten (Konzept
 * `data/vp-historie-konzept-t4`, Feature **F3**).
 *
 * Warum das die billigste Form von „nachschauen" ist: die Frage hinter jeder
 * Zahl auf dieser Seite lautet „ist das viel?", und sie war bisher nur durch
 * Blättern zu beantworten. Der Vergleich ist ein zweiter Abruf **desselben**
 * Endpunkts mit verschobenem Anker — er läuft durch denselben Cache
 * (`historyCache.ts`), kostet also beim Zurückblättern nichts mehr.
 *
 * **Die drei Ehrlichkeitsregeln, die hier Gesetz sind:**
 *
 * 1. **Kein Δ ohne Vergleichsbasis.** Trug die Vorperiode diesen Kanal gar
 *    nicht (`null`), gibt es keine Zeile — niemals ein Vergleich gegen eine
 *    erfundene Null (die genau dann „+∞ %" bedeutete).
 * 2. **Eine laufende Periode wird als solche beschriftet.** Ein halber Juli
 *    gegen einen vollen Juni ist kein Rückgang, sondern ein halber Monat; der
 *    Vergleich wird trotzdem gezeigt (er ist die einzige Einordnung, die es
 *    gibt), aber der Satz darüber sagt es ausdrücklich.
 * 3. **Gewertet wird nur, wo die Richtung eindeutig ist.** Mehr Erzeugung ist
 *    besser, weniger Netzbezug ist besser — mehr Verbrauch, mehr Ladung oder
 *    mehr Einspeisung sind es NICHT (eine Eigenverbrauchs-Anlage will weniger
 *    einspeisen). Wo es keine eindeutige Richtung gibt, bleibt die Zeile
 *    neutral: die Richtung ist die Tatsache, die Wertung wäre eine Behauptung.
 *
 * Kein React, kein Netz (das `fleet.ts`/`schedule.ts`-Muster).
 */
import type { HistoryRange } from './api';
import type { EnergieSummeKey } from './energieBilanz';
import { isCurrentPeriod } from './energieBilanz';
import { periodLabel, shiftAnchor } from './periodNav';

/** Unter dieser Änderung sagt die Seite „etwa wie" statt einer Richtung. */
export const FLACH_PCT = 3;

/** Beträge unter dieser Schwelle sind keine Vergleichsbasis (kWh bzw. €). */
export const BASIS_EPSILON = 0.05;

/** Wie eine Änderung zu lesen ist. */
export type DeltaRichtung = 'mehr' | 'weniger' | 'gleich';

/** Ob die Richtung für DIESE Kennzahl gut, schlecht oder schlicht neutral ist. */
export type DeltaWertung = 'gut' | 'schlecht' | 'neutral';

export interface DeltaView {
  richtung: DeltaRichtung;
  wertung: DeltaWertung;
  /** Gerundete Änderung in Prozent, Betrag (das Vorzeichen steckt in `richtung`). */
  pct: number;
  /** Die fertige Zeile: „18 % mehr als im Juni" / „etwa wie im Juni". */
  text: string;
  /** Der ausführliche Titel mit beiden Zahlen. */
  titel: string;
}

/**
 * Wohin der Vergleich schaut — der Anker der Vorperiode. Bewusst genau die
 * bestehende Blätter-Geste (`shiftAnchor(-1)`), damit „Vergleich" und
 * „ein Zeitraum zurück" nie auseinanderlaufen können.
 */
export function vergleichsAnker(anchor: Date, range: HistoryRange): Date {
  return shiftAnchor(anchor, range, -1);
}

/**
 * Der Name der Vorperiode, wie ihn ein Mensch sagt: „Juni", „2025",
 * „der Vorwoche", „dem Vortag". Bei einem Monat aus einem anderen Jahr steht
 * das Jahr dabei — „Dezember 2025" ist eine andere Aussage als „Dezember".
 */
export function vergleichsName(anchor: Date, range: HistoryRange): string {
  const vorher = vergleichsAnker(anchor, range);
  if (range === 'day') return 'dem Vortag';
  if (range === 'week') return 'der Vorwoche';
  if (range === 'year') return String(vorher.getFullYear());
  const monat = vorher.toLocaleDateString('de-DE', { month: 'long' });
  return vorher.getFullYear() === anchor.getFullYear()
    ? monat
    : `${monat} ${vorher.getFullYear()}`;
}

/** Die Kopfzeile der Karte: „Vergleich: Juni 2026". */
export function vergleichsKopf(anchor: Date, range: HistoryRange): string {
  return `Vergleich: ${periodLabel(vergleichsAnker(anchor, range), range)}`;
}

/**
 * Der Hinweis, der eine LAUFENDE Periode als solche kennzeichnet — sonst läse
 * sich ein halber Juli gegen einen vollen Juni wie ein Einbruch. Null, wenn der
 * Zeitraum abgeschlossen ist (dann gibt es nichts klarzustellen).
 */
export function laufendHinweis(
  anchor: Date,
  range: HistoryRange,
  now: Date,
): string | null {
  if (!isCurrentPeriod(anchor, range, now)) return null;
  const jetzt = periodLabel(anchor, range);
  const vorher = periodLabel(vergleichsAnker(anchor, range), range);
  return `${jetzt} läuft noch — verglichen wird mit dem vollständigen Zeitraum ${vorher}.`;
}

/**
 * Ob mehr von dieser Kennzahl für den Kunden gut ist. `null` = nicht eindeutig,
 * dann bleibt der Vergleich neutral (Regel 3).
 */
export type MehrIstBesser = boolean | null;

/** Die Wertung je Energiesumme — bewusst nur dort, wo sie eindeutig ist. */
export const ENERGIE_WERTUNG: Record<EnergieSummeKey, MehrIstBesser> = {
  // Mehr Ertrag der eigenen Anlage ist eindeutig gut.
  erzeugt: true,
  // Mehr Verbrauch ist weder gut noch schlecht — es ist der Bedarf des Hauses.
  verbraucht: null,
  // Weniger Netzbezug ist eindeutig gut (weniger gekaufter Strom).
  bezogen: false,
  // Mehr Einspeisung ist NICHT per se gut: eine Eigenverbrauchs-Anlage will
  // genau das Gegenteil. Deshalb neutral.
  eingespeist: null,
  // Speicherbewegung ist Betrieb, keine Leistung — neutral.
  geladen: null,
  entladen: null,
};

/**
 * Das Δ einer Kennzahl. `null`, wenn es keinen ehrlichen Vergleich gibt:
 * die Vorperiode trug den Kanal nicht (`null`), oder ihr Wert ist so nah an
 * null, dass jeder Prozentsatz Unsinn wäre (Regel 1). Der aktuelle Wert darf
 * `null` sein — dann gibt es ebenfalls nichts zu vergleichen.
 */
export function delta(
  jetzt: number | null | undefined,
  vorher: number | null | undefined,
  mehrIstBesser: MehrIstBesser = null,
  name = 'der Vorperiode',
): DeltaView | null {
  if (jetzt == null || vorher == null) return null;
  if (!Number.isFinite(jetzt) || !Number.isFinite(vorher)) return null;
  if (Math.abs(vorher) < BASIS_EPSILON) return null;

  const roh = ((jetzt - vorher) / Math.abs(vorher)) * 100;
  const pct = Math.round(Math.abs(roh));
  const flach = pct < FLACH_PCT;
  const richtung: DeltaRichtung = flach ? 'gleich' : roh > 0 ? 'mehr' : 'weniger';
  const wertung: DeltaWertung =
    flach || mehrIstBesser == null
      ? 'neutral'
      : (richtung === 'mehr') === mehrIstBesser
        ? 'gut'
        : 'schlecht';
  const text = flach ? `etwa wie ${praep(name)}` : `${pct} % ${richtung} als ${praep(name)}`;
  const titel =
    `Zeitraum: ${fmt(jetzt)} · ${name === 'der Vorperiode' ? 'Vorperiode' : name}: ${fmt(vorher)}`;
  return { richtung, wertung, pct, text, titel };
}

/** „im Juni" / „am Vortag" / „in der Vorwoche" / „2025" — im richtigen Fall. */
function praep(name: string): string {
  if (name === 'dem Vortag') return 'am Vortag';
  if (name === 'der Vorwoche') return 'in der Vorwoche';
  if (name === 'der Vorperiode') return 'in der Vorperiode';
  // Eine Jahreszahl steht bloß: „mehr als 2025", nie „mehr als im 2025".
  if (/^\d{4}$/.test(name)) return name;
  return `im ${name}`;
}

function fmt(v: number): string {
  return v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}
