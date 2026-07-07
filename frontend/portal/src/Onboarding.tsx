import { Card } from '../designsystem/components/core/Card';
import type { Site } from './api';
import { AnlageFlow } from './components/AnlageFlow';

/**
 * Guided first-run onboarding: the full-page host of the ONE "Anlage anlegen"
 * flow (captain decision 5) - Anlage benennen + Adresse + Anlagentyp, Gerät
 * verbinden, Speicher optional; after a claimed device it waits for the first
 * data ("Ihre Anlage ist verbunden"). Shown to any customer without a device,
 * so the path from "frisches Konto" to "Anlage sendet Daten" is one sequenced
 * flow instead of disconnected forms. Skippable at every step ("Später
 * einrichten"); a customer who already created an Anlage resumes at the
 * Gerät step. The flow itself lives in components/AnlageFlow.tsx and is
 * shared with the "Anlage anlegen" drawer for existing customers.
 */
export function OnboardingWizard({
  sites,
  onDone,
  onSkip,
}: {
  sites: Site[];
  onDone: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="vp-onboarding">
      <Card padding="lg" radius="lg">
        <h2 style={{ marginBottom: 4 }}>Willkommen bei VoltPilot</h2>
        <p className="vp-muted" style={{ margin: '0 0 8px' }}>
          In drei Schritten ist Ihre Anlage startklar.
        </p>
        <AnlageFlow sites={sites} waitForFirstData onDone={onDone} onSkipAll={onSkip} />
      </Card>
    </div>
  );
}
