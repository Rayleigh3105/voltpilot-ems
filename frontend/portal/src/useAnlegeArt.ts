import { useEffect, useState } from 'react';
import { api, type Funktionen } from './api';
import { anlegeArt, type AnlegeArt, type AnlegeOrt } from './anlegeNurMessen';

/** Lädt den EINEN Entscheid des Anlege-Flusses; `null` heißt noch nicht oder nicht sicher entschieden. */
export function useAnlegeArt(ort: AnlegeOrt = {}): AnlegeArt | null {
  const [funktionen, setFunktionen] = useState<Funktionen | null | undefined>(undefined);

  useEffect(() => {
    let aktiv = true;
    api.funktionen().then(
      (antwort) => {
        if (aktiv) setFunktionen(antwort);
      },
      () => {
        if (aktiv) setFunktionen(null);
      },
    );
    return () => {
      aktiv = false;
    };
  }, []);

  return funktionen === undefined ? null : anlegeArt(funktionen, ort);
}
