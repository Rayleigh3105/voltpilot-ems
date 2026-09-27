/**
 * K2 (Konzept „Energiemanagement ohne Fachsprache“, D4): der Fahrplan „Ihr Energiemanagement“ auf der Übersicht des
 * Unternehmens — sechs Schritte in der Reihenfolge, in der ein Betrieb sein Energiemanagement aufbaut. Jeder Schritt sagt
 * in einem Satz, was im Portal festgehalten ist, und nennt genau eine nächste Handlung.
 *
 * Regeln:
 * - Was nicht abrufbar ist, heißt „Nicht abrufbar.“ — nie „0“ und nie „erledigt“; was noch lädt, ist unbekannt.
 * - Kein Schritt beurteilt, ob etwas genügt: keine Zahl über das Ganze, kein Erfüllungsgrad, keine Ampel (G4). Der
 *   Fahrplan beschreibt, was hier festgehalten ist.
 * - Ein Schritt ohne das Recht, seinen Bereich zu sehen, entfällt — er wäre eine Sackgasse.
 * - Stehen alle Schritte, die die Person sieht, zeigt die Übersicht nur noch „Was steht an“ ({@link fahrplanSteht}, D4).
 *
 * Reines Modul: kein React, kein Netz; die Daten kommen aus den Abfragen, die die Bereiche schon haben.
 */
import type { Bericht, BewertungUmfang, Energieeinsatz, EnergiemanagementVerzeichnis, Kennzahl, Selbstauskunft } from './api';
import type { BezugsbasisUebersicht } from './bezugsbasisUebersicht';
import { bewertungFristBaustein } from './bewertungFrist';
import { SAETZE } from './energiemanagement';
import { verzeichnisWeg } from './energiemanagementPortal';
import { managementbewertungen } from './managementbewertung';
import { energiemanagementRoute, pageRoute, type Route } from './nav';
import type { VerbesserungUebersicht } from './verbesserungUebersicht';

/** Die Rechte aus `/me` — entschieden wird an der Route; hier nur, welche Schritte die Person sieht. */
type Rechte = Pick<Selbstauskunft, 'standorte' | 'unternehmen_rechte'>;

/** Der Stand einer Abfrage: lädt noch, nicht abrufbar, oder da. */
export type Lage<T> = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; wert: T };

export const FAHRPLAN_TITEL = 'Ihr Energiemanagement';
export const FAHRPLAN_SATZ = 'In der Reihenfolge, in der ein Betrieb es aufbaut — je Schritt, was hier festgehalten ist, und was als Nächstes geht.';
export const NICHT_ABRUFBAR = 'Nicht abrufbar.';
export const WIRD_GELADEN = 'Wird geladen …';

export type FahrplanSchrittKey = 'messen' | 'bewerten' | 'kennzahlen' | 'ziele' | 'nachweise' | 'rueckblick';

export interface FahrplanHandlung {
  text: string;
  ziel: Route;
}

export interface FahrplanSchritt {
  key: FahrplanSchrittKey;
  titel: string;
  /** Ein Satz: was im Portal festgehalten ist — oder „Nicht abrufbar.“ / „Wird geladen …“. */
  stand: string;
  /** `true` = etwas ist festgehalten, `false` = noch nichts, `null` = unbekannt (lädt oder nicht abrufbar). */
  festgehalten: boolean | null;
  /** Genau eine nächste Handlung. */
  handlung: FahrplanHandlung;
}

export interface FahrplanEingang {
  /** Die Namen der Standorte, an denen gemessen wird — aus Ebene und Funktionen, ohne eigene Abfrage. */
  messendeStandorte: readonly string[];
  /** Die Rechte der Person; ohne Recht auf einen Bereich entfällt sein Schritt. */
  rechte: Rechte | null;
  umfang: Lage<BewertungUmfang>;
  einsaetze: Lage<readonly Energieeinsatz[]>;
  /** Die Berichte: die energetische Bewertung (Schritt 2) und die Managementbewertungen (Schritt 6). */
  berichte: Lage<readonly Bericht[]>;
  kennzahlen: Lage<readonly Kennzahl[]>;
  bezugsbasen: Lage<BezugsbasisUebersicht>;
  verbesserung: Lage<VerbesserungUebersicht>;
  verzeichnis: Lage<EnergiemanagementVerzeichnis>;
}

const hat = (r: Rechte | null, recht: string) =>
  !!r && (r.unternehmen_rechte.includes(recht) || r.standorte.some((s) => s.rechte.includes(recht)));

/** Welche Schritte die Person sieht — und damit, welche Daten der Fahrplan abfragen muss. */
export function fahrplanSchritte(r: Rechte | null): FahrplanSchrittKey[] {
  const out: FahrplanSchrittKey[] = ['messen'];
  if (hat(r, 'energieeinsatz.ansehen')) out.push('bewerten');
  out.push('kennzahlen');
  if (hat(r, 'verbesserung.ansehen')) out.push('ziele');
  if (hat(r, 'energiemanagement.ansehen')) out.push('nachweise', 'rueckblick');
  return out;
}

const anzahl = (n: number, eins: string, viele: string) => `${n} ${n === 1 ? eins : viele}`;

/** Ein Schritt, dessen Daten (noch) fehlen: nie „0“, nie „erledigt“. */
function unbekannt(
  key: FahrplanSchrittKey,
  titel: string,
  lagen: readonly Lage<unknown>[],
  handlung: FahrplanHandlung,
): FahrplanSchritt | null {
  if (lagen.some((l) => l.art === 'fehler')) return { key, titel, stand: NICHT_ABRUFBAR, festgehalten: null, handlung };
  if (lagen.some((l) => l.art === 'laedt')) return { key, titel, stand: WIRD_GELADEN, festgehalten: null, handlung };
  return null;
}

const wert = <T>(l: Lage<T>): T => (l as { art: 'da'; wert: T }).wert;

function messen(e: FahrplanEingang): FahrplanSchritt {
  const titel = 'Messen einrichten';
  return e.messendeStandorte.length > 0
    ? {
        key: 'messen',
        titel,
        stand: `Gemessen wird an: ${e.messendeStandorte.join(', ')}.`,
        festgehalten: true,
        handlung: { text: 'Messstellen ansehen', ziel: pageRoute('portfolio-messstellen') },
      }
    : {
        key: 'messen',
        titel,
        stand: 'An keinem Standort wird gemessen.',
        festgehalten: false,
        handlung: { text: 'Standorte ansehen', ziel: pageRoute('portfolio-standorte') },
      };
}

function bewerten(e: FahrplanEingang): FahrplanSchritt {
  const key = 'bewerten';
  const titel = 'Energieeinsätze bewerten';
  const zur = (text: string) => ({ text, ziel: pageRoute('portfolio-bewertung') });
  const offen = unbekannt(key, titel, [e.umfang, e.einsaetze, e.berichte], zur('Zur energetischen Bewertung'));
  if (offen) return offen;
  if (wert(e.umfang).fassung === null) {
    return { key, titel, stand: 'Der Umfang ist noch nicht festgelegt.', festgehalten: false, handlung: zur('Umfang festlegen') };
  }
  const einsaetze = wert(e.einsaetze);
  if (einsaetze.length === 0) {
    return { key, titel, stand: 'Noch kein Energieeinsatz angelegt.', festgehalten: false, handlung: zur('Energieeinsatz anlegen') };
  }
  const frist = bewertungFristBaustein(wert(e.berichte));
  if (frist) return { key, titel, stand: frist.satz, festgehalten: true, handlung: zur('Zur energetischen Bewertung') };
  return {
    key,
    titel,
    stand: `${anzahl(einsaetze.length, 'Energieeinsatz', 'Energieeinsätze')} angelegt, noch kein freigegebener Stand der energetischen Bewertung.`,
    festgehalten: false,
    handlung: zur('Zur energetischen Bewertung'),
  };
}

function kennzahlen(e: FahrplanEingang): FahrplanSchritt {
  const key = 'kennzahlen';
  const titel = 'Kennzahlen mit Vergleichszeitraum';
  const zu = (text: string) => ({ text, ziel: pageRoute('portfolio-kennzahlen') });
  const offen = unbekannt(key, titel, [e.kennzahlen, e.bezugsbasen], zu('Zu den Kennzahlen'));
  if (offen) return offen;
  const lebende = wert(e.kennzahlen).filter((k) => k.archiviert_am == null).length;
  if (lebende === 0) return { key, titel, stand: 'Noch keine Kennzahl.', festgehalten: false, handlung: zu('Kennzahl anlegen') };
  const kz = anzahl(lebende, 'Kennzahl', 'Kennzahlen');
  const laufend = wert(e.bezugsbasen).laufend;
  if (laufend === 0) {
    return { key, titel, stand: `${kz}, noch ohne Bezugsbasis.`, festgehalten: false, handlung: zu('Bezugsbasis festlegen') };
  }
  return {
    key,
    titel,
    stand: `${kz} · ${anzahl(laufend, 'laufende Bezugsbasis', 'laufende Bezugsbasen')}.`,
    festgehalten: true,
    handlung: zu('Zu den Kennzahlen'),
  };
}

function ziele(e: FahrplanEingang): FahrplanSchritt {
  const key = 'ziele';
  const titel = 'Ziele und Maßnahmen';
  const zu = (text: string) => ({ text, ziel: pageRoute('portfolio-verbesserung') });
  const offen = unbekannt(key, titel, [e.verbesserung], zu('Zu Zielen und Maßnahmen'));
  if (offen) return offen;
  const z = wert(e.verbesserung).zaehler;
  if (z.energieziele_laufend === 0) {
    return { key, titel, stand: 'Noch kein laufendes Energieziel.', festgehalten: false, handlung: zu('Energieziel setzen') };
  }
  return {
    key,
    titel,
    stand: `${anzahl(z.energieziele_laufend, 'laufendes Energieziel', 'laufende Energieziele')} · ${anzahl(z.massnahmen_geplant, 'Maßnahme', 'Maßnahmen')} geplant.`,
    festgehalten: true,
    handlung: zu('Zu Zielen und Maßnahmen'),
  };
}

function nachweise(e: FahrplanEingang): FahrplanSchritt {
  const key = 'nachweise';
  const titel = 'Nachweise führen';
  const verzeichnis = { text: 'Zum Verzeichnis', ziel: energiemanagementRoute('verzeichnis') };
  const offen = unbekannt(key, titel, [e.verzeichnis], verzeichnis);
  if (offen) return offen;
  const gruppen = wert(e.verzeichnis).gruppen;
  const leer = gruppen.filter((g) => g.zeilen.length === 0);
  const mit = gruppen.filter((g) => g.zeilen.length > 0).map((g) => g.gruppe_wort);
  // Der nächste Schritt ist der erste Weg einer Gruppe ohne Eintrag (K4) — ohne Recht dorthin das Verzeichnis selbst.
  const naechster = leer.map((g) => verzeichnisWeg(g.gruppe, e.rechte)).find((w) => w !== null) ?? verzeichnis;
  return {
    key,
    titel,
    stand: mit.length === 0 ? SAETZE.verzeichnis_leer : `Festgehalten in: ${mit.join(', ')}.`,
    festgehalten: leer.length === 0,
    handlung: naechster,
  };
}

function rueckblick(e: FahrplanEingang): FahrplanSchritt {
  const key = 'rueckblick';
  const titel = 'Jährlicher Rückblick';
  const zur = { text: 'Zur Managementbewertung', ziel: energiemanagementRoute('managementbewertung') };
  const offen = unbekannt(key, titel, [e.berichte], zur);
  if (offen) return offen;
  const liste = managementbewertungen(wert(e.berichte));
  const freigegeben = liste.find((b) => b.neueste_nr != null);
  if (freigegeben) {
    return {
      key,
      titel,
      stand: `Managementbewertung ${freigegeben.zeitraum}: Stand Nr. ${freigegeben.neueste_nr} freigegeben.`,
      festgehalten: true,
      handlung: zur,
    };
  }
  return {
    key,
    titel,
    stand: liste.length === 0 ? 'Noch keine Managementbewertung angelegt.' : `Managementbewertung ${liste[0].zeitraum}: noch kein Stand freigegeben.`,
    festgehalten: false,
    handlung: zur,
  };
}

const BAUER: Record<FahrplanSchrittKey, (e: FahrplanEingang) => FahrplanSchritt> = {
  messen,
  bewerten,
  kennzahlen,
  ziele,
  nachweise,
  rueckblick,
};

/** Die Schritte, die die Person sieht, in der Reihenfolge des Aufbaus. */
export function fahrplan(e: FahrplanEingang): FahrplanSchritt[] {
  return fahrplanSchritte(e.rechte).map((key) => BAUER[key](e));
}

/**
 * D4: steht jeder sichtbare Schritt? Dann zeigt die Übersicht nur noch „Was steht an“. Ein unbekannter Schritt (lädt,
 * nicht abrufbar) steht nie — der Fahrplan bleibt, bis die Daten es zeigen.
 */
export function fahrplanSteht(schritte: readonly FahrplanSchritt[]): boolean {
  return schritte.length > 0 && schritte.every((s) => s.festgehalten === true);
}
