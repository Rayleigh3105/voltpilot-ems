import { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi, type AdminUser, type CreateUserInput, type Tenant } from '../../admin/adminApi';

/**
 * "Benutzer anlegen" drawer (platform-admin): provisions a customer user in
 * Keycloak with the tenant_id attribute + customer role, so the new login is
 * tenant-scoped by the existing OIDC + RLS spine.
 */
export function CreateUserDrawer({
  open,
  onClose,
  tenant,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  tenant: Tenant;
  onCreated: (user: AdminUser) => void;
}) {
  const [form, setForm] = useState<CreateUserInput>({ username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof CreateUserInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.username.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const u = await adminApi.createUser(tenant.id, {
        username: form.username.trim(),
        email: form.email?.trim() || undefined,
        firstName: form.firstName?.trim() || undefined,
        lastName: form.lastName?.trim() || undefined,
        password: form.password?.trim() || undefined,
        temporaryPassword: false,
      });
      setForm({ username: '', email: '', password: '', firstName: '', lastName: '' });
      onCreated(u);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Benutzername oder E-Mail existiert bereits.'
          : e instanceof ApiError
            ? `Fehler: ${e.message}`
            : 'Anlegen fehlgeschlagen.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Benutzer anlegen"
      icon={<IconTile category="primary" size={40}>☺</IconTile>}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !form.username.trim()}>
            {busy ? 'Lege an…' : 'Benutzer anlegen'}
          </Button>
        </>
      }
    >
      <p className="vp-note" style={{ marginTop: 0 }}>
        Wird in Keycloak mit dem Mandanten {tenant.name} ({tenant.id.slice(0, 8)}) und der
        Kundenrolle angelegt - der Benutzer sieht nach der Anmeldung nur diesen Mandanten.
      </p>
      <div className="vp-form-stack">
        <Input label="Benutzername *" placeholder="z. B. kunde-01" value={form.username} onChange={set('username')} />
        <Input label="E-Mail" type="email" placeholder="kunde@example.com" value={form.email ?? ''} onChange={set('email')} />
        <Input label="Vorname" value={form.firstName ?? ''} onChange={set('firstName')} />
        <Input label="Nachname" value={form.lastName ?? ''} onChange={set('lastName')} />
        <Input
          label="Initiales Passwort"
          type="password"
          placeholder="mind. 6 Zeichen"
          value={form.password ?? ''}
          onChange={set('password')}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}
