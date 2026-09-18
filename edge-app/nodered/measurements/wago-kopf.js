'use strict';

/**
 * Kopf-Pruefung und Identitaet der WAGO-Steuerung (UEMS AP-05 IP-7).
 *
 * IP-6 (`wago-registerbild.js`) PRUEFT das Registerbild und liefert die Beobachtung; dieses
 * Modul baut darauf, was daraus FOLGT. Es prueft nichts ein zweites Mal - jede Zahl und jeder
 * Grund kommt aus `liesRegisterbild`/`herzschlagUrteil`.
 *
 * Drei Folgen, und sonst keine:
 *
 *  1. **Finding `registerbild_unbekannt`.** Signatur oder Hauptversion fremd heisst: unter dieser
 *     Adresse steht NICHT das VoltPilot-Registerbild v1. Dann gibt es keinen einzigen Kartenwert
 *     (das tut schon IP-6) und die Lesung wird als Befund gemeldet.
 *  2. **Qualitaet `stale` nach drei stehenden Lesungen** - je STEUERUNG, nicht je Karte: der
 *     Herzschlag steht im Kopf, also steht er fuer alle Karten dieser Steuerung gleichzeitig.
 *     Ueberlauf (65 535 -> 0) und Programmstart (rueckwaerts) sind KEIN Stehen (Fall S2), und die
 *     erste laufende Lesung raeumt die Qualitaet sofort wieder weg.
 *  3. **Typenschild (0xFA10-0xFA17) nur ANZEIGEN.** Nie zur Identitaetspruefung: ob die Register
 *     ohne Laufzeitsystem ueberhaupt antworten, ist beim Hersteller NICHT belegt (Beleg H2).
 *     Antworten sie nicht, kommt dieses Modul still ohne sie aus.
 *
 * Nicht hier, mit Absicht: die Ereignisse aus dem Statuswort (`range_limit`, `frozen_source`,
 * `device_restart`) sind IP-8. Der Herzschlag-Zaehler steht hier, das Ereignis dort.
 *
 * WARNUNG: **RUHEND wie IP-6.** `wago.pm494`/`wago.pm495` stehen in `NOCH_NICHT_AN_DER_BOX`, also
 * laeuft auch dieses Modul heute nur in seinen Tests (Befund 8 aus dem Bau von AP-05).
 */

const registerbild = require('./wago-registerbild');

// ---------------------------------------------------------------------------
// 1. Der Befund
// ---------------------------------------------------------------------------

/**
 * Das Findings-Vokabular dieser Stufe. Geschlossen: ein Wort, das die Cloud nicht kennt, waere
 * kein Befund, sondern Rauschen.
 */
const FINDINGS = Object.freeze(['registerbild_unbekannt']);

/**
 * Welche Gruende aus Paragraf 5 heissen "das ist nicht unser Registerbild". Genau die zwei, die
 * VOR jeder Laengenpruefung stehen: bei allen anderen Gruenden steht ein v1-Registerbild da, es
 * passt nur nicht zum Hardwareblatt (falsche Kartenzahl, fremde Steuerung, fremde Wortfolge) -
 * das ist eine Aussage ueber die ANLAGE, nicht ueber das Programm in der Steuerung.
 */
const FREMDE_GRUENDE = Object.freeze(['signatur_fremd', 'hauptversion_fremd']);

/**
 * Die Fehlerklasse, unter der der Befund den BESTEHENDEN Findings-Weg der Mess-Runtime faehrt
 * (`reportSource` -> `data-source-status.js` -> `edge/data-sources/poll`).
 *
 * WARNUNG: Warum nicht `registerbild_unbekannt` selbst: Paragraf 7 des Quellenvertrags ist ein
 * GESCHLOSSENES Vokabular ("ein anderes Wort wird beim Annehmen verworfen"), das Box, Ingest,
 * Writer, API und Portal gemeinsam tragen - ein neues Wort dort ist eine Migration und mehrere
 * Vertragsleser, nicht dieses Paket. `layout_changed` ist genau der Satz, den der Kunde hier
 * lesen soll: "Aufbau geaendert - nichts wurde umgehaengt". Das feine Wort steht daneben im
 * Probe-Ergebnis (`mqtt-probe.schema.json`, op `wago_kopf`), wo der Assistent es braucht.
 */
const FINDING_ERROR_CLASS = 'layout_changed';

/** Der deutsche Satz zum Befund - einmal hier, damit keine Flaeche ihn nachbaut. */
const FINDING_SATZ = 'Unter dieser Adresse steht nicht das VoltPilot-Registerbild v1 '
  + '(Signatur oder Version fremd) - es wurde kein Kartenwert uebernommen.';

/**
 * Der Befund zu einem Leseergebnis von `liesRegisterbild`. `null` heisst: kein Befund - auch
 * dann, wenn das Registerbild aus einem ANDEREN Grund unlesbar war. Jeder Grund bleibt ein
 * Grund; nur diese zwei sind ein Befund ueber das Programm der Steuerung.
 */
function befund(gelesen) {
  if (!gelesen || !FREMDE_GRUENDE.includes(gelesen.grund)) return null;
  return Object.freeze({
    finding: 'registerbild_unbekannt',
    grund: gelesen.grund,
    error_class: FINDING_ERROR_CLASS,
    message: FINDING_SATZ,
  });
}

/**
 * Der Lese-Beleg fuer `MeasurementRuntime.reportSource` - dieselbe Form, die jede andere Quelle
 * dort abgibt. Die Box hat gelesen (`requests: 1`), sie hat nur nichts uebernommen: `samples`
 * bleibt bei 0, denn ein Kartenwert waere geraten.
 */
function quellenBeleg(bef) {
  if (!bef) return null;
  return { requests: 1, failed: true, error_class: bef.error_class };
}

// ---------------------------------------------------------------------------
// 2. Der Herzschlag
// ---------------------------------------------------------------------------

/** Ab so vielen stehenden Lesungen IN FOLGE gilt die Steuerung als veraltet. */
const STEHT_AB = 3;

/** Die zwei Qualitaeten, die diese Stufe vergibt (`mqtt-measurement-samples-2.1.schema.json`). */
const QUALITAET_NORMAL = 'good';
const QUALITAET_ALT = 'stale';

/**
 * Der Zaehler der stehenden Lesungen, JE STEUERUNG.
 *
 * Der Herzschlag steht im Kopf des Registerbilds, nicht in der Karte - er sagt "das Programm in
 * dieser Steuerung laeuft noch", und das gilt fuer alle ihre Karten zugleich. Ein Zaehler je
 * Karte wuerde dieselbe Aussage mehrfach fuehren und bei wechselnder Kartenzahl auseinander
 * laufen.
 *
 * `beobachte` nimmt die Herzschlag-Zahl EINER Lesung und gibt zurueck, was daraus folgt:
 * `urteil` (die Beobachtung aus IP-6), `steht` (wie viele stehende Lesungen in Folge) und
 * `qualitaet`. Eine Lesung ohne lesbaren Kopf (Herzschlag `null`) zaehlt NICHT als stehend -
 * sie ist gar keine Herzschlag-Beobachtung, und aus "nicht gelesen" darf nie "steht" werden.
 */
class HerzschlagWacht {
  constructor({ stehtAb = STEHT_AB, schrittgrenze = 120 } = {}) {
    this.stehtAb = stehtAb;
    this.schrittgrenze = schrittgrenze;
    this.stand = new Map();
  }

  beobachte(steuerung, herzschlag) {
    const vorher = this.stand.get(steuerung);
    if (!Number.isInteger(herzschlag)) {
      // Kein Kopf, keine Beobachtung: der bisherige Stand bleibt stehen, wie er ist.
      return this.urteilen(null, vorher ? vorher.steht : 0);
    }
    const urteil = registerbild.herzschlagUrteil(vorher ? vorher.herzschlag : null, herzschlag,
      this.schrittgrenze);
    // Nur `steht` zaehlt hoch. `ueberlauf` und `rueckwaerts` sind ein LAUFENDES Programm
    // (Zaehlerumlauf bzw. Neustart) - sie setzen den Zaehler zurueck wie `laeuft`.
    const steht = urteil === 'steht' ? (vorher ? vorher.steht : 0) + 1 : 0;
    this.stand.set(steuerung, { herzschlag, steht, urteil });
    // Die ZAHLEN gehoeren dieser Stufe, das Ereignis daraus IP-8: `device_restart` braucht
    // `herzschlag_vorher`/`herzschlag_nachher` (Vokabular), und nur hier steht das Paar
    // beisammen. Darum reicht die Beobachtung es mit heraus, statt dass ein zweiter Zaehler
    // denselben Herzschlag noch einmal mitfuehrt.
    return this.urteilen(urteil, steht, vorher ? vorher.herzschlag : null, herzschlag);
  }

  urteilen(urteil, steht, herzschlagVorher = null, herzschlagNachher = null) {
    return { urteil, steht, qualitaet: steht >= this.stehtAb ? QUALITAET_ALT : QUALITAET_NORMAL,
      herzschlag_vorher: herzschlagVorher, herzschlag_nachher: herzschlagNachher };
  }

  /** Der Stand einer Steuerung, ohne ihn zu veraendern. */
  stehtSeit(steuerung) {
    const vorher = this.stand.get(steuerung);
    return vorher ? vorher.steht : 0;
  }

  /** Eine Steuerung faellt aus der Planung - ihr Stand darf keine spaetere ueberdauern. */
  vergiss(steuerung) { this.stand.delete(steuerung); }
}

// ---------------------------------------------------------------------------
// 3. Das Typenschild - nur Anzeige
// ---------------------------------------------------------------------------

/**
 * Die Typenschild-Register der WAGO-Steuerung (0xFA10-0xFA17, 8 Woerter).
 *
 * WARNUNG: NIE zur Identitaetspruefung. Der Hersteller-Beleg H2 sagt ausdruecklich: ob diese
 * Register ohne laufendes Laufzeitsystem antworten, ist NICHT belegt. Ein Geraet, das hier
 * schweigt, ist deshalb kein fremdes Geraet - es ist ein Geraet, ueber das wir nichts erfahren
 * haben. Die Identitaet bleibt die Seriennummer vom Typenschild am Gehaeuse (Vertrag Paragraf 3).
 */
const TYPENSCHILD = Object.freeze({ adresse: 0xfa10, woerter: 8 });

/**
 * Die Woerter als Zeichenkette - zwei Zeichen je Wort, hohes Byte zuerst (die uebliche
 * Modbus-Textform). `null`, wenn nichts Druckbares dabei ist: eine Reihe von Nullen ist kein
 * Typenschild, sondern eine Leerantwort, und eine erfundene leere Zeichenkette waere eine
 * Aussage, die wir nicht haben.
 */
function liesTypenschild(woerter) {
  if (!Array.isArray(woerter) || woerter.length === 0) return null;
  let text = '';
  for (const wort of woerter) {
    const w = wort & 0xffff;
    text += String.fromCharCode(w >> 8, w & 0xff);
  }
  const sauber = text.split('').map((z) => {
    const code = z.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : z;
  }).join('').trim();
  return sauber === '' ? null : sauber;
}

// ---------------------------------------------------------------------------
// Die Stufe
// ---------------------------------------------------------------------------

/**
 * Eine Lesung, durch die Kopf-Stufe gefuehrt.
 *
 * `woerter`: was an der Basisadresse gelesen wurde (IP-6 plant die Anfragen).
 * `steuerung`: der Schluessel, unter dem der Herzschlag gezaehlt wird - das ZIEL, nicht die
 *   Karte und nicht die Familie (dieselbe Wahl wie `pollGruppe`).
 * `wacht`: die `HerzschlagWacht` der Laufzeit; ohne sie gibt es kein `stale`.
 *
 * Rueckgabe: das Ergebnis von `liesRegisterbild`, ergaenzt um `befund`, `herzschlag_urteil`,
 * `steht`, `qualitaet` und das Herzschlag-Paar `herzschlag_vorher`/`herzschlag_nachher` (die
 * beiden Zahlen, aus denen IP-8 `device_restart` baut - ohne Kopf bleiben sie `null`). Die
 * Karten bleiben unveraendert - diese Stufe erfindet keinen Wert und nimmt auch keinen weg;
 * sie sagt nur, wie ALT er ist.
 */
function pruefeLesung(woerter, { steuerung, parameter = {}, soll = null, wacht = null } = {}) {
  const gelesen = registerbild.liesRegisterbild(woerter, { parameter, soll });
  const bef = befund(gelesen);
  const herzschlag = gelesen.kopf ? gelesen.kopf.herzschlag : null;
  const beobachtung = wacht ? wacht.beobachte(steuerung, herzschlag)
    : { urteil: null, steht: 0, qualitaet: QUALITAET_NORMAL };
  return Object.assign({}, gelesen, {
    befund: bef,
    herzschlag_urteil: beobachtung.urteil,
    steht: beobachtung.steht,
    herzschlag_vorher: beobachtung.herzschlag_vorher === undefined ? null
      : beobachtung.herzschlag_vorher,
    herzschlag_nachher: beobachtung.herzschlag_nachher === undefined ? null
      : beobachtung.herzschlag_nachher,
    // Ohne Kartenwerte gibt es auch keine Qualitaet zu vergeben.
    qualitaet: gelesen.ergebnis === 'erkannt' ? beobachtung.qualitaet : null,
  });
}

/**
 * Der Kopf-Bericht des Verbindungstests (Probe-Op `wago_kopf`,
 * `docs/contracts/mqtt-probe.schema.json`). Er liest NUR den Kopf: keine Karte, kein Messwert.
 *
 * Ehrlichkeit wie ueberall: ein Feld, das diese Lesung nicht ergeben hat, FEHLT. Bei fremder
 * Signatur wissen wir nur, dass die Signatur fremd ist - Version, Kartenzahl und Herzschlag
 * waeren dort geraten. Bei fremder Hauptversion steht die Version selbst da (sie ist genau die
 * Auskunft, die der Assistent braucht), der Rest nicht: in einem v2-Registerbild bedeuten die
 * Woerter an Offset 4-11 nicht mehr, was ein v1-Leser aus ihnen machen wuerde (Vektor V4).
 */
function kopfBericht(woerter, { wortfolge = 'big', typenschild = null } = {}) {
  const K = registerbild.KOPF;
  const schild = typenschild === null ? null : liesTypenschild(typenschild);
  const mitSchild = (bericht) => (schild === null ? bericht
    : Object.assign(bericht, { typenschild: schild }));
  if (!Array.isArray(woerter) || woerter.length < registerbild.KOPFLAENGE_MIN) {
    // Zu wenige Woerter ist keine Aussage ueber das Geraet, sondern ueber die Antwort.
    return mitSchild({ signatur_ok: false, erkannt: false, grund: 'laenge_ungueltig' });
  }
  const w = (i) => woerter[i] & 0xffff;
  // Die Reihenfolge ist die des Vertrags (Paragraf 5), wie sie IP-6 faehrt - nur OHNE die
  // Pruefung, ob das ganze Registerbild da ist: diese Op liest bewusst nur den Kopf.
  const signaturOk = w(K.signatur_1) === registerbild.SIGNATUR[0]
    && w(K.signatur_2) === registerbild.SIGNATUR[1];
  if (!signaturOk) return mitSchild({ signatur_ok: false, erkannt: false, grund: 'signatur_fremd' });
  const hauptversion = w(K.hauptversion);
  if (hauptversion !== registerbild.HAUPTVERSION) {
    return mitSchild({ signatur_ok: true, erkannt: false, grund: 'hauptversion_fremd', hauptversion });
  }
  const kopflaenge = w(K.kopflaenge);
  const blocklaenge = w(K.kartenblocklaenge);
  if (kopflaenge < registerbild.KOPFLAENGE_MIN
      || blocklaenge < registerbild.KARTENBLOCKLAENGE_MIN) {
    return mitSchild({ signatur_ok: true, erkannt: false, grund: 'laenge_ungueltig', hauptversion });
  }
  if (registerbild.wert32(woerter, K.wortfolge_pruefwert, wortfolge)
      !== registerbild.WORTFOLGE_PRUEFWERT) {
    return mitSchild({ signatur_ok: true, erkannt: false, grund: 'wortfolge_abweichend',
      hauptversion });
  }
  return mitSchild({
    signatur_ok: true,
    erkannt: true,
    hauptversion,
    nebenversion: w(K.nebenversion),
    kopflaenge,
    kartenblocklaenge: blocklaenge,
    kartenzahl: w(K.kartenzahl),
    herzschlag: w(K.herzschlag),
    controller_kennung: registerbild.wert32(woerter, K.controller_kennung, wortfolge),
  });
}

module.exports = {
  FINDINGS, FREMDE_GRUENDE, FINDING_ERROR_CLASS, FINDING_SATZ,
  STEHT_AB, QUALITAET_NORMAL, QUALITAET_ALT, TYPENSCHILD,
  befund, quellenBeleg, HerzschlagWacht, liesTypenschild, pruefeLesung, kopfBericht,
};
