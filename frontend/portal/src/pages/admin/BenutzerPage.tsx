import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ApiError } from '../../api';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';
import { CreateUserDrawer } from './CreateUserDrawer';

/**
 * Plattform → Benutzer: customer users per tenant, same list + add-drawer
 * pattern. Users live in Keycloak per tenant, so the page starts with a
 * tenant selection (pre-set from the top-bar switcher when one is active).
 */
export function BenutzerPage({
  tenants,
  tenantOverride,
}: {
  tenants: Tenant[];
  /** The top-bar tenant context, used as the initial selection. */
  tenantOverride: string | null;
}) {
  const [tenantId, setTenantId] = useState<string | null>(tenantOverride);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (tenantOverride) setTenantId(tenantOverride);
  }, [tenantOverride]);

  useEffect(() => {
    if (!tenantId && tenants.length === 1) setTenantId(tenants[0].id);
  }, [tenants, tenantId]);

  const tenant = tenants.find((t) => t.id === tenantId) ?? null;

  async function reload() {
    if (!tenant) return;
    setError(null);
    try {
      setUsers(await adminApi.listUsers(tenant.id));
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    }
  }

  useEffect(() => {
    setUsers(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  async function disable(u: AdminUser) {
    if (!tenant) return;
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
      <div className="vp-page-head">
        <div className="titles">
          <h1>Benutzer</h1>
          <p>Kundenzugänge je Mandant verwalten.</p>
        </div>
        <div className="actions">
          <select
            aria-label="Mandant wählen"
            className="vp-select"
            style={{ width: 'auto' }}
            value={tenantId ?? ''}
            onChange={(e) => setTenantId(e.target.value || null)}
          >
            <option value="">Mandant wählen…</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)} disabled={!tenant}>
            Benutzer anlegen
          </Button>
        </div>
      </div>

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {!tenant ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Wählen Sie oben einen Mandanten, um dessen Benutzer zu sehen und anzulegen.
          </p>
        </Card>
      ) : users == null ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">Lade Benutzer…</p>
        </Card>
      ) : users.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">Noch keine Benutzer für {tenant.name}. Legen Sie den ersten an.</p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <table className="vp-table responsive">
            <thead>
              <tr>
                <th>Benutzername</th>
                <th>E-Mail</th>
                <th>Name</th>
                <th>Status</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Benutzername" className="vp-mono">
                    {u.username}
                  </td>
                  <td data-label="E-Mail">{u.email ?? '-'}</td>
                  <td data-label="Name">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || '-'}
                  </td>
                  <td data-label="Status">
                    <Badge variant={u.enabled ? 'ok' : 'off'} dot>
                      {u.enabled ? 'aktiv' : 'deaktiviert'}
                    </Badge>
                  </td>
                  <td data-label="" style={{ textAlign: 'right' }}>
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
        </Card>
      )}

      {tenant && (
        <CreateUserDrawer
          open={addOpen}
          onClose={() => setAddOpen(false)}
          tenant={tenant}
          onCreated={() => void reload()}
        />
      )}
    </>
  );
}
