import { lazy, type ComponentProps } from 'react';
import { LazyBoundary } from './Lazy';
import type { AnlegenFlow as AnlegenFlowTyp } from './AnlegenFlow';

/** Die EINE Ladestelle des Geräte-Assistenten (Vorladen und Rendern teilen sie). */
export const ladeAnlegenFlow = () => import('./AnlegenFlow');

const AnlegenFlow = lazy(() => ladeAnlegenFlow().then((m) => ({ default: m.AnlegenFlow })));

/**
 * Der Geräte-Assistent (Hinzufügen im Aufbau, Bearbeiten auf der Geräteseite), nachgeladen statt mitgeliefert.
 *
 * Er ist mit Vorlagen, Verbindungs- und Prüfschritten eines der größten Stücke des Portals (≈ 35 kB gz) und lag
 * statisch in jedem Aufruf von Aufbau und Geräteseite - gebraucht wird er erst, wenn jemand ein Gerät anlegt oder
 * bearbeitet. Beide Wirte rendern ihn nur, solange er offen ist; der Aufbau lädt ihn im Leerlauf vor
 * (`useImLeerlaufLaden`), damit der Klick auf „Hinzufügen“ nicht auf das Netz wartet.
 * Wächter: `src/seitenBuendel.test.ts`.
 */
export function AnlegenFlowLazy(props: ComponentProps<typeof AnlegenFlowTyp>) {
  return (
    <LazyBoundary>
      <AnlegenFlow {...props} />
    </LazyBoundary>
  );
}
