import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { api, ApiError, deviceLiveStatus, type Device, type Site } from '../api';
import { deviceKindLabel, fmtRelative } from '../format';
import { normalizeDeviceIdInput } from '../Onboarding';

/** Status badge for a device row/detail (zero-touch onboarding states). */
export function DeviceStatusBadge({ device }: { device: Device }) {
  const status = deviceLiveStatus(device);
  if (status === 'online') {
    return (
      <Badge variant="ok" dot>
        online
      </Badge>
    );
  }
  if (status === 'waiting') {
    return (
      <Badge variant="warn" dot>
        wartet auf erste Daten
      </Badge>
    );
  }
  return (
    <Badge variant="off" dot>
      offline
    </Badge>
  );
}

/**
 * ZERO-TOUCH "Gerät hinzufügen" drawer: the customer enters ONLY the
 * Edge-Referenz and picks the Standort - no IDs, no commands, no connection
 * panel. The cloud provisions the physical device over the MQTT handshake
 * (docs/contracts/mqtt-provisioning.schema.json); the row flips to online as
 * soon as the first telemetry arrives.
 */
export function AddDeviceDrawer({
  open,
  onClose,
  sites,
  onClaimed,
}: {
  open: boolean;
  onClose: () => void;
  sites: Site[];
  onClaimed: (device: Device) => void;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [siteId, setSiteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Device | null>(null);

  useEffect(() => {
    if (!siteId && sites[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  async function claim() {
    if (!externalRef.trim() || !siteId) return;
    setBusy(true);
    setError(null);
    try {
      const device = await api.claimDevice(siteId, externalRef.trim());
      setClaimed(device);
      setExternalRef('');
      onClaimed(device);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 422
          ? 'Diese Geräte-ID ist uns nicht bekannt. Bitte vergleichen Sie Ihre Eingabe genau mit dem Aufkleber auf Ihrem Gerät (z. B. VP-1234-ABCD).'
          : e instanceof ApiError && e.status === 409
            ? 'Diese Referenz ist bereits vergeben. Prüfen Sie die Schreibweise auf dem Typenschild.'
            : e instanceof ApiError && e.status === 404
              ? 'Der gewählte Standort wurde nicht gefunden. Bitte laden Sie die Seite neu.'
              : 'Das Gerät konnte nicht hinzugefügt werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setClaimed(null);
    setError(null);
    onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Gerät hinzufügen"
      icon={
        <IconTile category="battery" size={40}>
          <Icon name="zap" size={20} />
        </IconTile>
      }
      footer={
        claimed ? (
          <Button variant="primary" onClick={close}>
            Fertig
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={claim} disabled={busy || !externalRef.trim() || !siteId}>
              {busy ? 'Wird hinzugefügt…' : 'Gerät hinzufügen'}
            </Button>
          </>
        )
      }
    >
      {claimed ? (
        <>
          <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
            Gerät <b>{claimed.externalRef}</b> wurde dem Standort{' '}
            <b>{siteName(claimed.siteId)}</b> zugeordnet.
          </div>
          <p style={{ margin: 'var(--vp-space-4) 0' }}>
            Mehr ist nicht zu tun: sobald das Gerät mit dieser Referenz online geht,
            erhält es seine Konfiguration automatisch und beginnt zu senden.
          </p>
          <ul className="vp-checklist">
            <li>
              <span className="mk">
                <Icon name="check" size={13} strokeWidth={3} />
              </span>
              <div>
                <b>Gerät registriert</b>
                <div className="vp-note">
                  Zugeordnet zu Standort {siteName(claimed.siteId)}.
                </div>
              </div>
            </li>
            <li>
              <span className="mk todo">2</span>
              <div>
                <b>Gerät einschalten</b>
                <div className="vp-note">
                  Das Gerät meldet sich mit seiner Referenz an und wird automatisch
                  konfiguriert - keine IDs, kein Kopieren.
                </div>
              </div>
            </li>
            <li>
              <span className="mk todo">3</span>
              <div>
                <b>Auf erste Daten warten</b>
                <div className="vp-note">
                  Sobald erste Messwerte eintreffen, wechselt der Status automatisch von{' '}
                  <Badge variant="warn" dot style={{ fontSize: '0.7rem' }}>
                    wartet auf erste Daten
                  </Badge>{' '}
                  auf{' '}
                  <Badge variant="ok" dot style={{ fontSize: '0.7rem' }}>
                    online
                  </Badge>
                  .
                </div>
              </div>
            </li>
          </ul>
        </>
      ) : (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Geben Sie die Referenz ein, die auf dem Gerät steht (Typenschild bzw.
            Konfiguration). Das Gerät verbindet sich selbst - Sie müssen keine IDs
            übertragen.
          </p>
          <div className="vp-form-stack">
            <Input
              label="Edge-Referenz *"
              placeholder="z. B. edge-inverter-42"
              value={externalRef}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setExternalRef(normalizeDeviceIdInput(e.target.value))
              }
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <label htmlFor="claim-site" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                Standort
              </label>
              <select
                id="claim-site"
                className="vp-select"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {sites.length === 0 && (
            <div className="vp-alert vp-alert-info">
              Sie haben noch keinen Standort - legen Sie zuerst unter „Standorte“ einen an.
            </div>
          )}
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      )}
    </Drawer>
  );
}

/** Device detail drawer (row click): reference, site, status, last data. */
export function DeviceDetailDrawer({
  device,
  sites,
  onClose,
}: {
  device: Device | null;
  sites: Site[];
  onClose: () => void;
}) {
  if (!device) return null;
  const site = sites.find((s) => s.id === device.siteId);
  const status = deviceLiveStatus(device);

  return (
    <Drawer
      open
      onClose={onClose}
      title={device.externalRef}
      icon={
        <IconTile category="battery" size={40}>
          <Icon name="zap" size={20} />
        </IconTile>
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Schließen
        </Button>
      }
    >
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', flexWrap: 'wrap', marginBottom: 'var(--vp-space-5)' }}>
        <DeviceStatusBadge device={device} />
        <Badge variant="tint">{deviceKindLabel(device.kind)}</Badge>
        {site && <Badge variant="tint">{site.name}</Badge>}
      </div>

      <table className="vp-table">
        <tbody>
          <tr>
            <th scope="row">Referenz</th>
            <td className="vp-mono">{device.externalRef}</td>
          </tr>
          <tr>
            <th scope="row">Typ</th>
            <td>{deviceKindLabel(device.kind)}</td>
          </tr>
          <tr>
            <th scope="row">Standort</th>
            <td>{site?.name ?? device.siteId.slice(0, 8)}</td>
          </tr>
          <tr>
            <th scope="row">Zuletzt gesehen</th>
            <td>{fmtRelative(device.lastSeenAt)}</td>
          </tr>
        </tbody>
      </table>

      {status === 'waiting' && (
        <div className="vp-alert vp-alert-info">
          Das Gerät wurde beansprucht, hat aber noch keine Daten gesendet. Schalten
          Sie es ein - es konfiguriert sich automatisch über seine Referenz und der
          Status wechselt auf <b>online</b>, sobald Messwerte eintreffen.
        </div>
      )}
      {status === 'stale' && (
        <div className="vp-alert vp-alert-info">
          Seit über 5 Minuten keine Daten. Prüfen Sie Stromversorgung und
          Netzwerk des Geräts; nach dem Neustart konfiguriert es sich automatisch neu.
        </div>
      )}
    </Drawer>
  );
}
