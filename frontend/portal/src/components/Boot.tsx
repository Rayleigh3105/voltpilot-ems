import React from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import logoUrl from '../../designsystem/assets/voltpilot-logo.png';

/**
 * Synchronously rendered boot state (white-page fix): shown the moment the
 * bundle runs, BEFORE/WHILE initAuth() awaits Keycloak. Whatever hangs or
 * throws afterwards, the customer never looks at an empty page.
 */
export function BootSplash() {
  return (
    <div className="vp-login">
      <Card padding="lg" radius="lg" className="vp-login-card">
        <img src={logoUrl} alt="VoltPilot" />
        <h1>VoltPilot EMS</h1>
        <div className="vp-boot-spinner" aria-hidden="true" />
        <p role="status">Anmeldung wird geprüft …</p>
      </Card>
    </div>
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
      <div className="vp-login">
        <Card padding="lg" radius="lg" className="vp-login-card">
          <img src={logoUrl} alt="VoltPilot" />
          <h1>VoltPilot EMS</h1>
          <p>Es ist ein unerwarteter Fehler aufgetreten. Bitte laden Sie die Seite neu.</p>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => window.location.reload()}
          >
            Neu laden
          </Button>
        </Card>
      </div>
    );
  }
}
