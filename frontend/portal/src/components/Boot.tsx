import React from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { AuthScreen } from './AuthScreen';
// EINE Messung der Ausblend-Dauer fuer das ganze Portal: dieselbe Funktion,
// mit der P6 seine Modale wartet (`designsystem/components/shell/ausblenden.js`).
// Ein zweiter Leser desselben Tokens waere ein Zwilling, der abdriften kann.
import { ausblendDauerMs } from '../../designsystem/components/shell/ausblenden';

/**
 * Synchronously rendered boot state (white-page fix): shown the moment the
 * bundle runs, BEFORE/WHILE initAuth() awaits Keycloak. Whatever hangs or
 * throws afterwards, the customer never looks at an empty page. Rendered in
 * the same split-view brand language as login/register (AuthScreen).
 */
export function BootSplash() {
  return (
    <AuthScreen>
      <div className="vp-boot-spinner" aria-hidden="true" />
      <p role="status" style={{ textAlign: 'center' }}>
        Anmeldung wird geprüft …
      </p>
    </AuthScreen>
  );
}

/**
 * Wie lange laenger als die Ausblend-Dauer gewartet wird, bevor der
 * Rueckfall-Zeitgeber das Skelett entfernt. Deckt den Frame ab, in dem der
 * Uebergang startet - `transitionend` kaeme sonst knapp NACH dem Zeitgeber
 * und das Skelett verschwaende einen Hauch zu frueh (sichtbarer Sprung).
 */
const SKELETON_FADE_SLACK_MS = 60;

/**
 * Blendet das Inline-Skelett aus index.html aus (Sofort-Skelett gegen Chromes
 * Paint-Holding) und entfernt es DANACH.
 *
 * Aufgerufen aus `componentDidMount`, also NACHDEM React sein erstes DOM
 * geschrieben hat: das Skelett blendet ueber dem fertigen ersten Bild aus,
 * statt einen Schnitt zu machen (Bewegungs-Programm P4, Konzept
 * `data/vp-motion-konzept-m1/report.md` §6 Zeile "App-Start").
 *
 * ⚠ DER ZEITGEBER IST DIE WAHRHEIT, `transitionend` NUR DIE ABKUERZUNG.
 *   Ein Uebergang, der nie startet, feuert auch nie sein Ende - ein
 *   Hintergrund-Tab, ein `display:none` durch fremdes CSS oder ein Browser,
 *   der den Frame verschluckt, liessen das Skelett fuer immer ueber dem
 *   Portal stehen. Deshalb entfernt IMMER ein Zeitgeber, und das
 *   Uebergangs-Ende raeumt hoechstens frueher auf.
 *
 * Idempotent (mehrfacher Aufruf ist ein No-op) und jsdom-sicher.
 */
export function removeBootSkeleton(): void {
  if (typeof document === 'undefined') return;
  const skeleton = document.getElementById('vp-boot-skeleton');
  if (!skeleton) return;

  const fade = ausblendDauerMs();
  if (fade <= 0) {
    skeleton.remove();
    return;
  }

  // ⚠ Zweimal entfernen ist erlaubt: `ChildNode.remove()` kehrt ohne Eltern
  //   einfach zurueck. Deshalb braucht es hier KEINE Merke-Fahne — Zeitgeber
  //   und `transitionend` duerfen beide feuern.
  const drop = () => skeleton.remove();
  skeleton.addEventListener('transitionend', drop, { once: true });
  window.setTimeout(drop, fade + SKELETON_FADE_SLACK_MS);
  skeleton.classList.add('vp-bs-leaving');
}

/**
 * Top-level error boundary for the whole SPA: any render/boot exception lands
 * on a German recovery card instead of a blank page. Deliberately minimal -
 * it must render even when app state is broken.
 *
 * It also owns the ONE removal of the inline boot skeleton: it wraps every
 * render() in main.tsx and stays mounted across boot states, so its
 * componentDidMount fires exactly once - at React's first committed frame,
 * whichever boot outcome that is.
 */
export class BootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidMount(): void {
    removeBootSkeleton();
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('Unerwarteter Fehler beim Rendern des Portals', error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <AuthScreen>
        <h1>VoltPilot EMS</h1>
        <p className="vp-auth-hint">
          Es ist ein unerwarteter Fehler aufgetreten. Bitte laden Sie die Seite neu.
        </p>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={() => window.location.reload()}
        >
          Neu laden
        </Button>
      </AuthScreen>
    );
  }
}
