import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Device, type DeviceMovePreview, type MoveProvisioningStatus } from '../api';
import { AnlegenDialog } from './AnlegenDialog';
import './AnlegenFlow.css';

/** Der bewusst getrennte D8-Flow: Standort ist kein Feld des Edit-Assistenten. */
export function GeraetVerschiebenDialog({ device, onClose, onMoved }: {
  device: Device;
  onClose: () => void;
  onMoved: (device: Device) => void;
}) {
  const [preview, setPreview] = useState<DeviceMovePreview | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<MoveProvisioningStatus | null>(null);
  const target = useMemo(
    () => preview?.targets.find((option) => option.siteId === targetId) ?? null,
    [preview, targetId],
  );

  useEffect(() => {
    let active = true;
    api.deviceMovePreview(device.id).then(
      (result) => active && setPreview(result),
      (cause) => active && setError(cause instanceof ApiError ? cause.message : 'Die Topologieprüfung ist fehlgeschlagen.'),
    );
    return () => { active = false; };
  }, [device.id]);

  useEffect(() => {
    if (!applyStatus || applyStatus.status !== 'pending') return;
    let active = true;
    const timer = window.setInterval(() => {
      api.deviceMoveStatus(device.id).then((next) => {
        if (!active) return;
        setApplyStatus(next);
        if (next?.status === 'applied' || next?.status === 'refused') {
          setBusy(false);
        }
      }).catch(() => { /* transient offline state remains visible */ });
    }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [applyStatus, device.id]);

  async function move() {
    if (!preview || !target?.allowed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.moveDevice(device.id, {
        targetSiteId: target.siteId,
        expectedRevision: preview.revision,
        effectiveAt: new Date().toISOString(),
      });
      const status = await api.deviceMoveStatus(device.id);
      setApplyStatus(status);
      if (status?.status === 'applied' || status?.status === 'refused') onMoved(result);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Das Gerät konnte nicht verschoben werden.');
      // Bei 409 nie mit veralteter Prüfung weiterarbeiten.
      try {
        const fresh = await api.deviceMovePreview(device.id);
        setPreview(fresh);
        setTargetId(null);
        setStep(1);
      } catch { /* Der konkrete Fehler bleibt sichtbar. */ }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AnlegenDialog
      titel="Gerät verschieben"
      schritte={['Ziel prüfen', 'Bestätigen']}
      aktiv={step}
      onClose={onClose}
      onBack={step === 2 ? () => setStep(1) : null}
      footer={step === 1 ? (
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button disabled={!target?.allowed} onClick={() => setStep(2)}>Weiter</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={() => setStep(1)}>Zurück</Button>
          <Button disabled={busy || !target} onClick={() => void move()}>
            {busy ? 'Verschiebe …' : 'Jetzt verschieben'}
          </Button>
        </>
      )}
    >
      {step === 1 ? (
        <section>
          <h3 className="vp-assist-h">Wohin soll das Gerät?</h3>
          <p className="vp-assist-sub">VoltPilot prüft den Zielstandort auf eine widerspruchsfreie Gerätetopologie.</p>
          {!preview && !error && <p role="status">Prüfe Standorte …</p>}
          <div className="vp-move-targets" role="radiogroup" aria-label="Zielstandort">
            {preview?.targets.map((option) => (
              <label key={option.siteId} className={`vp-move-target${option.allowed ? '' : ' is-blocked'}`}>
                <input
                  type="radio"
                  name="move-target"
                  value={option.siteId}
                  checked={targetId === option.siteId}
                  disabled={!option.allowed}
                  onChange={() => setTargetId(option.siteId)}
                />
                <span><strong>{option.name}</strong>{option.reason && <small>{option.reason}</small>}</span>
              </label>
            ))}
          </div>
          {preview?.targets.length === 0 && <p className="vp-assist-help">Es gibt keinen weiteren Standort in diesem Konto.</p>}
        </section>
      ) : (
        <section>
          <h3 className="vp-assist-h">Umzug bestätigen</h3>
          <div className="vp-edit-effects">
            <strong>{device.name || device.externalRef} → {target?.name}</strong>
            <ul>
              <li>Wirksam sofort nach dem atomaren Speichern.</li>
              <li>Geräte-ID, Claim, Messhistorie, Transaktionen, Befehle und Audit bleiben erhalten.</li>
              <li>Ein Tenantwechsel ist ausgeschlossen.</li>
              <li>Die Konfiguration wird am Ziel neu verteilt; bis dahin bleibt die bisherige Gerätefassung aktiv.</li>
            </ul>
            {applyStatus && <p role="status">Provisionierung: {applyStatus.status === 'applied' ? 'angewandt' : applyStatus.status === 'refused' ? 'abgelehnt' : 'ausstehend'}{applyStatus.lastError ? ` – ${applyStatus.lastError}` : ''}</p>}
          </div>
        </section>
      )}
      {error && <p className="vp-assist-error" role="alert"><Icon name="alert-triangle" size={15} /> {error}</p>}
    </AnlegenDialog>
  );
}
