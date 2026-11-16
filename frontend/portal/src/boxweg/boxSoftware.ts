import { useEffect, useState } from 'react';
import type { BoxSoftwareUpdate, Device } from '../api';
import { api } from '../apiVoll';
import { softwareLage } from './wegLage';

/**
 * Erstverbindung S2: das Update frisch verbundener Boxen außerhalb des Verbinden-Wegs - die Box-Zeile im Aufbau
 * („Holt neue Software · noch etwa 1 Min.“). Gefragt werden nur Boxen, die in den letzten zwei Stunden verbunden
 * wurden (die Automatik greift nur in der ersten Stunde nach der ersten Meldung); alle anderen kosten nichts.
 */
export const SOFTWARE_FRISCH_MS = 2 * 60 * 60 * 1000;
export const SOFTWARE_TAKT_MS = 15_000;

/** Zustand der Box-Zeile, solange das Update läuft; `null` sonst. */
export function softwareZeile(update: BoxSoftwareUpdate | undefined, jetzt: Date): { wort: string; zeit: string | null } | null {
  if (!update) return null;
  const lage = softwareLage(update, jetzt);
  if (lage?.stand !== 'laeuft') return null;
  return { wort: 'Holt neue Software', zeit: lage.restText };
}

export function useBoxSoftware(boxen: readonly Device[]): ReadonlyMap<string, BoxSoftwareUpdate> {
  const [stand, setStand] = useState<ReadonlyMap<string, BoxSoftwareUpdate>>(new Map());
  const frisch = boxen
    .filter((d) => d.createdAt && Date.now() - new Date(d.createdAt).getTime() < SOFTWARE_FRISCH_MS)
    .map((d) => d.id)
    .join(',');
  useEffect(() => {
    if (!frisch) return;
    let aktiv = true;
    const ids = frisch.split(',');
    const fragen = () => {
      void Promise.all(ids.map((id) => api.boxSoftwareUpdate(id).then((u) => [id, u] as const, () => null))).then((liste) => {
        if (!aktiv) return;
        setStand(new Map(liste.filter((x): x is readonly [string, BoxSoftwareUpdate] => x !== null)));
      });
    };
    fragen();
    const takt = window.setInterval(fragen, SOFTWARE_TAKT_MS);
    return () => {
      aktiv = false;
      window.clearInterval(takt);
    };
  }, [frisch]);
  return stand;
}
