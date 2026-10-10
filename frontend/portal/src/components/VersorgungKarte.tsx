import { useEffect, useState } from 'react';
import { api, type StandortAmStichtag, type Versorgung } from '../api';
import { ausserhalbSatz, versorgungZeilen } from '../versorgung';
import './VersorgungKarte.css';

/** Standort › Versorgung (AP-10 IP-17/F15): die gebaute API-Sicht, keine zweite Ableitung im Portal. */
export function VersorgungKarte({ standort }: { standort: StandortAmStichtag }) {
  const [antwort, setAntwort] = useState<Versorgung | null>(null);
  const [fehler, setFehler] = useState(false);

  useEffect(() => {
    let aktiv = true;
    setAntwort(null);
    setFehler(false);
    api.versorgung(standort.id).then(
      (r) => aktiv && setAntwort(r),
      () => aktiv && setFehler(true),
    );
    return () => { aktiv = false; };
  }, [standort.id]);

  const zeilen = antwort ? versorgungZeilen(antwort) : [];
  const ausserhalb = antwort ? ausserhalbSatz(antwort) : null;
  return (
    <section className="vp-vs" aria-label={`Versorgung · ${standort.name}`} data-testid="versorgung">
      <h2 className="vp-vs-titel">Versorgung</h2>
      {fehler ? (
        <p className="vp-vs-hinweis">Die Versorgung ist gerade nicht abrufbar.</p>
      ) : !antwort ? (
        <p className="vp-vs-hinweis" aria-busy="true">Wird geladen …</p>
      ) : zeilen.length === 0 ? (
        <p className="vp-vs-hinweis">Noch kein Gebäude am Standort.</p>
      ) : (
        <ul className="vp-vs-zeilen">
          {zeilen.map((z) => (
            <li key={z.key} className={!z.messbar ? 'is-offen' : undefined}>
              <span className="vp-vs-punkt" aria-hidden="true" />
              <span className="vp-vs-text">{z.text}</span>
              {z.messstellen && <span className="vp-vs-ms">{z.messstellen}</span>}
            </li>
          ))}
        </ul>
      )}
      {ausserhalb && <p className="vp-vs-hinweis">{ausserhalb}</p>}
    </section>
  );
}
