import { Component, type ContextType, type ReactNode } from 'react';
import { ReportFirstPaint } from '../bootReady';

/** Der Satz, wenn eine Seite oder ein Reiter beim Zeichnen scheitert — Kopf, Navigation und andere Reiter bleiben. */
export const FEHLER_IM_BEREICH =
  'Dieser Bereich kann gerade nicht angezeigt werden. Wechseln Sie die Ansicht oder laden Sie die Seite neu.';

/**
 * Fängt einen Fehler beim Zeichnen EINER Seite oder EINES Reiters, statt das ganze Portal durch die Boot-Karte zu
 * ersetzen (`BootErrorBoundary` bleibt die letzte Grenze). Ohne Knopf: der Weg zurück ist die Navigation daneben. Ein
 * Wechsel der Hash-Route setzt die Grenze zurück — sonst bliebe die nächste Seite hinter dem alten Fehler stehen.
 *
 * Scheitert die Landeseite beim ersten Start, ist dieser Satz ihr erstes Bild: die Grenze meldet es der Lade-Bühne
 * (`ReportFirstPaint`), sonst stünde die Bühne bis zur 3-s-Grenze über dem Satz. Die gescheiterte Seite meldet nicht mehr.
 */
export class Fehlergrenze extends Component<{ children: ReactNode }, { fehler: boolean }> {
  static contextType = ReportFirstPaint;
  declare context: ContextType<typeof ReportFirstPaint>;
  state = { fehler: false };

  static getDerivedStateFromError(): { fehler: boolean } {
    return { fehler: true };
  }

  private zuruecksetzen = () => {
    if (this.state.fehler) this.setState({ fehler: false });
  };

  componentDidMount(): void {
    window.addEventListener('hashchange', this.zuruecksetzen);
  }

  componentWillUnmount(): void {
    window.removeEventListener('hashchange', this.zuruecksetzen);
  }

  componentDidCatch(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error('Unerwarteter Fehler beim Zeichnen eines Bereichs', error);
    this.context();
  }

  render(): ReactNode {
    if (!this.state.fehler) return this.props.children;
    return (
      <p className="vp-note" role="alert" data-testid="fehlergrenze">
        {FEHLER_IM_BEREICH}
      </p>
    );
  }
}
