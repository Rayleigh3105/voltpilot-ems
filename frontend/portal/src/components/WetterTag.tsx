import type { ReactNode } from 'react';
import type { HimmelArt } from '../wetterTag';
import './WetterTag.css';

/**
 * Das Himmel-Symbol (Konzept „Preise und Wetter", Fassung 3). Ursprünglich
 * ein Baustein der (inzwischen entfernten) Wetter-Seite - seit Konzept
 * `vp-prognosen-konzept` lebt es im Sonnen-Teppich weiter
 * (`PrognoseTeppich.tsx`), über dem Tagesbild und in jeder Zeile des
 * Teppichs.
 */

/* ===========================================================================
 * Das Wettersymbol
 * ========================================================================= */

function sonne(cx: number, cy: number, r: number, strahl: number): ReactNode {
  const strahlen = Array.from({ length: 8 }, (_, k) => {
    const a = (k * Math.PI) / 4;
    const r1 = r + 2.2;
    const r2 = r + 2.2 + strahl;
    return `M${(cx + r1 * Math.cos(a)).toFixed(2)} ${(cy + r1 * Math.sin(a)).toFixed(2)}L${(cx + r2 * Math.cos(a)).toFixed(2)} ${(cy + r2 * Math.sin(a)).toFixed(2)}`;
  }).join('');
  return (
    <>
      <circle cx={cx} cy={cy} r={r} className="vp-ws-sonne" />
      <path d={strahlen} className="vp-ws-strahl" />
    </>
  );
}

function wolke(dx: number, dy: number, hell: boolean): ReactNode {
  return (
    <path
      transform={`translate(${dx} ${dy})`}
      d="M7 19h10.5a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.5 1.6A3.8 3.8 0 0 0 7 19z"
      className={hell ? 'vp-ws-wolke is-hell' : 'vp-ws-wolke'}
    />
  );
}

function mond(dx: number, dy: number): ReactNode {
  return <path transform={`translate(${dx} ${dy})`} d="M15.5 3.5a8 8 0 1 0 5 13 6.5 6.5 0 0 1-5-13z" className="vp-ws-mond" />;
}

/** Ein Symbol je Himmel — immer zusammen mit seinem Wort, nie allein. */
export function WetterSymbol({ art, groesse = 24 }: { art: HimmelArt | null; groesse?: number }) {
  let inhalt: ReactNode;
  switch (art) {
    case 'sonnig':
      inhalt = sonne(12, 12, 4.6, 3);
      break;
    case 'wechselnd':
      inhalt = (
        <>
          {sonne(9, 8.5, 3.6, 2.2)}
          {wolke(1.5, 2.2, true)}
        </>
      );
      break;
    case 'bewoelkt':
      inhalt = wolke(0, -1, false);
      break;
    case 'klar':
      inhalt = mond(-1, 0);
      break;
    case 'nachtWolken':
      inhalt = (
        <>
          {mond(-3, -2)}
          {wolke(1.5, 2.5, false)}
        </>
      );
      break;
    default:
      inhalt = wolke(0, -1, false);
  }
  return (
    <svg width={groesse} height={groesse} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" className="vp-ws">
      {inhalt}
    </svg>
  );
}
