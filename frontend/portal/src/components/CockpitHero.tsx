import type { ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteEntity, SiteSource, SiteTopology } from '../api';
import type { CockpitHeroView, HeroRing } from '../cockpitWidgets';
import type { LiveSnapshot } from '../live';
import type { AnlagenSub } from '../nav';
import { flowHasValues } from '../liveDetail';
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
 *
 * **V14 (Audit): schweigt das Gerät, entfällt das Diagramm.** Vier „—"-Knoten
 * auf ~450 px sind keine Information; dann bekommt der WEG NACH VORN diesen
 * Platz (Was kann ich tun?, drei konkrete Schritte, ein Absprung zum Gerät).
 * **V11:** die Wetter-Zeile stand doppelt auf einem Bildschirm (hier UND in
 * der Wetter-Kachel) — hier ist sie weg, die Kachel trägt sie.
 */
export function CockpitHero({
  view,
  topology,
  snapshot,
  stale = false,
  sources = null,
  pins = null,
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
  /** Die PIN-Fakten der Komponenten (`edgeSourceId`/`orphanedPin`) - sie
      ordnen jede Quelle ihrer Komponente zu, nie die Reihenfolge. */
  pins?: SiteEntity[] | null;
  onOpenSub: (sub: AnlagenSub) => void;
  /** Zusatz unter dem Diagramm (heute: der Steuerungs-Streifen). */
  footer?: ReactNode;
}) {
  const hasFlow = flowHasValues(topology, snapshot);
  return (
    <Card padding="lg" radius="lg" className="vp-cockpit-hero" style={{ minWidth: 0 }}>
      <div className="vp-hero-flow">
        {hasFlow ? (
          topology ? (
            <AdaptiveEnergyFlow
              topology={topology}
              stale={stale}
              size="hero"
              sources={sources}
              pins={pins}
            />
          ) : (
            <EnergyFlow snapshot={snapshot} stale={stale} size="hero" />
          )
        ) : (
          <NoFlowGuidance onOpenSub={onOpenSub} />
        )}
        {/* Auf einer migrierten Anlage trägt der PV-Knoten seine Zusammensetzung
            selbst (ein Tipp darauf öffnet sie) - die immer sichtbare Zeile wäre
            dann eine zweite, widersprechbare Wahrheit. Die v1-Anlage behält sie:
            ihr Fluss hat keinen anklickbaren PV-Knoten. */}
        {hasFlow && !topology && <PvBreakdownLine sources={sources} />}
        {footer}
      </div>

      <div className="vp-hero-side">
        {view.rings.length > 0 ? (
          <div className="vp-hero-rings">
            {view.rings.map((r) => (
              <Ring key={r.id} ring={r} />
            ))}
          </div>
        ) : (
          view.ringsNote && (
            /* V13: der Platz bleibt reserviert und sagt, warum er leer ist -
               die Seitenhöhe springt nicht mehr bei jedem Tab-Wechsel. */
            <div className="vp-hero-rings vp-hero-rings-empty">
              <p className="vp-muted">{view.ringsNote}</p>
            </div>
          )
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

/**
 * V14: der Platz des Diagramms, wenn es nichts zu zeichnen gibt. Kein leeres
 * Diagramm, keine erfundene Null — die drei Dinge, die wirklich helfen.
 */
function NoFlowGuidance({ onOpenSub }: { onOpenSub: (sub: AnlagenSub) => void }) {
  return (
    <div className="vp-hero-noflow">
      <h3>Was kann ich tun?</h3>
      <ol>
        <li>Ist Ihr Gerät mit Strom versorgt?</li>
        <li>Hat es Verbindung zum Internet (Kabel oder WLAN)?</li>
        <li>Nach einem Neustart dauert es ein paar Minuten, bis Werte ankommen.</li>
      </ol>
      <button type="button" className="vp-btn vp-btn-ghost" onClick={() => onOpenSub('modell')}>
        <Icon name="cpu" size={16} />
        Gerät prüfen
      </button>
      <p className="vp-muted">
        Sobald Ihr Gerät wieder sendet, erscheint hier automatisch der Energiefluss.
      </p>
    </div>
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
