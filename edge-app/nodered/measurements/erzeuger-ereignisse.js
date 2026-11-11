'use strict';
/**
 * Kopf-Stufe, Qualitaet und Ereignisse des Erzeuger-Bilds (Paket EZ-5).
 *
 * Die zweite Stufe des Erzeuger-Wegs, gebaut wie IP-7/IP-8 des WAGO-Bilds:
 *
 *     liesErzeugerbild -> ErzeugerStufe.lesung() -> Werte mit Qualitaet + edge/events
 *
 * Sie prueft nichts ein zweites Mal - jede Zahl und jeder Grund kommt aus
 * `erzeuger-registerbild.js`. Sie sagt nur, was daraus FOLGT:
 *
 *  1. **Befund.** Signatur oder Hauptversion fremd heisst: unter dieser Adresse steht NICHT das
 *     VoltPilot-Bild Erzeuger v1 (`registerbild_unbekannt`). Jeder Grund faehrt auf dem
 *     Findings-Weg der Mess-Runtime als `layout_changed` - das Vokabular von §7 des
 *     Quellenvertrags ist geschlossen (dieselbe Wahl wie `wago-kopf.js`).
 *  2. **`stale` ab der dritten gleichen Lesung** des Herzschlags, je Steuerung (EZ-1 Lesart 8:
 *     gezaehlt werden LESUNGEN, nicht Uebergaenge). Der Zaehler ist die `HerzschlagWacht` des
 *     WAGO-Wegs mit dieser Schwelle; Ueberlauf 65 535 → 0 ist kein Stehen (EZ-1 A2).
 *  3. **`uncertain` fuer den Netzpunkt**, wenn `a_alter_s` ueber der Schwelle liegt (Vorgabe
 *     30 s, Konzept §4.3). `a_alter_s` ist laut Bild das Alter der NETZPUNKT-Messung - die
 *     Erzeugung, der Zustand und der Gasspeicher kommen nicht aus dieser Messung und bleiben,
 *     was sie sind.
 *  4. **Ereignisse**, jedes einmal je Zustandswechsel: `frozen_source` (Herzschlag steht) und
 *     `device_restart` (Herzschlag springt zurueck - das Programm ist neu angelaufen, die
 *     Zaehler `n_zaehler`/`d_zaehler` beginnen neu).
 *
 * NICHT hier, mit Absicht:
 * - `data_gap`: ein Lesefehler liefert keinen Wert; den Quellenstatus meldet die Laufzeit wie
 *   bei jeder Quelle, die Luecke bildet der Writer. Ein Treiber-`data_gap` weist der Kern ab.
 * - `state_change`/`bitfield_change`: die bildet die Cloud aus den gemeldeten Zustaenden.
 * - `counter_reset` des Zaehlerstands `t_e`: den bildet der Writer aus dem Zaehlerverlauf.
 */

const bild = require('./erzeuger-registerbild');
const { HerzschlagWacht } = require('./wago-kopf');
const ereignisse = require('./device-events');

/** Ab so vielen stehenden UEBERGAENGEN ist die dritte gleiche Lesung erreicht. */
const STEHT_AB = 2;
/** Vorgabe fuer `a_alter_s`, ab der der Netzpunkt `uncertain` ist (Konzept §4.3). */
const ALTER_SCHWELLE_S = 30;
/** Welche Werte `a_alter_s` datiert. */
const ALTER_DECKT = Object.freeze(['p_nvp_w']);

const QUALITAET_NORMAL = 'good';
const QUALITAET_ALT = 'stale';
const QUALITAET_UNSICHER = 'uncertain';
const QUALITAET_UNGUELTIG = 'invalid';

/** Die zwei Gruende, die „nicht unser Bild" heissen. */
const FREMDE_GRUENDE = Object.freeze(['signatur_fremd', 'version_fremd']);
const FINDING_ERROR_CLASS = 'layout_changed';
const FINDING_SATZ = 'Unter dieser Adresse steht nicht das VoltPilot-Registerbild Erzeuger v1 '
  + '(Signatur oder Version fremd) - es wurde kein Wert übernommen.';

/** Der Befund zu einem Leseergebnis - `null` heisst: kein Befund ueber das Programm. */
function befund(gelesen) {
  if (!gelesen || !FREMDE_GRUENDE.includes(gelesen.grund)) return null;
  return Object.freeze({ finding: 'registerbild_unbekannt', grund: gelesen.grund,
    error_class: FINDING_ERROR_CLASS, message: FINDING_SATZ });
}

/**
 * Die Erzeuger-Stufe EINER Box. Sie haelt den Zustand, aus dem „einmal je Zustandswechsel"
 * erst folgt: den Herzschlag je Steuerung und ob das Einfrieren schon gemeldet ist.
 */
class ErzeugerStufe {
  constructor({ stehtAb = STEHT_AB, alterSchwelleS = ALTER_SCHWELLE_S } = {}) {
    this.wacht = new HerzschlagWacht({ stehtAb });
    this.alterSchwelleS = alterSchwelleS;
    this.eingefroren = new Map();
  }

  /**
   * Eine Lesung auswerten.
   *
   * `woerter`: das laufende Bild ab der Basisadresse.
   * `steuerung`: der Schluessel, unter dem der Herzschlag zaehlt - das ZIEL.
   * `parameter`/`soll`: wie bei `liesErzeugerbild`; `soll.alter_schwelle_s` ersetzt die Vorgabe.
   * `datenquelle`: Kennung der Datenquelle (sie gehoert dem Bestand).
   * `komponente`: die Komponente der Anlagensteuerung, wenn die Laufzeit sie kennt.
   *
   * Rueckgabe: das Leseergebnis, ergaenzt um `befund`, `herzschlag_urteil`, `steht` und
   * `werte[].qualitaet` (`null` = kein Sample), dazu `ereignisse` als fertige Bus-Nachrichten.
   */
  lesung(woerter, { steuerung, parameter = {}, soll = null, datenquelle = null,
    komponente = null, zeitpunkt = new Date() } = {}) {
    const gelesen = bild.liesErzeugerbild(woerter, { parameter, soll });
    // Nur ein LESBARES Bild ist eine Herzschlag-Beobachtung - auch eines, das bloss nicht zum
    // Soll passt. Eine nicht lesbare Lesung unterbricht die Folge nicht und zaehlt nie als
    // stehend (Vertrag Erzeuger §8): aus „nicht gelesen" wird nie „steht".
    const lesbar = gelesen.ergebnis === 'erkannt' || bild.SOLL_GRUENDE.includes(gelesen.grund);
    const herzschlag = lesbar && Number.isInteger(gelesen.kopf.herzschlag)
      ? gelesen.kopf.herzschlag : null;
    const beobachtung = this.wacht.beobachte(steuerung, herzschlag);
    const raus = [];
    const melde = (eingang) => {
      const nachricht = ereignisse.nachricht(Object.assign({ datenquelle }, eingang), zeitpunkt);
      if (nachricht !== null) raus.push(nachricht);
    };
    if (beobachtung.urteil === 'rueckwaerts') {
      melde({ art: 'device_restart', herzschlag_vorher: beobachtung.herzschlag_vorher,
        herzschlag_nachher: beobachtung.herzschlag_nachher });
    }
    const steht = beobachtung.qualitaet === QUALITAET_ALT;
    if (steht && !this.eingefroren.get(steuerung)) {
      // `lesungen` zaehlt die gleichen LESUNGEN (Uebergaenge + 1), wie EZ-1 Lesart 8 sie zaehlt.
      melde({ art: 'frozen_source', komponente, lesungen: beobachtung.steht + 1,
        herzschlag: beobachtung.herzschlag_nachher });
    }
    if (beobachtung.steht === 0) this.eingefroren.delete(steuerung);
    else if (steht) this.eingefroren.set(steuerung, true);

    const ergebnis = Object.assign({}, gelesen, {
      befund: befund(gelesen),
      herzschlag_urteil: beobachtung.urteil,
      steht: beobachtung.steht,
      qualitaet: gelesen.ergebnis === 'erkannt' ? beobachtung.qualitaet : null,
      ereignisse: raus,
    });
    if (gelesen.ergebnis !== 'erkannt') return ergebnis;

    const schwelle = soll && Number.isInteger(soll.alter_schwelle_s)
      ? soll.alter_schwelle_s : this.alterSchwelleS;
    const alter = gelesen.werte.find((w) => w.feld === 'a_alter_s');
    const zuAlt = !!alter && Number.isInteger(alter.wert) && alter.wert > schwelle;
    ergebnis.werte = gelesen.werte.map((w) => {
      let q;
      if (w.grund === 'fremd') q = QUALITAET_UNGUELTIG;
      else if (w.wert === null) q = null;
      else if (steht) q = QUALITAET_ALT;
      else if (zuAlt && ALTER_DECKT.includes(w.feld)) q = QUALITAET_UNSICHER;
      else q = QUALITAET_NORMAL;
      return Object.assign({}, w, { qualitaet: q });
    });
    return ergebnis;
  }

  /** Eine Steuerung faellt aus der Planung - ihr Stand darf keine spaetere ueberdauern. */
  vergiss(steuerung) {
    this.wacht.vergiss(steuerung);
    this.eingefroren.delete(steuerung);
  }
}

module.exports = {
  STEHT_AB, ALTER_SCHWELLE_S, ALTER_DECKT, QUALITAET_NORMAL, QUALITAET_ALT, QUALITAET_UNSICHER,
  QUALITAET_UNGUELTIG, FREMDE_GRUENDE, FINDING_ERROR_CLASS, FINDING_SATZ, befund, ErzeugerStufe,
};
