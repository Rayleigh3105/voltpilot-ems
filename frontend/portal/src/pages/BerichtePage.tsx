import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht } from '../api';
import { ErrorState, Skeleton } from '../components/States';
import { LADEN, LEER, listenFehler, listenKarte, sortiert, TITEL, type ListenKarte } from '../berichtSeite';
import { BerichtSeite } from './BerichtSeite';
import './BerichtePage.css';

/**
 * „Unternehmen › Berichte“ (UEMS AP-12 IP-13, `#/portfolio/berichte`) und die Berichtsseite
 * (`#/portfolio/berichte/{kennung}`) — eine Portfolio-Welt neben „Kennzahlen“, bis AP-13 die Ebenen-Navigation bringt.
 *
 * Die Liste liest `GET /api/v1/berichte` (nur, was die Person lesen darf, G2) und zeigt je Bericht Vorlage, Geltung,
 * Zeitraum und den Vermerk (R5); jede Ableitung steht im reinen Modul `berichtSeite.ts`. Eine 403 (die Unterstützung
 * liest nie einen Bericht) steht als Satz der Route da, ohne „Erneut versuchen“.
 *
 * ⚠ „Bericht anlegen“ kommt mit IP-14, „letzter Abruf“ mit dem Abruf-Protokoll (IP-10) — vorher kein Knopf und keine
 *   Spalte ohne Ziel.
 */
export function BerichtePage({
  kennung = null,
  onOeffnen,
  onListe,
}: {
  kennung?: string | null;
  onOeffnen: (kennung: string) => void;
  onListe: () => void;
}) {
  if (kennung) return <BerichtSeite key={kennung} kennung={kennung} onListe={onListe} />;
  return <BerichteListe onOeffnen={onOeffnen} />;
}

function BerichteListe({ onOeffnen }: { onOeffnen: (kennung: string) => void }) {
  const [liste, setListe] = useState<Bericht[] | null>(null);
  const [fehler, setFehler] = useState<{ satz: string; erneut: boolean } | null>(null);
  const [versuch, setVersuch] = useState(0);

  useEffect(() => {
    let aktiv = true;
    setFehler(null);
    api.berichte().then(
      ({ berichte }) => aktiv && setListe(berichte),
      (e) => aktiv && setFehler(listenFehler(e)),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  return (
    <div className="vp-br" data-testid="berichte">
      <header className="vp-br-kopf">
        <h1>{TITEL}</h1>
      </header>
      {fehler ? (
        fehler.erneut ? (
          <ErrorState message={fehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
        ) : (
          <p className="vp-br-hinweis" role="status" data-testid="berichte-verwehrt">
            {fehler.satz}
          </p>
        )
      ) : !liste ? (
        <div aria-busy="true" aria-label={LADEN}>
          <Skeleton height={112} />
        </div>
      ) : liste.length === 0 ? (
        <p className="vp-br-leer">{LEER}</p>
      ) : (
        <ul className="vp-br-liste">
          {sortiert(liste).map((b) => (
            <li key={b.kennung}>
              <BerichtKarte karte={listenKarte(b)} onOeffnen={() => onOeffnen(b.kennung)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BerichtKarte({ karte, onOeffnen }: { karte: ListenKarte; onOeffnen: () => void }) {
  return (
    <button type="button" className="vp-br-karte" data-testid="bericht-karte" onClick={onOeffnen}>
      <span className="vp-br-karte-kopf">
        <span className="vp-br-kennung">{karte.kennung}</span>
        {karte.archiviert && <Badge variant="tint">{karte.archiviert}</Badge>}
        <span className="vp-br-pfeil" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      </span>
      <span className="vp-br-name">{karte.titel}</span>
      {karte.stand && (
        <span className="vp-br-karte-stand">
          <Badge variant={karte.standTon} data-testid="bericht-stand">
            {karte.stand}
          </Badge>
        </span>
      )}
      <span className="vp-br-unter">{karte.unter}</span>
    </button>
  );
}
