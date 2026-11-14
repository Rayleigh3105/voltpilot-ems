import React, { useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { adminApi, type AdminUser, type Tenant } from '../../admin/adminApi';
import { benutzerFehler, KUNDENROLLEN, unternehmensrolle, type BenutzerAngelegt, type BenutzerEintrag } from '../../benutzer';
import { ROLLE_BESCHREIBUNG } from '../../components/BenutzerEinladen';
import { VpPicker } from '../../components/VpPicker';
import { StartpasswortAnzeige } from '../../components/StartpasswortAnzeige';
import type { SelbstauskunftStandort } from '../../api';

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
 * Edit a user's profile: name, email, username (P3) - and (vp-admin-rollen-plattform, Admin-Durchgang
 * Antwort Punkt 3 = B) Rolle und Standorte, im selben Dialog, über denselben Prüfpunkt und dieselben
 * Regeln wie beim Kundenadministrator (`BenutzerVerwaltung#wechseln`). Changing the username shows the
 * Folgen-Satz (Labor W3-W5 des Konzept-Berichts §4.2/§4.4): Sitzungen bleiben, nur der alte
 * Anmeldename gilt ab dem Speichern nicht mehr.
 *
 * Eine Person kann mehr als eine Zuweisung tragen (etwa eine Hauptrolle und zusätzlich „Einsicht");
 * dieser EINE Rolle-Dialog ersetzt sie alle durch die gewählte Rolle und Standorte - wie der
 * Kundenadministrator es Zeile für Zeile tut, nur in einem Feld. Ohne Berührung des Rolle-/Standort-Felds
 * geht kein Zugriffs-Aufruf hinaus; nur Anmeldename/E-Mail/Name ändern sich dann.
 */
export function EditUserDrawer({
  tenant,
  user,
  eintrag,
  standorte: alleStandorte,
  onClose,
  onSaved,
}: {
  tenant: Tenant;
  user: AdminUser;
  eintrag: BenutzerEintrag | null;
  standorte: SelbstauskunftStandort[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email ?? '');
  const [firstName, setFirstName] = useState(user.firstName ?? '');
  const [lastName, setLastName] = useState(user.lastName ?? '');
  const bisher = eintrag?.zuweisungen ?? [];
  const [rolle, setRolle] = useState<string>(bisher[0]?.rolle ?? 'leser');
  const [standorte, setStandorte] = useState<string[]>(
    [...new Set(bisher.flatMap((z) => (z.standort_id ? [z.standort_id] : [])))],
  );
  const [rolleBeruehrt, setRolleBeruehrt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anmeldenameGeaendert = username.trim() !== user.username;
  const jeStandort = !unternehmensrolle(rolle);
  const ohneStandort = rolleBeruehrt && jeStandort && standorte.length === 0;

  async function save() {
    if (ohneStandort) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateUser(tenant.id, user.id, {
        username: anmeldenameGeaendert ? username.trim() : null,
        email: email.trim() || null,
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
      });
      if (rolleBeruehrt) {
        await adminApi.changeUserAccess(tenant.id, user.id, {
          bisher: bisher.map((z) => z.id),
          rolle,
          standorte: jeStandort ? standorte : [],
        });
      }
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
          <Button variant="primary" onClick={save} disabled={busy || !username.trim() || ohneStandort}>
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
        <VpPicker
          id="edit-user-rolle"
          label="Rolle"
          value={rolle}
          options={KUNDENROLLEN.map((r) => ({ ...r, sub: ROLLE_BESCHREIBUNG[r.value] }))}
          onChange={(v) => { setRolleBeruehrt(true); setRolle(v); setStandorte([]); }}
        />
        <p className="vp-note" style={{ margin: 0 }}>{ROLLE_BESCHREIBUNG[rolle]}</p>
        {jeStandort && (
          <VpPicker
            id="edit-user-standorte"
            label="Standorte"
            values={standorte}
            options={alleStandorte.map((s) => ({ value: s.id, label: s.name }))}
            onChangeMany={(ids) => { setRolleBeruehrt(true); setStandorte(ids); }}
          />
        )}
        {ohneStandort && (
          <p className="vp-feld-fehler" role="alert" style={{ margin: 0 }}>Wählen Sie mindestens einen Standort.</p>
        )}
        {rolleBeruehrt && (
          <p className="vp-note" style={{ margin: 0 }}>
            Die Änderung gilt sofort und steht im Zugriffsprotokoll des Kunden.
          </p>
        )}
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

