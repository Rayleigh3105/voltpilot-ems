import { useMemo, useState } from 'react';
import type { HistoryRange, Site } from '../api';
import { chartTheme } from '../chartTheme';
import { isoDate, periodLabel } from '../periodNav';
import { parseVerlaufParams } from '../verlauf';
import { isCurrentPeriod } from '../energieBilanz';
import { aufloesungText, energieKennzahlen } from '../energieSeite';
import { historieHash } from '../historieWelten';
import { ladeCsv } from '../ladeCsv';
import { PORTFOLIO_WELTEN, portfolioRange } from '../portfolioHistorie';
import {
  ENERGIE_ANLAGEN_SPALTEN,
  energieAnlagen,
  energieAnlagenCsv,
  energieAnlagenTabelle,
  portfolioCsvName,
  verbundHistory,
} from '../portfolioSeite';
import { usePortfolioHistorie, useVergleichsHistorie } from '../usePortfolioHistorie';
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
import { rollenFarbe } from '../components/energie/EnergieKarten';
import { AnlagenListe } from '../components/portfolio/AnlagenListe';
import { oeffneAnlagenWelt } from './portfolioWeltNav';

/**
 * **Meine Anlagen · Energie** (`#/portfolio/messwerte`) — die Energie ALLER
 * Anlagen im Rahmen der Anlagen-Seite (Konzept „Verlauf-Rework",
 * Portfolio-Paket).
 *
 * 1. **Kennzahlen** — die sechs Energiemengen über alle Anlagen, mit
 *    demselben ehrlichen Vergleich wie auf der Anlage: ein laufender Tag nur
 *    bis zur gleichen Stunde, eine laufende Woche/Monat/Jahr nur mit der Menge
 *    des ganzen Vergleichszeitraums (`energieKennzahlen` über die Eimer aller
 *    Anlagen).
 * 2. **Erzeugung je Anlage** — Balkenliste mit Verbrauch und Selbstversorgung
 *    je Anlage (Quoten nie gemittelt), umschaltbar auf die Tabelle mit allen
 *    sechs Mengen und CSV. Ein Tipp öffnet die Energie der Anlage im gleichen
 *    Zeitraum — dort steht der Verlauf.
 *
 * Eine Anlage ohne Messwerte fließt nicht als Null in die Summe; die
 * Statuszeile sagt, über wie viele Anlagen die Zahlen sprechen.
 */

const ANSICHTEN = [
  { id: 'balken', label: 'Balken' },
  { id: 'tabelle', label: 'Tabelle' },
] as const;
type Ansicht = (typeof ANSICHTEN)[number]['id'];

export function PortfolioMesswerte({ sites }: { sites: Site[] }) {
  const welt = PORTFOLIO_WELTEN.messwerte;
  const [init] = useState(() => parseVerlaufParams(window.location.hash));
  const [range, setRange] = useState<HistoryRange>(() => portfolioRange('messwerte', init.range));
  const [anchor, setAnchor] = useState<Date>(() =>
    init.at ? new Date(`${init.at}T12:00:00`) : new Date(),
  );
  const [ansicht, setAnsicht] = useState<Ansicht>('balken');

  const at = isoDate(anchor);
  const liste = useMemo(() => sites.map((s) => ({ id: s.id, name: s.name })), [sites]);
  const { daten, loading, stale, err, retry } = usePortfolioHistorie(liste, range, at);
  const verbund = useMemo(() => (daten ? verbundHistory(daten) : null), [daten]);
  const leer = useMemo(
    () => !daten || energieAnlagen(daten).every((z) => z.anteilPct == null),
    [daten],
  );
  const vorherDaten = useVergleichsHistorie(liste, range, anchor, !stale && daten != null && !leer);
  const vorher = useMemo(() => (vorherDaten ? verbundHistory(vorherDaten) : null), [vorherDaten]);

  const now = new Date();
  const label = periodLabel(anchor, range);
  const laeuft = isCurrentPeriod(anchor, range, now);

  const kennzahlen = useMemo(
    () => energieKennzahlen({ history: verbund, vorher, anchor, range, now, modus: 'vorperiode' }),
    // `now` wechselt bei jedem Rendern und ist kein Anlass zum Neurechnen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [verbund, vorher, anchor, range],
  );
  const balken = useMemo(() => (daten ? energieAnlagen(daten) : []), [daten]);
  const tabelle = useMemo(() => (daten ? energieAnlagenTabelle(daten) : null), [daten]);
  const abdeckung = useMemo(() => {
    if (!daten) return null;
    const mit = balken.filter((z) => z.anteilPct != null).length;
    const fehler = daten.filter((d) => d.fehler).length;
    if (mit === daten.length) return null;
    const teile = [`${mit} von ${daten.length} Anlagen mit Messwerten`];
    if (fehler > 0) teile.push(`${fehler} nicht geladen`);
    return teile.join(' · ');
  }, [daten, balken]);

  const hrefFor = (id: string) => historieHash(id, 'messwerte', range, at);

  return (
    <div className="vp-vr vp-vr-portfolio">
      <h1 className="vp-sr-only">Energie aller Anlagen — Gemessen</h1>
      <ZeitLeiste
        range={range}
        anchor={anchor}
        onRange={setRange}
        onAnchor={setAnchor}
        stale={stale}
        abdeckungInStatus
        now={now}
      />
      <VerlaufStatus
        art="gemessen"
        aufloesung={aufloesungText(verbund)}
        laeuft={laeuft ? 'Zwischenstand' : null}
        abdeckung={abdeckung}
        alt={stale}
        info={{ titel: 'So entstehen die Werte', text: welt.fussText }}
      />

      <div className={`vp-vr-body${stale ? ' alt' : ''}`} aria-busy={loading || undefined}>
        {err && !daten ? (
          <VrKarte titel="Energie" label="Energie konnte nicht geladen werden">
            <VerlaufFehler satz="Die Messwerte Ihrer Anlagen konnten nicht geladen werden." onRetry={retry} />
          </VrKarte>
        ) : !daten ? (
          loading ? (
            <VrKarte titel="Erzeugung je Anlage">
              <VerlaufKarteSkeleton chart={false} legende={false} />
            </VrKarte>
          ) : null
        ) : leer ? (
          <VrKarte titel="Erzeugung je Anlage">
            <VerlaufLeer
              label="Keine Messwerte in diesem Zeitraum"
              satz={`Keine Ihrer Anlagen hat für ${label} Messwerte geliefert.`}
            />
          </VrKarte>
        ) : (
          <>
            {err && stale && <PeriodeFehlgeschlagen periode={label} onRetry={retry} />}

            <Kennzahlen label={`Energie aller Anlagen · ${label}`} gleich anzahl={kennzahlen.length}>
              {kennzahlen.map((k) => (
                <Kennzahl
                  key={k.key}
                  label={k.label}
                  wert={k.wert}
                  ton={k.ton}
                  farbe={rollenFarbe(k.rolle)}
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
            </Kennzahlen>

            <VrKarte
              titel="Erzeugung je Anlage"
              info={{
                titel: 'Erzeugung je Anlage',
                text: 'Selbst versorgt: Anteil des Verbrauchs, den die Anlage selbst gedeckt hat — je Anlage, nie gemittelt. Ein Tipp auf eine Anlage öffnet ihre Energie im gleichen Zeitraum.',
              }}
              aktionen={
                <VrUmschalter label="Ansicht" optionen={ANSICHTEN} wert={ansicht} onWert={setAnsicht} />
              }
            >
              {ansicht === 'balken' ? (
                <AnlagenListe
                  zeilen={balken}
                  farbe={chartTheme().cPv}
                  hrefFor={hrefFor}
                  label={`Erzeugung je Anlage · ${label}`}
                />
              ) : (
                tabelle && (
                  <VrTabelle
                    titel={`Energie je Anlage · ${label}`}
                    spalten={ENERGIE_ANLAGEN_SPALTEN}
                    zeilen={tabelle.zeilen}
                    summe={tabelle.summe}
                    hauptSpalte={0}
                    onZeile={(id) => oeffneAnlagenWelt(id, 'messwerte', range, at)}
                    zeileTitel="Energie der Anlage öffnen"
                    fuss={
                      <button
                        type="button"
                        className="vp-vr-textbtn"
                        onClick={() => ladeCsv(energieAnlagenCsv(daten), portfolioCsvName('energie', range, at))}
                      >
                        Als CSV herunterladen
                      </button>
                    }
                  />
                )
              )}
            </VrKarte>
          </>
        )}
      </div>
    </div>
  );
}
