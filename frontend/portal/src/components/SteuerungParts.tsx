/**
 * Die Render-Bausteine der Steuerungs-Fläche (Modus-Karte, Schutzfunktionen,
 * Kopfzeile).
 *
 * ⚠ `CoOptimizationStrip` ist mit Steuerung Stufe 5 ERSATZLOS entfallen —
 * Begründung an der Stelle, an der auch seine Ableitung stand
 * (`steuerungArea.ts`, Abschnitt „Speicher-Modi").
 * Jede Ableitung liegt im unit-getesteten `src/steuerungArea.ts`; hier wird
 * NUR gerendert (der `FleetOverview`/`ErloesKomposition`-Präzedenzfall).
 */
import type { ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsSite, EntityStrategy } from '../api';
import type { EditorEntity } from '../flows/model';
import { InfoTip } from './InfoTip';
import { AUTOMATIC_MODULES } from '../moduleSurface';
import {
  contributionRows,
  entityChips,
  modeActions,
  peakContributionNote,
} from '../steuerungArea';
import type { ActiveMode } from '../surface';
import './Steuerung.css';

// ---------------------------------------------------------------------------
// 1 · Aktive Modi
// ---------------------------------------------------------------------------

/**
 * Eine Karte je AKTIVEM Modus: Zustand, Ergebnis-Satz, sein Beitrag (echte
 * Zahlen, sonst „—"), die beanspruchten Geräte und die Aktionen. Ein reiner
 * Stammdaten-Modus zeigt „Von VoltPilot eingerichtet" und KEINE
 * Öffnen/Pausieren-Affordanz (report §1.2).
 */
export function ModeCard({
  mode,
  earnings,
  strategies,
  entities,
  busy = false,
  onOpen,
  onPause,
}: {
  mode: ActiveMode;
  earnings: EarningsSite | null;
  strategies: Record<string, EntityStrategy[]> | null;
  entities: EditorEntity[];
  busy?: boolean;
  onOpen: (mode: ActiveMode) => void;
  onPause: (mode: ActiveMode) => void;
}) {
  const card = mode.manifest.steuerungCard;
  const actions = modeActions(mode);
  const rows = contributionRows(mode, earnings);
  const chips = entityChips(mode, strategies, entities);
  const peakNote = mode.kind === 'lastspitzenkappung' ? peakContributionNote(earnings) : null;

  return (
    <Card className="vp-modecard" padding="lg" radius="lg">
      <div className="vp-modecard-head">
        <h4>{card.title}</h4>
        {mode.preview ? (
          <Badge variant="off">In Vorbereitung</Badge>
        ) : (
          <Badge variant="ok" dot>Aktiv</Badge>
        )}
      </div>

      <p className="vp-modecard-line">{card.line}</p>

      {actions.managedNote && (
        <p className="vp-modecard-managed">
          <Icon name="shield" size={13} /> {actions.managedNote}
        </p>
      )}

      {rows.length > 0 && (
        <dl className="vp-modecard-contrib">
          {rows.map((row) => (
            <div key={row.id} className="vp-contrib-row">
              <dt className="vp-contrib-label">
                {row.label}
                {row.note && <span className="vp-contrib-period"> · {row.note}</span>}
              </dt>
              <dd className={`vp-contrib-value${row.value == null ? ' muted' : ''}`}>
                {row.value ?? '—'}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {peakNote && <p className="vp-coopt-note">{peakNote}</p>}

      {chips.length > 0 && (
        <div className="vp-modecard-chips" aria-label="Beanspruchte Geräte">
          {chips.map((chip) => (
            <span key={chip.id} className="vp-mode-chip">
              <Icon name="cpu" size={12} /> {chip.label}
            </span>
          ))}
        </div>
      )}

      <div className="vp-modecard-foot">
        {actions.canOpen && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpen(mode)}>
            Details
          </Button>
        )}
        {actions.canPause && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onPause(mode)}>
            Pausieren
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Automatisch aktiv (kein Modus — Schutzfunktionen, die immer laufen)
// ---------------------------------------------------------------------------

export function ProtectionsRow() {
  return (
    <div className="vp-protections">
      {AUTOMATIC_MODULES.map((row) => (
        <div key={row.title} className="vp-protection">
          <Icon name="shield" size={16} />
          <div style={{ minWidth: 0 }}>
            <strong>
              {row.title} <InfoTip title={row.title}>{row.tip}</InfoTip>
            </strong>
            <p>{row.line}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kopfzeile eines Teils
// ---------------------------------------------------------------------------

export function PartHead({
  title,
  badge,
  intro,
  children,
}: {
  title: string;
  badge?: ReactNode;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="vp-steuerung-parthead">
        <h3>{title}</h3>
        {badge}
        {children}
      </div>
      {intro && <p className="vp-steuerung-partintro">{intro}</p>}
    </>
  );
}
