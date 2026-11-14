import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SpeicherBilanz } from '../api';
import { anlagenCheckApi } from '../anlagenCheckApi';
import { speicherBilanz } from '../anlagenCheck';
import type { BausteinInhalt } from './GeraetRahmen';
import './SpeicherBilanzKarte.css';

/**
 * **Speicher-Bilanz · 30 Tage** (Anlagen-Check, Bedienkonzept vp-privatkunde-bedienkonzept §6.5, BK-7 = A): der
 * Baustein unter „Heute“ auf der Geräteseite des Speichers. Wirkungsgrad mit Ladestand-Ausgleich, Vollzyklen,
 * Verlust und ein Satz gegen die eigenen 12 Monate; „12 Monate ›“ zeigt dieselben Zahlen je Monat in der Karte
 * (kein Dialog). Ohne Messwerte keine Karte. Die Zahlen bildet der Server (`SpeicherBilanzRegel`).
 */
export function useSpeicherBilanzBaustein(siteId: string, zeigen: boolean): BausteinInhalt | null {
  const [daten, setDaten] = useState<{ siteId: string; b: SpeicherBilanz | null } | null>(null);
  const [monate, setMonate] = useState(false);
  useEffect(() => {
    if (!zeigen) return undefined;
    let aktiv = true;
    anlagenCheckApi.speicherBilanz(siteId).then(
      (b) => aktiv && setDaten({ siteId, b }),
      () => aktiv && setDaten({ siteId, b: null }),
    );
    return () => {
      aktiv = false;
    };
  }, [siteId, zeigen]);

  const m = zeigen && daten?.siteId === siteId ? speicherBilanz(daten.b) : null;
  if (!m) return null;
  const mitMonaten = m.monate.length > 0;
  return {
    titel: monate ? 'Speicher-Bilanz · 12 Monate' : m.titel,
    kopfRechts: mitMonaten ? (
      <button type="button" className="vp-sb-umschalter" onClick={() => setMonate((x) => !x)} aria-expanded={monate}>
        {monate ? `${m.titel.split(' · ')[1]}` : '12 Monate'} <Icon name="chevron-right" size={14} />
      </button>
    ) : null,
    inhalt: monate ? (
      <table className="vp-sb-monate">
        <thead>
          <tr>
            <th scope="col">Monat</th>
            <th scope="col">Wirkungsgrad</th>
            {m.monate.some((x) => x.vollzyklen != null) && <th scope="col">Vollzyklen</th>}
            <th scope="col">Verlust</th>
          </tr>
        </thead>
        <tbody>
          {[...m.monate].reverse().map((x) => (
            <tr key={x.monat}>
              <th scope="row">{x.monat}</th>
              <td>{x.wirkungsgrad}</td>
              {m.monate.some((y) => y.vollzyklen != null) && <td>{x.vollzyklen ?? '—'}</td>}
              <td>{x.verlust}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <div className="vp-sb">
        <div className="vp-sb-zellen">
          {m.zellen.map((z) => (
            <div key={z.titel} className="vp-sb-zelle">
              <div className="vp-sb-titel">{z.titel}</div>
              <div className="vp-sb-wert">{z.wert}</div>
              {z.sub && <div className="vp-sb-sub">{z.sub}</div>}
            </div>
          ))}
        </div>
        {m.satz && <p className={`vp-sb-satz is-${m.satz.ton}`}>{m.satz.text}</p>}
      </div>
    ),
  };
}
