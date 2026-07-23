import type { ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteSource, SiteTopology } from '../api';
import type { CockpitHeroView, HeroRing } from '../cockpitWidgets';
import type { LiveSnapshot } from '../live';
import type { AnlagenSub } from '../nav';
import { AdaptiveEnergyFlow } from './AdaptiveEnergyFlow';
import { EnergyFlow } from './EnergyFlow';
import { PvBreakdownLine } from './PvBreakdown';
import './CockpitBlocks.css';

/**
 * Portal v3 · M2 — der **Hero des Live-Cockpits**.
 *
 * Links das **bestehende** Energiefluss-Diagramm, groß und zentral gehostet:
 * `AdaptiveEnergyFlow` für eine migrierte Anlage (die vorhandene
 * `hasTopology`-Weiche entscheidet), sonst `EnergyFlow`. **Es wird KEIN neues
 * Diagramm gebaut** — die Owner-Entscheidung (BUILD.md §2) ist Wiederverwendung;
 * nur Größe und Platzierung ändern sich (`size="hero"`).
 *
 * Rechts die Kennzahlen: **Autarkie** und **Eigenverbrauch** als Ringe, die
 * dem gewählten Zeitraum folgen (v3.2 M1 — Etikett „Autarkie · Monat"), die
 * verdiente Summe des gewählten Zeitraums mit der Steuerungs-Zurechnung als
 * Unterzeile, und die eine Fahrplan-Zeile. Der Energiefluss links bleibt
 * „jetzt gerade". Ein Zeitraum-Wert, der nicht vorliegt, erzeugt **keinen
 * Ring** — nie „0 %".
 *
 * Render-only: alles Abgeleitete kommt aus `cockpitWidgets.ts` `cockpitHero`.
 */
export function CockpitHero({
  view,
  topology,
  snapshot,
  stale = false,
  sources = null,
  whyLine,
  onOpenSub,
  footer,
}: {
  view: CockpitHeroView;
  /** Nicht-null = migrierte Anlage → das adaptive Diagramm. */
  topology: SiteTopology | null;
  snapshot: LiveSnapshot;
  stale?: boolean;
  /**
   * Die Messstellen der Anlage: eine Multi-Wechselrichter-Anlage erklärt ihre
   * Solar-Zahl unter dem Diagramm (#524; rendert sich bei < 2 messenden
   * Geräten selbst weg). Die Frische-Zeile lebt seit dem Cockpit+Live-Merge
   * NUR noch als Kopf-Chip (R4: eine Frischewahrheit).
   */
  sources?: SiteSource[] | null;
  /** Die Wetter-„Warum"-Zeile, nur bei frischen Daten. */
  whyLine?: string | null;
  onOpenSub: (sub: AnlagenSub) => void;
  /** Zusatz unter dem Diagramm (heute: der Steuerungs-Streifen). */
  footer?: ReactNode;
}) {
  return (
    <Card padding="lg" radius="lg" className="vp-cockpit-hero" style={{ minWidth: 0 }}>
      <div className="vp-hero-flow">
        {topology ? (
          <AdaptiveEnergyFlow topology={topology} stale={stale} size="hero" />
        ) : (
          <EnergyFlow snapshot={snapshot} stale={stale} size="hero" />
        )}
        <PvBreakdownLine sources={sources} />
        {whyLine && (
          <p className="vp-live-why">
            <Icon name="sun" size={14} /> {whyLine}
          </p>
        )}
        {footer}
      </div>

      <div className="vp-hero-side">
        {view.rings.length > 0 && (
          <div className="vp-hero-rings">
            {view.rings.map((r) => (
              <Ring key={r.id} ring={r} />
            ))}
          </div>
        )}

        {view.money && (
          <div className="vp-hero-money">
            <span className="vp-hero-money-label">{view.money.label}</span>
            <span className="vp-hero-money-value">{view.money.value}</span>
            {/* Zurechnung IMMER als Unterzeile, nie als eigener Summand. */}
            {view.money.attribution && (
              <span className="vp-hero-money-attr">{view.money.attribution}</span>
            )}
          </div>
        )}

        {view.planSentence && (
          <button
            type="button"
            className="vp-hero-plan"
            onClick={() => onOpenSub('fahrplan')}
          >
            <Icon name="trending-up" size={16} />
            <span>{view.planSentence}</span>
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </div>
    </Card>
  );
}

/** Ein Ring-KPI — reines SVG, keine neue Abhängigkeit. */
function Ring({ ring }: { ring: HeroRing }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const on = (ring.pct / 100) * C;
  return (
    <div className="vp-hero-ring">
      <svg viewBox="0 0 64 64" role="img" aria-label={`${ring.label}: ${ring.valueText}`}>
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--vp-flow-base)" strokeWidth={6} />
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke={ring.hue}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${on.toFixed(2)} ${(C - on).toFixed(2)}`}
          transform="rotate(-90 32 32)"
        />
        <text
          x="32"
          y="36"
          textAnchor="middle"
          fontWeight={800}
          fontSize={14}
          fill="var(--vp-stat-ink, #2c5282)"
          fontFamily="Inter, sans-serif"
        >
          {ring.valueText}
        </text>
      </svg>
      <span className="vp-hero-ring-label">{ring.label}</span>
    </div>
  );
}
