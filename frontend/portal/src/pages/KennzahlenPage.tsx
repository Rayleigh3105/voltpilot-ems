import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Kennzahl } from '../api';
import { ErrorState, Skeleton } from '../components/States';
import {
  ANZAHL_VERLAUF,
  anfrage,
  heuteIn,
  LADEFEHLER,
  LADEN,
  LEER,
  listenKarte,
  TITEL,
  type ListenKarte,
  type ListenWerte,
} from '../kennzahlKarte';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { KennzahlSeite } from './KennzahlSeite';
import './KennzahlenPage.css';

/**
 * „Unternehmen › Kennzahlen“ (UEMS AP-11 IP-13, `#/portfolio/kennzahlen`) und die Kennzahl-Seite
 * (`#/portfolio/kennzahlen/{id}`, §5.3) — eine Portfolio-Welt neben „Standorte“, bis AP-13 die Ebenen-Navigation
 * bringt.
 *
 * Die Liste liest `GET /api/v1/kennzahlen` und je Kennzahl das Fenster des Verlaufs in ihrer Grundperiode
 * (`…/werte`, IP-7) — gezeigt wird der jüngste Schritt mit einer Zeile; jede Ableitung steht im reinen Modul
 * `kennzahlKarte.ts`.
 *
 * ⚠ Einen Knopf „Kennzahl anlegen“ gibt es hier noch nicht: der Assistent kommt mit IP-14 — vorher kein Knopf ohne Ziel.
 * ⚠ R-A7: antwortet `…/werte` für eine gelistete Kennzahl mit 404, trägt die Karte die Hinweiszeile ohne Wert.
 */
export function KennzahlenPage({
  kennzahlId = null,
  onOeffnen,
  onListe,
  zone = VORGABE_ZEITZONE,
}: {
  kennzahlId?: string | null;
  onOeffnen: (id: string) => void;
  onListe: () => void;
  /** Die Zeitzone, in der „heute“ liegt. */
  zone?: string;
}) {
  if (kennzahlId) return <KennzahlSeite key={kennzahlId} id={kennzahlId} zone={zone} onListe={onListe} />;
  return <KennzahlenListe zone={zone} onOeffnen={onOeffnen} />;
}

function KennzahlenListe({ zone, onOeffnen }: { zone: string; onOeffnen: (id: string) => void }) {
  const [liste, setListe] = useState<Kennzahl[] | null>(null);
  const [werte, setWerte] = useState<Record<string, ListenWerte>>({});
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    api.kennzahlen().then(
      ({ kennzahlen }) => {
        if (!aktiv) return;
        setListe(kennzahlen);
        setWerte({});
        const heute = heuteIn(zone, Date.now());
        const setze = (id: string, w: ListenWerte) => aktiv && setWerte((alt) => ({ ...alt, [id]: w }));
        for (const k of kennzahlen) {
          const art = k.grundperiode ?? k.perioden[0] ?? null;
          if (art === null) {
            setze(k.id, { art: 'ohne_periode' });
            continue;
          }
          const { von, bis } = anfrage(art, heute, ANZAHL_VERLAUF[art]);
          api.kennzahlWerte(k.id, art, von, bis).then(
            (antwort) => setze(k.id, { art: 'geladen', antwort }),
            (e) => setze(k.id, e instanceof ApiError && e.status === 404 ? { art: 'ausserhalb' } : { art: 'fehler' }),
          );
        }
      },
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [zone, versuch]);

  // Archivierte stehen hinten — sonst die Reihenfolge der Route.
  const sortiert = liste ? [...liste].sort((a, b) => Number(a.archiviert_am !== null) - Number(b.archiviert_am !== null)) : [];

  return (
    <div className="vp-kz" data-testid="kennzahlen">
      <header className="vp-kz-kopf">
        <h1>{TITEL}</h1>
      </header>
      {fehler ? (
        <ErrorState message={LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !liste ? (
        <div aria-busy="true" aria-label={LADEN}>
          <Skeleton height={132} />
        </div>
      ) : liste.length === 0 ? (
        <p className="vp-kz-leer">{LEER}</p>
      ) : (
        <ul className="vp-kz-liste">
          {sortiert.map((k) => (
            <li key={k.id}>
              <KennzahlKarte karte={listenKarte(k, werte[k.id] ?? { art: 'laedt' })} onOeffnen={() => onOeffnen(k.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KennzahlKarte({ karte, onOeffnen }: { karte: ListenKarte; onOeffnen: () => void }) {
  return (
    <button type="button" className="vp-kz-karte" data-testid="kennzahl-karte" onClick={onOeffnen}>
      <span className="vp-kz-karte-kopf">
        <span className="vp-kz-kennzeichen">{karte.kennzeichen}</span>
        {karte.archiviert && <Badge variant="tint">{karte.archiviert}</Badge>}
        <span className="vp-kz-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-kz-name">{karte.name}</span>
      {karte.hinweis ? (
        <span className="vp-kz-hinweis" data-testid="kennzahl-hinweis">
          {karte.hinweis}
        </span>
      ) : karte.fehler ? (
        <span className="vp-kz-hinweis">{karte.fehler}</span>
      ) : karte.zahl === null ? (
        <span className="vp-kz-platzhalter" aria-hidden="true" />
      ) : (
        <>
          <span className="vp-kz-zahl" data-testid="kennzahl-zahl">
            {karte.zahl}
          </span>
          {(karte.zustand || karte.periode) && (
            <span className="vp-kz-abzeichen">
              {karte.zustand && <Badge variant={karte.zustandTon}>{karte.zustand}</Badge>}
              {karte.periode && <span>{karte.periode}</span>}
            </span>
          )}
        </>
      )}
      <span className="vp-kz-unter">{karte.unter}</span>
    </button>
  );
}
