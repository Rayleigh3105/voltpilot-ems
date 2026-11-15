/**
 * Die Logiken im Reiter „Regeln“ (E7 = A: „Regel“ bleibt, Mehrteiliges heißt „Logik“): neben den Sätzen der
 * Regeln je Logik eine Karte mit Zustand und Lage; ein Tipp öffnet die Logik (Aufbau, Text, Mitlaufen, Fassungen,
 * Protokoll). „Neue Logik“ nur für wer die Logik bearbeiten darf (Kundenadministrator, Fachbetrieb, VoltPilot).
 */
import type { LogikListe } from '../../api';
import { logikHash } from '../../nav';
import { Ic } from '../Ic';
import { kopfPille } from './seite';

export function LogikenAbschnitt({ siteId, liste }: { siteId: string; liste: LogikListe | null }) {
  if (!liste || (!liste.logiken.length && !liste.darfBearbeiten)) return null;
  const oeffne = (id: string) => { window.location.hash = logikHash(siteId, id); };
  return (
    <section aria-label="Ihre Logiken" style={{ display: 'grid', gap: 8 }} className="links">
      <div className="grp-h"><h3>Logiken</h3>{liste.logiken.length > 0 && <span>{liste.logiken.length}</span>}</div>
      {liste.logiken.map((l) => {
        const p = kopfPille(l);
        return (
          <article className="card lg-karte links" key={l.logikId} data-logik={l.logikId}>
            <button type="button" className="lk-eintrag" style={{ padding: 0, minHeight: 44 }} onClick={() => oeffne(l.logikId)} aria-label={`Logik ${l.name} öffnen`}>
              <span>
                <b>{l.name}</b>
                <small>{l.lage?.titel ?? (l.aktiv ? `Fassung ${l.aktiv}` : `Fassung ${l.neueste} · läuft nicht`)}</small>
              </span>
              <Ic n="chevR" s={18} />
            </button>
            <div className="r-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className={`pill ${p.klasse}`}><i />{p.wort}</span>
              {l.offeneAnfragen > 0 && liste.darfBearbeiten ? (
                <span className="pill wait"><i />{l.offeneAnfragen === 1 ? '1 Anfrage' : `${l.offeneAnfragen} Anfragen`}</span>
              ) : null}
            </div>
          </article>
        );
      })}
      {liste.darfBearbeiten ? (
        <>
          {!liste.logiken.length ? <p className="leise" style={{ padding: '0 4px' }}>Mehrere Geräte nach eigenen Regeln zusammen steuern: eine Logik.</p> : null}
          <button type="button" className="btn sek" style={{ justifySelf: 'start' }} onClick={() => oeffne('neu')}>
            <Ic n="plus" s={18} />
            Neue Logik
          </button>
        </>
      ) : null}
    </section>
  );
}
