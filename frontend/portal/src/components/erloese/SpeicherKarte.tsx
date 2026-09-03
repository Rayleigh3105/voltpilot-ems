import type { ReactNode } from 'react';
import type { SpeicherAussage } from '../../speicherAussage';

/**
 * **Die Speicher-Karte** — Bauteil 3 der Variante C (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (3), Anatomie §3.2 (6)).
 *
 * Sie löst den früheren Speicher-KASTEN ab: keine grüne Fläche, keine
 * 3-px-Kennlinie, kein Batterie-Icon — eine Karte wie jede andere, mit Label
 * und Chip. **E7 = (a)** vom 03.09.2026: die Fläche in Speicherfarbe war eine
 * Fläche in der Fläche (Befund B2) UND eine Erfolgsfarbe über einer Zahl, die
 * negativ sein darf.
 *
 * Zeilen, in dieser Reihenfolge —
 *
 *   „Speicher heute"     · Betrag           (der ganze Speicher, `savedEur`)
 *   „davon Steuerung"    · Betrag + „stur …" (der Mehrwert der Steuerung)
 *   Bestand              · Chip „Kein Abzug"
 *   „Wie wird das berechnet?" (Aufklapper, `children`)
 *
 * ⚠ **REINE ANZEIGE.** Jede Zahl, jedes Wort und jeder Ton kommt aus
 *   `speicherAussage()`; dieselbe Ableitung speist Cockpit und Steuerungs-
 *   Bereich in der Kurzform (§3.6). Zwei Formulierungen über dieselbe Zahl
 *   wären genau der Bruch, den §3.5 beschreibt.
 *
 * ⚠ **Der Planwert steht NICHT mehr hier** (E6, Runde 1, in u3 §3.2 (6)
 *   wiederhergestellt): „Vorab geplant hatte der Fahrplan …" ist eine
 *   PLAN-Zahl neben lauter gemessenen — auf Ebene 0 hat sie sich mit ihnen
 *   verwechselt. Sie wohnt in den Schritten des Aufklappers, direkt hinter der
 *   Rechnung, mit der sie sich vergleicht.
 *
 * ⚠ **Der TON trägt immer ein WORT.** „Zwischenstand" bzw. „unter Null" stehen
 *   als Chip am Label, damit die Aussage ohne Farbe ankommt (§3.9).
 */
export interface SpeicherKarteProps {
  aussage: SpeicherAussage;
  /**
   * Wohin „Speicher-Daten fehlen ›" führt (die Technik-Seite mit den
   * Batterie-Stammdaten). Ohne Ziel bleibt der Hinweis ruhiger Text — nie ein
   * Knopf, der nirgends hinführt.
   */
  nachtragHref?: string;
  /** Das Label der Karte, 12/700 Versalien. */
  label?: string;
  /** Der Aufklapper „Wie wird das berechnet?" — er wohnt UNTER den Zeilen. */
  children?: ReactNode;
}

export function SpeicherKarte({
  aussage,
  nachtragHref,
  label = 'Ihr Speicher',
  children,
}: SpeicherKarteProps) {
  const nachtrag = aussage.nachtragLink && nachtragHref;
  return (
    <section className="vp-c-card vp-c-speicher">
      <h3 className="vp-c-label">
        <span className="vp-c-label-text">{label}</span>
        {aussage.gesamtChip && <span className="vp-chip">{aussage.gesamtChip}</span>}
      </h3>

      {/* Zeile 1 — der ganze Speicher. */}
      <p className="vp-c-sp-zeile" title={aussage.satz}>
        <span className="vp-c-sp-label">{aussage.gesamtLabel}</span>
        <span className="vp-c-sp-wert">{aussage.gesamt.wort}</span>
      </p>

      {/* Zeile 2 — der Anteil der Steuerung. Sie steht AUCH ohne Aufteilung da
          (dann „—" plus der Grund), damit der Kunde sieht, dass die Frage
          gestellt wurde — statt einer stillschweigend fehlenden Zeile. */}
      {(aussage.steuerung || aussage.splitReason) && (
        <p className="vp-c-sp-zeile" title={aussage.steuerungSatz ?? undefined}>
          <span className="vp-c-sp-label">{aussage.steuerungLabel}</span>
          <span className="vp-c-sp-wert">{aussage.steuerungWert}</span>
          {aussage.steuerungChip && (
            <span className="vp-c-sp-sek">
              {nachtrag ? (
                <a href={nachtragHref}>{aussage.steuerungChip}</a>
              ) : (
                aussage.steuerungChip
              )}
            </span>
          )}
        </p>
      )}

      {/* Der Bestand — bewertet, nie in der Kasse: eigener Chip, eigener Ton
          (Diagnose vp-tagesbild-minus-f3 §6). */}
      {aussage.bestand && (
        <p className="vp-c-sp-bestand" title={aussage.bestandTitel ?? undefined}>
          <span>{aussage.bestand}</span>
          {aussage.bestandBadge && <span className="vp-chip">{aussage.bestandBadge}</span>}
        </p>
      )}

      {children}
    </section>
  );
}
