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
  type HistoryRange,
  type PriceHistory,
  type ConsumerSchedule,
  type SchedulePlan,
  type ScheduleSlot,
  type Site,
  type SiteEarnings,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import { eurAmount, fmtNum } from '../format';
import { isoDate, PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { SitePicker } from '../components/SitePicker';
import {
  VerlaufFuss,
  VerlaufKopf,
  ZeitBlaetterer,
  ZeitLeisteRahmen,
  ZeitSegment,
} from '../components/HistorieWelt';
import { historieHash } from '../historieWelten';
import { parseVerlaufParams } from '../verlauf';
import { ankerAusWert } from '../historieZeit';
import { replaceCurrentNavigation } from '../navigationBlocker';
import { InfoTip } from '../components/InfoTip';
import { ChartHeadline, ChartSubtitle } from '../components/ChartExplain';
import {
  ChartCardSkeleton,
  EmptyState,
  ErrorState,
  VerlaufFehler,
  VerlaufKarteSkeleton,
  VerlaufLeer,
} from '../components/States';
import { PriceHistoryChart } from '../PriceHistoryChart';
import { WeatherChart } from '../WeatherChart';
import { erwarteteLeistung } from '../wetterLeistung';
import { vorhersageLabel, wetterStatement, wetterZeilen } from '../wetterKarte';
import { VerlaufLedger, type VerlaufLedgerZeile } from '../components/VerlaufLedger';
import { einstellungenHash } from '../settingsNav';
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
import {
  bezugspreisNote,
  fokusFenster,
  jetztPreis,
  preisZeilen,
  profiZeilen,
  tagWahl,
  type PreisZeile,
  type TagFokus,
} from '../marktpreise';
import { ctReihe, fensterZeilen, preisFenster, preisKern } from '../preisFenster';
import {
  MarktStatement,
  PreisZeilen,
  ProfiZahlen,
  TagSegment,
  WegZeile,
} from '../components/MarktpreiseMobil';
import { Aufklapper } from '../components/Aufklapper';
import { VerlaufKarte } from '../components/VerlaufKarte';
import { aktuellerPreisSlot } from '../settingsSurface';

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

/** Kurzes Datum für den Abdeckungs-Hinweis und den Leer-Zustand. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** „Ihr Bezugspreis 32,50 ct/kWh" - oder gar nichts. Nie eine erfundene Zahl. */
function bezugpreisZeile(ct: number | null): string | null {
  return bezugspreisNote(ct);
}

/**
 * Der Lead-Satz des früheren Seitenkopfs (`SUB_PAGES.marktpreise` in
 * `AnlagenPage`, bis P1). Er lebt als Fuß-Aufklapper weiter — der Wortlaut ist
 * unverändert Kunden-Sprache.
 */
const MARKTPREISE_LEAD =
  'Was Strom an der Börse kostet - heute, morgen und im Rückblick.';

/**
 * **Der Reiter „Marktpreise" in den C-Bausteinen** (Paket P4, Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §4.3).
 *
 * Drei Captain-Entscheide vom 03.09.2026 (Lavish-Review 19:40 Uhr) tragen den
 * Umbau, wörtlich:
 *
 *  - **E8** „a) Statement auf Marktpreise, Lastspitzen, Wetter" — die EINE Zahl
 *    des Reiters (der Börsenpreis JETZT) steht auf der Fläche, nicht in einer
 *    Karte, und **auf jeder Breite**. Bis P4 gab es sie nur am Telefon; der
 *    Rechner trug stattdessen drei `KpiCard` mit den ZEITRAUM-Zahlen — also
 *    genau nicht die Antwort auf „was kostet Strom gerade?".
 *  - **E6** „a) am Telefon immer Liste (V7), ab 700 px Tabelle" — das
 *    Profi-Detail (EUR/MWh) ist unter 721 px eine Ledger-Liste und darüber eine
 *    echte Tabelle, aus denselben Daten.
 *  - **E7** „a) Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen am Telefon"
 *    — der `dataZoom` der Kurve ist der FOKUS-Ausschnitt (`zoomLock`), keine
 *    Geste; er bleibt es.
 *
 * ⚠ **Die Zahlen und die Aussagen sind unverändert** — sie wechseln nur die
 *   Form: die drei KPI-Karten und die drei Chips wurden Ledger-Zeilen
 *   (`preisZeilen`), das `Stat`-Raster wurde das Profi-Detail (`profiZeilen`),
 *   und die Wortzeile der Preisfenster zog aus dem Chart-Fuß (0,74 rem) in die
 *   Karte (16 px).
 */
export function MarktpreisePage(props: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  /** Als Reiter des Verlaufs gerendert (E3) — ohne eigenen Seitenkopf. */
  embedded?: boolean;
}) {
  const site = props.sites.find((s) => s.id === props.selectedSite) ?? null;
  /**
   * Der Zeitraum steht in der ADRESSE (P1, V3) — wie auf Messwerten und
   * Erlösen, mit demselben Vokabular (`z=`/`at=`). Ein Lesezeichen OHNE
   * Parameter bleibt gültig: `parseVerlaufParams` fällt auf Tag/heute zurück.
   */
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() => ankerAusWert(init.at ?? '', init.range) ?? new Date());
  const [history, setHistory] = useState<PriceHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const at = isoDate(anchor);
  /**
   * Zeitraum + Anker in die Adresse — `replaceState`, wie auf Messwerten: eine
   * Zeitraum-Wahl ist kein eigener Schritt im Verlauf des Browsers, sondern die
   * Fortschreibung DERSELBEN Seite. Nur als REITER einer Anlage; als
   * eigenständige Seite (`/marktpreise` mit Anlagen-Wähler) gehört die Adresse
   * nicht dieser Anlage.
   */
  useEffect(() => {
    if (!props.embedded || !site) return;
    replaceCurrentNavigation(historieHash(site.id, 'marktpreise', range, at));
  }, [props.embedded, site?.id, range, at]);
  useEffect(() => {
    if (!site) {
      setHistory(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .priceHistory(site.id, range, at)
      .then((h) => active && setHistory(h))
      .catch((e) => active && setErr(e instanceof ApiError ? e.message : 'Fehler'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id, range, at, reloadKey]);

  const nextDisabled = shiftAnchor(anchor, range, 1) > new Date();
  const summary = history?.summary ?? null;
  const buckets = history?.buckets ?? [];
  const hasData = buckets.length > 0 && (summary?.count ?? 0) > 0;
  const isDay = range === 'day';

  const isPhone = useIsPhone();
  const [now, setNow] = useState<Date>(() => new Date());
  const [fokus, setFokus] = useState<TagFokus>('heute');
  // Der Bezugspreis wird GELESEN, nie gerechnet: er reist je Viertelstunde im
  // Fahrplan mit (`importPriceCtKwh`, die eine serverseitige Komposition) -
  // dieselbe Quelle wie die Vorschau unter dem Stromtarif. Aus den
  // Tarif-Feldern zu addieren waere die zweite Preiswahrheit.
  const [bezugCt, setBezugCt] = useState<number | null>(null);

  // Der Held zeigt die laufende Viertelstunde - ohne Takt zeigte er nach dem
  // ersten Slotwechsel eine vergangene.
  useFreshnessPoll(() => setNow(new Date()), 60_000);

  useEffect(() => {
    setBezugCt(null);
    // E8: das Statement steht auf JEDER Breite, also braucht auch der Rechner
    // seinen Bezugspreis. Der Abruf hängt weiterhin am Tages-Zeitraum - im
    // Rückblick gibt es kein „jetzt", das er einordnen könnte.
    if (!site || !isDay) return;
    let active = true;
    api
      .schedule(site.id)
      .then((plan) => {
        if (!active) return;
        const slot = aktuellerPreisSlot(plan.slots, plan.slotMinutes, new Date());
        setBezugCt(slot?.importPriceCtKwh ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [site?.id, isDay]);

  // Ein Zeitraumwechsel setzt den Tages-Fokus zurueck - sonst zeigte der
  // Rueckblick auf "Morgen".
  useEffect(() => setFokus('heute'), [range, at]);

  const jetzt = isDay ? jetztPreis(history, now) : null;
  /**
   * V3 · Heute/Morgen als Segment. Der Fokus-Ausschnitt bleibt dem TELEFON
   * vorbehalten (bei 375 px liegen 192 Viertelstunden in ~343 px); am Rechner
   * zeigt die Kurve beide Tage, und das Segment schaltet dort nur mit, wenn es
   * überhaupt einen Folgetag gibt.
   */
  const zeigtHeute = isDay && isoDate(new Date()) === at;
  const wahl = isDay ? tagWahl(buckets, zeigtHeute) : null;
  const zeilen = preisZeilen(summary, range, history?.bucket ?? '');
  const profi = profiZeilen(summary);

  /**
   * K1 · Der Kernaussage-Satz über der Tageskurve — ABGELEITET aus denselben
   * benannten Fenstern, die das Diagramm hinterlegt (`preisFenster`), also kann
   * er ihm nie widersprechen. Gerechnet wird auf dem GEZEIGTEN Ausschnitt: am
   * Telefon zeigt die Kurve einen Tag, dann darf der Satz nicht das Tief des
   * anderen benennen. Ohne belegbare Aussage steht dort der ehrliche Grund.
   */
  const kern = useMemo(() => {
    if (!isDay || !hasData) return null;
    const zoom = isPhone ? fokusFenster(buckets, fokus) : null;
    const sicht = zoom ? buckets.slice(zoom.start, zoom.end + 1) : buckets;
    const cts = ctReihe(sicht.map((b) => b.avgEurMwh));
    return preisKern(cts, sicht.map((b) => b.ts), preisFenster(cts, 15));
  }, [isDay, hasData, isPhone, buckets, fokus]);

  /**
   * V5 · Die benannten Preisfenster als Ledger-Zeilen (16 px) — bis P4 standen
   * sie als 0,74-rem-Zeile im Fuß des Diagramms. Abgeleitet aus DERSELBEN
   * `preisFenster.ts`, die die Bänder im Bild hinterlegt.
   */
  const fensterRows: PreisZeile[] = useMemo(() => {
    if (!isDay || !hasData || history?.bucket !== 'PT15M') return [];
    const cts = ctReihe(buckets.map((b) => b.avgEurMwh));
    return fensterZeilen(preisFenster(cts, 15), buckets.map((b) => b.ts)).map((f) => ({
      id: f.art,
      name: f.wort,
      wert: f.zeit,
    }));
  }, [isDay, hasData, history?.bucket, buckets]);

  // Partial coverage: the collector only fetches today+tomorrow, so week/month/
  // year fill in over time. Flag when the stored data starts well after the
  // window opens (older prices were never collected).
  const partialFrom =
    !isDay && hasData && summary?.coverageStart && history
      ? new Date(summary.coverageStart).getTime() - new Date(history.from).getTime() > 36 * 3600 * 1000
      : false;

  // §4.3 nennt den Chip „15 min" — kurz, weil er NEBEN einem langen Label
  // steht („DAY-AHEAD HEUTE & MORGEN · DE-LU"); „15-Minuten-Takt" schob ihn
  // bei 375 px in eine eigene Zeile.
  const raster =
    history?.bucket === 'PT15M'
      ? '15 min'
      : history?.bucket === 'PT1H'
        ? 'stündlich'
        : 'täglich';

  return (
    <PageFrame
      title="Marktpreise"
      // Am Telefon EIN Satz: der lange Untertitel maß gemessene 113 px (fuenf
      // Zeilen) und schob die Antwort nach unten - die Gebotszone steht ohnehin
      // in der Kopfzeile der Kurve (Mobil-Umbau Stufe 4, Prinzip P1).
      subtitle={
        isPhone
          ? 'Was Strom an der Börse kostet - heute und morgen.'
          : `Börsen-Strompreise (Day-Ahead)${site ? ` - Gebotszone ${site.biddingZone}` : ''}: heute & morgen sowie der Rückblick über Tag, Woche, Monat und Jahr.`
      }
      {...props}
    >
      {/* V1 · Der Seitenkopf ist unsichtbar: was er sagte, sagen die
          Bereichs-Reiter (Paket P1, Befund B1). Sein Lead-Satz steht am Fuß. */}
      <VerlaufKopf titel="Marktpreise" />
      {/* V3 · DIESELBE Zeit-Leiste wie auf Messwerten und Erlösen — vorher stand
          hier eine zweite `.vp-seg` in einem eigenen `vp-page-head` (Befund B2:
          drei Zeitraum-Bedienungen im selben Bereich). */}
      <ZeitLeisteRahmen
        mobil={isPhone}
        zeile1={
          <ZeitSegment label="Zeitraum" optionen={PERIOD_RANGES} wert={range} onWert={setRange} />
        }
        zeile2={
          <ZeitBlaetterer
            label={periodLabel(anchor, range)}
            onZurueck={() => setAnchor(shiftAnchor(anchor, range, -1))}
            onVor={() => setAnchor(shiftAnchor(anchor, range, 1))}
            vorDisabled={nextDisabled}
            onJetzt={() => setAnchor(new Date())}
          />
        }
      />

      {/* V10 · Laden — dieselbe Höhe, die das Bild später wirklich einnimmt. */}
      {loading && (
        <section className="vp-section">
          <div className="vp-c-card">
            <VerlaufKarteSkeleton legende={false} />
          </div>
        </section>
      )}

      {/* V10 · Fehler — IN der Karte, damit die Fläche ihre Überschrift behält. */}
      {err && (
        <VerlaufKarte label={isDay ? 'Day-Ahead heute & morgen' : 'Preisverlauf'}>
          <VerlaufFehler
            satz={`Die Börsenpreise konnten nicht geladen werden (${err}).`}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </VerlaufKarte>
      )}

      {/* V10 · Leer — EIN Satz, und wo es einen gibt: der Weg. */}
      {!loading && !err && !hasData && (
        <VerlaufKarte label={isDay ? 'Day-Ahead heute & morgen' : 'Preisverlauf'}>
          <VerlaufLeer
            label="Keine Börsenpreise in diesem Zeitraum"
            satz={
              isDay
                ? 'Die Börsenpreise werden automatisch geladen, sobald die Strombörse sie veröffentlicht (täglich am frühen Nachmittag für den Folgetag).'
                : summary?.coverageStart
                  ? `Preise liegen erst ab dem ${shortDate(summary.coverageStart)} vor - der Rückblick füllt sich Tag für Tag.`
                  : 'Für diesen Zeitraum liegen noch keine gespeicherten Preise vor. Der Rückblick füllt sich Tag für Tag - schauen Sie später wieder vorbei oder wählen Sie einen jüngeren Zeitraum.'
            }
            weg={isDay ? undefined : 'Zum heutigen Tag'}
            onWeg={
              isDay
                ? undefined
                : () => {
                    setRange('day');
                    setAnchor(new Date());
                  }
            }
          />
        </VerlaufKarte>
      )}

      {!loading && !err && hasData && summary && history && (
        <>
          {/* E8 · Das Statement: die EINE Zahl des Reiters, auf der Fläche.
              Ohne laufende Viertelstunde steht dort GAR NICHTS - nie der
              zuletzt bekannte Preis als „jetzt". */}
          {jetzt && (
            <section className="vp-section">
              <MarktStatement preis={jetzt} bezug={bezugpreisZeile(bezugCt)} />
            </section>
          )}

          <VerlaufKarte
            label={`${isDay ? 'Day-Ahead heute & morgen' : 'Preisverlauf'}${
              site ? ` · ${site.biddingZone}` : ''
            }`}
            chip={<span className="vp-chip">{raster}</span>}
          >
            {/* V6 · die Reihenfolge IST die Aussage: Label → Kernsatz → BILD →
                Zeilen → Erklärung im Aufklapper. */}
            <ChartHeadline kern={kern} />
            <PriceHistoryChart history={history} fokus={isPhone && isDay ? fokus : null} />
            <TagSegment wahl={wahl} wert={fokus} onWert={setFokus} />

            {/* V5 · Die benannten Fenster - Wort links, Zeitraum rechts. */}
            <PreisZeilen zeilen={fensterRows} label="Benannte Preisfenster" />
            {/* V5 · Tief / Hoch / Ø (und im Rückblick die Abdeckung). */}
            <PreisZeilen
              zeilen={zeilen}
              label={isDay ? 'Preis-Kennzahlen des Tages' : 'Preis-Kennzahlen im Zeitraum'}
            />

            {partialFrom && summary.coverageStart && (
              <p className="vp-mp-note">
                Für diesen Zeitraum liegen erst Preise ab dem {shortDate(summary.coverageStart)} vor
                - ältere Börsenpreise wurden noch nicht erfasst.
              </p>
            )}

            {/* V8 · Das Profi-Detail. Der EUR/MWh-Grundsatz der Seite bleibt -
                die Zahlen sind da, nur eine Ebene tiefer, auf JEDER Breite. */}
            <Aufklapper titel="Profi-Detail (EUR/MWh · Quelle)">
              <ProfiZahlen zeilen={profi} />
              <p className="vp-mp-note">
                Quelle: energy-charts.info (Fraunhofer ISE).{' '}
                {isDay ? '' : 'Preise sind marktweit je Gebotszone (nicht pro Anlage).'}
              </p>
            </Aufklapper>

            {/* Der Fahrplan-Querverweis BLEIBT sichtbar - er erklaert, warum es
                diesen Reiter ueberhaupt gibt. */}
            {isDay && site && (
              <WegZeile href={`#/anlage/${site.id}/fahrplan`}>
                Ihr Fahrplan nutzt genau diese Preise
              </WegZeile>
            )}
          </VerlaufKarte>
        </>
      )}
      {/* V1 · Der Lead-Satz des früheren Seitenkopfs — WÖRTLICH, nur an einem
          anderen Ort. Er ist Nachschlage-Text, kein Scrollweg-Inhalt; ihn beim
          Entfernen des Kopfes zu verlieren wäre kein Aufräumen. */}
      <VerlaufFuss text={MARKTPREISE_LEAD} />
    </PageFrame>
  );
}

// ---------------------------------------------------------------------------

/** The Wetter subpage of one Anlage: the forecast feeding its PV-Prognose. */
/** Der Lead-Satz des früheren Seitenkopfs (`SUB_PAGES.wetter`, bis P1). */
const WETTER_LEAD =
  'Die Vorhersage am Standort Ihrer Anlage - Grundlage der PV-Prognose.';

/**
 * **Paket P5 · der Reiter „Wetter" in den C-Bausteinen** (Konzept
 * `data/vp-verlauf-sprache-konzept-v5` §3.2 V4–V8 und §4.6; Captain-Entscheide
 * **E8 (a)** „Statement auf Marktpreise, Lastspitzen, Wetter" und **E7 (a)**
 * „Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen am Telefon").
 *
 * Die Karte von oben nach unten — die REIHENFOLGE ist die Aussage:
 *
 *  1. **Statement** — die EINE Zahl des Reiters (36/800, ab 721 px 48) und der
 *     Satz darunter. Der frühere Kernsatz („erwartete Spitze morgen gegen
 *     12:00 Uhr") WIRD die Zahl; die Icon-Kachel 40 px und die `h2` in Inter
 *     Tight sind ersatzlos entfallen.
 *  2. **Himmel-Reihe** als 24-px-Chips (im Bild-Baustein, K10).
 *  3. **Bild** (V6) direkt danach: erwartete Leistung + Sonnenstärke, darunter
 *     die Chip-Legende, deren Einträge die Reihen SCHALTEN (E7 a).
 *  4. **Vier Kennzahlen als Ledger-Zeilen** (V5) statt des 2×2-Rasters mit
 *     seinen 21,6-px-Werten — die EINE Zahl der Fläche ist das Statement.
 *  5. **„Mehr anzeigen" → Aufklapper** (V8) „Temperatur & Sonnenstärke im
 *     Verlauf" mit dem zweiten Bild, danach die Quelle als `.vp-c-note`.
 *
 * ⚠ **Keine Zeit-Leiste** (§4.6): eine Vorhersage beginnt bei JETZT, ein
 *   Zeitraum-Segment wäre ein Schalter ohne Wirkung. Das Datum steht deshalb im
 *   LABEL der Karte („Vorhersage · Do., 03.09., 18:30") — ohne es stünde
 *   nirgends, worauf sich die Zahl bezieht.
 *
 * ⚠ **Es wird keine Zahl neu gerechnet.** Statement, Zeilen und Kurve lesen
 *   dieselbe kW-Reihe (`erwarteteLeistung`); zwei Rechenwege über dieselbe Zahl
 *   auf EINER Karte wären zwei Wahrheiten. Fehlt ein Wert, trägt die Zeile „—",
 *   nie eine 0.
 */
export function WetterSection({ site }: { site: Site }) {
  const { data: forecast, loading, err, reload } = useSiteData<WeatherForecast>(site, (id) => api.weather(id));
  /**
   * Die LEITGRÖSSE der Fläche ist seit Stufe 4 die erwartete Leistung in kW -
   * und die einzige Stelle, an der die PV-Prognose des aktiven Modells das
   * Portal erreicht, ist der FAHRPLAN (`schedule.pv_kw`). Der Abruf ist
   * FAIL-SOFT: ohne Plan (kein Speicher, toter Optimierer) führt das Statement
   * wieder die Sonnenstärke und sagt im Satz den Grund (§4.6).
   */
  const [planSlots, setPlanSlots] = useState<ScheduleSlot[]>([]);
  useEffect(() => {
    setPlanSlots([]);
    let active = true;
    api
      .schedule(site.id)
      .then((plan) => {
        if (active) setPlanSlots(plan.slots);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [site.id]);
  /** V8 · Der Aufklapper mit dem ZWEITEN Bild — zu, bis jemand fragt. */
  const [mehrOpen, setMehrOpen] = useState(false);

  const points = forecast?.points ?? [];
  const jetzt = new Date();
  // Die Kopf-Zahl und die Kurve lesen DIESELBE kW-Reihe - sie können sich also
  // nicht widersprechen.
  const kwReihe = erwarteteLeistung(points, planSlots);
  const hatPunkte = points.length > 0;
  const stmt = hatPunkte ? wetterStatement(points, kwReihe, jetzt) : null;
  const zeilen: VerlaufLedgerZeile[] = hatPunkte ? wetterZeilen(points, kwReihe, jetzt) : [];

  return (
    <>
      {/* V1 · Unsichtbarer Seitenkopf (Paket P1). Wetter hatte gar keine `h1` in
          der Fläche selbst — der Titel stand im `SUB_PAGES`-Kopf über den
          Reitern und schob sie von 140 auf 316 px. */}
      <VerlaufKopf titel="Wetter" />
      <VerlaufKarte label={vorhersageLabel(jetzt)}>
        {loading && <VerlaufKarteSkeleton />}
        {err && (
          <VerlaufFehler
            satz={`Die Wettervorhersage konnte nicht geladen werden (${err}).`}
            onRetry={reload}
          />
        )}
        {!loading && !err && !hatPunkte && (
          /* §4.6 · Keine Koordinaten → V10 Leer MIT dem Weg. Der Satz nennt den
             Grund, der Knopf führt dorthin, wo er sich beheben lässt. */
          <VerlaufLeer
            label="Vorhersage"
            satz="Noch keine Vorhersage. Sie wird automatisch geladen - Ihre Anlage braucht dafür einen Standort auf der Karte."
            weg="Standort in den Einstellungen ergänzen ›"
            onWeg={() => {
              window.location.hash = einstellungenHash(site.id);
            }}
          />
        )}
        {!loading && !err && hatPunkte && stmt && (
          <>
            {/* E8 (a) · Das Statement: die EINE Zahl des Reiters, auf der
                Fläche statt in einer zweiten Karte. Ohne Fahrplan trägt sie die
                Sonnenstärke, und der Satz sagt WARUM - eine Leistung zu
                behaupten, die niemand prognostiziert hat, wäre erfunden. */}
            <div className="vp-c-stm">
              <p className="vp-c-stm-zahl">{stmt.zahl ?? '—'}</p>
              <p className="vp-c-stm-ein">
                <span>{stmt.satz}</span>
              </p>
            </div>
            {/* V6 · Himmel-Reihe → Bild → Chip-Legende, in EINEM Baustein.
                E7 (a): Tooltip per Tipp, KEIN Zoom durch Ziehen - auf keiner
                Breite. */}
            <WeatherChart points={points} planSlots={planSlots} detail />
            {/* V5 · Die vier Kennzahlen als Zeilen: Name links, Wert rechts in
                Tabellenziffern, Einheit mit schmalem Leerzeichen. */}
            <VerlaufLedger label="Kennzahlen der Vorhersage" zeilen={zeilen} />
            <Aufklapper
              titel="Temperatur & Sonnenstärke im Verlauf"
              open={mehrOpen}
              onToggle={() => setMehrOpen((v) => !v)}
            >
              {/* ⚠ Das zweite Bild entsteht ERST beim Aufklappen. Ein `details`
                  rendert seine Kinder auch zugeklappt, und ein ECharts-Canvas
                  in einem `display:none`-Kasten misst 0 × 0 - es bliebe leer,
                  bis irgendwann ein Resize kommt. */}
              {mehrOpen && <WeatherChart points={points} planSlots={planSlots} modus="kontext" />}
            </Aufklapper>
            <p className="vp-c-note">
              Wetterdaten: Open-Meteo, stündlich aktualisiert. Die erwartete Leistung ist
              die PV-Prognose, mit der Ihr Fahrplan rechnet - sie reicht so weit wie der
              Fahrplan.
            </p>
          </>
        )}
      </VerlaufKarte>
      {/* V1 · Der Lead-Satz des früheren Seitenkopfs — wörtlich, am Fuß. */}
      <VerlaufFuss text={WETTER_LEAD} />
    </>
  );
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
      }),
    [plan, slotMinutes, site.plantKind, site.tarifArt, site.tarifParamCtKwh, site.netzladenErlaubt, site.maxFeedInKw, hasWhy, lage, horizonNote],
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
