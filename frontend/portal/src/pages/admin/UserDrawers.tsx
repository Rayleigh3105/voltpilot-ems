import React, { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { ApiError } from '../../api';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';

/**
 * Die zwei Benutzer-Einschübe, WÖRTLICH aus der stillgelegten Benutzer-Seite
 * übernommen (das `VerbraucherDrawers`-Muster: verschoben, nicht neu gebaut).
 *
 * Admin-Umbau Stufe 4 „Feinschliff" (Konzept `vp-admin-neu-konzept-a9` §7,
 * Captain-Entscheid F5): die Benutzer-Verwaltung wohnt im Mandanten-Drawer,
 * und der Passwort-Reset zieht MIT um - der Drawer trug bis dahin nur die
 * halbe Verwaltung (anlegen/aktivieren/deaktivieren), und zwei halbe
 * Wahrheiten sind schlechter als eine ganze.
 */

/** Edit a user's profile: email + name. The username (login) is immutable. */
export function EditUserDrawer({
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
    <Modal
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
    </Modal>
  );
}

/**
 * Support password reset: the platform has no SMTP (no self-service reset), so
 * this is how support recovers a customer who forgot their password or locked
 * themselves out guessing. The backend also lifts any brute-force lockout so
 * the new password works immediately.
 */
export function ResetPasswordDrawer({
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
    <Modal
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
    </Modal>
  );
}
