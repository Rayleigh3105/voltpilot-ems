import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi, type ProvisionedDevice } from '../../admin/adminApi';
import { normalizeDeviceIdInput } from '../../Onboarding';
import { deviceKindLabel } from '../../format';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

/**
 * Plattform → Geräte-Registry: the manufacturing registry of sticker
 * Geräte-IDs (platform-wide, not per-tenant). Customers can only connect
 * device IDs registered here, so a typo'd ID fails fast in the portal instead
 * of creating a ghost device. New IDs are registered when devices are
 * produced/shipped.
 */
export function GeraeteRegistryPage() {
  const [devices, setDevices] = useState<ProvisionedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function reload() {
    setError(null);
    try {
      setDevices(await adminApi.listProvisionedDevices());
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    }
  }

  async function remove(d: ProvisionedDevice) {
    if (!window.confirm(`Geräte-ID „${d.externalRef}“ aus der Registry entfernen? Sie kann danach von keinem Kunden mehr verbunden werden.`)) {
      return;
    }
    setError(null);
    try {
      await adminApi.deleteProvisionedDevice(d.externalRef);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? `„${d.externalRef}“ ist bereits mit einem Kundenkonto verbunden und kann nicht entfernt werden. Der Kunde (oder Sie über die Mandanten-Ansicht) muss das Gerät zuerst entfernen.`
          : e instanceof ApiError
            ? `Entfernen fehlgeschlagen: ${e.message}`
            : 'Entfernen fehlgeschlagen. Bitte versuchen Sie es erneut.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Geräte-Registry</h1>
          <p>
            Produzierte Geräte mit ihrer Aufkleber-ID registrieren - Kunden können nur
            registrierte Geräte-IDs verbinden, Tippfehler werden sofort abgewiesen.
          </p>
        </div>
        <div className="actions">
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
            Geräte-ID registrieren
          </Button>
        </div>
      </div>

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {devices == null ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">Lade Geräte-Registry…</p>
        </Card>
      ) : devices.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch keine Geräte registriert. Registrieren Sie die erste Geräte-ID.
          </p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Geräte-ID</th>
                <th>Typ</th>
                <th>Notiz</th>
                <th>Registriert</th>
                <th>Status</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.externalRef}>
                  <td data-label="Geräte-ID" className="vp-mono">
                    {d.externalRef}
                  </td>
                  <td data-label="Typ">{deviceKindLabel(d.kind)}</td>
                  <td data-label="Notiz">{d.note ?? '-'}</td>
                  <td data-label="Registriert">{fmtDate(d.provisionedAt)}</td>
                  <td data-label="Status">
                    {d.claimed ? (
                      <Badge variant="ok" dot title={d.claimedByTenant ?? undefined}>
                        verbunden{d.claimedByTenant ? ` · ${d.claimedByTenant}` : ''}
                      </Badge>
                    ) : (
                      <Badge variant="off" dot>
                        noch nicht verbunden
                      </Badge>
                    )}
                  </td>
                  <td data-label="" style={{ textAlign: 'right' }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(d)}
                      disabled={d.claimed}
                      title={
                        d.claimed
                          ? 'Verbundene Geräte-IDs können nicht entfernt werden - das Gerät muss zuerst vom Kundenkonto getrennt werden.'
                          : undefined
                      }
                      style={d.claimed ? undefined : { color: 'var(--vp-industry-end)' }}
                    >
                      Entfernen
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ProvisionDeviceDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => void reload()}
      />
    </>
  );
}

function ProvisionDeviceDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [kind, setKind] = useState('inverter');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^vp-/i.test(externalRef.trim());

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.provisionDevice({
        externalRef: externalRef.trim(),
        kind,
        note: note.trim() || undefined,
      });
      setExternalRef('');
      setNote('');
      onCreated();
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Geräte-ID. Sie muss mit VP- beginnen (Aufkleber-Format).'
          : 'Das Registrieren hat nicht geklappt. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Geräte-ID registrieren"
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="zap" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Registriere…' : 'Geräte-ID registrieren'}
          </Button>
        </>
      }
    >
      <p className="vp-note" style={{ marginTop: 0 }}>
        Die ID vom Geräte-Aufkleber (Format VP-XXXX-XXXX). Bereits registrierte IDs werden
        unverändert übernommen.
      </p>
      <div className="vp-form-stack">
        <Input
          label="Geräte-ID *"
          placeholder="z. B. VP-1234-ABCD"
          value={externalRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setExternalRef(normalizeDeviceIdInput(e.target.value))
          }
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="provision-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Typ
          </label>
          <select
            id="provision-kind"
            className="vp-select"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="inverter">Wechselrichter</option>
            <option value="battery">Batteriespeicher</option>
            <option value="meter">Zähler</option>
          </select>
        </div>
        <Input
          label="Notiz"
          placeholder="z. B. Charge 2026-07"
          value={note}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}
