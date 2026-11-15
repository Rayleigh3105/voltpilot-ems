/**
 * Die Ansicht „Fassungen“ (Bericht 8.9): jede gespeicherte Fassung mit Urheber, Rolle, Zeit, Notiz und Proben;
 * zwei Fassungen Zeile für Zeile vergleichen, dazu welche Proben sich geändert haben; zurück auf eine frühere Fassung
 * (sie löst die laufende ab, im selben Zustand). Scharf schaltet in Stufe 4 die Plattform; der Kunde legt vor.
 */
import { useEffect, useState } from 'react';
import { type LogikAnsicht, type LogikFassungKopf } from '../../api';
import { api } from '../../apiVoll';
import { Blatt } from '../Blatt';
import { aktiveFassung, pille, rolleWort, vorgelegt, type Handlung } from './seite';
import { probenVergleich, vergleiche, zaehle, type Teil } from './vergleich';

export interface FassungenAnsichtProps {
  siteId: string;
  ansicht: LogikAnsicht;
  /** Ein Schritt an einer Fassung: mitlaufen, vorlegen, scharf (Plattform), zurück. */
  onSchritt: (fassung: number, schritt: Handlung | 'zurueck') => void;
  /** Den Text einer Fassung in den Entwurf holen (zum Weiterschreiben). */
  onUebernehmen: (fassung: number) => void;
}

const DATUM = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function datum(iso: string): string {
  return DATUM.format(new Date(iso));
}

function proben(f: LogikFassungKopf): string {
  const p = f.bericht?.proben ?? [];
  if (!p.length) return 'keine Proben';
  return `${p.filter((x) => x.besteht).length} von ${p.length} Proben`;
}

export function FassungenAnsicht({ siteId, ansicht, onSchritt, onUebernehmen }: FassungenAnsichtProps) {
  const [vergleich, setVergleich] = useState<{ alt: LogikFassungKopf; neu: LogikFassungKopf } | null>(null);
  const aktiv = aktiveFassung(ansicht);
  const v = vorgelegt(ansicht);
  return (
    <section className="card lk-abschnitt" aria-label="Fassungen">
      <div className="lk-abschnitt-kopf"><h2>Fassungen <small>{ansicht.fassungen.length}</small></h2></div>
      <p>Jede gespeicherte Fassung. Zurück wirkt sofort und behält den Zustand der laufenden.</p>
      <ul className="lk-liste">
        {ansicht.fassungen.map((f, i) => {
          const p = f.zustand === 'geprueft' && v?.fassung === f.fassung ? pille('geprueft', null, f.fassung)
            : pille(f.zustand, f.zustand === 'mitlaufend' || f.zustand === 'scharf' ? f.fassung : null);
          const vorige = ansicht.fassungen[i + 1] ?? null;
          const vergleichMit = aktiv && aktiv.fassung !== f.fassung ? aktiv : vorige;
          const zurueckErlaubt = ansicht.darfBearbeiten && aktiv != null && aktiv.fassung !== f.fassung
            && (aktiv.zustand !== 'scharf' || f.scharfAm != null || ansicht.plattform);
          return (
            <li key={f.fassung} data-fassung={f.fassung}>
              <div className="lk-zeile-kopf">
                <b>Fassung {f.fassung}</b>
                <span className={`pill ${p.klasse}`}><i />{p.wort.replace(/ · Fassung \d+$/, '')}</span>
              </div>
              <small>
                {datum(f.angelegtAm)} · {f.angelegtVon ?? 'unbekannt'}{rolleWort(f.rolle) ? ` (${rolleWort(f.rolle)})` : ''} · {proben(f)}
              </small>
              {f.notiz ? <small>„{f.notiz}“</small> : null}
              {f.vorgelegtAm ? <small>Zur Freigabe vorgelegt am {datum(f.vorgelegtAm)}{f.vorgelegtVon ? ` von ${f.vorgelegtVon}` : ''}</small> : null}
              {f.scharfAm ? <small>Scharf geschaltet am {datum(f.scharfAm)}</small> : null}
              <div className="lk-knoepfe">
                {vergleichMit ? (
                  <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); setVergleich(vergleichMit.fassung < f.fassung ? { alt: vergleichMit, neu: f } : { alt: f, neu: vergleichMit }); }}>
                    Mit {vergleichMit.fassung} vergleichen
                  </button>
                ) : null}
                {ansicht.darfBearbeiten && i > 0 ? (
                  <button type="button" className="tbtn" onClick={() => onUebernehmen(f.fassung)}>Als Entwurf öffnen</button>
                ) : null}
                {zurueckErlaubt ? (
                  <button type="button" className="tbtn" onClick={() => onSchritt(f.fassung, 'zurueck')}>Zurück auf diese</button>
                ) : null}
                {ansicht.plattform && f.zustand !== 'scharf' && (v?.fassung === f.fassung || (i === 0 && f.zustand === 'geprueft') || f.zustand === 'mitlaufend') ? (
                  <button type="button" className="tbtn on" onClick={() => onSchritt(f.fassung, 'scharf')}>Scharf schalten</button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {vergleich ? <VergleichBlatt siteId={siteId} logikId={ansicht.logikId} alt={vergleich.alt} neu={vergleich.neu} onClose={() => setVergleich(null)} /> : null}
    </section>
  );
}

function VergleichBlatt({ siteId, logikId, alt, neu, onClose }: { siteId: string; logikId: string; alt: LogikFassungKopf; neu: LogikFassungKopf; onClose: () => void }) {
  const [teile, setTeile] = useState<Teil[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => {
    let gilt = true;
    Promise.all([api.logikText(siteId, logikId, alt.fassung), api.logikText(siteId, logikId, neu.fassung)]).then(
      ([a, b]) => { if (gilt) setTeile(vergleiche(a.text, b.text)); },
      () => { if (gilt) setFehler('Die Texte ließen sich nicht laden.'); },
    );
    return () => { gilt = false; };
  }, [siteId, logikId, alt.fassung, neu.fassung]);
  const z = teile ? zaehle(teile) : null;
  const pv = probenVergleich(alt.bericht, neu.bericht);
  return (
    <Blatt symbol="layers" titel={`Fassung ${alt.fassung} und ${neu.fassung}`} unter={z ? `${z.dazu} Zeilen dazu, ${z.weg} weg` : 'wird geladen …'} voll breit onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        {fehler ? <p className="stn-fehler">{fehler}</p> : null}
        {pv.length ? (
          <div className="blk">
            <h3>Proben</h3>
            <ul className="lk-eintraege">
              {pv.map((x) => (
                <li key={x.name} className="lk-eintrag" style={{ cursor: 'default' }}>
                  <span><b>{x.name}</b><small>{x.was === 'neu' ? 'neu' : x.was === 'weg' ? 'entfernt' : x.was}</small></span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {teile ? (
          <div className="lk-diff" role="region" aria-label="Vergleich Zeile für Zeile" tabIndex={0}>
            {teile.map((t, i) => {
              if (t.art === 'ausgelassen') return <div key={i} className="aus">… {t.anzahl} Zeilen gleich</div>;
              if (t.art === 'gleich') {
                return t.zeilen.map((zeile, j) => (
                  <div key={`${i}-${j}`}><span>{t.neu + j}</span><span /><code>{zeile}</code></div>
                ));
              }
              return (
                <div key={i} className={t.art}>
                  <span>{t.art === 'dazu' ? t.neu : t.alt}</span>
                  <span aria-label={t.art === 'dazu' ? 'dazu' : 'weg'}>{t.art === 'dazu' ? '+' : '−'}</span>
                  <code>{t.zeile}</code>
                </div>
              );
            })}
          </div>
        ) : null}
        {teile && z && z.dazu === 0 && z.weg === 0 ? <p className="leise">Die Texte sind gleich.</p> : null}
      </div>
    </Blatt>
  );
}

