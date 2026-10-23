import { Card } from '../designsystem/components/core/Card';
import type { Site } from './api';
import type { Route } from './nav';
import { startklarSatz } from './anlageFlow';
import { AnlageFlow } from './components/AnlageFlow';

/**
 * Der Einrichtungs-Assistent der ERSTEN Anlage: der ganzseitige Wirt des EINEN Anlege-Flusses
 * (`components/AnlageFlow.tsx`, Adresse · Box · Anlage). Er erscheint einmal - für einen Kunden ohne
 * Anlage - und endet im Cockpit der neuen Anlage (D7); was danach offen ist, zeigt die Einrichtungs-Karte
 * dort, nie wieder ein Vollbild. „Später einrichten“ geht jederzeit.
 */
export function OnboardingWizard({
  sites,
  onSiteCreated,
  onDone,
  onSkip,
}: {
  sites: Site[];
  /** B1 (Anlage-Flow a1): die neue Anlage steht sofort in der Anlagenliste des Wirts. */
  onSiteCreated?: (site: Site) => void;
  /** Das Ziel am Ende: das Cockpit der neuen Anlage, im Modus „nur messen“ ihre Messstellen. */
  onDone: (ziel?: Route) => void;
  onSkip: () => void;
}) {
  return (
    <div className="vp-onboarding">
      <Card padding="lg" radius="lg">
        <h2 style={{ marginBottom: 4 }}>Willkommen bei VoltPilot</h2>
        <AnlageFlow
          wirt="assistent"
          sites={sites}
          onSiteCreated={onSiteCreated}
          onDone={onDone}
          onSkipAll={onSkip}
          // Die Schrittzahl folgt dem Fluss (mit Standort-Schritt vier) und steht erst, wenn das
          // feststeht (sonst stünde einen Augenblick die falsche Zahl da).
          kopf={(schritte) =>
            schritte && (
              <p className="vp-muted" style={{ margin: '0 0 8px' }}>
                {startklarSatz(schritte.length)}
              </p>
            )
          }
        />
      </Card>
    </div>
  );
}
