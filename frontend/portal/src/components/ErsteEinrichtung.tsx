import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { benachrichtigungenApi, type EmailZustellweg, type PushAbo } from '../benachrichtigungenApi';
import { MELDUNGEN_EINSTELLEN_HASH } from '../meldungen';
import {
  geraeteVorschlag,
  istIosOhneInstallierteApp,
  merkeGeraetAboId,
  pushEinschalten,
  pushUnterstuetzt,
} from '../push';
import { useIsPhone } from '../useIsPhone';
import './ErsteEinrichtung.css';

/** Der Stand der ersten Einrichtung (Kunden-Alarmierung P3, KA-6 A): welche Wege es gibt. */
export interface EinrichtungsStand {
  email: EmailZustellweg | null;
  pushAbos: PushAbo[];
}

/** Lädt E-Mail-Weg und Push-Geräte; `null` solange es lädt oder wenn das Laden scheitert (dann zeigt nichts etwas). */
export function useEinrichtungsStand(): [EinrichtungsStand | null, (s: EinrichtungsStand) => void] {
  const [stand, setStand] = useState<EinrichtungsStand | null>(null);
  useEffect(() => {
    let aktiv = true;
    Promise.all([benachrichtigungenApi.emailZustand(), benachrichtigungenApi.pushAbos()]).then(
      ([email, pushAbos]) => {
        if (aktiv) setStand({ email: email ?? null, pushAbos });
      },
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return [stand, setStand];
}

/** Ob die erste Einrichtung noch offen ist: solange kein Push-Gerät da ist (KA-6 A). */
export function einrichtungOffen(stand: EinrichtungsStand | null): boolean {
  return stand != null && stand.pushAbos.length === 0;
}

type Probe = 'keine' | 'gesendet' | 'ja' | 'nein';

/**
 * Die erste Einrichtung der Meldungen (Kunden-Alarmierung P3, Konzept §6.2, KA-6 A): die Zeile mit der E-Mail-Adresse
 * und EIN Knopf „Push auf diesem Handy einschalten“, danach sofort die Probe mit der Frage „Angekommen?“. Am iPhone
 * im Browser-Tab geht Push nur aus der App auf dem Home-Bildschirm - dort stehen die drei Schritte an Ort und Stelle
 * statt eines Knopfs, der nichts kann. Steht unter „Alles ruhig“ (Meldungen › Jetzt) und als Punkt in „Ihr Weg zum
 * fertigen EMS“; derselbe Stand, derselbe Text.
 *
 * Verschickt nichts von selbst: die Probe geht erst nach dem Tipp auf „einschalten“ an genau dieses Gerät.
 */
export function ErsteEinrichtung({
  stand,
  onStand,
  testId = 'erste-einrichtung',
}: {
  stand: EinrichtungsStand;
  onStand: (s: EinrichtungsStand) => void;
  testId?: string;
}) {
  const isPhone = useIsPhone();
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const [probe, setProbe] = useState<Probe>('keine');
  const [abo, setAbo] = useState<PushAbo | null>(null);
  const geraetWort = isPhone ? 'diesem Handy' : 'diesem Gerät';

  async function einschalten() {
    if (busy) return;
    setBusy(true);
    setFehler('');
    try {
      const neu = await pushEinschalten(geraeteVorschlag());
      merkeGeraetAboId(neu.id);
      setAbo(neu);
      await probeSenden(neu);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  async function probeSenden(ziel: PushAbo) {
    try {
      const ergebnis = await benachrichtigungenApi.pushProbe(ziel.id);
      if (!ergebnis.erfolgreich) {
        setFehler(ergebnis.fehler ?? 'Die Probe ging nicht hinaus. Bitte versuchen Sie es erneut.');
        setProbe('nein');
        return;
      }
      setProbe('gesendet');
    } catch {
      setFehler('Die Probe ging nicht hinaus. Bitte versuchen Sie es erneut.');
      setProbe('nein');
    }
  }

  function fertig() {
    setProbe('ja');
    if (abo) onStand({ ...stand, pushAbos: [...stand.pushAbos, abo] });
  }

  const email = stand.email;
  const iosOhneApp = istIosOhneInstallierteApp();
  const pushGeht = pushUnterstuetzt();

  return (
    <div className="vp-erste-einrichtung" data-testid={testId}>
      <p className={`vp-ee-zeile${email?.aktiv ? ' is-ok' : ''}`} data-testid="erste-einrichtung-email">
        <Icon name={email?.aktiv ? 'check' : 'file-text'} size={16} />
        {email ? (
          <span>
            E-Mail an <b>{email.ziel}</b>
            {!email.aktiv ? ' - abgeschaltet' : !email.bestaetigt ? ' - wartet auf Bestätigung' : ''}
            {email.aktiv && email.herkunft === 'anmeldung' && <span className="vp-ee-sub"> (Ihre Anmelde-Adresse)</span>}
          </span>
        ) : (
          <span>
            Noch keine E-Mail-Adresse. <a href={MELDUNGEN_EINSTELLEN_HASH}>Eintragen</a>
          </span>
        )}
      </p>

      {abo && (
        <p className="vp-ee-zeile is-ok">
          <Icon name="check" size={16} />
          <span>Push auf {geraetWort}</span>
        </p>
      )}

      {!abo && iosOhneApp && (
        <div className="vp-ee-ios" data-testid="erste-einrichtung-ios">
          <p className="vp-ee-ios-kopf">Push am iPhone geht nur aus der App auf dem Home-Bildschirm:</p>
          <ol>
            <li>
              Unten in Safari auf <b>Teilen</b> tippen <Icon name="upload" size={14} />.
            </li>
            <li>
              <b>Zum Home-Bildschirm</b> wählen und <b>Hinzufügen</b> tippen.
            </li>
            <li>
              VoltPilot vom Home-Bildschirm öffnen, unter <b>Meldungen</b> „Push einschalten“ tippen.
            </li>
          </ol>
        </div>
      )}

      {!abo && !iosOhneApp && pushGeht && (
        <Button variant="primary" fullWidth disabled={busy} onClick={() => void einschalten()} data-testid="erste-einrichtung-push">
          Push auf {geraetWort} einschalten
        </Button>
      )}

      {!abo && !iosOhneApp && !pushGeht && (
        <p className="vp-ee-hinweis">Dieser Browser kann keine Mitteilungen zeigen. Die E-Mail erreicht Sie trotzdem.</p>
      )}

      {abo && probe === 'gesendet' && (
        <div className="vp-ee-frage" role="group" aria-label="Probe angekommen?" data-testid="erste-einrichtung-probe">
          <b>Probe gesendet</b>
          <span>Ist sie auf {geraetWort} angekommen?</span>
          <div className="vp-ee-knoepfe">
            <Button variant="primary" size="sm" onClick={fertig}>
              Ja
            </Button>
            <Button variant="outline" size="sm" onClick={() => setProbe('nein')}>
              Nein
            </Button>
          </div>
        </div>
      )}

      {abo && probe === 'nein' && (
        <div className="vp-ee-frage" data-testid="erste-einrichtung-nein">
          <span>
            Prüfen Sie in den Einstellungen des Geräts, ob Mitteilungen für VoltPilot erlaubt sind und ob „Nicht
            stören“ an ist. Die E-Mail erreicht Sie auf jeden Fall.
          </span>
          <div className="vp-ee-knoepfe">
            <Button variant="outline" size="sm" onClick={() => void probeSenden(abo)}>
              Noch einmal senden
            </Button>
            <Button variant="ghost" size="sm" onClick={fertig}>
              Später
            </Button>
          </div>
        </div>
      )}

      {abo && probe === 'ja' && (
        <p className="vp-ee-zeile is-ok" role="status">
          <Icon name="check" size={16} />
          <span>Fertig. Meldungen erreichen Sie jetzt auch hier.</span>
        </p>
      )}

      {fehler && (
        <p className="vp-ee-fehler" role="alert">
          {fehler}
        </p>
      )}
    </div>
  );
}
