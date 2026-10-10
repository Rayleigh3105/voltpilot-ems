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

