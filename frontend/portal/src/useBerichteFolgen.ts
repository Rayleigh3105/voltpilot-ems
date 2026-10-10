import { useEffect, useState } from 'react';
import { api, type BerichtStrukturAnlass } from './api';
import { berichteFolgen, istKalendertag, type BerichteFolgen, type BerichteFolgenArt } from './berichteFolgen';

/**
 * Die Zeile „Freigegebene Berichte: …“ zu einer Strukturänderung (UEMS AP-12 IP-9) — gefragt über
 * `GET /api/v1/berichte/betroffen`, in Sätze gesetzt von `berichteFolgen.ts`.
 *
 * - `giltAb = null` (oder kein echter Kalendertag): nichts gefragt, nichts gezeigt.
 * - 200 ms Ruhe wie die Vorschau in „Anlage zuordnen“; die jüngste Frage gewinnt, eine ältere Antwort wird verworfen.
 * - Solange die Antwort fehlt, steht nichts da — geraten wird nicht.
 * - Jede Ablehnung (403: die Person darf keinen Bericht lesen; 400, 404) oder ein Netzfehler: die Zeile
 *   bleibt still weg. Sie ist eine Auskunft, kein Schritt des Dialogs.
 */
export function useBerichteFolgen(
  objekt: string,
  giltAb: string | null,
  anlass: BerichtStrukturAnlass,
  art: BerichteFolgenArt,
): BerichteFolgen | null {
  const frage = istKalendertag(giltAb) ? JSON.stringify([objekt, giltAb, anlass, art]) : null;
  const [antwort, setAntwort] = useState<{ frage: string; folgen: BerichteFolgen | null } | null>(null);

  useEffect(() => {
    if (frage == null || giltAb == null) return;
    let aktiv = true;
    const warten = setTimeout(() => {
      Promise.resolve()
        .then(() => api.berichteBetroffen(objekt, giltAb, anlass))
        .then((a) => berichteFolgen(a, art))
        .catch(() => null)
        .then((folgen) => {
          if (aktiv) setAntwort({ frage, folgen });
        });
    }, 200);
    return () => {
      aktiv = false;
      clearTimeout(warten);
    };
  }, [frage]); // eslint-disable-line react-hooks/exhaustive-deps

  return antwort?.frage === frage ? antwort.folgen : null;
}
