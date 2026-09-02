import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SpeicherAussage } from '../speicherAussage';
import './SpeicherBlock.css';

/**
 * Der SPEICHER-BLOCK der Erlöse-Karte — die Langform der Speicher-Aussage
 * (Erlöse-Konzept `vp-erloese-seite-konzept-e2` §3.5, Captain-Scoping 2).
 *
 * Vier Zeilen, jede „Label · Zahl · Chip" (Revision 2, §3.12 Textbudget):
 *
 *   1. Was der GANZE Speicher gebracht hat (`savedEur`).
 *   2. Wie viel davon VoltPilots STEUERUNG war (`savedSteuerungEur`),
 *      mit dem stur arbeitenden Vergleichs-Speicher als Chip.
 *   3. Das Bestandskonto (bewertet, nie in der Kasse) — Zeile 3.
 *   4. Was der Fahrplan VORAB geplant hatte — Zeile 4, Abzeichen „Geplant".
 *
 * ⚠ REINE ANZEIGE. Jede Zahl, jedes Wort und jeder Ton kommt aus
 * `speicherAussage()`; dieselbe Ableitung speist Cockpit und Steuerungs-Bereich
 * in der Kurzform (§3.6). Zwei Formulierungen über dieselbe Zahl wären genau
 * der Bruch, den §3.5 beschreibt („Cockpit sagt Steuerung −2,67 €, die
 * Erlöse-Seite +1,45 € über dieselbe Stunde").
 *
 * ⚠ Der TON trägt immer ein WORT. Grün/Bernstein sind Beiwerk; „Zwischenstand"
 * bzw. „unter Null" stehen als Chip daneben, damit die Aussage ohne Farbe
 * ankommt (§3.9).
 */
export function SpeicherBlock({
  aussage,
  nachtragHref,
  children,
  className,
}: {
  aussage: SpeicherAussage;
  /**
   * Wohin der Chip „Speicher-Daten fehlen ›" führt (die Technik-Seite mit den
   * Batterie-Stammdaten). Ohne Ziel bleibt der Chip ein ruhiger Hinweis — nie
   * ein Knopf, der nirgends hinführt.
   */
  nachtragHref?: string;
  /** Der Aufklapper „Wie wird das berechnet?" — er wohnt UNTER dem Block. */
  children?: ReactNode;
  className?: string;
}) {
  const nachtrag = aussage.nachtragLink && nachtragHref;
  return (
    <div className={className ? `vp-spb ${className}` : 'vp-spb'}>
      {/* Zeile 1 — der ganze Speicher. */}
      <p className={`vp-spb-zeile vp-spb-ton-${aussage.anzeigeTon}`} title={aussage.satz}>
        <Icon name="battery" size={14} aria-hidden="true" />
        <span className="vp-spb-label">{aussage.gesamtLabel}</span>
        <span className="vp-spb-wert">{aussage.gesamt.wort}</span>
        {aussage.gesamtChip && <span className="vp-spb-chip">{aussage.gesamtChip}</span>}
      </p>

      {/* Zeile 2 — der Anteil der Steuerung. Sie steht AUCH ohne Aufteilung da
          (dann „—" plus der Grund), damit der Kunde sieht, dass die Frage
          gestellt wurde — statt einer stillschweigend fehlenden Zeile. */}
      {(aussage.steuerung || aussage.splitReason) && (
        <p
          className={`vp-spb-zeile vp-spb-sub vp-spb-ton-${aussage.steuerungTon ?? 'neutral'}`}
          title={aussage.steuerungSatz ?? undefined}
        >
          <span className="vp-spb-label">{aussage.steuerungLabel}</span>
          <span className="vp-spb-wert">{aussage.steuerungWert}</span>
          {aussage.steuerungChip &&
            (nachtrag ? (
              <a className="vp-spb-chip vp-spb-chip-link" href={nachtragHref}>
                {aussage.steuerungChip}
              </a>
            ) : (
              <span className="vp-spb-chip">{aussage.steuerungChip}</span>
            ))}
        </p>
      )}

      {/* Zeile 3 — das Bestandskonto. Bewertet, nie in der Kasse: eigenes
          Abzeichen, gedämpfter Ton (Diagnose vp-tagesbild-minus-f3 §6). */}
      {aussage.bestand && (
        <p className="vp-spb-zeile vp-spb-still" title={aussage.bestandTitel ?? undefined}>
          <span className="vp-spb-satz">{aussage.bestand}</span>
          {aussage.bestandBadge && <span className="vp-spb-badge">{aussage.bestandBadge}</span>}
        </p>
      )}

      {/* Zeile 4 — der Planwert. Eigenes Abzeichen, damit er nie wie ein
          gemessener Betrag gelesen wird.

          ⚠ EIGENE Klasse `vp-spb-plan` NEBEN `vp-spb-still`: seit P6/E6 ist
          das die einzige Nennung der geplanten Ersparnis auf dieser Seite
          (die Karte „Geplante Speicher-Ersparnis" ist entfallen), und Zeile 3
          (Bestandskonto) darf davon unterscheidbar bleiben — sie beantwortet
          eine andere Frage. */}
      {aussage.geplant && (
        <p className="vp-spb-zeile vp-spb-still vp-spb-plan">
          <span className="vp-spb-satz">{aussage.geplant}</span>
          <span className="vp-spb-badge">Geplant</span>
        </p>
      )}

      {children}
    </div>
  );
}
