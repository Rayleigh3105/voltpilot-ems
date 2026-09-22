import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { api, type BewertungMessabdeckung } from '../api';
import { UEMS_MESSABDECKUNG, UEMS_NORMGRENZE } from '../glossar';
import { ABDECKUNG_SPALTEN, abdeckungSumme, einsatzZeilen, ortZeilen, type AbdeckungZeile } from '../uemsMessabdeckung';
import './MessabdeckungTabelle.css';

/**
 * „Messabdeckung“ in der Welt Bewertung (UEMS AP-16 IP-18, §5.3, R5): je Energieeinsatz und je Ort, was gemessen,
 * geplant, durch Ersatzwerte gestützt und ungemessen ist — mit den Rest-Zeilen je Anlage und der Summe mit K8.
 * Quelle ist allein `…/bewertung/messabdeckung` (IP-13); die Tabelle rechnet nichts nach.
 *
 * ⚠ Ohne Antwort oder ohne Energieeinsatz steht GAR NICHTS (R11: wer keinen Einsatz anlegt, merkt nichts).
 * ⚠ Telefon: jede Zeile wird eine Karte mit beschrifteten Spalten; es gibt keinen waagerechten Seitenlauf.
 */
export function MessabdeckungTabelle({ von, bis, zeitraum }: { von: string; bis: string; zeitraum: string }) {
  const [daten, setDaten] = useState<BewertungMessabdeckung | null>(null);
  useEffect(() => {
    let aktiv = true;
    setDaten(null);
    api.bewertungMessabdeckung(von, bis).then(
      (d) => aktiv && setDaten(d),
      () => aktiv && setDaten(null),
    );
    return () => {
      aktiv = false;
    };
  }, [von, bis]);

  if (!daten || daten.je_einsatz.length === 0) return null;
  const summe = abdeckungSumme(daten);

  return (
    <section className="vp-bw-karte vp-ma" aria-labelledby="bw-messabdeckung" data-testid="messabdeckung">
      <div className="vp-bw-karte-kopf">
        <h2 id="bw-messabdeckung">{UEMS_MESSABDECKUNG} · {zeitraum}</h2>
        <Badge variant={summe.k8Zustand === 'ueber_schwelle' ? 'ok' : summe.k8Zustand === 'unter_schwelle' ? 'warn' : 'off'} data-testid="messabdeckung-k8">
          {summe.k8}
        </Badge>
      </div>
      <p className="vp-ma-lesehilfe">
        gemessen = die Messstelle liefert Daten · geplant = Messbedarf offen oder Messstelle ohne Datenquelle, noch ohne Werte · Ersatz = Ersatzwerte im Zeitraum, Teil von „gemessen“ · ungemessen = Rest der Anlagenbilanz, keinem Einsatz zugeordnet.
        {daten.teilansicht ? ' Sie sehen die Standorte, für die Sie berechtigt sind.' : ''}
      </p>
      <dl className="vp-ma-summe" data-testid="messabdeckung-summe">
        {summe.teile.map((t) => (
          <div key={t.schluessel}>
            <dt>{t.label}</dt>
            <dd>{t.wert}</dd>
          </div>
        ))}
      </dl>
      {summe.satz && <p className="vp-ma-satz">{summe.satz}</p>}

      <h3 className="vp-ma-unter">Je Energieeinsatz</h3>
      <Tabelle zeilen={einsatzZeilen(daten)} mitMenge testId="messabdeckung-einsaetze" titel="Energieeinsatz" />
      <h3 className="vp-ma-unter">Je Ort</h3>
      <Tabelle zeilen={ortZeilen(daten)} testId="messabdeckung-orte" titel="Ort" />
      <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
    </section>
  );
}

function Tabelle({ zeilen, mitMenge = false, testId, titel }: { zeilen: AbdeckungZeile[]; mitMenge?: boolean; testId: string; titel: string }) {
  return (
    <table className="vp-ma-tabelle" data-testid={testId}>
      <thead>
        <tr>
          <th scope="col">{titel}</th>
          {ABDECKUNG_SPALTEN.map((s) => (
            <th key={s.schluessel} scope="col">
              {s.titel}
            </th>
          ))}
          {mitMenge && <th scope="col">Menge</th>}
        </tr>
      </thead>
      <tbody>
        {zeilen.map((z) => (
          <tr key={z.schluessel} className={`vp-ma-zeile is-${z.art}`} data-testid={`messabdeckung-zeile-${z.kennzeichen ?? z.schluessel}`}>
            <th scope="row">
              <span className="vp-ma-kopf">
                {z.kennzeichen && <span className="vp-bw-kz">{z.kennzeichen}</span>}
                <span className="vp-ma-titel">{z.titel}</span>
                {z.unter && <span className="vp-ma-leise">{z.unter}</span>}
              </span>
            </th>
            {ABDECKUNG_SPALTEN.map((s) => (
              <td key={s.schluessel} data-label={s.titel} className={z.zellen[s.schluessel].length === 0 ? 'is-leer' : undefined}>
                {z.zellen[s.schluessel].length === 0 ? (
                  <span aria-label="nichts">—</span>
                ) : (
                  <ul>
                    {z.zellen[s.schluessel].map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                )}
              </td>
            ))}
            {mitMenge && (
              <td data-label="Menge" className="vp-ma-menge">
                {z.menge ?? '—'}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
