// The calm "Steuerung" strip on the Anlagen-Seite (captain decision 4): one
// plain-German line "Ihr Gerät regelt gerade auf X -> Wechselrichter bestätigt Y" with a
// healthy | mismatch | stale | off | pending dot and a "geprüft vor X" note -
// PLUS, since 2026-07-30, the plan's own reason for that setpoint underneath.
// Without the reason the line read like a stubborn order (the owner's Pilsting
// question); with it the card answers "warum gerade das?" itself.
// Render-only; all derivation is the pure controlStrip() in src/control.ts.
import { Card } from '../../designsystem/components/core/Card';
import type { ControlStripView } from '../control';
import type { ExportGuardView } from '../curtailment';

/**
 * `card`  — die eigenständige Karte (v1-Zonen-Dashboard, unverändert).
 * `bare`  — der **Bühnenfuß** (Konzept „Die Bühne" §6.1): eine schlanke Zeile
 *           über die VOLLE Kartenbreite am Fuß des Hero, ohne eigenen Rahmen.
 *           Die Karte-in-Karte (weißer Rahmen im weißen Hero) und die leere
 *           Hälfte daneben verschwinden damit strukturell; Zustände, Sätze und
 *           der Grund kommen unverändert aus `control.ts`.
 */
export type ControlStripVariant = 'card' | 'bare';

/**
 * Der Einspeisewächter („Grenzen & Wächter" Stufe 0) — eine STEHENDE Aussage
 * über die Anlage, kein Live-Zustand der Batterie-Steuerung.
 *
 * **Deshalb hängt er ausdrücklich NICHT an `view`:** ein Gerät ohne
 * Batterie-Rücklesung liefert gar keine Steuerzeile, hält aber sehr wohl eine
 * Einspeisegrenze — genau die Konstellation in Herzogau. Die Grenze hinter
 * einem fremden Tor zu verstecken war der Fehler, den diese Stufe behebt, also
 * rendert der Streifen auch dann, wenn NUR der Wächter etwas zu sagen hat.
 */
function GuardLines({ guard }: { guard: ExportGuardView }) {
  return (
    <>
      <p className={`vp-guard-line tone-${guard.tone}`}>
        {guard.line}
        {guard.agoNote && <span className="vp-note vp-guard-ago"> {guard.agoNote}</span>}
      </p>
      {guard.deviceLimitLine && (
        <p className="vp-guard-line tone-warn">{guard.deviceLimitLine}</p>
      )}
    </>
  );
}

export function ControlStrip({
  view,
  variant = 'card',
  guard = null,
}: {
  view: ControlStripView | null;
  variant?: ControlStripVariant;
  guard?: ExportGuardView | null;
}) {
  if (!view && !guard) return null;
  const body = view && (
    <>
      {/* Was das GERÄT selbst geändert hat (PR 3) - nur wenn es das meldete. */}
      {view.execution && <p className="vp-control-reason">{view.execution}</p>}
      {/* Die EINSPEISE-Begrenzung ist ein anderer Steuerpfad als der
          Batterie-Sollwert oben - nur mit Beleg, nie behauptet. */}
      {view.curtailment && <p className="vp-control-reason">{view.curtailment}</p>}
      {/* The WHY - only present when the plan actually recorded one. */}
      {view.reason && <p className="vp-control-reason">{view.reason}</p>}
      {/* Der Ausblick aus dem Fahrplan - nur im Ruhefall, Action-Blau. */}
      {view.outlook && <p className="vp-outlook">{view.outlook}</p>}
    </>
  );

  if (variant === 'bare') {
    return (
      <section className="vp-control-foot" aria-label="Steuerung">
        <span className="vp-card-label vp-control-foot-lbl">Steuerung</span>
        {view && (
          <>
            <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
            <p className="vp-control-sentence">{view.sentence}</p>
            {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
          </>
        )}
        {body}
        {guard && <GuardLines guard={guard} />}
      </section>
    );
  }
  return (
    <section className="vp-section" aria-label="Steuerung">
      <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
        <span className="vp-card-label">Steuerung</span>
        {view && (
          <div className="vp-control-strip">
            <span className={`vp-control-dot tone-${view.tone}`} aria-hidden="true" />
            <p className="vp-control-sentence">{view.sentence}</p>
            {view.agoNote && <span className="vp-note vp-control-ago">{view.agoNote}</span>}
          </div>
        )}
        {body}
        {guard && <GuardLines guard={guard} />}
      </Card>
    </section>
  );
}
