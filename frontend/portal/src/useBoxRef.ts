/**
 * Die Boxen des Kundenbereichs für Flächen, die keine Geräteliste mitbekommen (Steuerung › Geräte, Verlauf,
 * Meldungen) und doch auf eine Geräteseite verweisen — dort steht die Box-Referenz im Pfad (`…/geraet/{ref}/…`).
 * Erst abgefragt, wenn eine Fläche es braucht (`aktiv`); fail-soft: ohne Antwort `null`, dann fehlt nur der Verweis.
 */
import { useEffect, useState } from 'react';
import { api, type Device } from './api';
import { boxRefOf } from './geraetAdresse';

export function useBoxen(aktiv: boolean): Device[] | null {
  const [boxen, setBoxen] = useState<Device[] | null>(null);
  useEffect(() => {
    if (!aktiv) return undefined;
    let laeuft = true;
    api.listDevices().then(
      (l) => laeuft && setBoxen(l.eintraege),
      () => undefined,
    );
    return () => {
      laeuft = false;
    };
  }, [aktiv]);
  return boxen;
}

/** Die Referenz der führenden Box einer Anlage (dieselbe Regel wie `boxRefOf`); null = keine sichere oder noch keine. */
export function useBoxRef(siteId: string | null, aktiv = true): string | null {
  const boxen = useBoxen(aktiv && siteId != null);
  return siteId ? boxRefOf(boxen, siteId) : null;
}
