import type { Kernaussage } from './chartKopf';
import type { InsightPart } from './schedule';
import type { PeakShaving, SchedulePlan } from './api';
import type { LastspitzenPeriode } from './moduleSurface';
import { abrechnungLabel, peakCounterfactualTip } from './moduleSurface';
import type { VerlaufLedgerZeile } from './components/VerlaufLedger';
import { eur, fmtNum } from './format';

/**
 * **Die reine Ableitungs-Schicht des Reiters „Lastspitzen"** (Paket P6 des
 * Konzepts `vp-verlauf-sprache-konzept-v5`, §4.4).
 *
 * Sie beantwortet die drei Fragen der Fläche — was das Statement sagt, was die
 * zwei Ledger-Zeilen tragen, und was über den zwei Bildern steht — und rendert
 * NICHTS. Zwei Regeln des Hauses stehen darin:
 *
 * ⚠ **Kein Satz ohne Beleg.** Jede Aussage kommt aus einer gemessenen Zahl;
 *   fehlt sie, steht dort der GRUND („In der laufenden Abrechnungsperiode
 *   liegen noch keine Messwerte vor.") und niemals eine 0.
 * ⚠ **Die Wörter sind die bisherigen.** Statement-Satz, Zeilen-Namen,
 *   Sekundärzeilen und der Ziel-Satz sind wörtlich das, was die Fläche vor P6
 *   schon sagte — P6 ändert die FORM, nicht die Aussage.
 */

/** Das Statement der Karte 1: die EINE Zahl des Reiters und ihr Satz. */
export interface LastspitzeStatement {
  /** Schon formatiert („8,7 kW'); `null` = nichts gemessen, die Fläche zeigt „—'. */
  zahl: string | null;
  /** Der Satz darunter — bei fehlender Zahl ist es der GRUND. */
  satz: string;
  /** Der erklärende Titel (Tooltip); `null`, wo es nichts zu erklären gibt. */
  titel: string | null;
}

/** Ob diese Periode überhaupt einen Beweis trägt. */
export function periodeGemessen(periode: LastspitzenPeriode | null): boolean {
  return (
    periode != null &&
    periode.peakKw != null &&
    periode.avoidedKw != null &&
    periode.avoidedEur != null
  );
}

/**
 * §4.4 · „Statement „8,7 kW" + Satz „Gehaltene Spitze in diesem
 * Abrechnungsjahr''. Der Satz nennt die LAUFENDE Periode bei ihrer Art
 * (Jahr/Monat) und eine vergangene bei ihrem Namen — er darf nie „diesem"
 * sagen über eine Periode, die vorbei ist.
 */
export function lastspitzeStatement(
  periode: LastspitzenPeriode | null,
  abrechnung: PeakShaving['abrechnung'],
): LastspitzeStatement {
  if (!periodeGemessen(periode) || periode == null) {
    return {
      zahl: null,
      satz:
        periode == null || periode.laufend !== false
          ? 'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.'
          : `Für ${periode.label} liegen keine Messwerte vor.`,
      titel: null,
    };
  }
  const wo = periode.laufend
    ? abrechnung === 'monat'
      ? 'in diesem Abrechnungsmonat'
      : 'in diesem Abrechnungsjahr'
    : `in ${periode.label}`;
  return {
    zahl: fmtNum(periode.peakKw as number, 'kW'),
    satz: `Gehaltene Spitze ${wo}`,
    titel: 'Die höchste Viertelstunden-Bezugsspitze dieser Abrechnungsperiode',
  };
}

/**
 * §4.4 · die zwei V5-Zeilen unter dem Statement. Das Vorzeichen kommt aus dem
 * WERT (nie aus einer Farbe), die Sekundärzeile ist der Erklärtext, der bis P6
 * im InfoTip bzw. im `title` der KPI-Karte stand.
 *
 * Leer, solange die Periode nichts gemessen hat — zwei Zeilen mit „+ 0,0 kW"
 * behaupteten einen Beweis, den es nicht gibt.
 */
export function lastspitzeZeilen(
  periode: LastspitzenPeriode | null,
  peak: PeakShaving,
): VerlaufLedgerZeile[] {
  if (!periodeGemessen(periode) || periode == null) return [];
  const kw = periode.avoidedKw as number;
  const euro = periode.avoidedEur as number;
  return [
    {
      id: 'vermieden',
      name: 'Vermiedene Spitze',
      wert: `${kw >= 0 ? '+' : ''}${fmtNum(kw, 'kW')}`,
      sekundaer: peakCounterfactualTip(peak),
    },
    {
      id: 'erspart',
      name: 'Ersparte Leistungskosten',
      wert: `${euro >= 0 ? '+' : ''}${eur(euro)} €`,
      sekundaer: `Vermiedene Spitze × Leistungspreis (${eur(peak.leistungspreisEurKw)} €/kW ${abrechnungLabel(peak.abrechnung)})`,
    },
  ];
}

/**
 * §4.4 Karte 3 · der Kernsatz über dem Fahrplan-Bild: „Der Speicher hält Ihren
 * Netzbezug unter 9 kW (rote Linie)", und als SEKUNDÄRZEILE die Aussage, die
 * bis P6 als `vp-insight`-Kasten UNTER dem Bild stand (V11: nie eine zweite
 * Fläche in Kategoriefarbe).
 *
 * ⚠ Ohne Ziel wird KEIN Ziel behauptet — dann führt die Plan-Aussage allein.
 *   Ohne beides steht dort nichts: ein nacktes „—" erklärt nichts.
 */
export function fahrplanKern(
  target: number | null | undefined,
  insight: InsightPart[] | null,
): Kernaussage | null {
  const insightSatz = insight?.map((p) => p.text).join('') ?? null;
  if (target != null) {
    return {
      wert: null,
      satz: `Der Speicher hält Ihren Netzbezug unter ${fmtNum(target, 'kW', 0)} (rote Linie)`,
      grund: null,
      ton: 'ok',
      anker: insightSatz,
    };
  }
  if (insightSatz)
    return { wert: null, satz: insightSatz, grund: null, ton: 'calm' };
  return null;
}

/**
 * §4.4 Karte 3 · der Hinweis, dass der Fahrplan IMMER der kommende ist. Er
 * gehört einer zurückgeblätterten Periode — sonst schriebe die Fläche den Plan
 * stillschweigend der falschen Periode zu.
 */
export function fahrplanPeriodenNote(
  periode: LastspitzenPeriode | null,
): string | null {
  if (periode == null || periode.laufend !== false) return null;
  return `Der Fahrplan zeigt immer die kommenden Stunden, nicht ${periode.label}.`;
}

/** §4.4 Karte 3 · der Leer-Zustand, wenn es noch keinen Plan gibt (V10). */
export const FAHRPLAN_LEER_SATZ =
  'Für heute liegt noch kein Fahrplan vor. Sobald Börsenpreise und Prognosen vorliegen, plant VoltPilot den Speichereinsatz zum Halten Ihrer Zielspitze.';

/** §4.4 Karte 2 · der Leer-Zustand des Verlaufs (V10). */
export const VERLAUF_LEER_SATZ =
  'Sobald zwei Abrechnungsperioden gemessen sind, erscheint hier Ihr Verlauf – mit und ohne Speichereinsatz.';

/** Ob der Plan Slots trägt (ein leerer Plan ist kein Plan). */
export function hatPlan(plan: SchedulePlan | null): boolean {
  return plan != null && plan.slots.length > 0;
}
