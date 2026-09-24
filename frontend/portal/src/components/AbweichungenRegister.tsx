import { useEffect, useState } from 'react';
import * as A from '../abweichungen';
import { api, type Abweichung } from '../api';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE } from '../glossar';
import { ErrorState, Skeleton } from './States';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; liste: Abweichung[] };

/**
 * Das Register „Abweichungen“ (AP-18 IP-18, §5.3, §6.3, A3, A6, E5 = A): offene zuerst — überfällige oben mit
 * „überfällig seit n Tagen“ aus `frist` der Route —, dann abgeschlossene mit ihrem Ergebnis; je Zeile Kennzeichen,
 * Kennzahl mit Monaten, Frist, Verantwortlich; Filter Zustand, Kennzahl, überfällig. Eröffnet wird an der Kennzahl
 * (Vermerk oder Vergleichszeile) — hier gibt es keinen Knopf dafür. Der Grenz-Satz steht immer (SP3).
 */
export function AbweichungenRegister({
  onOeffnen,
  grenze = true,
}: {
  onOeffnen: (id: string) => void;
  /** `false`, wenn die umgebende Fläche den Grenz-Satz schon trägt (der Bereich „Ziele und Maßnahmen“). */
  grenze?: boolean;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [filter, setFilter] = useState<A.RegisterFilter>(A.FILTER_LEER);

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.abweichungen().then(
      ({ abweichungen }) => aktiv && setLage({ art: 'da', liste: A.ordnen(abweichungen) }),
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  if (lage.art === 'laedt') return <Skeleton height={180} />;
  if (lage.art === 'fehler') return <ErrorState message={A.LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />;

  const zeilen = A.filtern(lage.liste, filter);
  return (
    <section className="vp-ez" data-testid="abweichungen-register">
      {lage.liste.length === 0 ? (
        <p className="vp-ez-satz" data-testid="abweichungen-leer">
          {A.LEER}
        </p>
      ) : (
        <>
          <div className="vp-ez-filter" data-testid="abweichungen-filter">
            <VpPicker
              label={A.FILTER.zustand}
              options={[{ value: '', label: A.FILTER.alle }, ...Object.entries(A.ZUSTAND_WORT).map(([value, label]) => ({ value, label }))]}
              value={filter.zustand}
              onChange={(v) => setFilter((f) => ({ ...f, zustand: v as A.RegisterFilter['zustand'] }))}
              search="nie"
            />
            <VpPicker
              label={A.FILTER.kennzahl}
              options={[{ value: '', label: A.FILTER.alle }, ...A.kennzahlOptionen(lage.liste)]}
              value={filter.kennzahl}
              onChange={(v) => setFilter((f) => ({ ...f, kennzahl: v }))}
            />
            <label className="vp-ez-wahl-punkt">
              <input
                type="checkbox"
                checked={filter.ueberfaellig}
                onChange={(x) => setFilter((f) => ({ ...f, ueberfaellig: x.target.checked }))}
                data-testid="abweichungen-filter-ueberfaellig"
              />
              {A.FILTER.ueberfaellig}
            </label>
          </div>
          {zeilen.length === 0 ? (
            <p className="vp-ez-satz">{A.LEER_GEFILTERT}</p>
          ) : (
            <table className="vp-ez-tafel" data-testid="abweichungen-tafel">
              <thead>
                <tr>
                  <th scope="col">{A.SPALTEN.kennzeichen}</th>
                  <th scope="col">{A.SPALTEN.zustand}</th>
                  <th scope="col">{A.SPALTEN.frist}</th>
                  <th scope="col">{A.SPALTEN.verantwortlich}</th>
                  <th scope="col">{A.SPALTEN.ergebnis}</th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((a) => {
                  const ueberfaellig = A.ueberfaelligText(a);
                  return (
                    <tr key={a.id} data-testid={`abweichung-zeile-${a.kennzeichen}`}>
                      <th scope="row">
                        <button type="button" className="vp-ez-zeile-knopf" onClick={() => onOeffnen(a.id)}>
                          {a.kennzeichen}
                        </button>
                        <span className="vp-ez-unter">{`${A.kennzahlText(a.kennzahl)} · ${A.monateDerAbweichung(a.monate)}`}</span>
                      </th>
                      <td data-label={A.SPALTEN.zustand} data-testid="zustand">
                        {A.ZUSTAND_WORT[a.zustand]}
                      </td>
                      <td data-label={A.SPALTEN.frist} data-testid="frist">
                        {Z.tag(a.frist.termin)}
                        {ueberfaellig && <span className="vp-ez-frist vp-ez-unter">{ueberfaellig}</span>}
                      </td>
                      <td data-label={A.SPALTEN.verantwortlich}>{a.verantwortlich.name}</td>
                      <td data-label={A.SPALTEN.ergebnis} data-testid="ergebnis">
                        {A.ergebnisText(a) ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      {grenze && <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>}
    </section>
  );
}
