import type { ReactNode } from 'react';
import type { SpeicherAussage } from '../../speicherAussage';

/**
 * **Die Steuerungs-Karte** — Bauteil 3 der Variante C (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (3), Anatomie §3.2 (6)),
 * bis zum 04.09.2026 die „Speicher-Karte".
 *
 * ⚠ **DIE MESSLATTE IST DERSELBE SPEICHER OHNE SMARTE STEUERUNG** (Captain
 * 04.09.2026). Die Karte trug bis hierher ZWEI Zeilen: „Speicher im Zeitraum
 * + 92,02 €" (der ganze Speicher gegenüber einer Anlage OHNE Speicher) und
 * darunter „davon Steuerung + 43,65 €". Die erste ist ERSATZLOS entfallen —
 * sie beantwortete eine Frage, die kein Kunde hat, und stand als große Zahl
 * über der kleinen, die zählt. Es bleibt EINE Zahl und EINE Geschichte.
 *
 * Zeilen, in dieser Reihenfolge —
 *
 *   „Steuerung heute"    · Betrag            (`savedSteuerungEur`)
 *                        · bzw. „—" + Grund  (ohne Batterie-Stammdaten)
 *   Bestand              · Chip „Kein Abzug"
 *   „Wie wird das berechnet?" (Aufklapper, `children`)
 *
 * ⚠ **REINE ANZEIGE.** Jede Zahl, jedes Wort und jeder Ton kommt aus
 *   `speicherAussage()`; dieselbe Ableitung speist Cockpit und Steuerungs-
 *   Bereich in der Kurzform. Zwei Formulierungen über dieselbe Zahl wären
 *   genau der Bruch, den §3.5 beschreibt.
 *
 * ⚠ **Der Planwert steht NICHT hier**: „Vorab geplant hatte der Fahrplan …"
 *   ist eine PLAN-Zahl neben lauter gemessenen — auf Ebene 0 hat sie sich mit
 *   ihnen verwechselt. Sie wohnt in den Schritten des Aufklappers, direkt
 *   hinter der Rechnung, mit der sie sich vergleicht — und erst, wenn der
 *   Fahrplan sie gegen dieselbe Messlatte rechnet.
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
  /**
   * `karte` (Vorgabe) = eigener Rahmen, wie auf der Erlöse-Seite.
   * `sektion` = OHNE Rahmen und ohne Fläche — die Form, in der die
   * Cockpit-Erlöskarte sie trägt (§2 Prinzip 3 „ein Rahmen je Karte"; eine
   * Karte in der Karte war Befund B2 der Runde).
   */
  variant?: 'karte' | 'sektion';
  /** Der Aufklapper „Wie wird das berechnet?" — er wohnt UNTER den Zeilen. */
  children?: ReactNode;
}

export function SpeicherKarte({
  aussage,
  nachtragHref,
  label = 'VoltPilots Steuerung',
  variant = 'karte',
  children,
}: SpeicherKarteProps) {
  const nachtrag = aussage.nachtragLink && nachtragHref;
  return (
    <section
      className={
        variant === 'sektion' ? 'vp-c-speicher is-sektion' : 'vp-c-card vp-c-speicher'
      }
    >
      <h3 className="vp-c-label">
        <span className="vp-c-label-text">{label}</span>
        {aussage.chip && <span className="vp-chip">{aussage.chip}</span>}
      </h3>

      {/* Die EINE Zahl — der Mehrwert der Steuerung gegenüber demselben
          Speicher ohne smarte Steuerung. Ohne Vergleich steht hier „—" und
          der GRUND darunter; die Gesamtzahl ist dafür ausdrücklich kein
          Ersatz (Captain 04.09.2026). */}
      <p className="vp-c-sp-zeile" title={aussage.satz ?? undefined}>
        <span className="vp-c-sp-label">{aussage.label}</span>
        <span className="vp-c-sp-wert">{aussage.wert}</span>
        {aussage.hinweis && (
          <span className="vp-c-sp-sek">
            {nachtrag ? <a href={nachtragHref}>{aussage.hinweis}</a> : aussage.hinweis}
          </span>
        )}
      </p>

      {/* Ohne Vergleich: der Grund im Klartext, nie eine Ersatzzahl. */}
      {aussage.ohneVergleich && (
        <p className="vp-c-sp-bestand">
          {nachtrag ? (
            <a href={nachtragHref}>{aussage.ohneVergleich}</a>
          ) : (
            <span>{aussage.ohneVergleich}</span>
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
