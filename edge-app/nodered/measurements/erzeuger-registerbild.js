'use strict';

/**
 * Lese-Familie `erzeuger_registerbild` (Konzept „Erzeuger am WAGO-Modbus-Server", Paket EZ-5,
 * Entscheide EW-4 A, EW-5 A, EW-17 A).
 *
 * Liest das „VoltPilot-Registerbild Erzeuger" in der schlanken Fassung 1.0 von der Steuerung
 * einer Erzeugeranlage (PV-Wechselrichter, BHKW-Motoren): ein Bild mit festen Abschnitten und
 * einem Block je Einheit, Eingangsregister ab Basisadresse 0 (EW-1 A, EW-2 A). Gebaut nach dem
 * Muster von `wago-registerbild.js` - Kopfpruefung, Ungueltig = Typ-Maximum, Anfragen
 * hoechstens 120 Woerter, ein Block nie geteilt -, aber ein EIGENES Bild mit eigener Signatur.
 *
 * Aufbau (Quelle `register-vorlage-schlank.json`, mit dem Abgleich aus EZ-1):
 *
 *     Kopf 0-11 · Anlage 12-21 · Netzbetreiber 22-27 · Direktvermarkter 28-33 · Wirkung 34-37
 *     je Einheit 10 Woerter ab 38 (Einheit n beginnt bei 38 + (n-1)·10), hoechstens 10 Einheiten
 *     Namen ab `beschreibung_ab`: Netzbetreiber +0, Direktvermarkter +16, Typ der Einheit n
 *     +32 + (n-1)·16, je 16 Woerter = 32 Zeichen ISO 8859-1, hoeherwertiges Byte zuerst
 *
 * Dieses Modul ist der LESER: es deutet Woerter und sagt je Feld, ob es ein Wert ist. Was daraus
 * an Qualitaet (`stale`, `uncertain`) und Ereignis wird, entscheidet `erzeuger-ereignisse.js`;
 * wann ein Wert gesendet wird, `erzeuger-meldung.js`.
 *
 * ⚠ Nur lesen. Die Werte gehen weder in die Energiebilanz der Box noch in Sonnenstrom-Logik oder
 * Steuerung (V1, Konzept §4.2) - ein BHKW-Motor ist nie Sonnenstrom.
 */

// ---------------------------------------------------------------------------
// Festlegungen des Bilds. Sie sagen nichts ueber Hardware, nur wie Steuerung und Box sich
// verstaendigen. `erzeuger-registerbild.test.js` prueft sie gegen die Vorlage.
// ---------------------------------------------------------------------------

/** 0x5650 „VP", 0x455A „EZ" - zwei einzelne Woerter, von der Wortfolge unberuehrt. */
const SIGNATUR = Object.freeze([0x5650, 0x455a]);
/** Version 0x0100: hoeherwertiges Byte = Hauptversion, niederwertiges = Nebenversion. */
const HAUPTVERSION = 1;
/** Mit dem Parameter Wortfolge gelesen 0x01020304 - sonst ist die Wortfolge falsch. */
const WORTFOLGE_PRUEFWERT = 0x01020304;
const KOPFLAENGE = 12;
/** Kopf + Anlage + Netzbetreiber + Direktvermarkter + Wirkung. */
const FESTER_TEIL = 38;
const EINHEIT_LAENGE = 10;
const MAX_EINHEITEN = 10;
/** Ein Name: 16 Woerter = 32 Zeichen. */
const NAME_WOERTER = 16;
/** Hoechstens 120 Woerter je Anfrage: `docs/contracts/v2/measurement-budget-vectors.json`. */
const MAX_WOERTER_JE_ANFRAGE = 120;
/** Der Takt der Familie (EW-5 A): die Box liest das Bild alle 5 s. */
const LESETAKT_S = 5;
/** Die Familie im Messpunkt-Katalog und die Quellenart ihrer Punkte. */
const FAMILIE = 'voltpilot.erzeuger_registerbild_v1';
const QUELLENART = 'erzeuger_registerbild';

/** Offsets im Kopf, ab der Basisadresse. */
const KOPF = Object.freeze({
  signatur_1: 0, signatur_2: 1, wortfolge: 2, version: 4, te_anzahl: 5, herzschlag: 6,
  programmstand: 7, steuerung_id: 8, anlagenart: 10, beschreibung_ab: 11,
});

/** „Ungueltig ist nicht 0": der groesste Wert des Datentyps heisst kein Wert. */
const UNGUELTIG = Object.freeze({ U16: 0xffff, S16: 0x7fff, U32: 0xffffffff, S32: 0x7fffffff });

/** Die Aufzaehlungen des Bilds. Ein Wert ausserhalb ist kein Wert (EZ-1 Lesart 6). */
const AUFZAEHLUNGEN = Object.freeze({
  anlagenart: Object.freeze([1, 2, 3]),
  zustand: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  n_kanal: Object.freeze([0, 1, 2, 3]),
  d_kanal: Object.freeze([0, 1, 2]),
  quelle_p: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  t_art: Object.freeze([1, 2]),
});

/**
 * Die Felder des laufenden Bilds hinter dem Kopf.
 *
 * - `offset`: ab der Basisadresse (Anlage, Netzbetreiber, Direktvermarkter, Wirkung) bzw. ab
 *   dem Anfang des Einheiten-Blocks (`einheit: true`).
 * - Der Messpunkt ist der Feldname (`erzeuger.<abschnitt>.<feld>`, je Einheit `erzeuger.te[<n>].<feld>`,
 *   n = TE-Nr. ab 1) - dieselben Schluessel wie die Katalogfamilie aus EZ-6.
 * - `art`: `zahl` · `zustand` (Aufzaehlung) · `bitfeld`; `masseinheit` und `faktor` deuten die Zahl.
 * - `klasse`: wann gemeldet wird (`erzeuger-meldung.js`): `schnell` mit `totband`, `zustand` bei
 *   jeder Aenderung, `zaehler` im Takt der Auswahl.
 * - `gueltig`: welches Bit welches Felds diesen Wert deckt (EZ-1 Lesart 5). Bit 0 heisst
 *   „unbekannt", nie 0.
 * - `ueberlauf`: der Zaehler laeuft von 65 535 auf 0 - 0xFFFF ist hier ein Wert (EZ-1 A2).
 */
const FELDER = Object.freeze([
  // Der Kopf traegt vier Messpunkte; Signatur, Pruefwert, Version, Herzschlag und `beschreibung_ab`
  // prueft die Box selbst (Katalog EZ-6).
  { abschnitt: 'kopf', feld: 'te_anzahl', offset: 5, typ: 'U16', art: 'zahl', klasse: 'zustand' },
  { abschnitt: 'kopf', feld: 'programmstand', offset: 7, typ: 'U16', art: 'zahl', klasse: 'zustand' },
  { abschnitt: 'kopf', feld: 'steuerung_id', offset: 8, typ: 'U32', art: 'zahl', klasse: 'zustand' },
  { abschnitt: 'kopf', feld: 'anlagenart', offset: 10, typ: 'U16', art: 'zustand', aufzaehlung: 'anlagenart', klasse: 'zustand' },
  { abschnitt: 'a', feld: 'a_gueltig', offset: 12, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { abschnitt: 'a', feld: 'a_alter_s', offset: 13, typ: 'U16', art: 'zahl', masseinheit: 's', klasse: 'schnell', totband: 5 },
  { abschnitt: 'a', feld: 'p_nvp_w', offset: 14, typ: 'S32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 'a_gueltig', bit: 0 } },
  { abschnitt: 'a', feld: 'p_erzeugung_w', offset: 16, typ: 'S32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 'a_gueltig', bit: 3 } },
  { abschnitt: 'a', feld: 'anlage_zustand', offset: 18, typ: 'U16', art: 'zustand', aufzaehlung: 'zustand', klasse: 'zustand' },
  { abschnitt: 'a', feld: 'a_bits', offset: 19, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { abschnitt: 'a', feld: 'speicher_fuellstand', offset: 20, typ: 'U16', art: 'zahl', masseinheit: '%', faktor: 0.1, klasse: 'schnell', totband: 0.5, gueltig: { feld: 'a_gueltig', bit: 4 } },
  { abschnitt: 'a', feld: 'p_installiert_kw', offset: 21, typ: 'U16', art: 'zahl', masseinheit: 'kW', klasse: 'zustand' },
  { abschnitt: 'nb', feld: 'n_kanal', offset: 22, typ: 'U16', art: 'zustand', aufzaehlung: 'n_kanal', klasse: 'zustand' },
  { abschnitt: 'nb', feld: 'n_bits', offset: 23, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { abschnitt: 'nb', feld: 'n_p_prozent', offset: 24, typ: 'U16', art: 'zahl', masseinheit: '%', faktor: 0.1, klasse: 'schnell', totband: 0, gueltig: { feld: 'n_bits', bit: 0 } },
  { abschnitt: 'nb', feld: 'n_cosphi', offset: 25, typ: 'S16', art: 'zahl', faktor: 0.001, klasse: 'schnell', totband: 0, gueltig: { feld: 'n_bits', bit: 0 } },
  { abschnitt: 'nb', feld: 'n_seit_s', offset: 26, typ: 'U16', art: 'zahl', masseinheit: 's', klasse: 'zaehler' },
  { abschnitt: 'nb', feld: 'n_zaehler', offset: 27, typ: 'U16', art: 'zahl', klasse: 'zaehler', ueberlauf: true },
  { abschnitt: 'dv', feld: 'd_kanal', offset: 28, typ: 'U16', art: 'zustand', aufzaehlung: 'd_kanal', klasse: 'zustand' },
  { abschnitt: 'dv', feld: 'd_bits', offset: 29, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { abschnitt: 'dv', feld: 'd_soll_w', offset: 30, typ: 'U32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 'd_bits', bit: 0 } },
  { abschnitt: 'dv', feld: 'd_seit_s', offset: 32, typ: 'U16', art: 'zahl', masseinheit: 's', klasse: 'zaehler', gueltig: { feld: 'd_bits', bit: 0 } },
  { abschnitt: 'dv', feld: 'd_zaehler', offset: 33, typ: 'U16', art: 'zahl', klasse: 'zaehler', ueberlauf: true, gueltig: { feld: 'd_bits', bit: 0 } },
  { abschnitt: 'wirkung', feld: 'quelle_p', offset: 34, typ: 'U16', art: 'zustand', aufzaehlung: 'quelle_p', klasse: 'zustand', gueltig: { feld: 's_bits', bit: 0 } },
  { abschnitt: 'wirkung', feld: 's_bits', offset: 35, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { abschnitt: 'wirkung', feld: 'p_grenze_w', offset: 36, typ: 'U32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 's_bits', bit: 0 } },
  { einheit: true, feld: 't_zustand', offset: 0, typ: 'U16', art: 'zustand', aufzaehlung: 'zustand', klasse: 'zustand', gueltig: { feld: 't_bits', bit: 0 } },
  { einheit: true, feld: 't_bits', offset: 1, typ: 'U16', art: 'bitfeld', klasse: 'zustand' },
  { einheit: true, feld: 't_art', offset: 2, typ: 'U16', art: 'zustand', aufzaehlung: 't_art', klasse: 'zustand' },
  { einheit: true, feld: 't_nenn_kw', offset: 3, typ: 'U16', art: 'zahl', masseinheit: 'kW', klasse: 'zustand' },
  { einheit: true, feld: 't_p_ist_w', offset: 4, typ: 'S32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 't_bits', bit: 0 } },
  { einheit: true, feld: 't_p_soll_w', offset: 6, typ: 'U32', art: 'zahl', masseinheit: 'W', klasse: 'schnell', totband: 500, gueltig: { feld: 't_bits', bit: 1 } },
  { einheit: true, feld: 't_e', offset: 8, typ: 'U32', art: 'zahl', masseinheit: 'kWh', faktor: 0.1, klasse: 'zaehler', gueltig: { feld: 't_bits', bit: 0 } },
].map(Object.freeze));

/** Die Namen, relativ zu `beschreibung_ab` (EZ-1 Lesart 1). */
const NAMEN = Object.freeze([
  Object.freeze({ feld: 'netzbetreiber_name', offset: 0 }),
  Object.freeze({ feld: 'direktvermarkter_name', offset: 16 }),
]);
/** Der Typname der Einheit n steht bei `beschreibung_ab` + 32 + (n-1)·16. */
const TYP_NAME = Object.freeze({ feld: 't_typ_name', offset: 32 });

/** Die Gruende, in der Reihenfolge, in der sie geprueft werden (EZ-1 Lesart 4, dann das Soll). */
const GRUENDE = Object.freeze(['zu_wenig_woerter', 'signatur_fremd', 'version_fremd',
  'wortfolge_falsch', 'te_anzahl_ungueltig', 'te_anzahl_abweichend',
  'steuerung_id_abweichend', 'anlagenart_abweichend']);

/**
 * Die Gruende, die nur mit dem SOLL entstehen. Das Bild selbst ist dann lesbar - sein Herzschlag
 * ist eine Beobachtung -, es passt nur nicht zur eingerichteten Anlage.
 */
const SOLL_GRUENDE = Object.freeze(['te_anzahl_abweichend', 'steuerung_id_abweichend',
  'anlagenart_abweichend']);

const WORTFOLGEN = Object.freeze(['big', 'little']);
const FUNKTIONSCODES = Object.freeze([3, 4]);

// ---------------------------------------------------------------------------
// Zahlen
// ---------------------------------------------------------------------------

/** Zwei Woerter als 32-bit-Rohmuster, in der Wortfolge des Parameters. */
function wert32(woerter, i, wortfolge) {
  const a = woerter[i] & 0xffff;
  const b = woerter[i + 1] & 0xffff;
  const [hoch, nieder] = wortfolge === 'little' ? [b, a] : [a, b];
  return hoch * 0x10000 + nieder;
}

/** Das Rohmuster eines Felds (16 oder 32 bit, ohne Vorzeichen). */
function rohVon(woerter, i, typ, wortfolge) {
  return typ === 'U32' || typ === 'S32' ? wert32(woerter, i, wortfolge) : woerter[i] & 0xffff;
}

/** Das Rohmuster als Ganzzahl des Datentyps. */
function mitVorzeichen(roh, typ) {
  if (typ === 'S16') return roh >= 0x8000 ? roh - 0x10000 : roh;
  if (typ === 'S32') return roh >= 0x80000000 ? roh - 0x100000000 : roh;
  return roh;
}

/** Ein ISO-8859-1-Name aus 16 Woertern, hoeherwertiges Byte zuerst, endet am ersten 0-Byte. */
function liesName(woerter, start = 0) {
  let text = '';
  for (let i = 0; i < NAME_WOERTER; i++) {
    const w = woerter[start + i];
    if (!Number.isInteger(w)) return null;
    for (const byte of [(w >> 8) & 0xff, w & 0xff]) {
      if (byte === 0) return text === '' ? null : text;
      text += String.fromCharCode(byte);
    }
  }
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Anfragen planen
// ---------------------------------------------------------------------------

/** Woerter des laufenden Bilds bei `n` Einheiten: 38 + 10·n. */
function laengeBild(teAnzahl) { return FESTER_TEIL + teAnzahl * EINHEIT_LAENGE; }

function pruefeBasis(basisadresse) {
  if (!Number.isInteger(basisadresse) || basisadresse < 0 || basisadresse > 65535) {
    throw new Error('Basisadresse ausserhalb 0 … 65 535');
  }
}

/**
 * Die Anfragen des laufenden Bilds (Kopf bis letzte Einheit): hoechstens `maxWoerter` je
 * Anfrage, und ein Einheiten-Block wird NIE geteilt - sonst koennten seine Haelften aus zwei
 * Lesesaetzen stammen. Bis 8 Einheiten eine Anfrage (38 + 80 = 118 Woerter), ab 9 zwei
 * (EZ-1 A1): Anfrage 1 Kopf bis Einheit 8, Anfrage 2 Einheit 9 und 10.
 */
function planeAnfragen({ basisadresse, teAnzahl, maxWoerter = MAX_WOERTER_JE_ANFRAGE }) {
  pruefeBasis(basisadresse);
  if (!Number.isInteger(teAnzahl) || teAnzahl < 1 || teAnzahl > MAX_EINHEITEN) {
    throw new Error('Zahl der Einheiten ausserhalb 1 … 10');
  }
  if (basisadresse + laengeBild(teAnzahl) > 65536) {
    throw new Error('Registerbild reicht ueber den Adressraum hinaus');
  }
  if (FESTER_TEIL > maxWoerter) throw new Error('Der feste Teil passt in keine Anfrage');
  const anfragen = [];
  let adresse = basisadresse;
  let vorlauf = FESTER_TEIL;
  let naechste = 0;
  while (naechste < teAnzahl || vorlauf > 0) {
    const einheiten = Math.min(teAnzahl - naechste, Math.floor((maxWoerter - vorlauf) / EINHEIT_LAENGE));
    anfragen.push({ start: adresse, count: vorlauf + einheiten * EINHEIT_LAENGE,
      kopf: vorlauf > 0, einheit_von: naechste + 1, einheiten });
    adresse += vorlauf + einheiten * EINHEIT_LAENGE;
    naechste += einheiten;
    vorlauf = 0;
  }
  return anfragen;
}

/**
 * Wo die Namen stehen - oder `null`, wenn das Bild keine traegt. `beschreibung_ab` 0 oder
 * 0xFFFF heisst „keine Namen"; ein Bereich, der in die laufenden Woerter ragt oder ueber den
 * Adressraum hinaus, ebenso - das Bild selbst bleibt lesbar (EZ-1 Lesart 1).
 */
function namensBereich(kopf, basisadresse = 0) {
  if (!kopf || !Number.isInteger(kopf.beschreibung_ab)) return null;
  const ab = kopf.beschreibung_ab;
  if (ab === 0 || ab === 0xffff || ab < laengeBild(kopf.te_anzahl)) return null;
  const count = 2 * NAME_WOERTER + kopf.te_anzahl * NAME_WOERTER;
  if (basisadresse + ab + count > 65536) return null;
  return { start: basisadresse + ab, count };
}

/** Die Anfragen der Namen: hoechstens sieben Namen (112 Woerter) je Anfrage, nie geteilt. */
function planeNamen(bereich, maxWoerter = MAX_WOERTER_JE_ANFRAGE) {
  if (!bereich) return [];
  const jeAnfrage = Math.floor(maxWoerter / NAME_WOERTER) * NAME_WOERTER;
  const anfragen = [];
  for (let start = 0; start < bereich.count; start += jeAnfrage) {
    anfragen.push({ start: bereich.start + start, count: Math.min(jeAnfrage, bereich.count - start) });
  }
  return anfragen;
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

function nichtLesbar(grund, kopf = null) {
  return { ergebnis: 'nicht_lesbar', grund, kopf, werte: [] };
}

/**
 * Der Kopf in der Reihenfolge von EZ-1 Lesart 4: Signatur (vor der Wortfolge) → Hauptversion →
 * Pruefwert → Zahl der Einheiten. Gibt `{ grund, kopf }` zurueck; `kopf` traegt nur, was diese
 * Pruefung schon sicher weiss - bei fremder Signatur nichts, bei fremder Hauptversion nur die
 * Version (in einem Bild der Fassung 2 bedeuten die Woerter dahinter etwas anderes).
 */
function liesKopf(woerter, wortfolge = 'big') {
  if (!Array.isArray(woerter) || woerter.length < KOPFLAENGE) {
    return { grund: 'zu_wenig_woerter', kopf: null };
  }
  const w = (i) => woerter[i] & 0xffff;
  if (w(KOPF.signatur_1) !== SIGNATUR[0] || w(KOPF.signatur_2) !== SIGNATUR[1]) {
    return { grund: 'signatur_fremd', kopf: null };
  }
  const version = w(KOPF.version);
  const hauptversion = version >> 8;
  const nebenversion = version & 0xff;
  if (hauptversion !== HAUPTVERSION) {
    return { grund: 'version_fremd', kopf: { hauptversion, nebenversion } };
  }
  if (wert32(woerter, KOPF.wortfolge, wortfolge) !== WORTFOLGE_PRUEFWERT) {
    return { grund: 'wortfolge_falsch', kopf: { hauptversion, nebenversion } };
  }
  // Die Kopf-Werte folgen derselben Regel wie jeder Wert: das Typ-Maximum ist kein Wert, eine
  // Anlagenart ausserhalb des Vokabulars auch (`null`). Der Herzschlag laeuft ueber 0xFFFF
  // hinweg und kennt keinen Ungueltig-Wert (EZ-1 A2); `beschreibung_ab` 0xFFFF heisst
  // „keine Namen" und bleibt roh.
  const programmstand = w(KOPF.programmstand);
  const steuerungId = wert32(woerter, KOPF.steuerung_id, wortfolge);
  const anlagenart = w(KOPF.anlagenart);
  const kopf = {
    hauptversion, nebenversion,
    te_anzahl: w(KOPF.te_anzahl),
    herzschlag: w(KOPF.herzschlag),
    programmstand: programmstand === UNGUELTIG.U16 ? null : programmstand,
    steuerung_id: steuerungId === UNGUELTIG.U32 ? null : steuerungId,
    anlagenart: AUFZAEHLUNGEN.anlagenart.includes(anlagenart) ? anlagenart : null,
    beschreibung_ab: w(KOPF.beschreibung_ab),
  };
  if (kopf.te_anzahl < 1 || kopf.te_anzahl > MAX_EINHEITEN) {
    return { grund: 'te_anzahl_ungueltig', kopf };
  }
  return { grund: null, kopf };
}

/** Ein Feld deuten: `{ wert, roh, grund }`. `wert: null` heisst kein Wert, mit Grund. */
function deuteFeld(feld, woerter, start, wortfolge, bits) {
  const roh = rohVon(woerter, start + feld.offset, feld.typ, wortfolge);
  // Reihenfolge des Vertrags: erst das deckende Bit, dann das Typ-Maximum, dann das Vokabular.
  if (feld.gueltig) {
    const deckend = bits[feld.gueltig.feld];
    // Ein deckendes Bitfeld, das selbst ungueltig ist, sagt nichts - dann ist auch der Wert
    // unbekannt, nie geraten.
    if (!Number.isInteger(deckend) || (deckend & (1 << feld.gueltig.bit)) === 0) {
      return { wert: null, roh, grund: 'gueltigkeit' };
    }
  }
  if (!feld.ueberlauf && roh === UNGUELTIG[feld.typ]) return { wert: null, roh, grund: 'ungueltig' };
  const zahl = mitVorzeichen(roh, feld.typ);
  if (feld.aufzaehlung && !AUFZAEHLUNGEN[feld.aufzaehlung].includes(zahl)) {
    // Ausserhalb des Vokabulars ist kein Wert - der Rohwert reist mit (EZ-1 Lesart 6).
    return { wert: null, roh: zahl, grund: 'fremd' };
  }
  const wert = feld.faktor ? Math.round(zahl * feld.faktor * 1e6) / 1e6 : zahl;
  return { wert, roh: zahl, grund: null };
}

/** Die Bitfelder eines Abschnitts, die andere Felder decken (`null` = ungueltig). */
function bitfelder(felder, woerter, start, wortfolge) {
  const out = {};
  for (const feld of felder) {
    if (feld.art !== 'bitfeld') continue;
    const roh = rohVon(woerter, start + feld.offset, feld.typ, wortfolge);
    out[feld.feld] = roh === UNGUELTIG[feld.typ] ? null : roh;
  }
  return out;
}

/** Der Messpunkt eines Felds. Einheiten zaehlen ab 1 (`erzeuger.te[1].…`, Katalog EZ-6). */
function punktVon(feld, einheit = null) {
  return feld.einheit ? `erzeuger.te[${einheit}].${feld.feld}` : `erzeuger.${feld.abschnitt}.${feld.feld}`;
}

/**
 * Das gelesene Bild deuten. `woerter[0]` ist das Wort an der Basisadresse, es muessen alle
 * 38 + 10·n Woerter des laufenden Bilds da sein (n aus dem Kopf).
 *
 * `parameter`: `{ wortfolge }` (Vorgabe `big`).
 * `soll`: `{ te_anzahl, steuerung_id?, anlagenart? }` - fehlt ein Feld, wird es nicht geprueft.
 *
 * Jeder Grund heisst: KEIN einziger Wert - lieber keine Zahl als eine falsche. Bei den
 * Soll-Gruenden ist der Kopf lesbar und reist mit („3 Einheiten statt 2").
 *
 * Rueckgabe bei `erkannt`: `{ kopf, werte: [{ punkt, feld, abschnitt, einheit, wert, roh,
 * grund, art, klasse, totband }] }` - je Feld genau ein Eintrag, auch ohne Wert.
 */
function liesErzeugerbild(woerter, { parameter = {}, soll = null } = {}) {
  const wortfolge = parameter.wortfolge === undefined ? 'big' : parameter.wortfolge;
  if (!WORTFOLGEN.includes(wortfolge)) throw new Error(`Wortfolge ${wortfolge}?`);
  const { grund, kopf } = liesKopf(woerter, wortfolge);
  // Bei fremder Version oder falscher Wortfolge ist der Kopf kein Kopf dieses Bilds - der Leser
  // gibt ihn nicht heraus (die Probe nennt die Version eigens, `kopfBericht`). Bei der Zahl der
  // Einheiten und zu wenigen Woertern ist er lesbar und reist mit („3 statt 2 Einheiten").
  if (grund) return nichtLesbar(grund, grund === 'te_anzahl_ungueltig' ? kopf : null);
  if (woerter.length < laengeBild(kopf.te_anzahl)) return nichtLesbar('zu_wenig_woerter', kopf);
  if (soll && Number.isInteger(soll.te_anzahl) && kopf.te_anzahl !== soll.te_anzahl) {
    // Eine Einheit kam dazu oder fiel weg: die Nummern werden nie still umgehaengt
    // (Konzept §3.9) - das Portal fragt einmal nach.
    return nichtLesbar('te_anzahl_abweichend', kopf);
  }
  if (soll && Number.isInteger(soll.steuerung_id) && kopf.steuerung_id !== soll.steuerung_id) {
    return nichtLesbar('steuerung_id_abweichend', kopf);
  }
  if (soll && Number.isInteger(soll.anlagenart) && kopf.anlagenart !== soll.anlagenart) {
    return nichtLesbar('anlagenart_abweichend', kopf);
  }
  const anlage = FELDER.filter((f) => !f.einheit);
  const einheit = FELDER.filter((f) => f.einheit);
  const werte = [];
  const eintrag = (feld, n, gedeutet) => werte.push({ punkt: punktVon(feld, n), feld: feld.feld,
    abschnitt: feld.einheit ? `te${n}` : feld.abschnitt, einheit: feld.einheit ? n : null,
    art: feld.art, klasse: feld.klasse, totband: feld.totband === undefined ? null : feld.totband,
    ...gedeutet });
  const bitsAnlage = bitfelder(anlage, woerter, 0, wortfolge);
  for (const feld of anlage) eintrag(feld, null, deuteFeld(feld, woerter, 0, wortfolge, bitsAnlage));
  for (let n = 1; n <= kopf.te_anzahl; n++) {
    // Einheit n beginnt bei 38 + (n-1)·10 - mit der Zahl AUS DEM KOPF, nie aus dem Soll.
    const start = FESTER_TEIL + (n - 1) * EINHEIT_LAENGE;
    const bits = bitfelder(einheit, woerter, start, wortfolge);
    for (const feld of einheit) eintrag(feld, n, deuteFeld(feld, woerter, start, wortfolge, bits));
  }
  return { ergebnis: 'erkannt', grund: null, kopf, werte };
}

/**
 * Die Namen deuten. `woerter[0]` ist das Wort bei Basis + `beschreibung_ab`. Rueckgabe je Name
 * `{ feld, einheit, wert }`; `wert: null` heisst „keiner" bzw. nicht gelesen. Namen sind keine
 * Messpunkte (Katalog EZ-6): sie reisen mit der Probe `erzeuger_kopf` in den Anlege-Schritt.
 */
function liesNamen(woerter, teAnzahl) {
  const raus = NAMEN.map((n) => ({ feld: n.feld,
    einheit: null, wert: Array.isArray(woerter) ? liesName(woerter, n.offset) : null }));
  for (let e = 1; e <= teAnzahl; e++) {
    raus.push({ feld: TYP_NAME.feld, einheit: e,
      wert: Array.isArray(woerter) ? liesName(woerter, TYP_NAME.offset + (e - 1) * NAME_WOERTER) : null });
  }
  return raus;
}

/**
 * Der Kopf-Bericht der Probe-Art `erzeuger_kopf` (`docs/contracts/mqtt-probe.schema.json`) fuer
 * den Anlege-Schritt „Steuerung verbinden": Kopf, je Einheit Art und Nennleistung und - wenn das
 * Bild sie traegt - die Namen. Kein Messwert.
 *
 * `kopf`: die 12 Kopfwoerter ab der Basisadresse.
 * `einheiten`: die Woerter ab Basis + 38 (10 je Einheit) - `null`, wenn ihre Lesung scheiterte.
 * `namen`: die Woerter ab Basis + `beschreibung_ab` - `null`, wenn nicht gelesen.
 *
 * Luecke statt Null: ein Feld, das diese Lesung nicht ergeben hat, FEHLT. Bei fremder Signatur
 * steht nur `signatur_ok: false` da; bei fremder Hauptversion nur die Version. Ein gelesener,
 * leerer Name ist `""` („keiner"), ein nicht gelesener fehlt.
 */
function kopfBericht(kopfWoerter, { wortfolge = 'big', einheiten = null, namen = null } = {}) {
  const { grund, kopf } = liesKopf(kopfWoerter, wortfolge);
  if (grund === 'zu_wenig_woerter' || grund === 'signatur_fremd') {
    return { signatur_ok: false, erkannt: false, grund };
  }
  const versionen = { hauptversion: kopf.hauptversion, nebenversion: kopf.nebenversion };
  if (grund === 'te_anzahl_ungueltig') {
    return Object.assign({ signatur_ok: true, erkannt: false, grund }, versionen,
      { te_anzahl: kopf.te_anzahl });
  }
  if (grund) return Object.assign({ signatur_ok: true, erkannt: false, grund }, versionen);
  const laenge = kopf.te_anzahl * EINHEIT_LAENGE;
  if (!Array.isArray(einheiten) || einheiten.length < laenge) {
    // Der Kopf nennt mehr Einheiten, als die Steuerung Register hat: das Bild ist nicht ganz.
    return Object.assign({ signatur_ok: true, erkannt: false, grund: 'zu_wenig_woerter' }, versionen,
      { te_anzahl: kopf.te_anzahl });
  }
  const bereich = namensBereich(kopf);
  const namenDa = !!bereich && Array.isArray(namen) && namen.length >= bereich.count;
  const text = (start) => { const n = liesName(namen, start); return n === null ? '' : n; };
  const art = FELDER.find((f) => f.feld === 't_art');
  const nenn = FELDER.find((f) => f.feld === 't_nenn_kw');
  const liste = [];
  for (let n = 1; n <= kopf.te_anzahl; n++) {
    const start = (n - 1) * EINHEIT_LAENGE;
    const a = einheiten[start + art.offset] & 0xffff;
    const k = einheiten[start + nenn.offset] & 0xffff;
    liste.push(Object.assign({ einheit: n },
      AUFZAEHLUNGEN.t_art.includes(a) ? { art: a } : {},
      k !== UNGUELTIG.U16 ? { nenn_kw: k } : {},
      namenDa ? { typ_name: text(TYP_NAME.offset + (n - 1) * NAME_WOERTER) } : {}));
  }
  // Ein Kopf-Feld ohne Wert FEHLT im Bericht - nie eine null, die wie eine Angabe aussieht.
  const daVon = (felder) => Object.fromEntries(Object.entries(felder).filter(([, v]) => v !== null));
  return Object.assign({ signatur_ok: true, erkannt: true }, versionen, daVon({
    te_anzahl: kopf.te_anzahl, herzschlag: kopf.herzschlag, programmstand: kopf.programmstand,
    steuerung_id: kopf.steuerung_id, anlagenart: kopf.anlagenart,
    beschreibung_ab: kopf.beschreibung_ab }), { einheiten: liste,
  }, namenDa ? { netzbetreiber_name: text(NAMEN[0].offset),
    direktvermarkter_name: text(NAMEN[1].offset) } : {});
}

/** Wie der Kopf-Bericht seine Woerter liest: Kopf, Einheiten, Namen - nie ein Block geteilt. */
function kopfPlan(basisadresse, kopf = null) {
  pruefeBasis(basisadresse);
  if (!kopf) return [{ teil: 'kopf', start: basisadresse, count: KOPFLAENGE }];
  const einheiten = { teil: 'einheiten', start: basisadresse + FESTER_TEIL,
    count: kopf.te_anzahl * EINHEIT_LAENGE };
  const bereich = namensBereich(kopf, basisadresse);
  return [einheiten].concat(planeNamen(bereich).map((a) => Object.assign({ teil: 'namen' }, a)));
}

/**
 * Wie sich die Herzschlag-Zahl zur vorigen Lesung verhaelt - dieselbe Beobachtung wie beim
 * WAGO-Bild. `ueberlauf` (65 535 → 0 mit kleinem Abstand) ist kein Neustart (EZ-1 A2).
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

const PUNKT_MUSTER = /^erzeuger\.(?:(kopf|a|nb|dv|wirkung)|te\[(\d+|\*)])\.([a-z0-9_]+)$/;

/** Traegt dieser Katalogpunkt das Erzeuger-Bild? Quellenart oder Familie genuegt. */
function istErzeugerPunkt(point) {
  return !!point && (point.source_kind === QUELLENART || point.family === FAMILIE);
}

/**
 * Der Punktschluessel zerlegt: `{ abschnitt, einheit, feld }` oder `null`. `einheit` ist die
 * TE-Nr. (ab 1), `'*'` fuer die Katalogvorlage `erzeuger.te[*].…`, `null` fuer feste Abschnitte.
 */
function punktTeile(pointKey) {
  const treffer = String(pointKey).match(PUNKT_MUSTER);
  if (!treffer) return null;
  const einheit = treffer[2] === undefined ? null : treffer[2] === '*' ? '*' : Number(treffer[2]);
  return { abschnitt: treffer[1] || 'te', einheit, feld: treffer[3] };
}

/** Alle Punkte eines Bilds mit `teAnzahl` Einheiten - die Box-Sicht der Familie. */
function punkteFuer(teAnzahl = MAX_EINHEITEN) {
  const raus = FELDER.filter((f) => !f.einheit).map((f) => punktVon(f));
  for (let e = 1; e <= teAnzahl; e++) raus.push(...FELDER.filter((f) => f.einheit).map((f) => punktVon(f, e)));
  return raus;
}

/** Die Katalogvorlage eines Punkts (`erzeuger.te[3].t_zustand` → `erzeuger.te[*].t_zustand`). */
function vorlageVon(pointKey) {
  return String(pointKey).replace(/^erzeuger\.te\[\d+]\./, 'erzeuger.te[*].');
}

/** EINE Pollgruppe je Steuerung und Takt. */
function pollGruppe(targetKey) {
  return `${targetKey}:erzeuger:registerbild:${LESETAKT_S}`;
}

module.exports = {
  SIGNATUR, HAUPTVERSION, WORTFOLGE_PRUEFWERT, KOPFLAENGE, FESTER_TEIL, EINHEIT_LAENGE,
  MAX_EINHEITEN, NAME_WOERTER, MAX_WOERTER_JE_ANFRAGE, LESETAKT_S, FAMILIE, QUELLENART, KOPF,
  UNGUELTIG, AUFZAEHLUNGEN, FELDER, NAMEN, TYP_NAME, GRUENDE, SOLL_GRUENDE, WORTFOLGEN, FUNKTIONSCODES,
  wert32, liesName, laengeBild, planeAnfragen, namensBereich, planeNamen, liesKopf,
  liesErzeugerbild, liesNamen, kopfBericht, kopfPlan, herzschlagUrteil, istErzeugerPunkt,
  punktTeile, punkteFuer, punktVon, vorlageVon, pollGruppe,
};
