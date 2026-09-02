// ---------------------------------------------------------------------------
// EINE Zahl über die Flächen — „unterm Strich"
// ---------------------------------------------------------------------------
//
// Erlöse-Konzept `data/vp-erloese-seite-konzept-e2` §2.3 B11/B12 · §3.1 · E9 (a)
// (Captain-Entscheid 02.09.2026, Paket P9).
//
// **Der behobene Befund war ein WORT über drei Zahlen.** Die große Zahl hieß
// auf der Erlöse-Seite „Ergebnis" und meinte das NETTO (Ertrag minus
// Stromkosten), im Cockpit „Verdient" und meinte den GESAMTERTRAG (ohne
// Kosten), im Portfolio „Ertrag" und meinte dasselbe wie das Cockpit. Ein
// Kunde, der vom Cockpit („Verdient 64,82 €") in die Erlöse-Welt („+ 63,23 €")
// klickte, sah zwei Zahlen für denselben Tag — Erklärungsnot ohne Fehler.
// Seit E9 (a) zeigen alle drei Flächen das Netto, mit demselben Wort.
//
// **Es gibt genau EINE Ableitung, und sie steht hier.** Wer die Zahl anfasst,
// fasst sie für Cockpit, Portfolio und Erlöse-Seite gemeinsam an.

import type { CockpitMoney } from './api';

/**
 * Das Wort für die große Zahl — auf JEDER Fläche dasselbe. Es ist bewusst
 * kein Ertrags-Wort: „unterm Strich" ist die Frage des Kunden („was bleibt
 * mir?"), und der Gesamtertrag beantwortet sie nicht.
 */
export const NETTO_WORT = 'Unterm Strich';

/**
 * Die Eingaben, aus denen sich das Netto ergibt. Beide Endpunkte erfüllen sie:
 * der anlagen-scharfe trägt `nettoErgebnisEur` fertig, der mandantenweite
 * trägt `actualEur` (siehe {@link nettoEur}).
 */
export type NettoQuelle = Pick<
  CockpitMoney,
  'eigenverbrauchsWertEur' | 'nettoErgebnisEur' | 'actualEur'
>;

function zahl(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Das Ergebnis eines Zeitraums „unterm Strich" — `null`, wo nichts berechenbar
 * ist (NIE eine erfundene 0).
 *
 * **Zwei Quellen, EIN Wert.**
 *
 * 1. Der anlagen-scharfe `GET /api/v1/sites/{id}/earnings` liefert
 *    `nettoErgebnisEur` selbst (`SiteEarningsController.netto`, serverseitig
 *    als BigDecimal gerechnet). Er hat immer Vorrang — die Zahl wird nicht
 *    nachgerechnet, sie wird gelesen.
 * 2. Der mandantenweite `GET /api/v1/earnings` (Portfolio) trägt bewusst
 *    KEINE Stromkosten und kein Netto — er beantwortet eine Portfolio-Frage.
 *    Er trägt aber `actualEur`, und der Server sichert die Identität
 *    `stromkostenEur − einspeiseErloesEur = actualEur` exakt zu
 *    (`SiteEarningsDto` Javadoc; „beide Identitäten asserted exactly").
 *    Eingesetzt in `netto = einspeise + eigen − stromkosten` fällt die
 *    Einspeisung heraus:
 *
 *        netto = einspeise + eigen − (actual + einspeise) = eigen − actual
 *
 *    Ein fehlender Eigenverbrauchs-Wert (Anlage ohne bewerteten Tarif) zählt
 *    dabei wie serverseitig als 0 SUMMAND — er löscht die beiden gemessenen
 *    Terme nicht aus.
 *
 * Dass beide Wege dieselbe Zahl ergeben, ist kein Vertrauen, sondern ein Test:
 * `erloesNetto.test.ts` fährt beide über die 15 Fixtures aus
 * `data/vp-erloese-seite-konzept-e2/derived.json`.
 */
export function nettoEur(money: NettoQuelle | null | undefined): number | null {
  if (!money) return null;
  const fertig = zahl(money.nettoErgebnisEur);
  if (fertig != null) return fertig;
  const actual = zahl(money.actualEur);
  if (actual == null) return null;
  return (zahl(money.eigenverbrauchsWertEur) ?? 0) - actual;
}
