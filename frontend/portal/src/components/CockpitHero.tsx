import { lazy, Suspense, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { RollenKanonischerWert, SiteEntity, SiteSource, SiteTopology } from '../api';
import type { LiveSnapshot } from '../live';
import type { AnlagenSub } from '../nav';
import { flowHasValues } from '../liveDetail';
import type { ChargingNodeOpts } from '../adaptiveFlow';
import { cockpitRollenTopologie } from '../pvRolle';
import { pvComposition } from '../pvComposition';
import { jetztFluss } from '../flussJetzt';
import type { Betrieb, Rolle } from '../leitungsplan';
import type { PlanWordingKind } from '../schedule';
import type { Tag } from '../tagesleiste';
import type { VerbrauchKomposition } from '../verbrauchKomposition';
// Die Bühne ist ein eigenes, nachgeladenes Stück: der Einstieg bleibt unter
// seiner Grenze (`test/bundle-smoke.sh`), und der Platzhalter hält ihre Höhe,
// damit beim Nachladen nichts springt.
const EnergieBuehne = lazy(() => import('./EnergieBuehne').then((m) => ({ default: m.EnergieBuehne })));
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
  topology,
  snapshot,
  stale = false,
  sources = null,
  pins = null,
  onOpenSub,
  footer,
  ladenHinweis = null,
  showRail = true,
  seite = null,
  pvRollen = null,
  verbrauchRollen = null,
  netzRollen = null,
  buehne = null,
}: {
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
   * Der Satz „Laden bei Bezug" (K8/B2, `ladenBeiBezug.ts`) - steht unter dem
   * Fluss, solange der Speicher lädt, während das Netz liefert. null = nichts.
   */
  ladenHinweis?: string | null;
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
   * Ob rechts neben dem Fluss eine Spalte steht (am Rechner). Am Telefon steht
   * die Leitkachel als erste Kachel unter der Bühne.
   */
  showRail?: boolean;
  /**
   * Die **Leitkachel** rechts neben dem Fluss (Konzept „Cockpit als
   * Tagesfilm“): „Unterm Strich“, der Börsenpreis oder die Lastspitze. Sie
   * steht dann nicht noch einmal im Raster darunter.
   */
  seite?: ReactNode;
  /**
   * Aktiviert die Umbenennen-Stifte in der PV-Zusammensetzung (Konzept
   * `vp-entity-alias-k1` §5): der Wunsch entsteht beim Blick auf DIESE Liste.
   * Es führt in denselben Bearbeitungsort wie das Anlagen-Modell.
   */
  rename?: { siteId: string; boxRef: string | null; onRenamed: () => void } | null;
  /**
   * Die Eingaben der Bühne (Konzept „Cockpit als Tagesfilm“): Betriebsmodell,
   * der heutige Tag (Verlauf + Plan), das Lastspitzen-Ziel und „Verbrauch im
   * Detail“. Fehlt sie, zeigt die Bühne nur „jetzt“, ohne Tagesleiste.
   */
  buehne?: {
    betrieb: Betrieb;
    tag: Tag | null;
    zielKw: number | null;
    verbrauch: VerbrauchKomposition | null;
    planKind: PlanWordingKind;
    isPhone: boolean;
    now: Date;
    /** Ein Knoten-Blatt geht auf/zu (z. B. um die Tagessummen je Gerät zu holen). */
    onBlatt?: (art: Rolle | null) => void;
  } | null;
  /**
   * Der kanonische PV-ROLLEN-Wert der Anlage (`GET …/rollen/pv`, vp-agg §2.4/B). Existiert eine
   * Standort-PV-Zuordnung, trägt die Cockpit-Zahl ein dezentes „berechnet" und ein Tipp öffnet die
   * Aufschlüsselung je Gerät. null / keine Zuordnung = das Cockpit bleibt beim Rückfall
   * `telemetry.pv_power_kw` und die Fläche rendert nichts.
   */
  pvRollen?: RollenKanonischerWert | null;
  verbrauchRollen?: RollenKanonischerWert | null;
  netzRollen?: RollenKanonischerWert | null;
}) {
  const rollenTopologie = cockpitRollenTopologie(topology, [pvRollen, verbrauchRollen, netzRollen]);
  const hasFlow = flowHasValues(rollenTopologie, snapshot);
  // Existiert eine kanonische PV-Zuordnung, ist SIE die Herkunft der Cockpit-Zahl - dann tritt die
  // rohe Quellen-Aufteilung (`PvBreakdownLine`) zurück, sie erklärte sonst eine andere Zahl.
  const pvRolleAktiv = pvRollen?.zuordnung_vorhanden === true;
  // Die EINE Ableitung der PV-Zusammensetzung: sie liefert die Zahl am
  // Sonnen-Knoten UND „Erzeugung im Detail“ - beide können sich nicht
  // widersprechen. Mit kanonischer PV-Rolle ist deren Wert die Zahl.
  const composition = topology && !pvRolleAktiv ? pvComposition(rollenTopologie, sources, pins) : null;
  // Rechts neben dem Fluss steht am Rechner die LEITKACHEL (Konzept „Cockpit
  // als Tagesfilm“) - „Unterm Strich“, der Börsenpreis oder die Lastspitze.
  // Ohne sie wird die Bühne einspaltig.
  const hasRail = showRail && seite != null;
  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-cockpit-hero${hasRail ? '' : ' vp-stage-norail'}`}
      style={{ minWidth: 0 }}
    >
      <div className="vp-hero-flow">
        {hasFlow ? (
          <Suspense fallback={<div className="vp-eb-warten" aria-hidden="true" />}>
          <EnergieBuehne
            jetzt={jetztFluss(rollenTopologie, snapshot, {
              pvTotalKw: composition?.totalKw ?? null,
              loadKanonisch: verbrauchRollen?.zuordnung_vorhanden ? { wert: verbrauchRollen.wert } : null,
            })}
            stale={stale}
            betrieb={buehne?.betrieb ?? 'eigenverbrauch'}
            tag={buehne?.tag ?? null}
            zielKw={buehne?.zielKw ?? null}
            verbrauch={buehne?.verbrauch ?? null}
            pv={composition}
            rollen={{ pv: pvRollen, load: verbrauchRollen, grid: netzRollen }}
            planKind={buehne?.planKind ?? 'eigenverbrauch'}
            isPhone={buehne?.isPhone ?? false}
            now={buehne?.now ?? new Date()}
            onBlatt={buehne?.onBlatt}
            onOpenSub={onOpenSub}
          />
          </Suspense>
        ) : (
          <NoFlowGuidance onOpenSub={onOpenSub} />
        )}
        {hasFlow && ladenHinweis && (
          <p className="vp-hero-hinweis" role="status">
            <Icon name="info" size={14} />
            <span>{ladenHinweis}</span>
          </p>
        )}
        {/* vp-agg §2.4/B: die Aufschlüsselung der kanonischen Rollen je Gerät
            steht im Blatt des jeweiligen Knotens - nicht noch einmal hier. */}
      </div>

      {hasRail && <div className="vp-hero-side">{seite}</div>}

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

