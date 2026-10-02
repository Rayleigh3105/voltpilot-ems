import { useEffect, useState } from 'react';
import { api, type HistoryRange } from './api';
import type { MispelJahr, MispelMonat } from './mispelMengen';

/**
 * MiSpeL MP-18: die Mengen nach Anlage 1 zum Zeitraum der Erlöse-Seite — im Jahr das Jahr, sonst der Monat des Ankers
 * (Tag und Woche zeigen keine Karte, brauchen aber `mispel` für den Arbitrage-Ausweis, W5). Ein Fehler lässt die Karte
 * weg; er erfindet keine Zahl.
 */
export function useMispelMengen(
  siteId: string,
  range: HistoryRange,
  anchor: Date,
): { monat: MispelMonat | null; jahr: MispelJahr | null } {
  const jahrZahl = anchor.getFullYear();
  const monat = `${jahrZahl}-${String(anchor.getMonth() + 1).padStart(2, '0')}`;
  const imJahr = range === 'year';
  const [stand, setStand] = useState<{ schluessel: string; monat: MispelMonat | null; jahr: MispelJahr | null }>({
    schluessel: '',
    monat: null,
    jahr: null,
  });
  const schluessel = `${siteId}|${imJahr ? jahrZahl : monat}`;

  useEffect(() => {
    let aus = false;
    if (jahrZahl < 2026 || (jahrZahl === 2026 && !imJahr && monat < '2026-10')) {
      setStand({ schluessel, monat: null, jahr: null });
      return;
    }
    const laden = imJahr
      ? api.mispelJahr(siteId, jahrZahl).then((j) => ({ schluessel, monat: null, jahr: j }))
      : api.mispelMonat(siteId, monat).then((m) => ({ schluessel, monat: m, jahr: null }));
    laden
      .then((s) => !aus && setStand(s))
      .catch(() => !aus && setStand({ schluessel, monat: null, jahr: null }));
    return () => {
      aus = true;
    };
  }, [siteId, imJahr, jahrZahl, monat, schluessel]);

  return stand.schluessel === schluessel ? { monat: stand.monat, jahr: stand.jahr } : { monat: null, jahr: null };
}
