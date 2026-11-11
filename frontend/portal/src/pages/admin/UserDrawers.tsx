import React, { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';
import { benutzerFehler, type BenutzerAngelegt } from '../../benutzer';
import { StartpasswortAnzeige } from '../../components/StartpasswortAnzeige';

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

/**
 * Edit a user's profile: name, email and - P3 - the username. Changing the username shows the
 * Folgen-Satz (Labor W3-W5 des Konzept-Berichts §4.2/§4.4): Sitzungen bleiben, nur der alte
 * Anmeldename gilt ab dem Speichern nicht mehr.
 */
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
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email ?? '');
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anmeldenameGeaendert = username.trim() !== user.username;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateUser(tenant.id, user.id, {
        username: anmeldenameGeaendert ? username.trim() : null,
        email: email.trim() || null,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(benutzerFehler(e, 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.'));
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
          <Button variant="primary" onClick={save} disabled={busy || !username.trim()}>
            {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        <Input
          label="Anmeldename"
          value={username}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
          hint="a-z, 0-9, Punkt, Bindestrich, Unterstrich; 3 bis 64 Zeichen."
        />
        {anmeldenameGeaendert && (
          <div className="vp-alert vp-alert-info" role="status">
            <p style={{ margin: 0 }}>
              Anmelden künftig mit <b className="vp-mono">{username.trim()}</b> oder der E-Mail.
            </p>
            <p style={{ margin: 0 }}>
              „{user.username}" gilt ab dem Speichern nicht mehr. Wer angemeldet ist, bleibt es.
            </p>
          </div>
        )}
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
 * N6: der Admin vergibt ein neues Startpasswort - derselbe Weg wie der Kundenadministrator
 * ({@code StartpasswortNeuVergeben}), nur über die Admin-Route.
 */
export function ResetPasswordDialog({
  tenant,
  user,
  onClose,
}: {
  tenant: Tenant;
  user: AdminUser;
  onClose: () => void;
}) {
  const [antwort, setAntwort] = useState<BenutzerAngelegt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function vergeben() {
    setBusy(true);
    setError(null);
    try {
      setAntwort(await adminApi.resetPassword(tenant.id, user.id));
    } catch (e) {
      setError(benutzerFehler(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Neues Startpasswort: ${user.username}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {antwort ? 'Schließen' : 'Abbrechen'}
          </Button>
          {!antwort && (
            <Button variant="primary" onClick={() => void vergeben()} disabled={busy}>
              {busy ? 'Wird vergeben…' : 'Startpasswort vergeben'}
            </Button>
          )}
        </>
      }
    >
      {antwort ? (
        <StartpasswortAnzeige passwort={antwort.startpasswort} />
      ) : (
        <p>
          Das bisherige Passwort wird ersetzt. Bei der nächsten Anmeldung muss die Person ein eigenes
          Passwort festlegen. Rolle und Standorte bleiben erhalten.
        </p>
      )}
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Modal>
  );
}

