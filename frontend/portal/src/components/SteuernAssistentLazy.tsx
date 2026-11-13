import { lazy, type ComponentProps } from 'react';
import { LazyBoundary } from './Lazy';
import type { SteuernAssistent as SteuernAssistentTyp } from './SteuernAssistent';

const SteuernAssistent = lazy(() => import('./SteuernAssistent').then((m) => ({ default: m.SteuernAssistent })));

/**
 * Der Steuern-Assistent, nachgeladen statt mitgeliefert: er zieht die Schalt-Freigabe und die Regel-Schritte mit
 * (≈ 16 kB gz) und lag statisch in jedem Aufruf von Übersicht und Steuerung - geöffnet wird er nur über
 * „Steuern einrichten“. Beide Wirte rendern ihn nur, solange er offen ist. Wächter: `src/seitenBuendel.test.ts`.
 */
export function SteuernAssistentLazy(props: ComponentProps<typeof SteuernAssistentTyp>) {
  return (
    <LazyBoundary fallback={null}>
      <SteuernAssistent {...props} />
    </LazyBoundary>
  );
}
