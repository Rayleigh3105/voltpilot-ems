import { useRef, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Icon } from '../designsystem/components/core/Icon';
import { Input } from '../designsystem/components/forms/Input';
import { ApiError, register } from './api';
import { login, loginWithCredentials } from './auth';
import { PASSWORT_MIN_ZEICHEN, passwortFehler } from './passwortRegel';

/**
 * „Konto erstellen“ - die Selbstregistrierung. Eigenes, nachgeladenes Stück (Bündel-Wächter
 * `test/bundle-smoke.sh`): das Formular braucht nur, wer sich registriert, nie das erste Bild des
 * Portals.
 */
/** Die eine Frage der Registrierung (D2): sie wählt den Weg beim Anlegen - Privat oder Unternehmen. */
const ZWECKE = [
  { wert: 'zuhause', titel: 'Für mein Zuhause', zeile: 'PV-Anlage, Speicher, Wallbox' },
  { wert: 'unternehmen', titel: 'Für ein Unternehmen', zeile: 'Standorte, Messstellen, Berichte' },
] as const;

export function RegisterForm({ onBack }: { onBack: () => void }) {
  const [zweck, setZweck] = useState<'zuhause' | 'unternehmen' | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ zweck: false, name: false, email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const nameOk = name.trim().length > 0;
  const emailOk = /\S+@\S+\.\S+/.test(email.trim());
  const passwordFehler = passwortFehler(password, email, name);
  const passwordOk = passwordFehler === null;
  const valid = zweck !== null && nameOk && emailOk && passwordOk;

  function touch(field: keyof typeof touched) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  async function submit() {
    if (busy) return;
    if (!valid) {
      // Point at what's missing instead of silently refusing.
      setTouched({ zweck: true, name: true, email: true, password: true });
      if (zweck === null) {
        document.getElementById('reg-zweck-zuhause')?.focus();
        return;
      }
      (!nameOk ? nameRef : !emailOk ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await register({ name: name.trim(), email: email.trim(), password, ...(zweck ? { zweck } : {}) });
      // Sign the fresh customer straight in with the credentials they just
      // typed (reloads the SPA into the onboarding wizard). If the direct
      // grant is unavailable (e.g. older realm config), fall back to the
      // pre-filled Keycloak login.
      try {
        await loginWithCredentials(email.trim().toLowerCase(), password);
        return; // reloading
      } catch {
        setDone(true);
      }
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 409
          ? 'Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Melden Sie sich stattdessen an.'
          : e instanceof ApiError && e.status === 400
            ? `Bitte prüfen Sie Ihre Eingaben: gültige E-Mail-Adresse und ein Passwort mit mindestens ${PASSWORT_MIN_ZEICHEN} Zeichen, das nicht Ihr Name oder Ihre E-Mail-Adresse ist.`
            : e instanceof ApiError && e.status === 429
              ? 'Zu viele Registrierungsversuche von Ihrem Anschluss. Bitte versuchen Sie es in etwa einer Stunde erneut.'
              : e instanceof ApiError && (e.status === 502 || e.status === 503)
                ? // Keycloak/anmeldedienst is down: this is an outage, not a
                  // transient hiccup - don't invite an immediate retry (m7).
                  'Der Anmeldedienst ist zurzeit nicht erreichbar. Bitte versuchen Sie es in wenigen Minuten erneut.'
                : 'Die Registrierung hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1>Ihr Konto ist bereit</h1>
        <p className="vp-auth-hint">
          Willkommen bei VoltPilot! Melden Sie sich jetzt mit Ihrer E-Mail-Adresse an -
          danach legen Sie Ihre Anlage an und verbinden Ihr Gerät.
        </p>
        <Button variant="primary" size="lg" fullWidth onClick={() => login(email.trim())}>
          Jetzt anmelden
        </Button>
      </>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h1>Konto erstellen</h1>
      <p className="vp-auth-hint">
        In einer Minute startklar: Konto anlegen, Adresse eintragen, Box verbinden.
      </p>
      <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
        <fieldset className="vp-zweck" aria-describedby={touched.zweck && !zweck ? 'reg-zweck-fehler' : undefined}>
          <legend className="vp-field-label">Wofür nutzen Sie VoltPilot?</legend>
          <div className="vp-zweck-wahl">
            {ZWECKE.map((z) => (
              <label key={z.wert} className={`vp-zweck-karte${zweck === z.wert ? ' is-an' : ''}`}>
                <input
                  id={`reg-zweck-${z.wert}`}
                  type="radio"
                  name="reg-zweck"
                  checked={zweck === z.wert}
                  onChange={() => setZweck(z.wert)}
                />
                <span>
                  <strong>{z.titel}</strong>
                  <span className="vp-zweck-zeile">{z.zeile}</span>
                </span>
              </label>
            ))}
          </div>
          {touched.zweck && !zweck && (
            <span id="reg-zweck-fehler" className="vp-zweck-fehler" role="alert">
              Bitte wählen Sie, wofür Sie VoltPilot nutzen.
            </span>
          )}
        </fieldset>
        <Input
          ref={nameRef}
          label={zweck === 'zuhause' ? 'Ihr Name' : zweck === 'unternehmen' ? 'Name Ihres Unternehmens' : 'Ihr Name oder Firmenname'}
          placeholder="z. B. Erika Kaiser"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
          onBlur={() => touch('name')}
          error={
            touched.name && !nameOk
              ? 'Bitte geben Sie Ihren Namen oder Firmennamen ein.'
              : null
          }
        />
        <Input
          ref={emailRef}
          label="E-Mail-Adresse"
          type="email"
          placeholder="erika@example.com"
          autoComplete="email"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
          onBlur={() => touch('email')}
          error={
            touched.email && !emailOk
              ? 'Das sieht noch nicht wie eine E-Mail-Adresse aus.'
              : null
          }
        />
        <div className="vp-pw-field">
          <div className="vp-pw-labelrow">
            <label htmlFor="reg-password" className="vp-field-label">
              Passwort
            </label>
            <button
              type="button"
              className="vp-linklike vp-pw-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Verbergen' : 'Anzeigen'}
            </button>
          </div>
          <Input
            ref={passwordRef}
            id="reg-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
            onBlur={() => touch('password')}
            error={
              touched.password && !passwordOk ? passwordFehler : null
            }
            hint={
              passwordOk ? (
                <span style={{ color: 'var(--vp-ok-ink)' }}>
                  <Icon
                    name="check"
                    size={12}
                    strokeWidth={3}
                    style={{ verticalAlign: '-1px', marginRight: 4 }}
                  />
                  Passwort erfüllt die Vorgabe.
                </span>
              ) : (
                `Mindestens ${PASSWORT_MIN_ZEICHEN} Zeichen, nicht Ihr Name oder Ihre E-Mail-Adresse.`
              )
            }
          />
        </div>
      </div>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={busy}
        // Blur validation can add a line above this button between pointer
        // down/up, moving it away from the tap. An invalid submit focuses the
        // first error itself; keep the field focused until that click lands.
        onMouseDown={(e) => { if (!valid) e.preventDefault(); }}
        style={{ marginTop: 16 }}
      >
        {busy ? 'Erstelle Konto…' : 'Konto erstellen'}
      </Button>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
      <p className="vp-auth-note">
        Schon ein Konto?{' '}
        <button type="button" className="vp-linklike" onClick={onBack}>
          Zur Anmeldung
        </button>
      </p>
    </form>
  );
}
