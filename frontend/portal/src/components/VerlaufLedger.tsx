import type { ReactNode } from 'react';
import './erloese/ErgebnisKarte.css';
import './VerlaufLedger.css';

/**
 * **Die Ledger-Zeile des Bereichs „Verlauf"** (Konzept
 * `vp-verlauf-sprache-konzept-v5` §3.2 V5, Paket P3).
 *
 * Name links, Wert rechts in Tabellenziffern, optionaler 8-px-Balken, darunter
 * die Sekundärzeile — die Form, die die Erlöse-Seite seit P7 fährt.
 *
 * ⚠ **Sie ist der ZUSAMMENBAU, nicht die Optik.** Jede Klasse kommt aus
 *   `erloese/ErgebnisKarte.css`; dieses Bauteil existiert, weil `Kontoauszug`
 *   an den Erlös-Wasserfall gebunden ist (gemeinsame Skala mit Nulllinie,
 *   `ErloesZeile`-Typen). Der Verlauf zeigt sechs nicht-negative Energien
 *   gegen ihre grösste — ein Balken OHNE Nulllinie.
 *
 * ⚠ **Kein farbiger Punkt vor dem Namen:** der Balken ist die Kennung
 *   (Erlöse-Prinzip 4). Zwei Träger derselben Aussage waren Befund B2.
 */

/** Die Geometrie des Balkens — fester Koordinatenraum, per SVG gedehnt. */
const BALKEN_BREITE = 100;
const BALKEN_HOEHE = 8;

function Balken({ anteil, farbe }: { anteil: number; farbe: string }) {
  return (
    <svg
      className="vp-c-led-bar"
      viewBox={`0 0 ${BALKEN_BREITE} ${BALKEN_HOEHE}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="vp-c-led-bar-base" x={0} y={0} width={BALKEN_BREITE} height={BALKEN_HOEHE} />
      {anteil > 0 && (
        <rect
          className="vp-c-led-bar-fill"
          x={0}
          y={0}
          width={anteil * BALKEN_BREITE}
          height={BALKEN_HOEHE}
          fill={farbe}
        />
      )}
    </svg>
  );
}

export interface VerlaufLedgerZeile {
  id: string;
  name: string;
  /** Der fertige Wert samt Einheit — `null` zeigt „—" in Muted. */
  wert: string | null;
  /** Anteil an der grössten Zeile, 0..1 — `null` = kein Balken. */
  anteil?: number | null;
  farbe?: string;
  /** Die Zeile darunter: Δ, Grund, Erklärung. */
  sekundaer?: ReactNode;
  /** Der Wert in Sektions-Größe (24 px) — die Quoten. */
  gross?: boolean;
  /** Titel/Tooltip der Zeile (der erklärende Satz aus der Ableitung). */
  hinweis?: string;
}

/**
 * Die Liste. `aria-label` benennt sie, weil sie ohne Überschrift steht — das
 * Label der Karte gehört der Karte.
 */
export function VerlaufLedger({
  zeilen,
  label,
}: {
  zeilen: readonly VerlaufLedgerZeile[];
  label: string;
}) {
  return (
    <ul className="vp-c-led vp-c-led-ruhig" aria-label={label}>
      {zeilen.map((z) => (
        <li key={z.id} className="vp-c-led-row" title={z.hinweis}>
          <div className="vp-c-led-sum">
            <span className="vp-c-led-name">{z.name}</span>
            <span
              className={
                z.wert == null
                  ? 'vp-c-led-val is-null'
                  : z.gross
                    ? 'vp-c-led-val is-zahl'
                    : 'vp-c-led-val'
              }
            >
              {/* ⚠ „—" ist die ehrliche Antwort, nie eine 0: eine Anlage ohne
                  Netzzähler hat nicht null bezogen, sie hat es nicht gemessen.
                  Der Grund steht in der Sekundärzeile. */}
              {z.wert ?? '—'}
            </span>
            {z.anteil != null && z.farbe && (
              <span className="vp-c-led-barwrap">
                <Balken anteil={z.anteil} farbe={z.farbe} />
              </span>
            )}
            {z.sekundaer != null && <span className="vp-c-led-sek">{z.sekundaer}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
