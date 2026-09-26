/**
 * Die WAAGE einer Viertelstunde (Konzept „Tagesuhr und Bildfahrplan",
 * Entscheid E5: „zwei Zahlen und ein Satz" — nachprüfbar, und der Satz trägt
 * auch ohne die Zahlen).
 *
 * Sie stellt die zwei Werte je kWh nebeneinander, zwischen denen die
 * Entscheidung dieser Viertelstunde lag: was die gewählte Handlung bringt bzw.
 * kostet und was die Energie im Speicher wert ist. Jede Zahl ist ein Feld des
 * Plans — `importPriceCtKwh` (der Preis, mit dem der Optimierer entschieden
 * hat, P0), `exportValueCtKwh` und `storedValueCtKwh` (Wert gespeicherter
 * Energie). Es wird nichts neu gerechnet.
 *
 * ⚠ **Keine Vorteils-Zahl bei aktiven Viertelstunden.** Am Optimum ist der
 * Grenznutzen einer ladenden oder abgebenden Viertelstunde null — die Lücke
 * zwischen den zwei Balken ist Speicherverlust und Verschleiß, nicht Gewinn.
 * Die Waage zeigt deshalb die zwei Werte und sagt nur die RICHTUNG („mehr
 * wert"), nie „X ct Vorteil".
 *
 * ⚠ **Ruhende Viertelstunden wiegen mit der Marge des Optimierers.** Ob Warten
 * besser war, entscheiden Verluste und Verschleiß mit; zwei nackte Preise
 * könnten dort das Gegenteil nahelegen. Hier spricht deshalb nur
 * `whyNextBest`/`whyNextBestMarginCt` (dieselbe Aussage wie `margeSatz`),
 * inklusive des ausgesprochenen Gleichstands.
 *
 * ⚠ **Widerspricht eine Zahl der Entscheidung, gibt es keine Waage.** Eine
 * Waage, deren schwerere Seite nicht gewählt wurde, wäre eine falsche
 * Begründung; dann bleibt der Warum-Satz des Panels allein stehen.
 *
 * Rein: kein React, kein Netz.
 */

import { margeSatz, nextBestOf, type WhySlot } from './fahrplanWhy';
import type { PlanWordingKind } from './schedule';

export interface WaageSeite {
  label: string;
  hinweis: string;
  ct: number;
  /** true = ein Preis, den man zahlt (gestreift gezeichnet). */
  kosten: boolean;
}

export interface Waage {
  frage: string;
  /** Die zwei Werte; null bei einer ruhenden Viertelstunde (nur die Marge). */
  seiten: [WaageSeite, WaageSeite] | null;
  /** Die gewählte Seite (0 oder 1); null ohne Seiten. */
  gewaehlt: 0 | 1 | null;
  urteil: string;
  /** Ein ausgesprochener Gleichstand (nur bei ruhenden Viertelstunden). */
  gleichstand: boolean;
}

function zahl(v: number | null | undefined): number | null {
  return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
}

const LAMBDA = 'Wert gespeicherter Energie';
const EINGERECHNET = 'Speicherverluste und Verschleiß sind im Plan eingerechnet.';

/** Die Waage einer Viertelstunde; null, wenn ihr die Fakten fehlen. */
export function waage(slot: WhySlot, plantKind: PlanWordingKind): Waage | null {
  const role = slot.slotRole ?? null;
  const bezug = zahl(slot.importPriceCtKwh);
  const einspeisung = zahl(slot.exportValueCtKwh);
  const lambda = zahl(slot.storedValueCtKwh);
  const verkaufen = plantKind === 'direktvermarktung' ? 'Verkaufen' : 'Einspeisen';

  switch (role) {
    case 'guenstig_laden':
      if (bezug == null || lambda == null || !(bezug < lambda)) return null;
      return {
        frage: 'Warum lädt er aus dem Netz?',
        seiten: [
          { label: 'Netzstrom kostet jetzt', hinweis: 'je kWh', ct: bezug, kosten: true },
          { label: 'Gespeichert ist er wert', hinweis: LAMBDA, ct: lambda, kosten: false },
        ],
        gewaehlt: 1,
        urteil: `Gespeichert ist die Kilowattstunde mehr wert, als sie jetzt kostet. ${EINGERECHNET}`,
        gleichstand: false,
      };
    case 'pv_speichern':
      if (einspeisung == null || lambda == null || !(einspeisung < lambda)) return null;
      return {
        frage: 'Warum speichert er die Sonne?',
        seiten: [
          { label: `${verkaufen} brächte`, hinweis: 'je kWh', ct: einspeisung, kosten: false },
          { label: 'Gespeichert ist sie wert', hinweis: LAMBDA, ct: lambda, kosten: false },
        ],
        gewaehlt: 1,
        urteil: `Gespeichert ist der Sonnenstrom mehr wert als ${plantKind === 'direktvermarktung' ? 'verkauft' : 'eingespeist'}. ${EINGERECHNET}`,
        gleichstand: false,
      };
    case 'eigenverbrauch':
      if (bezug == null || lambda == null || !(bezug > lambda)) return null;
      return {
        frage: 'Warum deckt er jetzt Ihren Verbrauch?',
        seiten: [
          { label: 'Jetzt nutzen spart Netzstrom zu', hinweis: 'je kWh', ct: bezug, kosten: false },
          { label: 'Aufheben wäre wert', hinweis: LAMBDA, ct: lambda, kosten: false },
        ],
        gewaehlt: 0,
        urteil: `Jetzt zu nutzen spart mehr, als die Energie im Speicher später wert wäre. ${EINGERECHNET}`,
        gleichstand: false,
      };
    case 'verkaufen':
      if (einspeisung == null || lambda == null || !(einspeisung > lambda)) return null;
      return {
        frage: plantKind === 'direktvermarktung' ? 'Warum verkauft er jetzt?' : 'Warum speist er jetzt ein?',
        seiten: [
          { label: `${verkaufen} bringt jetzt`, hinweis: 'je kWh', ct: einspeisung, kosten: false },
          { label: 'Aufheben wäre wert', hinweis: LAMBDA, ct: lambda, kosten: false },
        ],
        gewaehlt: 0,
        urteil: `${verkaufen} bringt jetzt mehr, als die Energie im Speicher später wert wäre. ${EINGERECHNET}`,
        gleichstand: false,
      };
    case 'warten':
    case 'reserve_halten': {
      // Nur die Marge des Optimierers — und nur ihr getesteter Wortlaut.
      const nb = nextBestOf(slot);
      const satz = margeSatz(slot, plantKind);
      if (nb == null || satz == null) return null;
      return {
        frage: 'Warum wartet er?',
        seiten: null,
        gewaehlt: null,
        urteil: satz,
        gleichstand: nb.tie,
      };
    }
    default:
      // Abregeln (Ursache kann eine Netzgrenze sein) und Lastspitze kappen
      // (Leistungspreis, kein kWh-Vergleich) erklärt das Panel mit seinen
      // eigenen, faktengebundenen Sätzen.
      return null;
  }
}
