import { useEffect, useState } from 'react';
import { api, type Energieziel, type EnergiezielStand } from '../api';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE, UEMS_VERBESSERUNG_SAETZE } from '../glossar';
import { ErrorState, Skeleton } from './States';
import '../pages/Verbesserung.css';

type Lage =
  | { art: 'laedt' }
  | { art: 'fehler' }
  | { art: 'da'; ziele: Energieziel[]; staende: Record<string, EnergiezielStand | 'fehler'> };

/**
 * Das Register „Energieziele“ (AP-18 IP-8, §5.1): je Energieziel Kennzahl, Zielwert, Zielperiode, Stand („2,9 % weniger
 * nach 5 von 12 Monaten“ — vom Leser `…/stand`), Verantwortlich und Zustand. Ohne Energieziel der Leer-Satz aus §5.9;
 * der Grenz-Satz steht immer (SP3). Die Zeile öffnet die Energieziel-Seite.
 */
export function EnergiezieleRegister({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api
      .energieziele()
      .then(async ({ energieziele }) => {
        const paare = await Promise.all(
          energieziele.map(async (ez) => [ez.id, await api.energiezielStand(ez.id).catch(() => 'fehler' as const)] as const),
        );
        if (aktiv) setLage({ art: 'da', ziele: energieziele, staende: Object.fromEntries(paare) });
      })
      .catch(() => aktiv && setLage({ art: 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  if (lage.art === 'laedt') return <Skeleton height={180} />;
  if (lage.art === 'fehler') return <ErrorState message={Z.LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />;

  return (
    <section className="vp-ez" data-testid="energieziele-register">
      {lage.ziele.length === 0 ? (
        <p className="vp-ez-satz" data-testid="energieziele-leer">
          {UEMS_VERBESSERUNG_SAETZE.leer()}
        </p>
      ) : (
        <table className="vp-ez-tafel" data-testid="energieziele-tafel">
          <thead>
            <tr>
              <th scope="col">{Z.SPALTEN.kennzeichen}</th>
              <th scope="col">{Z.SPALTEN.kennzahl}</th>
              <th scope="col">{Z.SPALTEN.zielwert}</th>
              <th scope="col">{Z.SPALTEN.zielperiode}</th>
              <th scope="col">{Z.SPALTEN.stand}</th>
              <th scope="col">{Z.SPALTEN.verantwortlich}</th>
              <th scope="col">{Z.SPALTEN.zustand}</th>
            </tr>
          </thead>
          <tbody>
            {lage.ziele.map((ez) => {
              const stand = lage.staende[ez.id];
              const frist = Z.fristText(ez);
              return (
                <tr key={ez.id} data-testid={`energieziel-zeile-${ez.kennzeichen}`}>
                  <th scope="row">
                    <button type="button" className="vp-ez-zeile-knopf" onClick={() => onOeffnen(ez.id)}>
                      {ez.kennzeichen}
                    </button>
                    <span className="vp-ez-unter">{ez.wortlaut}</span>
                  </th>
                  <td data-label={Z.SPALTEN.kennzahl}>
                    {ez.kennzahl.kennzeichen} {ez.kennzahl.name}
                  </td>
                  <td data-label={Z.SPALTEN.zielwert} className="vp-ez-zahl">
                    {Z.zielwertText(ez.zielwert_prozent)}
                  </td>
                  <td data-label={Z.SPALTEN.zielperiode}>{Z.zielperiodeText(ez.zielperiode)}</td>
                  <td data-label={Z.SPALTEN.stand} data-testid="stand">
                    {stand === undefined || stand === 'fehler' ? '—' : Z.standSpalte(stand)}
                  </td>
                  <td data-label={Z.SPALTEN.verantwortlich}>{ez.verantwortlich.name}</td>
                  <td data-label={Z.SPALTEN.zustand} data-testid="zustand">
                    {Z.ZUSTAND_WORT[ez.zustand]}
                    {ez.ergebnis && `: ${Z.ERGEBNIS_WORT[ez.ergebnis]}`}
                    {frist && <span className="vp-ez-unter">{frist}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
