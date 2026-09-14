/**
 * Die TAGES- und MONATSKARTE einer Messstelle (UEMS AP-08 IP-11) als reine
 * Ableitung: aus der Antwort von `GET /api/v1/messstellen/{kennzeichen}/werte`
 * (IP-9) wird, was die Karte und ihre Liste zeigen.
 *
 * Die Karte zeigt DREI Dinge nebeneinander, nie nur das erste: die Menge, ihren
 * Zustand samt Herkunft („vollständig (Menge aus Zählerständen)“) und die
 * Abdeckung des Verlaufs („Verlauf 85 %“) — dass beides zugleich stimmt, ist E1.
 *
 * Hier wird NICHTS gerechnet und kein Satz formuliert:
 *  - Zahl, Zustand, Verlauf und Kennzeichen kommen aus dem Ergebnis-Vertrag
 *    (`uemsErgebnis.ts`: `menge`, `teile`, `zustandMitHerkunft`), die Rundung
 *    bestimmt die EBENE (E11);
 *  - Beschriftung („02:00–03:00 MESZ“) und Tagesdauer („25 Stunden
 *    (Zeitumstellung)“) liefert die Route (E10) — die Fläche liest sie nur;
 *  - `null` ist ein Strich, nie 0.
 *
 * Ein Schritt ohne Zustand (die Route nennt dann `grund`) oder einer, der den
 * Vertrag verletzt, wird NICHT gesprochen: er zeigt nur den Strich.
 *
 * REIN: kein Netz, kein Zustand, keine Uhr.
 */

import type { MessstelleWerte, MessstelleWerteRaster, MessstelleWerteWert } from './api';
import { MONATE, WOCHENTAGE } from './picker/datum';
import {
  ANZEIGE_EINHEITEN,
  KEINE_WERTE,
  OHNE_ZAHL,
  VOLLSTAENDIG,
  menge,
  pruefe,
  pruefeMenge,
  teile,
  zustandMitHerkunft,
  type Ergebnis,
} from './uemsErgebnis';

/** Tag oder Monat — was die Karte zusammenfasst. */
export type KartenArt = 'tag' | 'monat';

/** Der Ton eines Abzeichens (die Varianten des `Badge` im Designsystem). */
export type Ton = 'ok' | 'warn' | 'off';

/** Was EIN Schritt anzeigt. */
export interface WertAnzeige {
  /** „2.304 kWh“ oder „—“. */
  zahl: string;
  /** Das Zustandswort (an der Karte samt Herkunft); `null` = der Schritt wird nicht gesprochen. */
  zustand: string | null;
  /** „Verlauf 85 %“; `null` = keine Abdeckung bekannt. */
  abdeckung: string | null;
  /** Die Kennzeichen-Sätze — Wortlaut und Reihenfolge wie geliefert. */
  kennzeichen: string[];
  zustandTon: Ton;
  abdeckungTon: Ton;
}

/** Die Karte oben: der Tag bzw. der Monat als EIN Schritt. */
export interface Karte extends WertAnzeige {
  titel: string;
  /** Nur am Tag: „25 Stunden (Zeitumstellung)“ bzw. „23 Stunden (Zeitumstellung)“. */
  tagesdauer: string | null;
}

/** Eine Zeile der Liste: eine Stunde des Tages bzw. ein Tag des Monats. */
export interface Zeile extends WertAnzeige {
  schluessel: string;
  beschriftung: string;
  /** Nur in der Tagesliste des Monats. */
  tagesdauer: string | null;
}

/** Eine Anfrage an die Route (Tage in der Zeitzone des Standorts, `bis` einschließlich). */
export interface Anfrage {
  raster: MessstelleWerteRaster;
  von: string;
  bis: string;
}

const zwei = (n: number): string => String(n).padStart(2, '0');

/** Der letzte Tag eines Monats `JJJJ-MM` als `JJJJ-MM-TT`. */
const letzterTag = (monat: string): string => {
  const [j, m] = monat.split('-').map(Number);
  return `${monat}-${zwei(new Date(Date.UTC(j, m, 0)).getUTCDate())}`;
};

/**
 * Die zwei Anfragen einer Karte: die Periode selbst (EIN Schritt) und ihre
 * Liste — am Tag die Stunden, im Monat die Tage. `wert` ist `JJJJ-MM-TT` bzw.
 * `JJJJ-MM`.
 */
export const anfragen = (art: KartenArt, wert: string): { karte: Anfrage; liste: Anfrage } => {
  if (art === 'tag') {
    return { karte: { raster: 'tag', von: wert, bis: wert }, liste: { raster: 'stunde', von: wert, bis: wert } };
  }
  const von = `${wert}-01`;
  const bis = letzterTag(wert);
  return { karte: { raster: 'monat', von, bis }, liste: { raster: 'tag', von, bis } };
};

/** Der Kalendertag des Beginns, wie die Route ihn schreibt (Ortszeit des Standorts, mit Versatz). */
const kalendertag = (von: string): { j: number; m: number; t: number } => {
  const [j, m, t] = von.slice(0, 10).split('-').map(Number);
  return { j, m, t };
};

/** „Di 03.11.2026“ — der Tag in der Ortszeit des Standorts. */
export const tagTitel = (von: string, mitJahr = true): string => {
  const { j, m, t } = kalendertag(von);
  const wochentag = WOCHENTAGE[(new Date(Date.UTC(j, m - 1, t)).getUTCDay() + 6) % 7];
  return `${wochentag} ${zwei(t)}.${zwei(m)}.${mitJahr ? j : ''}`;
};

/** „November 2026“. */
export const monatTitel = (von: string): string => {
  const { j, m } = kalendertag(von);
  return `${MONATE[m - 1]} ${j}`;
};

const tonDesZustands = (zustand: string | null): Ton => {
  if (zustand === VOLLSTAENDIG) return 'ok';
  if (zustand === null || zustand === KEINE_WERTE) return 'off';
  return 'warn';
};

const STRICH: WertAnzeige = {
  zahl: OHNE_ZAHL,
  zustand: null,
  abdeckung: null,
  kennzeichen: [],
  zustandTon: 'off',
  abdeckungTon: 'off',
};

/**
 * EIN Schritt als Anzeige. `mitHerkunft` setzt die Herkunft der Menge ans
 * Zustandswort (die Karte); die Zeilen einer Liste tragen das Wort allein.
 */
export const anzeige = (
  antwort: MessstelleWerte,
  w: MessstelleWerteWert,
  mitHerkunft: boolean,
): WertAnzeige => {
  const ebene = antwort.raster;
  const gespeichert = antwort.messstelle.einheit;
  const einheit = ANZEIGE_EINHEITEN.find((a) => a.gespeichert === gespeichert);
  // Ohne Zustand spricht der Schritt nicht; eine Einheit ohne Anzeige ebenso wenig.
  if (w.zustand === null || !einheit || pruefeMenge(gespeichert, ebene).length > 0) return STRICH;
  const ergebnis: Ergebnis = {
    wert: w.menge,
    einheit: einheit.angezeigt,
    ebene,
    zustand: w.zustand,
    abdeckungProzent: w.abdeckung_prozent,
    kennzeichen: w.kennzeichen,
  };
  // Ein Ergebnis, das den Vertrag verletzt, wird nicht gesprochen (auch nicht seine Zahl).
  if (pruefe(ergebnis).length > 0) return STRICH;
  const t = teile(ergebnis);
  const herleitung = mitHerkunft ? (antwort.quellen.find((q) => q.id === w.quelle)?.herleitung ?? null) : null;
  return {
    zahl: menge(w.menge, gespeichert, ebene),
    zustand: zustandMitHerkunft(w.zustand, herleitung, w.menge),
    abdeckung: t.abdeckung,
    kennzeichen: t.kennzeichen,
    zustandTon: tonDesZustands(w.zustand),
    abdeckungTon: w.abdeckung_prozent === 100 ? 'ok' : 'warn',
  };
};

/** Die Karte aus der Antwort der Periode (Raster `tag` bzw. `monat`, genau ein Schritt). */
export const karte = (antwort: MessstelleWerte): Karte | null => {
  const w = antwort.werte[0];
  if (!w) return null;
  return {
    ...anzeige(antwort, w, true),
    titel: antwort.raster === 'monat' ? monatTitel(w.von) : tagTitel(w.von),
    tagesdauer: antwort.raster === 'tag' ? w.tagesdauer : null,
  };
};

/**
 * Die Liste unter der Karte: am Tag die Stunden mit der Beschriftung der Route
 * (die doppelte Stunde mit MESZ/MEZ, die fehlende fehlt), im Monat die Tage mit
 * ihrer Tagesdauer.
 */
export const liste = (antwort: MessstelleWerte): Zeile[] =>
  antwort.werte.map((w) => ({
    ...anzeige(antwort, w, false),
    schluessel: w.von,
    beschriftung: antwort.raster === 'tag' ? tagTitel(w.von, false) : (w.beschriftung ?? w.von),
    tagesdauer: antwort.raster === 'tag' ? w.tagesdauer : null,
  }));
