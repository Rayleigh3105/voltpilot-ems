import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { api, type Erzeugungsanlagen } from '../api';
import * as E from '../erzeugungsanlagen';
import { ErzeugungsanlagenListe } from './ErzeugungsanlagenListe';

/**
 * Die Erzeugungsanlagen am Netzanschluss (Messkonzepte S1, nur Anzeige): die EA der Anlage, die heute an diesem
 * Netzanschluss hängt - eine Anlage hängt je Tag an genau einem. Ansehen, hinzufügen (mit MaStR-Nachschlagen) und
 * bearbeiten. Ein Messkonzept steht hier erst mit Schritt S2.
 */
export function NetzanschlussErzeugungsanlagen({
  siteId,
  anlageName,
  standortId,
  heute,
}: {
  siteId: string;
  anlageName: string | null;
  standortId: string;
  heute: string;
}) {
  const [liste, setListe] = useState<Erzeugungsanlagen | null>(null);
  const [fehler, setFehler] = useState(false);
  const [lauf, setLauf] = useState(0);
  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    api.erzeugungsanlagen(siteId).then(
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
  }, [siteId, lauf]);
  return (
    <div className="vp-na-ea" data-testid={`na-erzeugungsanlagen-${siteId}`}>
      <h3>{E.TITEL}</h3>
      {anlageName && <p className="vp-na-meta">über {anlageName}</p>}
      {fehler ? (
        <div role="alert">
          <p>{E.NICHT_ABRUFBAR}</p>
          <Button variant="outline" size="sm" onClick={() => setLauf((x) => x + 1)}>
            Erneut versuchen
          </Button>
        </div>
      ) : !liste ? (
        <p>Wird geladen …</p>
      ) : (
        <ErzeugungsanlagenListe siteId={siteId} liste={liste} heute={heute} standort={standortId} onGeaendert={setListe} />
      )}
    </div>
  );
}
