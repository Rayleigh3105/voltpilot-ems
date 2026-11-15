/**
 * Die Wortliste als Nachschlageseite (E9 = B: die Wörter des Textes sind englisch): jedes Wort mit dem deutschen
 * Wort der Wortliste und, wo es hilft, einem Satz, was es tut. Durchsuchbar auf Englisch und Deutsch.
 */
import { useId, useState } from 'react';
import { Blatt } from '../Blatt';
import { suche } from './woerter';

export function WoerterBlatt({ onClose }: { onClose: () => void }) {
  const [begriff, setBegriff] = useState('');
  const id = useId();
  const treffer = suche(begriff);
  return (
    <Blatt symbol="list" titel="Wörter der Textform" unter="Englisch, mit dem deutschen Wort" voll onClose={onClose}>
      <div className="lk-woerter">
        <div className="lk-feld">
          <label htmlFor={id}>Suchen</label>
          <input id={id} className="lk-eingabe" value={begriff} onChange={(e) => setBegriff(e.target.value)} placeholder="z. B. holds oder Neustart" />
        </div>
        {treffer.length === 0 ? <p className="leise">Kein Wort passt zu „{begriff}“.</p> : null}
        {treffer.map(({ gruppe, zeilen }) => (
          <section key={gruppe.tabelle} aria-label={gruppe.titel}>
            <h3>{gruppe.titel}</h3>
            <p>{gruppe.satz}</p>
            <dl>
              {zeilen.map((z) => (
                <div key={z.wort} style={{ display: 'contents' }}>
                  <dt>{z.wort}</dt>
                  <dd>
                    {z.deutsch}
                    {z.satz ? <small> · {z.satz}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Blatt>
  );
}
