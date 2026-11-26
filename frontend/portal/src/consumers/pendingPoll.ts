/**
 * Ob eine Fläche gerade auf die Bestätigung einer gesendeten Schaltung
 * wartet - das Signal, das den Poll-Takt zwischen {@link SCHNELL_POLL_MS}
 * und {@link LIVE_POLL_MS} wählt (pollCadence.ts, Captain-Befund
 * vp-schalten-sofort).
 *
 * Generisch über jeden schaltbaren Verbraucher: Shelly-Relais, Heizstab je
 * Phase, go-e-Wallbox und jeder weitere Typ melden denselben tri-state
 * `confirmed` auf ihrem `ConsumerRuntimeStatus`. `confirmed === true` ist der
 * EINZIGE Wert, der den schnellen Takt beendet - fehlt er (noch nicht
 * zurückgelesen) oder steht er auf `false` (eine Abweichung, z. B. ein
 * klemmendes Relais), bleibt der Takt schnell: sowohl der ehrliche
 * Zwischenstand als auch ein ehrlicher Fehlschlag sollen die Fläche zügig
 * erreichen, nicht erst nach dem normalen Takt.
 */

import type { ManualOverride } from './fulfillment';
import type { ConsumerRuntimeStatus } from './status';

export function wartetAufBestaetigung(
  overrides: readonly Pick<ManualOverride, 'entityId'>[] | null | undefined,
  status: readonly Pick<ConsumerRuntimeStatus, 'entityId' | 'confirmed'>[] | null | undefined,
): boolean {
  if (!overrides || overrides.length === 0) return false;
  const byId = new Map((status ?? []).map((s) => [s.entityId, s.confirmed]));
  return overrides.some((o) => byId.get(o.entityId) !== true);
}
