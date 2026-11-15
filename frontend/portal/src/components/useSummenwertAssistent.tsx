import { Suspense, lazy, useState } from 'react';
import type { SummenwertEinstieg } from './SummenwertAssistent';

/**
 * Der Summenwert-Assistent kommt mit dem Klick, der ihn öffnet (Performance Welle 3).
 *
 * Statisch hing er mit Registerkatalog, Formel-Messstellen und Quellen-Regeln an jedem Aufruf der Gerätedetailseite
 * (`GeraetSummenwerte`), obwohl ihn nur öffnet, wer einen Summenwert anlegt. Das Öffnen holt das Stück, bis es da
 * ist, steht nichts Neues auf der Seite; danach öffnet der Assistent genau wie vorher. Wer ihn öffnen DARF, sieht
 * den Knopf - das Vorladen beginnt beim Zeigen auf den Knopf (`ladeSummenwertAssistent`), so findet ein Klick das
 * Stück meist schon da.
 */
export const ladeSummenwertAssistent = () => import('./SummenwertAssistent');
const SummenwertAssistent = lazy(() => ladeSummenwertAssistent().then((m) => ({ default: m.SummenwertAssistent })));

/** Stabile Öffnen-Funktion für Karten und Anlagen-Einstieg. Fertig bleibt bis zum Schließen. */
export function useSummenwertAssistent() {
  const [einstieg, setEinstieg] = useState<SummenwertEinstieg | null>(null);
  return {
    oeffneSummenwertAssistent: (neu: SummenwertEinstieg) => setEinstieg(neu),
    assistent: einstieg && (
      <Suspense fallback={null}>
        <SummenwertAssistent {...einstieg} open onClose={() => setEinstieg(null)} />
      </Suspense>
    ),
  };
}
