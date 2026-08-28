import type { ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteEntity, SiteSource, SiteTopology } from '../api';
import type { CockpitHeroView, HeroRing } from '../cockpitWidgets';
import type { LiveSnapshot } from '../live';
import type { AnlagenSub } from '../nav';
import { flowHasValues } from '../liveDetail';
import type { ConsumerStripView } from '../consumers/fulfillment';
import type { ChargingNodeOpts } from '../adaptiveFlow';
import { AdaptiveEnergyFlow } from './AdaptiveEnergyFlow';
import { EnergyFlow } from './EnergyFlow';
import { PvBreakdownLine } from './PvBreakdown';
import { ConsumerStrip } from './ConsumerStrip';
import './CockpitBlocks.css';

/**
 * Der obere Cockpit-Bereich: **die Bühne** (abgenommenes Konzept
 * `data/vp-cockpit-konzept-f4`, Richtung A; Captain-Go 30.07.2026).
 *
 * Links, auf ~62 % der Kartenbreite, das **bestehende** Energiefluss-Diagramm —
 * `AdaptiveEnergyFlow` für eine migrierte Anlage (die vorhandene
 * `hasTopology`-Weiche entscheidet), sonst `EnergyFlow`. **Es wird KEIN neues
 * Diagramm gebaut** (BUILD.md §2), und es wird auch nicht kleiner: die bindende
 * Captain-Vorgabe ist, dass der Fluss groß und präsent bleibt — er FÜLLT jetzt
 * seine Spalte (`size="hero"`), statt zusätzlich von einem eigenen Deckel
 * begrenzt zu werden.
 *
 * Rechts die **Bilanz-Leiste**: das kompakte Zeitraum-Segment steht direkt über
 * den Zahlen, die es regiert (§6.3), darunter der Geldblock mit der
 * Steuerungs-Zurechnung als Unterzeile, die Ringe (Autarkie/Eigenverbrauch,
 * die dem Zeitraum folgen — v3.2 M1) und die eine Fahrplan-Zeile. Die Blöcke
 * verteilen sich per `space-between` über die volle Bühnenhöhe, **deshalb gibt
 * es die tote Zone unter dem Geldblock strukturell nicht mehr**. Der
 * Energiefluss selbst bleibt „jetzt gerade". Ein Zeitraum-Wert, der nicht
 * vorliegt, erzeugt **keinen Ring** — nie „0 %"; und eine Komposition, die
 * KEINEN Leisten-Block beisteuert, bekommt gar keine Leiste (kein leerer
 * Rahmen, die Bühne wird dann einspaltig).
 *
 * Am Bühnenfuß, über die **volle** Kartenbreite, die schlanke Steuerungs-Zeile
 * (Sollwert → Bestätigung → Grund, `ControlStrip variant="bare"`): kein
 * Karte-in-Karte-Rahmen, keine leere Hälfte daneben.
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
  periodSeg = null,
  controlConfirmed = false,
  charging = null,
  chargingOwn = null,
  showRail = true,
  rename = null,
  consumers = null,
  onOpenConsumers,
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
  /**
   * Der **Bühnenfuß** in voller Kartenbreite (heute: die Steuerungs-Zeile).
   * Er hängt bewusst NICHT mehr in der Fluss-Spalte — dort blieb die rechte
   * Hälfte daneben leer (Befund P4 des Konzepts).
   */
  footer?: ReactNode;
  /**
   * Das kompakte Zeitraum-Segment der Bilanz-Leiste (`PeriodTabs variant="seg"`).
   * null = diese Komposition hat keine zeitraum-bezogenen Zahlen, also auch
   * nichts zu wählen.
   */
  periodSeg?: ReactNode;
  /** Der Wechselrichter bestätigt den Sollwert → Haken am Speicher-Knoten. */
  controlConfirmed?: boolean;
  /**
   * Der fünfte Kreis „Laden" (Konzept `vp-verbraucher-cockpit-k1` §6, E3) —
   * ein Abzweig VOM Haus. Er wird durchgereicht, nie hier abgeleitet: die
   * eine Ableitung ist `ladenKachel.ladeFlussKnoten`, damit Diagramm und Kachel
   * über dieselbe Säule nichts Verschiedenes behaupten können. null (keine
   * Ladepunkte) rendert das Diagramm ZEICHENGLEICH zu vorher.
   */
  charging?: ChargingNodeOpts | null;
  /**
   * Der Kreis „Laden (eigener Anschluss)" (Cockpit Phase 1 / C2) - Säulen an
   * einem EIGENEN Netzanschluss hängen am HUB neben dem Haus, nicht als Abzweig
   * darunter: ihre Kilowatt stecken nicht in der Hausmessung.
   */
  chargingOwn?: ChargingNodeOpts | null;
  /**
   * Ob die **Bilanz-Leiste** gerendert wird. Default `true` = die Bühne, wie
   * sie war. Die Telefon-Fassung (Mobil-Umbau Stufe 2, `<= 720px`) setzt sie
   * auf `false`: dort trägt die EINE Geld-Karte unter dem Fluss Segment, Zahl,
   * Zurechnung und die Ringe (als Chips), und die Fahrplan-Zeile ist eine
   * eigene Zeile mit Absprung — die Leiste wäre die zweite Kopie davon.
   */
  showRail?: boolean;
  /**
   * Aktiviert die Umbenennen-Stifte in der PV-Zusammensetzung (Konzept
   * `vp-entity-alias-k1` §5): der Wunsch entsteht beim Blick auf DIESE Liste.
   * Es führt in denselben Bearbeitungsort wie das Anlagen-Modell.
   */
  rename?: { siteId: string; boxRef: string | null; onRenamed: () => void } | null;
  /**
   * Der Cockpit-Verbraucherstreifen (§14.10): eine Zeile je steuerbarem
   * Verbraucher unter dem Energiefluss. null (keine Verbraucher / älteres
   * Backend) rendert nichts - das Cockpit ist dann byte-identisch zu vorher.
   */
  consumers?: ConsumerStripView | null;
  onOpenConsumers?: () => void;
}) {
  const hasFlow = flowHasValues(topology, snapshot);
  const rings =
    view.rings.length > 0 ? (
      <div className="vp-hero-rings">
        {view.rings.map((r) => (
          <Ring key={r.id} ring={r} />
        ))}
      </div>
    ) : view.ringsNote ? (
      /* V13: der Platz bleibt reserviert und sagt, warum er leer ist -
         die Seitenhöhe springt nicht mehr bei jedem Tab-Wechsel. */
      <div className="vp-hero-rings vp-hero-rings-empty">
        <p className="vp-muted">{view.ringsNote}</p>
      </div>
    ) : null;
  // Die Leiste verteilt die VORHANDENEN Blöcke über die Höhe. Steuert eine
  // Komposition keinen einzigen bei, gibt es keine Leiste (und keinen leeren
  // Rahmen) - die Bühne wird dann einspaltig und der Fluss nimmt sie ganz ein.
  const hasRail =
    showRail &&
    (periodSeg != null || view.money != null || rings != null || view.planSentence != null);
  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-cockpit-hero${hasRail ? '' : ' vp-stage-norail'}`}
      style={{ minWidth: 0 }}
    >
      <div className="vp-hero-flow">
        {hasFlow ? (
          topology ? (
            <AdaptiveEnergyFlow
              topology={topology}
              stale={stale}
              size="hero"
              sources={sources}
              pins={pins}
              controlConfirmed={controlConfirmed}
              charging={charging}
              chargingOwn={chargingOwn}
              rename={rename}
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
        <ConsumerStrip view={consumers} onOpen={onOpenConsumers} />
      </div>

      {hasRail && (
        <div className="vp-hero-side">
          {periodSeg && (
            <div className="vp-rail-blk vp-hero-seg">
              <span className="vp-card-label">Bilanz</span>
              {periodSeg}
            </div>
          )}

          {view.money && (
            <div className="vp-rail-blk vp-hero-money">
              <span className="vp-hero-money-label">{view.money.label}</span>
              <span className="vp-hero-money-value">{view.money.value}</span>
              {/* Zurechnung IMMER als Unterzeile, nie als eigener Summand. */}
              {view.money.attribution && (
                <span
                  className={`vp-hero-money-attr${view.money.attributionInterim ? ' is-interim' : ''}`}
                >
                  {view.money.attribution}
                </span>
              )}
              {view.money.bestand && (
                <span className="vp-hero-money-bestand" title={view.money.bestand.titel ?? undefined}>
                  <span>{view.money.bestand.text}</span>
                  {view.money.bestand.badge && (
                    <Badge variant="tint" className="vp-hero-money-bestand-badge">
                      {view.money.bestand.badge}
                    </Badge>
                  )}
                </span>
              )}
            </div>
          )}

          {rings && <div className="vp-rail-blk">{rings}</div>}

          {view.planSentence && (
            <div className="vp-rail-blk">
              <button
                type="button"
                className="vp-hero-plan"
                onClick={() => onOpenSub('fahrplan')}
              >
                <Icon name="trending-up" size={16} />
                <span>{view.planSentence}</span>
                <Icon name="chevron-right" size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {footer && <div className="vp-stage-foot">{footer}</div>}
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
