import type { ReactNode } from 'react';
import { InfoTip } from '../InfoTip';
import { PROVENIENZ, type Provenienz } from '../../historieWelten';

/**
 * **Das Statement** — Bauteil 1 der Variante C (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (1); Captain-Entscheid
 * E1 = (c) vom 03.09.2026).
 *
 * Es steht AUF DER FLÄCHE, nicht in einer Karte: die eine Zahl braucht keinen
 * Rahmen, sie IST der Rahmen. Vier Dinge, in dieser Reihenfolge —
 *
 *   Label 12/700 Versalien + Provenienz-Chip · Zahl 48/800 (375: 36) ·
 *   der eine Satz 16 · die Einordnung 16 + Chip + ⓘ.
 *
 * ⚠ **Die Farbe ist die ZUGABE, nie die Aussage** (§2 Prinzip 4, E8 = a): der
 *   Betrag trägt sein Vorzeichen als ZEICHEN; `is-kosten` färbt zusätzlich.
 *   Wer die Farbe nicht sieht, liest dieselbe Aussage.
 *
 * ⚠ **Der Vergleichs-Chip trägt KEINEN Farbton** (W1 = a): „↓ 25 %" ist eine
 *   Beobachtung, kein Urteil — ein grüner Aufwärts-Chip behauptete, mehr sei
 *   immer besser, und ein roter Abwärts-Chip, weniger Sonne sei ein Mangel.
 *   Deshalb rendert dieses Bauteil den Chip SELBST statt `DeltaZeile` zu
 *   benutzen (die trägt `vp-delta-{wertung}` und damit einen Ton).
 *
 * ⚠ **Der Fallback-Satz wandert in den ⓘ-Tooltip** (W2 = a): „Verglichen wird
 *   bis 11 Uhr — der Vortag ebenfalls …" ist eine METHODEN-Auskunft. Auf
 *   Ebene 0 kostete sie 20 Wörter und beantwortete eine Frage, die niemand
 *   gestellt hat; im Tooltip steht sie für die, die sie stellen.
 */
export interface StatementEinordnung {
  /** „Bis 11 Uhr: heute 50,90 € · gestern 67,71 €" — Beträge, nie ein Chip. */
  betraege: string | null;
  /** „↓ 25 %" — ohne Farbton, mit Richtungszeichen im Text. */
  chip: { text: string; richtung: 'mehr' | 'weniger' | 'gleich'; titel?: string } | null;
  /** Die Methoden-Auskunft; sie steht NUR im ⓘ. */
  satz: string | null;
}

export interface StatementProps {
  /** „ERGEBNIS · MI., 02.09.2026" — die Fläche versalisiert, die Daten nicht. */
  label: string;
  /**
   * Das Ehrlichkeits-Abzeichen der Karte (genau eines).
   *
   * ⚠ OPTIONAL seit P5: die Cockpit-Erlöskarte trägt es NICHT (Mockup
   *   `rvC-375-cockpit.png`) — dort sind „Zwischenstand" und „Kein Abzug"
   *   die zwei Chips, die §3.7 misst, und ein drittes Abzeichen sprengte das
   *   Chip-Budget (§2 Prinzip 5). Die BEWERTUNG steht eine Ebene tiefer, auf
   *   der Erlöse-Seite, über derselben Zahl.
   */
  provenienz?: Provenienz | null;
  /** Die eine Zahl, fertig formatiert und MIT Vorzeichen. */
  betrag: string;
  /** `true` färbt sie zusätzlich — das Zeichen steht ohnehin im Text. */
  kosten: boolean;
  /**
   * Der eine Satz, höchstens acht Wörter.
   *
   * ⚠ OPTIONAL seit P5: die Cockpit-Erlöskarte trägt ihn NICHT (§3.10 misst
   *   sie bei 32 Wörtern — der Obergrenze der Abnahme). Dort sagt der Kontext
   *   schon, worüber gesprochen wird; auf der Erlöse-Seite ist er der Einstieg
   *   in eine ganze Welt und bleibt Pflicht-Lesestoff.
   */
  satz?: string;
  /** Der Vergleich in EINER Zeile; ohne Vortag bleibt sie weg. */
  einordnung?: StatementEinordnung | null;
  /** Zusatz unter der Einordnung (die Seite hängt hier nichts ein). */
  children?: ReactNode;
}

/** Das Richtungszeichen — es steht IM Text, nicht nur in der Farbe. */
const PFEIL: Record<'mehr' | 'weniger' | 'gleich', string> = {
  mehr: '↑',
  weniger: '↓',
  gleich: '',
};

export function Statement({
  label,
  provenienz,
  betrag,
  kosten,
  satz,
  einordnung,
  children,
}: StatementProps) {
  const prov = provenienz ? PROVENIENZ[provenienz] : null;
  const ein = einordnung ?? null;
  const zeigeEinordnung = Boolean(ein && (ein.betraege || ein.chip));
  return (
    <div className="vp-c-stm">
      {/* ⚠ Das Label IST die Überschrift der Ergebnis-Fläche (`h2`) — Variante C
          gibt ihr keine Karten-Kopfzeile mehr (§3.10 (1)), also müsste ohne
          dieses `h2` die eine Zahl der Seite ohne Überschrift im Dokument
          stehen. Die Optik bleibt 12/700 Versalien; die Kartenlabels darunter
          sind `h3` (Kontoauszug, Ihr Speicher). */}
      <h2 className="vp-c-label">
        <span className="vp-c-label-text">{label}</span>
        {prov && (
          <span className="vp-chip" title={prov.satz}>
            {prov.label}
          </span>
        )}
      </h2>
      <p className={kosten ? 'vp-c-stm-zahl is-kosten' : 'vp-c-stm-zahl'}>{betrag}</p>
      {satz && <p className="vp-c-stm-satz">{satz}</p>}
      {zeigeEinordnung && ein && (
        <p className="vp-c-stm-ein">
          {ein.betraege && <span>{ein.betraege}</span>}
          {ein.chip && (
            <span className="vp-chip" title={ein.chip.titel}>
              {PFEIL[ein.chip.richtung] && `${PFEIL[ein.chip.richtung]} `}
              {ein.chip.text}
            </span>
          )}
          {ein.satz && (
            <span className="vp-c-info">
              <InfoTip label="Wie wird verglichen?">{ein.satz}</InfoTip>
            </span>
          )}
        </p>
      )}
      {children}
    </div>
  );
}
