import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
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
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);

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
                  <td data-label="" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Button variant="ghost" size="sm" onClick={() => setResetUser(u)}>
                      Passwort zurücksetzen
                    </Button>
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
      {tenant && resetUser && (
        <ResetPasswordDrawer
          key={resetUser.id}
          tenant={tenant}
          user={resetUser}
          onClose={() => setResetUser(null)}
        />
      )}
    </>
  );
}

/**
 * Support password reset: the platform has no SMTP (no self-service reset), so
 * this is how support recovers a customer who forgot their password or locked
 * themselves out guessing. The backend also lifts any brute-force lockout so
 * the new password works immediately.
 */
function ResetPasswordDrawer({
  tenant,
  user,
  onClose,
}: {
  tenant: Tenant;
  user: AdminUser;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [temporary, setTemporary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const valid = password.length >= 8;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await adminApi.resetPassword(tenant.id, user.id, { password, temporary });
      setPassword('');
      setMsg({
        ok: true,
        text:
          `Neues Passwort für „${user.username}“ gesetzt` +
          (temporary ? ' - muss bei der nächsten Anmeldung geändert werden.' : '.') +
          ' Eine eventuelle Anmeldesperre wurde aufgehoben.',
      });
    } catch (e) {
      setMsg({
        ok: false,
        text:
          e instanceof ApiError && e.status === 400
            ? 'Das Passwort muss mindestens 8 Zeichen lang sein.'
            : e instanceof ApiError
              ? `Zurücksetzen fehlgeschlagen: ${e.message}`
              : 'Zurücksetzen fehlgeschlagen.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Passwort zurücksetzen: ${user.username}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Schließen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Setze zurück…' : 'Passwort setzen'}
          </Button>
        </>
      }
    >
      <p className="vp-note" style={{ marginTop: 0 }}>
        Teilen Sie dem Kunden das neue Passwort auf einem sicheren Weg mit. Eine eventuelle
        Anmeldesperre (zu viele Fehlversuche) wird dabei aufgehoben.
      </p>
      <div className="vp-form-stack">
        <Input
          label="Neues Passwort *"
          type="password"
          placeholder="mind. 8 Zeichen"
          value={password}
          autoComplete="new-password"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={temporary}
            onChange={(e) => setTemporary(e.target.checked)}
          />
          <span style={{ fontSize: '0.9rem' }}>Muss bei nächster Anmeldung geändert werden</span>
        </label>
      </div>
      {msg && <div className={`vp-alert ${msg.ok ? 'vp-alert-ok' : 'vp-alert-err'}`}>{msg.text}</div>}
    </Drawer>
  );
}
