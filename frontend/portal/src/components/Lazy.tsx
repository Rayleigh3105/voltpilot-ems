import { Suspense, type ReactNode } from 'react';
import { ChartCardSkeleton, Skeleton } from './States';
import { useAusblenden } from '../../designsystem/components/shell/ausblenden';
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

/**
 * **Skelett → Inhalt, als echtes Überblenden** (Bewegungs-Programm P6, Konzept
 * `data/vp-motion-konzept-m1/report.md` §6 Zeile „Skelett → Inhalt":
 * „Crossfade 160/200 ms im reservierten Rahmen (CLS 0)").
 *
 * ## ⚠ WARUM DAS NICHT AM SUSPENSE-RAND GEHT
 *
 * `Suspense` tauscht Platzhalter und Inhalt im SELBEN Commit — der Fallback
 * ist fort, bevor irgendein CSS ihn ausblenden könnte. Ein Überblenden
 * braucht deshalb einen Aufrufer, dem BEIDE Seiten gehören, und genau das ist
 * dieser Baustein. Am Suspense-Rand bleibt es bei der halben Zusage: der
 * Platzhalter kommt ohne Sprung (`.vp-blende` an den Skelett-Flächen), der
 * Inhalt ersetzt ihn hart.
 *
 * ## ⚠ DER RAHMEN IST RESERVIERT, NICHT DIE SUMME
 *
 * Das gehende Skelett wird `position: absolute` (siehe `.vp-blende-rahmen` in
 * `index.css`). Bliebe es im Fluss, wäre die Rahmenhöhe für 160 ms Skelett
 * PLUS Inhalt — der Sprung, den die Blende verhindert, wäre ihr eigenes Werk.
 * So bestimmt vom ersten Frame an der Inhalt die Höhe, und das Skelett
 * verblasst darüber: gemessene Layout-Verschiebung 0.
 *
 * Die Ausblend-Dauer misst `useAusblenden` am selben `--vp-motion-exit`, mit
 * dem das CSS ausblendet — der EINE Schalter nullt beides zugleich, und in
 * jsdom (kein Stylesheet) verschwindet das Skelett synchron wie vor P6.
 */
export function Blende({
  laedt,
  skelett,
  children,
  className,
}: {
  /** Solange `true`, steht das Skelett allein. */
  laedt: boolean;
  skelett: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { sichtbar, schliessend } = useAusblenden(laedt);
  const rahmen = className ? `vp-blende-rahmen ${className}` : 'vp-blende-rahmen';
  return (
    <div className={rahmen}>
      {!laedt && <div className="vp-blende">{children}</div>}
      {sichtbar && (
        <div className={schliessend ? 'vp-blende is-weg' : 'vp-blende'} aria-hidden={schliessend}>
          {skelett}
        </div>
      )}
    </div>
  );
}
