import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Netzanschluss, type Netzanschluesse, type StandortAmStichtag } from '../api';
import { NetzanschlussDialog } from '../components/NetzanschlussDialog';
import { Recht } from '../components/Recht';
import { heuteIn } from '../kennzahlKarte';
import * as N from '../netzanschlussListe';
import './StandortBereichPage.css';
import './StandortNetzanschluessePage.css';

export function StandortNetzanschluessePage({
  standort,
  onGeaendert,
}: {
  standort: StandortAmStichtag;
  onGeaendert: () => void;
}) {
  const [liste, setListe] = useState<Netzanschluesse | null>(null);
  const [fehler, setFehler] = useState(false);
  const [lauf, setLauf] = useState(0);
  const [dialog, setDialog] = useState<Netzanschluss | 'neu' | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const ausloeser = useRef<HTMLElement | null>(null);
  const heute = heuteIn(standort.zeitzone, Date.now());
  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    api.netzanschluesse(standort.id).then(
      (r) => {
        if (aktiv) setListe(r);
      },
      () => {
        if (aktiv) setFehler(true);
      },
    );
    return () => {
      aktiv = false;
    };
  }, [standort.id, lauf]);
  const oeffne = (e: React.MouseEvent<HTMLElement>, ziel: Netzanschluss | 'neu') => {
    ausloeser.current = e.currentTarget;
    setDialog(ziel);
  };
  const schliesse = () => {
    setDialog(null);
    requestAnimationFrame(() => ausloeser.current?.focus());
  };
  const gespeichert = (n: Netzanschluss) => {
    setListe(
      (l) =>
        l && {
          ...l,
          netzanschluesse: l.netzanschluesse.some((x) => x.id === n.id)
            ? l.netzanschluesse.map((x) => (x.id === n.id ? n : x))
            : [...l.netzanschluesse, n],
        },
    );
    schliesse();
    setMeldung(`${n.kennzeichen} gespeichert.`);
    setLauf((x) => x + 1);
    onGeaendert();
  };
  return (
    <section className="vp-sb vp-na" data-testid="netzanschluesse">
      <header className="vp-sb-kopf vp-na-kopf">
        <div>
          <h1>{N.TITEL}</h1>
          <p>{standort.name}</p>
        </div>
        {liste && standort.zustand !== 'archiviert' && (
          <Recht aktion={N.RECHT} standort={standort.id}>
            <Button onClick={(e) => oeffne(e, 'neu')}>{N.ANLEGEN}</Button>
          </Recht>
        )}
      </header>
      {meldung && <p role="status">{meldung}</p>}
      {fehler ? (
        <div role="alert" className="vp-sb-karte">
          <p>{N.NICHT_ABRUFBAR}</p>
          <Button variant="outline" onClick={() => setLauf((x) => x + 1)}>
            Erneut versuchen
          </Button>
        </div>
      ) : !liste ? (
        <p>Wird geladen …</p>
      ) : liste.netzanschluesse.length === 0 ? (
        <div className="vp-sb-karte">
          <h2>Noch kein Netzanschluss</h2>
          <p>Legen Sie den Netzanschluss an und binden Sie anschließend eine Anlage ab dem gewünschten Tag.</p>
        </div>
      ) : (
        <ul className="vp-na-liste">
          {liste.netzanschluesse.map((n) => (
            <li key={n.id} className="vp-sb-karte vp-na-karte" data-testid={`netzanschluss-${n.kennzeichen}`}>
              <div className="vp-na-kopf">
                <div>
                  <span className="vp-na-kennzeichen">{n.kennzeichen}</span>
                  <h2>{n.name}</h2>
                </div>
                <span>{n.messung}</span>
              </div>
              {N.leistung(n) && <p className="vp-na-leistung">{N.leistung(n)}</p>}
              <p className="vp-na-meta">
                {[n.malo ? `MaLo ${n.malo}` : 'Marktlokation nicht angegeben', n.netzbetreiber]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {n.gueltig_ab && <p>Besteht ab {N.tagText(n.gueltig_ab)}</p>}
              {n.gueltig_bis && <p>Besteht bis {N.tagText(n.gueltig_bis)}</p>}
              {n.hinweise.includes('vereinbart_ueber_anschluss') && <p>{N.HINWEIS_LEISTUNG}</p>}
              <div className="vp-na-bindungen">
                {n.anlagen.length ? (
                  n.anlagen.map((b) => (
                    <p key={b.id}>
                      {N.bindungsText(b)}
                      {!N.giltAm(b, heute) && (
                        <span className="vp-na-meta"> · {b.gueltig_ab > heute ? 'geplant' : 'beendet'}</span>
                      )}
                    </p>
                  ))
                ) : (
                  <p>Noch keine Anlage gebunden</p>
                )}
              </div>
              {standort.zustand !== 'archiviert' && (!n.gueltig_bis || n.gueltig_bis >= heute) && (
                <Recht aktion={N.RECHT} standort={standort.id}>
                  <Button variant="outline" onClick={(e) => oeffne(e, n)}>
                    Anlage binden / wechseln
                  </Button>
                </Recht>
              )}
            </li>
          ))}
        </ul>
      )}
      {dialog && liste && (
        <NetzanschlussDialog
          standort={standort}
          liste={liste.netzanschluesse}
          vorschlag={liste.kennzeichen_vorschlag}
          ziel={dialog === 'neu' ? null : dialog}
          heute={heute}
          onClose={schliesse}
          onGespeichert={gespeichert}
        />
      )}
    </section>
  );
}
