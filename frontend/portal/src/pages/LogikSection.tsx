/**
 * Die Seite einer Logik der Steuerung (Steuerlogik Stufe 4) - der Einstieg, den die Anlagen-Seite lazy lädt
 * (`pageChunks.ts`); die Fläche selbst wohnt in `src/steuerung/logik/`. Ein eigenes Stück, weil Aufbau und Text den
 * YAML-Leser mitbringen, den die Steuerung sonst nicht braucht.
 */
import type { Site } from '../api';
import type { AnlagenSub } from '../nav';
import { LogikSeite } from '../steuerung/logik/LogikSeite';

export function LogikSection({ site, onOpenSub }: { site: Site; onOpenSub: (sub: AnlagenSub) => void }) {
  return <LogikSeite site={site} onOpenSub={onOpenSub} />;
}
