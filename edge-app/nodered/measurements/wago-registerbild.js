'use strict';

/**
 * Treiberfamilie `wago.registerbild` (UEMS AP-05 IP-6, Teil a).
 *
 * Liest das „VoltPilot-Registerbild WAGO v1" (`docs/contracts/v2/wago-registerbild.md`) von
 * einer WAGO-Steuerung: Block-Lesen je Steuerung, Karte = Basis + n · Stride, 32-bit nach dem
 * Parameter Wortfolge.
 *
 * ⚠ **Der Treiber ist RUHEND.** Die Familien `wago.pm494`/`wago.pm495` stehen in
 * `NOCH_NICHT_AN_DER_BOX` (`catalog/measurement-points/tools/cataloglib.py`), also enthaelt die
 * Box-Sicht des Katalogs keinen einzigen WAGO-Punkt und `resolvePoint` liefert fuer sie `null`.
 * Dieser Leser laeuft heute nur in seinen Tests - das Heben von `RUNTIME_VERSION`, das Streichen
 * des Eintrags und die Metadaten-Migration sind ein eigenes Paket und gehoeren zu einem
 * Edge-Release (Befund 8 aus dem Bau von AP-05).
 *
 * ⚠ **Der Treiber erfindet weder Faktor noch Datentyp.** Fuer die 750-494 ist die
 * Messwert-Tabelle insgesamt NICHT belegt (Befund 4): ihre Katalogpunkte tragen
 * `value_type: "unknown"` und sind nicht lesbar. Hier entstehen nur Rohwoerter und - wo der
 * Vertrag einen Datentyp belegt - die 32-bit-Ganzzahl dahinter. Aus einem Rohwert wird an
 * dieser Stelle nie eine kWh-Zahl.
 *
 * Nicht hier, mit Absicht: die Kopf-Pruefung als eigene Stufe mit Herzschlag-Qualitaet `stale`
 * und Probe-Op `wago_kopf` ist IP-7, die Ereignisse aus dem Statuswort sind IP-8. Dieser Leser
 * liefert die Beobachtung (`herzschlagUrteil`) und das Urteil je Karte; was daraus an Qualitaet
 * und Ereignis wird, entscheiden die beiden Folgepakete.
 */

// ---------------------------------------------------------------------------
// Festlegungen des Vertrags (§3, §4). Sie sagen nichts ueber Hardware, sondern nur, wie
// Programm und Box sich verstaendigen - darum stehen sie hier als Konstanten und nicht im
// Katalog. `wago-registerbild.test.js` prueft sie gegen `wago-registerbild-vectors.json`.
// ---------------------------------------------------------------------------

/** 0x5650 „VP", 0x5242 „RB" - zwei einzelne Woerter, von der Wortfolge unberuehrt (§3). */
const SIGNATUR = Object.freeze([0x5650, 0x5242]);
const HAUPTVERSION = 1;
const KOPFLAENGE_MIN = 12;
const KARTENBLOCKLAENGE_MIN = 42;
/** Mit dem Parameter Wortfolge gelesen 0x01020304 - sonst gibt es keinen Kartenwert (§3). */
const WORTFOLGE_PRUEFWERT = 0x01020304;
/** Artikelnummer ohne „750-" (§4). Ein anderer Wert heisst `kartentyp_fremd`. */
const KARTENTYPEN = Object.freeze([494, 495]);
/** Hoechstens 120 Woerter je Anfrage: `docs/contracts/v2/measurement-budget-vectors.json`. */
const MAX_WOERTER_JE_ANFRAGE = 120;

/** Offsets im Kopf, ab der Basisadresse (§3). */
const KOPF = Object.freeze({
  signatur_1: 0, signatur_2: 1, hauptversion: 2, nebenversion: 3, kopflaenge: 4,
  kartenblocklaenge: 5, kartenzahl: 6, herzschlag: 7, wortfolge_pruefwert: 8,
  controller_kennung: 10,
});

/** Offsets im Karten-Block, ab dem Blockanfang (§4). */
const KARTE = Object.freeze({
  steckplatz: 0, kartentyp: 1, variante: 2, gueltigkeit: 3, kartenregister_32: 4,
  kartenregister_35: 5, statuswoerter: 6, messwerte: 18,
});
/** 3 Gruppen × 4 Woerter (§4.2). */
const STATUSWOERTER = 12;

/** Welche Teile das Programm gelesen hat (§4.1). Ist ein Bit 0, ist der Teil unbekannt. */
const GUELTIGKEIT = Object.freeze({
  karte_gelesen: 0, kartenregister_32_gelesen: 1, kartenregister_35_gelesen: 2,
  statuswoerter_gelesen: 3,
});

/**
 * Der Standardsatz E9 (§4.3). `datentyp: null` heisst „zu erheben" - ohne belegten Datentyp
 * gibt es nie eine Zahl, auch wenn Woerter dastehen.
 */
const MESSWERTE = Object.freeze([
  { nr: 1, schluessel: 'energy_import_total', offset: 18, datentyp: 'UInt32' },
  { nr: 2, schluessel: 'energy_export_total', offset: 20, datentyp: null },
  { nr: 3, schluessel: 'power_l1', offset: 22, datentyp: 'Int32' },
  { nr: 4, schluessel: 'power_l2', offset: 24, datentyp: 'Int32' },
  { nr: 5, schluessel: 'power_l3', offset: 26, datentyp: 'Int32' },
  { nr: 6, schluessel: 'voltage_l1', offset: 28, datentyp: 'UInt32' },
  { nr: 7, schluessel: 'voltage_l2', offset: 30, datentyp: 'UInt32' },
  { nr: 8, schluessel: 'voltage_l3', offset: 32, datentyp: 'UInt32' },
  { nr: 9, schluessel: 'current_l1', offset: 34, datentyp: 'UInt32' },
  { nr: 10, schluessel: 'current_l2', offset: 36, datentyp: 'UInt32' },
  { nr: 11, schluessel: 'current_l3', offset: 38, datentyp: 'UInt32' },
  { nr: 12, schluessel: 'frequency', offset: 40, datentyp: 'UInt32' },
]);

/**
 * „Ungueltig ist nicht 0": der GROESSTE Wert des Datentyps heisst kein Messwert
 * (Handbuch 750-495 S. 79 Tab. 27, Vertrag §4.3, V7). Massgeblich ist der Datentyp des Felds -
 * 0xFFFFFFFF in einem Int32-Feld ist −1 und damit ein Wert.
 */
const UNGUELTIG = Object.freeze({ UInt32: 4294967295, Int32: 2147483647 });

/** Die Gruende aus §5, in der Reihenfolge, in der sie geprueft werden. */
const GRUENDE = Object.freeze(['signatur_fremd', 'hauptversion_fremd', 'laenge_ungueltig',
  'wortfolge_abweichend', 'kartenzahl_abweichend', 'controller_kennung_abweichend']);
/** Die Urteile je Karte aus §5. */
const KARTEN_ERGEBNISSE = Object.freeze(['kartentyp_fremd', 'aufbau_abweichend', 'nicht_gelesen',
  'gelesen']);

const WORTFOLGEN = Object.freeze(['big', 'little']);
const FUNKTIONSCODES = Object.freeze([3, 4]);

// ---------------------------------------------------------------------------
// Zahlen
// ---------------------------------------------------------------------------

/** Zwei Woerter als 32-bit-Rohmuster, in der Wortfolge des Parameters (§2). */
function wert32(woerter, i, wortfolge) {
  const a = woerter[i] & 0xffff;
  const b = woerter[i + 1] & 0xffff;
  const [hoch, nieder] = wortfolge === 'little' ? [b, a] : [a, b];
  return hoch * 0x10000 + nieder;
}

/**
 * Aus dem Rohmuster die Zahl des Feldes - oder `null` fuer „kein Messwert".
 * Zwei Faelle sind kein Wert: ein Feld ohne belegten Datentyp und der Ungueltig-Wert des
 * Datentyps (Befund 7). Ein Int32-Feld mit 0xFFFFFFFF ist dagegen −1 und bleibt ein Wert.
 */
function deute32(roh, datentyp) {
  if (!datentyp || !Object.hasOwn(UNGUELTIG, datentyp)) return null;
  if (roh === UNGUELTIG[datentyp]) return null;
  if (datentyp === 'Int32') return roh >= 0x80000000 ? roh - 0x100000000 : roh;
  return roh;
}

// ---------------------------------------------------------------------------
// Anfragen planen
// ---------------------------------------------------------------------------

/**
 * Die Anfragen einer Lesung: hoechstens `maxWoerter` je Anfrage, und ein Karten-Block wird NIE
 * auf zwei Anfragen verteilt (§7) - sonst koennten die Haelften aus zwei verschiedenen
 * Lesesaetzen stammen. Der Kopf faehrt in der ersten Anfrage mit.
 *
 * Mit den Vertragslaengen 12 + 42 sind das genau die Zahlen der Tabelle in §7:
 * 1 Karte 1 Anfrage, 2 Karten 1, 3 Karten 2, 4 Karten 2, 5 Karten 3 - also `ceil(K / 2)`.
 *
 * `kopflaenge`/`kartenblocklaenge` sind Vorgabe, nicht Konstante: eine Nebenversion verlaengert
 * Kopf oder Block (§6), und wer sie aus einer vorigen Lesung kennt, gibt sie hier mit.
 */
function planeAnfragen(parameter) {
  const basisadresse = parameter.basisadresse;
  const kartenzahl = parameter.kartenzahl;
  const kopflaenge = parameter.kopflaenge === undefined ? KOPFLAENGE_MIN : parameter.kopflaenge;
  const blocklaenge = parameter.kartenblocklaenge === undefined
    ? KARTENBLOCKLAENGE_MIN : parameter.kartenblocklaenge;
  const max = parameter.maxWoerter === undefined ? MAX_WOERTER_JE_ANFRAGE : parameter.maxWoerter;
  if (!Number.isInteger(basisadresse) || basisadresse < 0 || basisadresse > 65535) {
    throw new Error('Basisadresse ausserhalb 0 … 65 535');
  }
  if (!Number.isInteger(kartenzahl) || kartenzahl < 0) throw new Error('Kartenzahl fehlt');
  if (kopflaenge < KOPFLAENGE_MIN || blocklaenge < KARTENBLOCKLAENGE_MIN) {
    throw new Error('Kopf- oder Kartenblocklaenge unter dem Vertrag');
  }
  if (basisadresse + kopflaenge + kartenzahl * blocklaenge > 65536) {
    throw new Error('Registerbild reicht ueber den Adressraum hinaus');
  }
  // Ein Block, der in keine Anfrage passt, waere nur mit einer Teilung lesbar - und die ist
  // verboten. Lieber hier scheitern als halbe Karten aus zwei Lesesaetzen zusammensetzen.
  if (blocklaenge > max) throw new Error('Ein Karten-Block passt in keine Anfrage');
  const anfragen = [];
  let adresse = basisadresse;
  let vorlauf = kopflaenge;
  let naechste = 0;
  while (naechste < kartenzahl || vorlauf > 0) {
    const karten = Math.min(kartenzahl - naechste, Math.floor((max - vorlauf) / blocklaenge));
    anfragen.push({ start: adresse, count: vorlauf + karten * blocklaenge,
      kopf: vorlauf > 0, karte_von: naechste, karten });
    adresse += vorlauf + karten * blocklaenge;
    naechste += karten;
    vorlauf = 0;
  }
  return anfragen;
}

/** Wie viele Anfragen eine Lesung mit `kartenzahl` Karten braucht (§7). */
function anfragenJeLesung(kartenzahl, parameter = {}) {
  return planeAnfragen(Object.assign({ basisadresse: 0 }, parameter, { kartenzahl })).length;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

function nichtLesbar(grund, kopf = null) {
  return { ergebnis: 'nicht_lesbar', grund, kopf, karten: [] };
}

function ohneKartenwerte(kopfFelder, ergebnis) {
  return Object.assign({}, kopfFelder, { ergebnis, kartenregister_32: null,
    kartenregister_35: null, statuswoerter: null, messwerte_roh: null, messwerte: null });
}

/**
 * Eine Karte (§5, zweite Liste). Der Aufbau wird gegen das Soll geprueft, BEVOR ein Wort als
 * Wert gilt: Identitaet der Karte ist (Geraet, Steckplatz) - ein Umstecken wird sichtbar und
 * nie still umgehaengt (E4).
 */
function liesKarte(woerter, start, blocklaenge, wortfolge, soll) {
  const b = (offset) => woerter[start + offset] & 0xffff;
  const kopfFelder = { steckplatz: b(KARTE.steckplatz), kartentyp: b(KARTE.kartentyp),
    variante: b(KARTE.variante), gueltigkeit: b(KARTE.gueltigkeit) };
  if (!KARTENTYPEN.includes(kopfFelder.kartentyp)) {
    return ohneKartenwerte(kopfFelder, 'kartentyp_fremd');
  }
  if (soll && (kopfFelder.steckplatz !== soll.steckplatz || kopfFelder.kartentyp !== soll.kartentyp
      || kopfFelder.variante !== (soll.variante === undefined ? 0 : soll.variante))) {
    return ohneKartenwerte(kopfFelder, 'aufbau_abweichend');
  }
  const gesetzt = (bit) => (kopfFelder.gueltigkeit & (1 << bit)) !== 0;
  // Bit 0 = 0: die ALTEN Woerter stehen weiter im Block (Karte gezogen, Klemmenbusfehler).
  // Wer nur die Woerter ansieht, merkt nichts - darum wird hier kein einziges ausgeliefert.
  if (!gesetzt(GUELTIGKEIT.karte_gelesen)) return ohneKartenwerte(kopfFelder, 'nicht_gelesen');
  const messwerteRoh = MESSWERTE.map((m) => (m.offset + 2 <= blocklaenge
    ? wert32(woerter, start + m.offset, wortfolge) : null));
  return Object.assign({}, kopfFelder, {
    ergebnis: 'gelesen',
    kartenregister_32: gesetzt(GUELTIGKEIT.kartenregister_32_gelesen)
      ? b(KARTE.kartenregister_32) : null,
    kartenregister_35: gesetzt(GUELTIGKEIT.kartenregister_35_gelesen)
      ? b(KARTE.kartenregister_35) : null,
    statuswoerter: gesetzt(GUELTIGKEIT.statuswoerter_gelesen)
      ? Array.from({ length: STATUSWOERTER }, (_, i) => b(KARTE.statuswoerter + i)) : null,
    messwerte_roh: messwerteRoh,
    messwerte: messwerteRoh.map((roh, i) => (roh === null ? null : deute32(roh, MESSWERTE[i].datentyp))),
  });
}

/**
 * Das gelesene Registerbild deuten (§5). `woerter[0]` ist das Wort an der Basisadresse.
 *
 * `parameter`: `{ basisadresse, funktionscode, wortfolge }` - Funktionscode und Wortfolge sind
 * Parameter je Anlage, kein festes `modbus_holding` (Befund 9).
 * `soll`: `{ kartenzahl, controller_kennung, karten: [{ steckplatz, kartentyp, variante }] }`
 * aus der Hardwareblatt-Fassung; fehlt ein Soll-Feld, wird es nicht geprueft.
 *
 * Jeder Grund heisst: KEIN einziger Kartenwert - lieber keine Zahl als eine falsche. Bei
 * `kartenzahl_abweichend` und `controller_kennung_abweichend` ist der Kopf selbst lesbar und
 * wird mitgegeben („4 Karten statt 3").
 */
function liesRegisterbild(woerter, { parameter = {}, soll = null } = {}) {
  if (!Array.isArray(woerter)) return nichtLesbar('laenge_ungueltig');
  const wortfolge = parameter.wortfolge === undefined ? 'big' : parameter.wortfolge;
  if (!WORTFOLGEN.includes(wortfolge)) throw new Error(`Wortfolge ${wortfolge}?`);
  const w = (i) => woerter[i] & 0xffff;
  // Die Reihenfolge aus §5 gilt, soweit die Woerter ueberhaupt da sind: Signatur und
  // Hauptversion stehen vor jeder Laengenpruefung, damit ein fremdes Registerbild als solches
  // erkannt wird und nicht als „zu kurz".
  if (woerter.length <= KOPF.signatur_2) return nichtLesbar('laenge_ungueltig');
  if (w(KOPF.signatur_1) !== SIGNATUR[0] || w(KOPF.signatur_2) !== SIGNATUR[1]) {
    return nichtLesbar('signatur_fremd');
  }
  if (woerter.length <= KOPF.hauptversion) return nichtLesbar('laenge_ungueltig');
  if (w(KOPF.hauptversion) !== HAUPTVERSION) return nichtLesbar('hauptversion_fremd');
  if (woerter.length < KOPFLAENGE_MIN) return nichtLesbar('laenge_ungueltig');
  const kopflaenge = w(KOPF.kopflaenge);
  const blocklaenge = w(KOPF.kartenblocklaenge);
  if (kopflaenge < KOPFLAENGE_MIN || blocklaenge < KARTENBLOCKLAENGE_MIN) {
    return nichtLesbar('laenge_ungueltig');
  }
  const kartenzahl = w(KOPF.kartenzahl);
  const basisadresse = parameter.basisadresse === undefined ? 0 : parameter.basisadresse;
  if (woerter.length < kopflaenge + kartenzahl * blocklaenge
      || basisadresse + kopflaenge + kartenzahl * blocklaenge > 65536) {
    return nichtLesbar('laenge_ungueltig');
  }
  if (wert32(woerter, KOPF.wortfolge_pruefwert, wortfolge) !== WORTFOLGE_PRUEFWERT) {
    return nichtLesbar('wortfolge_abweichend');
  }
  const kopf = { hauptversion: w(KOPF.hauptversion), nebenversion: w(KOPF.nebenversion),
    kopflaenge, kartenblocklaenge: blocklaenge, kartenzahl, herzschlag: w(KOPF.herzschlag),
    controller_kennung: wert32(woerter, KOPF.controller_kennung, wortfolge) };
  if (soll && soll.kartenzahl !== undefined && kartenzahl !== soll.kartenzahl) {
    return nichtLesbar('kartenzahl_abweichend', kopf);
  }
  // Die Controller-Kennung ist KEIN Identitaetsbeweis: sie zeigt nur, ob unter der Adresse die
  // Steuerung antwortet, die das Hardwareblatt erwartet. Das Geraet bleibt ueber die
  // Seriennummer vom Typenschild identifiziert (§3, Konzept §6.2).
  if (soll && soll.controller_kennung !== undefined
      && kopf.controller_kennung !== soll.controller_kennung) {
    return nichtLesbar('controller_kennung_abweichend', kopf);
  }
  const sollKarten = (soll && soll.karten) || [];
  const karten = [];
  for (let n = 0; n < kartenzahl; n++) {
    // Karte n beginnt bei Kopflaenge + n · Kartenblocklaenge - immer mit den Laengen AUS DEM
    // KOPF, nie mit 12 und 42 als Konstanten (§4).
    karten.push(liesKarte(woerter, kopflaenge + n * blocklaenge, blocklaenge, wortfolge,
      sollKarten[n] || null));
  }
  return { ergebnis: 'erkannt', grund: null, kopf, karten };
}

/**
 * Wie sich die Herzschlag-Zahl zur vorigen Lesung verhaelt - eine Beobachtung, keine Regel.
 * Qualitaet `stale` nach drei stehenden Lesungen (IP-7) und das Neustart-Ereignis (IP-8)
 * entstehen aus dieser Folge, nicht hier.
 *
 * `ueberlauf`: kleiner, aber der Abstand ueber 65 536 hinweg bleibt unter `schrittgrenze`.
 * `rueckwaerts`: sonst - dann ist das Programm neu angelaufen.
 */
function herzschlagUrteil(vorher, jetzt, schrittgrenze = 120) {
  if (!Number.isInteger(vorher)) return 'erste_lesung';
  if (jetzt === vorher) return 'steht';
  if (jetzt > vorher) return 'laeuft';
  return (jetzt + 0x10000 - vorher) <= schrittgrenze ? 'ueberlauf' : 'rueckwaerts';
}

// ---------------------------------------------------------------------------
// Punkte und Pollgruppen
// ---------------------------------------------------------------------------

const PUNKT_MUSTER = /^wago\.(pm494|pm495)\.karte\[(\d+|\*)]\./;

/** Traegt dieser Katalogpunkt die Quellenart des Registerbilds? */
function istRegisterbildPunkt(point) {
  return !!point && point.source_kind === 'wago_registerbild';
}

/** Der Karten-Index aus einem Punktschluessel - `null` bei der Vorlage `karte[*]`. */
function karteIndexAus(pointKey) {
  const treffer = String(pointKey).match(PUNKT_MUSTER);
  if (!treffer || treffer[2] === '*') return null;
  return Number(treffer[2]);
}

/**
 * EINE Pollgruppe je Steuerung. Der Schluessel nennt die Steuerung (das Ziel) und den Takt,
 * aber ABSICHTLICH nicht die Familie: eine Steuerung kann eine 750-494 und eine 750-495
 * nebeneinander tragen, und beide stehen im selben Registerbild. Waere die Familie Teil des
 * Schluessels, wuerde dieselbe Registerstrecke zweimal gelesen.
 */
function pollGruppe(targetKey, cadenceS) {
  return `${targetKey}:wago:registerbild:${cadenceS}`;
}

module.exports = {
  SIGNATUR, HAUPTVERSION, KOPFLAENGE_MIN, KARTENBLOCKLAENGE_MIN, WORTFOLGE_PRUEFWERT,
  KARTENTYPEN, MAX_WOERTER_JE_ANFRAGE, KOPF, KARTE, STATUSWOERTER, GUELTIGKEIT, MESSWERTE,
  UNGUELTIG, GRUENDE, KARTEN_ERGEBNISSE, WORTFOLGEN, FUNKTIONSCODES,
  wert32, deute32, planeAnfragen, anfragenJeLesung, liesRegisterbild, liesKarte,
  herzschlagUrteil, istRegisterbildPunkt, karteIndexAus, pollGruppe,
};
