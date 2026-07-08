// The calm "Steuerung" strip on the Anlagen-Seite (captain decision 4): one
// plain-German line "Fahrplan-Sollwert X -> Wechselrichter bestätigt Y" with a
// healthy | mismatch | stale | off | pending dot and a "geprüft vor X" note.
// Render-only; all derivation is the pure controlStrip() in src/control.ts.
import { Card } from '../../designsystem/components/core/Card';
import type { ControlStripView } from '../control';

export function ControlStrip({ view }: { view: ControlStripView }) {
  return (
    <section className="vp-section" aria-label="Steuerung">
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">Steuerung</span>
        <div className="vp-control-strip">
          <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
          <p className="vp-control-sentence">{view.sentence}</p>
          {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
        </div>
      </Card>
    </section>
  );
}
