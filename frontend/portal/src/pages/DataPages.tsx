import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  ONLINE_WINDOW_MS,
  type ControlStatus,
  type CurtailmentStatus,
  type ConsumerSchedule,
  type SchedulePlan,
  type Site,
  type SiteEarnings,
  type TelemetryPoint,
  type WeatherForecast,
  type ForecastQuality,
} from '../api';
import { mittlereMae } from '../prognose';
import { showTechnicalLayer } from '../rollen';
import { eurAmount, fmtNum } from '../format';
import { isoDate } from '../periodNav';
import { SitePicker } from '../components/SitePicker';
import { VerlaufKopf } from '../components/HistorieWelt';
import { InfoTip } from '../components/InfoTip';
import { ChartSubtitle } from '../components/ChartExplain';
import { einstellungenHash } from '../settingsNav';
import {
  ChartCardSkeleton,
  EmptyState,
  ErrorState,
} from '../components/States';
import { ScheduleChart } from '../ScheduleChart';
import {
  KEIN_LADESTAND_NOTE,
  bankedValueLine,
  horizonHint,
  ladestandHerkunftNote,
  planOhneLadestand,
  planStaleNote,
  savingsTodayEur,
} from '../schedule';
import { consumerLayers, consumerSlotInfos, hasConsumerData } from '../consumerSchedule';
import { FALLBACK_14A_NOTE, FORECAST_FOOTNOTE, phases } from '../fahrplanWhy';
import { FahrplanWhyPanel } from '../components/FahrplanWhy';
import { filmKicker, filmRows, naechsterEinsatz } from '../fahrplanFilm';
import { jetztHeld } from '../fahrplanJetzt';
import { lageView } from '../fahrplanLage';
import { JetztKompakt, JetztWarnungen, TagesFilm } from '../components/FahrplanJetzt';
import { FahrplanLage } from '../components/FahrplanLage';
import { FahrplanTagesbild, TagOhneBildKarte } from '../components/FahrplanTagesbild';
import { minuteDesTages, tagModell } from '../fahrplanTag';
import { indexImLauf, tagDatum, tagesSchalter, tagOhneBild, type TagArt } from '../fahrplanTagesbild';
import { haptik } from '../haptik';
import { speicherAussage } from '../speicherAussage';
import { planAnnahmen } from '../fahrplanAnnahmen';
import { flowConflictCandidate, stepFlowConflict } from '../flowConflict';
import { controlReasonSlot } from '../control';
import { curtailTruth } from '../curtailment';
import { buildSnapshot } from '../live';
import { useFreshnessPoll } from '../useFreshnessPoll';
// LIVE: die Live-Daten-Seite zeigt gemessene Ist-Werte.
import { LIVE_POLL_MS } from '../pollCadence';
import { useIsPhone } from '../useIsPhone';
import { ProvBadge } from '../components/HistorieWelt';
import { TagSegment } from '../components/MarktpreiseMobil';
import { PreisSeite } from './PreisSeite';
import { WetterSeite } from './WetterSeite';

/** Shared frame for the site-scoped data pages (picker + load/error states). */
function useSiteData<T>(
  site: Site | null,
  load: (siteId: string) => Promise<T>,
): { data: T | null; loading: boolean; err: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!site) {
      setData(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    load(site.id)
      .then((d) => active && setData(d))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, reloadKey]);

  return { data, loading, err, reload: () => setReloadKey((k) => k + 1) };
}

function PageFrame({
  title,
  subtitle,
  sites,
  selectedSite,
  onSelectSite,
  embedded = false,
  children,
}: {
  title: string;
  subtitle: string;
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  /**
   * Als REITER einer Anlage gerendert (Navigations-Runde „zwei Ebenen", E3):
   * die Anlage steht dann schon im Pfad der Kopfzeile und der Seitenkopf der
   * Unterseite trägt den Titel — Überschrift und Anlagen-Wähler wären hier
   * eine zweite Kopie davon.
   */
  embedded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {!embedded && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="actions">
            <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
          </div>
        </div>
      )}
      {sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch keine Anlage - legen Sie zuerst unter „Meine Anlage“ eine an.
          </p>
        </Card>
      ) : !sites.some((s) => s.id === selectedSite) ? (
        // Sites exist but the selection hasn't resolved yet: show a loading
        // state, not the "you have no prices/weather" empty copy (m2).
        <Card padding="lg" radius="lg">
          <ChartCardSkeleton />
        </Card>
      ) : (
        children
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * **Der Reiter „Marktpreise"** — seit dem Konzept „Preise und Wetter"
 * (Fassung 3, Entscheide E1–E8 = A vom 20.10.2026) wohnt die Seite in
 * `PreisSeite.tsx`: Antwort zuerst, Jetzt-Linie im Bild, Rückblick im Blatt.
 * Hier bleibt nur der Rahmen der eigenständigen Seite (Anlagen-Wähler).
 */
export function MarktpreisePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  /** Als Reiter des Verlaufs gerendert (E3) — ohne eigenen Seitenkopf. */
  embedded?: boolean;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  return (
    <PageFrame
      title="Marktpreise"
      subtitle={`Börsen-Strompreise${site ? ` - Gebotszone ${site.biddingZone}` : ''}: was Strom jetzt kostet und wann es billiger wird.`}
      {...props}
    >
      {site && <PreisSeite key={site.id} site={site} embedded={props.embedded ?? false} />}
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------

/**
 * **Der Reiter „Wetter"** — seit dem Konzept „Preise und Wetter" (Fassung 3,
 * E5 = A „Wetter zuerst", 20.10.2026) wohnt die Seite in `WetterSeite.tsx`:
 * Wetter jetzt, drei Tage, ein Bild für den gewählten Tag.
 */
export function WetterSection({ site }: { site: Site }) {
  return <WetterSeite site={site} />;
}

// ---------------------------------------------------------------------------

/** Wie weit zurück die Live-Messwerte des Helden geholt werden. */
const LIVE_WINDOW_MS = 15 * 60 * 1000;

/** Wie oft die Tages-Aussage „Was bringt es heute?" neu geholt wird. */
const GELD_TAKT_MS = 5 * 60 * 1000;

/** Wie der Fahrplan entsteht — als Info-Knopf über dem Diagramm bzw. in „Mehr erklären". */
const FAHRPLAN_BERECHNUNG =
  'Der Fahrplan wird für jede Anlage einzeln alle 15 Minuten neu berechnet - ' +
  'für die nächsten 24 Stunden in 15-Minuten-Schritten. Ein Optimierungsmodell ' +
  'plant den Batteriespeicher so, dass Ihre Stromkosten minimal werden: ' +
  'laden bei günstigem Strom oder PV-Überschuss, entladen wenn Strom teuer ist, ' +
  'Eigenverbrauch maximieren. Eingaben je Anlage sind die Börsen-Day-Ahead-Preise, ' +
  'die Last- und PV-Prognose, der aktuelle Ladestand, die Batteriegrenzen und die ' +
  '§14a-Netzgrenze. Weil jede Anlage eigene Eingaben hat, erhält sie ihren eigenen ' +
  'Fahrplan.';

/**
 * Die Fahrplan-Seite einer Anlage (Konzept „Tagesuhr und Bildfahrplan",
 * Entscheide E1–E11 vom 24.09.2026) im AUFBAU DES PROTOTYPS:
 *
 *   0 Tagesschalter    Gestern · Heute · Morgen (E2 = A) direkt unter den
 *                      Reitern; gestern der Tages-Splice des Vortags, morgen
 *                      der jüngste Lauf. Nur heute spricht das Gerät.
 *   1 Warnungen        ein Plan älter als ~2 h, dazu die Warnungen der
 *                      Jetzt-Aussage (K10) und die P7-Hinweise - über dem Bild
 *   2 Tagesbild        `FahrplanTagesbild` trägt alles Weitere selbst: Kopfsatz
 *                      und Stand; am Telefon die Tagesuhr, Werte, Moment-Zeile
 *                      und die Antworten (E1, alle im ersten Bildschirm, E9);
 *                      ab 900 px Inhaltsbreite (E10) das Jetzt-Band und der
 *                      Bildfahrplan; darunter „Warum?", Zustand mit
 *                      „Eingreifen …", die Waage (E5), die Stationen des Tages
 *                      und „Worauf Ihr Plan achtet" (`fahrplanAnnahmen`)
 *   3 „Alle Werte"     das bisherige Diagramm (`ScheduleChart`) als Dialog -
 *                      zum Nachschlagen, kein zweites Bild auf der Seite
 *
 * Die Geldzahl der Seite ist die Antwort „Was bringt es heute?" gegen
 * DENSELBEN Speicher ohne smarte Steuerung (E6, `speicherAussage`) — das
 * Diagramm nennt dann keinen eigenen Betrag gegen „ohne Speicher".
 *
 * Ein Plan OHNE die persistierten Warum-Fakten hat kein Tagesbild (es müsste
 * Tätigkeiten erfinden) und degradiert zur bisherigen Seite: das Diagramm als
 * Held, „Ihr Vorteil", der Film und die Fußnoten in „Mehr erklären".
 *
 * Alle Ableitung ist rein und getestet (`fahrplanTag.ts`, `fahrplanUhr.ts`,
 * `fahrplanBildfahrplan.ts`, `fahrplanAntworten.ts`, `fahrplanWaage.ts`,
 * `fahrplanTagesbild.ts`, `fahrplanAnnahmen.ts`, `fahrplanJetzt.ts`,
 * `fahrplanFilm.ts`, `fahrplanLage.ts`, `fahrplanWhy.ts`, `schedule.ts`) —
 * hier stehen nur das Gerüst und das Holen der Daten.
 */
/**
 * §14.11 slot card: the tapped slot's consumers with Ziel + Grund (the ONE
 * tested reason map) and the Pflicht word + lock icon - never colour alone.
 */
function VerbraucherSlotCard({
  infos,
}: {
  infos: ReturnType<typeof consumerSlotInfos>;
}) {
  if (infos.length === 0) return null;
  return (
    <div className="vp-verbraucher-slotcard" data-testid="verbraucher-slotcard">
      <p className="vp-verbraucher-slotcard-title">Verbraucher in dieser Viertelstunde</p>
      <ul>
        {infos.map((info) => (
          <li key={info.name}>
            <span className="vp-verbraucher-name">{info.name}</span>
            <span className="vp-verbraucher-ziel">{info.ziel}</span>
            {info.pflicht && (
              <span className="vp-verbraucher-pflicht">
                <Icon name="lock" size={13} /> Pflichtfenster
              </span>
            )}
            {info.grund && <span className="vp-verbraucher-grund">{info.grund}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Der Vortag des Tagesschalters, wie er geholt wurde — je Kalendertag. */
interface GesternStand {
  iso: string;
  plan: SchedulePlan | null;
  fehler: boolean;
}

/** Stabile leere Listen (Memo-Abhängigkeiten ändern sich nicht bei jedem Rendern). */
const KEINE_SLOTS: SchedulePlan['slots'] = [];
const KEINE_ANNAHMEN: ReturnType<typeof planAnnahmen> = [];

/**
 * Der Fahrplan-Reiter trägt wie seine Nachbarn Preise und Wetter nur eine
 * unsichtbare `h1` (`VerlaufKopf`, Befund B1): ein sichtbarer Kopf ließ die
 * Reiterleiste springen und nahm am Telefon der Tagesuhr 140 px.
 */

/** Über wie viele Tage die Vorhersage-Zeile des Fahrplans mittelt. */
const VORHERSAGE_TAGE = 7;

/**
 * Die gemessene mittlere Abweichung der AKTIVEN Modelle über die letzten
 * {@link VORHERSAGE_TAGE} bewerteten Tage - dieselbe Rechnung wie die
 * Prognose-Seite (`prognose.mittlereMae`). Ohne Bewertung: null, keine Zeile.
 */
function vorhersageZeile(
  q: ForecastQuality | null,
): { verbrauchKw: number | null; pvKw: number | null; tage: number; fenster: number } | null {
  if (!q) return null;
  const verbrauch = mittlereMae(q.accuracy, q.activeLoadModel, VORHERSAGE_TAGE);
  const pv = mittlereMae(q.accuracy, q.activePvModel, VORHERSAGE_TAGE);
  if (!verbrauch && !pv) return null;
  return {
    verbrauchKw: verbrauch?.mae ?? null,
    pvKw: pv?.mae ?? null,
    tage: Math.max(verbrauch?.tage ?? 0, pv?.tage ?? 0),
    fenster: VORHERSAGE_TAGE,
  };
}

export function FahrplanSection({ site }: { site: Site }) {
  return (
    <>
      <VerlaufKopf titel="Fahrplan" />
      <FahrplanInhalt site={site} />
    </>
  );
}

function FahrplanInhalt({ site }: { site: Site }) {
  const { data: plan, loading, err, reload } = useSiteData<SchedulePlan>(site, (id) => api.schedule(id));
  const [selSlot, setSelSlot] = useState<number | null>(null);
  const [selPhase, setSelPhase] = useState<number | null>(null);
  // Der Held braucht zwei weitere Wahrheiten neben dem Plan: das Rücklesen des
  // Geräts (Ausführung) und die Live-Telemetrie (Messung). Beide werden
  // FAIL-SOFT geholt - fehlt eine, sagt der Held das ehrlich, statt zu raten.
  const [control, setControl] = useState<ControlStatus | null>(null);
  // ... und - seit PR 3 - die Abregel-Wahrheit: setzt die Anlage eine geplante
  // Drosselung überhaupt um? Ein eigener Abruf, weil der Herzschlag-Block
  // unabhängig vom Rücklese-Block kommt; 204/Fehler => null => Plan-Wortlaut.
  const [curtailStatus, setCurtailStatus] = useState<CurtailmentStatus | null>(null);
  const [points, setPoints] = useState<TelemetryPoint[]>([]);
  const [now, setNow] = useState<Date>(() => new Date());
  const [mehrOpen, setMehrOpen] = useState<boolean>(false);
  // Der GANZE Tag für den Film (Tages-Splice, „wie der Tag geplant war") -
  // ebenfalls FAIL-SOFT: eine api ohne diese Lesart antwortet mit 400, dann
  // bleibt der Film exakt bei der Rest-des-Tages-Fassung des jüngsten Laufs.
  const [dayPlan, setDayPlan] = useState<SchedulePlan | null>(null);
  // Verbrauchssteuerung §14.11 (SHADOW): die Verbraucher-Slots des jüngsten
  // Co-Optimizer-Laufs, FAIL-SOFT - eine ältere api / eine nicht geflaggte
  // Anlage liefert nichts, und der Fahrplan bleibt byte-identisch.
  const [consumerPlan, setConsumerPlan] = useState<ConsumerSchedule | null>(null);
  // Erklärbarkeit Stufe 2 „Die Lage": die Wetter-Vorhersage der Anlage, EINMAL
  // je Anlage und FAIL-SOFT geholt. Sie liefert ausschließlich das WORT für
  // morgen (`weatherWhyTomorrow`); jede kWh-Zahl kommt aus den Plan-Eingaben.
  // Ohne sie fehlt der Himmels-Satz, sonst ändert sich nichts.
  const [wetter, setWetter] = useState<WeatherForecast | null>(null);
  // „Anlage – neu gedacht" (E6 = A): die Treffsicherheit der Vorhersagen steht
  // als EINE Zeile in „Worauf Ihr Plan achtet" statt auf einer eigenen Seite.
  // FAIL-SOFT: ohne Bewertung fehlt nur diese Zeile.
  const [vorhersage, setVorhersage] = useState<ForecastQuality | null>(null);

  const siteId = site.id;
  const loadLive = useCallback(() => {
    setNow(new Date());
    api
      .controlStatus(siteId)
      .then((c) => setControl(c))
      .catch(() => undefined);
    api
      .curtailmentStatus(siteId)
      .then((c) => setCurtailStatus(c))
      .catch(() => undefined);
    api
      .telemetry(siteId, new Date(Date.now() - LIVE_WINDOW_MS).toISOString())
      .then((p) => setPoints(p))
      .catch(() => undefined);
  }, [siteId]);

  useEffect(() => {
    setControl(null);
    setCurtailStatus(null);
    setPoints([]);
    loadLive();
  }, [loadLive]);
  useFreshnessPoll(loadLive, LIVE_POLL_MS);

  useEffect(() => {
    let active = true;
    setDayPlan(null);
    api
      .schedule(siteId, 'day')
      .then((p) => active && setDayPlan(p))
      .catch(() => active && setDayPlan(null));
    return () => {
      active = false;
    };
  }, [siteId]);

  useEffect(() => {
    let active = true;
    setConsumerPlan(null);
    try {
      api
        .consumerSchedule(siteId)
        .then((c) => active && setConsumerPlan(c))
        .catch(() => active && setConsumerPlan(null));
    } catch {
      // Fail-soft also against a SYNC throw (an api double without the
      // method): the Fahrplan then stays byte-identical.
    }
    return () => {
      active = false;
    };
  }, [siteId]);

  useEffect(() => {
    let active = true;
    setWetter(null);
    try {
      api
        .weather(siteId)
        .then((w) => active && setWetter(w))
        .catch(() => active && setWetter(null));
    } catch {
      // Dieselbe Fail-soft-Disziplin wie oben: eine api-Attrappe ohne die
      // Methode darf die Seite nicht mitreißen.
    }
    return () => {
      active = false;
    };
  }, [siteId]);

  // ---- Der TAGESSCHALTER (Konzept „Tagesuhr und Bildfahrplan", E2 = A) ----
  // Gestern · Heute · Morgen. Heute bleibt alles wie bisher; morgen kommt aus
  // dem jüngsten Lauf (er trägt den Folgetag, sobald dessen Preise da sind);
  // gestern ist der Tages-Splice des Vortags („wie der Tag geplant war") —
  // erst beim ersten Blick geholt und FAIL-SOFT wie alles hier.
  const isPhone = useIsPhone();
  const [tagArt, setTagArt] = useState<TagArt>('heute');
  const gesternIso = isoDate(tagDatum(now, 'gestern'));
  const [gestern, setGestern] = useState<GesternStand | null>(null);
  const [gesternVersuch, setGesternVersuch] = useState(0);
  const [gesternGeld, setGesternGeld] = useState<SiteEarnings | null>(null);
  useEffect(() => {
    setTagArt('heute');
    setGestern(null);
    setGesternGeld(null);
  }, [siteId]);
  useEffect(() => {
    if (tagArt !== 'gestern') return;
    let active = true;
    setGestern((g: GesternStand | null) => (g?.iso === gesternIso && !g.fehler ? g : null));
    api
      .schedule(siteId, 'day', gesternIso)
      .then((p) => active && setGestern({ iso: gesternIso, plan: p, fehler: false }))
      .catch(() => active && setGestern({ iso: gesternIso, plan: null, fehler: true }));
    // „Was hat es gebracht?": die Aussage des VOLLEN Vortags, dieselbe Quelle
    // wie „Was bringt es heute?" (E6) - ohne Antwort entfällt nur sie.
    try {
      api
        .siteEarnings(siteId, 'day', gesternIso)
        .then((m) => active && setGesternGeld(m))
        .catch(() => active && setGesternGeld(null));
    } catch {
      if (active) setGesternGeld(null);
    }
    return () => {
      active = false;
    };
  }, [tagArt, siteId, gesternIso, gesternVersuch]);
  const waehleTag = (art: TagArt) => {
    if (art === tagArt) return;
    haptik('tick');
    setTagArt(art);
  };

  useEffect(() => {
    let active = true;
    setVorhersage(null);
    try {
      api
        .forecastQuality(siteId, VORHERSAGE_TAGE)
        .then((q) => active && setVorhersage(q))
        .catch(() => active && setVorhersage(null));
    } catch {
      // Eine api-Attrappe ohne die Methode reißt die Seite nicht mit.
    }
    return () => {
      active = false;
    };
  }, [siteId]);

  const slots = plan?.slots ?? [];
  const slotMinutes = plan?.slotMinutes ?? 15;
  // Auf das Slot-Raster DIESES Plans ausgerichtet (Zeitstempel, nie Index);
  // ohne Verbraucher bleibt alles Weitere unverändert.
  const verbraucher = useMemo(
    () => consumerLayers(consumerPlan, (plan?.slots ?? []).map((s) => s.start)),
    [consumerPlan, plan],
  );
  const verbraucherAktiv = hasConsumerData(verbraucher);
  // The why-layer gate: [] unless EVERY slot carries a known role.
  const whyPhases = useMemo(() => phases(slots, slotMinutes), [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasWhy = whyPhases.length > 0;
  // Null (never a fabricated 0,00 €) when today carries no priced plan slot -
  // e.g. the newest run is yesterday's (audit F1).
  const savingsToday = savingsTodayEur(slots, now);
  // P7: der Lauf hatte keinen Ladestand, also wurde der Speicher gar nicht
  // geplant. Ohne diesen Schalter läse der Kunde denselben Zustand als
  // Defekt - lauter 0-kW-Balken, keine Ladestandslinie, keine Ersparnis.
  const ohneLadestand = planOhneLadestand(plan);
  // Vorbereitet für den generischen SoC-Baustein: ein BERECHNETER Ladestand
  // darf planen, muss sich aber als berechnet zu erkennen geben. Heute null.
  const herkunftNote = ladestandHerkunftNote(plan);
  // Honest freshness banner: the newest run is stale.
  const staleNote = planStaleNote(plan?.generatedAt, slots, now, slotMinutes);
  // Energy = mean power over each slot × slot length in hours. Derive slots-per-
  // hour from the plan's authoritative slotMinutes instead of hardcoding /4, so
  // a non-15-min slot length stays correct.
  const slotsPerHour = plan && plan.slotMinutes > 0 ? 60 / plan.slotMinutes : 4;
  const chargeKwh = slots.reduce((sum, s) => sum + Math.max(s.batteryKw ?? 0, 0), 0) / slotsPerHour;
  const dischargeKwh =
    slots.reduce((sum, s) => sum + Math.max(-(s.batteryKw ?? 0), 0), 0) / slotsPerHour;
  const generatedAt = plan?.generatedAt
    ? new Date(plan.generatedAt).toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  // FK2: banked terminal value + horizon-edge hint (pure derivations).
  const banked = bankedValueLine(plan?.bankedValueEur);
  const horizonNote = horizonHint(slots, now, slotMinutes);
  // Die „Lage"-Zeile (Erklärbarkeit Stufe 2): Tages-Bogen + Morgen-Ausblick aus
  // den Eingaben DIESES Laufs. Sie liest die Slots des jüngsten Laufs (nicht
  // den Tages-Splice - der ist aus vielen Läufen genäht und trägt deshalb weder
  // einen Anker noch eine Prognose, die zu EINEM Lauf gehört) und liefert null,
  // sobald es nichts Belegtes zu sagen gibt; dann rendert die Karte gar nicht.
  const lage = useMemo(
    () => lageView({ slots, slotMinutes, plan, weather: wetter?.points, now }),
    [slots, slotMinutes, plan, wetter, now],
  );

  // Block 2 - der GANZE Tag, wenn der Splice ihn trägt. Die Warum-Ebene ist
  // per Konstruktion alles-oder-nichts (`phases()` liefert [] sobald EIN Slot
  // keine Rolle trägt), also ist eine nicht-leere Phasenliste zugleich der
  // Fail-soft-Schalter: ohne sie (ältere api, Splice ohne Warum-Spalten) rendert
  // der Film zeichengleich den jüngsten Lauf, also den Rest des Tages.
  const daySlots = dayPlan?.slots ?? [];
  const dayPhases = useMemo(() => phases(daySlots, slotMinutes), [dayPlan, slotMinutes]); // eslint-disable-line react-hooks/exhaustive-deps
  const wholeDay = dayPhases.length > 0;
  const filmSlots = wholeDay ? daySlots : slots;
  const filmPhases = wholeDay ? dayPhases : whyPhases;
  const hasFilm = filmPhases.length > 0;
  // Der Ausblick des Helden liest dieselbe Ableitung - eine Quelle, zwei
  // Verbraucher.
  const film = useMemo(
    () => filmRows(filmPhases, filmSlots, site.plantKind, now),
    [filmPhases, filmSlots, site.plantKind, now],
  );
  // Block 1 - die drei Wahrheiten im Jetzt.
  const snapshot = useMemo(() => buildSnapshot(points), [points]);
  const newestTs = points.length > 0 ? points[points.length - 1].ts : null;
  const snapshotFresh =
    newestTs != null && now.getTime() - new Date(newestTs).getTime() <= ONLINE_WINDOW_MS;
  // Flussabgleich (Scout `vp-verkauf-praemisse-s8` §3): der Entprellungs-Zähler,
  // EINE Beobachtung je Poll, verankert am Rücklese-Zeitpunkt des Geräts
  // (`checkedAt` ist je Herzschlag neu). So kann ein einzelner Messversatz
  // zwischen Speicher-, Haus- und Netzzähler keinen Alarm gebären. Der aktuelle
  // Befund liegt in einer Ref, damit der Effekt nur je NEUER Beobachtung faltet.
  const hasConflictCandidate =
    flowConflictCandidate({
      commandedKw: control?.commandedKw,
      snapshot,
      snapshotFresh,
      executionMode: control?.executionMode,
      maxFeedInKw: site.maxFeedInKw,
    }) != null;
  const [conflictStreak, setConflictStreak] = useState(0);
  const conflictCandRef = useRef(hasConflictCandidate);
  conflictCandRef.current = hasConflictCandidate;
  const conflictObs = control?.checkedAt ?? null;
  useEffect(() => {
    if (conflictObs == null) return;
    setConflictStreak((s) => stepFlowConflict(s, conflictCandRef.current));
  }, [conflictObs]);
  // Die Beleg-Lage der Abregelung, EINMAL abgeleitet und an alle drei Flächen
  // gereicht (Held, Slot-Panel, Phasen-Panel) - so können sie sich nicht
  // widersprechen. Sie gilt nur für den laufenden Slot: die Panels filtern
  // darauf über den Index (`curtailTruthForSlot`).
  const curtail = useMemo(() => curtailTruth(curtailStatus, now), [curtailStatus, now]);
  // Erklärbarkeit Stufe 3 „Grenzen als Gründe": die Fakten, die NICHT in der
  // Viertelstunde stehen - die gepflegte Einspeisegrenze der Anlage und der
  // s0-Block der Box (Einspeisewächter + die Grenze IM GERÄT). Beide optional;
  // ohne sie nennt der Abregel-Satz seine Ursache ohne Zahl und der
  // Grenzen-Block bleibt aus.
  const grenzen = useMemo(
    () => ({ maxFeedInKw: site.maxFeedInKw, curtailment: curtailStatus }),
    [site.maxFeedInKw, curtailStatus],
  );
  const activeSlot = controlReasonSlot(slots, now, slotMinutes);
  // `controlReasonSlot` liefert ein Element DIESES Arrays zurück, `indexOf` ist
  // also exakt - und es gibt keine zweite „welcher Slot läuft"-Regel.
  const activeSlotIdx = activeSlot ? slots.indexOf(activeSlot) : -1;
  const activeFilmSlot = controlReasonSlot(filmSlots, now, slotMinutes);
  const activeFilmIdx = activeFilmSlot ? filmSlots.indexOf(activeFilmSlot) : -1;
  const held = useMemo(
    () =>
      jetztHeld({
        slot: controlReasonSlot(slots, now, slotMinutes),
        slots,
        // Die LAUF-Fakten des jüngsten Laufs (Erklärbarkeit Stufe 1): der
        // Held liest denselben Plan, den das Gerät gerade ausführt.
        planFacts: plan,
        control,
        // Steuerbar ist die Anlage genau dann, wenn der Plan ein Gerät hat -
        // dieselbe Regel wie auf dem Cockpit (`batteryLinked`).
        expectControl: plan?.deviceId != null,
        snapshot,
        snapshotFresh,
        planStale: staleNote != null,
        nextPhase: naechsterEinsatz(film),
        curtail,
        maxFeedInKw: site.maxFeedInKw,
        conflictStreak,
        plantKind: site.plantKind,
        now,
      }),
    [
      slots,
      slotMinutes,
      control,
      curtail,
      plan,
      plan?.deviceId,
      snapshot,
      snapshotFresh,
      staleNote,
      film,
      site.plantKind,
      site.maxFeedInKw,
      conflictStreak,
      now,
    ],
  );

  // ---- Das Tagesbild (Konzept „Tagesuhr und Bildfahrplan", E1–E11) ----
  // EIN Tagesmodell für Uhr und Bildfahrplan, aus derselben Liste wie der Film
  // (Tages-Splice, sonst der jüngste Lauf). Ohne vollständige Warum-Ebene gibt
  // es kein Tagesbild - dann bleibt die Seite beim bisherigen Diagramm.
  // Im Bild steht der Preis, der den Plan treibt (`bildPreisArt`): ändert sich
  // der Bezugspreis über den Tag, er; ist er flach, bei Direktvermarktung die
  // Börse, sonst keiner (ein flacher Preis erklärt nichts, vgl. D1).
  const tagHeute = useMemo(
    () => tagModell({ slots: filmSlots, slotMinutes, now, plantKind: site.plantKind, tarifArt: site.tarifArt ?? null }),
    [filmSlots, slotMinutes, now, site.plantKind, site.tarifArt],
  );
  // Der AUFBAU der Seite hängt an heute: ohne Warum-Ebene heute gibt es kein
  // Tagesbild und damit auch keinen Tagesschalter.
  const hasTagesbild = tagHeute.hatWarum && tagHeute.slots.length > 0;
  const morgenMs = tagDatum(now, 'morgen').getTime();
  const tagMorgen = useMemo(
    () =>
      tagModell({
        slots,
        slotMinutes,
        now,
        plantKind: site.plantKind,
        tarifArt: site.tarifArt ?? null,
        tag: new Date(morgenMs),
      }),
    [slots, slotMinutes, now, site.plantKind, site.tarifArt, morgenMs],
  );
  const morgenGeplant = tagMorgen.hatWarum && tagMorgen.slots.length > 0;
  const gesternSlots = gestern?.iso === gesternIso ? (gestern.plan?.slots ?? KEINE_SLOTS) : KEINE_SLOTS;
  const tagGestern = useMemo(
    () =>
      tagModell({
        slots: gesternSlots,
        slotMinutes,
        now,
        plantKind: site.plantKind,
        tarifArt: site.tarifArt ?? null,
        tag: tagDatum(now, 'gestern'),
      }),
    [gesternSlots, slotMinutes, now, site.plantKind, site.tarifArt],
  );
  const gesternPhasen = useMemo(() => phases(gesternSlots, slotMinutes), [gesternSlots, slotMinutes]);
  const tag = tagArt === 'gestern' ? tagGestern : tagArt === 'morgen' ? tagMorgen : tagHeute;
  const tagHatBild = tag.hatWarum && tag.slots.length > 0;
  // „Was bringt es heute?" (E6): die Steuerungs-Aussage der Erlöse-Welt aus
  // `GET /sites/{id}/earnings?range=day`, FAIL-SOFT wie Wetter und Verbraucher
  // (auch gegen eine api-Attrappe ohne die Methode) - ohne Antwort entfällt
  // nur diese eine Antwort. Der laufende Tag ist ein Zwischenstand; er wird
  // alle fünf Minuten neu geholt, nicht bei jedem Live-Takt.
  const [tagesGeld, setTagesGeld] = useState<SiteEarnings | null>(null);
  const heuteIso = isoDate(now);
  const geldTakt = Math.floor(now.getTime() / GELD_TAKT_MS);
  // Eine andere Anlage oder ein neuer Tag: die alte Aussage gilt nicht mehr.
  // Die Auffrischung alle fünf Minuten leert dagegen nicht (kein Flackern).
  useEffect(() => {
    setTagesGeld(null);
  }, [siteId, heuteIso]);
  useEffect(() => {
    if (!hasTagesbild) return;
    let active = true;
    try {
      api
        .siteEarnings(siteId, 'day', heuteIso)
        .then((m) => active && setTagesGeld(m))
        .catch(() => active && setTagesGeld(null));
    } catch {
      if (active) setTagesGeld(null);
    }
    return () => {
      active = false;
    };
  }, [siteId, heuteIso, geldTakt, hasTagesbild]);
  const speicher = useMemo(
    () => (tagesGeld ? speicherAussage(tagesGeld, { now }) : null),
    [tagesGeld, now],
  );
  const speicherGestern = useMemo(
    () => (gesternGeld ? speicherAussage(gesternGeld, { now }) : null),
    [gesternGeld, now],
  );
  // „Alle Werte": das bisherige Diagramm als Dialog - zum Nachschlagen, nicht
  // als zweites Bild desselben Tages auf der Seite.
  const [alleWerteOpen, setAlleWerteOpen] = useState<boolean>(false);
  // „Worauf Ihr Plan achtet": gepflegte Werte der Anlage und Felder des Laufs,
  // dazu die Hinweise, die früher in „Mehr erklären" standen.
  const annahmen = useMemo(
    () =>
      planAnnahmen({
        planVon: plan?.generatedAt ? new Date(plan.generatedAt) : null,
        slotMinutes,
        plantKind: site.plantKind,
        tarifArt: site.tarifArt ?? null,
        tarifParamCtKwh: site.tarifParamCtKwh ?? null,
        netzladenErlaubt: site.netzladenErlaubt ?? null,
        untergrenzePct: plan?.effectiveFloorSocPct ?? null,
        einspeisegrenzeKw: site.maxFeedInKw ?? null,
        lastspitzeZielKw: plan?.peakTargetKw ?? null,
        fallback14a: hasWhy && plan?.fallback14a === true,
        lage,
        horizont: horizonNote,
        vorhersage: vorhersageZeile(vorhersage),
        prognoseSeite: showTechnicalLayer() ? `#/anlage/${site.id}/prognose` : null,
      }),
    [plan, slotMinutes, site.id, site.plantKind, site.tarifArt, site.tarifParamCtKwh, site.netzladenErlaubt, site.maxFeedInKw, hasWhy, lage, horizonNote, vorhersage],
  );
  const planVon = plan?.generatedAt
    ? new Date(plan.generatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : null;
  // Das Warum einer Viertelstunde des Tagesbilds liest den JÜNGSTEN Lauf, wenn
  // er sie trägt (dieselben Zahlen wie das Gerät, mit den Lauf-Fakten), sonst
  // den Tages-Splice, der sie damals geplant hat.
  const tagesSlotImLauf = (i: number) => {
    const s = tag.slots[i];
    return s && hasWhy ? indexImLauf(s.start, slots) : -1;
  };
  const slotFuerWarum = (i: number) => {
    const li = tagesSlotImLauf(i);
    return li >= 0 ? slots[li] : (tag.slots[i] ?? null);
  };
  const warumPanel = (i: number, schliessen: () => void) => {
    const li = tagesSlotImLauf(i);
    if (li >= 0) {
      return (
        <FahrplanWhyPanel
          phases={whyPhases}
          slots={slots}
          plantKind={site.plantKind}
          slotMinutes={slotMinutes}
          selectedPhase={null}
          selectedSlot={li}
          curtail={curtail}
          planFacts={plan}
          grenzen={grenzen}
          siteId={site.id}
          currentSlotIndex={activeSlotIdx}
          ohneGeld
          onClose={schliessen}
        />
      );
    }
    // Nicht im jüngsten Lauf: der Splice, der die Viertelstunde geplant hat -
    // heute der des Tages, gestern der des Vortags.
    const s = tag.slots[i];
    const quelle = tagArt === 'gestern' ? gesternSlots : filmSlots;
    const fi = s ? indexImLauf(s.start, quelle) : -1;
    if (fi < 0) return null;
    return (
      <FahrplanWhyPanel
        phases={tagArt === 'gestern' ? gesternPhasen : filmPhases}
        slots={quelle}
        plantKind={site.plantKind}
        slotMinutes={slotMinutes}
        selectedPhase={null}
        selectedSlot={fi}
        curtail={curtail}
        grenzen={grenzen}
        siteId={site.id}
        currentSlotIndex={tagArt === 'heute' ? activeFilmIdx : -1}
        ohneGeld
        onClose={schliessen}
      />
    );
  };

  const closePanel = () => {
    setSelPhase(null);
    setSelSlot(null);
  };
  // ZWEI Panels, weil zwei Listen: die Filmzeile zeigt auf die Phasen des
  // GANZEN Tages, die angetippte Viertelstunde im Diagramm auf die Slots des
  // jüngsten Laufs. Ein geteiltes Panel würde bei aktivem Splice in die
  // falsche Liste greifen.
  const phasePanel = hasFilm ? (
    <FahrplanWhyPanel
      phases={filmPhases}
      slots={filmSlots}
      plantKind={site.plantKind}
      slotMinutes={slotMinutes}
      selectedPhase={selPhase}
      selectedSlot={null}
      curtail={curtail}
      grenzen={grenzen}
      siteId={site.id}
      currentSlotIndex={activeFilmIdx}
      ohneGeld={hasTagesbild}
      onClose={closePanel}
    />
  ) : null;
  const slotPanel = hasWhy ? (
    <FahrplanWhyPanel
      phases={whyPhases}
      slots={slots}
      plantKind={site.plantKind}
      slotMinutes={slotMinutes}
      selectedPhase={null}
      selectedSlot={selSlot}
      curtail={curtail}
      planFacts={plan}
      grenzen={grenzen}
      siteId={site.id}
      currentSlotIndex={activeSlotIdx}
      ohneGeld={hasTagesbild}
      onClose={closePanel}
    />
  ) : null;

  // `plan === null` bis der erste Abruf zurück ist: sonst blitzte für einen
  // Frame „Noch kein Fahrplan" auf, bevor der Ladezustand greift.
  if (loading || (plan == null && err == null)) {
    return (
      <Card padding="lg" radius="lg">
        <ChartCardSkeleton stats={0} />
      </Card>
    );
  }
  if (err) {
    return (
      <ErrorState message={`Der Fahrplan konnte nicht geladen werden (${err}).`} onRetry={reload} />
    );
  }
  if (slots.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="battery-charging"
          category="battery"
          title="Noch kein Fahrplan"
          description="Sobald Ihre Anlage einen Batteriespeicher meldet und Börsenpreise vorliegen, plant VoltPilot alle 15 Minuten einen kostenoptimalen Tagesfahrplan - er erscheint dann automatisch hier."
        />
      </Card>
    );
  }

  const staleBlock = staleNote ? (
    <div className="vp-alert vp-alert-warn" role="status" style={{ margin: '0 0 var(--vp-space-4)' }}>
      {staleNote}
    </div>
  ) : null;

  // Die Diagramm-Karte der bisherigen Seite: ohne Warum-Ebene der Held, mit
  // Tagesbild der Inhalt von „Alle Werte" (dann ohne eigene Geldzahl - die
  // Seite nennt sie in der Antwort „Was bringt es heute?", Messlatte E6).
  const diagramm = (
    <>
      <ScheduleChart
        plan={plan!}
        showPhaseBand
        onSlotClick={
          hasWhy
            ? (i) => {
                setSelSlot((cur) => (cur === i ? null : i));
                setSelPhase(null);
              }
            : undefined
        }
        selectedIndex={hasWhy ? selSlot : undefined}
        consumers={verbraucherAktiv ? verbraucher : undefined}
        plantKind={site.plantKind}
        // Der Zielwert der Lastspitzen-Kappung gehört zum Plan, den er
        // begrenzt (Verlauf-Rework E1) — ohne Modul bleibt er null, nie 0.
        peakTargetKw={plan?.peakTargetKw ?? null}
        ohneGeld={hasTagesbild}
      />
      {selSlot != null && slotPanel}
      {/* §14.11: die Verbraucher des angetippten Slots - Ziel + Grund aus
          der EINEN getesteten reason_code-Tabelle, Pflicht als Wort +
          Schloss-Icon, nie nur Farbe. Ohne Verbraucher rendert nichts. */}
      {selSlot != null && verbraucherAktiv && (
        <VerbraucherSlotCard infos={consumerSlotInfos(verbraucher, selSlot)} />
      )}
    </>
  );

  const fahrplanKopf = (
    <div className="vp-jetzt-kick">
      <span className="vp-card-label">Der Fahrplan Ihres Speichers</span>
      <InfoTip title="Wie der Fahrplan berechnet wird">{FAHRPLAN_BERECHNUNG}</InfoTip>
    </div>
  );

  // P7: direkt über dem Bild, weil genau dort die leeren Speicher-Balken bzw.
  // die fehlende Ladestandsfläche stehen.
  const ladestandHinweise = (
    <>
      {ohneLadestand && (
        <div className="vp-alert vp-alert-warn" role="status" style={{ margin: '0 0 var(--vp-space-4)' }}>
          {KEIN_LADESTAND_NOTE}
        </div>
      )}
      {herkunftNote && (
        <p className="vp-note" style={{ margin: '0 0 var(--vp-space-3)' }}>{herkunftNote}</p>
      )}
    </>
  );

  // Der Film des Tages (F3) - mit Tagesbild die STATIONEN unter den
  // Antworten, sonst in „Mehr erklären".
  const stationen = hasFilm ? (
    <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
      <div className="vp-jetzt-kick">
        {/* „Der ganze Tag", sobald der Splice die Vormittags-Phasen trägt -
            sonst die bisherige Beschriftung. EIN Abzeichen für die ganze
            Karte: hier stehen nur geplante Zahlen, auch in der Vergangenheit. */}
        <span className="vp-card-label">{filmKicker(film)}</span>
        <ProvBadge art="geplant" />
      </div>
      <TagesFilm
        view={film}
        selected={selPhase}
        onSelect={(i) => {
          setSelPhase((cur) => (cur === i ? null : i));
          setSelSlot(null);
        }}
        panel={selPhase != null ? phasePanel : null}
        ohneGeld={hasTagesbild}
      />
      <p className="vp-note" style={{ margin: 'var(--vp-space-3) 0 0' }}>
        Phase antippen: warum der Speicher das tut, mit den Zahlen dahinter.
        Was heute wirklich passiert ist, steht unter{' '}
        <a href={`#/anlage/${site.id}/messwerte`}>Messwerte</a>.
      </p>
    </Card>
  ) : null;

  return (
    <>
      {/* ---- Block 1: die Status-Zeile (kompakt) ---- Mit Tagesbild steht sie
          unter den Antworten, sobald der Zeiger auf „jetzt" steht (E1/E9: die
          Uhr ganz oben, alle Antworten im ersten Bildschirm). */}
      {!hasTagesbild && <JetztKompakt view={held} />}

      {/* ---- Block 2: Warnungen ---- Ein Plan älter als ~2 h ist nicht der Plan
          von heute; das steht ganz oben, nie kondensiert. Mit Tagesbild unter
          dem Tagesschalter - und nur für heute und morgen (beide kommen aus
          diesem Lauf; gestern ist der Plan, wie er damals galt). */}
      {!hasTagesbild && staleBlock}

      {hasTagesbild ? (
        <>
          {/* ---- Der TAGESSCHALTER (E2 = A) ---- direkt unter den Reitern, in
              der Form des Tag-Segments der Preise: EIN Muster im Bereich. */}
          <div className="vp-tb-tage">
            <TagSegment
              wahl={tagesSchalter(now, morgenGeplant)}
              wert={tagArt}
              onWert={waehleTag}
              voll={isPhone}
            />
          </div>
          {tagArt !== 'gestern' && staleBlock}
          {/* ---- Block 3: das TAGESBILD im Aufbau des Prototyps (E1/E10) ----
              Warnungen der Jetzt-Aussage stehen ÜBER dem Bild (K10) - sie
              gelten nur heute. Das Tagesbild trägt Kopfsatz, Jetzt-Band bzw.
              Uhr, Antworten, Waage, Stationen und „Worauf Ihr Plan achtet". */}
          {tagArt === 'heute' && <JetztWarnungen view={held} />}
          {tagArt !== 'gestern' && ladestandHinweise}
          {tagHatBild ? (
            <FahrplanTagesbild
              tag={tag}
              plantKind={site.plantKind}
              speicher={tagArt === 'heute' ? speicher : tagArt === 'gestern' ? speicherGestern : null}
              siteId={site.id}
              slotFuerWarum={slotFuerWarum}
              warumPanel={warumPanel}
              phasenPanel={(phaseIndex, schliessen) => (
                <FahrplanWhyPanel
                  phases={tag.phasenRoh}
                  slots={tag.slots}
                  plantKind={site.plantKind}
                  slotMinutes={slotMinutes}
                  selectedPhase={phaseIndex}
                  selectedSlot={null}
                  curtail={curtail}
                  grenzen={grenzen}
                  siteId={site.id}
                  currentSlotIndex={tag.jetztIndex}
                  ohneGeld
                  onClose={schliessen}
                />
              )}
              nachtragHref={einstellungenHash(site.id, 'speicher')}
              // Die Ausführung spricht nur über jetzt; „Plan von …", die
              // Annahmen und „Alle Werte" beschreiben den jüngsten Lauf - er
              // trägt heute und morgen, nicht gestern.
              held={tagArt === 'heute' ? held : null}
              planVon={tagArt === 'gestern' ? null : planVon}
              annahmen={tagArt === 'gestern' ? KEINE_ANNAHMEN : annahmen}
              berechnung={FAHRPLAN_BERECHNUNG}
              onAlleWerte={tagArt === 'gestern' ? null : () => setAlleWerteOpen(true)}
              morgen={tagArt === 'heute' ? film.tomorrowSummary : null}
              art={tagArt}
              zeigerStart={tagArt === 'heute' ? null : minuteDesTages(now)}
              autoEinfuehrung={tagArt === 'heute'}
            />
          ) : (
            <TagOhneBildKarte
              zustand={
                tagOhneBild(
                  tagArt,
                  gestern?.iso === gesternIso ? { laedt: false, fehler: gestern.fehler } : { laedt: true, fehler: false },
                  now,
                ) ?? { titel: '', text: null, laedt: false, erneut: false, mitMesswerte: false }
              }
              siteId={site.id}
              onErneut={() => setGesternVersuch((v) => v + 1)}
            />
          )}

          {/* ---- „Alle Werte" ---- das bisherige Diagramm mit allen Spuren als
              Dialog zum Nachschlagen. Es entsteht ERST beim Öffnen: ein
              ECharts-Canvas in einem geschlossenen Kasten misst 0 × 0. */}
          <Modal
            open={alleWerteOpen}
            onClose={() => setAlleWerteOpen(false)}
            title={verbraucherAktiv ? 'Alle Werte im Diagramm, mit Verbrauchern' : 'Alle Werte im Diagramm'}
          >
            {alleWerteOpen && (
              <>
                <ChartSubtitle>
                  Oben der Preis, unten Ihr Speicher, darunter das Phasen-Band -
                  tippen Sie eine Spalte fürs Warum.
                </ChartSubtitle>
                {diagramm}
                {/* Die Energiesummen sind Diagramm-KONTEXT, kein Seiten-Einstieg. */}
                <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                  Über den ganzen Planungszeitraum: {fmtNum(chargeKwh, 'kWh')} geplantes Laden,{' '}
                  {fmtNum(dischargeKwh, 'kWh')} geplantes Entladen.
                </p>
                <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                  Kostenoptimaler Batterie-Fahrplan in 15-Minuten-Schritten aus Börsenpreisen
                  und Last-/PV-Prognose{generatedAt ? `, erstellt am ${generatedAt} Uhr` : ''}.
                  Ihr Gerät begrenzt jeden Sollwert zusätzlich lokal (u. a. §14a EnWG).
                </p>
              </>
            )}
          </Modal>
        </>
      ) : (
        /* ---- Ohne Warum-Ebene: das Diagramm als HELD (Variante A+C) ----
           Desktop UND Mobil offen, mit dem Phasen-Band als dritter Spur. */
        <Card padding="lg" radius="lg" style={{ marginBottom: 'var(--vp-space-4)' }}>
          {fahrplanKopf}
          <ChartSubtitle>
            Oben der Preis, unten Ihr Speicher, darunter das Phasen-Band -
            tippen Sie eine Spalte fürs Warum.
          </ChartSubtitle>
          {/* Die Lage-Zeile - V-02 (UX-Review 24.09.2026): als ruhige Zeile
              IN der Diagramm-Karte; die volle Lage wohnt in „Mehr erklären". */}
          {lage && <FahrplanLage view={lage} variant="zeile" />}
          {ladestandHinweise}
          {diagramm}
        </Card>
      )}

      {/* ---- „Mehr erklären" (Standard ZU) ---- NUR ohne Tagesbild: die volle
          Lage, „Ihr Vorteil", der Film und alle Fußnoten. Mit Tagesbild stehen
          Lage und Hinweise in „Worauf Ihr Plan achtet", das Diagramm unter
          „Alle Werte" - eine zweite Fassung darunter wäre doppelt. */}
      {!hasTagesbild && (
      <Card padding="lg" radius="lg">
        <div className="vp-fp-fold-head">
          <button
            type="button"
            className={`vp-fp-fold-toggle${mehrOpen ? ' is-open' : ''}`}
            aria-expanded={mehrOpen}
            onClick={() => setMehrOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={18} />
            Mehr erklären
          </button>
        </div>

        {mehrOpen && (
          <>
            {/* ---- Ihr Vorteil ---- nur OHNE Tagesbild (der Aufklapper steht
                nur dort): mit Tagesbild ist die Geldzahl der Seite die Antwort
                „Was bringt es heute?" gegen DENSELBEN Speicher ohne smarte
                Steuerung (E6). Eine zweite Zahl gegen „ohne Speicher" wäre
                eine zweite Wahrheit. */}
            {(
              <section className="vp-fp-vorteil" aria-label="Ihr Vorteil">
                <div className="vp-jetzt-kick">
                  <span className="vp-card-label">Ihr Vorteil</span>
                  <ProvBadge art="geplant" />
                </div>
                {ohneLadestand ? (
                  /* P7: „kein Fahrplan" wäre hier falsch - es GIBT einen Fahrplan, er
                     plant nur den Speicher nicht. Der Grund steht an der Stelle, an der
                     sonst die Euro-Zahl stünde, damit die fehlende Zahl erklärt ist und
                     nicht als Fehler gelesen wird. */
                  <p className="vp-note" style={{ margin: 0 }}>{KEIN_LADESTAND_NOTE}</p>
                ) : savingsToday == null ? (
                  <p className="vp-note" style={{ margin: 0 }}>
                    Für heute liegt noch kein Fahrplan vor.
                  </p>
                ) : (
                  <p className="vp-fp-euro">
                    {/* Sign-honest wie überall im Portal: ein Plus wird ausgeschrieben,
                        ein Minus trägt sein eigenes Zeichen (`eurAmount`). */}
                    <b>
                      Heute geplant:{' '}
                      {savingsToday > 0 ? `+${eurAmount(savingsToday)}` : eurAmount(savingsToday)}
                    </b>
                    <span className="sub">
                      gegenüber einem Betrieb ohne Speicher
                      <InfoTip title="Wie diese Zahl zu lesen ist">
                        Verglichen wird mit einem Betrieb ganz ohne Batteriespeicher.
                        Energie, die der Fahrplan über den Tag hinaus im Speicher lässt,
                        ist hier noch nicht mitgezählt: sie wird mit ihrem erwarteten
                        Nutzen am Folgetag bewertet und als eigene Zeile ausgewiesen. An
                        Tagen, an denen viel Energie für den Folgetag gespeichert wird,
                        kann die Zahl deshalb klein oder sogar negativ sein – der
                        gespeicherte Wert kommt morgen zurück.
                      </InfoTip>
                    </span>
                  </p>
                )}
                {banked && <p className="vp-fp-euro-note">{banked}</p>}
              </section>
            )}

            {/* Die vollständige Lage heute & morgen (Bedingung + Quelle). */}
            {lage && <FahrplanLage view={lage} variant="voll" />}

            {/* Der Film des Tages - ohne Tagesbild hier, sonst als Stationen im Tagesbild. */}
            {stationen}

            {/* Die Diagramm-Fußnoten. */}
            {/* Die Energiesummen sind Diagramm-KONTEXT, kein Seiten-Einstieg. */}
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
              Über den ganzen Planungszeitraum: {fmtNum(chargeKwh, 'kWh')} geplantes Laden,{' '}
              {fmtNum(dischargeKwh, 'kWh')} geplantes Entladen.
            </p>
            {/* F6: the per-slot explanation ("Warum") only exists for plans a
                current optimizer wrote - the columns fill forward, never
                backwards. Say it in one line so its absence does not read as a
                missing feature (and never fabricate a reason). */}
            {!hasWhy && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                Die Begründung je Viertelstunde erscheint mit dem nächsten Planungslauf.
              </p>
            )}
            {/* Fallback-build honesty: the §14a limit could not be fully
                scheduled - the device enforces it additionally. */}
            {hasWhy && plan?.fallback14a === true && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                {FALLBACK_14A_NOTE}
              </p>
            )}
            {/* Horizon-edge honesty (FK2): the morning plan legitimately ends at
                midnight until tomorrow's prices publish - say so, calmly. */}
            {horizonNote && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>{horizonNote}</p>
            )}
            {/* Forecast honesty (why-layer): the plan rests on forecasts. */}
            {hasWhy && (
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-3)' }}>
                {FORECAST_FOOTNOTE} <a href="#/prognose">Zur Prognosequalität →</a>
              </p>
            )}
            <p className="vp-note" style={{ marginTop: 'var(--vp-space-4)' }}>
              Kostenoptimaler Batterie-Fahrplan in 15-Minuten-Schritten aus Börsenpreisen
              und Last-/PV-Prognose{generatedAt ? `, erstellt am ${generatedAt} Uhr` : ''}.
              Ihr Gerät begrenzt jeden Sollwert zusätzlich lokal (u. a. §14a EnWG).
            </p>
          </>
        )}
      </Card>
      )}
    </>
  );
}
