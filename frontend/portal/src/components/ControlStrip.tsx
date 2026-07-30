// The calm "Steuerung" strip on the Anlagen-Seite (captain decision 4): one
// plain-German line "Fahrplan-Sollwert X -> Wechselrichter bestätigt Y" with a
// healthy | mismatch | stale | off | pending dot and a "geprüft vor X" note -
// PLUS, since 2026-07-30, the plan's own reason for that setpoint underneath.
// Without the reason the line read like a stubborn order (the owner's Pilsting
// question); with it the card answers "warum gerade das?" itself.
// Render-only; all derivation is the pure controlStrip() in src/control.ts.
import { Card } from '../../designsystem/components/core/Card';
import type { ControlStripView } from '../control';

/**
 * `card`  — die eigenständige Karte (v1-Zonen-Dashboard, unverändert).
 * `bare`  — der **Bühnenfuß** (Konzept „Die Bühne" §6.1): eine schlanke Zeile
 *           über die VOLLE Kartenbreite am Fuß des Hero, ohne eigenen Rahmen.
 *           Die Karte-in-Karte (weißer Rahmen im weißen Hero) und die leere
 *           Hälfte daneben verschwinden damit strukturell; Zustände, Sätze und
 *           der Grund kommen unverändert aus `control.ts`.
 */
export type ControlStripVariant = 'card' | 'bare';

export function ControlStrip({
  view,
  variant = 'card',
}: {
  view: ControlStripView;
  variant?: ControlStripVariant;
}) {
  if (variant === 'bare') {
    return (
      <section className="vp-control-foot" aria-label="Steuerung">
        <span className="vp-card-label vp-control-foot-lbl">Steuerung</span>
        <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
        <p className="vp-control-sentence">{view.sentence}</p>
        {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
        {/* The WHY - only present when the plan actually recorded one. */}
        {view.reason && <p className="vp-control-reason">{view.reason}</p>}
      </section>
    );
  }
  return (
    <section className="vp-section" aria-label="Steuerung">
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">Steuerung</span>
        <div className="vp-control-strip">
          <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
          <p className="vp-control-sentence">{view.sentence}</p>
          {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
        </div>
        {/* The WHY - only present when the plan actually recorded one. */}
        {view.reason && <p className="vp-control-reason">{view.reason}</p>}
      </Card>
    </section>
  );
}
