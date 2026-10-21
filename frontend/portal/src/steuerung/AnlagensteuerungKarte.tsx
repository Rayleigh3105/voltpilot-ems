/**
 * Steuerung › Geräte, Ansicht „nur messen“, an einer Anlage mit Anlagensteuerung (UEMS EZ-10, EW-3 A): wer die
 * Anlage steuert - Netzbetreiber und Direktvermarkter, VoltPilot liest nur - und je Einheit Soll, Ist, ob sie
 * folgt und ob sie für den Direktvermarkter bereit ist. Kein neuer Reiter; ohne Anlagensteuerung (oder an einem
 * älteren Backend) rendert die Karte nichts. Die Ableitungen stehen in `anlagensteuerung.ts`.
 */
import type { Anlagensteuerung, AnlagensteuerungWerte, NetzVermarktung } from '../api';
import {
  datenstandZeile,
  einheitZeilen,
  folgtSatz,
  steuerSatz,
  werteJe,
  type EinheitZeile,
} from '../anlagensteuerung';
import { useAnlagensteuerung } from '../useAnlagensteuerung';
import { Ic } from './Ic';

export function AnlagensteuerungKarten({ siteId, now }: { siteId: string; now?: Date }) {
  const stand = useAnlagensteuerung(siteId);
  const steuerungen = stand.liste?.steuerungen ?? [];
  if (steuerungen.length === 0) return null;
  return (
    <>
      {steuerungen.map((s) => (
        <AnlagensteuerungKarte
          key={s.geraet_id}
          steuerung={s}
          werte={stand.werte[s.geraet_id] ?? null}
          nv={stand.netzVermarktung}
          now={now}
        />
      ))}
    </>
  );
}

export function AnlagensteuerungKarte({
  steuerung: s,
  werte,
  nv,
  now = new Date(),
}: {
  steuerung: Anlagensteuerung;
  /** `null` = noch nicht geladen. */
  werte: AnlagensteuerungWerte | null;
  nv: NetzVermarktung | null;
  now?: Date;
}) {
  const je = werteJe(werte);
  const zeilen = einheitZeilen(s, werte, nv, now);
  const folgt = folgtSatz(je);
  const stand = datenstandZeile(werte, now);
  const ohneDaten = werte?.stand === 'noch_keine_daten';
  return (
    <section className="card links erz" id={`erz-${s.geraet_id}`} aria-labelledby={`erz-h-${s.geraet_id}`}>
      <div className="card-h">
        <h2 id={`erz-h-${s.geraet_id}`}>
          <Ic n="cpu" s={18} />
          {s.bezeichnung ?? 'Anlagensteuerung'}
        </h2>
        {werte && <span className="meta">{stand.wert}</span>}
      </div>
      <p className="j-say">{steuerSatz(nv, je)}</p>
      {folgt && <p className="leise erz-folgt">{folgt}</p>}
      {ohneDaten && <p className="leise">Von dieser Steuerung liegen noch keine Daten vor.</p>}
      {zeilen.length === 0 ? (
        <p className="leise">An dieser Steuerung ist noch keine Einheit eingetragen.</p>
      ) : (
        <ul className="erz-liste" aria-label="Einheiten">
          {zeilen.map((z) => (
            <EinheitEintrag key={z.teNr} z={z} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EinheitEintrag({ z }: { z: EinheitZeile }) {
  return (
    <li className="erz-zeile" data-testid="erz-einheit">
      <span className="ico">
        <Ic n={z.symbol} s={21} />
      </span>
      <span className="d-mid">
        <span className="d-name erz-kopf">
          <b>{z.name}</b>
          <Folgt z={z} />
        </span>
        {(z.unter || z.zustand) && (
          <span className="d-satz">{[z.unter, z.zustand].filter(Boolean).join(' · ')}</span>
        )}
        <span className="erz-werte">
          <span>
            Soll <b>{z.soll}</b>
          </span>
          <span>
            Ist <b>{z.ist}</b>
          </span>
        </span>
        {z.dv && <span className={`erz-dv ${z.dv.bereit ? 'is-bereit' : 'is-nicht'}`}>{z.dv.text}</span>}
        {z.veraltet && <span className="erz-alt">{z.veraltet}</span>}
      </span>
    </li>
  );
}

function Folgt({ z }: { z: EinheitZeile }) {
  if (z.ohneDaten) {
    return (
      <span className="pill stale">
        <i />
        noch keine Daten
      </span>
    );
  }
  if (z.folgt === 'folgt') {
    return (
      <span className="pill on">
        <i />
        folgt
      </span>
    );
  }
  if (z.folgt === 'folgt_nicht') {
    return (
      <span className="pill wait">
        <i />
        folgt nicht
      </span>
    );
  }
  return null;
}
