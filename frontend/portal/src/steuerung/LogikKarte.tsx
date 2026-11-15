/**
 * Die Karte einer scharfen Logik im Reiter „Geräte“ (Steuerlogik Stufe 3, Bericht 6.5 und 17.3): ein Satz, die
 * Störung zuerst, der Schalter, den der Kunde selbst stellt (etwa „Winterregelung“), und „Warum?“. Die Karte
 * rechnet nichts: alles kommt aus `steuerlogikKarte.ts`.
 */
import type { SteuerlogikKarte } from '../api';
import { fusszeile, geltend, istAn, kartenSchalter, kopf, pille, zusatzStoerung } from '../steuerlogikKarte';
import { Ic } from './Ic';

export interface LogikKarteProps {
  karte: SteuerlogikKarte;
  jetzt: Date;
  /** Ein Wert wird gerade gesendet (Kennung), sonst `null`. */
  sendet: string | null;
  onWarum: () => void;
  onSchalter: (kennung: string, an: boolean) => void;
}

export function LogikKarte({ karte, jetzt, sendet, onWarum, onSchalter }: LogikKarteProps) {
  const p = pille(karte);
  const k = kopf(karte);
  const s = zusatzStoerung(karte);
  const schalter = kartenSchalter(karte);
  const geraete = karte.geraete.length === 1 ? '1 Gerät' : `${karte.geraete.length} Geräte`;
  return (
    <section className="card lg-karte links" aria-label={`Logik ${karte.name}`} data-logik={karte.logikId}>
      <div className="lg-kopf">
        <span className={`ico${p.klasse === 'lock' ? ' warn' : ''}`}>
          <Ic n={p.klasse === 'lock' ? 'alert' : 'sliders'} s={22} />
        </span>
        <span className="lg-t">
          <small>Logik · {geraete}</small>
          <b>{karte.name}</b>
        </span>
        <span className={`pill ${p.klasse}`}>
          <i />
          {p.wort}
        </span>
      </div>
      <p className="lg-titel">{k.titel}</p>
      {k.satz ? <p className="lg-satz">{k.satz}</p> : null}
      {s ? (
        <p className="lg-stoerung" role="status">
          <Ic n="alert" s={16} />
          <span>{s.text}</span>
        </p>
      ) : null}
      {schalter.map((sw) => {
        const an = istAn(geltend(sw));
        return (
          <div className="lg-schalter" key={sw.kennung}>
            <span>
              <b>{sw.name}</b>
              {sw.hilfe ? <small>{sw.hilfe}</small> : null}
            </span>
            {sw.aendern ? (
              <button
                type="button"
                className="sw"
                role="switch"
                aria-checked={an}
                aria-label={sw.name}
                disabled={sendet === sw.kennung}
                onClick={() => onSchalter(sw.kennung, !an)}
              />
            ) : (
              <b className="lg-wert">{an ? 'an' : 'aus'}</b>
            )}
          </div>
        );
      })}
      <div className="lg-fuss">
        <span className="meta">{fusszeile(karte, jetzt)}</span>
        <button type="button" className="lnk" onClick={(e) => { e.currentTarget.focus(); onWarum(); }}>
          Warum?
          <Ic n="help" s={16} />
        </button>
      </div>
    </section>
  );
}
