import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { api, ApiError, type Earnings, type PeakShaving, type SchedulePlan, type Site } from '../api';
import { abrechnungLabel, lastspitzenPerioden } from '../moduleSurface';
import {
  FAHRPLAN_LEER_SATZ,
  VERLAUF_LEER_SATZ,
  fahrplanKern,
  fahrplanPeriodenNote,
  hatPlan,
  lastspitzeStatement,
  lastspitzeZeilen,
} from '../lastspitzenVerlauf';
import { planInsightParts } from '../schedule';
import {
  VerlaufFuss,
  VerlaufKopf,
  ZeitBlaetterer,
  ZeitLeisteRahmen,
} from '../components/HistorieWelt';
import { useIsPhone } from '../useIsPhone';
import { ChartHeadline } from '../components/ChartExplain';
import { VerlaufKarte } from '../components/VerlaufKarte';
import { VerlaufLedger } from '../components/VerlaufLedger';
import { PeakHistoryChart, peakVerlaufKernsatz } from '../components/PeakHistoryChart';
import { ScheduleChart } from '../ScheduleChart';
import {
  EmptyState,
  VerlaufFehler,
  VerlaufKarteSkeleton,
  VerlaufLeer,
} from '../components/States';

/**
 * U4 - the `Lastspitzen` subpage (`#/anlage/{id}/lastspitzen`, design §6 Face 2).
 * The peak-shaving customer's dedicated proof-and-plan view:
 *
 *   1. the PS-4 proof (gehaltene Spitze / vermiedene Spitze / ersparte
 *      Leistungskosten of the running billing period),
 *   2. the per-period history chart (earnings.peakShaving.history),
 *   3. the Fahrplan with the peak-target (Ziel Netzbezug) overlay.
 *
 * All data is customer-reachable (peakShaving from GET /earnings, the target
 * from GET /schedule) - no new endpoint. A site without an active peak-shaving
 * module gets the honest "nicht aktiv" state (deep-link safe, never a crash).
 */
/** Der Lead-Satz des früheren Seitenkopfs (`SUB_PAGES.lastspitzen`, bis P1). */
const LASTSPITZEN_LEAD =
  'Lastspitzenkappung: gehaltene Spitze, vermiedene Leistungskosten und der Fahrplan zum Halten Ihrer Zielspitze.';

export function LastspitzenSection({ site }: { site: Site }) {
  const isPhone = useIsPhone();
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnErr, setEarnErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // peakShaving is range-independent (always the running billing period); month
  // is an arbitrary valid range. Fail-soft: an older backend omits the block.
  useEffect(() => {
    let active = true;
    setEarnings(null);
    setEarnErr(null);
    api.earnings('month').then(
      (e) => active && setEarnings(e),
      (e) => active && setEarnErr(e instanceof ApiError ? e.message : 'Fehler'),
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  useEffect(() => {
    let active = true;
    setPlan(null);
    api.schedule(site.id).then(
      (p) => active && setPlan(p),
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  const peak: PeakShaving | null =
    earnings?.sites.find((s) => s.id === site.id)?.peakShaving ?? null;

  /**
   * Die blätterbaren Perioden + die gewählte. `idx` steht auf der LAUFENDEN
   * (der letzten), sobald der Abruf da ist — ein Blätterer, der auf einer alten
   * Periode startet, beantwortete die Frage nicht, mit der man herkommt.
   */
  const perioden = useMemo(() => lastspitzenPerioden(peak), [peak]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(Math.max(0, perioden.length - 1));
  }, [perioden.length, site.id]);

  if (earnErr && earnings == null) {
    // V10 · der Fehler steht IN der Karte, unter der Überschrift, unter der
    // sonst die Zahl stünde — nie in einer eigenen Kachel.
    return (
      <VerlaufKarte label="Ihre Lastspitze">
        <VerlaufFehler satz={earnErr} onRetry={() => setReloadKey((k) => k + 1)} />
      </VerlaufKarte>
    );
  }

  if (earnings == null) {
    // V10 · das Skelett reserviert die Höhe des späteren Inhalts (Label + Satz),
    // damit die Fläche beim Eintreffen der Zahl nicht springt.
    return (
      <VerlaufKarte label="Ihre Lastspitze">
        <VerlaufKarteSkeleton chart={false} legende={false} />
      </VerlaufKarte>
    );
  }

  if (peak == null) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="trending-up"
          title="Lastspitzenkappung ist für diese Anlage nicht aktiv"
          description="Lastspitzenkappung lohnt sich für Gewerbe mit Leistungsmessung: Ihre Batterie kappt die Bezugsspitze Ihres Netzanschlusses und senkt so den Leistungspreis. Einrichtung durch VoltPilot – sprechen Sie uns an."
        />
      </Card>
    );
  }

  const hasHistory = peak.history.length > 0;
  const target = plan?.peakTargetKw ?? null;
  const gezeigt = perioden[idx] ?? null;

  // ⚠ Jede Aussage der Fläche kommt aus DIESEN reinen Ableitungen
  //   (`lastspitzenVerlauf.ts`) — der Reiter formuliert nichts selbst.
  const statement = lastspitzeStatement(gezeigt, peak.abrechnung);
  const zeilen = lastspitzeZeilen(gezeigt, peak);
  const verlaufKern = peakVerlaufKernsatz(peak);
  const periodenNote = fahrplanPeriodenNote(gezeigt);
  // Der Insight-Satz des Plans — DIESELBE reine Ableitung, die `ScheduleChart`
  // sonst selbst rendert; im Verlauf-Rahmen trägt ihn der Wirt als
  // Sekundärzeile des Kernsatzes.
  const planKern = fahrplanKern(
    target,
    plan != null ? planInsightParts(plan.slots, new Date()) : null,
  );

  return (
    <>
      {/* V1 · Unsichtbarer Seitenkopf (Paket P1): sein Titel + Lead standen im
          `SUB_PAGES`-Kopf ÜBER den Reitern und schoben sie von 140 auf 287 px. */}
      <VerlaufKopf titel="Lastspitzen" />
      {/* V3 · Der Zeitraum dieses Reiters ist die ABRECHNUNGSPERIODE (§4.4) —
          ein Blätterer, kein Segment. Er liest ausschließlich `peak.history`
          (die letzten zwölf gemessenen Perioden inkl. der laufenden); einen
          Endpunkt für den Beweis einer vergangenen Periode gibt es nicht, es
          entsteht also kein neuer Abruf. */}
      <ZeitLeisteRahmen
        mobil={isPhone}
        zeile1={
          <ZeitBlaetterer
            label={gezeigt?.label ?? 'Laufende Periode'}
            onZurueck={() => setIdx((i) => Math.max(0, i - 1))}
            onVor={() => setIdx((i) => Math.min(perioden.length - 1, i + 1))}
            zurueckDisabled={idx <= 0}
            vorDisabled={idx >= perioden.length - 1}
            jetztLabel="Aktuelle Periode"
            onJetzt={
              idx < perioden.length - 1 ? () => setIdx(perioden.length - 1) : undefined
            }
          />
        }
      />

      {/* KARTE 1 · das STATEMENT (§4.4, Captain-Entscheid E8 = a: „Statement auf
          Marktpreise, Lastspitzen, Wetter"). Die drei `KpiCard`s — Icon-Kachel,
          Wert 24 px, Karte in der Karte — sind entfallen: die EINE Zahl des
          Reiters steht 36/800 auf der Fläche, die zwei anderen sind V5-Zeilen
          mit ihrem Erklärtext als Sekundärzeile (bis P6 ein InfoTip bzw. ein
          `title`, den am Telefon niemand erreichte). */}
      <VerlaufKarte
        label={`Ihre Lastspitze · Abrechnung ${abrechnungLabel(peak.abrechnung)}`}
        provenienz="gemessen"
        chip={
          gezeigt?.laufend && statement.zahl ? (
            <span className="vp-chip">Zwischenstand</span>
          ) : undefined
        }
      >
        {/* ⚠ „—" ist die ehrliche Antwort, nie eine 0 — der Grund steht im
            Satz darunter (§4.4 Sonderzustände). */}
        <p className="vp-c-stm-zahl" title={statement.titel ?? undefined}>
          {statement.zahl ?? '—'}
        </p>
        <p className="vp-c-stm-satz">{statement.satz}</p>
        {zeilen.length > 0 && (
          <VerlaufLedger zeilen={zeilen} label="Beitrag des Speichers in dieser Periode" />
        )}
      </VerlaufKarte>

      {/* KARTE 2 · V6 — Label → Kernsatz → BILD → Chip-Legende → Aufklapper.
          Der 91-px-Untertitel und die Legende standen bis P6 VOR dem Bild und
          schoben die Kurve aus dem ersten Bildschirm. */}
      <VerlaufKarte label="Bezugsspitzen im Verlauf" provenienz="gemessen">
        {hasHistory ? (
          <>
            <ChartHeadline
              kern={{
                wert: null,
                satz: verlaufKern,
                grund: verlaufKern
                  ? null
                  : 'Für die gezeigten Perioden ist noch keine Ersparnis messbar.',
                ton: 'ok',
              }}
            />
            <PeakHistoryChart peak={peak} verlauf />
          </>
        ) : (
          <VerlaufLeer label="Bezugsspitzen im Verlauf" satz={VERLAUF_LEER_SATZ} />
        )}
      </VerlaufKarte>

      {/* KARTE 3 · V6 + V8 + V11. Der Fahrplan ist IMMER der kommende — es gibt
          keinen für eine vergangene Periode. Wer zurückgeblättert hat, bekommt
          das gesagt, statt den Plan stillschweigend der falschen Periode
          zuzuschreiben. */}
      <VerlaufKarte label="Fahrplan & Ziel-Netzbezug" provenienz="geplant">
        {plan == null ? (
          <VerlaufKarteSkeleton legende={false} />
        ) : !hatPlan(plan) ? (
          <VerlaufLeer label="Noch kein Fahrplan" satz={FAHRPLAN_LEER_SATZ} />
        ) : (
          <>
            {/* V11 · der frühere `vp-insight`-Kasten ist die SEKUNDÄRZEILE des
                Kernsatzes (`anker`) — nie eine zweite Fläche in Kategoriefarbe. */}
            <ChartHeadline kern={planKern} />
            <ScheduleChart plan={plan} peakTargetKw={target} verlauf />
            {periodenNote && <p className="vp-c-note">{periodenNote}</p>}
          </>
        )}
      </VerlaufKarte>
      {/* V1 · Der Lead-Satz des früheren Seitenkopfs — wörtlich, am Fuß. */}
      <VerlaufFuss text={LASTSPITZEN_LEAD} />
    </>
  );
}
