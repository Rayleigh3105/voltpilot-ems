import { createContext, useContext, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import './GrenzSatz.css';

/**
 * Der Grenz-Satz und der Verantwortungs-Satz des Energiemanagements — EINMAL je Bereich statt mehrfach je Seite
 * (Konzept „Energiemanagement ohne Fachsprache“ K7, Entscheid D5).
 *
 * Ein Bereich (Bewertung, Energieeinsatz, Ziele und Maßnahmen, Energiemanagement, die UEMS-Bausteine der Übersicht)
 * legt sich in `GrenzSatzBereich` und trägt im Kopf `GrenzHinweis`: „Was VoltPilot leistet“ öffnet beide Sätze im
 * vollen Wortlaut. Jeder Teil darin (Rangliste, Register, Reiter) behält seinen `GrenzSatz` — er schweigt im Bereich und
 * spricht, wo er allein steht. Dialoge und Berichte tragen die Sätze weiter selbst und vollständig - außer den Dialogen
 * unter Verbessern: sie sind Teile ihrer Seite, der Satz steht dort einmal (Konzept Verbessern v1, PR 4;
 * `VERBESSERUNG_TEILE` in `copy.test.ts`).
 */
const ImBereich = createContext(false);

export function GrenzSatzBereich({ children }: { children: ReactNode }) {
  return <ImBereich.Provider value={true}>{children}</ImBereich.Provider>;
}

/** Die Sätze einer Fläche; in einem `GrenzSatzBereich` stehen sie im `GrenzHinweis` seines Kopfs. */
export function GrenzSatz({
  className,
  verantwortung = false,
  grenze = true,
  testId,
}: {
  className?: string;
  /** Auch der Verantwortungs-Satz (Flächen des Energiemanagements, SP4). */
  verantwortung?: boolean;
  /** Der Grenz-Satz; `false` nur, wo eine Fläche allein den Verantwortungs-Satz trägt. */
  grenze?: boolean;
  testId?: string;
}) {
  if (useContext(ImBereich)) return null;
  return (
    <>
      {verantwortung && <p className={className}>{UEMS_VERANTWORTUNG}</p>}
      {grenze && (
        <p className={className} data-testid={testId}>
          {UEMS_NORMGRENZE}
        </p>
      )}
    </>
  );
}

export const GRENZHINWEIS_TITEL = 'Was VoltPilot leistet';

/** Der Hinweis im Kopf eines Bereichs: ein Aufklapper mit beiden Sätzen im vollen Wortlaut. */
export function GrenzHinweis() {
  return (
    <details className="vp-grenzhinweis" data-testid="grenzhinweis">
      <summary>
        <Icon name="info" size={15} />
        <span>{GRENZHINWEIS_TITEL}</span>
      </summary>
      <div className="vp-grenzhinweis-text">
        <p>{UEMS_NORMGRENZE}</p>
        <p>{UEMS_VERANTWORTUNG}</p>
      </div>
    </details>
  );
}
