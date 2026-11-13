import { lazy, type ComponentProps } from 'react';
import { LazyBoundary } from './Lazy';
import type { DatenquelleWechselDialog as DatenquelleWechselDialogTyp } from './DatenquelleWechselDialog';

const DatenquelleWechselDialog = lazy(() =>
  import('./DatenquelleWechselDialog').then((m) => ({ default: m.DatenquelleWechselDialog })),
);

/**
 * „Zuständige Box wechseln“, nachgeladen statt mitgeliefert: der Dialog zieht die Box-Dialoge mit (`boxDialoge.ts`,
 * ≈ 20 kB gz) und lag statisch in jedem Aufruf von Geräte-, Gateway- und Box-Seite. Alle drei Wirte rendern ihn nur,
 * solange er offen ist. Wächter: `src/seitenBuendel.test.ts`.
 */
export function DatenquelleWechselDialogLazy(props: ComponentProps<typeof DatenquelleWechselDialogTyp>) {
  return (
    <LazyBoundary fallback={null}>
      <DatenquelleWechselDialog {...props} />
    </LazyBoundary>
  );
}
