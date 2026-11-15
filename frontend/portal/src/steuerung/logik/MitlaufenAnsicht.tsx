/**
 * Die Ansicht „Mitlaufen“ (Bericht 8.4): die Logik rechnet auf der Box mit den echten Werten und schaltet nichts;
 * hier steht, ob sie zur selben Zeit dasselbe getan hätte wie die bisherige Steuerung - je Gerät die Abweichung und
 * das Vergleichsprotokoll eines Tages. Freiwillig (E5 = C): ein Werkzeug, keine Pflicht.
 */
import { useEffect, useState } from 'react';
import { type LogikAnsicht, type SteuerlogikVerlauf } from '../../api';
import { api } from '../../apiVoll';
import { VpDatePicker } from '../../components/VpDatePicker';
import { abweichungSatz, standText, tagDerAnlage, uhrzeit } from '../../steuerlogikMitlauf';
import { Ic } from '../Ic';
import { aktiveFassung } from './seite';

export interface MitlaufenAnsichtProps {
  siteId: string;
  ansicht: LogikAnsicht;
  jetzt: Date;
  /** Startet das Mitlaufen der neuesten Fassung; `null`, wenn es nicht geht (die Box kann es nicht, ohne Recht). */
  onStart: (() => void) | null;
}

export function MitlaufenAnsicht({ siteId, ansicht, jetzt, onStart }: MitlaufenAnsichtProps) {
  const aktiv = aktiveFassung(ansicht);
  const [tag, setTag] = useState(() => tagDerAnlage(jetzt));
  const [verlauf, setVerlauf] = useState<SteuerlogikVerlauf | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    let gilt = true;
    setVerlauf(null);
    api.siteSteuerlogikVerlauf(siteId, ansicht.logikId, tag).then(
      (v) => { if (gilt) { setVerlauf(v); setFehler(null); } },
      () => { if (gilt) setFehler('Das Protokoll ließ sich nicht laden.'); },
    );
    return () => { gilt = false; };
  }, [siteId, ansicht.logikId, tag]);

  const lauf = ansicht.lauf;
  const geraete = Object.entries(lauf?.rueckmeldung?.geraete ?? {});
  const naechster = ansicht.fassungen[0];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="card lk-abschnitt" aria-label="Lauf">
        <div className="lk-abschnitt-kopf">
          <h2>{aktiv ? `Fassung ${aktiv.fassung} ${aktiv.zustand === 'scharf' ? 'ist scharf' : 'läuft mit'}` : 'Läuft nicht'}</h2>
          {lauf ? <span className="meta">gemeldet {uhrzeit(lauf.gemeldetAm)}</span> : null}
        </div>
        {aktiv?.zustand === 'mitlaufend' ? (
          <p>Die Box rechnet mit den echten Werten und schaltet nichts. Die Geräte bleiben bei ihrer bisherigen Steuerung.</p>
        ) : aktiv?.zustand === 'scharf' ? (
          <p>Die Box schaltet nach dieser Fassung. Der Vergleich zeigt, ob die Geräte getan haben, was die Logik wollte.</p>
        ) : (
          <p>Lassen Sie eine Fassung mitlaufen, um sie mit echten Werten zu sehen, ohne dass sie schaltet.</p>
        )}
        {!ansicht.boxKann ? <p className="lk-leer">Die Box dieser Anlage kann noch keine Logik mitlaufen lassen.</p> : null}
        {onStart && naechster && naechster.zustand === 'geprueft' && aktiv?.zustand !== 'scharf' ? (
          <div className="lk-knoepfe">
            <button type="button" className="btn" onClick={onStart} disabled={!ansicht.boxKann}>
              <Ic n="play" s={18} />
              Fassung {naechster.fassung} mitlaufen lassen
            </button>
          </div>
        ) : null}
        {lauf && aktiv && lauf.fassung !== aktiv.fassung ? (
          <p className="lk-leer">Die Box meldet noch Fassung {lauf.fassung}.</p>
        ) : null}
        {geraete.length ? (
          <ul className="lk-liste" aria-label="Vergleich je Gerät">
            {geraete.map(([k, g]) => (
              <li key={k}>
                <div className="lk-zeile-kopf">
                  <b>{g.name ?? k}</b>
                  <span className={`pill ${g.abweichend_s === 0 && g.verglichen_s > 0 ? 'on' : g.verglichen_s === 0 ? 'off' : 'wait'}`}>
                    <i />
                    {g.abweichend_s === 0 && g.verglichen_s > 0 ? 'gleich' : g.verglichen_s === 0 ? 'offen' : 'weicht ab'}
                  </span>
                </div>
                <small>Würde: {standText(g.wunsch)} · Ist: {standText(g.ist)}</small>
                <small>{abweichungSatz(g.abweichend_s, g.verglichen_s)} · {g.wunsch_wechsel} Wechsel gewollt, {g.ist_wechsel} geschaltet</small>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card lk-abschnitt" aria-label="Vergleichsprotokoll">
        <div className="lk-abschnitt-kopf">
          <h2>Vergleichsprotokoll</h2>
          <VpDatePicker ariaLabel="Tag" value={tag} max={tagDerAnlage(jetzt)} onChange={(t) => t && setTag(t)} />
        </div>
        <p>Jeder Wechsel des Tages: was die Logik wollte und was das Gerät tat.</p>
        {fehler ? <p className="stn-fehler">{fehler}</p> : null}
        {verlauf && verlauf.wechsel.length === 0 ? <p className="lk-leer">An diesem Tag gab es keinen Wechsel.</p> : null}
        {verlauf && verlauf.wechsel.length ? (
          <div className="lk-scroll">
            <table className="lk-tabelle">
              <thead><tr><th>Zeit</th><th>Gerät</th><th>Was</th><th>Neu</th><th>Die andere Seite</th></tr></thead>
              <tbody>
                {verlauf.wechsel.slice().reverse().map((w) => (
                  <tr key={`${w.laufSeit}-${w.nr}`}>
                    <td className="zeit">{uhrzeit(w.t)}</td>
                    <td>{lauf?.rueckmeldung?.geraete?.[w.geraet]?.name ?? w.geraet}</td>
                    <td>{w.was === 'wunsch' ? 'Logik will' : 'Gerät ist'}</td>
                    <td>{standText(w.neu)}</td>
                    <td>{standText(w.andere)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
