/**
 * „Ladungen“ auf dem Reiter Laden (Konzept „Ein Ort fürs Laden" e1, Abschnitt
 * 4.1 Punkt 5, Scheibe 1): zuerst nur die kWh aus den vorhandenen
 * OCPP-Ladevorgängen - Herkunft, Euro und Sonnenanteil kommen erst mit der
 * eigenen Server-Route aus Scheibe 2 (gleiche Preisgrundlage wie die Erlöse).
 *
 * ⚠ Eine kWh-Zahl entsteht nur aus einem GEMESSENEN Zählerstandspaar
 * (`meterStart`/`meterStop`), nie aus einer laufenden Sitzung - dieselbe
 * Rechnung wie `completedEnergy` auf der Geräteseite (`OcppWallboxPage.tsx`),
 * hier als reine Ableitung statt als Komponentenhilfsfunktion dupliziert.
 */
import type { OcppTransaction } from '../api';

/** Die geladene Menge einer beendeten Sitzung - `null` ohne beide Zählerstände oder bei einem negativen/kaputten Delta. */
export function transaktionsKwh(t: Pick<OcppTransaction, 'meterStart' | 'meterStop'>): number | null {
  if (t.meterStop == null || !Number.isFinite(t.meterStart)) return null;
  const delta = t.meterStop - t.meterStart;
  return Number.isFinite(delta) && delta >= 0 ? delta / 1000 : null;
}

export interface LadungZeile {
  key: string;
  /** Wann die Ladung begann (ISO) - die Fläche formatiert, diese Schicht nicht. */
  startedAt: string;
  /** `null` = Menge nicht bestimmbar (fehlender/unplausibler Zählerstand), nie 0 geraten. */
  kwh: number | null;
}

/** Die letzten `n` BEENDETEN Ladungen eines Ladepunkts, neueste zuerst. */
export function letzteLadungen(
  transactions: readonly OcppTransaction[] | null | undefined,
  chargePointId: string,
  n = 3,
): LadungZeile[] {
  return (transactions ?? [])
    .filter((t) => t.chargePointId === chargePointId && t.stoppedAt != null)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, n)
    .map((t) => ({ key: `${t.chargePointId}-${t.transactionId}`, startedAt: t.startedAt, kwh: transaktionsKwh(t) }));
}
