import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import type { History, HistoryRange, Site } from '../api';
import { NBSP } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  energieBilanz,
  messwerteKernaussage,
  summenTitel,
  zeitraumHinweis,
  zeitraumWort,
  type EnergieFarbe,
  type EnergieSumme,
} from '../energieBilanz';
import {
  delta,
  ENERGIE_WERTUNG,
  fuehrendesDelta,
  keineVergleichsDatenText,
  laufendHinweis,
  normalisiereModus,
  ueberlagerungAktiv,
  ueberlagerungLegende,
  vergleichsKopf,
  vergleichsName,
  wirksamerModus,
  type VergleichsModus,
} from '../historieVergleich';
import { chartTheme } from '../chartTheme';
import {
  historieHash,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { ankerAusWert, mitVergleich, parseVergleichModus } from '../historieZeit';
import { useHistoryPeriod, useVergleichsPeriode } from '../useHistoryPeriod';
import { useIsPhone } from '../useIsPhone';
import type { AnlageSurface } from '../surface';
import { replaceCurrentNavigation } from '../navigationBlocker';

import { InfoTip } from '../components/InfoTip';
import { ChartHeadline, ChartSubtitle } from '../components/ChartExplain';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { SiteMeasurementComparison } from '../components/SiteMeasurementComparison';
import { HistoryEnergieChart } from '../HistoryChart';
import {
  DeltaZeile,
  KartenKopf,
  PeriodeFehlgeschlagen,
  WeltDisclosure,
  WeltFuss,
  WeltKopf,
  ZeitLeiste,
} from '../components/HistorieWelt';

import '../components/Historie.css';

/**
 * **Welt A · „Messwerte"** (`#/anlage/{id}/messwerte`) — die Basis-Welt der
 * Historie, auf JEDER Anlage vorhanden (Konzept `data/vp-historie-konzept-t4`,
 * Captain-Struktur H1).
 *
 * Sie zeigt ausschließlich GEMESSENE Zahlen: die Energiemengen des Zeitraums,
 * das eine Mehrreihen-Diagramm (`energieBilanz.ts` + `HistoryChart` —
 * unverändert übernommen) und darunter, aufklappbar, den Messwerte-Explorer.
 *
 * Zwei Struktur-Entscheidungen stecken darin:
 * - **Der dritte Umschalter „Übersicht | Messwerte" entfällt ersatzlos.** Der
 *   Explorer ist ein Abschnitt DIESER Welt, kein konkurrierender Modus; der
 *   bestehende Deep-Link `?m=…&z=tag` öffnet ihn direkt aufgeklappt.
 * - **Die Stromkosten sind hier weg.** Sie sind eine BEWERTETE Zahl (heute
 *   gepflegtes Preisblatt) und standen als einzelner Chip in einer gemessenen
 *   Karte; sie leben jetzt in der Erlöse-Welt (report §7).
 */

function kwh(v: number | null | undefined): string {
  return v == null
    ? '-'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}kWh`;
}

function pct(v: number | null | undefined): string {
  return v == null ? '-' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}%`;
}

/** The pure `EnergieFarbe` key -> the resolved chart hex (the KPI dots). */
function dotColor(key: EnergieFarbe): string {
  const t = chartTheme();
  const map: Record<EnergieFarbe, string> = {
    pv: t.pv,
    load: t.load,
    grid: t.flowGrid,
    gridImport: t.discharge,
    gridExport: t.charge,
    charge: t.charge,
    battDischarge: t.battDischarge,
    soc: t.soc,
  };
  return map[key];
}

/**
 * One period-total tile: value + coloured dot + plain-German hint, darunter das
 * Δ zur Vorperiode (F3) — das rendert sich selbst weg, wenn es keinen ehrlichen
 * Vergleich gibt.
 */
function SummeTile({
  summe,
  vergleichKwh,
  vergleichName,
}: {
  summe: EnergieSumme;
  /** Dieselbe Summe der Vorperiode — null/undefined = kein Vergleich. */
  vergleichKwh?: number | null;
  vergleichName: string;
}) {
  const d = delta(summe.kwh, vergleichKwh, ENERGIE_WERTUNG[summe.key], vergleichName);
  return (
    <div className="vp-esum" title={summe.hinweis}>
      <span className="vp-esum-v">{kwh(summe.kwh)}</span>
      <span className="vp-esum-l">
        <span className="vp-esum-dot" style={{ ['--dot' as string]: dotColor(summe.farbe) }} />
        {summe.label}
      </span>
      <DeltaZeile delta={d} />
    </div>
  );
}

/**
 * Die Energiemengen des Zeitraums.
 *
 * **Am Telefon ist es ein kompaktes 2-Spalten-Raster mit EINER Δ-Zeile**
 * (Konzept `data/vp-mobile-views-x1` §5): sechs Kacheln mit je eigener Δ-Zeile
 * kosteten dort ~540 px VOR dem Diagramm. Die Zahlen bleiben alle sechs, der
 * Vergleich wird auf `fuehrendesDelta` eingedampft — das seine Größe NENNT,
 * statt wie im Entwurf gegenstandslos „etwa gleich" zu behaupten. Die Quoten
 * ziehen in dieselbe Zeile.
 */
function EnergieSummenKarte({
  history,
  vorher,
  range,
  anchor,
  modus,
  isPhone,
}: {
  history: History;
  vorher: History | null;
  range: HistoryRange;
  anchor: Date;
  modus: VergleichsModus;
  isPhone: boolean;
}) {
  const bilanz = energieBilanz(history);
  const now = new Date();
  const hinweis = zeitraumHinweis(anchor, range, now);
  const vergleichName = vergleichsName(anchor, range, modus);
  const vorherSummen = vorher ? energieBilanz(vorher).summen : null;
  const laufend = vorher ? laufendHinweis(anchor, range, now, modus) : null;
  const einDelta = isPhone
    ? fuehrendesDelta(bilanz.summen, vorherSummen, vergleichName)
    : null;

  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg">
        <KartenKopf
          icon="zap"
          titel={summenTitel(anchor, range, isPhone)}
          art="gemessen"
          extra={
            vorherSummen && !isPhone ? (
              <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range, modus)}</span>
            ) : undefined
          }
        />

        {isPhone ? (
          <dl className="vp-esum-kompakt" aria-label="Energiemengen im Zeitraum">
            {bilanz.summen.map((s) => (
              <div key={s.key} className="vp-esum-k" title={s.hinweis}>
                <dt>
                  <span
                    className="vp-esum-dot"
                    style={{ ['--dot' as string]: dotColor(s.farbe) }}
                  />
                  {s.label}
                </dt>
                <dd>{kwh(s.kwh)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="vp-energie-summen" aria-label="Energiemengen im Zeitraum">
            {bilanz.summen.map((s, i) => (
              <SummeTile
                key={s.key}
                summe={s}
                vergleichKwh={vorherSummen ? vorherSummen[i]?.kwh : null}
                vergleichName={vergleichName}
              />
            ))}
          </div>
        )}

        {laufend && <p className="vp-note vp-note-laufend">{laufend}</p>}

        {isPhone ? (
          // Quoten UND der eine Vergleich in einer ruhigen Meta-Zeile.
          <p className="vp-esum-meta">
            <span>
              Autarkie <b>{pct(bilanz.autarkiePct)}</b>
            </span>
            <span>
              Eigenverbrauch <b>{pct(bilanz.eigenverbrauchPct)}</b>
            </span>
            {einDelta && (
              <span className="vp-esum-meta-delta">
                {einDelta.label} <DeltaZeile delta={einDelta.view} />
              </span>
            )}
          </p>
        ) : (
          <div className="vp-energie-chips">
            <span className="vp-energie-chip">
              Autarkie <b>{pct(bilanz.autarkiePct)}</b>
              <InfoTip title="Autarkiegrad">
                Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben (aus PV und Speicher) -
                der Rest kam aus dem Netz. Formel: 1 − Netzbezug/Verbrauch.
              </InfoTip>
            </span>
            <span className="vp-energie-chip">
              Eigenverbrauch <b>{pct(bilanz.eigenverbrauchPct)}</b>
              <InfoTip title="Eigenverbrauchsquote">
                Anteil Ihrer PV-Erzeugung, den Sie selbst genutzt statt eingespeist haben.
                Formel: selbst genutzte PV / PV-Erzeugung.
              </InfoTip>
            </span>
          </div>
        )}

        {hinweis && <p className="vp-note">{hinweis}</p>}
      </Card>
    </section>
  );
}

/**
 * Der „Was zeigt das?"-Satz des Diagramms.
 *
 * **Am Telefon die KURZE Fassung** (eine Zeile statt drei): der lange Satz
 * kostete dort gemessen 91 px direkt über der Kurve, die im ersten Bildschirm
 * stehen soll. Er verschwindet nicht — er nennt dieselben vier Größen, nur
 * ohne den erklärenden Nachsatz, den die Legende darunter ohnehin zeigt.
 */
function diagrammUntertitel(isDay: boolean, isPhone: boolean, raster: string): string {
  if (isPhone) {
    // Das Raster (`15-Minuten-Mittel`) steht hier statt als eigenes Abzeichen
    // im Kartenkopf: dort brach es den Kopf auf zwei Zeilen, und es IST eine
    // Präzisions-Angabe zum Diagramm - sie gehört zu seinem Satz.
    return isDay
      ? `PV, Haus, Netz und Speicher im Tagesverlauf - dazu der Ladestand. ${raster}.`
      : `PV, Haus, Netz und Speicher je Abschnitt in kWh - dazu der Ladestand. ${raster}.`;
  }
  return isDay
    ? 'Der Tagesverlauf Ihrer Anlage in einem Bild: PV-Erzeugung, Hausverbrauch, Netz und Speicher - dazu der Ladestand.'
    : 'Erzeugung, Verbrauch, Netz und Speicher je Abschnitt im gewählten Zeitraum - als Energiemengen in Kilowattstunden, dazu der Ladestand.';
}

/** Das eine Mehrreihen-Diagramm samt Legende und Ereignis-Chips. */
function EnergieDiagrammKarte({
  history,
  range,
  anchor,
  modus,
  vorher,
  isPhone,
  onTagOeffnen,
}: {
  history: History;
  range: HistoryRange;
  anchor: Date;
  modus: VergleichsModus;
  vorher: History | null;
  isPhone: boolean;
  onTagOeffnen?: (at: string) => void;
}) {
  const isDay = range === 'day';
  const raster = isDay ? '15-Minuten-Mittel' : range === 'week' ? 'stündlich' : 'täglich';
  // F8: überlagert wird nur, was auch Zahlen trägt - eine leere Reihe läse sich
  // wie gemessene Nullen.
  const ueberlagern =
    ueberlagerungAktiv(modus) && vorher != null && vorher.buckets.length > 0 ? vorher : null;
  // K1/M11: die Kernaussage der Welt als SATZ über dem Bild - abgeleitet aus
  // der schon vorhandenen Eigenverbrauchs-Quote plus derselben Quote des
  // Vergleichszeitraums als Anker (K8). Ohne Quote steht dort der Grund.
  const vglName = vergleichsName(anchor, range, modus);
  const kern = messwerteKernaussage(
    energieBilanz(history),
    zeitraumWort(range),
    vorher ? { pct: energieBilanz(vorher).eigenverbrauchPct, name: vglName } : null,
  );

  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg">
        <KartenKopf
          icon="activity"
          titel="Ihre Energie im Verlauf"
          art="gemessen"
          /* B7: `Badge variant="tint"` misst 1,66:1 (im echten Browser bei
             1440 nachgemessen) — das Raster-Wort trägt seit E9 die EINE
             Haus-Chip-Form (P0 `.vp-chip`, 4,8:1). */
          extra={isPhone ? undefined : <span className="vp-chip">{raster}</span>}
        />
        <ChartHeadline kern={kern} />
        <ChartSubtitle>{diagrammUntertitel(isDay, isPhone, raster)}</ChartSubtitle>
        <HistoryEnergieChart
          history={history}
          onTagOeffnen={onTagOeffnen}
          vergleich={ueberlagern}
          legende={ueberlagerungLegende(anchor, range, modus)}
        />
      </Card>
    </section>
  );
}

/**
 * Karte 1 + 2 der Welt.
 *
 * **Die Reihenfolge ist die Mobil-Entscheidung** (P3 „Diagramm zuerst, Zahlen
 * dahinter"): am Telefon führt das Diagramm, am Schreibtisch bleibt es bei
 * Summen → Diagramm (dort passt beides fast gemeinsam ins Bild, und die
 * Desktop-Bühne bleibt byte-gleich). Getauscht wird die DOM-Reihenfolge, nicht
 * nur die optische — sonst läse ein Screenreader eine andere Seite als das Auge.
 */
function EnergieKarten({
  history,
  vorher,
  range,
  anchor,
  modus,
  isPhone,
  onTagOeffnen,
}: {
  history: History;
  /** Die Vorperiode für das Δ (F3) — null, solange sie nicht geladen ist. */
  vorher: History | null;
  range: HistoryRange;
  anchor: Date;
  /** F8: der gewählte Vergleich — er regiert Δ-Namen UND Überlagerung. */
  modus: VergleichsModus;
  isPhone: boolean;
  /** Der Tagesdrilldown (F5) — im Tages-Zeitraum gibt es nichts zu öffnen. */
  onTagOeffnen?: (at: string) => void;
}) {
  const bilanz = energieBilanz(history);

  if (history.buckets.length === 0 || bilanz.empty) {
    return (
      <Card padding="lg" radius="lg">
        <VerlaufLeer
          label="Keine Messwerte in diesem Zeitraum"
          satz="Sobald Ihre Anlage misst, entsteht hier die Energiegeschichte: PV-Erzeugung, Hausverbrauch, Netz und Speicher in einem Bild. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
        />
      </Card>
    );
  }

  const summen = (
    <EnergieSummenKarte
      history={history}
      vorher={vorher}
      range={range}
      anchor={anchor}
      modus={modus}
      isPhone={isPhone}
    />
  );
  const diagramm = (
    <EnergieDiagrammKarte
      history={history}
      range={range}
      anchor={anchor}
      modus={modus}
      vorher={vorher}
      isPhone={isPhone}
      onTagOeffnen={onTagOeffnen}
    />
  );

  return isPhone ? (
    <>
      {diagramm}
      {summen}
    </>
  ) : (
    <>
      {summen}
      {diagramm}
    </>
  );
}

export function MesswerteSection({
  site,
}: {
  site: Site;
  /** Das M0-Lese-Modell der Anlage — entscheidet, ob es die Erlöse-Welt gibt. */
  /**
   * ⚠ Reserviert: seit E3 leitet die Seite daraus nichts mehr ab (die Welten
   * stehen als Bereichs-Reiter, `anlageNav` entscheidet über sie). Die Prop
   * bleibt in der Signatur, weil jeder Aufrufer sie führt.
   */
  surface?: AnlageSurface | null;
  /**
   * ⚠ Reserviert und derzeit ohne Wirkung: der Welt-Wechsel wohnt seit E3 in
   * den Bereichs-Reitern (`anlageNav` Verlauf › Messwerte · Erlöse). Die Prop
   * bleibt optional in der Signatur, damit ein Aufrufer, der sie noch übergibt,
   * nicht bricht.
   */
  onOpenWelt?: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  // Der Explorer ist ein Abschnitt dieser Welt; ein Deep-Link auf einen
  // Messwert öffnet ihn direkt aufgeklappt (bestehende Links bleiben gültig).
  const [explorerOpen, setExplorerOpen] = useState(init.target != null);
  // F8: der Vergleichs-Zustand reist in der Adresse (`v=`), damit ein Link ihn
  // mitbringt und der Welt-Wechsel ihn behält.
  const [modusWahl, setModusWahl] = useState<VergleichsModus>(() =>
    parseVergleichModus(window.location.hash),
  );

  const isPhone = useIsPhone();
  const at = isoDate(anchor);
  const { history, loading, stale, err, retry } = useHistoryPeriod(site.id, range, at);
  // Ein per Lesezeichen mitgebrachtes „Vorjahr" auf einem Tages-Zeitraum fällt
  // auf die Vorperiode zurück - der Umschalter bietet dort nichts anderes an.
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  // F3+F8: der zweite Abruf mit verschobenem Anker - EINE Antwort speist Δ-Zeile
  // und Überlagerung, sie können sich deshalb nicht widersprechen. Er startet
  // erst, wenn der gezeigte Zeitraum überhaupt Zahlen trägt.
  const vorher = useVergleichsPeriode(
    site.id,
    range,
    anchor,
    !stale && (history?.buckets.length ?? 0) > 0,
    wirksamerModus(modus),
  );
  // Ehrlich statt leer: eine Vergleichsperiode ohne Zahlen wird GESAGT.
  const vergleichHinweis =
    ueberlagerungAktiv(modus) && vorher != null && vorher.buckets.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const setModus = useCallback(
    (m: VergleichsModus) => {
      setModusWahl(m);
      replaceCurrentNavigation(mitVergleich(historieHash(site.id, 'messwerte', range, at), m));
    },
    [site.id, range, at],
  );

  // Ein Cockpit-Sprung (oder Zurück/Vorwärts) ändert den Deep-Link, während
  // diese Fläche montiert bleibt - Zeitraum + Explorer daraus neu setzen. Der
  // replaceState des Explorers löst kein hashchange aus, das hier reagiert also
  // nur auf echte Navigation.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      if (!p.target) return;
      setExplorerOpen(true);
      setModusWahl(parseVergleichModus(window.location.hash));
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const welt = WELTEN.messwerte;

  /**
   * **F5 · der Tagesdrilldown.** Ein Tipp auf einen Balken (oder einen
   * Ereignis-Chip) öffnet DIESEN Tag — in derselben Welt, mit denselben
   * Bausteinen wie jede andere Zeitraum-Geste: `ankerAusWert` liefert den Anker
   * (12 Uhr mittags, damit keine Zeitzone ihn über eine Tagesgrenze kippt),
   * `historieHash` die Adresse. Hier entsteht KEINE eigene Routing-Logik.
   *
   * Die Adresse wird mitgeschrieben (`replaceState` wie beim Zuklappen des
   * Explorers), damit ein Neuladen den gesprungenen Tag zeigt statt der Periode,
   * aus der man kam.
   */
  const oeffneTag = useMemo(
    () =>
      range === 'day'
        ? undefined
        : (at: string) => {
            const ziel = ankerAusWert(at, 'day');
            if (!ziel) return;
            setRange('day');
            setAnchor(ziel);
            replaceCurrentNavigation(
              mitVergleich(historieHash(site.id, 'messwerte', 'day', at), modus),
            );
          },
    [range, site.id, modus],
  );

  const toggleExplorer = useCallback(() => {
    setExplorerOpen((open) => {
      // Beim Zuklappen die Messwert-Parameter aus der Adresse nehmen, damit ein
      // Neuladen die Welt so zeigt, wie sie gerade aussieht.
      if (open) {
        replaceCurrentNavigation(
          mitVergleich(historieHash(site.id, 'messwerte', range, at), modus),
        );
      }
      return !open;
    });
  }, [site.id, range, at, modus]);

  return (
    <>
      <WeltKopf welt={welt} />
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        coverage={history?.coverage}
        stale={stale}
        vergleich={modus}
        onVergleich={setModus}
        vergleichHinweis={vergleichHinweis}
      />

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {/* V10 (Paket P2b): die drei Zustände leben IN der Karte und
            reservieren den Platz des späteren Inhalts — beim Zeitraumwechsel
            springt damit nichts. */}
        {err && !history ? (
          <Card padding="lg" radius="lg">
            <VerlaufFehler
              satz={`Die Historie konnte nicht geladen werden (${err}).`}
              onRetry={retry}
            />
          </Card>
        ) : !history ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <VerlaufKarteSkeleton />
            </Card>
          ) : null
        ) : (
          <>
            {/* P5: fehlgeschlagenes Blättern darf nicht als stiller Stillstand
                enden - die alte Periode bleibt stehen, sagt aber, dass sie die
                alte ist. */}
            {err && stale && (
              <PeriodeFehlgeschlagen periode={periodLabel(anchor, range)} onRetry={retry} />
            )}
            <EnergieKarten
              history={history}
              vorher={vorher}
              range={range}
              anchor={anchor}
              modus={modus}
              isPhone={isPhone}
              onTagOeffnen={oeffneTag}
            />
          </>
        )}
      </div>

      {/* Karte 3: der Messwerte-Explorer - ein Abschnitt DIESER Welt. */}
      <WeltDisclosure
        titel="Einzelne Messwerte vergleichen"
        sub="bis zu 3 gleichzeitig"
        open={explorerOpen}
        onToggle={toggleExplorer}
      >
        <VerlaufExplorer
          site={site}
          range={range}
          anchor={anchor}
          initialTargets={init.targets}
        />
        <SiteMeasurementComparison siteId={site.id} />
      </WeltDisclosure>

      <WeltFuss welt={welt} />
    </>
  );
}
