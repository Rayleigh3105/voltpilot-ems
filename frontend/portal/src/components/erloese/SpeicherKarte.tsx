import type { ReactNode } from 'react';
import { FORMEL_AUSLOESER_SCHRITTE } from '../../erloesEbenen';
import type { SpeicherAussage } from '../../speicherAussage';
import type { SteuerungKarte } from '../../steuerungZeitraum';
import { RechenZeilen } from '../SteuerungFormel';

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
 *     Grund in Worten mit Zahl (nur unter einem Minus-Tag, Konzept k1 E3)
 *   Anker                · „September bisher + 116,94 €" (E4)
 *   Bestand (Vorsprung)  · Chip „Kein Abzug" (E2)
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
  /** Die Aussage; null nur, wo `zeitraum` die Karte allein trägt (vor dem ersten Eimer des Tages). */
  aussage: SpeicherAussage | null;
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
  /**
   * Die Tagesansicht MIT BESTAND (Bedienkonzept vp-herzogau-p3-kachel-konzept
   * §3, P3-3 A): „Heute bis 08:15“ bzw. „Steuerung an diesem Tag“ mit Bestand
   * und Grund-Wort, die Anker „Letzte 7 Tage“ und „Oktober bisher“, die Liste
   * „Tag für Tag“ und der Rechenweg in vier Schritten. Gesetzt ersetzt sie die
   * Zeilen aus `aussage` und den Aufklapper `children`.
   */
  zeitraum?: SteuerungKarte | null;
}

export function SpeicherKarte({
  aussage,
  nachtragHref,
  label = 'VoltPilots Steuerung',
  variant = 'karte',
  children,
  zeitraum,
}: SpeicherKarteProps) {
  if (zeitraum) {
    return <SpeicherKarteMitBestand karte={zeitraum} label={label} variant={variant} />;
  }
  if (!aussage) return null;
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
        {/* Kein nacktes Minus (k1 E1): der Grund des Servers in Worten mit
            Zahl — Sekundärtext, kein Chip. Ohne Grund steht nur der Chip. */}
        {aussage.grundZeile && <span className="vp-c-sp-sek vp-c-sp-grund">{aussage.grundZeile}</span>}
      </p>

      {/* Der Anker des größeren Zeitraums (k1 E4) — dieselbe Zahl wie der Reiter. */}
      {aussage.anker && (
        <p className="vp-c-sp-anker">
          <span className="vp-c-sp-anker-label">{aussage.anker.label}</span>
          <span className="vp-c-sp-anker-wert">{aussage.anker.wert}</span>
        </p>
      )}

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

/**
 * Die Karte MIT BESTAND: der Tag, die Anker, „Tag für Tag“ und der Rechenweg —
 * jede Zeile und jede Zahl aus `steuerungKarte()`, hier wird nur gezeichnet.
 */
function SpeicherKarteMitBestand({
  karte,
  label,
  variant,
}: {
  karte: SteuerungKarte;
  label: string;
  variant: 'karte' | 'sektion';
}) {
  return (
    <section
      className={
        variant === 'sektion' ? 'vp-c-speicher is-sektion' : 'vp-c-card vp-c-speicher'
      }
    >
      <h3 className="vp-c-label">
        <span className="vp-c-label-text">{label}</span>
        {karte.chip && <span className="vp-chip">{karte.chip}</span>}
      </h3>

      <p className="vp-c-sp-zeile">
        <span className="vp-c-sp-label">{karte.tag.label}</span>
        <span className="vp-c-sp-wert">{karte.tag.wert}</span>
        {karte.tag.grund && <span className="vp-c-sp-sek vp-c-sp-grund">{karte.tag.grund}</span>}
      </p>

      {karte.anker.map((a) => (
        <p key={a.label} className="vp-c-sp-anker">
          <span className="vp-c-sp-anker-label">{a.label}</span>
          <span className="vp-c-sp-anker-wert">{a.wert}</span>
        </p>
      ))}

      {karte.liste && (
        <div className="vp-c-sp-liste">
          <h4 className="vp-c-sp-liste-kopf">Tag für Tag</h4>
          <ul>
            {karte.liste.zeilen.map((z) => (
              <li key={z.label}>
                <span className="vp-c-sp-tag">{z.label}</span>
                <span className="vp-c-sp-tag-wert">{z.wert}</span>
                {z.grund && <span className="vp-c-sp-tag-grund">{z.grund}</span>}
              </li>
            ))}
          </ul>
          <p className="vp-c-sp-summe">
            <span>{karte.liste.summe.label}</span>
            <span className="vp-c-sp-tag-wert">{karte.liste.summe.wert}</span>
          </p>
          <p className="vp-c-sp-fuss">{karte.liste.fuss}</p>
        </div>
      )}

      {karte.rechenweg.length > 0 && (
        <details className="vp-formel">
          <summary>{FORMEL_AUSLOESER_SCHRITTE}</summary>
          <div className="vp-formel-body">
            <RechenZeilen zeilen={karte.rechenweg} />
          </div>
        </details>
      )}
    </section>
  );
}
