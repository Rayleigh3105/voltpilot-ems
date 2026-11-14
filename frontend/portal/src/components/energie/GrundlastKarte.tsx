import { useEffect, useMemo, useState } from 'react';
import { api, type Grundlast, type HistoryRange } from '../../api';
import { chartTheme } from '../../chartTheme';
import { GRUNDLAST, GRUNDLAST_UNTERZEILE } from '../../glossar';
import { grundlastKarte, grundlastZeitraum } from '../../grundlast';
import { VrKarte } from '../VerlaufRahmen';
import './EnergieSeite.css';

/** Die Farbe des i-ten Teils: wie „Verbrauch nach Bereichen“ (der Verbraucher-Ton, nach hinten heller). */
function farbe(i: number): { background: string; opacity: number } {
  return { background: chartTheme().consumer, opacity: [1, 0.5, 0.3][i] ?? 0.2 };
}

/**
 * **Grundlast** - Karte in Verlauf › Energie, Seitenspalte nach „Verbrauch nach Bereichen“ (Bedienkonzept
 * Privatkunde §5.1, BK-1 = A). Folgt dem Zeitraum: Woche und Monat ein Balken je Nacht, Jahr einer je Monat, der
 * Tag den Wert dieser Nacht. Die Zahlen rechnet der Server, die Wörter {@link grundlastKarte}. Ohne gemessenen
 * Hausverbrauch erscheint sie nicht.
 */
export function GrundlastKarte({
  site,
  range,
  at,
}: {
  site: { id: string; profil?: string | null };
  range: HistoryRange;
  at: string;
}) {
  const z = grundlastZeitraum(range);
  const key = `${site.id}|${z}|${at}`;
  const [daten, setDaten] = useState<{ key: string; g: Grundlast | null } | null>(null);
  useEffect(() => {
    let aktiv = true;
    api.grundlast(site.id, z, at).then(
      (g) => aktiv && setDaten({ key, g }),
      () => aktiv && setDaten({ key, g: null }),
    );
    return () => {
      aktiv = false;
    };
  }, [site.id, z, at, key]);

  const g = daten?.key === key ? daten.g : null;
  const modell = useMemo(() => (g && g.hausverbrauchGemessen ? grundlastKarte(g, site.profil) : null), [g, site.profil]);
  if (!modell) return null;
  const teilZeilen = modell.teile.filter((t) => t.art === 'teil');

  return (
    <VrKarte
      titel={GRUNDLAST}
      sub={GRUNDLAST_UNTERZEILE}
      info={{
        titel: 'So entsteht die Grundlast',
        text: 'Je Nacht zählt die niedrigste Viertelstunde zwischen 0 und 5 Uhr - was dann noch läuft, läuft immer. Eine Nacht, in der mehr als zwei Viertelstunden ohne Messwert sind, wird nicht gewertet. Die typische Nacht ist der mittlere Wert der gewerteten Nächte (ab drei). kWh am Tag = Watt × 24 Stunden.',
      }}
      className="vp-vr-grundlast"
    >
      <div className="vp-vr-grundlast-kopf">
        <span>{modell.titel}</span>
        <b>{modell.zahl}</b>
      </div>
      {modell.balken.length > 1 && (
        <>
          <div className="vp-vr-grundlast-balken" role="img" aria-label={`${GRUNDLAST} je ${z === 'jahr' ? 'Monat' : 'Nacht'}`}>
            {modell.balken.map((b) => (
              <div key={b.key} className={`vp-vr-grundlast-saeule is-${b.art}`} title={b.titel}>
                {b.art === 'wert' && b.hoehe != null && (
                  <i style={{ height: `${Math.max(4, b.hoehe * 100)}%`, background: chartTheme().consumer }} />
                )}
                {b.art === 'ohne' && <i />}
              </div>
            ))}
          </div>
          {modell.achse && (
            <div className="vp-vr-saeulen-achse" aria-hidden="true">
              <span>{modell.achse[0]}</span>
              <span>{modell.achse[1]}</span>
            </div>
          )}
        </>
      )}
      {modell.teile.length > 0 && (
        <dl className="vp-vr-kv vp-vr-grundlast-teile">
          {modell.teile.map((t) => (
            <div key={t.key} className={t.art === 'rest' ? 'is-rest' : undefined}>
              <dt>
                <span
                  className="vp-vr-key"
                  style={t.art === 'rest' ? { background: chartTheme().idle } : farbe(teilZeilen.indexOf(t))}
                  aria-hidden="true"
                />{' '}
                {t.label}
              </dt>
              <dd>{t.wert}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="vp-vr-grundlast-satz">{modell.satz}</p>
    </VrKarte>
  );
}
