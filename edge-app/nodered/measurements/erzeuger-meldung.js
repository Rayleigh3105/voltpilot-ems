'use strict';
/**
 * Wann ein Wert des Erzeuger-Bilds gesendet wird (Paket EZ-5, EW-5 A, Konzept §4.3).
 *
 * Die Box LIEST das Bild alle 5 s, sie SENDET nicht alle 5 s jeden Wert - sonst laege eine
 * Anlage mit zehn Einheiten bei ueber 1 100 Werten je Minute. Die Regel je Feld (`klasse` in
 * `erzeuger-registerbild.js` FELDER):
 *
 * - `schnell` (Leistungen, Vorgaben, wirksame Grenze): sobald sich der Wert um mehr als das
 *   Totband des Felds bewegt (Totband 0 = jede Aenderung), spaetestens nach `cadence_s`.
 * - `zustand` (Zustaende, Bitfelder, Kennzahlen der Anlage): bei jeder Aenderung, spaetestens
 *   nach `cadence_s` - der Cloud-Wechsel `state_change`/`bitfield_change` braucht jede Aenderung.
 * - `zaehler` (Vorgaben-Zaehler, „seit", Zaehlerstand): im Takt der Auswahl (`cadence_s`; fuer die
 *   Zaehler nennt der Katalog 60 s). Ein verpasster Wechsel steckt im Zaehler.
 *
 * `cadence_s` der Auswahl ist damit der LAENGSTE Abstand zweier Werte, nicht der Lesetakt.
 * Eine neue Qualitaet wird immer sofort gesendet; ein Wert, der verschwindet (ungueltig, nicht
 * gueltig, nicht gelesen), loescht den Stand - der naechste Wert ist wieder der erste.
 */

class ErzeugerMeldung {
  constructor() {
    /** Je Schluessel (Ziel, Komponente, Punkt): zuletzt gesendeter Wert, Qualitaet, Zeit. */
    this.stand = new Map();
  }

  /**
   * Soll dieser Wert jetzt gesendet werden? Merkt sich den Wert, wenn ja.
   *
   * `eintrag`: `{ wert, roh, qualitaet, klasse, totband }` aus `ErzeugerStufe.lesung`.
   */
  soll(schluessel, eintrag, cadenceS, jetztMs) {
    if (eintrag.qualitaet === null || eintrag.qualitaet === undefined) {
      this.stand.delete(schluessel);
      return false;
    }
    const vergleich = eintrag.wert === null ? eintrag.roh : eintrag.wert;
    const vorher = this.stand.get(schluessel);
    const merke = () => {
      this.stand.set(schluessel, { wert: vergleich, qualitaet: eintrag.qualitaet, zeit: jetztMs });
      return true;
    };
    if (!vorher || vorher.qualitaet !== eintrag.qualitaet) return merke();
    if (jetztMs - vorher.zeit >= cadenceS * 1000) return merke();
    if (eintrag.klasse === 'zustand') return vergleich !== vorher.wert ? merke() : false;
    if (eintrag.klasse === 'schnell') {
      const totband = Number.isFinite(eintrag.totband) ? eintrag.totband : 0;
      const bewegt = typeof vergleich === 'number' && typeof vorher.wert === 'number'
        ? Math.abs(vergleich - vorher.wert) > totband + 1e-9 : vergleich !== vorher.wert;
      return bewegt ? merke() : false;
    }
    return false;
  }

  /** Alle Staende eines Ziels vergessen (Lesefehler, fremdes Bild, neuer Plan). */
  vergissZiel(zielSchluessel) {
    const praefix = `${zielSchluessel}\u0000`;
    for (const schluessel of Array.from(this.stand.keys())) {
      if (schluessel.startsWith(praefix)) this.stand.delete(schluessel);
    }
  }

  vergissAlles() { this.stand.clear(); }
}

/** Der Schluessel eines Werts: Ziel, Komponente, Punkt. */
function meldeSchluessel(zielSchluessel, entityId, pointKey) {
  return `${zielSchluessel}\u0000${entityId || ''}\u0000${pointKey}`;
}

module.exports = { ErzeugerMeldung, meldeSchluessel };
