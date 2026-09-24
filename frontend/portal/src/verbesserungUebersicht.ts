/**
 * UEMS AP-18 IP-19 (F1–F3, W7, R9, R13): das reine Bild des Übersichts-Bausteins „Ziele und Maßnahmen“ am Unternehmen.
 * Zähler und Fristen leitet der Server beim Abruf ab (`GET /api/v1/verbesserung/uebersicht`, Operation `frist`); hier
 * werden nur Sätze gebildet — Wortlaut aus AP-18 §5.9 („Baustein“, „Überfällig“). Reines Modul: kein React, kein Netz.
 */
import { tagDeutsch } from './bezugsbasisUebersicht';
import {
  UEMS_BEWERTUNG_FAELLIG_SEIT,
  UEMS_UEBERFAELLIG_SEIT,
  UEMS_ZIELE_UND_MASSNAHMEN,
} from './glossar';

export type VerbesserungUebersichtZaehler = {
  auffaelligkeiten_offen: number;
  abweichungen_offen: number;
  abweichungen_ueberfaellig: number;
  massnahmen_geplant: number;
  massnahmen_ueberfaellig: number;
  massnahmen_umgesetzt_ohne_bewertung: number;
  energieziele_laufend: number;
  energieziele_bewertung_faellig: number;
  anstoesse_offen: number;
  messbedarfe_ueberfaellig: number;
};

/** Ein fälliger Vorgang; `satz` ist der §5.9-Satz „Überfällig“ des Servers (beim Energieziel `null`). */
export type VerbesserungUebersichtZeile = {
  art: 'massnahme' | 'abweichung' | 'energieziel';
  id: string;
  kennzeichen: string;
  titel: string;
  zustand: string;
  termin: string;
  faellig: 'ueberfaellig' | 'bewertung_faellig';
  seit_tagen: number;
  verantwortlich: string;
  satz: string | null;
  kennzahl_id: string | null;
  einsatz_id: string | null;
};

export type VerbesserungUebersicht = {
  abruf: string;
  zaehler: VerbesserungUebersichtZaehler;
  faellig: VerbesserungUebersichtZeile[];
};

/**
 * Wohin eine Zeile springt: jeder fällige Vorgang auf seine eigene Seite — Energieziel (IP-8), Maßnahme (IP-13),
 * Abweichung (IP-18).
 */
export type VerbesserungSprung = { art: VerbesserungUebersichtZeile['art']; id: string } | null;

export type VerbesserungUebersichtBild = {
  /** Der §5.9-Satz „Baustein“ ohne den Titel davor. */
  summe: string;
  /** Etwas ist überfällig oder fällig — die Summe trägt den Warnton. */
  faellig: boolean;
  /** Die übrigen Zähler: „1 Maßnahme geplant · 1 offene Auffälligkeit“ (leer: nichts weiter). */
  zahlen: string;
  zeilen: { key: string; satz: string; sprung: VerbesserungSprung }[];
};

export const ZIELE_MASSNAHMEN_TITEL = UEMS_ZIELE_UND_MASSNAHMEN;
/** Der Sprung in den Bereich „Ziele und Maßnahmen“ (IP-8) — gebaut wie „Alle Kennzahlen“ am Baustein „Kennzahlen“. */
export const ZIELE_MASSNAHMEN_OEFFNEN = `Alle ${UEMS_ZIELE_UND_MASSNAHMEN}`;

const anzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Die Zeile eines fälligen Energieziels — das Muster „Überfällig“ mit „Bewertung fällig seit n Tagen“. */
function energiezielSatz(z: VerbesserungUebersichtZeile): string {
  return `${z.kennzeichen} · ${z.titel} · ${UEMS_BEWERTUNG_FAELLIG_SEIT(z.seit_tagen)} · ${z.verantwortlich}.`;
}

export function sprungDerZeile(z: Pick<VerbesserungUebersichtZeile, 'art' | 'id'>): VerbesserungSprung {
  return { art: z.art, id: z.id };
}

/** §5.9 „Baustein“ — Titel, dann die fälligen und die offenen Teile; eine einzelne überfällige Maßnahme mit Namen. */
export function bausteinSatz(u: VerbesserungUebersicht): string {
  return `${UEMS_ZIELE_UND_MASSNAHMEN} — ${summeSatz(u)}`;
}

function summeSatz(u: VerbesserungUebersicht): string {
  const z = u.zaehler;
  const teile: string[] = [];
  if (z.abweichungen_ueberfaellig > 0) {
    teile.push(`${anzahl(z.abweichungen_ueberfaellig, 'Abweichung', 'Abweichungen')} überfällig`);
  }
  if (z.massnahmen_ueberfaellig > 0) {
    const eine = u.faellig.filter((f) => f.art === 'massnahme');
    teile.push(
      z.massnahmen_ueberfaellig === 1 && eine.length === 1
        ? `1 Maßnahme überfällig: ${eine[0].kennzeichen} ${eine[0].titel}, Termin ${tagDeutsch(eine[0].termin)}, ${UEMS_UEBERFAELLIG_SEIT(eine[0].seit_tagen)} (${eine[0].verantwortlich})`
        : `${z.massnahmen_ueberfaellig} Maßnahmen überfällig`,
    );
  }
  if (z.energieziele_bewertung_faellig > 0) {
    teile.push(`${anzahl(z.energieziele_bewertung_faellig, 'Energieziel', 'Energieziele')} mit fälliger Bewertung`);
  }
  if (z.massnahmen_umgesetzt_ohne_bewertung > 0) {
    teile.push(`${anzahl(z.massnahmen_umgesetzt_ohne_bewertung, 'Maßnahme', 'Maßnahmen')} umgesetzt, noch nicht bewertet`);
  }
  if (z.energieziele_laufend > 0) {
    teile.push(z.energieziele_laufend === 1 ? '1 Energieziel läuft' : `${z.energieziele_laufend} Energieziele laufen`);
  }
  return teile.length > 0 ? `${teile.join(' · ')}.` : 'Nichts überfällig.';
}

/**
 * Das Bild der Kachel; `null` ohne Energieziel, Maßnahme, Abweichung oder Auffälligkeit, die noch etwas verlangt —
 * ein Kunde ohne Vorgang sieht keine neue Kachel (R13, AP-13 E3). Ein überfälliger Messbedarf allein öffnet sie nicht
 * (er steht am Baustein „Energetische Bewertung“); mit einem Vorgang zählt er mit (W7).
 */
export function verbesserungUebersichtBild(u: VerbesserungUebersicht | null): VerbesserungUebersichtBild | null {
  if (!u) return null;
  const z = u.zaehler;
  const vorgaenge =
    z.auffaelligkeiten_offen +
    z.abweichungen_offen +
    z.massnahmen_geplant +
    z.massnahmen_umgesetzt_ohne_bewertung +
    z.energieziele_laufend +
    z.anstoesse_offen;
  if (vorgaenge === 0 && u.faellig.length === 0) return null;
  const zahlen: string[] = [];
  if (z.auffaelligkeiten_offen > 0) {
    zahlen.push(anzahl(z.auffaelligkeiten_offen, 'offene Auffälligkeit', 'offene Auffälligkeiten'));
  }
  if (z.abweichungen_offen > 0) zahlen.push(anzahl(z.abweichungen_offen, 'offene Abweichung', 'offene Abweichungen'));
  if (z.massnahmen_geplant > 0) zahlen.push(`${anzahl(z.massnahmen_geplant, 'Maßnahme', 'Maßnahmen')} geplant`);
  if (z.anstoesse_offen > 0) zahlen.push(anzahl(z.anstoesse_offen, 'offener Anstoß', 'offene Anstöße'));
  if (z.messbedarfe_ueberfaellig > 0) {
    zahlen.push(`${anzahl(z.messbedarfe_ueberfaellig, 'Messbedarf', 'Messbedarfe')} überfällig`);
  }
  return {
    summe: summeSatz(u),
    faellig: u.faellig.length > 0 || z.messbedarfe_ueberfaellig > 0,
    zahlen: zahlen.join(' · '),
    zeilen: u.faellig.map((f) => ({
      key: `${f.art}-${f.id}`,
      satz: f.satz ?? energiezielSatz(f),
      sprung: sprungDerZeile(f),
    })),
  };
}
