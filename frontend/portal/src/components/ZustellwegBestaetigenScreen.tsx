import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { zustellwegBestaetigen, type ZustellwegBestaetigungsErgebnis } from '../api';
import { AuthScreen, TrustRow } from './AuthScreen';

/**
 * Die Seite hinter dem Link aus der Bestätigungs-Mail
 * (`#/zustellweg/bestaetigen?token=...`, `ZustellwegController#bestaetigen`,
 * §6.6 "So erreichen wir Sie"). Gerendert von `main.tsx` VOR/OHNE den
 * Auth-Bootstrap (es prüft `zustellwegBestaetigenToken()` schon vor
 * `initAuth()`) - der Klick kommt oft ohne angemeldete Sitzung (anderes
 * Gerät/Browser), und der Endpunkt selbst verlangt keine Anmeldung.
 *
 * Der Server unterscheidet abgelaufen/ungültig/schon verwendet bewusst nicht
 * (kein Hinweis, ob ein Token je existiert hat) - die Fehlermeldung bleibt
 * deshalb ebenso allgemein, mit demselben nächsten Schritt für alle drei Fälle.
 */
/** Die Wege („So erreichen wir Sie“) auf der Einstellungs-Seite - die Sprungmarke `?abschnitt=` scrollt dorthin. */
export const ZURUECK_ZU_DEN_WEGEN = '#/meldungen?reiter=einstellen';

export function ZustellwegBestaetigenScreen({ token }: { token: string }) {
  const [zustand, setZustand] = useState<ZustellwegBestaetigungsErgebnis | 'laedt' | 'fehler'>('laedt');
  // Der Token ist einmalig (Server verbraucht ihn beim ersten Treffer, §6.7) -
  // `StrictMode`s doppelter Dev-Effekt (mount → cleanup → mount, SYNCHRON,
  // bevor die Anfrage je antwortet) darf den Aufruf deshalb NICHT zweimal
  // auslösen, sonst sähe ein echter Klick in der Entwicklung fälschlich
  // "abgelaufen" (der zweite Aufruf träfe auf den vom ersten schon
  // verbrauchten Token). Bewusst OHNE einen `aktiv`-Abbruch im Cleanup: die
  // Seite bleibt bis zum eigenen `window.location.reload()` montiert, ein
  // Abbruch gehört nur zur Schein-Aufräumung von `StrictMode` und würde sonst
  // das ECHTE Ergebnis der einen Anfrage verwerfen.
  const schonAngestossen = useRef<string | null>(null);

  useEffect(() => {
    if (schonAngestossen.current === token) return;
    schonAngestossen.current = token;
    zustellwegBestaetigen(token).then(
      (ergebnis) => setZustand(ergebnis),
      () => setZustand('fehler'),
    );
  }, [token]);

  // Der Hash wechselt WEG von dieser Route, bevor die Seite neu lädt - sonst
  // bestätigte der nächste Boot denselben (jetzt verbrauchten) Token erneut
  // und zeigte sofort "abgelaufen". Danach entscheidet main.tsx wie gewohnt:
  // angemeldet -> zurück zu den Wegen ("So erreichen wir Sie", Kunden-Alarmierung
  // P0: dort sieht man die bestätigte Adresse und kann eine Probe senden), sonst
  // Keycloak-Login mit genau diesem Ziel.
  function weiterZuVoltpilot() {
    window.location.hash = ZURUECK_ZU_DEN_WEGEN;
    window.location.reload();
  }

  if (zustand === 'laedt') {
    return (
      <AuthScreen>
        <h1>Wir bestätigen Ihre E-Mail-Adresse …</h1>
        <p className="vp-auth-hint">Einen Moment bitte.</p>
        <TrustRow />
      </AuthScreen>
    );
  }

  if (zustand === 'bestaetigt') {
    return (
      <AuthScreen>
        <h1>E-Mail-Adresse bestätigt</h1>
        <div className="vp-alert vp-alert-ok" role="status">
          Sie erhalten Meldungen von VoltPilot jetzt auch per E-Mail.
        </div>
        <Button variant="primary" size="lg" fullWidth onClick={weiterZuVoltpilot}>
          Zurück zu den Einstellungen
        </Button>
        <TrustRow />
      </AuthScreen>
    );
  }

  const istAbgelaufen = zustand === 'abgelaufen';
  return (
    <AuthScreen>
      <h1>{istAbgelaufen ? 'Link nicht mehr gültig' : 'Das hat gerade nicht geklappt'}</h1>
      <div className="vp-alert vp-alert-err" role="alert">
        {istAbgelaufen
          ? 'Dieser Bestätigungslink ist ungültig, abgelaufen oder schon verwendet. Fordern Sie die Bestätigung in Ihren Benachrichtigungs-Einstellungen erneut an.'
          : 'Die Bestätigung ist zurzeit nicht möglich. Bitte versuchen Sie es in wenigen Minuten erneut.'}
      </div>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={istAbgelaufen ? weiterZuVoltpilot : () => window.location.reload()}
      >
        {istAbgelaufen ? 'Zurück zu den Einstellungen' : 'Erneut versuchen'}
      </Button>
      <TrustRow />
    </AuthScreen>
  );
}
