import type { ReactNode } from 'react';
import { NwSymbol } from './NwSymbol';
import { ZUSTAND_WORT, type ZustandArt } from './nwBild';
import './NwZeilen.css';

/** Zustands-Zeichen einer Folge oder eines Schritts (`.zs`): erledigt (Haken), läuft (Uhr), überfällig, ohne Folge. */
export function ZustandsZeichen({ art, stumm = false }: { art: ZustandArt; stumm?: boolean }) {
  const symbol =
    art === 'done' ? <NwSymbol name="check" size={12} strokeWidth={3} /> : art === 'ohne' ? null : <NwSymbol name="uhr" size={11} strokeWidth={2.4} />;
  const aria = stumm ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': ZUSTAND_WORT[art] };
  return (
    <span className={`vp-nw-zs is-${art}`} {...aria}>
      {symbol}
    </span>
  );
}

/**
 * Die Status-Zeile unter dem Titel einer Seite (`.pstatus`, Familie R4/m1): ein Zeichen und zwei bis fünf Wörter, die die
 * Frage der Seite beantworten („● Stand 1 gilt“, „✓ abgeschlossen“), leise dahinter höchstens ein Fakt. Warnton nur für
 * Abgelaufenes.
 */
export function StatusZeile({
  zeichen,
  text,
  sub,
  warn = false,
  testId,
}: {
  zeichen: ReactNode;
  text: string;
  sub?: string | null;
  warn?: boolean;
  testId?: string;
}) {
  return (
    <p className={`vp-nw-status${warn ? ' is-warn' : ''}`} data-testid={testId}>
      {zeichen}
      <span>{text}</span>
      {sub && <span className="vp-nw-status-sub">{sub}</span>}
    </p>
  );
}
