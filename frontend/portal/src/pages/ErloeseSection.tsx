import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import type { History, HistoryRange, PlantKind, ProtocolEvent, Site } from '../api';
import { eurAmount } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  keineVergleichsDatenText,
  normalisiereModus,
  ueberlagerungAktiv,
  ueberlagerungLegende,
  vergleichsKopf,
  wirksamerModus,
  type VergleichsModus,
} from '../historieVergleich';
import { mitVergleich, parseVergleichModus } from '../historieZeit';
import { erloesVergleich } from '../vergleichLaufend';
import {
  DASH,
  erloesAufklapper,
  erloesErgebnis,
  geplanteErsparnisNotiz,
  preisTreiber,
  type ErgebnisZeile,
  type PreisZeile,
} from '../erloesKomposition';
import { soVerdient } from '../soVerdient';
import {
  availableWelten,
  historieHash,
  weltSwitchCards,
  WELTEN,
  type WeltId,
} from '../historieWelten';
import { useHistoryPeriod } from '../useHistoryPeriod';
import { useIsPhone } from '../useIsPhone';
import { useSiteEarnings, useVergleichsErloese } from '../useSiteEarnings';
import type { AnlageSurface } from '../surface';
import { replaceCurrentNavigation } from '../navigationBlocker';

import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { Tagesbild, type TagesbildGeldReihe } from '../components/Tagesbild';
import {
  DeltaZeile,
  KartenKopf,
  PeriodeFehlgeschlagen,
  ProvBadge,
  WeltDisclosure,
  WeltFuss,
  WeltKopf,
  ZeitLeiste,
} from '../components/HistorieWelt';
import { ErloeseVerlaufChart } from '../components/ErloeseVerlaufChart';
import { SoVerdientCard } from '../components/SoVerdient';
import { SteuerungFormel } from '../components/SteuerungFormel';

import '../components/Historie.css';
import '../components/Erloese.css';
import { MiniShareBar } from '../components/MiniChart';

/**
 * **Welt B · „Erlöse"** (`#/anlage/{id}/erloese`) — die Geld-Welt der Historie
 * (Konzept `data/vp-historie-konzept-t4`, Captain-Struktur H1, Feature **F1**).
 *
 * **Der behobene Fehler war, dass der Tab „Erlöse" keine Erlöse enthielt:** er
 * zeigte zwei Zahlen — Stromkosten (eine KOSTEN-Größe) und die GEPLANTE
 * Speicher-Ersparnis — und für Woche/Monat/Jahr sonst nichts. Der gemessene
 * Erlös derselben Anlage existierte längst, nur eine Fläche weiter. Jetzt führt
 * die Welt mit ihm:
 *
 * 1. **Ergebnis** — die eine große Zahl (Einspeise-Erlös + Wert des
 *    Eigenverbrauchs − Stromkosten), die Zurechnung „davon durch die Steuerung"
 *    als Unterzeile (nie ein weiterer Summand) und das Δ zur Vorperiode.
 * 2. **Geld im Verlauf** — dieselben drei Teile über die Zeit, für JEDEN
 *    Zeitraum (bisher hing das Diagramm an `isDay`).
 * 3. **Was den Preis gemacht hat** — Ø Bezugspreis, erzielter Marktwert gegen
 *    den Monatsdurchschnitt, Marktprämie, Netzladen-Anteil.
 * 4. **Geplante Speicher-Ersparnis** — bleibt, aber mit eigenem Abzeichen
 *    „Geplant": eine Vorher-Rechnung steht nie unbeschriftet neben einer
 *    gemessenen Zahl (report §7).
 * 5. **Der Tag im Detail** — das Tagesbild (Preis · Speicher · Ertrag über
 *    EINER Zeitachse) + Tagesprotokoll.
 *
 * Zwei Abrufe, beide über ihren Cache: die Geld-Zahlen aus dem anlagen-scharfen
 * `GET /sites/{id}/earnings` (P3) und — nur für die geplante Ersparnis und den
 * Tag — die bestehende Historie-Antwort.
 */

const EVENT_ICONS: Record<ProtocolEvent['type'], { icon: IconName; label: string }> = {
  'batterie-laden': { icon: 'arrow-up', label: 'Laden' },
  'batterie-entladen': { icon: 'arrow-down', label: 'Entladen' },
  'pv-spitze': { icon: 'sun', label: 'PV' },
  'preis-tief': { icon: 'trending-down', label: 'Preis-Tief' },
  'preis-hoch': { icon: 'trending-up', label: 'Preis-Hoch' },
};

/**
 * Eine Zeile der Ergebnis-Komposition (Punkt · Name · Operator · Betrag). Das
 * Perioden-Etikett steht NUR, wenn der Stapel wirklich mehrere Perioden mischt
 * — sonst sagt es die Überschrift der Karte schon.
 */
function KompositionsZeile({ row, zeigePeriode }: { row: ErgebnisZeile; zeigePeriode: boolean }) {
  return (
    <li className={row.eur == null ? 'vp-ekomp-row vp-ekomp-off' : 'vp-ekomp-row'}>
      <span className="vp-ekomp-dot" style={{ background: row.hue }} aria-hidden="true" />
      <span className="vp-ekomp-name">
        {row.label}
        {zeigePeriode && <span className="vp-ekomp-period">{row.periodLabel}</span>}
      </span>
      <MiniShareBar className="vp-ekomp-bar" fraction={row.barFraction} color={row.hue} />
      <span className="vp-ekomp-value">
        {row.eur != null && (
          <span className="vp-ekomp-sign" aria-hidden="true">
            {row.vorzeichen === 'minus' ? '−' : '+'}
          </span>
        )}
        <span className="vp-ekomp-amount">{row.valueText}</span>
      </span>
      {row.note && <span className="vp-ekomp-note">{row.note}</span>}
    </li>
  );
}

/**
 * „Was den Preis gemacht hat" — der KÖRPER, ohne Karte.
 *
 * Er ist herausgelöst, weil ihn beide Fassungen brauchen: am Schreibtisch in
 * seiner eigenen Karte, am Telefon im Aufklapper. **Ein zweiter Renderer wäre
 * eine zweite Wahrheit** — die Zeilen selbst kommen ohnehin aus dem einen
 * `preisTreiber()`.
 */
function PreisTreiberBody({ zeilen }: { zeilen: PreisZeile[] }) {
  return (
    <ul className="vp-preistreiber">
      {zeilen.map((z) => (
        <li key={z.id} className={z.vorhanden ? undefined : 'vp-pt-off'}>
          <span className="vp-pt-wert">{z.wert}</span>
          <span className="vp-pt-label">{z.label}</span>
          {z.note && <span className="vp-pt-note">{z.note}</span>}
          {z.hinweise.map((h) => (
            <span key={h} className="vp-pt-hint">
              {h}
            </span>
          ))}
          {z.href && (
            <a className="vp-pt-link" href={z.href}>
              Zu den Einstellungen
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Der Tagesnachweis — seit Stufe 3 das TAGESBILD: drei Flächen über EINER
 * Zeitachse statt eines Einzelbilds mit drei Y-Achsen (F8 verschärft).
 *
 * Das gemessene Geld reist mit, weil daraus die dritte Fläche („was dabei
 * herauskommt") und der Vergleichsanker im Kopf entstehen — es ist DASSELBE
 * `money`, mit dem die Ergebnis-Karte darüber rechnet, also kann das Bild ihr
 * nicht widersprechen. Fehlt es, entfällt die Fläche ehrlich.
 */
function TagesbildBody({ history, geld, plantKind }: TagesbildBodyProps) {
  return (
    <>
      <ChartSubtitle>
        Der ganze Tag in drei Flächen über einer Zeitachse: was Strom gekostet hat,
        was Ihre Anlage damit gemacht hat und was dabei herausgekommen ist.
      </ChartSubtitle>
      <Tagesbild history={history} geld={geld} plantKind={plantKind} />
    </>
  );
}

interface TagesbildBodyProps {
  history: History;
  geld: TagesbildGeldReihe | null;
  plantKind: PlantKind;
}

/** Das Tagesprotokoll — der Körper, ohne Karte. */
function TagesprotokollBody({ history }: { history: History }) {
  if (history.protocol.length === 0) {
    return (
      <p className="vp-muted">
        Keine besonderen Ereignisse an diesem Tag - keine nennenswerte
        Batterie-Aktivität, PV-Erzeugung oder Preisspreizung erkannt.
      </p>
    );
  }
  return (
    <>
      <ul className="vp-timeline">
        {history.protocol.map((e, i) => {
          const fmt = (iso: string) =>
            new Date(iso).toLocaleTimeString('de-DE', {
              hour: '2-digit',
              minute: '2-digit',
            });
          const oneSlot = new Date(e.end).getTime() - new Date(e.start).getTime() <= 15 * 60000;
          return (
            <li key={`${e.type}-${e.start}-${i}`}>
              <span className="t">
                {oneSlot ? fmt(e.start) : `${fmt(e.start)} - ${fmt(e.end)}`}
              </span>
              <span className="ico" aria-hidden="true">
                {EVENT_ICONS[e.type] ? <Icon name={EVENT_ICONS[e.type].icon} size={16} /> : null}
              </span>
              <span className="txt">{e.text}</span>
            </li>
          );
        })}
      </ul>
      <p className="vp-note" style={{ marginTop: 12 }}>
        Automatisch aus Messwerten und Börsenpreisen des Tages abgeleitet.
      </p>
    </>
  );
}

export function ErloeseSection({
  site,
  surface,
  onOpenWelt,
}: {
  site: Site;
  surface?: AnlageSurface | null;
  onOpenWelt: (welt: WeltId) => void;
}) {
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(init.range);
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  // F8: der Vergleichs-Zustand reist in der Adresse (`v=`) - derselbe Parameter
  // wie in der Messwerte-Welt, also nimmt der Welt-Wechsel ihn mit.
  const [modusWahl, setModusWahl] = useState<VergleichsModus>(() =>
    parseVergleichModus(window.location.hash),
  );

  const isPhone = useIsPhone();
  // Der Zustand der Aufklapper lebt in der Sitzung dieser Fläche (das
  // Technik-Muster) - wer eine Erklärung geöffnet hat, findet sie beim
  // Zeitraum-Wechsel offen wieder.
  const [offen, setOffen] = useState<ReadonlySet<string>>(() => new Set());
  const toggleAufklapper = useCallback((id: string) => {
    setOffen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const at = isoDate(anchor);
  // Das Geld dieser Anlage - ein Abruf, eine Anlage, ein Zeitraum (P3).
  const { money, loading, stale, err, retry } = useSiteEarnings(site.id, range, at);
  // Die Historie-Antwort trägt hier nur noch die GEPLANTE Ersparnis und den Tag
  // (Speicher & Preis, Tagesprotokoll) - und die Datenlage der Zeit-Leiste.
  const { history } = useHistoryPeriod(site.id, range, at);
  // F3: der zweite Abruf mit verschobenem Anker - erst, wenn der gezeigte
  // Zeitraum überhaupt Zahlen trägt.
  const modus = normalisiereModus(modusWahl, anchor, range, history?.coverage);
  const vorher = useVergleichsErloese(
    site.id,
    range,
    anchor,
    !stale && money?.nettoErgebnisEur != null,
    wirksamerModus(modus),
  );
  // Ehrlich statt leer: eine Vergleichsperiode ohne bewertete Viertelstunden
  // wird GESAGT, nicht als Null-Linie gezeichnet.
  const vergleichSerie =
    ueberlagerungAktiv(modus) && (vorher?.series.length ?? 0) > 0 ? vorher!.series : null;
  const vergleichHinweis =
    ueberlagerungAktiv(modus) && vorher != null && vorher.series.length === 0
      ? keineVergleichsDatenText(anchor, range, modus)
      : null;

  const setModus = useCallback(
    (m: VergleichsModus) => {
      setModusWahl(m);
      replaceCurrentNavigation(mitVergleich(historieHash(site.id, 'erloese', range, at), m));
    },
    [site.id, range, at],
  );

  // Zurück/Vorwärts oder ein Sprung mit Zeitraum: die Periode neu übernehmen.
  useEffect(() => {
    const onHash = () => {
      const p = parseVerlaufParams(window.location.hash);
      setModusWahl(parseVergleichModus(window.location.hash));
      setRange(p.range);
      setAnchor(p.at ? new Date(`${p.at}T12:00:00`) : new Date());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const welt = WELTEN.erloese;
  const available = availableWelten(surface);
  const label = periodLabel(anchor, range);
  const now = new Date();
  const isDay = range === 'day';

  const ergebnis = erloesErgebnis({ money, periodLabel: label, kurzerTitel: isPhone });
  // Das Kombinations-Bild — `null` auf einer nicht direkt vermarkteten Anlage
  // (S9): dort bleibt die Welt byte-gleich wie bisher.
  const verdient = soVerdient({ money, siteId: site.id });
  const preise = preisTreiber({
    money,
    netzladenErlaubt: site.netzladenErlaubt,
    siteId: site.id,
    // Absorbieren statt doppeln: die Karte sagt selbst, welche Zeilen sie
    // übernommen hat — dieselbe Wahrheit steht nie zweimal auf einer Seite.
    ohne: verdient?.absorbiert,
  });
  // Die dritte Fläche des Tagesbilds („was dabei herauskommt") und sein
  // Vergleichsanker im Kopf kommen aus DEMSELBEN `money`, mit dem die
  // Ergebnis-Karte darüber rechnet - es gibt keinen zweiten Geld-Rechner, also
  // kann das Bild der großen Zahl nicht widersprechen.
  const tagesGeld: TagesbildGeldReihe | null = money
    ? {
        savedEur: money.savedEur,
        baselineEur: money.baselineEur,
        actualEur: money.actualEur,
        // Das Bestandskonto reist mit, damit der Kopf des Tagesbilds und die
        // Ergebnis-Karte darüber DIESELBE Bestandszeile ableiten.
        speicherDeltaKwh: money.speicherDeltaKwh,
        speicherWertCtKwh: money.speicherWertCtKwh,
        speicherWertEur: money.speicherWertEur,
        speicherWertBasis: money.speicherWertBasis,
        to: money.to,
        range: money.range,
        series: money.series,
      }
    : null;
  // Am Telefon bleibt der Kartenkopf EINE Zeile (sonst rutscht der Titel auf
  // „Ergebni…"); WELCHER Zeitraum verglichen wird, sagen die Zeilen darunter
  // ohnehin („etwa wie am Vortag" bzw. „· gestern 67,57 €").
  const kopfVergleich =
    vorher && !isPhone ? (
      <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range, modus)}</span>
    ) : undefined;
  // P2 (E3): ein LAUFENDER Tag wird gegen die GLEICHE Stunde des Vortags
  // gerechnet, nicht gegen den vollen Vortag (Befund B3) - die Ableitung liegt
  // rein in `vergleichLaufend.ts` und liefert Chip, Beträge und den Erklärsatz
  // fertig; ein abgeschlossener Zeitraum bekommt unverändert sein `delta()`.
  const vergleich = erloesVergleich({
    range,
    anchor,
    now,
    modus,
    jetztEur: money?.nettoErgebnisEur,
    vorherEur: vorher?.nettoErgebnisEur,
    jetztSeries: money?.series,
    vorherSeries: vorher?.series,
  });
  // Welche Aufklapper es am Telefon gibt - ein Aufklapper ohne Karte dahinter
  // wäre ein Versprechen ins Leere.
  const aufklapper = erloesAufklapper({
    hatSoVerdient: verdient != null,
    hatPreisTreiber: preise.length > 0,
    istTag: isDay,
    hatTagesdaten: history != null,
  });
  const geplant = geplanteErsparnisNotiz(history?.totals.batterySavingsPlannedEur, label);

  // Der Ton kommt aus der Ableitung (E8/B2) - der Renderer faerbt, er urteilt
  // nicht: gruen nur bei einem Plus, Bernstein nur bei einem abgeschlossenen
  // Minus, sonst neutral. Ein aelterer Stand ohne `steeringTon` bleibt gruen.
  const steeringZeile = ergebnis.steering ? (
    <>
      <p
        className={`vp-erg-steering vp-erg-steering-${ergebnis.steeringTon ?? 'ok'}`}
        title={ergebnis.steeringTitel ?? undefined}
      >
        <Icon name="zap" size={14} aria-hidden="true" />
        {ergebnis.steering}
      </p>
      {/* Die Rechnung hinter dem Chip - dieselbe Erklaerung wie im Cockpit
          (Captain 01.09.2026), zugeklappt genau EINE ruhige Zeile. */}
      {ergebnis.steeringFormel && <SteuerungFormel input={ergebnis.steeringFormel} />}
    </>
  ) : null;
  // Das BESTANDSKONTO steht NEBEN der Zurechnung, nie in der grossen Zahl:
  // die gemessene Kasse kennt eingelagerte Energie nur als entgangenen Erlös
  // (Diagnose vp-tagesbild-minus-f3). Eigene Zeile, eigenes Etikett.
  const bestandZeileEl = ergebnis.bestand ? (
    <p className="vp-erg-bestand" title={ergebnis.bestand.titel ?? undefined}>
      {/* Icon UND Satz sind EIN Flex-Kind: sonst rutscht das Symbol am Telefon
          allein in eine eigene Zeile (bei 375 px gemessen). */}
      <span className="vp-erg-bestand-satz">
        <Icon name="battery" size={14} aria-hidden="true" />
        {ergebnis.bestand.text}
      </span>
      {ergebnis.bestand.badge && (
        <span className="vp-erg-bestand-badge">{ergebnis.bestand.badge}</span>
      )}
    </p>
  ) : null;
  // Revision 2 (§3.12): auf Ebene 0 steht der Vergleich als CHIP („25 %
  // weniger") und nur, wenn er abweicht; die Beträge stehen ruhig darunter, der
  // Erklärsatz („bis 12 Uhr, der Vortag ebenso") ist der Satz, den die
  // Ergebnis-Karte (P3/P4) in ihr Akkordeon übernimmt.
  const vergleichsZeilen = (
    <>
      {vergleich?.chip && (
        <p className="vp-kpi-delta">
          <DeltaZeile delta={vergleich.chip} />
        </p>
      )}
      {vergleich?.betraege && <p className="vp-erg-vergleich">{vergleich.betraege}</p>}
      {vergleich?.satz && <p className="vp-note vp-note-laufend">{vergleich.satz}</p>}
    </>
  );

  return (
    <>
      <WeltKopf
        welt={welt}
        cards={weltSwitchCards('erloese', available)}
        hrefFor={(c) => mitVergleich(historieHash(site.id, c.welt.id, range, at), modus)}
        onOpen={(c) => onOpenWelt(c.welt.id)}
      />
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
        {err && !money ? (
          <ErrorState
            message={`Die Erlöse konnten nicht geladen werden (${err}).`}
            onRetry={retry}
          />
        ) : !money ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton />
            </Card>
          ) : null
        ) : (
          <>
            {err && stale && (
              <PeriodeFehlgeschlagen periode={label} onRetry={retry} />
            )}

            {/* Karte 1 - das Ergebnis des Zeitraums samt seiner Herkunft. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="euro"
                  category="primary"
                  titel={ergebnis.titel}
                  art="bewertet"
                  extra={kopfVergleich}
                />
                {ergebnis.nettoEur == null ? (
                  <EmptyState
                    icon="euro"
                    category="dynamic"
                    title="Noch kein Ergebnis für diesen Zeitraum"
                    description={
                      ergebnis.leerText ??
                      'Sobald Messwerte und Preise vorliegen, steht hier, was Ihre Anlage eingebracht hat.'
                    }
                  />
                ) : (
                  <>
                    <p
                      className={`vp-erg-netto vp-erg-${ergebnis.richtung ?? 'ertrag'}`}
                      title={ergebnis.nettoSatz}
                    >
                      {ergebnis.nettoText}
                    </p>
                    <p className="vp-erg-satz">{ergebnis.nettoSatz}</p>
                    {/* **Der Falz ist die Antwort.** Am Telefon stehen die drei
                        Zeilen, die die Zahl ERGEBEN, direkt unter ihr; die
                        Einordnung (Zurechnung, Δ, laufende Periode) folgt
                        danach. Am Schreibtisch bleibt die gewachsene Ordnung —
                        dort steht ohnehin alles gemeinsam im Bild. */}
                    {!isPhone && steeringZeile}
                    {!isPhone && bestandZeileEl}
                    {!isPhone && vergleichsZeilen}
                    {/* Die Herkunft der großen Zahl - nur, wenn es eine gibt;
                        eine Liste aus lauter „—" erklärt nichts. */}
                    <ul className="vp-ekomp" aria-label="Woraus sich das Ergebnis zusammensetzt">
                      {ergebnis.rows.map((row) => (
                        <KompositionsZeile
                          key={row.id}
                          row={row}
                          zeigePeriode={ergebnis.mehrerePerioden}
                        />
                      ))}
                    </ul>
                    {isPhone && steeringZeile}
                    {isPhone && bestandZeileEl}
                    {isPhone && vergleichsZeilen}
                    {ergebnis.periodNote && <p className="vp-note">{ergebnis.periodNote}</p>}
                    {ergebnis.footnote && <p className="vp-note">{ergebnis.footnote}</p>}
                  </>
                )}
              </Card>
            </section>

            {/* „Ist das gut?" — die Antwort gehört direkt hinter die
                „Wie viel?"-Antwort. Nur direkt vermarktete Anlagen; alle
                anderen sehen die Welt unverändert. Am Telefon wird sie zum
                benannten Aufklapper (unten). */}
            {!isPhone && verdient && <SoVerdientCard view={verdient} />}

            {/* Karte 2 - dieselben Teile über die Zeit, für JEDEN Zeitraum. */}
            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="trending-up"
                  category="dynamic"
                  titel={`Geld im Verlauf · ${label}`}
                  art="bewertet"
                />
                <ErloeseVerlaufChart
                  series={money.series}
                  range={range}
                  vergleich={vergleichSerie}
                  legende={ueberlagerungLegende(anchor, range, modus)}
                />
              </Card>
            </section>

            {isPhone ? (
              <>
                {/* **Alles Erklärende wird ein benannter Aufklapper** (Konzept
                    §6): der Falz gehört dem Ergebnis, und „Speicher & Preis"
                    samt drei Absätzen lag bisher täglich bei 4 867 px im
                    Scrollweg. Geöffnet steht der VOLLE Inhalt samt Abzeichen
                    darin — nichts wird gekürzt, nur einsortiert. */}
                {aufklapper.map((a) => (
                  <WeltDisclosure
                    key={a.id}
                    titel={a.titel}
                    sub={a.sub}
                    open={offen.has(a.id)}
                    onToggle={() => toggleAufklapper(a.id)}
                  >
                    {a.id === 'so-verdient' && verdient && <SoVerdientCard view={verdient} />}
                    {a.id === 'preis-treiber' && (
                      <>
                        <ProvBadge art="bewertet" />
                        <PreisTreiberBody zeilen={preise} />
                      </>
                    )}
                    {a.id === 'speicher-preis' && history && (
                      <>
                        <ProvBadge art="gemessen" />
                        <TagesbildBody history={history} geld={tagesGeld} plantKind={site.plantKind} />
                      </>
                    )}
                    {a.id === 'tagesprotokoll' && history && (
                      <>
                        <ProvBadge art="bewertet" />
                        <TagesprotokollBody history={history} />
                      </>
                    )}
                  </WeltDisclosure>
                ))}

                {/* Die GEPLANTE Ersparnis bleibt sichtbar, verliert aber ihren
                    Karten-Rang: als gleichrangige Karte neben dem gemessenen
                    Ergebnis ist sie die dokumentierte Verwechslungs-Falle
                    dieser Seite. Das Abzeichen „Geplant" bleibt wörtlich. */}
                <p className={geplant.vorhanden ? 'vp-geplant-notiz' : 'vp-geplant-notiz is-leer'}>
                  <span className="vp-prov vp-prov-geplant">{geplant.badge}</span>
                  <b>{geplant.wertText}</b>
                  <span>{geplant.satz}</span>
                </p>
              </>
            ) : (
              <>
                {/* Karte 3 - die Preise hinter dem Ergebnis. */}
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <KartenKopf
                      icon="euro"
                      category="industry"
                      titel="Was den Preis gemacht hat"
                      art="bewertet"
                    />
                    <PreisTreiberBody zeilen={preise} />
                  </Card>
                </section>

                {/* Geplant: die Vorher-Rechnung des Optimierers - eigene Karte,
                    eigenes Abzeichen, damit sie nie als gemessene Ersparnis gilt. */}
                <section className="vp-section">
                  <Card padding="lg" radius="lg">
                    <KartenKopf
                      icon="battery-charging"
                      category="battery"
                      titel={`Geplante Speicher-Ersparnis · ${label}`}
                      art="geplant"
                    />
                    <p className="vp-erg-plan">
                      {history?.totals.batterySavingsPlannedEur == null
                        ? DASH
                        : eurAmount(history.totals.batterySavingsPlannedEur)}
                    </p>
                    <p className="vp-note">
                      {history?.totals.batterySavingsPlannedEur == null
                        ? 'Für diesen Zeitraum liegt kein Batterie-Fahrplan vor - die geplante Ersparnis erscheint, sobald geplant wird.'
                        : 'Vorab geplant, nicht gemessen: der gemessene Beitrag der Steuerung steht oben im Ergebnis. Beide dürfen deutlich voneinander abweichen.'}
                    </p>
                  </Card>
                </section>

                {/* Tagesansicht: der Nachweis - was der Speicher wirklich getan hat. */}
                {isDay && history && (
                  <section className="vp-section">
                    <Card padding="lg" radius="lg">
                      <KartenKopf
                        icon="battery"
                        category="battery"
                        titel="Der Tag im Bild"
                        art="gemessen"
                        extra={
                          history.plan.length > 0 ? (
                            <Badge variant="tint">Plan &amp; Ist</Badge>
                          ) : (
                            <Badge variant="off">kein Plan</Badge>
                          )
                        }
                      />
                      <TagesbildBody history={history} geld={tagesGeld} plantKind={site.plantKind} />
                    </Card>
                  </section>
                )}

                {/* Tagesprotokoll (nur Tag): der Tag in deutschen Sätzen. */}
                {isDay && history && (
                  <section className="vp-section">
                    <Card padding="lg" radius="lg">
                      <KartenKopf icon="list" category="home" titel="Tagesprotokoll" art="bewertet" />
                      <TagesprotokollBody history={history} />
                    </Card>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>

      <WeltFuss welt={welt} />
    </>
  );
}
