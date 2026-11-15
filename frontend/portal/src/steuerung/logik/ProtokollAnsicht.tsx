/**
 * Die Ansicht „Protokoll“ (Bericht 8.6, 8.9): wer hat wann was getan - Werte gestellt, Fassungen gespeichert,
 * mitlaufen lassen, vorgelegt, scharf geschaltet, zurückgenommen, Änderungen angefragt. Die letzten 90 Tage, als
 * Tabelle zum Herunterladen.
 */
import { useEffect, useState } from 'react';
import { api, type SteuerlogikSchritt } from '../../api';
import { Ic } from '../Ic';
import { datum } from './FassungenAnsicht';
import { protokollCsv, rolleWort, schrittSatz } from './seite';

export function ProtokollAnsicht({ siteId, logikId, name, stand }: { siteId: string; logikId: string; name: string; stand: number }) {
  const [schritte, setSchritte] = useState<SteuerlogikSchritt[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [nurWerte, setNurWerte] = useState(false);
  useEffect(() => {
    let gilt = true;
    api.logikProtokoll(siteId, logikId).then(
      (p) => { if (gilt) { setSchritte(p.schritte); setFehler(null); } },
      () => { if (gilt) setFehler('Das Protokoll ließ sich nicht laden.'); },
    );
    return () => { gilt = false; };
  }, [siteId, logikId, stand]);

  const liste = (schritte ?? []).filter((s) => !nurWerte || s.was === 'stellwert');
  const herunterladen = () => {
    const blob = new Blob([protokollCsv(liste)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `protokoll-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'logik'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="card lk-abschnitt" aria-label="Protokoll">
      <div className="lk-abschnitt-kopf">
        <h2>Protokoll</h2>
        <div className="mini-seg" role="group" aria-label="Was zeigen">
          <button type="button" aria-pressed={!nurWerte} onClick={() => setNurWerte(false)}>Alles</button>
          <button type="button" aria-pressed={nurWerte} onClick={() => setNurWerte(true)}>Stellwerte</button>
        </div>
      </div>
      <p>Wer hat wann was getan, die letzten 90 Tage.</p>
      {fehler ? <p className="stn-fehler">{fehler}</p> : null}
      {schritte && liste.length === 0 ? <p className="lk-leer">Noch nichts.</p> : null}
      {liste.length ? (
        <>
          <ul className="lk-liste">
            {liste.map((s, i) => (
              <li key={`${s.am}-${i}`}>
                <span>{schrittSatz(s)}</span>
                <small>{datum(s.am)} · {s.von ?? 'unbekannt'}{rolleWort(s.rolle) ? ` (${rolleWort(s.rolle)})` : ''}</small>
              </li>
            ))}
          </ul>
          <button type="button" className="tbtn" style={{ justifySelf: 'start' }} onClick={herunterladen}>
            <Ic n="down" s={16} />
            Als Tabelle herunterladen
          </button>
        </>
      ) : null}
    </section>
  );
}
