import type { ReactNode } from 'react';
import type { ErgebnisZeilenView, ErloesZeileId, SekundaerZiel } from '../erloesZeilen';
import type { Provenienz } from '../provenienz';
import { Kontoauszug } from './erloese/Kontoauszug';
import { Statement, type StatementEinordnung } from './erloese/Statement';
import './erloese/ErgebnisKarte.css';

/**
 * **Die Ergebnis-Fläche, Variante C „Neu modern"** — der Zusammenbau
 * (Konzept `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C";
 * Captain-Entscheid E1 = (c) vom 03.09.2026).
 *
 * Sie hält NUR die Ordnung; jedes Bauteil kennt seine eigene Anatomie:
 *
 *   links   `Statement` (auf der Fläche) + `Kontoauszug` (Karte)
 *   rechts  `SpeicherKarte` (Karte) + `PreiseZeile` (flache Karte)
 *
 * ⚠ **Zwei Spalten ab 1100 px** (E4 = a): 58 % links, 42 % rechts. Darunter
 *   EINE Spalte in der Leserichtung Statement → Kontoauszug → Speicher →
 *   Preise. Der Falz gehört dem Ergebnis (§2 Prinzip 7) — deshalb steht das
 *   Statement auf jeder Breite zuerst und in derselben Reihenfolge.
 *
 * ⚠ **Das Statement steht IN der linken Spalte, nicht darüber.** Über beiden
 *   Spalten wäre die eine Zahl vom Kontoauszug abgeschnitten, der sie belegt;
 *   in der Spalte stehen Zahl und Beleg untereinander wie auf einem Beleg.
 *
 * ⚠ **Der Name bleibt `ErgebnisZeilen`** — die Seite und die Beweis-Harness
 *   hängen an dieser Einbaustelle; getauscht wurde die Anatomie, nicht der
 *   Anschluss.
 */
export interface ErgebnisZeilenProps {
  view: ErgebnisZeilenView;
  /** „ERGEBNIS · MI., 02.09.2026" — die Fläche versalisiert, die Daten nicht. */
  label: string;
  /** Das Ehrlichkeits-Abzeichen (genau eines je Fläche). */
  provenienz?: Provenienz;
  /**
   * Ebene 1 der Zeile. Fehlt sie, bleibt die Zeile eine ruhige Zeile —
   * ein Aufklapper ohne Inhalt wäre ein Versprechen ins Leere.
   */
  ebene1?: (id: ErloesZeileId) => ReactNode | null;
  /** Wohin ein Weg der Sekundärzeile führt; ohne Auflösung bleibt er Text. */
  hrefFor?: (ziel: SekundaerZiel) => string | undefined;
  /** Der Vergleich in EINER Zeile — er wohnt im Statement (§3.2 (7)). */
  einordnung?: StatementEinordnung | null;
  /** Zeilen ausserhalb des Wasserfalls (Lastspitzen). */
  ausserhalb?: ReactNode;
  /** Der Perioden-Hinweis unter dem Kontoauszug. */
  note?: ReactNode;
  /** Die Karte „Ihr Speicher" — rechts ab 1100 px, sonst darunter. */
  speicher?: ReactNode;
  /** Die flache Karte „Preise & Vergütung". */
  preise?: ReactNode;
}

export function ErgebnisZeilen({
  view,
  label,
  provenienz = 'bewertet',
  ebene1,
  hrefFor,
  einordnung,
  ausserhalb,
  note,
  speicher,
  preise,
}: ErgebnisZeilenProps) {
  return (
    <div className="vp-c">
      <div className="vp-c-links">
        {view.hero && (
          <Statement
            label={label}
            provenienz={provenienz}
            betrag={view.hero.text}
            kosten={view.hero.ton === 'kosten'}
            satz={view.satz}
            einordnung={einordnung}
          />
        )}
        <Kontoauszug
          view={view}
          ebene1={ebene1}
          hrefFor={hrefFor}
          ausserhalb={ausserhalb}
          note={note}
        />
      </div>
      <div className="vp-c-rechts">
        {speicher}
        {preise}
      </div>
    </div>
  );
}
