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
 * Top-level error boundary for the whole SPA: any render/boot exception lands
 * on a German recovery card instead of a blank page. Deliberately minimal -
 * it must render even when app state is broken.
 */
export class BootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
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
