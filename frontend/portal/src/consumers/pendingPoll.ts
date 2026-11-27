/**
 * Ob eine Fläche gerade auf das Ergebnis einer gesendeten Schaltung wartet - das Signal, das den Poll-Takt zwischen
 * {@link SCHNELL_POLL_MS} und {@link LIVE_POLL_MS} wählt (pollCadence.ts, Captain-Befunde vp-schalten-sofort und
 * vp-schalten-3s).
 *
 * Generisch über jeden schaltbaren Verbraucher: Shelly-Relais, Heizstab je Phase, go-e-Wallbox und jeder weitere Typ.
 * Gewartet wird, solange der gemeldete Zustand den WUNSCH des Handeingriffs nicht bestätigt - nach derselben Regel wie
 * die Schaltspur der API ({@link spurUrteil}, gemeinsame Vektoren). Bis 27.11.2026 hing das allein an
 * `confirmed === true`; das war aber schon für den VORIGEN Stand wahr (ein Heizstab, dessen L1 von Hand an war, meldet
 * `confirmed: true`, während „Aus“ noch unterwegs ist) - die Fläche fiel dann sofort auf den Live-Takt zurück.
 *
 * Auch ein gehaltener Wunsch (Mindestlauf, Mindestpause) hält den schnellen Takt: endet die Schutzregel, schaltet die
 * Box, und das soll die Fläche zügig zeigen.
 */

import type { ManualOverride } from './fulfillment';
import { spurUrteil, type SpurWunsch } from './schaltspur';
import type { ConsumerRuntimeStatus } from './status';

type Eingriff = Pick<ManualOverride, 'entityId'> & Partial<Pick<ManualOverride, 'kind' | 'targetCommand'
  | 'targetValue' | 'targetOutputs'>>;

/** Der Wunsch eines laufenden Handeingriffs, wie die Schaltspur ihn prüft. */
export function wunschDes(o: Eingriff): SpurWunsch {
  return {
    art: o.kind === 'stop' ? 'stop' : 'start',
    kommando: o.targetCommand === 'on_off' || o.targetCommand === 'setpoint_kw' ? o.targetCommand : null,
    wert: o.targetValue ?? null,
    ausgaenge: o.targetOutputs ?? null,
  };
}

export function wartetAufBestaetigung(
  overrides: readonly Eingriff[] | null | undefined,
  status: readonly ConsumerRuntimeStatus[] | null | undefined,
): boolean {
  if (!overrides || overrides.length === 0) return false;
  const byId = new Map((status ?? []).map((s) => [s.entityId, s]));
  return overrides.some((o) => spurUrteil(wunschDes(o), byId.get(o.entityId)) !== 'bestaetigt');
}
