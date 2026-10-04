import { useEffect, useState } from 'react';
import { api, type HistoryRange } from './api';
import type { LadepunktErtraege } from './ladepunktErtraege';

/**
 * MiSpeL MP-41a: die Erträge am Ladepunkt im Monat des Ankers (nur im Monat; BK-41 „in allen Varianten gleich“). Ein
 * Fehler lässt die Karte weg; er erfindet keine Zahl.
 */
export function useLadepunktErtraege(siteId: string, range: HistoryRange, anchor: Date): LadepunktErtraege | null {
  const monat = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}`;
  const aktiv = range === 'month' && monat >= '2026-10';
  const schluessel = `${siteId}|${aktiv ? monat : ''}`;
  const [stand, setStand] = useState<{ schluessel: string; daten: LadepunktErtraege | null }>({ schluessel: '', daten: null });

  useEffect(() => {
    let aus = false;
    if (!aktiv) {
      setStand({ schluessel, daten: null });
      return;
    }
    api
      .ladepunktErtraege(siteId, monat)
      .then((d) => !aus && setStand({ schluessel, daten: d }))
      .catch(() => !aus && setStand({ schluessel, daten: null }));
    return () => {
      aus = true;
    };
  }, [siteId, monat, aktiv, schluessel]);

  return stand.schluessel === schluessel ? stand.daten : null;
}
