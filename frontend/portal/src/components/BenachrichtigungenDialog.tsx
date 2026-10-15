import { useEffect, useState } from 'react';
import { Modal } from '../../designsystem/components/shell/Modal';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import { VpPicker } from './VpPicker';
import { VpTimePicker } from './VpTimePicker';
import { benachrichtigungenApi, type EmailZustellweg, type PushAbo } from '../benachrichtigungenApi';
import type { Schwere } from '../meldungenApi';
import { geraeteVorschlag, istIosOhneInstallierteApp, pushEinschalten, pushUnterstuetzt } from '../push';
import type { RuhezeitRegeln, RuhezeitTeilfenster } from '../ruhezeit';
import './BenachrichtigungenDialog.css';

/**
 * "Meine Benachrichtigungen" (Alerting Scheibe 3, Konzept §6.8 Entwurf 4): Zustellwege (E-Mail,
 * Web-Push "Abo je Gerät"), Ruhezeit mit "Dringendes trotzdem melden" (Entscheid 8A). Lazy geladen
 * wie `KontoAppDialog` - nur das Konto-Menü importiert dieses Modul.
 *
 * Kundenwörter dieser Fläche (dieselbe Zurückstellung wie `meldungen.ts` - das Fachmodell-Glossar
 * verlangt belegte Zeilenverweise gegen einen festgehaltenen Repo-Stand, den diese Scheibe noch
 * nicht hat): "So erreichen wir Sie", "Ruhezeit", "Dringendes trotzdem melden", "Tages-Zusammenfassung".
 */

const SCHWERE_OPTIONEN: { value: Schwere; label: string }[] = [
  { value: 'hinweis', label: 'ab Hinweis' },
  { value: 'warnung', label: 'ab Warnung' },
  { value: 'dringend', label: 'ab Dringend' },
];

type WochenendeArt = 'aus' | 'ganz' | 'eigen';

function wochenendeArt(regeln: RuhezeitRegeln): WochenendeArt {
  if (regeln.wochenende == null) return 'aus';
  if (regeln.wochenende === 'ganz') return 'ganz';
  return 'eigen';
}

export default function BenachrichtigungenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);

  const [email, setEmail] = useState<EmailZustellweg | null>(null);
  const [emailEingabe, setEmailEingabe] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailHinweis, setEmailHinweis] = useState<string | null>(null);

  const [pushAbos, setPushAbos] = useState<PushAbo[]>([]);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFehler, setPushFehler] = useState<string | null>(null);

  const [regeln, setRegeln] = useState<RuhezeitRegeln>({});
  const [zeitzone, setZeitzone] = useState('Europe/Berlin');
  const [dringendDurch, setDringendDurch] = useState(true);
  const [ruhezeitBusy, setRuhezeitBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let aktiv = true;
    setLaden(true);
    setFehler(null);
    Promise.all([benachrichtigungenApi.emailZustand(), benachrichtigungenApi.pushAbos(), benachrichtigungenApi.ruhezeit()])
      .then(([e, p, r]) => {
        if (!aktiv) return;
        setEmail(e ?? null);
        setPushAbos(p);
        setRegeln(JSON.parse(r.regeln) as RuhezeitRegeln);
        setZeitzone(r.zeitzone);
        setDringendDurch(r.dringendDurch);
      })
      .catch(() => {
        if (aktiv) setFehler('Die Einstellungen konnten nicht geladen werden.');
      })
      .finally(() => {
        if (aktiv) setLaden(false);
      });
    return () => {
      aktiv = false;
    };
  }, [open]);

  function emailSenden() {
    if (!emailEingabe.trim()) return;
    setEmailBusy(true);
    setEmailHinweis(null);
    benachrichtigungenApi
      .emailAnfordern(emailEingabe.trim())
      .then(() => setEmailHinweis('Bestätigungs-Mail unterwegs - bitte den Link darin öffnen.'))
      .catch(() => setEmailHinweis('Das hat nicht geklappt. Bitte erneut versuchen.'))
      .finally(() => setEmailBusy(false));
  }

  function emailEinstellungenSetzen(abSchwere: Schwere, zusammenfassungAktiv: boolean, zusammenfassungUhrzeit: string) {
    if (!email) return;
    setEmail({ ...email, abSchwere, zusammenfassungAktiv, zusammenfassungUhrzeit });
    void benachrichtigungenApi.emailEinstellungenSetzen(abSchwere, zusammenfassungAktiv, zusammenfassungUhrzeit);
  }

  async function pushGeraetEinschalten() {
    setPushBusy(true);
    setPushFehler(null);
    try {
      await pushEinschalten(geraeteVorschlag());
      const liste = await benachrichtigungenApi.pushAbos();
      setPushAbos(liste);
    } catch (e) {
      setPushFehler(e instanceof Error ? e.message : 'Das hat nicht geklappt.');
    } finally {
      setPushBusy(false);
    }
  }

  function pushAboAendern(id: string, aktiv: boolean, abSchwere: Schwere) {
    setPushAbos((liste) => liste.map((a) => (a.id === id ? { ...a, aktiv, abSchwere } : a)));
    void benachrichtigungenApi.pushEinstellungenSetzen(id, aktiv, abSchwere);
  }

  function pushAboEntfernen(id: string) {
    setPushAbos((liste) => liste.filter((a) => a.id !== id));
    void benachrichtigungenApi.pushEntfernen(id);
  }

  function ruhezeitSpeichern(naechsteRegeln: RuhezeitRegeln, naechsteZeitzone: string, naechsterDringendDurch: boolean) {
    setRegeln(naechsteRegeln);
    setZeitzone(naechsteZeitzone);
    setDringendDurch(naechsterDringendDurch);
    setRuhezeitBusy(true);
    benachrichtigungenApi
      .ruhezeitSetzen(JSON.stringify(naechsteRegeln), naechsteZeitzone, naechsterDringendDurch)
      .finally(() => setRuhezeitBusy(false));
  }

  const werktagsAn = regeln.werktags != null;
  const wochenende = wochenendeArt(regeln);

  return (
    <Modal open={open} onClose={onClose} title="Meine Benachrichtigungen">
      {laden && <p className="vp-note">Wird geladen …</p>}
      {fehler && <p className="vp-alert" role="alert">{fehler}</p>}
      {!laden && !fehler && (
        <div className="vp-benachrichtigungen">
          <section>
            <h3>E-Mail</h3>
            {email ? (
              <>
                <p className="vp-note">
                  {email.ziel} {email.bestaetigt ? '· bestätigt' : '· noch nicht bestätigt'}
                </p>
                <VpPicker
                  id="email-ab-schwere"
                  label="Meldungen ab"
                  value={email.abSchwere}
                  onChange={(v) => emailEinstellungenSetzen((v ?? 'warnung') as Schwere, email.zusammenfassungAktiv, email.zusammenfassungUhrzeit)}
                  options={SCHWERE_OPTIONEN}
                />
                <Switch
                  checked={email.zusammenfassungAktiv}
                  onChange={(e) => emailEinstellungenSetzen(email.abSchwere, e.target.checked, email.zusammenfassungUhrzeit)}
                  label="Tages-Zusammenfassung"
                />
                {email.zusammenfassungAktiv && (
                  <VpTimePicker
                    label="Uhrzeit"
                    value={email.zusammenfassungUhrzeit.slice(0, 5)}
                    onChange={(v) => emailEinstellungenSetzen(email.abSchwere, email.zusammenfassungAktiv, `${v}:00`)}
                  />
                )}
              </>
            ) : (
              <>
                <Input
                  label="E-Mail-Adresse"
                  type="email"
                  value={emailEingabe}
                  onChange={(e) => setEmailEingabe(e.target.value)}
                  placeholder="name@beispiel.de"
                />
                <Button type="button" size="md" disabled={emailBusy || !emailEingabe.trim()} onClick={emailSenden}>
                  Bestätigen
                </Button>
                {emailHinweis && <p className="vp-note">{emailHinweis}</p>}
              </>
            )}
          </section>

          <section>
            <h3>Push auf diesem Gerät</h3>
            {istIosOhneInstallierteApp() && (
              <p className="vp-note">
                Auf dem iPhone zuerst „Zum Home-Bildschirm“, dann hier einschalten.
              </p>
            )}
            {!pushUnterstuetzt() && !istIosOhneInstallierteApp() && (
              <p className="vp-note">Dieser Browser unterstützt Push nicht.</p>
            )}
            {pushUnterstuetzt() && (
              <Button type="button" size="md" disabled={pushBusy} onClick={() => void pushGeraetEinschalten()}>
                Einschalten
              </Button>
            )}
            {pushFehler && <p className="vp-alert" role="alert">{pushFehler}</p>}
            {pushAbos.map((abo) => (
              <div key={abo.id} className="vp-benachrichtigungen-geraet">
                <span>{abo.geraet}</span>
                <VpPicker
                  id={`push-ab-schwere-${abo.id}`}
                  label="ab"
                  value={abo.abSchwere}
                  onChange={(v) => pushAboAendern(abo.id, abo.aktiv, (v ?? 'warnung') as Schwere)}
                  options={SCHWERE_OPTIONEN}
                />
                <Switch checked={abo.aktiv} onChange={(e) => pushAboAendern(abo.id, e.target.checked, abo.abSchwere)} />
                <Button type="button" size="sm" variant="ghost" onClick={() => pushAboEntfernen(abo.id)}>
                  Entfernen
                </Button>
              </div>
            ))}
          </section>

          <section>
            <h3>Ruhezeit</h3>
            <Switch
              checked={werktagsAn}
              onChange={(e) => {
                const naechste: RuhezeitRegeln = { ...regeln };
                if (e.target.checked) naechste.werktags = { von: '22:00', bis: '07:00' };
                else delete naechste.werktags;
                ruhezeitSpeichern(naechste, zeitzone, dringendDurch);
              }}
              label="Werktags"
            />
            {werktagsAn && regeln.werktags && (
              <div className="vp-benachrichtigungen-fenster">
                <VpTimePicker
                  label="Von"
                  value={regeln.werktags.von}
                  onChange={(v) => ruhezeitSpeichern({ ...regeln, werktags: { ...(regeln.werktags as RuhezeitTeilfenster), von: v } }, zeitzone, dringendDurch)}
                />
                <VpTimePicker
                  label="Bis"
                  value={regeln.werktags.bis}
                  onChange={(v) => ruhezeitSpeichern({ ...regeln, werktags: { ...(regeln.werktags as RuhezeitTeilfenster), bis: v } }, zeitzone, dringendDurch)}
                />
              </div>
            )}

            <VpPicker
              id="wochenende-art"
              label="Am Wochenende"
              value={wochenende}
              onChange={(v) => {
                const naechste: RuhezeitRegeln = { ...regeln };
                if (v === 'aus') delete naechste.wochenende;
                else if (v === 'ganz') naechste.wochenende = 'ganz';
                else naechste.wochenende = { von: '00:00', bis: '23:59' };
                ruhezeitSpeichern(naechste, zeitzone, dringendDurch);
              }}
              options={[
                { value: 'ganz', label: 'ganz' },
                { value: 'eigen', label: 'eigene Zeiten' },
                { value: 'aus', label: 'keine Ruhezeit' },
              ]}
            />
            {wochenende === 'eigen' && typeof regeln.wochenende === 'object' && (
              <div className="vp-benachrichtigungen-fenster">
                <VpTimePicker
                  label="Von"
                  value={regeln.wochenende.von}
                  onChange={(v) => ruhezeitSpeichern({ ...regeln, wochenende: { ...(regeln.wochenende as RuhezeitTeilfenster), von: v } }, zeitzone, dringendDurch)}
                />
                <VpTimePicker
                  label="Bis"
                  value={regeln.wochenende.bis}
                  onChange={(v) => ruhezeitSpeichern({ ...regeln, wochenende: { ...(regeln.wochenende as RuhezeitTeilfenster), bis: v } }, zeitzone, dringendDurch)}
                />
              </div>
            )}

            <Switch
              checked={dringendDurch}
              onChange={(e) => ruhezeitSpeichern(regeln, zeitzone, e.target.checked)}
              label="Dringendes trotzdem melden"
            />
            {ruhezeitBusy && <p className="vp-note">Wird gespeichert …</p>}
          </section>
        </div>
      )}
    </Modal>
  );
}
