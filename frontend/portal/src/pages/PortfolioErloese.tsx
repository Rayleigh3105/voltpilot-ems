import { useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { fmtNum } from '../format';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import {
  delta,
  laufendHinweis,
  vergleichsKopf,
  vergleichsName,
} from '../historieVergleich';
import { historieHash } from '../historieWelten';
import { DASH, signedEuro, steeringAttributionNote } from '../erloesKomposition';
import { SteuerungFormel } from '../components/SteuerungFormel';
import {
  erloeseAggregat,
  PORTFOLIO_WELTEN,
  portfolioRange,
  type ErloeseZeile,
} from '../portfolioHistorie';
import {
  usePortfolioErloese,
  useVergleichsErloesePortfolio,
} from '../usePortfolioHistorie';

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
 * ZURECHNUNG darunter — nie ein weiterer Summand (er steckt schon im Ertrag).
 */

const SPALTEN = ['Anlage', 'Ertrag', 'Durch Steuerung', 'Eingespeist', 'Verlauf'] as const;

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
      <td className="num" data-label="Ertrag">
        <span className="vp-pf-v">
          {zeile.ertragEur == null ? DASH : signedEuro(zeile.ertragEur)}
        </span>
      </td>
      <td className="num" data-label="Durch Steuerung">
        <span className="vp-pf-v">
          {zeile.savedEur == null ? DASH : signedEuro(zeile.savedEur)}
        </span>
      </td>
      <td className="num" data-label="Eingespeist">
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
  const vergleichName = vergleichsName(anchor, range);
  const laufend = vorher ? laufendHinweis(anchor, range, now) : null;
  const kontext = `${sites.length} ${sites.length === 1 ? 'Anlage' : 'Anlagen'} · ${label}`;
  // Mehr Ertrag ist eindeutig besser - hier darf gewertet werden.
  const ertragDelta = delta(aggregat?.ertragEur, vorher?.ertragEur, true, vergleichName);
  const zurechnung = steeringAttributionNote(aggregat?.savedEur);

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

            <section className="vp-section">
              <Card padding="lg" radius="lg" className="vp-pf-summenkarte">
                <KartenKopf
                  icon="euro"
                  category="primary"
                  titel={`Ertrag aller Anlagen · ${label}`}
                  art="bewertet"
                  extra={
                    vorher ? (
                      <span className="vp-karten-vergleich">{vergleichsKopf(anchor, range)}</span>
                    ) : undefined
                  }
                />
                {aggregat.ertragEur == null ? (
                  <EmptyState
                    icon="euro"
                    category="dynamic"
                    title="Noch kein Ergebnis für diesen Zeitraum"
                    description="Für keine Ihrer Anlagen liegen in diesem Zeitraum bewertete Viertelstunden vor. Sobald Messwerte und Preise da sind, steht hier, was Ihr Portfolio eingebracht hat."
                  />
                ) : (
                  <>
                    <p className="vp-pf-summe">
                      {signedEuro(aggregat.ertragEur)}
                      <span className="vp-pf-summe-l">Ertrag im Zeitraum</span>
                    </p>
                    {zurechnung && (
                      <>
                        <p className="vp-pf-zurechnung">
                          <Icon name="zap" size={14} aria-hidden="true" />
                          {zurechnung}
                        </p>
                        {/* Im Portfolio gibt es keinen EINEN Tarif — die
                            Erklaerung sagt deshalb „der Stromtarif der
                            jeweiligen Anlage" statt einer erfundenen Zahl. */}
                        <SteuerungFormel input={{ tarifneutral: true }} />
                      </>
                    )}
                    {ertragDelta && (
                      <p className="vp-kpi-delta">
                        <DeltaZeile delta={ertragDelta} />
                      </p>
                    )}
                    {laufend && <p className="vp-note vp-note-laufend">{laufend}</p>}

                    {/* Woraus die große Zahl besteht - ein Teil ohne Wert wird
                        gar nicht erst gezeigt (eine Liste aus „—" erklärt
                        nichts, MIG §5). */}
                    <ul className="vp-pf-teile" aria-label="Woraus sich der Ertrag zusammensetzt">
                      {aggregat.einspeiseEur != null && (
                        <li>
                          <span className="vp-pf-teil-l">Einspeise-Erlös</span>
                          <span className="vp-pf-teil-v">{signedEuro(aggregat.einspeiseEur)}</span>
                        </li>
                      )}
                      {aggregat.eigenverbrauchEur != null && (
                        <li>
                          <span className="vp-pf-teil-l">Wert des Eigenverbrauchs</span>
                          <span className="vp-pf-teil-v">
                            {signedEuro(aggregat.eigenverbrauchEur)}
                          </span>
                        </li>
                      )}
                    </ul>
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
