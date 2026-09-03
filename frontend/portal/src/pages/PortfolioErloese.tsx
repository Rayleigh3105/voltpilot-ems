import { useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { fmtNum } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import { isCurrentPeriod } from '../energieBilanz';
import { historieHash } from '../historieWelten';
import { DASH, signedEuro } from '../erloesKomposition';
import { NETTO_WORT } from '../erloesNetto';
import { flottenZeilen } from '../erloesZeilen';
import { speicherAussage } from '../speicherAussage';
import { SteuerungFormel } from '../components/SteuerungFormel';
import { ErgebnisZeilen } from '../components/ErgebnisZeilen';
import { SpeicherKarte } from '../components/erloese/SpeicherKarte';
import {
  erloeseAggregat,
  flottenSatz,
  PORTFOLIO_WELTEN,
  portfolioRange,
  portfolioVergleich,
  SPEICHER_JE_ANLAGE,
  type ErloeseZeile,
} from '../portfolioHistorie';
import {
  usePortfolioErloese,
  useVergleichsErloesePortfolio,
} from '../usePortfolioHistorie';

import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { KartenKopf, PeriodeFehlgeschlagen } from '../components/HistorieWelt';
import {
  AbdeckungsSatz,
  AnlagenTabelle,
  MiniTrend,
  PortfolioWeltFuss,
  PortfolioWeltKopf,
  PortfolioZeitLeiste,
} from '../components/PortfolioWelt';
import { oeffneAnlagenWelt } from './portfolioWeltNav';

/**
 * **Portfolio · Welt B „Erlöse"** (`#/portfolio/erloese`) — das gemessene Geld
 * ALLER Anlagen in einem Zeitraum (PR G, Konzept `data/vp-historie-konzept-t4`
 * §4.3). Σ oben, Anlagen darunter, ein Klick öffnet die Erlöse-Welt DIESER
 * Anlage im GLEICHEN Zeitraum.
 *
 * Die Quelle ist der mandantenweite `GET /api/v1/earnings` — genau dafür
 * existiert er (die anlagen-scharfe Variante bleibt der Anlagen-Welt
 * vorbehalten, P3). Deshalb kennt diese Welt bewusst **keine Kalenderwoche**:
 * der Endpunkt kennt sie nicht, und eine Taste, die ins Leere führt, wäre
 * schlimmer als eine Taste weniger.
 *
 * **Zwei Regeln, die von der Anlagen-Welt eins zu eins gelten:** die gezeigten
 * Teile ERGEBEN die große Zahl, und der Beitrag der Steuerung ist eine
 * ZURECHNUNG darunter — nie ein weiterer Summand (er steckt schon darin).
 *
 * **Die große Zahl ist seit E9 / P9 das Ergebnis UNTERM STRICH** — dieselbe
 * Größe und dasselbe Wort wie auf der Anlagen-Seite, die ein Klick auf eine
 * Zeile öffnet (Erlöse-Konzept §2.3 B11/B12: die Flotte behauptete für
 * denselben Tag eine andere Zahl als jede einzelne Anlage darin). Der fehlende
 * Zeitraum „Woche" bleibt, was er war — eine Grenze der Quelle (siehe oben),
 * keine zweite Rechenart.
 */

/**
 * Die Spalten der Anlagen-Tabelle.
 *
 * ⚠ **„Speicher", nicht „Durch Steuerung"** (Befund **B13**): `savedEur` ist
 *   der Wert des GANZEN Speichersystems gegenüber einer Anlage ohne Speicher —
 *   der Anteil der intelligenten Steuerung daran ist eine ANDERE Zahl
 *   (`savedSteuerungEur`), die der Flotten-Endpunkt bewusst nicht als Summe
 *   führt. Das Wort ist dasselbe wie in der Speicher-Karte darüber und auf der
 *   Anlagen-Seite (`speicherAussage.gesamtLabel`).
 *
 * ⚠ **„Eingespeist" fällt am Telefon weg** (Skill-Regel „Table Handling", §3.7):
 *   unter 720 px klappt die Zeile zur Karte, und die vierte Zahl ist dort die
 *   am wenigsten gefragte. Das macht CSS (`.vp-pf-col-kwh`), nicht diese Liste —
 *   die Kopfzelle muss zu ihrer Datenzelle passen.
 */
const SPALTEN = ['Anlage', NETTO_WORT, 'Speicher', 'Eingespeist', 'Verlauf'] as const;

function Zeile({
  zeile,
  href,
  onOpen,
}: {
  zeile: ErloeseZeile;
  href: string;
  onOpen: () => void;
}) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td data-label="Anlage">
        <div className="vp-cell-main">
          <a
            href={href}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              onOpen();
            }}
          >
            <b>{zeile.name}</b>
          </a>
          {zeile.hinweis && <span className="vp-pf-row-note">{zeile.hinweis}</span>}
        </div>
      </td>
      <td className="num" data-label={NETTO_WORT}>
        <span className="vp-pf-v">
          {zeile.nettoEur == null ? DASH : signedEuro(zeile.nettoEur)}
        </span>
      </td>
      <td className="num" data-label="Speicher">
        <span className="vp-pf-v">
          {zeile.savedEur == null ? DASH : signedEuro(zeile.savedEur)}
        </span>
      </td>
      <td className="num vp-pf-col-kwh" data-label="Eingespeist">
        <span className="vp-pf-v">
          {zeile.eingespeistKwh == null ? DASH : fmtNum(zeile.eingespeistKwh, 'kWh')}
        </span>
      </td>
      <td data-label="Verlauf">
        <MiniTrend
          werte={zeile.spark}
          titel={`Ertrag von ${zeile.name} je Abschnitt`}
          farbe={chartTheme().price}
        />
      </td>
    </tr>
  );
}

export function PortfolioErloese({ sites }: { sites: Site[] }) {
  const welt = PORTFOLIO_WELTEN.erloese;
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(() => portfolioRange('erloese', init.range));
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  const at = isoDate(anchor);
  const { daten, loading, stale, err, retry } = usePortfolioErloese(range, at);
  const liste = useMemo(() => sites.map((s) => ({ id: s.id, name: s.name })), [sites]);
  const aggregat = useMemo(
    () => (daten ? erloeseAggregat(daten.sites, liste) : null),
    [daten, liste],
  );

  const vorherDaten = useVergleichsErloesePortfolio(
    range,
    anchor,
    !stale && aggregat != null && !aggregat.leer,
  );
  const vorher = useMemo(
    () => (vorherDaten ? erloeseAggregat(vorherDaten.sites, liste) : null),
    [vorherDaten, liste],
  );

  const now = new Date();
  const label = periodLabel(anchor, range);
  const laeuft = isCurrentPeriod(anchor, range, now);
  const kontext = `${sites.length} ${sites.length === 1 ? 'Anlage' : 'Anlagen'} · ${label}`;

  // DIE VIER ZEILEN DER FLOTTE — derselbe Wasserfall wie auf der Anlagen-Seite
  // (E2 = „beide"): Einspeise-Erlös + Eigenverbrauch − Netzbezug = Ergebnis.
  // Die frühere Prosa-Liste `vp-pf-teile` ist damit entfallen (Befund B13
  // „die drei Teile als Prosa"): sie trug drei Zahlen ohne Balken, ohne
  // Vorzeichen-Ton und in einer anderen Reihenfolge als die Anlagen-Seite.
  const zeilenView = useMemo(
    () =>
      flottenZeilen({
        einspeiseEur: aggregat?.einspeiseEur,
        eigenverbrauchEur: aggregat?.eigenverbrauchEur,
        stromkostenEur: aggregat?.stromkostenEur,
        nettoEur: aggregat?.nettoEur,
        periodLabel: label,
        laeuft,
        range,
      }),
    [aggregat, label, laeuft, range],
  );

  // DIE EINORDNUNG — nur mit gleich langen Grundlagen (E3, Befund B13).
  //
  // ⚠ Am laufenden Tag entscheidet AUSSCHLIESSLICH der Server-Wert
  //   (`daten.vergleich`, bis zur gleichen Berliner Stunde). Fehlt er, bleibt
  //   die Zeile WEG — die alte Seite schrieb dort „↑ 532 % mehr als am
  //   Vortag" über einen halben Tag.
  const vergleich = useMemo(
    () =>
      portfolioVergleich({
        range,
        anchor,
        now,
        server: daten?.vergleich ?? null,
        jetztEur: aggregat?.nettoEur,
        vorherEur: vorher?.nettoEur,
      }),
    // `now` ist absichtlich kein Anlass zum Neurechnen (es wechselt bei jedem
    // Rendern); die Grenze kommt vom Server bzw. aus dem Anker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, anchor, daten, aggregat, vorher],
  );

  // ⚠ Der Chip trägt KEINEN Farbton (W1 = a) und das WORT bleibt im Titel
  //   erreichbar — wortgleich zur Anlagen-Seite, damit derselbe Vergleich nicht
  //   zweimal anders aussieht.
  const einordnung = {
    betraege: vergleich?.betraege ?? null,
    chip: vergleich?.chip
      ? {
          text: `${vergleich.chip.pct} %`,
          richtung: vergleich.chip.richtung,
          titel: `${vergleich.chip.text} — ${vergleich.chip.titel}`,
        }
      : null,
    satz: vergleich?.satz ?? null,
  };

  // DIE SPEICHER-KARTE — dieselbe Ableitung wie Cockpit und Anlagen-Seite.
  //
  // ⚠ Der Wortlaut ist „Speicher heute" (`gesamtLabel`), NICHT „durch
  //   VoltPilots Steuerung" (Befund B13): `savedEur` ist der Wert des GANZEN
  //   Speichersystems. Die Zeile „davon Steuerung" bleibt hier per
  //   Konstruktion weg — der Flotten-Endpunkt führt die Aufteilung nicht als
  //   Summe, und `speicherAussage` behauptet ohne sie nichts.
  const speicher = useMemo(
    () =>
      speicherAussage(
        { savedEur: aggregat?.savedEur ?? null, range, to: daten?.to ?? null },
        { now, laeuft },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aggregat, range, daten, laeuft],
  );

  return (
    <>
      <PortfolioWeltKopf welt={welt} kontext={kontext} />
      <PortfolioZeitLeiste
        welt={welt}
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        now={now}
      />

      {/* ⚠ `vp-pf-erloes-body` trägt die Freistellung unter der KLEBENDEN
          Zeit-Leiste (gemessen bei 1440 px, siehe `PortfolioWelt.css`): der
          Portfolio-Kopf ist `vp-sr-only`, also hat die Leiste keine sichtbare
          Überschrift über sich und wird 68 px UNTER ihrem Fluss-Platz
          angeheftet. Bis P6 fing das die Polsterung der Summen-Karte auf;
          seit die Variante C das `Statement` ohne Rahmen auf den Grund
          setzt, lag sein Label vollständig hinter der Leiste. */}
      <div
        className={
          stale
            ? 'vp-welt-body vp-pf-erloes-body vp-welt-stale'
            : 'vp-welt-body vp-pf-erloes-body'
        }
      >
        {err && !aggregat ? (
          <ErrorState
            message="Die Erlöse Ihrer Anlagen konnten nicht geladen werden."
            onRetry={retry}
          />
        ) : !aggregat ? (
          loading ? (
            <Card padding="lg" radius="lg">
              <ChartCardSkeleton />
            </Card>
          ) : null
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            {/* DIE ERGEBNIS-FLÄCHE DER FLOTTE (Variante C, §3.10 Punkt 7:
                „Cockpit-Erlöskarte und Portfolio tragen dasselbe Kleid").

                Sie ist bewusst KEINE Karte mehr, sondern dieselben vier
                Bauteile wie eine Ebene tiefer: `Statement` ohne Rahmen auf dem
                Grund, `Kontoauszug` und `SpeicherKarte` als je EINE Karte. Der
                frühere `KartenKopf` (Icon-Kachel + Titel + Abzeichen) ist damit
                entfallen — sein Titel ist das Label des Statements, sein
                Abzeichen dessen Chip. „Preise & Vergütung" gibt es hier
                nicht: das Portfolio hat keinen EINEN Tarif. */}
            <section className="vp-section">
              {aggregat.nettoEur == null ? (
                <Card padding="lg" radius="lg" className="vp-pf-summenkarte">
                  <KartenKopf
                    icon="euro"
                    category="primary"
                    titel={`${NETTO_WORT} · ${label}`}
                    art="bewertet"
                  />
                  <EmptyState
                    icon="euro"
                    category="dynamic"
                    title="Noch kein Ergebnis für diesen Zeitraum"
                    description="Für keine Ihrer Anlagen liegen in diesem Zeitraum bewertete Viertelstunden vor. Sobald Messwerte und Preise da sind, steht hier, was Ihr Portfolio eingebracht hat."
                  />
                </Card>
              ) : (
                <ErgebnisZeilen
                  view={{
                    ...zeilenView,
                    satz: flottenSatz(
                      zeilenView.satz,
                      aggregat.zeilen.length - aggregat.ohneErgebnis,
                    ),
                  }}
                  label={`${NETTO_WORT} · ${label}`}
                  provenienz="bewertet"
                  einordnung={einordnung}
                  // Kein Aufklapper je Zeile: die Rechnung mit eingesetzten
                  // Zahlen gehört der ANLAGE (dort steht ihr Tarif). Ein
                  // Aufklapper, der „der Stromtarif der jeweiligen Anlage"
                  // sagen müsste, erklärt nichts (§3.3).
                  note={
                    <>
                      {/* Ehrlich statt still: eine Anlage ohne Ergebnis fehlt
                          in der Summe und wird GENANNT — sie zählt nicht als 0. */}
                      {aggregat.ohneErgebnis > 0 && (
                        <p className="vp-note">
                          {aggregat.ohneErgebnis === 1
                            ? 'Für eine Anlage liegt in diesem Zeitraum noch kein Ergebnis vor – sie fehlt in der Summe.'
                            : `Für ${aggregat.ohneErgebnis} Anlagen liegt in diesem Zeitraum noch kein Ergebnis vor – sie fehlen in der Summe.`}
                        </p>
                      )}
                      <AbdeckungsSatz abdeckung={aggregat.abdeckung} />
                    </>
                  }
                  speicher={
                    speicher?.hatAussage ? (
                      <SpeicherKarte aussage={speicher}>
                        {/* Statt einer erfundenen Flotten-Aufteilung der Ort,
                            an dem sie wirklich steht (SPEICHER_JE_ANLAGE). */}
                        <p className="vp-c-sp-sek vp-pf-sp-hinweis">
                          {SPEICHER_JE_ANLAGE}
                        </p>
                        {/* Im Portfolio gibt es keinen EINEN Tarif — die
                            Erklärung sagt deshalb „der Stromtarif der
                            jeweiligen Anlage" statt einer erfundenen Zahl. */}
                        <SteuerungFormel input={{ tarifneutral: true }} />
                      </SpeicherKarte>
                    ) : undefined
                  }
                />
              )}
            </section>

            <section className="vp-section">
              <AnlagenTabelle kopf={SPALTEN}>
                {aggregat.zeilen.map((z) => (
                  <Zeile
                    key={z.siteId}
                    zeile={z}
                    href={historieHash(z.siteId, 'erloese', range, at)}
                    onOpen={() => oeffneAnlagenWelt(z.siteId, 'erloese', range, at)}
                  />
                ))}
              </AnlagenTabelle>
            </section>
          </>
        )}
      </div>

      <PortfolioWeltFuss welt={welt} />
    </>
  );
}
