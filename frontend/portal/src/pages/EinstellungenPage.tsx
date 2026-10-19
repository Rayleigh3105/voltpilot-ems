import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  currentUser,
  kontoAktionAusfuehren,
  kontoAktionSnapshot,
  kontoAktionZuruecksetzen,
  logout,
  subscribeKontoAktion,
} from '../auth';
import {
  benachrichtigungenApi,
  type EmailZustellweg,
  type ProbeErgebnis,
  type PushAbo,
  type TelegramZiel,
  type WebhookZiel,
} from '../benachrichtigungenApi';
import { InstallAppPanel } from '../components/InstallAppPanel';
import { VpPicker } from '../components/VpPicker';
import { VpTimePicker } from '../components/VpTimePicker';
import {
  baueKurzbild,
  RUHEZEIT_PRESET_LABEL,
  ruhezeitPresetVon,
  ruhezeitRegelnFuerPreset,
  schwereAusStufe,
  stufeAusSchwere,
  type KurzbildWeg,
  type RuhezeitPresetId,
  type ZweiStufen,
} from '../einstellungenAbleitung';
import type { Schwere } from '../meldungenApi';
import {
  aktuellerPushEndpoint,
  geraeteVorschlag,
  istIosOhneInstallierteApp,
  pushBeiAbmeldenAufraeumen,
  pushEinschalten,
  pushUnterstuetzt,
} from '../push';
import { ROLLE_KUNDENWORT, ROLLE_NOETIG_REIHENFOLGE } from '../rechte';
import type { RuhezeitRegeln, RuhezeitTeilfenster } from '../ruhezeit';
import { useRollen } from '../rollen';
import './Einstellungen.css';
import './EinstellungenPage.css';

/**
 * Die Einstellungs-Seite (Konzept `vp-einstellungen-konzept-e1`, Scheibe 1): löst das Modal
 * „Meine Benachrichtigungen" und den Menüeintrag „Als App auf dem Handy" ab (Entscheid 1A).
 * Vier Gruppen im Hausmuster von `AnlageTechnik.tsx` (`SettingRow`-Geschwister `Zeile`/`Gruppe`/
 * `Kachel`, dieselben `.vp-einst-*`-Klassen) - eine Seite statt eines Stapels (M1).
 *
 * Route `#/einstellungen`, Sprungmarken über `?abschnitt=wege|ruhezeit|konto|geraet`.
 */

const SCHUTZ: Record<ZweiStufen, string> = { alle: 'Warnung und Dringend', nur_dringend: 'Nur Dringend' };
const SCHWERE_LABEL: Record<Schwere, string> = { hinweis: 'Hinweis', warnung: 'Warnung', dringend: 'Dringend' };

/** Der in diesem Browser SELBST eingeschaltete Push-Abo - lokal gemerkt, weil die API die
 * Endpunkt-Kennung nicht liefert (M4, Gerät erkennen bleibt Scheibe 2). Kein Konto-Datum: eine
 * Browser-Vorliebe wie die drei bestehenden `localStorage`-Schlüssel des Portals. */
const PUSH_GERAET_SCHLUESSEL = 'vp-einst-push-geraet-abo-id';
function geraetAboId(): string | null {
  try {
    return localStorage.getItem(PUSH_GERAET_SCHLUESSEL);
  } catch {
    return null;
  }
}
function merkeGeraetAboId(id: string): void {
  try {
    localStorage.setItem(PUSH_GERAET_SCHLUESSEL, id);
  } catch {
    /* kein Speicher (privates Fenster) - "dieses Gerät" bleibt dann einfach unerkannt */
  }
}
function vergissGeraetAboId(): void {
  try {
    localStorage.removeItem(PUSH_GERAET_SCHLUESSEL);
  } catch {
    /* siehe oben */
  }
}

function kanalZielSatz(url: string): string {
  if (/webhook\.office\.com|logic\.azure\.com/i.test(url)) return 'Microsoft Teams';
  if (/hooks\.slack\.com/i.test(url)) return 'Slack';
  return 'Eigener Dienst';
}

type BlattArt =
  | { art: 'email' }
  | { art: 'push-geraet' }
  | { art: 'push-abo'; abo: PushAbo }
  | { art: 'weiterer-weg' }
  | { art: 'kanal'; ziel: WebhookZiel }
  | { art: 'telegram'; ziel: TelegramZiel }
  | { art: 'ruhezeit' }
  | { art: 'zusammenfassung' }
  | { art: 'rolle' }
  | { art: 'person' }
  | { art: 'passwort' }
  | { art: 'zwei-schritt' }
  | { art: 'geraet-app' };

type FolgeEintrag = { key: string; text: string; istFehler: boolean };

const SCHALT_FEHLER = 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';

/** "Probe senden" (Entscheid 10A) - ein Fehlschlag wirft nie, nur der Text unterscheidet sich. */
function probeFolge(key: string, ergebnis: ProbeErgebnis): FolgeEintrag {
  return ergebnis.erfolgreich
    ? { key, text: 'Testnachricht gesendet.', istFehler: false }
    : { key, text: ergebnis.fehler ?? SCHALT_FEHLER, istFehler: true };
}

function Kachel({ icon, kat }: { icon: IconName; kat: string }) {
  return (
    <span className={`vp-einst-tile is-${kat}`} aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  );
}

function Gruppe({ id, titel, children }: { id: string; titel: string; children: ReactNode }) {
  return (
    <section id={`einst-${id}`} className="vp-einst-grp" aria-labelledby={`einst-${id}-h`}>
      <h3 id={`einst-${id}-h`}>{titel}</h3>
      <ul className="vp-einst-liste">{children}</ul>
    </section>
  );
}

function Zeile({
  icon,
  kat,
  label,
  wert = null,
  sub = null,
  warn = false,
  onClick,
}: {
  icon: IconName;
  kat: string;
  label: string;
  wert?: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="vp-einst-zeile" onClick={onClick} aria-haspopup="dialog">
        <Kachel icon={icon} kat={kat} />
        <span className="vp-einst-lab">
          <b>{label}</b>
          {wert != null && <span className="vp-einst-wert">{wert}</span>}
          {sub && <small className={warn ? 'is-warn' : undefined}>{sub}</small>}
        </span>
        <span className="vp-einst-ende">
          <Icon name="chevron-right" size={18} />
        </span>
      </button>
    </li>
  );
}

/** Eine Zeile mit direktem Schalter statt Blatt - wie „Netzladen" in `AnlageTechnik.tsx`. */
function SchaltZeile({
  icon,
  kat,
  label,
  sub,
  checked,
  disabled,
  onChange,
}: {
  icon: IconName;
  kat: string;
  label: string;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  // `aria-labelledby` liest seinen Wert als Leerzeichen-getrennte Liste von Kennungen - das Label
  // darf darin also selbst keine Leerzeichen tragen.
  const id = `einst-schalt-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <li>
      <div className="vp-einst-zeile is-statisch">
        <Kachel icon={icon} kat={kat} />
        <span className="vp-einst-lab">
          <b id={id}>{label}</b>
          {sub && <small>{sub}</small>}
        </span>
        <span className="vp-einst-ende">
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={id}
            className={`vp-switch${checked ? ' on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(!checked)}
          >
            <span className="vp-switch-knob" aria-hidden="true" />
          </button>
        </span>
      </div>
    </li>
  );
}

/** Der Zwei-Stufen-Umschalter einer Weg-Zeile (§4.4) - `.vp-einst-seg` mit zwei statt drei Spalten. */
function StufenSchalter({
  id,
  wert,
  disabled,
  onChange,
}: {
  id: string;
  wert: ZweiStufen;
  disabled?: boolean;
  onChange: (next: ZweiStufen) => void;
}) {
  return (
    <div className="vp-einst-seg vp-meinst-seg2" role="radiogroup" aria-label={`Stufe für ${id}`}>
      {(['alle', 'nur_dringend'] as const).map((stufe) => (
        <button
          key={stufe}
          type="button"
          role="radio"
          aria-checked={wert === stufe}
          disabled={disabled}
          onClick={() => stufe !== wert && onChange(stufe)}
        >
          {SCHUTZ[stufe]}
        </button>
      ))}
    </div>
  );
}

function Folge({ eintrag }: { eintrag: FolgeEintrag | null }) {
  if (!eintrag) return null;
  return (
    <div className={`vp-einst-folge${eintrag.istFehler ? ' is-fehler' : ''}`} role={eintrag.istFehler ? 'alert' : 'status'}>
      <Icon name={eintrag.istFehler ? 'alert-triangle' : 'info'} size={15} />
      <span>{eintrag.text}</span>
    </div>
  );
}

export function EinstellungenPage() {
  const user = currentUser();
  const { selbst } = useRollen();

  const [laden, setLaden] = useState(true);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [ladeVersion, setLadeVersion] = useState(0);

  const [email, setEmail] = useState<EmailZustellweg | null>(null);
  const [pushAbos, setPushAbos] = useState<PushAbo[]>([]);
  const [webhookZiele, setWebhookZiele] = useState<WebhookZiel[]>([]);
  const [telegramZiele, setTelegramZiele] = useState<TelegramZiel[]>([]);
  const [telegramVerfuegbar, setTelegramVerfuegbar] = useState(false);
  const [regeln, setRegeln] = useState<RuhezeitRegeln>({});
  const [zeitzone, setZeitzone] = useState('Europe/Berlin');
  const [dringendDurch, setDringendDurch] = useState(true);
  const [ruhezeitBis, setRuhezeitBis] = useState<Date | null>(null);
  // M4 (Scheibe 2): der echte Browser-Endpunkt erkennt "dieses Gerät" zuverlässig, auch in einem
  // Tab/Profil, das es nie selbst angelegt hat - der lokal gemerkte Schlüssel (Scheibe 1) bleibt
  // nur der Rückfall, falls der Browser den Endpunkt (noch) nicht liefert.
  const [dieserEndpoint, setDieserEndpoint] = useState<string | null>(null);

  const [blatt, setBlatt] = useState<BlattArt | null>(null);
  const letztesBlatt = useRef<BlattArt | null>(null);
  if (blatt) letztesBlatt.current = blatt;
  const blattInhalt = blatt ?? letztesBlatt.current;

  const [busy, setBusy] = useState<string | null>(null);
  const [folge, setFolge] = useState<FolgeEintrag | null>(null);

  useEffect(() => {
    let aktiv = true;
    setLaden(true);
    setLadeFehler(false);
    Promise.all([
      benachrichtigungenApi.emailZustand(),
      benachrichtigungenApi.pushAbos(),
      benachrichtigungenApi.webhookZiele(),
      benachrichtigungenApi.telegramStatus(),
      benachrichtigungenApi.ruhezeit(),
    ])
      .then(([e, p, w, t, r]) => {
        if (!aktiv) return;
        setEmail(e ?? null);
        setPushAbos(p);
        setWebhookZiele(w);
        setTelegramZiele(t.ziele);
        setTelegramVerfuegbar(t.verfuegbar);
        const geleseneRegeln = JSON.parse(r.regeln) as RuhezeitRegeln;
        setRegeln(geleseneRegeln);
        setZeitzone(r.zeitzone);
        setDringendDurch(r.dringendDurch);
        return benachrichtigungenApi.ruhezeitProbe(r.regeln, r.zeitzone).then((bis) => {
          if (aktiv) setRuhezeitBis(bis ? new Date(bis) : null);
        });
      })
      .catch(() => {
        if (aktiv) setLadeFehler(true);
      })
      .finally(() => {
        if (aktiv) setLaden(false);
      });
    return () => {
      aktiv = false;
    };
  }, [ladeVersion]);

  // Sprungmarke `?abschnitt=` (wie `settingsNav.ts` es für die Anlage tut) - einmal beim Laden.
  useEffect(() => {
    const q = window.location.hash.indexOf('?');
    if (q < 0) return;
    const ziel = new URLSearchParams(window.location.hash.slice(q + 1)).get('abschnitt');
    if (!ziel) return;
    document.getElementById(`einst-${ziel}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // M4: der Browser-Endpunkt dieses Geräts, unabhängig vom Haupt-Ladevorgang (nie blockierend).
  useEffect(() => {
    let aktiv = true;
    void aktuellerPushEndpoint().then((e) => {
      if (aktiv) setDieserEndpoint(e);
    });
    return () => {
      aktiv = false;
    };
  }, [ladeVersion]);

  // Rückkehr von einem Keycloak-Konto-Schritt (Entscheid 6A): einmalig den Status zeigen.
  const kontoAktion = useSyncExternalStore(subscribeKontoAktion, kontoAktionSnapshot);
  useEffect(() => {
    if (!kontoAktion) return;
    const text =
      kontoAktion.status === 'success'
        ? kontoAktion.action === 'CONFIGURE_TOTP'
          ? 'Zwei-Schritt-Anmeldung eingerichtet.'
          : 'Passwort geändert.'
        : kontoAktion.status === 'cancelled'
          ? null
          : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.';
    if (text) setFolge({ key: 'konto-aktion', text, istFehler: kontoAktion.status === 'error' });
    kontoAktionZuruecksetzen();
  }, [kontoAktion]);

  function schliesse() {
    setBlatt(null);
  }
  function oeffne(b: BlattArt) {
    setFolge(null);
    setBlatt(b);
  }

  async function ruhezeitSpeichern(naechste: RuhezeitRegeln, naechsteDringendDurch = dringendDurch) {
    setRegeln(naechste);
    setDringendDurch(naechsteDringendDurch);
    setBusy('ruhezeit');
    try {
      await benachrichtigungenApi.ruhezeitSetzen(JSON.stringify(naechste), zeitzone, naechsteDringendDurch);
      const bis = await benachrichtigungenApi.ruhezeitProbe(JSON.stringify(naechste), zeitzone);
      setRuhezeitBis(bis ? new Date(bis) : null);
      setFolge({ key: 'ruhezeit', text: 'Gespeichert.', istFehler: false });
    } catch {
      setFolge({ key: 'ruhezeit', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  async function emailStufeSetzen(stufe: ZweiStufen) {
    if (!email) return;
    const abSchwere = schwereAusStufe(stufe);
    setEmail({ ...email, abSchwere });
    setBusy('email');
    try {
      await benachrichtigungenApi.emailEinstellungenSetzen(abSchwere, email.zusammenfassungAktiv, email.zusammenfassungUhrzeit);
      setFolge({ key: 'email', text: 'Gespeichert.', istFehler: false });
    } catch {
      setFolge({ key: 'email', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  async function emailAnfordern(adresse: string) {
    setBusy('email-anfordern');
    try {
      await benachrichtigungenApi.emailAnfordern(adresse);
      setFolge({ key: 'email', text: `Link an ${adresse} gesendet - bitte dort öffnen.`, istFehler: false });
      setLadeVersion((v) => v + 1);
    } catch {
      setFolge({ key: 'email', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  /** "E-Mail-Weg abschalten"/wieder einschalten (Scheibe 2, B12) - die Adresse bleibt erhalten. */
  async function emailAktivSetzen(aktiv: boolean) {
    if (!email) return;
    setEmail({ ...email, aktiv });
    setBusy('email');
    try {
      await benachrichtigungenApi.emailAktivSetzen(aktiv);
      setFolge({ key: 'email', text: aktiv ? 'Wieder eingeschaltet.' : 'Abgeschaltet.', istFehler: false });
    } catch {
      setEmail({ ...email, aktiv: !aktiv });
      setFolge({ key: 'email', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  /** "E-Mail-Weg entfernen" (Scheibe 2, B12). */
  async function emailEntfernen() {
    setBusy('email');
    try {
      await benachrichtigungenApi.emailEntfernen();
      setEmail(null);
      schliesse();
    } catch {
      setFolge({ key: 'email', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  /** "Probe-Mail senden" (Entscheid 10A). */
  async function emailProbeSenden() {
    setBusy('email-probe');
    try {
      const ergebnis = await benachrichtigungenApi.emailProbe();
      setFolge(probeFolge('email', ergebnis));
    } catch {
      setFolge({ key: 'email', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  async function pushGeraetEinschalten() {
    setBusy('push-geraet');
    try {
      const abo = await pushEinschalten(geraeteVorschlag());
      merkeGeraetAboId(abo.id);
      const liste = await benachrichtigungenApi.pushAbos();
      setPushAbos(liste);
      setFolge({ key: 'push-geraet', text: 'Push eingeschaltet.', istFehler: false });
    } catch (e) {
      setFolge({ key: 'push-geraet', text: e instanceof Error ? e.message : SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  async function pushGeraetBeenden(id: string) {
    setBusy('push-geraet');
    try {
      await benachrichtigungenApi.pushEntfernen(id);
      vergissGeraetAboId();
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        await sub?.unsubscribe();
      } catch {
        /* das Abo ist serverseitig trotzdem beendet */
      }
      setPushAbos((liste) => liste.filter((a) => a.id !== id));
      schliesse();
    } catch {
      setFolge({ key: 'push-geraet', text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  function pushAboAendern(id: string, aktiv: boolean, abSchwere: Schwere) {
    setPushAbos((liste) => liste.map((a) => (a.id === id ? { ...a, aktiv, abSchwere } : a)));
    void benachrichtigungenApi.pushEinstellungenSetzen(id, aktiv, abSchwere);
  }

  function pushAboEntfernen(id: string) {
    setPushAbos((liste) => liste.filter((a) => a.id !== id));
    void benachrichtigungenApi.pushEntfernen(id);
    schliesse();
  }

  /** "Gerät umbenennen" (Scheibe 2, §4.12). */
  function pushNameSetzen(id: string, geraet: string) {
    setPushAbos((liste) => liste.map((a) => (a.id === id ? { ...a, geraet } : a)));
    void benachrichtigungenApi.pushNameSetzen(id, geraet);
  }

  /** "Probe-Mitteilung senden" (Entscheid 10A). */
  async function pushProbeSenden(id: string) {
    setBusy('push-probe');
    try {
      const ergebnis = await benachrichtigungenApi.pushProbe(id);
      setFolge(probeFolge(id, ergebnis));
    } catch {
      setFolge({ key: id, text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  function kanalAendern(id: string, aktiv: boolean, abSchwere: Schwere) {
    setWebhookZiele((liste) => liste.map((z) => (z.id === id ? { ...z, aktiv, abSchwere } : z)));
    void benachrichtigungenApi.webhookZielEinstellungenSetzen(id, aktiv, abSchwere);
  }

  function kanalEntfernen(id: string) {
    setWebhookZiele((liste) => liste.filter((z) => z.id !== id));
    void benachrichtigungenApi.webhookZielEntfernen(id);
    schliesse();
  }

  /** "Team-Kanal bearbeiten" (Scheibe 2, §4.12). */
  async function kanalBearbeiten(id: string, url: string, name: string) {
    setBusy('kanal-bearbeiten');
    try {
      await benachrichtigungenApi.webhookZielBearbeiten(id, url, name);
      setWebhookZiele((liste) => liste.map((z) => (z.id === id ? { ...z, url, name } : z)));
      setFolge({ key: 'kanal-bearbeiten', text: 'Gespeichert.', istFehler: false });
      return true;
    } catch (e) {
      setFolge({
        key: 'kanal-bearbeiten',
        text: e instanceof Error ? e.message : SCHALT_FEHLER,
        istFehler: true,
      });
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** "Probe senden" (Entscheid 10A). */
  async function kanalProbeSenden(id: string) {
    setBusy('kanal-probe');
    try {
      const ergebnis = await benachrichtigungenApi.webhookProbe(id);
      setFolge(probeFolge(id, ergebnis));
    } catch {
      setFolge({ key: id, text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  function telegramAendern(id: string, aktiv: boolean, abSchwere: Schwere) {
    setTelegramZiele((liste) => liste.map((z) => (z.id === id ? { ...z, aktiv, abSchwere } : z)));
    void benachrichtigungenApi.telegramZielEinstellungenSetzen(id, aktiv, abSchwere);
  }

  function telegramTrennen(id: string) {
    setTelegramZiele((liste) => liste.filter((z) => z.id !== id));
    void benachrichtigungenApi.telegramZielEntfernen(id);
    schliesse();
  }

  /** "Probe senden" (Entscheid 10A) - nur für eine bereits bestätigte Verbindung. */
  async function telegramProbeSenden(id: string) {
    setBusy('telegram-probe');
    try {
      const ergebnis = await benachrichtigungenApi.telegramProbe(id);
      setFolge(probeFolge(id, ergebnis));
    } catch {
      setFolge({ key: id, text: SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  async function telegramVerbinden() {
    setBusy('telegram');
    try {
      const link = await benachrichtigungenApi.telegramVerbinden();
      window.open(link, '_blank', 'noopener,noreferrer');
      const status = await benachrichtigungenApi.telegramStatus();
      setTelegramZiele(status.ziele);
      schliesse();
    } catch (e) {
      setFolge({ key: 'telegram', text: e instanceof Error ? e.message : SCHALT_FEHLER, istFehler: true });
    } finally {
      setBusy(null);
    }
  }

  const geraetAbo = dieserEndpoint
    ? pushAbos.find((a) => a.endpoint === dieserEndpoint)
    : pushAbos.find((a) => a.id === geraetAboId());
  const andereAbos = pushAbos.filter((a) => a.id !== geraetAbo?.id);

  const kurzbildWege: KurzbildWeg[] = [
    ...(email ? [{ label: 'E-Mail', schwere: email.abSchwere, aktiv: email.bestaetigt && email.aktiv }] : []),
    ...(geraetAbo ? [{ label: 'Push', schwere: geraetAbo.abSchwere, aktiv: geraetAbo.aktiv }] : []),
    ...andereAbos.map((a) => ({ label: 'Push', schwere: a.abSchwere, aktiv: a.aktiv })),
    ...webhookZiele.map((z) => ({ label: 'Team-Kanal', schwere: z.abSchwere, aktiv: z.aktiv })),
    ...telegramZiele.filter((z) => z.bestaetigt).map((z) => ({ label: 'Telegram', schwere: z.abSchwere, aktiv: z.aktiv })),
  ];
  const kurzbild = baueKurzbild(kurzbildWege, ruhezeitBis, dringendDurch);

  const preset = ruhezeitPresetVon(regeln);
  const rolle = [...ROLLE_NOETIG_REIHENFOLGE].reverse().find((r) => selbst?.rollen.includes(r));
  const rolleUndZugangSichtbar = !!selbst && (!selbst.unternehmensweit || (selbst.kundenadministratoren?.length ?? 0) > 0);

  // Das Blatt merkt sich bei seinem Öffnen nur die ID; Stufe/Schalter/Name zeigen den LEBENDIGEN
  // Datensatz, damit ein Bearbeiten (Scheibe 2) oder ein Umschalten sofort in diesem Blatt sichtbar
  // wird, statt erst nach dem erneuten Öffnen.
  const lebendigerPushAbo = blattInhalt?.art === 'push-abo'
    ? (pushAbos.find((a) => a.id === blattInhalt.abo.id) ?? blattInhalt.abo)
    : null;
  const lebendigerKanal = blattInhalt?.art === 'kanal'
    ? (webhookZiele.find((z) => z.id === blattInhalt.ziel.id) ?? blattInhalt.ziel)
    : null;
  const lebendigeTelegramVerbindung = blattInhalt?.art === 'telegram'
    ? (telegramZiele.find((z) => z.id === blattInhalt.ziel.id) ?? blattInhalt.ziel)
    : null;

  if (laden) {
    return (
      <div className="vp-einst">
        <header className="vp-meinst-kopf">
          <h1>Einstellungen</h1>
        </header>
        <p className="vp-note">Wird geladen …</p>
      </div>
    );
  }
  if (ladeFehler) {
    return (
      <div className="vp-einst">
        <header className="vp-meinst-kopf">
          <h1>Einstellungen</h1>
        </header>
        <p className="vp-alert" role="alert">
          Die Einstellungen konnten nicht geladen werden.{' '}
          <button type="button" className="vp-linklike" onClick={() => setLadeVersion((v) => v + 1)}>
            Erneut laden
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="vp-einst">
      <header className="vp-meinst-kopf">
        <h1>Einstellungen</h1>
        <p>Für Sie persönlich: wie eine Meldung Sie erreicht, Ruhezeit und Zusammenfassung, Ihr Konto, dieses Gerät.</p>
      </header>

      <button type="button" className="vp-meinst-person" onClick={() => oeffne({ art: 'person' })} aria-haspopup="dialog">
        <span className="vp-meinst-person-av" aria-hidden="true">
          {(user.name || 'VP').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
        </span>
        <span className="vp-meinst-person-txt">
          <span className="vp-meinst-person-n">{user.name}</span>
          {user.email && user.email !== user.name && <span className="vp-meinst-person-e">{user.email}</span>}
          {rolle && <span className="vp-meinst-person-r">{ROLLE_KUNDENWORT[rolle]}</span>}
        </span>
        <Icon name="chevron-right" size={18} />
      </button>

      <section className="vp-meinst-kurzbild" aria-labelledby="einst-kurzbild-h">
        <h2 id="einst-kurzbild-h">So erreicht Sie eine Meldung jetzt</h2>
        {kurzbild.zeilen.map((z) => (
          <p key={z.schwere} className="vp-meinst-kurzbild-zeile">
            <span className="vp-meinst-kurzbild-stufe">{SCHWERE_LABEL[z.schwere]}</span>
            <span>
              {z.schwere === 'hinweis'
                ? 'nur hier'
                : z.wartet
                  ? `wartet${ruhezeitBis ? ` bis ${ruhezeitBis.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : ''}`
                  : z.wege.length > 0
                    ? z.wege.join(' · ')
                    : 'nur hier'}
            </span>
          </p>
        ))}
      </section>

      <div className="vp-einst-raster">
        <Gruppe id="wege" titel="So erreichen wir Sie">
          {/* Push, dieses Gerät - immer zuerst (§4.4), lokal anhand des selbst angelegten Abos erkannt (M4). */}
          <Zeile
            icon="smartphone"
            kat="dynamic"
            label="Push auf diesem Gerät"
            wert={geraetAbo ? SCHUTZ[stufeAusSchwere(geraetAbo.abSchwere)] : 'Nicht eingerichtet'}
            onClick={() => oeffne({ art: 'push-geraet' })}
          />
          {andereAbos.map((abo) => (
            <Zeile
              key={abo.id}
              icon="smartphone"
              kat="dynamic"
              label={abo.geraet || 'Push'}
              wert={SCHUTZ[stufeAusSchwere(abo.abSchwere)]}
              onClick={() => oeffne({ art: 'push-abo', abo })}
            />
          ))}
          <Zeile
            icon="file-text"
            kat="navy"
            label="E-Mail"
            wert={email ? email.ziel : 'Nicht eingerichtet'}
            warn={!!email && !email.bestaetigt}
            sub={email && !email.bestaetigt ? 'Wartet auf Bestätigung' : null}
            onClick={() => oeffne({ art: 'email' })}
          />
          {webhookZiele.map((ziel) => (
            <Zeile
              key={ziel.id}
              icon="link"
              kat="grid"
              label="Team-Kanal"
              wert={ziel.name || kanalZielSatz(ziel.url)}
              onClick={() => oeffne({ art: 'kanal', ziel })}
            />
          ))}
          {telegramZiele.map((ziel) => (
            <Zeile
              key={ziel.id}
              icon="wifi"
              kat="home"
              label="Telegram"
              wert={ziel.bestaetigt ? 'Verbunden' : 'Wartet auf „Starten" in Telegram'}
              onClick={() => oeffne({ art: 'telegram', ziel })}
            />
          ))}
          <Zeile icon="plus" kat="navy" label="Weiteren Weg verbinden" onClick={() => oeffne({ art: 'weiterer-weg' })} />
        </Gruppe>

        <Gruppe id="ruhezeit" titel="Ruhezeit und Zusammenfassung">
          <Zeile
            icon="history"
            kat="navy"
            label="Ruhezeit"
            wert={RUHEZEIT_PRESET_LABEL[preset]}
            onClick={() => oeffne({ art: 'ruhezeit' })}
          />
          <SchaltZeile
            icon="alert-triangle"
            kat="gefahr"
            label="Dringendes trotzdem melden"
            checked={dringendDurch}
            disabled={busy === 'ruhezeit'}
            onChange={(next) => void ruhezeitSpeichern(regeln, next)}
          />
          {email?.bestaetigt ? (
            <Zeile
              icon="list"
              kat="home"
              label="Tages-Zusammenfassung"
              wert={email.zusammenfassungAktiv ? `Per E-Mail um ${email.zusammenfassungUhrzeit.slice(0, 5)} Uhr` : 'Aus'}
              onClick={() => oeffne({ art: 'zusammenfassung' })}
            />
          ) : (
            <Zeile
              icon="list"
              kat="home"
              label="Tages-Zusammenfassung"
              wert="Aus"
              warn
              sub="Braucht eine bestätigte E-Mail-Adresse"
              onClick={() => document.getElementById('einst-wege')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />
          )}
        </Gruppe>

        <Gruppe id="konto" titel="Ihr Konto">
          {rolleUndZugangSichtbar && (
            <Zeile icon="users" kat="grid" label="Rolle und Zugang" onClick={() => oeffne({ art: 'rolle' })} />
          )}
          <Zeile icon="lock" kat="navy" label="Passwort ändern" onClick={() => oeffne({ art: 'passwort' })} />
          <Zeile icon="shield" kat="battery" label="Zwei-Schritt-Anmeldung" onClick={() => oeffne({ art: 'zwei-schritt' })} />
          <li>
            {/* B8 (Scheibe 0): erst dieses Geräts Push-Abo aufräumen, dann abmelden - wie der
                Abmelden-Weg im Avatar-Menü (AppShell.tsx), bestmöglich, hält nie auf. */}
            <button
              type="button"
              className="vp-einst-zeile is-gefahr"
              onClick={() => void pushBeiAbmeldenAufraeumen().finally(logout)}
            >
              <Kachel icon="log-out" kat="gefahr" />
              <span className="vp-einst-lab">
                <b>Abmelden</b>
              </span>
              <span className="vp-einst-ende" />
            </button>
          </li>
        </Gruppe>

        <Gruppe id="geraet" titel="Dieses Gerät">
          <Zeile icon="smartphone" kat="battery" label="Als App auf diesem Gerät" onClick={() => oeffne({ art: 'geraet-app' })} />
        </Gruppe>
      </div>

      <Modal open={blatt != null} onClose={schliesse} title={blattTitel(blattInhalt)}>
        {blattInhalt?.art === 'person' && (
          <div className="vp-einst-blatt">
            <dl className="vp-kv">
              <div className="vp-kv-row">
                <dt className="vp-kv-k">Name</dt>
                <dd className="vp-kv-v">{user.name}</dd>
              </div>
              {user.email && (
                <div className="vp-kv-row">
                  <dt className="vp-kv-k">Anmelde-E-Mail</dt>
                  <dd className="vp-kv-v">{user.email}</dd>
                </div>
              )}
            </dl>
            <p className="vp-note">
              {selbst?.kundenadministratoren?.length
                ? `Beides ändert ${selbst.kundenadministratoren.length === 1 ? 'Ihr Kundenadministrator' : 'ein Kundenadministrator'} ${selbst.kundenadministratoren.map((p) => p.name).join(', ')}, damit Nachweise den geprüften Namen tragen.`
                : 'Beides ändert Ihr Kundenadministrator, damit Nachweise den geprüften Namen tragen.'}
            </p>
          </div>
        )}

        {blattInhalt?.art === 'email' && (
          <EmailBlatt
            email={email}
            busy={busy != null}
            onAnfordern={emailAnfordern}
            onStufe={emailStufeSetzen}
            onAktivSetzen={(a) => void emailAktivSetzen(a)}
            onEntfernen={() => void emailEntfernen()}
            onProbe={() => void emailProbeSenden()}
            folge={folge?.key === 'email' || folge?.key === 'email-anfordern' ? folge : null}
          />
        )}

        {blattInhalt?.art === 'push-geraet' && (
          <PushGeraetBlatt
            abo={geraetAbo ?? null}
            busy={busy === 'push-geraet' || busy === 'push-probe'}
            onEinschalten={() => void pushGeraetEinschalten()}
            onStufe={(s) => geraetAbo && pushAboAendern(geraetAbo.id, geraetAbo.aktiv, schwereAusStufe(s))}
            onBeenden={() => geraetAbo && void pushGeraetBeenden(geraetAbo.id)}
            onNameSetzen={(name) => geraetAbo && pushNameSetzen(geraetAbo.id, name)}
            onProbe={() => geraetAbo && void pushProbeSenden(geraetAbo.id)}
            folge={folge?.key === 'push-geraet' || folge?.key === geraetAbo?.id ? folge : null}
          />
        )}

        {blattInhalt?.art === 'push-abo' && lebendigerPushAbo && (
          <PushAboBlatt
            abo={lebendigerPushAbo}
            busy={busy === 'push-probe'}
            onStufe={(s) => pushAboAendern(lebendigerPushAbo.id, lebendigerPushAbo.aktiv, schwereAusStufe(s))}
            onAktivSetzen={(a) => pushAboAendern(lebendigerPushAbo.id, a, lebendigerPushAbo.abSchwere)}
            onNameSetzen={(name) => pushNameSetzen(lebendigerPushAbo.id, name)}
            onProbe={() => void pushProbeSenden(lebendigerPushAbo.id)}
            onEntfernen={() => pushAboEntfernen(lebendigerPushAbo.id)}
            folge={folge?.key === lebendigerPushAbo.id ? folge : null}
          />
        )}

        {blattInhalt?.art === 'kanal' && lebendigerKanal && (
          <KanalBlatt
            ziel={lebendigerKanal}
            busy={busy === 'kanal-bearbeiten' || busy === 'kanal-probe'}
            onStufe={(s) => kanalAendern(lebendigerKanal.id, lebendigerKanal.aktiv, schwereAusStufe(s))}
            onAktivSetzen={(a) => kanalAendern(lebendigerKanal.id, a, lebendigerKanal.abSchwere)}
            onBearbeiten={(url, name) => kanalBearbeiten(lebendigerKanal.id, url, name)}
            onProbe={() => void kanalProbeSenden(lebendigerKanal.id)}
            onEntfernen={() => kanalEntfernen(lebendigerKanal.id)}
            folge={folge?.key === 'kanal-bearbeiten' || folge?.key === lebendigerKanal.id ? folge : null}
          />
        )}

        {blattInhalt?.art === 'telegram' && lebendigeTelegramVerbindung && (
          <div className="vp-einst-blatt">
            <p className="vp-note">{lebendigeTelegramVerbindung.bestaetigt ? 'Verbunden' : 'Wartet auf „Starten" in Telegram'}</p>
            <StufenSchalter
              id={lebendigeTelegramVerbindung.id}
              wert={stufeAusSchwere(lebendigeTelegramVerbindung.abSchwere)}
              onChange={(s) => telegramAendern(lebendigeTelegramVerbindung.id, lebendigeTelegramVerbindung.aktiv, schwereAusStufe(s))}
            />
            <Switch
              checked={lebendigeTelegramVerbindung.aktiv}
              onChange={(e) => telegramAendern(lebendigeTelegramVerbindung.id, e.target.checked, lebendigeTelegramVerbindung.abSchwere)}
              label="Eingeschaltet"
            />
            {lebendigeTelegramVerbindung.bestaetigt && (
              <Button
                type="button"
                variant="outline"
                size="md"
                disabled={busy === 'telegram-probe'}
                onClick={() => void telegramProbeSenden(lebendigeTelegramVerbindung.id)}
              >
                Probe senden
              </Button>
            )}
            <Button type="button" variant="ghost" size="md" onClick={() => telegramTrennen(lebendigeTelegramVerbindung.id)}>
              Trennen
            </Button>
            <Folge eintrag={folge?.key === lebendigeTelegramVerbindung.id ? folge : null} />
          </div>
        )}

        {blattInhalt?.art === 'weiterer-weg' && (
          <WeitererWegBlatt
            telegramVerfuegbar={telegramVerfuegbar}
            busy={busy}
            onTelegram={() => void telegramVerbinden()}
            onKanalAngelegt={(z) => {
              setWebhookZiele((liste) => [...liste, z]);
            }}
            folge={folge?.key === 'telegram' ? folge : null}
          />
        )}

        {blattInhalt?.art === 'ruhezeit' && (
          <RuhezeitBlatt
            preset={preset}
            regeln={regeln}
            zeitzone={zeitzone}
            busy={busy === 'ruhezeit'}
            onPreset={(p) => void ruhezeitSpeichern(ruhezeitRegelnFuerPreset(p, regeln))}
            onRegeln={(r) => void ruhezeitSpeichern(r)}
            folge={folge?.key === 'ruhezeit' ? folge : null}
          />
        )}

        {blattInhalt?.art === 'zusammenfassung' && email?.bestaetigt && (
          <div className="vp-einst-blatt">
            <Switch
              checked={email.zusammenfassungAktiv}
              onChange={(e) => {
                setEmail({ ...email, zusammenfassungAktiv: e.target.checked });
                void benachrichtigungenApi.emailEinstellungenSetzen(email.abSchwere, e.target.checked, email.zusammenfassungUhrzeit);
              }}
              label="Tages-Zusammenfassung"
            />
            {email.zusammenfassungAktiv && (
              <VpTimePicker
                label="Uhrzeit"
                value={email.zusammenfassungUhrzeit.slice(0, 5)}
                onChange={(v) => {
                  setEmail({ ...email, zusammenfassungUhrzeit: `${v}:00` });
                  void benachrichtigungenApi.emailEinstellungenSetzen(email.abSchwere, email.zusammenfassungAktiv, `${v}:00`);
                }}
              />
            )}
            <p className="vp-note">Die Ruhezeit gilt hier nicht.</p>
          </div>
        )}

        {blattInhalt?.art === 'rolle' && selbst && (
          <div className="vp-einst-blatt">
            {rolle && <p className="vp-einst-gross">{ROLLE_KUNDENWORT[rolle]}</p>}
            <p className="vp-note">
              {selbst.unternehmensweit
                ? 'Gilt für das ganze Unternehmen, auch künftige Standorte.'
                : selbst.standorte.length > 0
                  ? `Gilt für: ${selbst.standorte.map((s) => s.name).join(', ')}.`
                  : 'Noch keinem Standort zugewiesen.'}
            </p>
            {selbst.kundenadministratoren?.length > 0 && (
              <p className="vp-note">
                Ändern kann das {selbst.kundenadministratoren.length === 1 ? 'Ihr Kundenadministrator' : 'Ihre Kundenadministratoren'}:{' '}
                {selbst.kundenadministratoren.map((p) => p.name).join(', ')}.
              </p>
            )}
          </div>
        )}

        {blattInhalt?.art === 'passwort' && (
          <div className="vp-einst-blatt">
            <p className="vp-note">Sie werden zu einer gesicherten Seite weitergeleitet, dort ein neues Passwort setzen und kehren hierher zurück.</p>
            <Button type="button" size="md" onClick={() => kontoAktionAusfuehren('UPDATE_PASSWORD')}>
              Passwort ändern
            </Button>
          </div>
        )}

        {blattInhalt?.art === 'zwei-schritt' && (
          <div className="vp-einst-blatt">
            <p className="vp-note">Sie werden zu einer gesicherten Seite weitergeleitet, dort die Zwei-Schritt-Anmeldung einrichten und kehren hierher zurück.</p>
            <Button type="button" size="md" onClick={() => kontoAktionAusfuehren('CONFIGURE_TOTP')}>
              Zwei-Schritt-Anmeldung einrichten
            </Button>
          </div>
        )}

        {blattInhalt?.art === 'geraet-app' && (
          <div className="vp-einst-blatt">
            <InstallAppPanel />
          </div>
        )}
      </Modal>
    </div>
  );
}

function blattTitel(b: BlattArt | null): string {
  switch (b?.art) {
    case 'person':
      return 'Ihr Konto';
    case 'email':
      return 'E-Mail';
    case 'push-geraet':
      return 'Push auf diesem Gerät';
    case 'push-abo':
      return b.abo.geraet || 'Push';
    case 'weiterer-weg':
      return 'Weiteren Weg verbinden';
    case 'kanal':
      return 'Team-Kanal';
    case 'telegram':
      return 'Telegram';
    case 'ruhezeit':
      return 'Ruhezeit';
    case 'zusammenfassung':
      return 'Tages-Zusammenfassung';
    case 'rolle':
      return 'Rolle und Zugang';
    case 'passwort':
      return 'Passwort ändern';
    case 'zwei-schritt':
      return 'Zwei-Schritt-Anmeldung';
    case 'geraet-app':
      return 'Als App auf diesem Gerät';
    default:
      return '';
  }
}

// --------------------------------------------------------------------------------------- Blätter

function EmailBlatt({
  email,
  busy,
  onAnfordern,
  onStufe,
  onAktivSetzen,
  onEntfernen,
  onProbe,
  folge,
}: {
  email: EmailZustellweg | null;
  busy: boolean;
  onAnfordern: (adresse: string) => void;
  onStufe: (stufe: ZweiStufen) => void;
  onAktivSetzen: (aktiv: boolean) => void;
  onEntfernen: () => void;
  onProbe: () => void;
  folge: FolgeEintrag | null;
}) {
  const [adresse, setAdresse] = useState(email?.ziel ?? '');
  const [andereAnzeigen, setAndereAnzeigen] = useState(false);

  if (!email) {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Die Adresse ist vorbelegt - ein Tipp genügt, der Link kommt sofort.</p>
        <Input label="E-Mail-Adresse" type="email" value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="name@beispiel.de" />
        <Button type="button" size="md" disabled={busy || !adresse.trim()} onClick={() => onAnfordern(adresse.trim())}>
          Bestätigungs-Link senden
        </Button>
        <Folge eintrag={folge} />
      </div>
    );
  }
  if (!email.bestaetigt) {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Noch nicht bestätigt. Bitte öffnen Sie den Link in der Mail an {email.ziel}.</p>
        <Button type="button" size="md" variant="outline" disabled={busy} onClick={() => onAnfordern(email.ziel)}>
          Link erneut senden
        </Button>
        {!andereAnzeigen ? (
          <button type="button" className="vp-linklike" onClick={() => setAndereAnzeigen(true)}>
            Andere Adresse
          </button>
        ) : (
          <>
            <Input label="Andere E-Mail-Adresse" type="email" value={adresse} onChange={(e) => setAdresse(e.target.value)} />
            <Button type="button" size="md" disabled={busy || !adresse.trim()} onClick={() => onAnfordern(adresse.trim())}>
              Bestätigungs-Link senden
            </Button>
          </>
        )}
        <Folge eintrag={folge} />
      </div>
    );
  }
  return (
    <div className="vp-einst-blatt">
      <p className="vp-note">{email.ziel} · Bestätigt</p>
      <Switch checked={email.aktiv} disabled={busy} onChange={(e) => onAktivSetzen(e.target.checked)} label="Eingeschaltet" />
      <StufenSchalter id="email" wert={stufeAusSchwere(email.abSchwere)} disabled={busy || !email.aktiv} onChange={onStufe} />
      <Button type="button" variant="outline" size="md" disabled={busy} onClick={onProbe}>
        Probe-Mail senden
      </Button>
      {!andereAnzeigen ? (
        <button type="button" className="vp-linklike" onClick={() => setAndereAnzeigen(true)}>
          Andere Adresse
        </button>
      ) : (
        <>
          <Input label="Andere E-Mail-Adresse" type="email" value={adresse} onChange={(e) => setAdresse(e.target.value)} />
          <Button type="button" size="md" disabled={busy || !adresse.trim()} onClick={() => onAnfordern(adresse.trim())}>
            Bestätigungs-Link senden
          </Button>
        </>
      )}
      <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onEntfernen}>
        E-Mail-Weg entfernen
      </Button>
      <Folge eintrag={folge} />
    </div>
  );
}

function PushGeraetBlatt({
  abo,
  busy,
  onEinschalten,
  onStufe,
  onBeenden,
  onNameSetzen,
  onProbe,
  folge,
}: {
  abo: PushAbo | null;
  busy: boolean;
  onEinschalten: () => void;
  onStufe: (s: ZweiStufen) => void;
  onBeenden: () => void;
  onNameSetzen: (name: string) => void;
  onProbe: () => void;
  folge: FolgeEintrag | null;
}) {
  if (abo) {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Push an auf diesem Gerät.</p>
        <GeraetNameFeld geraet={abo.geraet} busy={busy} onNameSetzen={onNameSetzen} />
        <StufenSchalter id="push-geraet" wert={stufeAusSchwere(abo.abSchwere)} disabled={busy} onChange={onStufe} />
        <Button type="button" variant="outline" size="md" disabled={busy} onClick={onProbe}>
          Probe-Mitteilung senden
        </Button>
        <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onBeenden}>
          Push auf diesem Gerät beenden
        </Button>
        <Folge eintrag={folge} />
      </div>
    );
  }
  if (istIosOhneInstallierteApp()) {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Auf dem iPhone geht Push erst als installierte App - zuerst „Als App auf diesem Gerät" einrichten.</p>
      </div>
    );
  }
  if (!pushUnterstuetzt()) {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Dieser Browser unterstützt Push nicht.</p>
      </div>
    );
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return (
      <div className="vp-einst-blatt">
        <p className="vp-note">Push ist in diesem Browser gesperrt. Öffnen Sie die Website-Informationen neben der Adresse und erlauben Sie Benachrichtigungen.</p>
      </div>
    );
  }
  return (
    <div className="vp-einst-blatt">
      <p className="vp-note">Gleich fragt der Browser: bitte Erlauben.</p>
      <Button type="button" size="md" disabled={busy} onClick={onEinschalten}>
        Push einschalten
      </Button>
      <Folge eintrag={folge} />
    </div>
  );
}

/** "Gerät umbenennen" (Scheibe 2, §4.12) - ein Feld, Speichern nur bei einem wirklich geänderten Namen. */
function GeraetNameFeld({
  geraet,
  busy,
  onNameSetzen,
}: {
  geraet: string;
  busy: boolean;
  onNameSetzen: (name: string) => void;
}) {
  const [wert, setWert] = useState(geraet);
  const geaendert = wert.trim() !== '' && wert.trim() !== geraet;
  return (
    <div className="vp-meinst-geraet-name">
      <Input label="Name" value={wert} onChange={(e) => setWert(e.target.value)} />
      {geaendert && (
        <Button type="button" size="md" variant="outline" disabled={busy} onClick={() => onNameSetzen(wert.trim())}>
          Umbenennen
        </Button>
      )}
    </div>
  );
}

/** Ein WEITERES Geräte-Abo (nicht dieses Gerät) - Stufe, Schalter, umbenennen, Probe, entfernen. */
function PushAboBlatt({
  abo,
  busy,
  onStufe,
  onAktivSetzen,
  onNameSetzen,
  onProbe,
  onEntfernen,
  folge,
}: {
  abo: PushAbo;
  busy: boolean;
  onStufe: (s: ZweiStufen) => void;
  onAktivSetzen: (aktiv: boolean) => void;
  onNameSetzen: (name: string) => void;
  onProbe: () => void;
  onEntfernen: () => void;
  folge: FolgeEintrag | null;
}) {
  return (
    <div className="vp-einst-blatt">
      <GeraetNameFeld geraet={abo.geraet} busy={busy} onNameSetzen={onNameSetzen} />
      <StufenSchalter id={abo.id} wert={stufeAusSchwere(abo.abSchwere)} disabled={busy} onChange={onStufe} />
      <Switch checked={abo.aktiv} disabled={busy} onChange={(e) => onAktivSetzen(e.target.checked)} label="Eingeschaltet" />
      <Button type="button" variant="outline" size="md" disabled={busy} onClick={onProbe}>
        Probe-Mitteilung senden
      </Button>
      <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onEntfernen}>
        Entfernen
      </Button>
      <Folge eintrag={folge} />
    </div>
  );
}

/** Team-Kanal: Stufe, Schalter, "Bearbeiten" (Adresse/Name), Probe, Entfernen (Scheibe 2, §4.12). */
function KanalBlatt({
  ziel,
  busy,
  onStufe,
  onAktivSetzen,
  onBearbeiten,
  onProbe,
  onEntfernen,
  folge,
}: {
  ziel: WebhookZiel;
  busy: boolean;
  onStufe: (s: ZweiStufen) => void;
  onAktivSetzen: (aktiv: boolean) => void;
  onBearbeiten: (url: string, name: string) => Promise<boolean>;
  onProbe: () => void;
  onEntfernen: () => void;
  folge: FolgeEintrag | null;
}) {
  const [bearbeitenOffen, setBearbeitenOffen] = useState(false);
  const [url, setUrl] = useState(ziel.url);
  const [name, setName] = useState(ziel.name);

  return (
    <div className="vp-einst-blatt">
      {!bearbeitenOffen ? (
        <>
          <p className="vp-note">
            {ziel.name || ziel.url} · {kanalZielSatz(ziel.url)}
          </p>
          <button type="button" className="vp-linklike" onClick={() => setBearbeitenOffen(true)}>
            Bearbeiten
          </button>
        </>
      ) : (
        <>
          <Input label="Adresse" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            type="button"
            size="md"
            disabled={busy || !url.trim()}
            onClick={() => void onBearbeiten(url.trim(), name.trim()).then((ok) => ok && setBearbeitenOffen(false))}
          >
            Speichern
          </Button>
        </>
      )}
      <StufenSchalter id={ziel.id} wert={stufeAusSchwere(ziel.abSchwere)} disabled={busy} onChange={onStufe} />
      <Switch checked={ziel.aktiv} disabled={busy} onChange={(e) => onAktivSetzen(e.target.checked)} label="Eingeschaltet" />
      <Button type="button" variant="outline" size="md" disabled={busy} onClick={onProbe}>
        Probe senden
      </Button>
      <Button type="button" variant="ghost" size="md" disabled={busy} onClick={onEntfernen}>
        Entfernen
      </Button>
      <Folge eintrag={folge} />
    </div>
  );
}

function WeitererWegBlatt({
  telegramVerfuegbar,
  busy,
  onTelegram,
  onKanalAngelegt,
  folge,
}: {
  telegramVerfuegbar: boolean;
  busy: string | null;
  onTelegram: () => void;
  onKanalAngelegt: (ziel: WebhookZiel) => void;
  folge: FolgeEintrag | null;
}) {
  const [kanalOffen, setKanalOffen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [geheimnis, setGeheimnis] = useState<string | null>(null);
  const [probeLaeuft, setProbeLaeuft] = useState(false);
  const [probeErgebnis, setProbeErgebnis] = useState<ProbeErgebnis | null>(null);

  async function anlegen() {
    if (!url.trim()) return;
    setFehler(null);
    try {
      const neu = await benachrichtigungenApi.webhookZielAnlegen(url.trim(), name.trim());
      onKanalAngelegt({ id: neu.id, url: url.trim(), name: name.trim(), aktiv: true, abSchwere: 'warnung', erstelltAm: new Date().toISOString() });
      setGeheimnis(kanalZielSatz(url.trim()) === 'Eigener Dienst' ? neu.geheimnis : null);
      setUrl('');
      setName('');
    } catch (e) {
      setFehler(e instanceof Error ? e.message : SCHALT_FEHLER);
    }
  }

  /** "Probe senden" VOR dem Anlegen (Entscheid 10A) - nichts wird gespeichert. */
  async function probeVorAnlegen() {
    if (!url.trim()) return;
    setProbeLaeuft(true);
    setProbeErgebnis(null);
    try {
      setProbeErgebnis(await benachrichtigungenApi.webhookProbeVorAnlegen(url.trim()));
    } catch {
      setProbeErgebnis({ erfolgreich: false, fehler: SCHALT_FEHLER });
    } finally {
      setProbeLaeuft(false);
    }
  }

  return (
    <div className="vp-einst-blatt">
      {telegramVerfuegbar && (
        <div className="vp-meinst-weiterer-abschnitt">
          <Button type="button" size="md" disabled={busy === 'telegram'} onClick={onTelegram}>
            Telegram verbinden
          </Button>
          <p className="vp-note">In Telegram öffnen - der Link gilt 14 Minuten.</p>
          <Folge eintrag={folge} />
        </div>
      )}
      <div className="vp-meinst-weiterer-abschnitt">
        {!kanalOffen ? (
          <Button type="button" size="md" variant="outline" onClick={() => setKanalOffen(true)}>
            Team-Kanal verbinden
          </Button>
        ) : geheimnis ? (
          <>
            <p className="vp-note" role="status">
              Verbunden. Signatur-Schlüssel (nur jetzt sichtbar): <code>{geheimnis}</code>
            </p>
            <Button type="button" size="md" variant="ghost" onClick={() => setGeheimnis(null)}>
              Fertig
            </Button>
          </>
        ) : (
          <>
            <p className="vp-note">Für Microsoft Teams, Slack oder einen eigenen Dienst.</p>
            <Input label="Adresse" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <Input label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Energieteam" />
            <div className="vp-meinst-weiterer-aktionen">
              <Button type="button" size="md" variant="outline" disabled={!url.trim() || probeLaeuft} onClick={() => void probeVorAnlegen()}>
                Probe senden
              </Button>
              <Button type="button" size="md" disabled={!url.trim()} onClick={() => void anlegen()}>
                Verbinden
              </Button>
            </div>
            {probeErgebnis && (
              <p className={probeErgebnis.erfolgreich ? 'vp-note' : 'vp-alert'} role={probeErgebnis.erfolgreich ? 'status' : 'alert'}>
                {probeErgebnis.erfolgreich ? 'Testnachricht gesendet.' : (probeErgebnis.fehler ?? SCHALT_FEHLER)}
              </p>
            )}
            {fehler && (
              <p className="vp-alert" role="alert">
                {fehler}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RuhezeitBlatt({
  preset,
  regeln,
  zeitzone: _zeitzone,
  busy,
  onPreset,
  onRegeln,
  folge,
}: {
  preset: RuhezeitPresetId;
  regeln: RuhezeitRegeln;
  zeitzone: string;
  busy: boolean;
  onPreset: (p: RuhezeitPresetId) => void;
  onRegeln: (r: RuhezeitRegeln) => void;
  folge: FolgeEintrag | null;
}) {
  const werktagsAn = regeln.werktags != null;
  const wochenendeArt: 'aus' | 'ganz' | 'eigen' = regeln.wochenende == null ? 'aus' : regeln.wochenende === 'ganz' ? 'ganz' : 'eigen';

  return (
    <div className="vp-einst-blatt">
      <p className="vp-note">In der Ruhezeit warten Meldungen. Unter der Glocke steht alles sofort.</p>
      <VpPicker
        id="ruhezeit-vorgabe"
        label="Vorgabe"
        value={preset}
        onChange={(v) => v && onPreset(v as RuhezeitPresetId)}
        options={(Object.keys(RUHEZEIT_PRESET_LABEL) as RuhezeitPresetId[]).map((p) => ({ value: p, label: RUHEZEIT_PRESET_LABEL[p] }))}
      />
      {preset === 'eigene' && (
        <>
          <Switch
            checked={werktagsAn}
            disabled={busy}
            onChange={(e) => {
              const naechste: RuhezeitRegeln = { ...regeln };
              if (e.target.checked) naechste.werktags = { von: '22:00', bis: '07:00' };
              else delete naechste.werktags;
              onRegeln(naechste);
            }}
            label="Werktags"
          />
          {werktagsAn && regeln.werktags && (
            <div className="vp-benachrichtigungen-fenster">
              <VpTimePicker
                label="Von"
                value={regeln.werktags.von}
                onChange={(v) => onRegeln({ ...regeln, werktags: { ...(regeln.werktags as RuhezeitTeilfenster), von: v } })}
              />
              <VpTimePicker
                label="Bis"
                value={regeln.werktags.bis}
                onChange={(v) => onRegeln({ ...regeln, werktags: { ...(regeln.werktags as RuhezeitTeilfenster), bis: v } })}
              />
            </div>
          )}
          <VpPicker
            id="ruhezeit-wochenende"
            label="Am Wochenende"
            value={wochenendeArt}
            onChange={(v) => {
              const naechste: RuhezeitRegeln = { ...regeln };
              if (v === 'aus') delete naechste.wochenende;
              else if (v === 'ganz') naechste.wochenende = 'ganz';
              else naechste.wochenende = { von: '00:00', bis: '23:59' };
              onRegeln(naechste);
            }}
            options={[
              { value: 'ganz', label: 'ganz' },
              { value: 'eigen', label: 'eigene Zeiten' },
              { value: 'aus', label: 'keine Ruhezeit' },
            ]}
          />
          {wochenendeArt === 'eigen' && typeof regeln.wochenende === 'object' && (
            <div className="vp-benachrichtigungen-fenster">
              <VpTimePicker
                label="Von"
                value={regeln.wochenende.von}
                onChange={(v) => onRegeln({ ...regeln, wochenende: { ...(regeln.wochenende as RuhezeitTeilfenster), von: v } })}
              />
              <VpTimePicker
                label="Bis"
                value={regeln.wochenende.bis}
                onChange={(v) => onRegeln({ ...regeln, wochenende: { ...(regeln.wochenende as RuhezeitTeilfenster), bis: v } })}
              />
            </div>
          )}
        </>
      )}
      <Folge eintrag={folge} />
    </div>
  );
}
