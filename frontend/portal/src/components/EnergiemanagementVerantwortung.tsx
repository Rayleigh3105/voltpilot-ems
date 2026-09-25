import { useEffect, useState } from 'react';
import { api, type EnergiemanagementVerantwortung as Verantwortung } from '../api';
import { heute } from '../bewertung';
import * as E from '../energiemanagementPortal';
import { UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG, UEMS_WER_IST_WOFUER_VERANTWORTLICH } from '../glossar';
import { VpDatePicker } from './VpDatePicker';

/**
 * „Wer ist wofür verantwortlich“ (UEMS AP-19 IP-13, PA4, R5) — eine Ansicht unter dem Reiter „Aufgaben“ über dem Leser
 * `GET …/verantwortung` (IP-10): die Aufgaben am Tag, daneben die Verantwortlichen der Objekte so, wie ihre Register sie
 * heute zeigen, und die Freigaben der Bezugsbasen. Gelesen, nichts kopiert, kein Urteil: ob die Verteilung genügt, sagt
 * eine Prüfung, nicht diese Übersicht; Verantwortung verleiht kein Recht. `saetze` zeigt Grenz- und Verantwortungs-Satz,
 * wo die Ansicht allein steht.
 */
export function EnergiemanagementVerantwortung({ onPerson, onZurueck, saetze = false }: { onPerson: (id: string) => void; onZurueck: () => void; saetze?: boolean }) {
  const [tag, setTag] = useState(() => heute());
  const [v, setV] = useState<Verantwortung | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.energiemanagementVerantwortung(tag).then(
      (r) => aktiv && setV(r),
      (e) => aktiv && setFehler(E.ablehnungSatz(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [tag]);
  const freigaben = v ? E.freigabenSatz(v.bezugsbasen_freigaben) : null;

  return (
    <section className="vp-ez-karte" aria-label={UEMS_WER_IST_WOFUER_VERANTWORTLICH} data-testid="verantwortung-ansicht">
      <button type="button" className="vp-em-hilfe" onClick={onZurueck} data-testid="verantwortung-zurueck">
        ← {UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT}
      </button>
      <h2>{UEMS_WER_IST_WOFUER_VERANTWORTLICH}</h2>
      <p className="vp-ez-leise">
        Die Verantwortlichen stehen so, wie die Register sie heute zeigen; die Aufgaben folgen dem gewählten Tag. Verantwortung verleiht kein Recht.
      </p>
      <VpDatePicker label="Aufgaben am" value={tag} onChange={(t) => t && setTag(t)} />
      {fehler ? (
        <p className="vp-ez-fehler" role="alert">{fehler}</p>
      ) : v === null ? (
        <p className="vp-ez-leise">Wird geladen …</p>
      ) : (
        <>
          <div className="vp-em-gruppe" data-testid="verantwortung-aufgaben">
            <h3>{UEMS_AUFGABEN_IM_ENERGIEMANAGEMENT}</h3>
            <ul className="vp-em-kurzliste">
              {v.aufgaben
                .filter((a) => a.aufgabe !== 'weitere' || a.laufend.length > 0)
                .map((a) => (
                  <li key={a.aufgabe} data-testid={`verantwortung-aufgabe-${a.aufgabe}`}>
                    {a.satz ?? (
                      <>
                        {a.wort} —{' '}
                        {a.laufend.map((z, i) => (
                          <span key={z.id}>
                            {i > 0 ? ', ' : ''}
                            <button type="button" className="vp-ez-zeile-knopf" onClick={() => onPerson(z.person.id)}>
                              {z.person.name}
                            </button>
                          </span>
                        ))}
                      </>
                    )}
                  </li>
                ))}
            </ul>
          </div>
          {E.objekteNachArt(v.objekte).map((g) => (
            <div key={g.art} className="vp-em-gruppe" data-testid={`verantwortung-art-${g.art}`}>
              <h3>{g.wort}</h3>
              <table className="vp-ez-tafel">
                <thead>
                  <tr>
                    <th scope="col">Kennzeichen</th>
                    <th scope="col">Titel</th>
                    <th scope="col">Verantwortlich</th>
                  </tr>
                </thead>
                <tbody>
                  {g.objekte.map((o) => (
                    <tr key={o.id} data-testid={`verantwortung-objekt-${o.kennzeichen}`}>
                      <td>{o.kennzeichen}</td>
                      <td data-label="Titel">{o.titel}</td>
                      <td data-label="Verantwortlich">{o.verantwortlich?.name ?? 'niemand eingetragen'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {g.art === 'bezugsbasis' && (
                <p className="vp-ez-leise">Verantwortlich an den Bezugsbasen: die Verantwortlichen der Kennzahlen.</p>
              )}
            </div>
          ))}
          {v.bezugsbasen_freigaben.length > 0 && (
            <div className="vp-em-gruppe" data-testid="verantwortung-freigaben">
              <h3>Freigaben der Bezugsbasen</h3>
              {freigaben && (
                <p className="vp-ez-satz" data-testid="verantwortung-freigaben-satz">
                  {freigaben}
                </p>
              )}
              <table className="vp-ez-tafel">
                <thead>
                  <tr>
                    <th scope="col">Bezugsbasis</th>
                    <th scope="col">Fassung</th>
                    <th scope="col">Freigegeben von</th>
                    <th scope="col">Am</th>
                  </tr>
                </thead>
                <tbody>
                  {v.bezugsbasen_freigaben.map((f) => (
                    <tr key={`${f.bezugsbasis_id}-${f.fassung}`} data-testid={`verantwortung-freigabe-${f.bezugsbasis}-${f.fassung}`}>
                      <td>
                        {f.bezugsbasis}
                        <span className="vp-ez-unter">{f.kennzahl}</span>
                      </td>
                      <td data-label="Fassung">{f.fassung}</td>
                      <td data-label="Freigegeben von">
                        {f.freigegeben_von ?? '—'}
                        {f.vieraugen && f.zweite_person ? ` · zweite Person ${f.zweite_person}` : ''}
                      </td>
                      <td data-label="Am">{E.tagText(f.freigegeben_am) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {saetze && (
        <div className="vp-em-saetze">
          <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
          <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
        </div>
      )}
    </section>
  );
}
