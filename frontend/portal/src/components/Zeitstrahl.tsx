import { useId } from 'react';
import './Zeitstrahl.css';

export type ZeitstrahlZustand = 'gilt' | 'geplant' | 'beendet';

export interface ZeitstrahlAbschnitt {
  schluessel: string;
  /** Wozu der Abschnitt gehört — „Werk Ahrenberg Nord (ST-3)“. */
  titel: string;
  /** „01.10.2026 – 28.02.2027“ oder „ab 01.03.2027“. */
  zeitraum: string;
  zustand: ZeitstrahlZustand;
}

const WORT: Record<ZeitstrahlZustand, string> = { gilt: 'gilt', geplant: 'geplant', beendet: 'beendet' };

/**
 * Der Zeitstrahl-Baustein (UEMS AP-02 IP-12, V4): die Zuordnungen eines Objekts als senkrechte Folge
 * von Abschnitten — was bis wann galt, was heute gilt, was geplant ist. Senkrecht, damit er bei 375 px
 * nie quer läuft; die Reihenfolge ist die der Tage. Rein darstellend: Wortlaut und Zustand kommen
 * fertig vom Aufrufer (etwa `zeitstrahl` in `ortVerschieben.ts`). Ohne Abschnitte gibt es ihn nicht.
 */
export function Zeitstrahl({ titel, abschnitte }: { titel: string; abschnitte: ZeitstrahlAbschnitt[] }) {
  const id = `vp-zs-${useId().replace(/:/g, '')}`;
  if (abschnitte.length === 0) return null;
  return (
    <section className="vp-zs" aria-labelledby={id} data-testid="zeitstrahl">
      <h4 id={id}>{titel}</h4>
      <ol className="vp-zs-liste">
        {abschnitte.map((a) => (
          <li key={a.schluessel} className={`vp-zs-abschnitt vp-zs-${a.zustand}`}>
            <span className="vp-zs-punkt" aria-hidden="true" />
            <span className="vp-zs-text">
              <span className="vp-zs-titel">{a.titel}</span>
              <span className="vp-zs-zeitraum">{a.zeitraum}</span>
            </span>
            <span className="vp-zs-chip">{WORT[a.zustand]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
