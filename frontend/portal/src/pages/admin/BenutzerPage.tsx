import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';
import { AdminPageHead } from './AdminPageHead';
import { CreateUserDrawer } from './CreateUserDrawer';
import { RowMenu } from '../../components/RowMenu';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';

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
  // Load failure kept distinct from action errors (and from the loading `null`)
  // so a failed load shows a retryable ErrorState, not a permanent skeleton.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);

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
    setLoadError(null);
    try {
      setUsers(await adminApi.listUsers(tenant.id));
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Die Benutzer konnten nicht geladen werden.');
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

  async function enable(u: AdminUser) {
    if (!tenant) return;
    try {
      await adminApi.enableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Aktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  async function remove(u: AdminUser) {
    if (!tenant) return;
    if (!window.confirm(`Benutzer „${u.username}“ endgültig löschen? Das Konto und der Zugang werden dauerhaft entfernt - das kann nicht rückgängig gemacht werden.`)) {
      return;
    }
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

  const headActions = (
    <>
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
    </>
  );

  return (
    <>
      <AdminPageHead
        icon="users"
        category="home"
        title="Benutzer"
        description="Kundenzugänge je Mandant verwalten."
        actions={headActions}
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {!tenant ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="users"
            category="home"
            title="Mandant wählen"
            description="Wählen Sie oben einen Mandanten, um dessen Benutzer zu sehen und anzulegen."
          />
        </Card>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : users == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={5} />
        </Card>
      ) : users.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="users"
            category="home"
            title={`Noch keine Benutzer für ${tenant.name}`}
            description="Legen Sie den ersten Kundenzugang für diesen Mandanten an."
            action={
              <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen(true)}>
                Benutzer anlegen
              </Button>
            }
          />
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
                    <RowMenu
                      label={`Aktionen für ${u.username}`}
                      items={[
                        { label: 'Bearbeiten', icon: 'pencil', onClick: () => setEditUser(u) },
                        { label: 'Passwort zurücksetzen', icon: 'refresh-cw', onClick: () => setResetUser(u) },
                        u.enabled
                          ? { label: 'Deaktivieren', icon: 'x', onClick: () => disable(u) }
                          : { label: 'Aktivieren', icon: 'check', onClick: () => enable(u) },
                        { label: 'Löschen', icon: 'trash', danger: true, onClick: () => remove(u) },
                      ]}
                    />
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
      {tenant && editUser && (
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
    </>
  );
}

/** Edit a user's profile: email + name. The username (login) is immutable. */
function EditUserDrawer({
  tenant,
  user,
  onClose,
  onSaved,
}: {
  tenant: Tenant;
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(user.email ?? '');
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateUser(tenant.id, user.id, {
        email: email.trim() || null,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige E-Mail-Adresse.'
          : e instanceof ApiError && e.status === 409
            ? 'Ein Benutzer mit dieser E-Mail-Adresse existiert bereits.'
            : 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Benutzer bearbeiten: ${user.username}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <Input
          label="Benutzername"
          value={user.username}
          disabled
          readOnly
          hint="Der Benutzername ist der Anmeldename und kann nicht geändert werden."
        />
        <Input
          label="E-Mail"
          type="email"
          value={email}
          autoComplete="off"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
        />
        <Input
          label="Vorname"
          value={firstName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFirstName(e.target.value)}
        />
        <Input
          label="Nachname"
          value={lastName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLastName(e.target.value)}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
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
