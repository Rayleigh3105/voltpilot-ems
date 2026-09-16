import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { KpiCard } from '../../../designsystem/components/shell/KpiCard';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { VpPicker } from '../../components/VpPicker';
import { ApiError, type Site } from '../../api';
import { fmtCoords, fmtNum } from '../../format';
import { tenantPulse } from '../../adminPulse';
import {
  adminApi,
  type AdminUser,
  type Tenant,
  type TenantOffboardingReport,
} from '../../admin/adminApi';
import { CreateSiteDrawer } from '../../components/CreateSiteDrawer';
import { DangerZone } from '../../components/DangerZone';
import { EmptyState, ErrorState, TextSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';
import { CreateUserDrawer } from './CreateUserDrawer';
import { EditUserDrawer } from './UserDrawers';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RowMenu } from '../../components/RowMenu';
import type { PageId } from '../../nav';

/**
 * Plattform → Mandanten: the same list + add-drawer + detail-drawer pattern as
 * Standorte/Geräte, backed by the platform-admin API. The detail drawer shows
 * the tenant's users + sites and offers "In Mandanten-Ansicht springen", which
 * sets the tenant switcher and renders the customer pages for that tenant.
 */
export function MandantenPage({
  tenants,
  onReloadTenants,
  onJumpToTenant,
}: {
  tenants: Tenant[];
  onReloadTenants: (selectId?: string) => void;
  onJumpToTenant: (tenantId: string, page: PageId) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<Tenant | null>(null);

  const addButton = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
      Mandant anlegen
    </Button>
  );

  return (
    <>
      <AdminPageHead
        icon="building"
        category="industry"
        title="Mandanten"
        description="Mandanten plattformweit verwalten. Zeile öffnen für Benutzer und Anlagen - oder oben über den Mandanten-Umschalter in die Ansicht eines Mandanten springen."
        actions={addButton}
      />

      {tenants.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="building"
            category="industry"
            title="Noch keine Mandanten"
            description="Legen Sie den ersten Mandanten an, um Kunden auf der Plattform zu verwalten - Benutzer und Anlagen richten Sie danach je Mandant ein."
            action={addButton}
          />
        </Card>
      ) : (
        <>
          <MandantenPulse tenants={tenants} />
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table className="vp-table responsive">
              <thead>
                <tr>
                  <th>Mandant</th>
                  <th>Segment</th>
                  <th>Tarif</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => setDetail(t)}>
                    <td data-label="Mandant">
                      <div className="vp-cell-main">
                        <b>{t.name}</b>
                        <span className="vp-cell-sub vp-mono" title={t.id}>
                          {t.id.slice(0, 8)}…
                        </span>
                      </div>
                    </td>
                    <td data-label="Segment">
                      <Badge variant="tint">{segmentLabel(t.segment)}</Badge>
                    </td>
                    <td data-label="Tarif">
                      <Badge variant="tint">{t.plan.toUpperCase()}</Badge>
                    </td>
                    <td data-label="" style={{ textAlign: 'right' }}>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Details zu ${t.name}`}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setDetail(t);
                        }}
                      >
                        Details <Icon name="chevron-right" size={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <CreateTenantDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(t) => onReloadTenants(t.id)}
      />

      {detail && (
        <TenantDetailDrawer
          tenant={detail}
          onClose={() => setDetail(null)}
          onJumpToTenant={onJumpToTenant}
          onChanged={(t) => {
            if (t) setDetail(t);
            onReloadTenants(t?.id);
          }}
          onDeleted={() => {
            setDetail(null);
            onReloadTenants();
          }}
        />
      )}
    </>
  );
}

/**
 * Platform pulse strip: a compact at-a-glance count of Mandanten by segment,
 * derived purely from the tenants in hand (tenantPulse) - the admin's first
 * "how big is the platform?" signal above the table.
 */
function MandantenPulse({ tenants }: { tenants: Tenant[] }) {
  const p = tenantPulse(tenants);
  return (
    <div className="vp-kpis vp-admin-pulse" style={{ marginBottom: 'var(--vp-space-6)' }}>
      <KpiCard
        icon={<Icon name="building" size={20} />}
        category="primary"
        value={fmtNum(p.total, '', 0)}
        label="Mandanten gesamt"
      />
      <KpiCard
        icon={<Icon name="home" size={20} />}
        category="home"
        value={fmtNum(p.privat, '', 0)}
        label="Privatkunden"
      />
      <KpiCard
        icon={<Icon name="building" size={20} />}
        category="industry"
        value={fmtNum(p.gewerbe, '', 0)}
        label="Gewerbe & Industrie"
      />
      {p.andere > 0 && (
        <KpiCard
          icon={<Icon name="list" size={20} />}
          category="dynamic"
          value={fmtNum(p.andere, '', 0)}
          label="Andere Segmente"
        />
      )}
    </div>
  );
}

function CreateTenantDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const [name, setName] = useState('');
  const [segment, setSegment] = useState('CI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await adminApi.createTenant({ name: name.trim(), segment });
      setName('');
      onCreated(t);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Ein Mandant mit diesem Namen existiert bereits.'
          : 'Der Mandant konnte nicht angelegt werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mandant anlegen"
      icon={
        <IconTile category="industry" size={40}>
          <Icon name="building" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Wird angelegt…' : 'Mandant anlegen'}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <Input
          label="Name *"
          placeholder="z. B. Stadtwerke Musterstadt"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <VpPicker
          id="tenant-segment"
          label="Segment"
          options={[
            { value: 'CI', label: 'CI (Gewerbe/Industrie)' },
            { value: 'B2C', label: 'B2C (Privat)' },
          ]}
          value={segment}
          onChange={setSegment}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Modal>
  );
}

function TenantDetailDrawer({
  tenant,
  onClose,
  onJumpToTenant,
  onChanged,
  onDeleted,
}: {
  tenant: Tenant;
  onClose: () => void;
  onJumpToTenant: (tenantId: string, page: PageId) => void;
  onChanged: (tenant?: Tenant) => void;
  onDeleted: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Load failure kept distinct from action errors (and the loading `null`), so a
  // failed load shows a retryable ErrorState instead of permanent skeletons.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userDrawer, setUserDrawer] = useState(false);
  // Stufe 4 (F5): die Benutzer-Verwaltung ist hier VOLLSTÄNDIG - inklusive des
  // Passwort-Resets, des einen Support-Hebels. Er lag bis dahin allein auf der
  // eigenen Benutzer-Seite, während dieser Drawer die andere Hälfte trug.
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [confirmUser, setConfirmUser] = useState<{ user: AdminUser; kind: 'disable' | 'delete' } | null>(null);
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [report, setReport] = useState<TenantOffboardingReport | null>(null);

  async function reload() {
    setError(null);
    setLoadError(null);
    try {
      const [u, s] = await Promise.all([
        adminApi.listUsers(tenant.id),
        adminApi.listSites(tenant.id),
      ]);
      setUsers(u);
      setSites(s);
    } catch (e) {
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Mandantendaten konnten nicht geladen werden.',
      );
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function disable(u: AdminUser) {
    try {
      await adminApi.disableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Deaktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  /**
   * Der Löschweg der stillgelegten Benutzer-Seite, wörtlich übernommen - inkl.
   * der Selbst-Sperre des Servers (409: das eigene Konto ist nicht löschbar).
   */
  async function remove(u: AdminUser) {
    try {
      await adminApi.deleteUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Sie können Ihr eigenes Konto nicht löschen.'
          : e instanceof ApiError
            ? `Löschen fehlgeschlagen: ${e.message}`
            : 'Fehler',
      );
    }
  }

  async function enable(u: AdminUser) {
    try {
      await adminApi.enableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Aktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  async function offboard() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      setReport(await adminApi.deleteTenant(tenant.id, tenant.name));
    } catch (e) {
      setDeleteError(
        e instanceof ApiError && e.status === 502
          ? 'Die Benutzerverwaltung ist gerade nicht erreichbar - es wurde nichts gelöscht. Bitte versuchen Sie es später erneut.'
          : e instanceof ApiError
            ? `Löschen fehlgeschlagen: ${e.message}`
            : 'Löschen fehlgeschlagen. Es wurde nichts gelöscht.',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  // Offboarding done: show the report instead of the (now gone) tenant data.
  if (report) {
    return (
      <Modal
        open
        onClose={onDeleted}
        title={`Mandant gelöscht: ${report.tenantName}`}
        icon={
          <IconTile category="industry" size={40}>
            <Icon name="trash" size={20} />
          </IconTile>
        }
        footer={
          <Button variant="primary" onClick={onDeleted}>
            Schließen
          </Button>
        }
      >
        <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
          Der Mandant „{report.tenantName}" wurde vollständig entfernt.
        </div>
        <table className="vp-table" style={{ marginTop: 'var(--vp-space-4)' }}>
          <tbody>
            <tr>
              <th scope="row">Anlagen</th>
              <td>{report.deletedSites}</td>
            </tr>
            <tr>
              <th scope="row">Geräte</th>
              <td>{report.deletedDevices}</td>
            </tr>
            <tr>
              <th scope="row">Messpunkte</th>
              <td>{fmtNum(report.deletedTelemetryRows, '', 0)}</td>
            </tr>
            <tr>
              <th scope="row">Gelöschte Benutzer</th>
              <td>{report.deletedUsers.length > 0 ? report.deletedUsers.join(', ') : '-'}</td>
            </tr>
          </tbody>
        </table>
        {report.failedUsers.length > 0 && (
          <div className="vp-alert vp-alert-err">
            Diese Benutzerkonten konnten nicht gelöscht werden und brauchen manuelle
            Nacharbeit: <b>{report.failedUsers.join(', ')}</b>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={tenant.name}
        icon={
          <IconTile category="industry" size={40}>
            <Icon name="building" size={20} />
          </IconTile>
        }
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Schließen
            </Button>
            <Button variant="primary" onClick={() => onJumpToTenant(tenant.id, 'uebersicht')}>
              In Mandanten-Ansicht springen →
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', gap: 'var(--vp-space-2)', flexWrap: 'wrap', marginBottom: 'var(--vp-space-5)' }}>
          <Badge variant="tint">{segmentLabel(tenant.segment)}</Badge>
          <Badge variant="tint">
            {tenant.betriebsart == null
              ? 'Automatisch (nach Anzahl Anlagen)'
              : betriebsartLabel(tenant.betriebsart)}
          </Badge>
          <Badge variant="tint">Tarif {tenant.plan.toUpperCase()}</Badge>
          <span className="vp-mono" style={{ alignSelf: 'center' }}>{tenant.id}</span>
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

        {editing && (
          <TenantEditForm
            tenant={tenant}
            onCancel={() => setEditing(false)}
            onSaved={(t) => {
              setEditing(false);
              onChanged(t);
            }}
          />
        )}

        {error && <div className="vp-alert vp-alert-err">{error}</div>}

        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Benutzer {users ? `(${users.length})` : ''}</h2>
          <span className="actions">
            <Button variant="outline" size="sm" disabled={!users || users.length > 0} iconLeft={<Icon name="plus" size={16} />} onClick={() => setUserDrawer(true)}>
              Benutzer anlegen
            </Button>
          </span>
        </div>
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void reload()} />
        ) : users == null ? (
          <TextSkeleton lines={3} />
        ) : users.length === 0 ? (
          <p className="vp-muted">Noch keine Benutzer für diesen Mandanten.</p>
        ) : (
          <table className="vp-table responsive" style={{ marginBottom: 'var(--vp-space-5)' }}>
            {/* `responsive` + `data-label`: seit Stufe 4 ist DAS hier die
                einzige Benutzer-Verwaltung, und vier Spalten samt
                Aktions-Menü messen am Telefon 499 px in einem 374-px-Einschub
                (gemessen). Die Haus-Tabelle klappt unter 720 px zu
                Etikett/Wert-Karten. */}
            <thead>
              <tr>
                <th>Benutzername</th>
                <th>E-Mail</th>
                <th>Status</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Benutzername" className="vp-mono">{u.username}</td>
                  <td data-label="E-Mail">{u.email ?? '-'}</td>
                  <td data-label="Status">
                    <Badge variant={u.enabled ? 'ok' : 'off'} dot>
                      {u.enabled ? 'aktiv' : 'deaktiviert'}
                    </Badge>
                  </td>
                  <td data-label="" style={{ textAlign: 'right' }}>
                    <RowMenu
                      label={`Aktionen für ${u.username}`}
                      items={[
                        { label: 'Bearbeiten', icon: 'pencil', onClick: () => setEditUser(u) },
                        u.enabled
                          ? {
                              label: 'Deaktivieren',
                              icon: 'x',
                              onClick: () => setConfirmUser({ user: u, kind: 'disable' }),
                            }
                          : { label: 'Aktivieren', icon: 'check', onClick: () => enable(u) },
                        {
                          label: 'Löschen',
                          icon: 'trash',
                          danger: true,
                          onClick: () => setConfirmUser({ user: u, kind: 'delete' }),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Anlagen {sites ? `(${sites.length})` : ''}</h2>
          <span className="actions">
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSiteDrawer(true)}>
              Anlage anlegen
            </Button>
          </span>
        </div>
        {loadError ? (
          // The single ErrorState above the users section already covers this
          // shared load failure and offers the retry.
          null
        ) : sites == null ? (
          <TextSkeleton lines={3} />
        ) : sites.length === 0 ? (
          <p className="vp-muted">
            Noch keine Anlagen - der Kunde kann erst danach Geräte verbinden.
          </p>
        ) : (
          <table className="vp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Zone</th>
                <th>Koordinaten</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <Badge variant="tint">{s.biddingZone}</Badge>
                  </td>
                  <td>{fmtCoords(s.latitude, s.longitude) ?? <span className="vp-muted">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="vp-alert vp-alert-info" style={{ marginTop: 'var(--vp-space-5)' }}>
          Über den Mandanten-Umschalter oben (oder den Knopf unten) sehen Sie Anlagen,
          Geräte und Übersicht dieses Mandanten - dieselben Seiten wie der Kunde, nur
          mit gewähltem Mandanten.
        </div>

        <DangerZone
          actionLabel="Mandant löschen (Offboarding)"
          description="Offboarding entfernt den Mandanten mit allen Daten und Zugängen - die endgültigste Aktion auf der Plattform."
          consequences={[
            `Alle Anlagen (${sites?.length ?? '…'}) und Geräte des Mandanten`,
            'Alle Messdaten, Prognosen und Fahrpläne',
            `Alle Benutzerkonten (${users?.length ?? '…'}) - die Personen können sich nicht mehr anmelden`,
            `Der Mandant „${tenant.name}" selbst`,
          ]}
          confirmLabel="Mandant endgültig löschen"
          typeToConfirm={tenant.name}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void offboard()}
        />
      </Modal>

      <CreateUserDrawer
        open={userDrawer}
        onClose={() => setUserDrawer(false)}
        tenant={tenant}
        onCreated={() => void reload()}
      />
      {editUser && (
        <EditUserDrawer
          key={editUser.id}
          tenant={tenant}
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null);
            void reload();
          }}
        />
      )}
      {/* Die zwei Rückfragen im HAUS-MUSTER statt eines nativen `confirm`:
          sie stehen in einem Drawer, der schon eine Folgenliste kennt
          (`DangerZone` darunter), und ein System-Popup daneben wäre die
          schwächste Rückfrage der Fläche. */}
      <ConfirmDialog
        open={confirmUser != null}
        tone="danger"
        title={
          confirmUser?.kind === 'delete' ? 'Benutzer löschen?' : 'Benutzer deaktivieren?'
        }
        intro={
          confirmUser?.kind === 'delete'
            ? `Das Konto „${confirmUser?.user.username}" wird endgültig entfernt.`
            : `„${confirmUser?.user.username}" kann sich danach nicht mehr anmelden.`
        }
        consequences={
          confirmUser?.kind === 'delete'
            ? [
                'Der Zugang wird dauerhaft gelöscht - das lässt sich nicht rückgängig machen.',
                'Die Anlagen und Daten des Mandanten bleiben unberührt.',
                'Ein neuer Zugang für dieselbe Person ist jederzeit wieder anlegbar.',
              ]
            : [
                'Die Anmeldung wird gesperrt; laufende Sitzungen enden beim nächsten Aufruf.',
                'Das Konto bleibt bestehen - Aktivieren stellt den Zugang sofort wieder her.',
                'Die Anlagen und Daten des Mandanten bleiben unberührt.',
              ]
        }
        confirmLabel={confirmUser?.kind === 'delete' ? 'Benutzer löschen' : 'Deaktivieren'}
        onCancel={() => setConfirmUser(null)}
        onConfirm={() => {
          const c = confirmUser;
          setConfirmUser(null);
          if (!c) return;
          void (c.kind === 'delete' ? remove(c.user) : disable(c.user));
        }}
      />
      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => adminApi.createSite(tenant.id, input)}
        onCreated={() => void reload()}
        contextNote={`Wird für den Mandanten ${tenant.name} (${tenant.id.slice(0, 8)}) angelegt. Der Kunde sieht sie sofort in seinem Portal.`}
      />
    </>
  );
}

/** Inline edit form of the tenant drawer: name + segment + Betriebsart (U0). */
function TenantEditForm({
  tenant,
  onCancel,
  onSaved,
}: {
  tenant: Tenant;
  onCancel: () => void;
  onSaved: (updated: Tenant) => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [segment, setSegment] = useState(tenant.segment);
  // '' = Automatisch (no override stored; the segment derives the shell).
  const [betriebsart, setBetriebsart] = useState(tenant.betriebsart ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.updateTenant(tenant.id, {
        name: name.trim(),
        segment,
        betriebsart: betriebsart === '' ? null : (betriebsart as 'endkunde' | 'betreiber'),
      });
      onSaved(updated);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name, Segment und Betriebsart.'
          : 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 'var(--vp-space-5)' }}>
      <div className="vp-form-stack">
        <Input
          label="Name *"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <VpPicker
          id="edit-tenant-segment"
          label="Segment"
          options={[
            { value: 'CI', label: 'CI (Gewerbe/Industrie)' },
            { value: 'B2C', label: 'B2C (Privat)' },
          ]}
          value={segment}
          onChange={setSegment}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <VpPicker
            id="edit-tenant-betriebsart"
            label="Betriebsart (Navigation des Kunden)"
            options={[
              { value: '', label: 'Automatisch (nach Anzahl Anlagen)' },
              { value: 'endkunde', label: 'Endkunde (Cockpit für die eigene Anlage)' },
              { value: 'betreiber', label: 'Betreiber (Flotten-/Portfolio-Ansicht)' },
            ]}
            value={betriebsart}
            onChange={setBetriebsart}
          />
          <p className="vp-muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            Bestimmt die Navigation des Kundenportals. Automatisch heißt: ab
            zwei Anlagen die Flotten-Ansicht, sonst das Cockpit - das Segment
            wird dafür ausdrücklich NICHT herangezogen.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button>
      </div>
    </div>
  );
}

function segmentLabel(segment: string): string {
  if (segment === 'CI') return 'Gewerbe & Industrie';
  if (segment === 'B2C') return 'Privat';
  return segment;
}

/** German label of an explicitly set U0 shell frame. */
function betriebsartLabel(betriebsart: string): string {
  if (betriebsart === 'endkunde') return 'Endkunde';
  if (betriebsart === 'betreiber') return 'Betreiber';
  return betriebsart;
}
