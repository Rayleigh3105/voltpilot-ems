import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError, type Site } from '../../api';
import { fmtCoords } from '../../format';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';
import { CreateSiteDrawer } from '../../components/CreateSiteDrawer';
import { CreateUserDrawer } from './CreateUserDrawer';
import type { PageId } from '../../nav';

/**
 * Plattform → Mandanten: the same list + add-drawer + detail-drawer pattern as
 * Standorte/Geräte, backed by the platform-admin API. The detail drawer shows
 * the tenant's users + sites and offers "In Portal-Ansicht springen", which
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

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Mandanten</h1>
          <p>
            Kunden (Mandanten) plattformweit verwalten. Zeile öffnen für Benutzer und
            Standorte - oder oben über den Kontext-Umschalter in die Portal-Ansicht
            eines Mandanten springen.
          </p>
        </div>
        <div className="actions">
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
            Mandant anlegen
          </Button>
        </div>
      </div>

      {tenants.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">Noch keine Mandanten. Legen Sie den ersten an.</p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Mandant</th>
                <th>Segment</th>
                <th>Tarif</th>
                <th>Mandant-ID</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setDetail(t)}>
                  <td data-label="Mandant">
                    <b>{t.name}</b>
                  </td>
                  <td data-label="Segment">
                    <Badge variant="tint">{segmentLabel(t.segment)}</Badge>
                  </td>
                  <td data-label="Tarif">
                    <Badge variant="tint">{t.plan.toUpperCase()}</Badge>
                  </td>
                  <td data-label="Mandant-ID" className="vp-mono" title={t.id}>
                    {t.id.slice(0, 8)}…
                  </td>
                  <td data-label="">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        setDetail(t);
                      }}
                    >
                      Details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
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
        />
      )}
    </>
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
    <Drawer
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="tenant-segment" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Segment
          </label>
          <select
            id="tenant-segment"
            className="vp-select"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
          >
            <option value="CI">CI (Gewerbe/Industrie)</option>
            <option value="B2C">B2C (Privat)</option>
          </select>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}

function TenantDetailDrawer({
  tenant,
  onClose,
  onJumpToTenant,
}: {
  tenant: Tenant;
  onClose: () => void;
  onJumpToTenant: (tenantId: string, page: PageId) => void;
}) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userDrawer, setUserDrawer] = useState(false);
  const [siteDrawer, setSiteDrawer] = useState(false);

  async function reload() {
    setError(null);
    try {
      const [u, s] = await Promise.all([
        adminApi.listUsers(tenant.id),
        adminApi.listSites(tenant.id),
      ]);
      setUsers(u);
      setSites(s);
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function disable(u: AdminUser) {
    if (!window.confirm(`Benutzer „${u.username}“ wirklich deaktivieren? Die Person kann sich danach nicht mehr anmelden.`)) {
      return;
    }
    try {
      await adminApi.disableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Deaktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  return (
    <>
      <Drawer
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
              In Portal-Ansicht springen →
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', gap: 'var(--vp-space-2)', flexWrap: 'wrap', marginBottom: 'var(--vp-space-5)' }}>
          <Badge variant="tint">{segmentLabel(tenant.segment)}</Badge>
          <Badge variant="tint">Tarif {tenant.plan.toUpperCase()}</Badge>
          <span className="vp-mono" style={{ alignSelf: 'center' }}>{tenant.id}</span>
        </div>

        {error && <div className="vp-alert vp-alert-err">{error}</div>}

        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Benutzer {users ? `(${users.length})` : ''}</h2>
          <span className="actions">
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setUserDrawer(true)}>
              Benutzer anlegen
            </Button>
          </span>
        </div>
        {users == null ? (
          <p className="vp-muted">Lade Benutzer…</p>
        ) : users.length === 0 ? (
          <p className="vp-muted">Noch keine Benutzer für diesen Mandanten.</p>
        ) : (
          <table className="vp-table" style={{ marginBottom: 'var(--vp-space-5)' }}>
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
                  <td className="vp-mono">{u.username}</td>
                  <td>{u.email ?? '-'}</td>
                  <td>
                    <Badge variant={u.enabled ? 'ok' : 'off'} dot>
                      {u.enabled ? 'aktiv' : 'deaktiviert'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {u.enabled && (
                      <Button variant="ghost" size="sm" onClick={() => disable(u)}>
                        Deaktivieren
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
          <h2 style={{ fontSize: '1.05rem' }}>Standorte {sites ? `(${sites.length})` : ''}</h2>
          <span className="actions">
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSiteDrawer(true)}>
              Standort anlegen
            </Button>
          </span>
        </div>
        {sites == null ? (
          <p className="vp-muted">Lade Standorte…</p>
        ) : sites.length === 0 ? (
          <p className="vp-muted">
            Noch keine Standorte - der Kunde kann erst danach Geräte beanspruchen.
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
          Über den Kontext-Umschalter oben (oder den Knopf unten) sehen Sie Standorte,
          Geräte und Übersicht dieses Mandanten - dieselben Seiten wie der Kunde, nur
          mit gesetztem Mandanten-Kontext.
        </div>
      </Drawer>

      <CreateUserDrawer
        open={userDrawer}
        onClose={() => setUserDrawer(false)}
        tenant={tenant}
        onCreated={() => void reload()}
      />
      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => adminApi.createSite(tenant.id, input)}
        onCreated={() => void reload()}
        contextNote={`Wird für den Mandanten ${tenant.name} (${tenant.id.slice(0, 8)}) angelegt. Der Kunde sieht ihn sofort in seinem Portal.`}
      />
    </>
  );
}

function segmentLabel(segment: string): string {
  if (segment === 'CI') return 'Gewerbe & Industrie';
  if (segment === 'B2C') return 'Privat';
  return segment;
}
