import { useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { ZUSTAND_TITLE, zustandView, type HealthItem } from '../health';
import type { AnlagenSub } from '../nav';
import { ToolboxPointer } from './CockpitBlocks';
import './ZustandCard.css';

/**
 * Die Zustand-Fläche des Cockpits (vp-cockpit-unten-ux-n3 PR 3, D5/D6):
 * **leise, wenn gesund — laut nur mit Befund.**
 *
 * - Grün: EINE ruhige Zeile („Alles in Ordnung — … arbeiten zusammen.") mit
 *   einem „Details"-Aufklapper, der die klassische Checkliste zeigt — nichts
 *   ist gelöscht, es ist nur still, solange es nichts zu melden gibt.
 * - Befund: die Karte kippt in den Warn-Rahmen („Zustand der Anlage" +
 *   Badge-Wort), Befunde warn-zuerst, jede Zeile nennt Ursache UND Hebel
 *   (Gerät → Anlagen-Modell, Fahrplan → Fahrplan, Steuerung → Steuerung,
 *   Speicher → Einstellungen); `off`-Befunde bleiben im ruhigen Ton (D5 —
 *   laut ist nur, was kaputt ist). Die gesunden Reste kollabieren zu einer
 *   gedämpften Zeile.
 * - Der Modus-Fuß (D6): die Toolbox-Zeile ist der FUSS dieser Fläche — der
 *   Stack endet mit einer Karte statt mit einem baumelnden Absatz. Wortlaut
 *   unverändert (nie ein bestimmter Modus beworben).
 *
 * Render-only — die ganze Ableitung ist `health.zustandView` (rein,
 * unit-getestet); der Container behält `id="zustand"` als Sprungziel des
 * Schalen-Abzeichens.
 */
export function ZustandCard({
  items,
  onOpenSub,
  onOpenModus,
}: {
  items: HealthItem[];
  /** Der Hebel eines Befunds öffnet seine Unterseite. */
  onOpenSub: (sub: AnlagenSub) => void;
  /** Der Modus-Fuß öffnet die Steuerung (Modus hinzufügen). */
  onOpenModus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const view = zustandView(items);
  if (view == null) return null;

  const foot = (
    <div className="vp-zustand-foot">
      <ToolboxPointer onOpen={onOpenModus} />
    </div>
  );

  if (view.state === 'ok') {
    const rest = view.line!.startsWith('Alles in Ordnung')
      ? view.line!.slice('Alles in Ordnung'.length)
      : view.line!;
    return (
      <Card padding="lg" radius="lg" className="vp-zustand" style={{ minWidth: 0 }}>
        <div className="vp-zustand-line">
          <span className="vp-zustand-dot" aria-hidden="true" />
          <span className="vp-zustand-text">
            <b>Alles in Ordnung</b>
            {rest}
          </span>
          <button
            type="button"
            className={`vp-zustand-details${open ? ' is-open' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            Details
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
        {open && (
          <ul className="vp-health-list vp-zustand-list">
            {items.map((it) => (
              <li key={it.key} className={`vp-health-item tone-${it.state}`}>
                <span className="vp-health-mark" aria-hidden="true">
                  ✓
                </span>
                <span className="vp-health-label">{it.label}</span>
                <span className="vp-health-detail">{it.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {foot}
      </Card>
    );
  }

  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-zustand befund${view.toneWord === 'Hinweis' ? ' hinweis' : ''}`}
      style={{ minWidth: 0 }}
    >
      <div className="vp-zustand-head">
        <span className="vp-zustand-dot" aria-hidden="true" />
        {ZUSTAND_TITLE}
        <span className="vp-badge-word">
          <Badge variant={view.toneWord === 'Warnung' ? 'warn' : 'off'}>{view.toneWord}</Badge>
        </span>
      </div>
      {view.findings.map((f) => (
        <div key={f.key} className={`vp-zustand-row ${f.state}`}>
          <span className="vp-zustand-mark" aria-hidden="true">
            {f.state === 'warn' ? '!' : '–'}
          </span>
          <span className="txt">{f.text}</span>
          <button
            type="button"
            className="vp-zustand-lever"
            onClick={() => onOpenSub(f.lever.sub)}
          >
            {f.lever.label}
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      ))}
      {view.okSummary && <p className="vp-zustand-ok">{view.okSummary}</p>}
      {foot}
    </Card>
  );
}
