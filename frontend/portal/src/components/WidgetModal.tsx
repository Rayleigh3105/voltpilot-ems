import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsRange, History } from '../api';
import type { WidgetDef, WidgetDrillIn, WidgetFace } from '../cockpitWidgets';
import type { AnlagenSub } from '../nav';
import { widgetHistoryMetric } from '../widgetHistory';
import { WidgetHistoryChart } from './WidgetHistoryChart';
import './CockpitBlocks.css';

/**
 * Portal v3.2 · **M2 — das RICHE Widget-Detail-Modal.** Ein Tipp auf eine
 * Kachel öffnet EINE Ansicht, die die **Werte** der Kachel UND ihren
 * **Verlauf** zusammen zeigt (OpenEMS-Widget-Detail-Richtung) — der frühere
 * „Jetzt | Verlauf"-Umschalter ist weg. Aufbau: Kopf (Titel + aktuelle Zahl) →
 * Werte-Zeilen → der reiche Block-Körper (`extra`) → das Verlauf-Diagramm für
 * diese Kennzahl über den GEWÄHLTEN Zeitraum → die Absprünge in die Tiefe.
 *
 * Render-only. Die Werte-Zeilen lesen **dieselbe** Ableitung wie die Kachel
 * (`cockpitWidgets.ts`), der Verlauf **dieselben** Historie-Buckets wie die
 * Historie-Seite (`widgetHistory.ts` + `WidgetHistoryChart`) — keine zweite
 * Rechnung, kein neuer Chart-Stack. Der Verlauf **folgt dem Zeitraum-Tab**; wo
 * keiner vorliegt (Gesamt, frische Anlage), steht ein ehrlicher Satz statt
 * eines erfundenen Diagramms.
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
  extra,
  history,
  range,
  periodLabel,
}: {
  widget: WidgetDef;
  onClose: () => void;
  onOpenSub: (sub: AnlagenSub) => void;
  /** Der reiche Block-Körper (Peak-Band / Erlös-Komposition / Fahrplan-Band). */
  extra?: ReactNode;
  /** Die zeitraum-bezogene Historie für den Verlauf; null = kein Verlauf. */
  history?: History | null;
  /** Der gewählte Zeitraum (regiert den Verlauf; „Gesamt" hat keinen). */
  range: EarningsRange;
  /** Das Periodenetikett (z. B. „Juli", „Heute") für die Verlauf-Überschrift. */
  periodLabel: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Die migrierte „Jetzt"-Seite trägt die Werte; die „Verlauf"-Seite trägt nur
  // noch ihren Absprung in die Tiefen-Sicht (der Verlauf selbst steht jetzt IM
  // Modal als Diagramm). Beide Notizen/Absprünge fließen in eine Ansicht.
  const jetzt: WidgetFace = widget.modal.jetzt;
  const verlauf: WidgetFace = widget.modal.verlauf;
  const metric = widgetHistoryMetric(widget.id);
  const drills = dedupeDrills([jetzt.drillIn, verlauf.drillIn]);

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

        <div className="vp-wmodal-body">
          {jetzt.rows.length > 0 && (
            <ul className="vp-wmodal-rows">
              {jetzt.rows.map((r) => (
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

          {/* Der Verlauf dieser Kennzahl — Werte UND Verlauf in EINER Ansicht.
              Nur Fluss-/Energie-Kacheln haben einen (`widgetHistoryMetric`). */}
          {metric && (
            <WidgetHistoryChart
              history={history ?? null}
              metric={metric}
              range={range}
              periodLabel={periodLabel}
            />
          )}

          {jetzt.note && <p className="vp-wmodal-note">{jetzt.note}</p>}

          {drills.map((d) => (
            <button
              key={d.sub}
              type="button"
              className="vp-wmodal-drill"
              title={d.hint}
              onClick={() => {
                onClose();
                onOpenSub(d.sub);
              }}
            >
              {d.label}
              <Icon name="chevron-right" size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Beide Absprünge einer Kachel, nach Ziel-Seite entdoppelt (erster gewinnt). */
function dedupeDrills(drills: (WidgetDrillIn | null)[]): WidgetDrillIn[] {
  const out: WidgetDrillIn[] = [];
  const seen = new Set<AnlagenSub>();
  for (const d of drills) {
    if (!d || seen.has(d.sub)) continue;
    seen.add(d.sub);
    out.push(d);
  }
  return out;
}
