import { useMemo } from 'react';
import type { ComponentRole } from '../komponenten';
import {
  aggregatLabel,
  wertText,
  zeitbezug,
  type EigenerWert,
} from '../eigeneAuswertung';
import type { VerlaufSeries } from '../verlauf';
import { VerlaufChart } from './VerlaufChart';
import './EigeneAuswertung.css';

/**
 * Ein EIGENER Cockpit-Baustein (Anwendungs-Programm Stufe 5): die Kachel mit
 * EINER Zahl, und der Verlauf mit derselben Zahl als Kopfzeile.
 *
 * Render-only. Jede Ableitung — welche Kennzahl auf welchem Kanal ehrlich ist,
 * wie eine Zahl heisst, welche Einheit sie trägt — liegt im reinen
 * `src/eigeneAuswertung.ts`; die WERTE kommen fertig vom Server
 * (`GET /sites/{id}/eigene-auswertung`), aus demselben Messwert-Pfad, aus dem
 * der Verlaufs-Explorer seine Kurven zieht.
 *
 * ## Drei Ehrlichkeitsregeln der Fläche
 *
 * 1. **Eine fehlende Zahl bleibt ein Strich.** Eine Kachel ohne Messung sagt
 *    das in einem Satz; sie behauptet keine Null.
 * 2. **Jede Zahl trägt ihren Zeitbezug** („jetzt", „heute", „Höchstwert
 *    heute") — „3,2 kW" allein sagt nicht, wovon es der Wert ist.
 * 3. **Der Verlauf benutzt die BESTEHENDE Chart-Grammatik** (`VerlaufChart` auf
 *    `useEChart`/`chartTheme`), keine zweite Chart-Bibliothek und keine zweite
 *    Optik.
 */

/** Der Entitätstyp bestimmt die Farbe, wo der Kanal sie nicht schon setzt. */
function rolleVon(entityType: string | null): ComponentRole {
  switch (entityType) {
    case 'producer':
      return 'pv';
    case 'battery-hybrid':
      return 'storage';
    case 'grid-meter':
      return 'grid';
    case 'house-load':
      return 'house';
    default:
      return 'consumer';
  }
}

/** Die Eimer des Tages als Reihe für `VerlaufChart` — dieselbe Form wie dort. */
function serie(w: EigenerWert, einheitText: string): VerlaufSeries {
  const points = w.verlauf.map((b) => ({
    t: b.start,
    avg: b.avg,
    min: b.min,
    max: b.max,
    n: b.n,
  }));
  return {
    points,
    unit: einheitText,
    // Der Tag ist die rohe Linie (wie im Verlaufs-Explorer) — kein Band.
    hasBand: false,
    isDay: true,
    bars: false,
    bucketMinutes: 15,
    empty: !points.some((p) => p.avg != null),
  };
}

/**
 * Die Quellen-Zeile. ⚠ **Ohne Komponenten-NAMEN steht dort nur die Kennzahl** —
 * eine plattform-komponierte Zeile trägt per Label-Hygiene kein Label
 * (`label != NULL` heisst „von einem Menschen vergeben"), und „Ihre Anlage" wäre
 * eine vage Behauptung über eine bestimmte Komponente. Der Titel nennt sie
 * ohnehin: der Vorschlag beginnt mit ihrem Namen.
 */
function quelle(w: EigenerWert): string {
  const k = w.komponente?.trim();
  return k ? `${k} · ${aggregatLabel(w.aggregat)}` : aggregatLabel(w.aggregat);
}

export function EigenerBaustein({
  wert,
  einheit,
}: {
  wert: EigenerWert;
  /** Die Einheit — aus der DEKLARIERTEN Einheit der Komponente, wo es eine gibt. */
  einheit: string;
}) {
  const zahl = wertText(wert.wert, wert.channel, einheit);
  const bezug = zeitbezug(wert.aggregat);
  const selections = useMemo(
    () => [
      {
        key: `${wert.entityId}:${wert.channel}`,
        label: wert.titel,
        channel: wert.channel,
        role: rolleVon(wert.entityType),
        series: serie(wert, einheit || ''),
      },
    ],
    [wert, einheit],
  );

  if (wert.darstellung === 'chart') {
    return (
      <section className="vp-eigen-chart" aria-label={wert.titel}>
        <header className="vp-eigen-head">
          <div>
            <h3>{wert.titel}</h3>
            <p className="vp-eigen-quelle">{quelle(wert)}</p>
          </div>
          <p className="vp-eigen-zahl">
            {zahl}
            <span className="vp-eigen-bezug">{bezug}</span>
          </p>
        </header>
        {wert.hinweis ? (
          <p className="vp-eigen-hinweis">{wert.hinweis}</p>
        ) : (
          <div className="vp-eigen-canvas">
            <VerlaufChart selections={selections} range="day" />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="vp-eigen-kachel" aria-label={wert.titel}>
      <h3>{wert.titel}</h3>
      <p className="vp-eigen-zahl">
        {zahl}
        <span className="vp-eigen-bezug">{bezug}</span>
      </p>
      <p className="vp-eigen-quelle">{quelle(wert)}</p>
      {wert.hinweis && <p className="vp-eigen-hinweis">{wert.hinweis}</p>}
    </section>
  );
}
