import { useEffect, useState } from 'react';
import { api, type StandortAmStichtag, type StandortWetter } from '../api';
import { standortWetterZeile, WETTER } from '../wetterBezug';
import './VersorgungKarte.css';

/**
 * Standort › Zeile „Wetter“ (AP-17 IP-12c, §6.3): bezogen aus dem Wetter-Archiv mit Quelle und letztem Abruf und den
 * gebundenen Gradtagzahlen — oder „Koordinaten fehlen“ mit dem Satz aus §5.8. Solange nichts (oder nichts Lesbares)
 * geladen ist, steht die Zeile nicht da: sie ist eine Ergänzung, keine Pflichtangabe des Standorts.
 */
export function StandortWetterZeile({ standort }: { standort: StandortAmStichtag }) {
  const [antwort, setAntwort] = useState<StandortWetter | null>(null);
  useEffect(() => {
    let aktiv = true;
    setAntwort(null);
    Promise.resolve().then(() => api.standortWetter(standort.id)).then(
      (r) => { if (aktiv && r && Array.isArray(r.gradtagzahlen)) setAntwort(r); },
      () => undefined,
    );
    return () => { aktiv = false; };
  }, [standort.id]);
  if (!antwort) return null;
  const z = standortWetterZeile(antwort);
  return (
    <section className="vp-vs" aria-label={`${WETTER} · ${standort.name}`} data-testid="standort-wetter">
      <h2 className="vp-vs-titel">{WETTER}</h2>
      <p className="vp-vs-text">{z.wert}</p>
      {z.satz && <p className="vp-vs-hinweis">{z.satz}</p>}
    </section>
  );
}
