import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { KpiCard } from '../../../designsystem/components/shell/KpiCard';
import { ApiError } from '../../api';
import { adminApi, type PendingEnrollment, type ProvisionedDevice } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';
import { normalizeDeviceIdInput } from '../../anlageFlow';
import { deviceKindLabel, fmtRelative } from '../../format';
import { funnelStages, pendingRows } from '../../onboardingFunnel';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('de-DE');

/**
 * Plattform → Geräte-Registry: der Onboarding-FUNNEL eines Geräts, nicht mehr
 * nur seine Manufacturing-Registry.
 *
 * Drei Stufen: **registriert** (die Aufkleber-ID steht hier, nur sie kann ein
 * Kunde verbinden — ein Tippfehler wird sofort abgewiesen statt ein Geist-Gerät
 * anzulegen) → **wartet auf Zuordnung** (das Gerät hat sich gemeldet, aber kein
 * Claim passt: das Tippfehler-Fenster) → **verbunden**.
 *
 * Die mittlere Stufe war bis zum Admin-Umbau (Stufe 1, B3) unsichtbar, obwohl
 * `GET /api/v1/admin/enrollments/pending` seit dem Enrollment-Bau existiert —
 * ein Gerät „tat seinen Teil", während der Kunde eine andere Referenz tippte,
 * und beide Seiten sahen davon nichts.
 */
export function GeraeteRegistryPage() {
  const [devices, setDevices] = useState<ProvisionedDevice[] | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[] | null>(null);
  // Getrennt von `pending === null` (= lädt noch), damit ein Fehlschlag als
  // Fehlschlag steht und nie als "niemand wartet" gelesen wird.
  const [pendingFailed, setPendingFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Load failure kept distinct from action errors (and from the loading `null`)
  // so a failed load shows a retryable ErrorState, not a permanent skeleton.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  async function reload() {
    setError(null);
    setLoadError(null);
    try {
      setDevices(await adminApi.listProvisionedDevices());
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Die Registry konnte nicht geladen werden.');
    }
    // Die wartenden Geräte sind eine EIGENE Wahrheit: fällt ihr Abruf aus,
    // bleibt die Registry darunter benutzbar (und die Sektion sagt selbst, dass
    // sie gerade nichts weiß) - nie eine leere Liste, die „niemand wartet"
    // behaupten würde.
    try {
      setPending(await adminApi.listPendingEnrollments());
      setPendingFailed(false);
    } catch {
      setPending(null);
      setPendingFailed(true);
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

  const registerButton = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
      Geräte-ID registrieren
    </Button>
  );

  return (
    <>
      <AdminPageHead
        icon="list"
        category="primary"
        title="Geräte-Registry"
        description="Der Weg eines Geräts: registrieren - Kunde verbindet es - es liefert Daten. Kunden können nur registrierte Geräte-IDs verbinden, Tippfehler werden sofort abgewiesen."
        actions={registerButton}
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      <FunnelStrip devices={devices ?? []} pending={pending ?? []} known={devices != null} />

      <PendingEnrollments rows={pending} failed={pendingFailed} onRetry={() => void reload()} />

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : devices == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={6} />
        </Card>
      ) : devices.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="list"
            category="primary"
            title="Noch keine Geräte registriert"
            description="Registrieren Sie die erste Aufkleber-ID (Format VP-XXXX-XXXX), damit Kunden ihr Gerät verbinden können."
            action={registerButton}
          />
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div className="vp-admin-sec-head">
            <h2>Registrierte Geräte-IDs</h2>
            <p>
              Die Manufacturing-Registry: nur eine hier eingetragene Aufkleber-ID
              kann ein Kunde verbinden.
            </p>
          </div>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Geräte-ID</th>
                <th>Typ</th>
                <th>Notiz</th>
                {/* „Registriert am" statt „Registriert": im Funnel darüber ist
                    „Registriert" eine STUFE, hier ist es ein Datum. */}
                <th>Registriert am</th>
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
                  <td data-label="Registriert am">{fmtDate(d.provisionedAt)}</td>
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
                      className={d.claimed ? undefined : 'vp-btn-danger'}
                      iconLeft={<Icon name="trash" size={16} />}
                      onClick={() => remove(d)}
                      disabled={d.claimed}
                      title={
                        d.claimed
                          ? 'Verbundene Geräte-IDs können nicht entfernt werden - das Gerät muss zuerst vom Kundenkonto getrennt werden.'
                          : undefined
                      }
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

/**
 * Die drei Funnel-Stufen als ruhiger Streifen (das `MandantenPulse`-Muster).
 * Solange die Registry noch lädt, werden gar keine Zahlen behauptet.
 */
function FunnelStrip({
  devices,
  pending,
  known,
}: {
  devices: ProvisionedDevice[];
  pending: PendingEnrollment[];
  known: boolean;
}) {
  if (!known) return null;
  const stages = funnelStages(devices, pending);
  const icons: Record<string, 'list' | 'history' | 'check'> = {
    registriert: 'list',
    wartet: 'history',
    verbunden: 'check',
  };
  return (
    <div className="vp-kpis vp-admin-pulse" style={{ marginBottom: 'var(--vp-space-6)' }}>
      {stages.map((s) => (
        <KpiCard
          key={s.id}
          icon={<Icon name={icons[s.id]} size={20} />}
          category={s.attention ? 'dynamic' : s.id === 'verbunden' ? 'battery' : 'primary'}
          value={String(s.count)}
          label={
            // `.vp-cell-main` ist die vorhandene Spalten-Klasse (flex column) -
            // so steht der einordnende Satz unter dem Wort statt daneben.
            <span className="vp-cell-main">
              <span>{s.label}</span>
              <span className="vp-cell-sub">{s.note}</span>
            </span>
          }
        />
      ))}
    </div>
  );
}

/**
 * Sektion „Wartet auf Zuordnung": Geräte, die sich gemeldet haben und auf
 * keinen Claim treffen. Read-only - von hier aus ist nichts zu klicken, weil
 * die Reparatur beim Kunden liegt (er tippt die richtige Referenz) bzw. beim
 * Support. Die Fläche macht den Zustand SICHTBAR, sie behauptet keine Lösung.
 */
function PendingEnrollments({
  rows,
  failed,
  onRetry,
}: {
  rows: PendingEnrollment[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
        <ErrorState
          message="Die wartenden Geräte konnten nicht geladen werden."
          onRetry={onRetry}
        />
      </Card>
    );
  }
  if (rows == null) return null;
  const list = pendingRows(rows);
  if (list.length === 0) {
    return (
      <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-6)' }}>
        <EmptyState
          icon="check"
          category="battery"
          title="Kein Gerät wartet auf Zuordnung"
          description="Jedes Gerät, das sich gemeldet hat, ist einem Kundenkonto zugeordnet."
        />
      </Card>
    );
  }
  return (
    <Card style={{ padding: 0, overflow: 'hidden', marginBottom: 'var(--vp-space-6)' }}>
      <div className="vp-admin-sec-head">
        <h2>Wartet auf Zuordnung</h2>
        <p>
          Diese Geräte melden sich, treffen aber auf kein Kundenkonto - meist,
          weil beim Verbinden eine andere Referenz eingegeben wurde.
        </p>
      </div>
      <table className="vp-table responsive">
        <thead>
          <tr>
            <th>Referenz</th>
            <th>Geräte-Info</th>
            <th>Meldet sich seit</th>
            <th>Hinweis</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.externalRef}>
              <td data-label="Referenz" className="vp-mono">
                {r.externalRef}
              </td>
              <td data-label="Geräte-Info">{r.deviceInfo ?? '—'}</td>
              <td data-label="Meldet sich seit">{fmtRelative(r.csrUpdatedAt)}</td>
              <td data-label="Hinweis">
                <Badge variant={r.suspect ? 'warn' : 'off'} dot>
                  {r.hint}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
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
