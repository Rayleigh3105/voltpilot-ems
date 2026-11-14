import { useEffect, useState } from 'react';
import type { AnlagenCheck, HistoryRange } from '../../api';
import { anlagenCheckApi } from '../../anlagenCheckApi';
import { solarKarte } from '../../anlagenCheck';
import { ANLAGEN_CHECK_KARTE } from '../../glossar';
import { VrKarte } from '../VerlaufRahmen';
import './EnergieSeite.css';

const Z: Record<HistoryRange, 'tag' | 'woche' | 'monat' | 'jahr'> = {
  day: 'tag',
  week: 'woche',
  month: 'monat',
  year: 'jahr',
};

/** Der PV-Ton der Portal-Palette (wie die Kacheln), nach hinten heller - dieselbe Staffel wie „Verbrauch nach Bereichen“. */
function farbe(i: number): { background: string; opacity: number } {
  return { background: 'var(--vp-c-chart-pv, #e65100)', opacity: [1, 0.6, 0.3][i] ?? 0.18 };
}

/**
 * **Erzeugung nach Einheiten** (Anlagen-Check, Bedienkonzept vp-privatkunde-bedienkonzept §6.1, BK-4 = A): die erste
 * Karte der Seitenspalte in Verlauf › Energie, der Spiegel von „Verbrauch nach Bereichen“. Folgt dem Zeitraum der
 * Seite; Urteil vom Server, Wörter `anlagenCheck.ts`. Ohne PV keine Karte.
 */
export function EinheitenKarte({ siteId, range, at }: { siteId: string; range: HistoryRange; at: string }) {
  const key = `${siteId}|${range}|${at}`;
  const [daten, setDaten] = useState<{ key: string; c: AnlagenCheck | null } | null>(null);
  useEffect(() => {
    let aktiv = true;
    anlagenCheckApi.anlagenCheck(siteId, Z[range], at).then(
      (c) => aktiv && setDaten({ key, c }),
      () => aktiv && setDaten({ key, c: null }),
    );
    return () => {
      aktiv = false;
    };
  }, [siteId, range, at, key]);

  const m = daten && daten.key === key ? solarKarte(daten.c) : null;
  if (!m) return null;
  const hoechste = Math.max(0, ...m.saeulen.map((s) => s.summe));
  const ganze = daten?.c?.modus === 'ganze_anlage';

  return (
    <VrKarte
      titel={ANLAGEN_CHECK_KARTE}
      sub={m.sub}
      info={{
        titel: 'So entsteht der Vergleich',
        text: `Gemessen: die Erzeugung ${ganze ? 'der ganzen Anlage' : 'der Geräte, die einer Einheit zugeordnet sind'}. Erwartet: die Prognose vom Vorabend, je Einheit nach ihren Dachflächen aufgeteilt. Die Prozente zählen nur Tage mit Sonne, ohne abgeregelte Tage und ohne Tage mit fehlenden Messwerten.${ganze ? ' Mit Geräten an mindestens zwei Einheiten (Anlage › Einstellungen › Solaranlage) steht hier jede Einheit einzeln.' : ''}`,
      }}
      className="vp-vr-bereiche vp-vr-einheiten"
    >
      <dl className="vp-vr-kv">
        {m.zeilen.map((z, i) => (
          <div key={z.id} className={z.warn ? 'is-warn' : undefined}>
            <dt>
              <span className="vp-vr-key" style={farbe(i)} aria-hidden="true" /> {z.name}
              {z.erwartet && <small>{z.erwartet}</small>}
            </dt>
            <dd>
              {z.wert}
              {z.prozent && <small> · {z.prozent}</small>}
            </dd>
          </div>
        ))}
      </dl>
      {m.saeulen.length > 1 && hoechste > 0 && (
        <>
          <div className="vp-vr-saeulen" role="img" aria-label={`Erzeugung je ${range === 'year' ? 'Monat' : 'Tag'} nach Einheiten`}>
            {m.saeulen.map((s) => (
              <div key={s.start} className="vp-vr-saeule" title={s.kopf}>
                <div className="vp-vr-saeule-stapel" style={{ height: `${(s.summe / hoechste) * 100}%` }}>
                  {s.teile.map((v, i) =>
                    v != null && v > 0 && s.summe > 0 ? <i key={i} style={{ height: `${(v / s.summe) * 100}%`, ...farbe(i) }} /> : null,
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="vp-vr-saeulen-achse" aria-hidden="true">
            <span>{m.saeulen[0].kopf}</span>
            <span>{m.saeulen[m.saeulen.length - 1].kopf}</span>
          </div>
        </>
      )}
      {m.satz && <p className="vp-vr-foot">{m.satz}</p>}
      {m.hinweis && <p className="vp-vr-foot">{m.hinweis}</p>}
    </VrKarte>
  );
}
