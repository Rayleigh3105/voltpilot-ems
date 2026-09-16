import { useEffect, useState } from 'react';
import { StartpasswortAnzeige } from '../../components/StartpasswortAnzeige';
import { benutzerFehler } from '../../benutzer';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { adminApi, type CreateUserInput, type Tenant } from '../../admin/adminApi';

/**
 * "Benutzer anlegen" drawer (platform-admin): provisions a customer user in
 * Keycloak with tenant_id, a Kundenadministrator assignment and mandatory password change.
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
  onCreated: () => void;
}) {
  const [form, setForm] = useState<CreateUserInput>({ username: '', email: '' });
  const [passwort, setPasswort] = useState<string | null>(null);
  useEffect(() => { if (!open) setPasswort(null); }, [open]);
  const schliessen = () => { if (!busy) { setPasswort(null); onClose(); } };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof CreateUserInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.username.trim() || !form.email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const u = await adminApi.createUser(tenant.id, {
        username: form.username.trim(),
        email: form.email.trim(),
        firstName: form.firstName?.trim() || undefined,
        lastName: form.lastName?.trim() || undefined,
      });
      setPasswort(u.startpasswort);
      setForm({ username: '', email: '', firstName: '', lastName: '' });
      onCreated();
    } catch (e) {
      setError(benutzerFehler(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={schliessen}
      title={passwort ? "Kundenadministrator angelegt" : "Ersten Kundenadministrator anlegen"}
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="users" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={schliessen} disabled={busy}>
            {passwort ? "Schließen" : "Abbrechen"}
          </Button>
          {!passwort && <Button variant="primary" onClick={submit} disabled={busy || !form.username.trim() || !form.email?.trim()}>
            {busy ? 'Wird angelegt…' : 'Benutzer anlegen'}
          </Button>}
        </>
      }
    >
      {passwort ? <StartpasswortAnzeige passwort={passwort} /> : <>
      <p className="vp-note" style={{ marginTop: 0 }}>
        Der erste Kundenadministrator wird für <b>{tenant.name}</b> angelegt. Weitere Benutzer legt diese Person selbst an. Bei der ersten Anmeldung muss sie das Startpasswort ändern.
      </p>
      <div className="vp-form-stack">
        <Input label="Benutzername *" placeholder="z. B. kunde-01" value={form.username} onChange={set('username')} />
        <Input label="E-Mail" type="email" placeholder="kunde@example.com" value={form.email ?? ''} onChange={set('email')} />
        <Input label="Vorname" value={form.firstName ?? ''} onChange={set('firstName')} />
        <Input label="Nachname" value={form.lastName ?? ''} onChange={set('lastName')} />
      </div></>}
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Modal>
  );
}
