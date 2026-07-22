import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { WidgetDef, WidgetFace } from '../cockpitWidgets';
import type { AnlagenSub } from '../nav';
import './CockpitBlocks.css';

export type WidgetFaceKey = 'jetzt' | 'verlauf';

/**
 * Portal v3 · M2 — das **Widget-Modal** mit den Segmenten `Jetzt | Verlauf`.
 *
 * Render-only. Beide Gesichter lesen **dieselbe** Ableitung wie die Kachel
 * (`cockpitWidgets.ts`) — es gibt keine zweite Rechnung (M2-Akzeptanz 3).
 *
 * **Es portalisiert nach `document.body`** — die Host-Karte hat `overflow:
 * hidden` (rundet die Ecken) und würde ein absolut positioniertes Kind
 * abschneiden; genau die dokumentierte `InfoTip`/`RowMenu`-Fehlerklasse.
 * Auf dem Telefon wird das Modal per CSS zum Vollbild-Sheet.
 */
export function WidgetModal({
  widget,
  onClose,
  onOpenSub,
  jetztExtra,
  verlaufExtra,
  controls,
}: {
  widget: WidgetDef;
  onClose: () => void;
  onOpenSub: (sub: AnlagenSub) => void;
  /** Der volle Körper des „Jetzt"-Gesichts (die migrierten Block-Bodies). */
  jetztExtra?: ReactNode;
  /** Der volle Körper des „Verlauf"-Gesichts (Bänder/Charts der Blöcke). */
  verlaufExtra?: ReactNode;
  /** Der Steuer-Slot der Kachel (heute: der Hinweis auf Technik). */
  controls?: ReactNode;
}) {
  const [face, setFace] = useState<WidgetFaceKey>('jetzt');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const view: WidgetFace = widget.modal[face];
  const extra = face === 'jetzt' ? jetztExtra : verlaufExtra;

  return createPortal(
    <div className="vp-wmodal-backdrop" onClick={onClose} role="presentation">
      <div
        className="vp-wmodal"
        role="dialog"
        aria-modal="true"
        aria-label={widget.label}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="vp-wmodal-head">
          <h3 className="vp-wmodal-title">{widget.label}</h3>
          <button type="button" className="vp-wmodal-close" onClick={onClose} aria-label="Schließen">
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="vp-wmodal-seg" role="tablist" aria-label="Ansicht">
          {(['jetzt', 'verlauf'] as WidgetFaceKey[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={face === k}
              className={`vp-wmodal-segbtn${face === k ? ' is-on' : ''}`}
              onClick={() => setFace(k)}
            >
              {k === 'jetzt' ? 'Jetzt' : 'Verlauf'}
            </button>
          ))}
        </div>

        <div className="vp-wmodal-body">
          {view.rows.length > 0 && (
            <ul className="vp-wmodal-rows">
              {view.rows.map((r) => (
                <li key={r.label} className="vp-wmodal-row">
                  <span className="vp-wmodal-row-label">{r.label}</span>
                  <span className="vp-wmodal-row-value">
                    {r.value}
                    {r.sub && <small className="vp-wmodal-row-sub">{r.sub}</small>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {extra}
          {view.note && <p className="vp-wmodal-note">{view.note}</p>}
          {face === 'jetzt' && controls}
          {view.drillIn && (
            <button
              type="button"
              className="vp-wmodal-drill"
              title={view.drillIn.hint}
              onClick={() => {
                const sub = view.drillIn!.sub;
                onClose();
                onOpenSub(sub);
              }}
            >
              {view.drillIn.label}
              <Icon name="chevron-right" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
