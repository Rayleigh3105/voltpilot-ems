import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  deviceLiveStatus,
  deviceWaitedTooLong,
  type Device,
  type DevicePurgeResult,
  type Site,
} from '../api';
import { deviceKindLabel, fmtRelative } from '../format';
import { DangerZone } from './DangerZone';
import { VpPicker } from './VpPicker';
import { HelpLink } from '../help/HelpProvider';
import { normalizeDeviceIdInput, DEVICE_ID_FIELD, DEVICE_ID_UNKNOWN_MSG } from '../anlageFlow';

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
 * Edge-Referenz and picks the Anlage - no IDs, no commands, no connection
 * panel. The cloud provisions the physical device over the MQTT handshake
 * (docs/contracts/mqtt-provisioning.schema.json); the row flips to online as
 * soon as the first telemetry arrives.
 */
export function AddDeviceDrawer({
  open,
  onClose,
  sites,
  onClaimed,
  title = 'Gerät hinzufügen',
}: {
  open: boolean;
  onClose: () => void;
  sites: Site[];
  onClaimed: (device: Device) => void;
  /** Titel und Knopf; der Aufbau nennt die Box beim Namen („VoltPilot-Box hinzufügen"). */
  title?: string;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [siteId, setSiteId] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<Device | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!siteId && sites[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  async function claim() {
    if (busy || !siteId) return;
    if (!externalRef.trim()) {
      // Mirror RegisterForm: keep the button live, point at the empty field (m6).
      setRefTouched(true);
      refInput.current?.focus();
      return;
    }
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
          ? DEVICE_ID_UNKNOWN_MSG
          : e instanceof ApiError && e.status === 409
            ? 'Diese Geräte-ID ist bereits mit einem anderen Konto verbunden. Bitte prüfen Sie die Schreibweise - oder kontaktieren Sie unseren Support.'
            : e instanceof ApiError && e.status === 404
              ? 'Die gewählte Anlage wurde nicht gefunden. Bitte laden Sie die Seite neu.'
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
    <Modal
      open={open}
      onClose={close}
      title={title}
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
            <Button variant="primary" onClick={claim} disabled={busy || !siteId}>
              {busy ? 'Wird hinzugefügt…' : title}
            </Button>
          </>
        )
      }
    >
      {claimed ? (
        <>
          <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
            Gerät <b>{claimed.externalRef}</b> wurde der Anlage{' '}
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
                  Zugeordnet zur Anlage {siteName(claimed.siteId)}.
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
            {DEVICE_ID_FIELD.help} Das Gerät verbindet sich selbst - Sie müssen keine
            IDs übertragen.
          </p>
          <HelpLink article="box-verbinden">Hilfe beim Verbinden</HelpLink>
          <div className="vp-form-stack">
            <Input
              ref={refInput}
              label={`${DEVICE_ID_FIELD.label} *`}
              placeholder={DEVICE_ID_FIELD.placeholder}
              value={externalRef}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setExternalRef(normalizeDeviceIdInput(e.target.value));
                if (refTouched) setRefTouched(false);
              }}
              onBlur={() => setRefTouched(true)}
              error={refTouched && !externalRef.trim() ? 'Bitte geben Sie die Geräte-ID ein.' : null}
            />
            <VpPicker
              id="claim-site"
              label="Anlage"
              options={sites.map((s) => ({ value: s.id, label: s.name }))}
              value={siteId}
              onChange={setSiteId}
              searchPlaceholder="Anlage suchen …"
            />
          </div>
          {sites.length === 0 && (
            <div className="vp-alert vp-alert-info">
              Sie haben noch keine Anlage - legen Sie zuerst unter „Meine Anlage“ eine an.
            </div>
          )}
          {error && <div className="vp-alert vp-alert-err">{error}</div>}
        </>
      )}
    </Modal>
  );
}

/**
 * What removing a device actually takes away - ONE list, used by BOTH unclaim
 * entry points (the danger zone at the foot of the drawer AND the shortcut in
 * the "waiting too long" alert). The E3 Nebenwirkungs-Regel: an action that
 * devalues something else names the consequence BEFORE it runs, so the two
 * paths must never be able to promise different things.
 */
export function unclaimConsequences(device: Device): string[] {
  const name = device.name || device.externalRef;
  return [
    `Das Gerät „${name}" wird von Ihrem Konto getrennt`,
    'Alle aufgezeichneten Messdaten dieses Geräts werden gelöscht',
    'Das physische Gerät verliert seinen Fahrplan und fällt in den sicheren Standardbetrieb zurück',
  ];
}

/**
 * Device detail drawer (row click): reference, site, status, last data - plus
 * "Bearbeiten" (type + label; the reference is the immutable identity) and the
 * unclaim delete with an explicit consequence list.
 */
export function DeviceDetailDrawer({
  device,
  sites,
  onClose,
  onChanged,
}: {
  device: Device | null;
  sites: Site[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeDone, setPurgeDone] = useState<DevicePurgeResult | null>(null);

  useEffect(() => {
    setEditing(false);
    setDeleteError(null);
    setPurgeError(null);
    setPurgeDone(null);
  }, [device?.id]);

  if (!device) return null;
  const site = sites.find((s) => s.id === device.siteId);
  const status = deviceLiveStatus(device);
  const waitedTooLong = deviceWaitedTooLong(device);

  async function unclaim(d: Device) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteDevice(d.id);
      onClose();
      onChanged();
    } catch {
      setDeleteError('Das Gerät konnte nicht entfernt werden. Bitte versuchen Sie es erneut.');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function purgeData(d: Device) {
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      const result = await api.purgeDeviceData(d.id);
      setPurgeDone(result);
      onChanged();
    } catch {
      setPurgeError(
        'Die Datenaufzeichnungen konnten nicht gelöscht werden. Bitte versuchen Sie es erneut.'
      );
    } finally {
      setPurgeBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={device.name || device.externalRef}
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
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Icon name="pencil" size={16} />}
            onClick={() => setEditing(true)}
            style={{ marginLeft: 'auto' }}
          >
            Bearbeiten
          </Button>
        )}
      </div>

      {editing ? (
        <DeviceEditForm
          device={device}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <>
          <table className="vp-table">
            <tbody>
              <tr>
                <th scope="row">Referenz</th>
                <td className="vp-mono">{device.externalRef}</td>
              </tr>
              <tr>
                <th scope="row">Bezeichnung</th>
                <td>{device.name ?? <span className="vp-muted">-</span>}</td>
              </tr>
              <tr>
                <th scope="row">Typ</th>
                <td>{deviceKindLabel(device.kind)}</td>
              </tr>
              <tr>
                <th scope="row">Anlage</th>
                <td>{site?.name ?? device.siteId.slice(0, 8)}</td>
              </tr>
              <tr>
                <th scope="row">Zuletzt gesehen</th>
                <td>{fmtRelative(device.lastSeenAt)}</td>
              </tr>
            </tbody>
          </table>

          {status === 'waiting' && !waitedTooLong && (
            <div className="vp-alert vp-alert-info">
              Das Gerät ist mit Ihrem Konto verbunden, hat aber noch keine Daten gesendet. Schalten
              Sie es ein - es konfiguriert sich automatisch über seine Referenz und der
              Status wechselt auf <b>online</b>, sobald Messwerte eintreffen.
            </div>
          )}
          {status === 'waiting' && waitedTooLong && (
            <div className="vp-alert vp-alert-warn">
              <b>Seit der Verbindung ({fmtRelative(device.createdAt)}) sind noch keine
              Daten eingetroffen.</b> Das ist ungewöhnlich lange. Häufige Ursachen:
              <ul style={{ margin: '8px 0 12px', paddingLeft: '1.2em' }}>
                <li>
                  Die Geräte-ID wurde vertippt - vergleichen Sie{' '}
                  <span className="vp-mono">{device.externalRef}</span> Zeichen für Zeichen
                  mit der ID, die Ihr Gerät anzeigt.
                </li>
                <li>Das Gerät ist nicht mit Strom oder Internet verbunden.</li>
                <li>Der Wechselrichter ist am Gerät noch nicht eingerichtet.</li>
              </ul>
              Bei einer vertippten ID entfernen Sie das Gerät und verbinden es mit der
              korrekten ID neu.
              {/*
                This shortcut removes the device just like the danger zone below,
                so it goes through the SAME consequence list and confirm step -
                before it used to unclaim on a single click, which silently
                deleted every recorded measurement of that device.
              */}
              <DangerZone
                variant="inline"
                actionLabel="Gerät entfernen und neu verbinden"
                consequences={unclaimConsequences(device)}
                confirmLabel="Gerät endgültig entfernen"
                busy={deleteBusy}
                error={deleteError}
                onConfirm={() => void unclaim(device)}
              />
            </div>
          )}
          {status === 'stale' && (
            <div className="vp-alert vp-alert-info">
              Seit über 5 Minuten keine Daten. Prüfen Sie Stromversorgung und
              Netzwerk des Geräts; nach dem Neustart konfiguriert es sich automatisch neu.
            </div>
          )}

          {purgeDone ? (
            <div className="vp-alert vp-alert-ok" style={{ marginTop: 'var(--vp-space-5)' }}>
              <b>Datenaufzeichnungen gelöscht.</b> Alle bisherigen Messdaten dieses
              Geräts wurden unwiderruflich entfernt
              {purgeDone.purgedRows > 0 ? ` (${purgeDone.purgedRows.toLocaleString('de-DE')} Datenpunkte)` : ''}.
              {' '}
              {purgeDone.deviceNotified
                ? 'Das Gerät leert seinen lokalen Zwischenspeicher automatisch - sofort, oder sobald es das nächste Mal online ist.'
                : 'Das Gerät wird benachrichtigt, sobald die Verbindung zur Geräte-Cloud wieder steht; ältere Messwerte werden bis dahin nicht mehr angenommen.'}
              {' '}Neue Messwerte werden ab jetzt wieder normal aufgezeichnet.
            </div>
          ) : (
            <DangerZone
              actionLabel="Datenaufzeichnungen löschen"
              description="Löscht alle bisher aufgezeichneten Messdaten dieses Geräts unwiderruflich. Das Gerät bleibt verbunden und zeichnet ab sofort wieder neu auf."
              consequences={[
                `Alle Messdaten von „${device.name || device.externalRef}" werden endgültig gelöscht - auch aus Verlauf, Historie und Statistiken`,
                'Auch der lokale Zwischenspeicher auf dem Gerät wird geleert; ist das Gerät gerade offline, passiert das automatisch beim nächsten Verbinden',
                'Das Gerät selbst bleibt verbunden und funktioniert unverändert weiter - neue Messwerte laufen normal ein',
              ]}
              confirmLabel="Datenaufzeichnungen endgültig löschen"
              typeToConfirm={device.name || device.externalRef}
              busy={purgeBusy}
              error={purgeError}
              onConfirm={() => void purgeData(device)}
            />
          )}

          <DangerZone
            actionLabel="Gerät entfernen"
            description="Falsches Gerät verbunden? Entfernen macht die Geräte-ID wieder frei - sie kann danach erneut (auch von einem anderen Konto) verbunden werden."
            consequences={unclaimConsequences(device)}
            confirmLabel="Gerät endgültig entfernen"
            busy={deleteBusy}
            error={deleteError}
            onConfirm={() => void unclaim(device)}
          />
        </>
      )}
    </Modal>
  );
}

/**
 * Inline edit form: type + Bezeichnung only. The Referenz is deliberately not
 * editable - it is the device's identity (sticker/topics); a wrong reference
 * is fixed by removing the device and connecting the right one.
 */
function DeviceEditForm({
  device,
  onCancel,
  onSaved,
}: {
  device: Device;
  onCancel: () => void;
  onSaved: (updated: Device) => void;
}) {
  const [kind, setKind] = useState(device.kind);
  const [name, setName] = useState(device.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.updateDevice(device.id, { kind, name: name.trim() || null });
      onSaved(updated);
    } catch {
      setError('Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 'var(--vp-space-4)' }}>
      <div className="vp-form-stack">
        <Input label="Referenz" value={device.externalRef} disabled readOnly
          hint="Die Referenz ist die Identität des Geräts und kann nicht geändert werden. Falsche Referenz? Entfernen Sie das Gerät und verbinden Sie das richtige." />
        <Input
          label="Bezeichnung"
          placeholder="z. B. Wechselrichter Garage"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <VpPicker
          id="edit-device-kind"
          label="Typ"
          options={[
            { value: 'inverter', label: 'Wechselrichter' },
            { value: 'battery', label: 'Batteriespeicher' },
            { value: 'meter', label: 'Zähler' },
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button>
      </div>
    </div>
  );
}
