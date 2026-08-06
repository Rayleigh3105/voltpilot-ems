import { Suspense, type ReactNode } from 'react';
import { ChartCardSkeleton, Skeleton } from './States';
import './Lazy.css';

/**
 * Die EINE Suspense-Grenze des Portals.
 *
 * Warum es sie gibt: das Einstiegs-Bündel trug bis hierher die GANZE Anwendung
 * - jede Unterseite einer Anlage, jede Plattform-Seite, ECharts und Leaflet -,
 * obwohl das Cockpit nichts davon zeichnet. 2,15 MB mussten geladen, geparst
 * und übersetzt werden, bevor die erste Anfrage hinausging (gemessen: 3,7 s
 * Totzeit auf einem gedrosselten Gerät). Alles, was nicht zum ERSTEN Bild
 * gehört, wird deshalb per `React.lazy` in ein eigenes Stück geschnitten und
 * erst geholt, wenn es wirklich gebraucht wird.
 *
 * Die Ehrlichkeits-Regel gilt hier wie überall: der Platzhalter ist eine
 * SKELETT-Fläche, die genau das ankündigt, was gleich an ihrer Stelle steht -
 * nie eine erfundene Zahl, nie eine Ansicht, die wieder verschwindet. Eine
 * Fläche, die schon eine eigene Lade-Aussage hat, gibt ihre über `fallback`
 * mit; sonst steht dort ein ruhiges Skelett.
 */
export function LazyBoundary({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return <Suspense fallback={fallback ?? <PageLoading />}>{children}</Suspense>;
}

/** Ruhiger Platzhalter einer noch nachladenden Unterseite. */
export function PageLoading() {
  return (
    <div className="vp-lazy-page" role="status" aria-live="polite" aria-busy="true">
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      <Skeleton height={18} width="40%" />
      <Skeleton height={220} />
      <Skeleton height={120} />
    </div>
  );
}

/** Platzhalter genau in der Grösse eines Diagramms (kein Layout-Sprung). */
export function ChartLoading({ chartHeight = 240 }: { chartHeight?: number }) {
  return <ChartCardSkeleton stats={0} chartHeight={chartHeight} />;
}
