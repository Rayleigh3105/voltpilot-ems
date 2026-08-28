import { useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { NBSP } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import type { EnergieFarbe } from '../energieBilanz';
import {
  delta,
  ENERGIE_WERTUNG,
  laufendHinweis,
  vergleichsKopf,
  vergleichsName,
} from '../historieVergleich';
import { historieHash } from '../historieWelten';
import {
  hatGeldWelt,
  messwerteAggregat,
  PORTFOLIO_TABELLE_KEYS,
  PORTFOLIO_WELTEN,
  portfolioHash,
  portfolioRange,
  type MesswerteZeile,
  type PortfolioSumme,
} from '../portfolioHistorie';
import { usePortfolioHistorie, useVergleichsHistorie } from '../usePortfolioHistorie';

import { ChartCardSkeleton, EmptyState, ErrorState } from '../components/States';
import { DeltaZeile, KartenKopf, PeriodeFehlgeschlagen } from '../components/HistorieWelt';
import {
  AbdeckungsSatz,
  AnlagenTabelle,
  MiniTrend,
  PortfolioWeltFuss,
  PortfolioWeltKopf,
  PortfolioZeitLeiste,
} from '../components/PortfolioWelt';
import { portfolioSwitchCards, oeffnePortfolioWelt, oeffneAnlagenWelt } from './portfolioWeltNav';

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

/** Der reine `EnergieFarbe`-Schlüssel → die aufgelöste Diagrammfarbe (die Punkte). */
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

/** Eine Summen-Kachel des Portfolios — dieselbe Kachel wie in der Anlagen-Welt. */
function SummeTile({
  summe,
  vergleichKwh,
  vergleichName,
}: {
  summe: PortfolioSumme;
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

const SPALTEN = ['Anlage', 'Erzeugt', 'Verbraucht', 'Bezogen', 'Eingespeist', 'Verlauf'] as const;

function Zeile({
  zeile,
  href,
  onOpen,
}: {
  zeile: MesswerteZeile;
  href: string;
  onOpen: () => void;
}) {
  return (
    <tr className="clickable" onClick={onOpen}>
      <td data-label="Anlage">
        <div className="vp-cell-main">
          {/* Ein echter Link: Tastatur, Mittelklick und „in neuem Tab öffnen"
              funktionieren, die ganze Zeile bleibt trotzdem klickbar. */}
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
      {PORTFOLIO_TABELLE_KEYS.map((key, i) => (
        <td key={key} className="num" data-label={SPALTEN[i + 1]}>
          <span className="vp-pf-v">{kwh(zeile.werte[i])}</span>
        </td>
      ))}
      <td data-label="Verlauf">
        <MiniTrend
          werte={zeile.spark}
          titel={`PV-Erzeugung von ${zeile.name} je Abschnitt`}
          farbe={chartTheme().pv}
        />
      </td>
    </tr>
  );
}

export function PortfolioMesswerte({ sites }: { sites: Site[] }) {
  const welt = PORTFOLIO_WELTEN.messwerte;
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(() => portfolioRange('messwerte', init.range));
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );

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

  return (
    <>
      <PortfolioWeltKopf
        welt={welt}
        cards={portfolioSwitchCards('messwerte', hatGeldWelt(sites))}
        kontext={kontext}
        hrefFor={(c) => portfolioHash(c.welt.id, range, at)}
        onOpen={(c) => oeffnePortfolioWelt(c.welt.id, range, at)}
      />
      <PortfolioZeitLeiste
        welt={welt}
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        now={now}
      />

      <div className={stale ? 'vp-welt-body vp-welt-stale' : 'vp-welt-body'}>
        {err && !aggregat ? (
          <ErrorState
            message="Die Messwerte Ihrer Anlagen konnten nicht geladen werden."
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

            <section className="vp-section">
              <Card padding="lg" radius="lg">
                <KartenKopf
                  icon="zap"
                  titel={`Energie aller Anlagen · ${label}`}
                  art="gemessen"
                  extra={
                    vorher ? (
                      <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range)}</span>
                    ) : undefined
                  }
                />
                {aggregat.leer ? (
                  <EmptyState
                    icon="history"
                    category="dynamic"
                    title="Keine Messwerte in diesem Zeitraum"
                    description="Keine Ihrer Anlagen hat in diesem Zeitraum gemessen. Wählen Sie einen anderen Zeitraum oder schauen Sie später wieder vorbei."
                  />
                ) : (
                  <>
                    <div className="vp-energie-summen" aria-label="Energiemengen aller Anlagen">
                      {aggregat.summen.map((s, i) => (
                        <SummeTile
                          key={s.key}
                          summe={s}
                          vergleichKwh={vorher ? vorher.summen[i]?.kwh : null}
                          vergleichName={vergleichName}
                        />
                      ))}
                    </div>
                    {laufend && <p className="vp-note vp-note-laufend">{laufend}</p>}
                    <AbdeckungsSatz abdeckung={aggregat.abdeckung} />
                  </>
                )}
              </Card>
            </section>

            <section className="vp-section">
              <AnlagenTabelle kopf={SPALTEN}>
                {aggregat.zeilen.map((z) => (
                  <Zeile
                    key={z.siteId}
                    zeile={z}
                    href={historieHash(z.siteId, 'messwerte', range, at)}
                    onOpen={() => oeffneAnlagenWelt(z.siteId, 'messwerte', range, at)}
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
