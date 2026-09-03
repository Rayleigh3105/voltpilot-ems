import type { ReactNode } from 'react';
import { PROVENIENZ, type Provenienz } from '../historieWelten';
import './erloese/ErgebnisKarte.css';
import './VerlaufLedger.css';

/**
 * **Die Karte des Bereichs „Verlauf", Variante C** (Konzept
 * `vp-verlauf-sprache-konzept-v5` §3.2 V4, Paket P3).
 *
 * Ein Rahmen, kein Schatten; Kopf = Versalien-Label 12/700 plus das
 * Ehrlichkeits-Abzeichen als `.vp-chip` rechts. Sie ersetzt auf diesem Reiter
 * das Paar `Card` + `KartenKopf` (h2 20 px in Inter Tight + Icon-Zeile).
 *
 * ⚠ **Das Abzeichen bleibt** — es ist die Ehrlichkeitsregel, nicht Zierrat
 *   (report §7). Es wechselt nur die Form: seit E9/P0 trägt der ganze Bereich
 *   EINE Chip-Optik (`.vp-chip`, in `index.css`).
 *
 * ⚠ **Nie eine Karte in der Karte** (§3.2 V4): Abschnitte trennen sich durch
 *   Abstand oder eine 1-px-Linie. Wer hier ein zweites `.vp-c-card` schachtelt,
 *   bricht die Regel, an der die ganze Fläche ihre Ruhe hat.
 */
export function VerlaufKarte({
  label,
  provenienz,
  chip,
  children,
}: {
  /** Der Text des Labels — die Fläche versalisiert, die Daten nicht. */
  label: string;
  /** Das Ehrlichkeits-Abzeichen; ohne Angabe trägt die Karte keines. */
  provenienz?: Provenienz | null;
  /** Ein zweiter Chip (z. B. „Zwischenstand") — er steht VOR dem Abzeichen. */
  chip?: ReactNode;
  children: ReactNode;
}) {
  const prov = provenienz ? PROVENIENZ[provenienz] : null;
  return (
    <section className="vp-section">
      <div className="vp-c-card">
        <h2 className="vp-c-label vp-c-label-vl">
          <span className="vp-c-label-text">{label}</span>
          {/* ⚠ Die Chips stehen in EINER Gruppe: `.vp-c-label` ist
              `space-between`, drei direkte Kinder schöben den mittleren in die
              Mitte des Labels statt an den rechten Rand. */}
          {(chip || prov) && (
            <span className="vp-c-label-chips">
              {chip}
              {prov && (
                <span className="vp-chip" title={prov.satz}>
                  {prov.label}
                </span>
              )}
            </span>
          )}
        </h2>
        {children}
      </div>
    </section>
  );
}
