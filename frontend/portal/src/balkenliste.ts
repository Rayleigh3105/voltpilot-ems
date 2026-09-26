/**
 * **Die Balkenliste** — der EINE Baustein, mit dem die Erlöse-Karten „Preise
 * im Zeitraum" und „So verdient Ihre Anlage" Preise je Kilowattstunde zeigen
 * (Konzept „Erlöse · Preise und Verdienst", 25.09.2026).
 *
 * Jede Zeile trägt Namen und Zahl als TEXT; der Balken darunter ist nur das
 * Bild dazu, auf EINER gemeinsamen Skala je Karte. Im Bild steht deshalb keine
 * Beschriftung, die bei 375 px überlappen oder gestaucht werden könnte — der
 * Befund, an dem das frühere Säulenbild gescheitert ist.
 *
 * **Ehrliche Skala per Konstruktion:** sie beginnt nie über 0 und reicht bis
 * zum größten Wert; ein negativer Wert zieht den Anfang nach links und bekommt
 * eine Nulllinie. Ein fehlender Wert ist KEIN Null-Balken, sondern
 * `vorhanden: false` („—" mit gestrichelter Spur).
 *
 * Reines Modul: kein React, kein Netzwerk. `components/erloese/Balkenliste.tsx`
 * rendert nur.
 */

import { NBSP } from './format';
import type { SekundaerZiel } from './erloesZeilen';

/**
 * Die Rolle eines Balkens — sie IST seine Farbe. Die drei Posten tragen
 * dieselbe Rollenfarbe wie Kennzahlen, Abrechnung und Verlauf
 * (`chartTheme()`: `cPv` · `cGrid` · `cGeldKosten`); der Durchschnitt aller
 * Solaranlagen ist eine Kontext-Reihe (Haus-Neutral), die Marktprämie der
 * Preis-Ton.
 */
export type BalkenRolle = 'eigenverbrauch' | 'einspeisung' | 'netzbezug' | 'markt' | 'praemie';

/** Ein Stück eines Balkens, in ct/kWh auf der gemeinsamen Skala. */
export interface BalkenSegment {
  rolle: BalkenRolle;
  von: number;
  bis: number;
  /** Schraffiert: ein vorläufiger Wert (der Monatsmarktwert vor dem amtlichen). */
  vorlaeufig?: boolean;
  /** Wird NACH dem Grundbalken aufgedeckt — es „kommt obendrauf". */
  danach?: boolean;
}

/** Die Unterzeile einer Zeile: ein Halbsatz, optional mit dem Weg dorthin. */
export interface BalkenUnter {
  text: string;
  link?: { text: string; ziel: SekundaerZiel } | null;
  /** Ein Farbschlüssel vor dem Text — er benennt ein Segment ohne Legende. */
  schluessel?: BalkenRolle | null;
}

export interface BalkenZeile {
  /** Stabile Kennung — sie hält die Zeile über einen Zeitraumwechsel. */
  id: string;
  name: string;
  /** Farbschlüssel vor dem Namen; `null` = kein Schlüssel (die Summenzeile). */
  rolle: BalkenRolle | null;
  /** Der angezeigte Wert, „25,0 ct" — oder „—". */
  wert: string;
  /** `false` ⇒ „—" und eine gestrichelte Spur, nie ein Null-Balken. */
  vorhanden: boolean;
  /** Ein negativer Wert trägt den Minus-Ton (das Vorzeichen steht im Text). */
  minus?: boolean;
  /** Die Ergebniszeile: größerer Wert, kräftigere Spur. */
  summe?: boolean;
  segmente: BalkenSegment[];
  unter: BalkenUnter | null;
  /** Erklärung auf Abruf (ⓘ am Namen). */
  info?: { titel: string; text: string } | null;
}

export interface BalkenSkala {
  min: number;
  max: number;
}

export interface Balkenliste {
  /** Der zugängliche Name der Liste. */
  label: string;
  zeilen: BalkenZeile[];
  skala: BalkenSkala;
}

/** Unter dieser Spannweite gibt es keine sinnvolle Skala — dann gilt 0 … 1 ct. */
const MIN_SPANNE = 0.001;

/**
 * Die gemeinsame Skala einer Liste: von `min(0, …)` bis `max(0, …)` über alle
 * Segmente. Kein Kopfraum nötig — die Zahlen stehen als Text neben dem Balken.
 */
export function skalaFuer(zeilen: readonly BalkenZeile[]): BalkenSkala {
  let min = 0;
  let max = 0;
  for (const z of zeilen) {
    for (const s of z.segmente) {
      min = Math.min(min, s.von, s.bis);
      max = Math.max(max, s.von, s.bis);
    }
  }
  if (max - min < MIN_SPANNE) max = min + 1;
  return { min, max };
}

/** Die Lage eines Werts auf der Skala, in Prozent der Spur. */
export function lage(v: number, skala: BalkenSkala): number {
  return ((v - skala.min) / (skala.max - skala.min)) * 100;
}

/** Die Liste mit ihrer Skala — die Skala wird nie von Hand gesetzt. */
export function balkenliste(label: string, zeilen: BalkenZeile[]): Balkenliste {
  return { label, zeilen, skala: skalaFuer(zeilen) };
}

/** Eine Nachkommastelle, wie „Ø … ct/kWh" in der Abrechnung. */
export function ct1(v: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * „25,0 ct" — negativ mit dem typografischen Minus („− 0,2 ct"), fehlend „—".
 * Das Vorzeichen folgt dem ANGEZEIGTEN Betrag: „− 0,0 ct" gibt es nicht.
 */
export function ctWert(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const betrag = ct1(Math.abs(v));
  const negativ = v < 0 && betrag !== ct1(0);
  return `${negativ ? `−${NBSP}` : ''}${betrag}${NBSP}ct`;
}

/** Ob ein Wert als Minus gelesen wird — dieselbe Grenze wie `ctWert`. */
export function istMinus(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(v) && v < 0 && ct1(Math.abs(v)) !== ct1(0);
}
