import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { zustellwegAbmelden, type ZustellwegAbmeldenErgebnis } from '../api';
import { AuthScreen, TrustRow } from './AuthScreen';
import { ZURUECK_ZU_DEN_WEGEN } from './ZustellwegBestaetigenScreen';

/**
 * Die Seite hinter „Abmelden" unter jeder Mail (`#/zustellweg/abmelden?token=...`, `ZustellwegController#abmelden`,
 * Kunden-Alarmierung P2, KA-1 A). Gerendert von `main.tsx` vor/ohne den Auth-Bootstrap, wie die Bestätigungsseite.
 *
 * Sie fragt erst und meldet erst auf den Knopf ab: Mail-Dienste öffnen Links aus Mails zur Prüfung selbst, ein
 * Abmelden schon beim Laden der Seite träfe Menschen, die nie geklickt haben. Abgeschaltet wird nur der E-Mail-Weg;
 * im Portal bleiben die Meldungen, und der Weg lässt sich in den Einstellungen wieder einschalten.
 */
export function ZustellwegAbmeldenScreen({ token }: { token: string }) {
  const [zustand, setZustand] = useState<ZustellwegAbmeldenErgebnis | 'frage' | 'laedt' | 'fehler'>('frage');

  function abmelden() {
    setZustand('laedt');
    zustellwegAbmelden(token).then(
      (ergebnis) => setZustand(ergebnis),
      () => setZustand('fehler'),
    );
  }

  // Der Hash wechselt weg von dieser Route, bevor die Seite neu lädt; danach entscheidet main.tsx wie gewohnt
  // (angemeldet: die Wege in den Einstellungen, sonst die Anmeldung mit genau diesem Ziel).
  function zuDenEinstellungen() {
    window.location.hash = ZURUECK_ZU_DEN_WEGEN;
    window.location.reload();
  }

  if (zustand === 'frage' || zustand === 'laedt') {
    return (
      <AuthScreen>
        <h1>Keine E-Mails mehr zu Meldungen?</h1>
        <p className="vp-auth-hint">
          Sie bekommen dann keine Meldungen von VoltPilot mehr per E-Mail. Im Portal sehen Sie weiter alles, und Sie
          können die E-Mails in Ihren Einstellungen jederzeit wieder einschalten.
        </p>
        <Button variant="primary" size="lg" fullWidth onClick={abmelden} disabled={zustand === 'laedt'}>
          Abmelden
        </Button>
        <TrustRow />
      </AuthScreen>
    );
  }

  if (zustand === 'abgemeldet') {
    return (
      <AuthScreen>
        <h1>Abgemeldet</h1>
        <div className="vp-alert vp-alert-ok" role="status">
          Sie bekommen keine Meldungen mehr per E-Mail. Im Portal bleiben sie sichtbar.
        </div>
        <Button variant="outline" size="lg" fullWidth onClick={zuDenEinstellungen}>
          Zu den Einstellungen
        </Button>
        <TrustRow />
      </AuthScreen>
    );
  }

  const unbekannt = zustand === 'unbekannt';
  return (
    <AuthScreen>
      <h1>{unbekannt ? 'Link nicht mehr gültig' : 'Das hat gerade nicht geklappt'}</h1>
      <div className="vp-alert vp-alert-err" role="alert">
        {unbekannt
          ? 'Zu diesem Link gibt es keine E-Mail-Adresse mehr. In Ihren Einstellungen sehen Sie, wie VoltPilot Sie erreicht.'
          : 'Das Abmelden ist zurzeit nicht möglich. Bitte versuchen Sie es in wenigen Minuten erneut.'}
      </div>
      <Button variant="primary" size="lg" fullWidth onClick={unbekannt ? zuDenEinstellungen : abmelden}>
        {unbekannt ? 'Zu den Einstellungen' : 'Erneut versuchen'}
      </Button>
      <TrustRow />
    </AuthScreen>
  );
}
