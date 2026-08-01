import React from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { AuthScreen } from './AuthScreen';

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
 * Removes the inline first-paint skeleton from index.html (Sofort-Skelett gegen
 * Chromes Paint-Holding). Called from componentDidMount, i.e. AFTER React wrote
 * its first DOM but BEFORE the browser paints that frame - so the swap happens
 * within one frame and never flickers. Idempotent + jsdom-safe.
 */
export function removeBootSkeleton(): void {
  if (typeof document === 'undefined') return;
  document.getElementById('vp-boot-skeleton')?.remove();
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
