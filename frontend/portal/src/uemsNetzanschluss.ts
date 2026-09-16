/**
 * Der NETZANSCHLUSS als eigenes Objekt am Standort (UEMS AP-10 E8, AP-00 E6/E10) — der TS-Zwilling
 * von `services/api/.../uems/NetzanschlussRegeln.java`.
 *
 * Die EINE Wahrheit steht in `docs/contracts/v2/netzanschluss-vectors.json` (Prosa:
 * `netzanschluss.md`); beide Zwillinge fahren sie PER PFAD.
 *
 * Der Anschluss gehört dem STANDORT; eine Anlage verweist zeitgültig auf ihn (Tage). Je Tag hat
 * eine Anlage höchstens einen Anschluss UND ein Anschluss höchstens eine Anlage; ein Wechsel
 * beendet die laufende Bindung am Vortag.
 *
 * Was hier NICHT passiert (W9): die Preis- und Grenzspalten der Anlage bleiben unverändert an der
 * Anlage. Und die Kopfzeile ZEIGT die vereinbarte Leistung — sie PRÜFT keine Grenze (AP-15).
 *
 * Rein: keine Netzzugriffe, keine Uhr, kein React.
 */
import { dezText, type Dez } from './bezugsdaten';
import { kennzeichenFormatGueltig } from './uemsMessstelle';
import { minusTage } from './uemsBilanz';
import { KVA, KW, zahl } from './uemsErgebnis';

/** Dieselbe Kennzeichen-Form wie bei der Messstelle (AP-00 E10) — nur mit eigenem Präfix. */
export const KENNZEICHEN_PRAEFIX = 'NA-';
export const KENNZEICHEN_STELLEN = 4;

/** Elf Ziffern. Eine kürzere Nummer wird abgelehnt, nie aufgefüllt. */
export const MALO_MUSTER = '^[0-9]{11}$';

/** Geschlossenes Vokabular: ein Wort außerhalb wird VERWORFEN, nie geraten. */
export const MESSUNGEN = ['RLM', 'SLP'];

export const FEHLER_KENNZEICHEN_FORMAT = 'kennzeichen_format';
export const FEHLER_KENNZEICHEN_BELEGT = 'kennzeichen_belegt';
export const FEHLER_MALO = 'malo_form';
export const FEHLER_ANFRAGE = 'anfrage_ungueltig';
export const FEHLER_BINDUNG_UEBERLAPPT = 'bindung_ueberlappt';
export const FEHLER_ANSCHLUSS_BELEGT = 'anschluss_belegt';

/** Ein Hinweis hält nichts an — er sagt nur, was auffällt. */
export const HINWEIS_VEREINBART_UEBER_ANSCHLUSS = 'vereinbart_ueber_anschluss';

export const KOPFZEILE_TRENNER = ' · ';

// ------------------------------------------------------------------------------- Kennzeichen

export interface Vorschlag {
  kennzeichen: string;
  zaehler: number;
}

export interface KennzeichenUrteil {
  gueltig: boolean;
  fehler: string | null;
  vorschlag: Vorschlag | null;
}

/** Das automatische Kennzeichen zur laufenden Nummer: `2 → NA-0002`. */
export const automatisch = (nummer: number): string =>
  `${KENNZEICHEN_PRAEFIX}${String(nummer).padStart(KENNZEICHEN_STELLEN, '0')}`;

/**
 * `kandidat === null` heißt: automatisch vergeben — die kleinste Nummer über dem Zähler, deren
 * Kennzeichen niemand trägt oder trug. Ein einmal vergebenes Kennzeichen wird nie an einen anderen
 * Anschluss weitergegeben.
 */
export function kennzeichen(
  kandidat: string | null,
  belegt: string[],
  zaehler: number,
): KennzeichenUrteil {
  if (kandidat === null) {
    let n = zaehler + 1;
    while (belegt.includes(automatisch(n))) n += 1;
    return { gueltig: true, fehler: null, vorschlag: { kennzeichen: automatisch(n), zaehler: n } };
  }
  if (!kennzeichenFormatGueltig(kandidat)) {
    return { gueltig: false, fehler: FEHLER_KENNZEICHEN_FORMAT, vorschlag: null };
  }
  if (belegt.includes(kandidat)) {
    return { gueltig: false, fehler: FEHLER_KENNZEICHEN_BELEGT, vorschlag: null };
  }
  return { gueltig: true, fehler: null, vorschlag: null };
}

// ---------------------------------------------------------------------------- Marktlokation

export interface MaloUrteil {
  malo: string | null;
  fehler: string | null;
}

/**
 * Die Marktlokation hat elf Ziffern. Ohne Marktlokation ist der Anschluss anlegbar — sie ist dann
 * `null`, nicht „unbekannt 0". Was die Form nicht hält, wird abgelehnt statt zurechtgebogen.
 */
export function malo(text: string | null): MaloUrteil {
  if (text === null) return { malo: null, fehler: null };
  return new RegExp(MALO_MUSTER).test(text)
    ? { malo: text, fehler: null }
    : { malo: null, fehler: FEHLER_MALO };
}

// ---------------------------------------------------------------------------------- Felder

export interface Felder {
  name: string | null;
  standort: string | null;
  malo: string | null;
  netzbetreiber: string | null;
  anschluss_kva: Dez | null;
  vereinbart_kw: Dez | null;
  messung: string | null;
}

export interface FelderUrteil {
  gueltig: boolean;
  fehler: string | null;
  feld: string | null;
  hinweise: string[];
}

const positiv = (d: Dez | null): boolean => d === null || d.z > 0n;

const groesser = (a: Dez, b: Dez): boolean => {
  const e = Math.max(a.e, b.e);
  return a.z * 10n ** BigInt(e - a.e) > b.z * 10n ** BigInt(e - b.e);
};

/**
 * Name und Standort sind Pflicht; Leistungen sind freiwillig, aber wenn sie da sind, sind sie
 * größer als null. Die Messung kommt aus dem geschlossenen Vokabular. Eine vereinbarte Leistung
 * ÜBER der Anschlussleistung ist ein Hinweis, keine Ablehnung: was der Netzbetreiber vereinbart
 * hat, wissen wir nicht besser als er.
 */
export function felder(f: Felder): FelderUrteil {
  const ab = (feld: string): FelderUrteil => ({
    gueltig: false,
    fehler: FEHLER_ANFRAGE,
    feld,
    hinweise: [],
  });
  if (!f.name || !f.name.trim()) return ab('name');
  if (!f.standort || !f.standort.trim()) return ab('standort');
  if (f.messung === null || !MESSUNGEN.includes(f.messung)) return ab('messung');
  if (!positiv(f.anschluss_kva)) return ab('anschluss_kva');
  if (!positiv(f.vereinbart_kw)) return ab('vereinbart_kw');
  if (f.malo !== null && malo(f.malo).fehler !== null) return ab('malo');
  const hinweise: string[] = [];
  if (f.anschluss_kva !== null && f.vereinbart_kw !== null && groesser(f.vereinbart_kw, f.anschluss_kva)) {
    hinweise.push(HINWEIS_VEREINBART_UEBER_ANSCHLUSS);
  }
  return { gueltig: true, fehler: null, feld: null, hinweise };
}

// --------------------------------------------------------------------------------- Bindung

/** Eine zeitgültige Bindung Anlage ↔ Netzanschluss; `gueltig_bis === null` heißt „läuft". */
export interface Bindung {
  anlage: string;
  netzanschluss: string;
  gueltig_ab: string;
  gueltig_bis: string | null;
}

export interface BindungUrteil {
  beendet: Bindung | null;
  eintrag: Bindung | null;
  fehler: string | null;
  rueckwirkend: boolean;
}

const laeuftAm = (b: Bindung, tag: string): boolean =>
  tag >= b.gueltig_ab && (b.gueltig_bis === null || tag <= b.gueltig_bis);

/** Teilen sich zwei Bindungen mindestens einen Tag (`gueltig_bis === null` = offen)? */
const ueberlappen = (a: Bindung, b: Bindung): boolean =>
  !(a.gueltig_bis !== null && a.gueltig_bis < b.gueltig_ab) &&
  !(b.gueltig_bis !== null && b.gueltig_bis < a.gueltig_ab);

/**
 * Eine neue Bindung ab ihrem Tag. Läuft an diesem Tag schon eine Bindung DERSELBEN Anlage, die an
 * genau diesem Tag beginnt, ist das ein Konflikt; beginnt die neue später, wird die laufende am
 * Vortag beendet. Hängt der Anschluss an einem ihrer Tage schon an einer ANDEREN Anlage, ist er
 * belegt. Eine SPÄTERE Bindung derselben Anlage wird nie verkürzt — teilt die neue einen Tag mit
 * ihr, ist das ebenfalls ein Konflikt (nur die laufende endet am Vortag, nichts wird überschrieben).
 */
export function bindung(bestehend: Bindung[], neu: Bindung, heute: string): BindungUrteil {
  const rueckwirkend = neu.gueltig_ab < heute;
  const belegt = bestehend.some(
    (b) =>
      b.netzanschluss === neu.netzanschluss && b.anlage !== neu.anlage && ueberlappen(b, neu),
  );
  if (belegt) {
    return { beendet: null, eintrag: null, fehler: FEHLER_ANSCHLUSS_BELEGT, rueckwirkend };
  }
  const laufend = bestehend.find((b) => b.anlage === neu.anlage && laeuftAm(b, neu.gueltig_ab));
  if (laufend && neu.gueltig_ab <= laufend.gueltig_ab) {
    return { beendet: null, eintrag: null, fehler: FEHLER_BINDUNG_UEBERLAPPT, rueckwirkend };
  }
  const spaeter = bestehend.some(
    (b) => b !== laufend && b.anlage === neu.anlage && ueberlappen(b, neu),
  );
  if (spaeter) {
    return { beendet: null, eintrag: null, fehler: FEHLER_BINDUNG_UEBERLAPPT, rueckwirkend };
  }
  if (!laufend) return { beendet: null, eintrag: neu, fehler: null, rueckwirkend };
  return {
    beendet: { ...laufend, gueltig_bis: minusTage(neu.gueltig_ab, 1) },
    eintrag: neu,
    fehler: null,
    rueckwirkend,
  };
}

// ------------------------------------------------------------------------------- Kopfzeile

export interface KopfzeileUrteil {
  text: string;
  grenze_geprueft: boolean;
}

/**
 * Die Kopfzeile der Bilanz-Seite. Was fehlt, steht nicht da — ein fehlender Momentanwert wird nie
 * zu „0 kW". `uemsErgebnis.zahl` unterscheidet vereinbarte Angaben und gemessene Leistung (E11).
 * `grenze_geprueft` ist immer `false`: hier wird GEZEIGT, nicht geprüft (AP-15).
 */
export function kopfzeile(
  // Die Kennung steht am Kopf der Seite, nicht in dieser Zeile.
  _netzanschluss: string | null,
  vereinbartKw: Dez | null,
  anschlussKva: Dez | null,
  momentanKw: Dez | null,
): KopfzeileUrteil {
  const teile: string[] = [];
  if (vereinbartKw !== null) teile.push(`vereinbart ${zahl(dezText(vereinbartKw), KW, null, 'vereinbart')}`);
  if (anschlussKva !== null) teile.push(`Anschluss ${zahl(dezText(anschlussKva), KVA, null, 'vereinbart')}`);
  if (momentanKw !== null) teile.push(`Momentan ${zahl(dezText(momentanKw), KW, null)}`);
  return { text: teile.join(KOPFZEILE_TRENNER), grenze_geprueft: false };
}
