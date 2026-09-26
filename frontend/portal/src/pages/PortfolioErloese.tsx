import { useMemo, useState } from 'react';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import { isCurrentPeriod } from '../energieBilanz';
import { historieHash } from '../historieWelten';
import { vollerVergleichsName } from '../vergleichLaufend';
import { ladeCsv } from '../ladeCsv';
import { speicherAussage } from '../speicherAussage';
import {
  erloeseAggregat,
  PORTFOLIO_WELTEN,
  portfolioRange,
  portfolioRanges,
  portfolioVergleich,
} from '../portfolioHistorie';
import {
  ERLOESE_ANLAGEN_SPALTEN,
  erloeseAnlagen,
  erloeseAnlagenCsv,
  erloeseAnlagenTabelle,
  portfolioCsvName,
  portfolioGeldKennzahlen,
  portfolioSteuerung,
  type PortfolioGeldId,
} from '../portfolioSeite';
import { usePortfolioErloese, useVergleichsErloesePortfolio } from '../usePortfolioHistorie';
import { SteuerungFormel } from '../components/SteuerungFormel';
import { VerlaufFehler, VerlaufKarteSkeleton, VerlaufLeer } from '../components/States';
import { PeriodeFehlgeschlagen, ZeitLeiste } from '../components/HistorieWelt';
import {
  Kennzahl,
  Kennzahlen,
  VerlaufStatus,
  VrKarte,
  VrTabelle,
  VrUmschalter,
} from '../components/VerlaufRahmen';
import { AnlagenListe } from '../components/portfolio/AnlagenListe';
import { oeffneAnlagenWelt } from './portfolioWeltNav';

/**
 * **Meine Anlagen · Erlöse** (`#/portfolio/erloese`) — das Geld ALLER Anlagen
 * im Rahmen der Anlagen-Seite (Konzept „Verlauf-Rework", Portfolio-Paket).
 *
 * 1. **Kennzahlen** — Ergebnis groß, daneben Eigenverbrauch, Einspeisung,
 *    Netzbezug und die Kachel **VoltPilot-Steuerung** (Mehrwert gegenüber
 *    demselben Speicher ohne smarte Steuerung, Rechnung im ⓘ).
 * 2. **Ergebnis je Anlage** — eine Balkenliste (am Telefon ohne Querscrollen),
 *    umschaltbar auf die Tabelle mit allen Posten und CSV. Ein Tipp auf eine
 *    Anlage öffnet ihre Erlöse im gleichen Zeitraum — dort steht der Verlauf.
 *
 * Die Quelle ist der mandantenweite `GET /api/v1/earnings`; er kennt keine
 * Woche, also bietet die Zeitleiste keine an. Erklärungen stehen im ⓘ der
 * Statuszeile, nie als Absatz im Weg.
 */

const ANSICHTEN = [
  { id: 'balken', label: 'Balken' },
  { id: 'tabelle', label: 'Tabelle' },
] as const;
type Ansicht = (typeof ANSICHTEN)[number]['id'];

function kennzahlFarbe(id: PortfolioGeldId): string | null {
  const t = chartTheme();
  if (id === 'eigenverbrauch') return t.cPv;
  if (id === 'einspeisung') return t.cGrid;
  if (id === 'netzbezug') return t.cGeldKosten;
  return null;
}

export function PortfolioErloese({ sites }: { sites: Site[] }) {
  const welt = PORTFOLIO_WELTEN.erloese;
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(() => portfolioRange('erloese', init.range));
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  const [ansicht, setAnsicht] = useState<Ansicht>('balken');

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

  // Am laufenden Tag entscheidet ausschließlich der Server-Wert (bis zur
  // gleichen Berliner Stunde) — fehlt er, bleibt die Zeile weg.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, anchor, daten, aggregat, vorher],
  );

  const kennzahlen = aggregat
    ? portfolioGeldKennzahlen({
        aggregat,
        vergleich,
        vergleichVoll: vollerVergleichsName(anchor, range, 'vorperiode'),
      })
    : [];

  // Die Steuerungs-Aussage über alle Anlagen — dieselbe Ableitung wie auf der
  // Anlage; `savedEur` ist hier nur die Prüfsumme (= dieselbe Zahl).
  const speicher = useMemo(
    () =>
      speicherAussage(
        {
          savedEur: aggregat?.steuerungEur ?? null,
          savedSteuerungEur: aggregat?.steuerungEur ?? null,
          range,
          to: daten?.to ?? null,
        },
        { now, laeuft },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aggregat, range, daten, laeuft],
  );
  const steuerung = aggregat ? portfolioSteuerung(speicher, aggregat) : null;

  const balken = useMemo(() => (aggregat ? erloeseAnlagen(aggregat) : []), [aggregat]);
  const tabelle = useMemo(() => (aggregat ? erloeseAnlagenTabelle(aggregat) : null), [aggregat]);
  const hrefFor = (id: string) => historieHash(id, 'erloese', range, at);
  const t = chartTheme();

  return (
    <div className="vp-vr vp-vr-portfolio">
      <h1 className="vp-sr-only">Erlöse aller Anlagen — Bewertet</h1>
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        ranges={portfolioRanges('erloese')}
        stale={stale}
        abdeckungInStatus
        now={now}
      />
      <VerlaufStatus
        art="bewertet"
        laeuft={laeuft ? 'Zwischenstand' : null}
        abdeckung={aggregat?.abdeckung.satz ?? null}
        alt={stale}
        info={{ titel: 'So entstehen die Beträge', text: welt.fussText }}
      />

      <div className={`vp-vr-body${stale ? ' alt' : ''}`} aria-busy={loading || undefined}>
        {err && !aggregat ? (
          <VrKarte titel="Erlöse" label="Erlöse konnten nicht geladen werden">
            <VerlaufFehler satz="Die Erlöse Ihrer Anlagen konnten nicht geladen werden." onRetry={retry} />
          </VrKarte>
        ) : !aggregat ? (
          loading ? (
            <VrKarte titel="Ergebnis je Anlage">
              <VerlaufKarteSkeleton chart={false} legende={false} />
            </VrKarte>
          ) : null
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            <Kennzahlen
              label={`Erlöse aller Anlagen · ${label}`}
              anzahl={kennzahlen.length - 1 + (steuerung ? 1 : 0)}
            >
              {kennzahlen.map((k) => (
                <Kennzahl
                  key={k.id}
                  haupt={k.id === 'ergebnis'}
                  label={k.label}
                  wert={k.wert}
                  ton={k.ton}
                  farbe={kennzahlFarbe(k.id)}
                  info={k.info}
                  unter={
                    k.unter ? (
                      <>
                        {k.pfeil && <span className="vp-vr-dlt" aria-hidden="true">{k.pfeil} </span>}
                        {k.unter}
                      </>
                    ) : null
                  }
                />
              ))}
              {steuerung && (
                <Kennzahl
                  hervor={`is-${steuerung.ton}`}
                  label={steuerung.label}
                  wert={steuerung.wert}
                  farbe="var(--vp-c-primary)"
                  info={{
                    titel: steuerung.titel,
                    text: (
                      <div className="vp-vr-mw-info">
                        {steuerung.info.map((s) => (
                          <p key={s}>{s}</p>
                        ))}
                        <SteuerungFormel input={{ tarifneutral: true }} />
                      </div>
                    ),
                  }}
                  unter={steuerung.unter}
                />
              )}
            </Kennzahlen>

            {aggregat.leer ? (
              <VrKarte titel="Ergebnis je Anlage">
                <VerlaufLeer
                  label="Noch kein Ergebnis für diesen Zeitraum"
                  satz="Für keine Ihrer Anlagen liegen bewertete Werte vor. Sobald Messwerte und Preise da sind, steht hier, was jede Anlage eingebracht hat."
                />
              </VrKarte>
            ) : (
              <VrKarte
                titel="Ergebnis je Anlage"
                info={{
                  titel: 'Ergebnis je Anlage',
                  text: 'Ein Tipp auf eine Anlage öffnet ihre Erlöse im gleichen Zeitraum — mit Verlauf und Abrechnung.',
                }}
                aktionen={
                  <VrUmschalter label="Ansicht" optionen={ANSICHTEN} wert={ansicht} onWert={setAnsicht} />
                }
              >
                {ansicht === 'balken' ? (
                  <AnlagenListe
                    zeilen={balken}
                    farbe={t.ink}
                    hrefFor={hrefFor}
                    label={`Ergebnis je Anlage · ${label}`}
                  />
                ) : (
                  tabelle && (
                    <VrTabelle
                      titel={`Ergebnis je Anlage · ${label}`}
                      spalten={ERLOESE_ANLAGEN_SPALTEN}
                      zeilen={tabelle.zeilen}
                      summe={tabelle.summe}
                      hauptSpalte={0}
                      onZeile={(id) => oeffneAnlagenWelt(id, 'erloese', range, at)}
                      zeileTitel="Erlöse der Anlage öffnen"
                      fuss={
                        <button
                          type="button"
                          className="vp-vr-textbtn"
                          onClick={() =>
                            ladeCsv(erloeseAnlagenCsv(aggregat), portfolioCsvName('erloese', range, at))
                          }
                        >
                          Als CSV herunterladen
                        </button>
                      }
                    />
                  )
                )}
              </VrKarte>
            )}
          </>
        )}
      </div>
    </div>
  );
}
