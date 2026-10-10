'use strict';
/**
 * Ereignisse und Qualitaet aus Statuswort und Zaehlerverlauf (UEMS AP-05 IP-8).
 *
 * Die dritte Stufe des WAGO-Wegs. Davor: IP-6 liest das Registerbild
 * (`wago-registerbild.js`), IP-7 prueft den Kopf und zaehlt den Herzschlag
 * (`wago-kopf.js`). Diese Stufe sagt, welche EREIGNISSE daraus werden:
 *
 *     liesRegisterbild -> pruefeLesung -> lesung() -> edge/events -> Kern -> .../v2/events
 *
 * Der Einliefer-Weg ist gebaut (AP-07 IP-19, `device-events.js`): der Treiber sagt nur, WAS er
 * sah - Kennung der Box, Umschlag, Sequenz und `ereignis_id` gehoeren dem Kern. Das Vokabular
 * ist GESCHLOSSEN und wird hier nicht geweitet; `device_restart`, `frozen_source` und
 * `range_limit` stehen darin schon als Box-Arten. Es gibt deshalb KEINE Migration und keine
 * Cloud-Aenderung in diesem Paket - die Zelle des Konzepts ist aelter als der Ereignis-Vertrag.
 *
 * ## Was hier NICHT gedeutet wird
 *
 * Die **Bitlage der Bereichsbegrenzung** in den Statuswoertern ist fuer die 750-494 NICHT
 * belegt (Vertrag §4.2 „Zu erheben", §8 „nicht zitiert", AP-05 Befunde 1 und 4). Sie wird darum
 * auch nicht geraten. Der Aufbau, den der Vertrag BELEGT - drei Gruppen, je vier Prozesswerte,
 * „Bereichsbegrenzung Prozesswert x" meint den x-ten Wert der Gruppe -, steht hier als Form
 * (`bereichsbegrenzungBits`); die vier Bitzahlen darin bringt Pilotschritt 2 mit. Ohne sie
 * deutet diese Stufe kein einziges Bit, und `range_limit` faehrt allein auf dem belegten
 * Merkmal: dem UNGUELTIG-Wert des Datentyps (Handbuch 750-495 S. 79 Tab. 27, Vertrag §4.3).
 *
 * ## Die drei Arten, jede einmal je ZUSTANDSWECHSEL
 *
 * Der Vertrag §3 sagt, was ein Leser aus dem Herzschlag schliesst - genau zwei Dinge -, und §5
 * nennt `frozen_source` und `device_restart` als die Ereignisse daraus. Daran haelt sich diese
 * Stufe; sie erfindet keine dritte Herzschlag-Regel.
 *
 * - **`frozen_source`** („Werte eingefroren", Vokabular §4) - der Herzschlag steht ueber drei
 *   aufeinanderfolgende Lesungen. Derselbe Sachverhalt, den IP-7 als Qualitaet `stale` an jeden
 *   Wert der Steuerung schreibt: die Qualitaet faehrt mit jedem Wert zum Writer, das Ereignis
 *   sagt es EINMAL und mit Grund. Die Schwelle gehoert IP-7 - diese Stufe liest dessen Urteil
 *   (`qualitaet === 'stale'`) und legt keine zweite Zahl daneben. `lesungen` ist der Stand des
 *   IP-7-Zaehlers, `herzschlag` die stehende Zahl. Je STEUERUNG, denn der Herzschlag steht im
 *   Kopf und gilt fuer alle Karten zugleich - `komponente` und `messkanal` bleiben darum leer
 *   (im Vokabular sind sie wahlfrei).
 * - **`device_restart`** - der Herzschlag springt zurueck (`rueckwaerts` aus IP-7): das Programm
 *   der Steuerung ist neu angelaufen. `ueberlauf` (65 535 -> 0) ist KEIN Neustart, sondern ein
 *   laufender Zaehler - Fall S2 des Simulators faehrt beides hintereinander.
 * - **`range_limit`** - ein Messwert liest den UNGUELTIG-Wert seines Datentyps. Genau das, was
 *   `deute32` schon zu `null` macht und was der Treiber als „kein Sample" ausliefert (PR 942,
 *   `measurement-driver.js`: Stille ist eine Luecke, nie eine 0). Diese Stufe legt KEINE zweite
 *   Qualitaetsregel daneben - sie gibt der Stille ihren GRUND. Je (Karte, Gruppe), weil der
 *   Vertrag die Bereichsbegrenzung an das Statuswort der Gruppe bindet; das rohe Statuswort 1
 *   faehrt unausgelegt mit, damit der Pilot spaeter die Bitlage daran ablesen kann.
 *
 * `counter_reset` kommt hier nicht vor: den bildet der Writer aus dem Zaehlerverlauf, und er
 * bleibt unberuehrt.
 */

const registerbild = require('./wago-registerbild');
const kopf = require('./wago-kopf');
const ereignisse = require('./device-events');

/**
 * Die Qualitaet eines Werts, dessen Feld den UNGUELTIG-Wert liest
 * (`mqtt-measurement-samples-2.1.schema.json`). Geliefert wird er deswegen nicht - das tut schon
 * IP-6 nicht -, aber sein Fehlen ist eine Beobachtung und keine Luecke.
 */
const QUALITAET_UNGUELTIG = 'invalid';

/** Die drei Arten, die diese Stufe melden kann - Teilmenge von `device-events.ARTEN`. */
const ARTEN = Object.freeze(['device_restart', 'frozen_source', 'range_limit']);

/**
 * Welche Gruppe deckt Messwert `nr` (Vertrag §4.2): 1-4 -> Gruppe 1, 5-8 -> 2, 9-12 -> 3.
 * Der Rueckgabewert ist 1-basiert wie im Vertrag.
 */
function gruppeVon(nr) { return Math.floor((nr - 1) / 4) + 1; }

/** Der Platz eines Messwerts INNERHALB seiner Gruppe (1-4) - das „x" aus „Prozesswert x". */
function platzInGruppe(nr) { return ((nr - 1) % 4) + 1; }

/**
 * Statuswort 1 der Gruppe. Die zwoelf Woerter stehen als 3 x 4 im Block (§4.2), das erste Wort
 * jeder Vierergruppe ist Statuswort 1. Wurden die Statuswoerter nicht gelesen (Gueltigkeit
 * Bit 3 = 0), gibt es keins - dann fehlt das Feld spaeter, es wird nie als 0 erfunden.
 */
function statuswort1(karte, gruppe) {
  if (!Array.isArray(karte.statuswoerter)) return null;
  const wort = karte.statuswoerter[(gruppe - 1) * registerbild.STATUSWOERTER / 3];
  return Number.isInteger(wort) ? wort : null;
}

/**
 * Liest der Messwert an Platz `i` den UNGUELTIG-Wert seines Datentyps?
 *
 * Nur DAS ist die belegte Bereichsbegrenzung. Ein Feld ohne belegten Datentyp (Messwert 2,
 * `energy_export_total`) ist nie ein Wert und darum auch nie eine Begrenzung - sonst haetten
 * wir ein Ereignis aus einer Luecke gemacht.
 */
function liestUngueltig(karte, i) {
  const datentyp = registerbild.MESSWERTE[i].datentyp;
  if (!datentyp || !Object.hasOwn(registerbild.UNGUELTIG, datentyp)) return false;
  const roh = Array.isArray(karte.messwerte_roh) ? karte.messwerte_roh[i] : null;
  return roh === registerbild.UNGUELTIG[datentyp];
}

/**
 * Ist die Bereichsbegrenzung im Statuswort gesetzt? Ohne belegte Bitlage lautet die Antwort
 * IMMER `null` - „unbekannt", nicht „nein" (Vertrag §4.1: ein fehlender Teil ist unbekannt).
 * `bits` ist die Bitlage je Platz in der Gruppe (1-4), wie Pilotschritt 2 sie erheben wird.
 */
function begrenzungLautStatuswort(karte, nr, bits) {
  if (!Array.isArray(bits) || bits.length !== 4) return null;
  const wort = statuswort1(karte, gruppeVon(nr));
  if (wort === null) return null;
  const bit = bits[platzInGruppe(nr) - 1];
  if (!Number.isInteger(bit) || bit < 0 || bit > 15) return null;
  return (wort & (1 << bit)) !== 0;
}

/**
 * Die Ereignis-Stufe EINER Box. Sie haelt den Zustand, aus dem „einmal je Zustandswechsel"
 * ueberhaupt erst folgt: ohne Gedaechtnis wuerde jede Lesung dasselbe Ereignis neu melden.
 *
 * `bereichsbegrenzungBits`: die vier Bitzahlen aus Pilotschritt 2, sonst `null` (nichts gedeutet).
 */
class WagoEreignisse {
  constructor({ bereichsbegrenzungBits = null } = {}) {
    this.bereichsbegrenzungBits = bereichsbegrenzungBits;
    /** Je Steuerung: ob das Einfrieren dieser Episode schon gemeldet ist. */
    this.eingefroren = new Map();
    /** Je Karte und Gruppe: ob die Begrenzung gerade steht (damit sie nur einmal meldet). */
    this.begrenzt = new Map();
  }

  /**
   * Eine Lesung auswerten.
   *
   * `gelesen`: das Ergebnis von `wago-kopf.pruefeLesung` (Kopf geprueft, Herzschlag gezaehlt).
   * `datenquelle`: die Kennung der Datenquelle - sie gehoert dem Bestand, nicht dieser Stufe.
   * `steuerung`: derselbe Schluessel wie in IP-7 (das Ziel, nicht die Karte).
   * `komponente`: `(karte, index) => Kennung|null` - die Entitaet der Karte im Bestand. Was die
   *   Laufzeit nicht kennt, bleibt leer; `komponente` ist im Vokabular wahlfrei.
   * `zeitpunkt`: die Messzeit dieser Lesung (Vorgabe: jetzt).
   *
   * Rueckgabe: `{ ereignisse, qualitaet }`. `ereignisse` sind fertige Bus-Nachrichten fuer
   * `node.send(...)`; eine Art, die der Einliefer-Weg verwerfen wuerde, kommt gar nicht vor.
   * `qualitaet` ist die Sicht je Wert - sie legt KEINE neue Regel fest, sondern traegt die
   * gebauten zusammen: `stale` aus IP-7, „kein Wert" aus IP-6 und PR 942.
   */
  lesung(gelesen, { datenquelle, steuerung, komponente = null, zeitpunkt = new Date() } = {}) {
    const raus = [];
    const melde = (eingang) => {
      const nachricht = ereignisse.nachricht(Object.assign({ datenquelle }, eingang), zeitpunkt);
      if (nachricht !== null) raus.push(nachricht);
    };

    // 1. Neustart der Steuerung. Der Herzschlag springt zurueck - `ueberlauf` tut das NICHT.
    if (gelesen.herzschlag_urteil === 'rueckwaerts') {
      melde({
        art: 'device_restart',
        herzschlag_vorher: gelesen.herzschlag_vorher,
        herzschlag_nachher: gelesen.herzschlag_nachher,
      });
    }

    // 2. Werte eingefroren: der Herzschlag steht, IP-7 urteilt `stale`. Einmal je Episode -
    //    laeuft der Herzschlag wieder, ist die Episode zu und eine neue kann melden.
    const steht = gelesen.qualitaet === kopf.QUALITAET_ALT;
    if (steht && !this.eingefroren.get(steuerung)) {
      melde({
        art: 'frozen_source',
        lesungen: gelesen.steht,
        herzschlag: gelesen.herzschlag_nachher,
      });
    }
    if (gelesen.steht === 0) this.eingefroren.delete(steuerung);
    else if (steht) this.eingefroren.set(steuerung, true);

    // Kein lesbares Registerbild (fremde Version, Laenge, Wortfolge - IP-6/IP-7 melden das als
    // `layout_changed`): dann gibt es keine Karte und keinen Kartenstand. Die naechste Lesung
    // ist wieder die erste, sonst zaehlte ein Zustand von VOR der Luecke weiter.
    if (gelesen.ergebnis !== 'erkannt') {
      this.vergissKarten(steuerung);
      return { ereignisse: raus, qualitaet: [] };
    }

    const karten = Array.isArray(gelesen.karten) ? gelesen.karten : [];
    const qualitaet = [];

    karten.forEach((karte, index) => {
      // Die Karte ist ihr Steckplatz (Identitaet (Geraet, Steckplatz), E4) - nicht ihr Index:
      // faellt eine Karte aus der Planung, verschiebt sich der Index, der Steckplatz nicht.
      const schluessel = `${steuerung}#${karte.steckplatz}`;
      if (karte.ergebnis !== 'gelesen') {
        // Keine Kartenwerte, also keine Aussage ueber die Begrenzung. Der Stand darf nicht
        // stehen bleiben: nach einer Luecke ist die naechste Lesung wieder die erste.
        this.begrenzt.delete(schluessel);
        return;
      }
      const kennung = typeof komponente === 'function' ? komponente(karte, index) : null;

      // 3. Bereichsbegrenzung, je Gruppe. Einmal beim Eintreten, nicht je Lesung.
      const stand = this.begrenzt.get(schluessel) || new Map();
      for (let gruppe = 1; gruppe <= 3; gruppe++) {
        const treffer = registerbild.MESSWERTE.some((m, i) => gruppeVon(m.nr) === gruppe
          && (liestUngueltig(karte, i)
            || begrenzungLautStatuswort(karte, m.nr, this.bereichsbegrenzungBits) === true));
        if (treffer && !stand.get(gruppe)) {
          melde({
            art: 'range_limit',
            komponente: kennung,
            // Das rohe Statuswort der Gruppe, unausgelegt. Fehlt es, fehlt das Feld.
            statuswort: statuswort1(karte, gruppe),
          });
        }
        stand.set(gruppe, treffer);
      }
      this.begrenzt.set(schluessel, stand);

      // 4. Qualitaet je Wert. Das ist eine SICHT auf die gebauten Regeln, kein zweiter
      //    Lieferweg: geliefert wird weiter, was IP-6 und der Treiber liefern (PR 942 gibt beim
      //    UNGUELTIG-Wert gar kein Sample - Stille ist eine Luecke, nie eine 0). Die Sicht sagt,
      //    WARUM ein Wert fehlt, und unterscheidet dabei zwei Faelle, die man nie verwechseln
      //    darf: `invalid` ist eine BEOBACHTUNG der Karte („hier steht kein Messwert"),
      //    `null` ist UNWISSEN (Feld ohne belegten Datentyp - Messwert 2). Aus Unwissen wird
      //    niemals ein Urteil.
      registerbild.MESSWERTE.forEach((m, i) => {
        let q;
        if (liestUngueltig(karte, i)) q = QUALITAET_UNGUELTIG;
        else if (karte.messwerte[i] === null) q = null;
        else q = gelesen.qualitaet;
        qualitaet.push({ steckplatz: karte.steckplatz, nr: m.nr, messkanal: m.schluessel,
          qualitaet: q });
      });
    });

    return { ereignisse: raus, qualitaet };
  }

  /** Nur die Kartenstaende einer Steuerung vergessen (der Herzschlag-Stand bleibt). */
  vergissKarten(steuerung) {
    const praefix = `${steuerung}#`;
    for (const schluessel of Array.from(this.begrenzt.keys())) {
      if (schluessel.startsWith(praefix)) this.begrenzt.delete(schluessel);
    }
  }

  /** Eine Steuerung faellt aus der Planung - ihr Stand darf keine spaetere ueberdauern. */
  vergiss(steuerung) {
    this.eingefroren.delete(steuerung);
    this.vergissKarten(steuerung);
  }
}

module.exports = {
  ARTEN, QUALITAET_UNGUELTIG, WagoEreignisse,
  gruppeVon, platzInGruppe, statuswort1, liestUngueltig, begrenzungLautStatuswort,
};
