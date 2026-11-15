import { useState } from 'react';
import { ApiError } from '../api';
import { api } from '../apiVoll';
import type { ChargingConfig } from '../ladepunkte';
import { ENTFERNEN_HINWEIS, entfernenFolgen, entfernenFrage } from '../ladesaeuleAnbinden';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Die Rückfrage vor der RÜCKNAHME einer Ladesäulen-Kennung
 * (`DELETE …/charging-config/charge-points/{chargePointId}`, Recht
 * `ladepunkt.anbinden` wie der Server-Endpunkt) — GENAU EIN Ort für Frage,
 * Folgen und Hinweis.
 *
 * Herausgelöst aus `LadesaeuleAnbinden` (vp-ladesaeule-entfernen): die
 * Rücknahme ist dieselbe Handlung, ob sie aus der „Schon eingetragen"-Liste,
 * dem Zeilenmenü im Aufbau oder dem „⋯"-Menü der Ladesäulen-Seite kommt - eine
 * zweite Kopie hieße, Frage, Folgen und Fehlerbehandlung zweimal zu pflegen.
 */
export function LadesaeuleEntfernenDialog({
  siteId,
  kennung,
  name,
  confirmLabel = 'Ladesäule entfernen',
  onClose,
  onEntfernt,
}: {
  siteId: string;
  kennung: string;
  name: string;
  confirmLabel?: string;
  onClose: () => void;
  onEntfernt: (config: ChargingConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  async function entfernen() {
    setBusy(true);
    setFehler(null);
    try {
      const c = await api.removeChargePoint(siteId, kennung);
      onEntfernt(c);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Die Kennung konnte nicht entfernt werden.');
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open
      title="Ladesäule entfernen"
      intro={entfernenFrage(name)}
      consequences={[...entfernenFolgen(name), ENTFERNEN_HINWEIS]}
      confirmLabel={confirmLabel}
      tone="danger"
      busy={busy}
      onConfirm={() => void entfernen()}
      onCancel={onClose}
      extra={fehler && (
        <p className="vp-anbinden-error" role="status">
          {fehler}
        </p>
      )}
    />
  );
}
