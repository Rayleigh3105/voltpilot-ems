import { useMemo, useState } from 'react';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { NBSP } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import { isCurrentPeriod } from '../energieBilanz';
import { laufendHinweis, vergleichsKopf, vergleichsName } from '../historieVergleich';
import { historieHash } from '../historieWelten';
import { messwerteZeilen } from '../messwerteZeilen';
import {
  messwerteAggregat,
  PORTFOLIO_TABELLE_KEYS,
  PORTFOLIO_WELTEN,
  portfolioRange,
  type MesswerteZeile,
} from '../portfolioHistorie';
import { usePortfolioHistorie, useVergleichsHistorie } from '../usePortfolioHistorie';
import { useIsPhone } from '../useIsPhone';

import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { DeltaZeile, PeriodeFehlgeschlagen } from '../components/HistorieWelt';
import { VerlaufKarte } from '../components/VerlaufKarte';
import { VerlaufLedger, type VerlaufLedgerZeile } from '../components/VerlaufLedger';
import {
  AbdeckungsSatz,
  AnlagenBlock,
  PortfolioWeltFuss,
  PortfolioWeltKopf,
  PortfolioZeitLeiste,
  type AnlagenZeileView,
} from '../components/PortfolioWelt';
import { oeffneAnlagenWelt } from './portfolioWeltNav';

/**
 * **Portfolio · Welt A „Messwerte"** (`#/portfolio/messwerte`) — die Basis-Welt
 * der Historie eine Ebene höher (PR G, Konzept `data/vp-historie-konzept-t4`
 * §4.3). Σ oben, Anlagen darunter, ein Klick öffnet DIESELBE Welt DIESER Anlage
 * im GLEICHEN Zeitraum.
 *
 * Sie rechnet nichts Eigenes: je Anlage läuft derselbe `/history`-Abruf durch
 * denselben Cache wie die Anlagen-Welt, und die Summen entstehen über denselben
 * reinen Kern (`energieBilanz.energieSummen`). Was hier NEU ist, ist die
 * Ehrlichkeit der Ebene: eine Anlage ohne Messwerte fließt nicht als Null in
 * die Summe, sondern steht mit ihrem Grund in der Tabelle — und die Summe sagt,
 * über wie viele Anlagen sie spricht.
 */

function kwh(v: number | null | undefined): string {
  return v == null
    ? '—'
    : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}${NBSP}kWh`;
}

/** Die vier Zahlen-Spalten der Anlagen-Liste — „Anlage" und „Verlauf" sind
 *  die zwei festen Ränder und stehen im Baustein. */
const SPALTEN = ['Erzeugt', 'Verbraucht', 'Bezogen', 'Eingespeist'] as const;

/** Eine Anlagen-Zeile in der geteilten Form beider Zwillinge (Liste/Tabelle). */
function anlagenZeile(z: MesswerteZeile, range: HistoryRange, at: string): AnlagenZeileView {
  return {
    id: z.siteId,
    name: z.name,
    hinweis: z.hinweis,
    href: historieHash(z.siteId, 'messwerte', range, at),
    onOpen: () => oeffneAnlagenWelt(z.siteId, 'messwerte', range, at),
    werte: PORTFOLIO_TABELLE_KEYS.map((_, i) => kwh(z.werte[i])),
    spark: z.spark,
    sparkTitel: `PV-Erzeugung von ${z.name} je Abschnitt`,
    sparkFarbe: chartTheme().pv,
  };
}

export function PortfolioMesswerte({ sites }: { sites: Site[] }) {
  const welt = PORTFOLIO_WELTEN.messwerte;
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(() => portfolioRange('messwerte', init.range));
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

  const isPhone = useIsPhone();
  const at = isoDate(anchor);
  const liste = useMemo(() => sites.map((s) => ({ id: s.id, name: s.name })), [sites]);
  const { daten, loading, stale, err, retry } = usePortfolioHistorie(liste, range, at);
  const aggregat = useMemo(() => (daten ? messwerteAggregat(daten) : null), [daten]);

  // Δ zur Vorperiode - erst, wenn der gezeigte Zeitraum überhaupt Zahlen trägt.
  const vorherDaten = useVergleichsHistorie(
    liste,
    range,
    anchor,
    !stale && aggregat != null && !aggregat.leer,
  );
  const vorher = useMemo(
    () => (vorherDaten ? messwerteAggregat(vorherDaten) : null),
    [vorherDaten],
  );

  const now = new Date();
  const label = periodLabel(anchor, range);
  const vergleichName = vergleichsName(anchor, range);
  const laufend = vorher ? laufendHinweis(anchor, range, now) : null;
  const kontext = `${sites.length} ${sites.length === 1 ? 'Anlage' : 'Anlagen'} · ${label}`;
  // Ein laufender Zeitraum sagt das am Label — die Zahlen sind ein
  // Zwischenstand, kein Ergebnis (wortgleich zum Anlagen-Reiter).
  const zwischenstand = isCurrentPeriod(anchor, range, now);

  // ⚠ DIESELBE Ableitung wie der Anlagen-Reiter (E1 b): `PortfolioSumme` ist
  //   eine `EnergieSumme` plus dem Zähler „wie viele Anlagen" — die sechs
  //   Zeilen, ihre Balken, ihre Gründe und ihr Δ entstehen deshalb in
  //   `messwerteZeilen.ts` und nirgends ein zweites Mal.
  const zeilen: VerlaufLedgerZeile[] = useMemo(() => {
    if (!aggregat) return [];
    return messwerteZeilen(aggregat.summen, vorher ? vorher.summen : null, vergleichName).map(
      (z) => ({
        id: z.key,
        name: z.name,
        wert: z.wert,
        anteil: z.anteil,
        farbe: z.farbe,
        hinweis: z.hinweis,
        // Der Grund gewinnt gegen das Δ: eine Zeile ohne Wert hat auch keinen
        // Vergleich, und der Grund ist die Auskunft, die fehlt.
        sekundaer: z.grund ? z.grund : z.delta ? <DeltaZeile delta={z.delta} /> : undefined,
      }),
    );
  }, [aggregat, vorher, vergleichName]);

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

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {/* V10 (Paket P2b/P8): die drei Zustände leben IN der Karte und
            reservieren den Platz des späteren Inhalts — beim Zeitraumwechsel
            springt damit nichts. */}
        {err && !aggregat ? (
          <div className="vp-c-card">
            <VerlaufFehler
              satz="Die Messwerte Ihrer Anlagen konnten nicht geladen werden."
              onRetry={retry}
            />
          </div>
        ) : !aggregat ? (
          loading ? (
            <div className="vp-c-card">
              <VerlaufKarteSkeleton chart={false} legende={false} />
            </div>
          ) : null
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            <VerlaufKarte
              label={`Energie aller Anlagen · ${label}`}
              provenienz="gemessen"
              chip={
                <>
                  {zwischenstand && <span className="vp-chip">Zwischenstand</span>}
                  {/* ⚠ Der Vergleichs-Kopf bleibt dem Rechner — wortgleich zur
                      Regel des Anlagen-Reiters (P3): am Telefon stünden zwei
                      Chips neben einem langen Label und schöben es 119 px über
                      den Rand (bei 375 px gemessen). Der Vergleich steht in
                      jeder Δ-Zeile darunter beim Namen. */}
                  {vorher && !isPhone && (
                    <span className="vp-chip">{vergleichsKopf(anchor, range)}</span>
                  )}
                </>
              }
            >
              {aggregat.leer ? (
                <VerlaufLeer
                  label="Keine Messwerte in diesem Zeitraum"
                  satz="Keine Ihrer Anlagen hat in diesem Zeitraum gemessen. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
                />
              ) : (
                <>
                  <VerlaufLedger zeilen={zeilen} label="Energiemengen aller Anlagen" />
                  {laufend && <p className="vp-c-note">{laufend}</p>}
                  <AbdeckungsSatz abdeckung={aggregat.abdeckung} />
                </>
              )}
            </VerlaufKarte>

            <AnlagenBlock
              label="Anlagen"
              kopf={SPALTEN}
              zeilen={aggregat.zeilen.map((z) => anlagenZeile(z, range, at))}
            />
          </>
        )}
      </div>

      <PortfolioWeltFuss welt={welt} />
    </>
  );
}
