import { useEffect, useState } from 'react';
import { mispelPauschalApi, type PauschalJahr } from './mispelPauschal';

/**
 * MiSpeL MP-27: der Jahresstand der Pauschaloption zum Kalenderjahr der Erlöse-Seite (Jahr: die Karte, Monat: die
 * Zeile mit Sprung). Ohne Jahreslauf (`staende` leer) oder bei einem Fehler `null` — dann keine Karte, keine Zahl.
 */
export function usePauschalJahr(siteId: string, jahr: number, aktiv: boolean): PauschalJahr | null {
  const schluessel = `${siteId}|${jahr}`;
  const [stand, setStand] = useState<{ schluessel: string; daten: PauschalJahr | null }>({ schluessel: '', daten: null });

  useEffect(() => {
    let aus = false;
    // Die Pauschaloption wirkt frühestens ab dem 01.10.2026 (Tenor Ziff. 8) — davor gibt es nichts zu lesen.
    if (!aktiv || jahr < 2026) {
      setStand({ schluessel, daten: null });
      return;
    }
    mispelPauschalApi
      .jahr(siteId, jahr)
      .then((d) => !aus && setStand({ schluessel, daten: d.staende.length > 0 ? d : null }))
      .catch(() => !aus && setStand({ schluessel, daten: null }));
    return () => {
      aus = true;
    };
  }, [siteId, jahr, aktiv, schluessel]);

  return stand.schluessel === schluessel ? stand.daten : null;
}
