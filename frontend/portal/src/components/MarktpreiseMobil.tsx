import type { PreisZeile, TagFokus, TagWahl } from '../marktpreise';
import { useIsPhone } from '../useIsPhone';
import './Marktpreise.css';

/**
 * Geteilte Render-Teile aus dem Reiter „Marktpreise" (Variante C, Paket P4):
 * das Tag-Segment (heute im Fahrplan), die Kennzahl-Zeilen und das
 * Profi-Detail (heute im Rückblick und im Erklär-Blatt der Preis-Seite). Sie
 * rechnen NICHTS — jede Zahl und jedes Wort kommt aus `src/marktpreise.ts`.
 */

/** Ein Eintrag des Tag-Segments; `datum` ist eine ruhige zweite Zeile („Mi 24.09."). */
export interface TagSegmentEintrag<T extends string> {
  id: T;
  label: string;
  datum?: string;
}

/**
 * V3 · Heute/Morgen als Segment (44 px), nicht als Sprung-Chip.
 *
 * Es rendert GAR NICHT, wo es nichts zu sagen gibt — ein Segment mit einem
 * einzigen Eintrag und ohne Grund schaltet nichts (`tagWahl` gibt dort `null`).
 *
 * Seit dem Tagesschalter des Fahrplans (Konzept „Tagesuhr und Bildfahrplan",
 * E2 = A) trägt es auch „Gestern · Heute · Morgen": EIN Tages-Segment im
 * Fahrplan-Bereich, nicht zwei Muster nebeneinander. `datum` setzt die zweite
 * Zeile, `voll` streckt die Schiene auf die ganze Breite (Telefon).
 */
export function TagSegment<T extends string = TagFokus>({
  wahl,
  wert,
  onWert,
  voll = false,
}: {
  wahl: { optionen: readonly TagSegmentEintrag<T>[]; chip: string | null } | TagWahl | null;
  wert: T;
  onWert: (w: T) => void;
  voll?: boolean;
}) {
  if (!wahl) return null;
  const optionen = wahl.optionen as readonly TagSegmentEintrag<T>[];
  return (
    <div className={`vp-mp-tag${voll ? ' is-voll' : ''}`}>
      <div className="vp-mp-tagseg" role="tablist" aria-label="Tag">
        {optionen.map((o) => (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={wert === o.id}
            className={[wert === o.id ? 'is-on' : '', o.datum ? 'has-datum' : ''].filter(Boolean).join(' ')}
            onClick={() => onWert(o.id)}
          >
            {o.label}
            {o.datum && <small>{o.datum}</small>}
          </button>
        ))}
      </div>
      {/* ⚠ Der Grund, nicht die Leere: vor ~12:45 hat die Börse den Folgetag
          noch nicht veröffentlicht. */}
      {wahl.chip && <span className="vp-chip">{wahl.chip}</span>}
    </div>
  );
}

/**
 * V5 · Die Kennzahlen als Ledger-Zeilen. Name links, Wert rechts in
 * Tabellenziffern, der Zeitpunkt als ruhige Zeile darunter.
 *
 * Sie ersetzt BEIDE alten Formen auf einmal: die drei `KpiCard` des Rechners
 * und die drei Chips des Telefons (§3.2 V5 „keine KPI-Karten, keine
 * Icon-Kacheln").
 */
export function PreisZeilen({ zeilen, label }: { zeilen: readonly PreisZeile[]; label: string }) {
  if (zeilen.length === 0) return null;
  return (
    <ul className="vp-c-led vp-c-led-ruhig vp-mp-led" aria-label={label}>
      {zeilen.map((z) => (
        <li key={z.id} className="vp-c-led-row">
          <div className="vp-c-led-sum">
            <span className="vp-c-led-name">{z.name}</span>
            <span className="vp-c-led-val">{z.wert}</span>
            {z.sekundaer && <span className="vp-c-led-sek">{z.sekundaer}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * **E6 · Liste statt Tabelle am Telefon** (Captain-Entscheid 03.09.2026,
 * wörtlich: „a) am Telefon immer Liste (V7), ab 700 px Tabelle").
 *
 * ⚠ Es sind ZWEI Bäume aus DENSELBEN Daten, nicht eine Tabelle mit
 *   `data-label`: eine Label/Wert-Karte MIT Tabellen-Semantik lässt einen
 *   Screenreader Spaltenköpfe vorlesen, die es optisch gar nicht gibt (die
 *   verworfene Option (c) des Entscheids). Die Grenze ist die Haus-Grenze
 *   720 px (`useIsPhone`), also dieselbe, an der der Reiter sonst umschaltet.
 */
export function ProfiZahlen({ zeilen }: { zeilen: readonly PreisZeile[] }) {
  const isPhone = useIsPhone();
  if (zeilen.length === 0) return null;
  if (isPhone) return <PreisZeilen zeilen={zeilen} label="Profi-Detail in EUR/MWh" />;
  return (
    <table className="vp-mp-tab">
      <thead>
        <tr>
          <th scope="col">Kennzahl</th>
          <th scope="col">Wert</th>
        </tr>
      </thead>
      <tbody>
        {zeilen.map((z) => (
          <tr key={z.id}>
            <th scope="row">{z.name}</th>
            <td>{z.wert}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
