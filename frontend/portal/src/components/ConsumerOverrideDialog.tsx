/**
 * Die Rückfrage für eine SOFORTAKTION (§14.13 "Jetzt starten"/"Jetzt stoppen"/
 * "Automatik fortsetzen") - das Haus-Muster von ConfirmDialog (ein Drawer mit
 * Folgenliste), erweitert um die für einen Start/Stopp PFLICHTIGE Dauer. Der
 * Eingriff ist zeitlich begrenzt (§16), also verlangt der Dialog eine Endzeit,
 * bevor „Bestätigen" möglich ist. Reine Anzeige - die Ableitung kommt aus
 * `consumers/fulfillment.ts`.
 */
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import {
  OVERRIDE_DURATIONS,
  RESUME_CONSEQUENCES,
  STOP_CONSEQUENCES,
  startConsequences,
  type SofortAktion,
} from '../consumers/fulfillment';

export function ConsumerOverrideDialog({
  action,
  consumerName,
  effectivePowerKw,
  busy,
  onConfirm,
  onCancel,
}: {
  action: SofortAktion | null;
  consumerName: string;
  effectivePowerKw?: number | null;
  busy?: boolean;
  /** For start/stop the chosen duration in minutes; for resume, undefined. */
  onConfirm: (durationMinutes?: number) => void;
  onCancel: () => void;
}): JSX.Element | null {
  const [minutes, setMinutes] = useState(30);
  if (!action) return null;

  const needsDuration = action === 'start' || action === 'stop';
  const title =
    action === 'start' ? `„${consumerName}" jetzt starten`
      : action === 'stop' ? `„${consumerName}" jetzt stoppen`
        : `„${consumerName}": Automatik fortsetzen`;
  const consequences =
    action === 'start' ? startConsequences(effectivePowerKw)
      : action === 'stop' ? STOP_CONSEQUENCES
        : RESUME_CONSEQUENCES;

  return (
    <Drawer open onClose={onCancel} title={title}>
      <div className="vp-vb-override-dialog">
        <ul className="vp-vb-consequences">
          {consequences.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {needsDuration && (
          <label className="vp-vb-duration">
            <span>Wie lange?</span>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              aria-label="Dauer des Eingriffs"
            >
              {OVERRIDE_DURATIONS.map((d) => (
                <option key={d.minutes} value={d.minutes}>{d.label}</option>
              ))}
            </select>
          </label>
        )}
        <div className="vp-vb-dialog-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Abbrechen</Button>
          <Button
            onClick={() => onConfirm(needsDuration ? minutes : undefined)}
            disabled={busy}
          >
            {busy ? 'Wird gesendet…' : 'Bestätigen'}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
