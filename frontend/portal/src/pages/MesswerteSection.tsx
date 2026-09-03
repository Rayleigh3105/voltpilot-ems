import { useCallback, useEffect, useMemo, useState } from 'react';
import type { History, HistoryRange, Site } from '../api';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  energieBilanz,
  isCurrentPeriod,
  messwerteKernaussage,
  summenTitel,
  zeitraumHinweis,
  zeitraumWort,
} from '../energieBilanz';
import {
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

import { ChartHeadline } from '../components/ChartExplain';
import { Aufklapper } from '../components/Aufklapper';
import { VerlaufKarte } from '../components/VerlaufKarte';
import { VerlaufLedger, type VerlaufLedgerZeile } from '../components/VerlaufLedger';
import { messwerteQuoten, messwerteZeilen } from '../messwerteZeilen';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { VerlaufExplorer } from '../components/VerlaufExplorer';
import { SiteMeasurementComparison } from '../components/SiteMeasurementComparison';
import { HistoryEnergieChart } from '../HistoryChart';
import {
  DeltaZeile,
  PeriodeFehlgeschlagen,
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

/**
 * **Karte 2 · „Energie im Zeitraum"** in der Ledger-Form (Konzept
 * `vp-verlauf-sprache-konzept-v5` §3.2 V5, §4.1 Karte 2; Paket P3).
 *
 * Sechs Zeilen `Name · Wert · Balken · Δ`, danach die zwei Quoten mit ihrer
 * 24-px-Zahl und der Vergleichs-Satz als `.vp-c-note`. Das frühere 2-spaltige
 * Kachel-Raster (Label 12,5 / Wert 16, sechs Kacheln mit eigenem Rahmen) ist
 * ersatzlos entfallen — es war die Kachel-Form, die Variante C abschafft.
 *
 * ⚠ **Es ändert sich die FORM, nicht die Aussage.** Jede Zahl kommt aus
 *   derselben `energieBilanz`, jedes Δ aus demselben `delta`; die Ableitung
 *   liegt rein in `messwerteZeilen.ts` und ist ohne Browser prüfbar.
 *
 * ⚠ **Am Telefon UND am Rechner dieselbe Liste.** Die frühere Gabelung (dort
 *   ein `dl`-Raster mit EINEM Δ, hier sechs Kacheln mit je eigenem) machte aus
 *   einer Fläche zwei; die Ledger-Zeile trägt beide Fälle, weil sie ihre
 *   Sekundärzeile ohnehin unter den Namen legt.
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

  // §4.1 · ein laufender Zeitraum sagt das am Label, nicht erst im Kleingedruckten:
  // die Zahlen sind ein Zwischenstand, kein Ergebnis.
  const zwischenstand = isCurrentPeriod(anchor, range, now);

  const energien = messwerteZeilen(bilanz.summen, vorherSummen, vergleichName);
  const quoten = messwerteQuoten(bilanz);

  const zeilen: VerlaufLedgerZeile[] = [
    ...energien.map((z) => ({
      id: z.key,
      name: z.name,
      wert: z.wert,
      anteil: z.anteil,
      farbe: z.farbe,
      hinweis: z.hinweis,
      // Der Grund gewinnt gegen das Δ: eine Zeile ohne Wert hat auch keinen
      // Vergleich, und der Grund ist die Auskunft, die fehlt.
      sekundaer: z.grund ? z.grund : z.delta ? <DeltaZeile delta={z.delta} /> : undefined,
    })),
    ...quoten.map((q) => ({
      id: q.key,
      name: q.name,
      wert: q.wert,
      gross: true,
      sekundaer: q.satz,
    })),
  ];

  return (
    <VerlaufKarte
      label={summenTitel(anchor, range, isPhone)}
      provenienz="gemessen"
      chip={
        <>
          {zwischenstand && <span className="vp-chip">Zwischenstand</span>}
          {/* Der Vergleichs-Kopf bleibt dem Rechner: am Telefon stünden zwei
              Chips neben einem Label, das dort ohnehin schon kurz ist — und
              der Vergleich steht in jeder Δ-Zeile darunter beim Namen. */}
          {vorherSummen && !isPhone && (
            <span className="vp-chip">{vergleichsKopf(anchor, range, modus)}</span>
          )}
        </>
      }
    >
      <VerlaufLedger zeilen={zeilen} label="Energiemengen im Zeitraum" />
      {laufend && <p className="vp-c-note">{laufend}</p>}
      {hinweis && <p className="vp-c-note">{hinweis}</p>}
    </VerlaufKarte>
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
    <VerlaufKarte
      label="Ihre Energie im Verlauf"
      provenienz="gemessen"
      chip={isPhone ? undefined : <span className="vp-chip">{raster}</span>}
    >
      {/* V6 · die Reihenfolge IST die Aussage: Label → Kernsatz → BILD →
          Legende → Erklärung. Der Untertitel und die zwei Richtungszeilen
          standen bis P3 VOR dem Bild (~91 + 30 px direkt über der Kurve) —
          sie erklären es, also stehen sie jetzt darunter im Aufklapper. */}
      <ChartHeadline kern={kern} />
      <HistoryEnergieChart
        history={history}
        onTagOeffnen={onTagOeffnen}
        vergleich={ueberlagern}
        legende={ueberlagerungLegende(anchor, range, modus)}
        erklaerung={diagrammUntertitel(isDay, isPhone, raster)}
      />
    </VerlaufKarte>
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
  // Der letzte Tag, an dem diese Anlage überhaupt gemessen hat — die Antwort
  // steht schon in der Abdeckung der Antwort, sie wird hier nur gelesen.
  const letzterTag = history.coverage?.lastDataAt?.slice(0, 10) ?? null;

  if (history.buckets.length === 0 || bilanz.empty) {
    return (
      <div className="vp-c-card">
        <VerlaufLeer
          label="Keine Messwerte in diesem Zeitraum"
          satz={`Für ${periodLabel(anchor, range)} liegen keine Messwerte vor. Sobald Ihre Anlage misst, entsteht hier die Energiegeschichte: Erzeugung, Verbrauch, Netz und Speicher in einem Bild.`}
          /* §4.1 · der Weg wird nur angeboten, wenn es ihn WIRKLICH gibt: ohne
             eine je gemessene Viertelstunde führt „Zum letzten Tag mit Daten"
             nirgends hin, und ein toter Link ist schlimmer als keiner. */
          weg={letzterTag ? 'Zum letzten Tag mit Daten ›' : undefined}
          onWeg={letzterTag && onTagOeffnen ? () => onTagOeffnen(letzterTag) : undefined}
        />
      </div>
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
  // Der Fuß „Was diese Zahlen sind" ist seit P3 die letzte Zeile der letzten
  // Karte; sein Zustand gehört dieser Fläche, nicht dem Baustein.
  const [fussOffen, setFussOffen] = useState(false);
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
          /* §4.1 · der Fehler steht in Karte 1, Karte 2 BLEIBT Skeleton in
             ihrer Inhaltshöhe — sonst springt die Seite beim Wiederholen. */
          <>
            <div className="vp-c-card">
              <VerlaufFehler
                satz={`Die Historie konnte nicht geladen werden (${err}).`}
                onRetry={retry}
              />
            </div>
            <div className="vp-c-card">
              <VerlaufKarteSkeleton chart={false} legende={false} />
            </div>
          </>
        ) : !history ? (
          loading ? (
            <div className="vp-c-card">
              <VerlaufKarteSkeleton />
            </div>
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

      {/* Karte 3: der Messwerte-Explorer — ein Abschnitt DIESER Welt, und
          seit P3 zugleich die LETZTE Karte: der Fuß „Was diese Zahlen sind"
          ist ihre letzte Zeile statt eines eigenen Kastens (Konzept §4.1
          „Fuß: V8 als letzte Zeile der letzten Karte"). */}
      <section className="vp-section">
        <div className="vp-c-card">
          <Aufklapper
            titel="Einzelne Messwerte vergleichen"
            sub="bis zu 3 gleichzeitig"
            open={explorerOpen}
            onToggle={toggleExplorer}
          >
            {/* ⚠ Der Inhalt wird erst beim Öffnen GEBAUT: ein ECharts-Knoten in
                einer zugeklappten `details` misst 0 px Breite und rendert
                falsch, sobald er später sichtbar wird. */}
            {explorerOpen ? (
              <>
                <VerlaufExplorer
                  site={site}
                  range={range}
                  anchor={anchor}
                  initialTargets={init.targets}
                />
                <SiteMeasurementComparison siteId={site.id} />
              </>
            ) : null}
          </Aufklapper>
          {/* ⚠ Kontrolliert wie der Explorer darüber: nur so trägt der
              `summary` sein `aria-expanded` (der Aufklapper setzt es
              ausschliesslich im kontrollierten Betrieb — nativ sagt das
              `details` es selbst, aber die Fläche hatte es schon vor P3). */}
          <Aufklapper
            titel="Was diese Zahlen sind"
            open={fussOffen}
            onToggle={() => setFussOffen((o) => !o)}
          >
            <p className="vp-c-bild-erklaerung">{welt.fussText}</p>
          </Aufklapper>
        </div>
      </section>
    </>
  );
}
