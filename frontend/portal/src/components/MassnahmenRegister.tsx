import { useEffect, useState } from 'react';
import { api, type Massnahme } from '../api';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE, UEMS_VERBESSERUNG_SAETZE } from '../glossar';
import * as M from '../massnahmen';
import { MassnahmeAnlegen } from './MassnahmeDialoge';
import { ErrorState, Skeleton } from './States';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; liste: Massnahme[] };

/**
 * Das Register „Maßnahmen“ (AP-18 IP-13, §5.4, M1, M4, E5 = A): je Maßnahme Kennzeichen und Titel, Zustand, Termin,
 * Verantwortlich, Messgrundlage — ohne sie das Kennzeichen „ohne Messgrundlage — Wirkung nicht messbar“ in der Zeile;
 * „überfällig seit n Tagen“ aus `frist` der Route, überfällige zuerst; Filter Zustand, Kennzahl, überfällig. Ohne
 * Maßnahme der Leer-Satz aus §5.9; der Grenz-Satz steht immer (SP3). „Maßnahme anlegen“ legt von Hand an.
 */
export function MassnahmenRegister({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [filter, setFilter] = useState<M.RegisterFilter>(M.FILTER_LEER);

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahmen().then(
      ({ massnahmen }) => aktiv && setLage({ art: 'da', liste: M.ordnen(massnahmen) }),
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const anlegen = <MassnahmeAnlegen vorbelegung={{ herkunft: 'von_hand' }} standort={null} variante="primary" onAngelegt={(m) => onOeffnen(m.id)} />;

  if (lage.art === 'laedt') return <Skeleton height={180} />;
  if (lage.art === 'fehler') return <ErrorState message={M.LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />;

  const zeilen = M.filtern(lage.liste, filter);
  return (
    <section className="vp-ez" data-testid="massnahmen-register">
      {anlegen}
      {lage.liste.length === 0 ? (
        <p className="vp-ez-satz" data-testid="massnahmen-leer">
          {UEMS_VERBESSERUNG_SAETZE.leer()}
        </p>
      ) : (
        <>
          <div className="vp-ez-filter" data-testid="massnahmen-filter">
            <VpPicker
              label={M.FILTER.zustand}
              options={[{ value: '', label: M.FILTER.alle }, ...Object.entries(M.ZUSTAND_WORT).map(([value, label]) => ({ value, label }))]}
              value={filter.zustand}
              onChange={(v) => setFilter((f) => ({ ...f, zustand: v as M.RegisterFilter['zustand'] }))}
              search="nie"
            />
            <VpPicker
              label={M.FILTER.kennzahl}
              options={[{ value: '', label: M.FILTER.alle }, ...M.kennzahlOptionen(lage.liste)]}
              value={filter.kennzahl}
              onChange={(v) => setFilter((f) => ({ ...f, kennzahl: v }))}
            />
            <label className="vp-ez-wahl-punkt">
              <input
                type="checkbox"
                checked={filter.ueberfaellig}
                onChange={(x) => setFilter((f) => ({ ...f, ueberfaellig: x.target.checked }))}
                data-testid="massnahmen-filter-ueberfaellig"
              />
              {M.FILTER.ueberfaellig}
            </label>
          </div>
          {zeilen.length === 0 ? (
            <p className="vp-ez-satz">{M.LEER_GEFILTERT}</p>
          ) : (
            <table className="vp-ez-tafel" data-testid="massnahmen-tafel">
              <thead>
                <tr>
                  <th scope="col">{M.SPALTEN.kennzeichen}</th>
                  <th scope="col">{M.SPALTEN.zustand}</th>
                  <th scope="col">{M.SPALTEN.termin}</th>
                  <th scope="col">{M.SPALTEN.verantwortlich}</th>
                  <th scope="col">{M.SPALTEN.messgrundlage}</th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((m) => {
                  const ueberfaellig = M.ueberfaelligText(m);
                  return (
                    <tr key={m.id} data-testid={`massnahme-zeile-${m.kennzeichen}`}>
                      <th scope="row">
                        <button type="button" className="vp-ez-zeile-knopf" onClick={() => onOeffnen(m.id)}>
                          {m.kennzeichen}
                        </button>
                        <span className="vp-ez-unter">{m.titel}</span>
                      </th>
                      <td data-label={M.SPALTEN.zustand} data-testid="zustand">
                        {M.ZUSTAND_WORT[m.zustand]}
                      </td>
                      <td data-label={M.SPALTEN.termin} data-testid="termin">
                        {Z.tag(m.termin)}
                        {ueberfaellig && <span className="vp-ez-frist vp-ez-unter">{ueberfaellig}</span>}
                      </td>
                      <td data-label={M.SPALTEN.verantwortlich}>{m.verantwortlich.name}</td>
                      <td data-label={M.SPALTEN.messgrundlage} data-testid="messgrundlage">
                        {m.messgrundlage ? (
                          `${m.messgrundlage.kennzahl.kennzeichen} ${m.messgrundlage.kennzahl.name ?? ''}`.trim()
                        ) : (
                          <span className="vp-ez-ohne">{m.ohne_messgrundlage?.kennzeichen}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
