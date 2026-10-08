import type { CSSProperties } from 'react';
import { NwSymbol } from './NwSymbol';
import './NwZeilen.css';

/** Eine Stufe eines Vorgangs: erledigt (mit Tag), jetzt (der nächste Schritt), offen, ausgelassen. */
export type Stufe = { titel: string; datum?: string | null; zustand: 'done' | 'an' | 'offen' | 'aus' };

const WORT: Record<Stufe['zustand'], string> = { done: 'erledigt', an: 'jetzt', offen: 'offen', aus: 'ausgelassen' };

/**
 * Die Stufen eines Vorgangs (Verbessern v1, `.stufen`): „Geplant · Durchgeführt · Abgeschlossen“ mit Tag darunter. Grün
 * nur für erledigte Schritte, Navy für den nächsten; nichts wird geraten - eine Stufe ohne Tag bleibt ohne Tag.
 */
export function Stufen({ stufen, label = 'Stand des Vorgangs', testId }: { stufen: Stufe[]; label?: string; testId?: string }) {
  return (
    <ol className="vp-nw-stufen" style={{ '--n': stufen.length } as CSSProperties} aria-label={label} data-testid={testId}>
      {stufen.map((s) => (
        <li key={s.titel} className={`is-${s.zustand}`} aria-label={`${s.titel}: ${s.datum ?? WORT[s.zustand]}`}>
          <span className="vp-nw-stufe-p" aria-hidden="true">
            {s.zustand === 'done' && <NwSymbol name="check" size={13} strokeWidth={3} />}
          </span>
          <b aria-hidden="true">{s.titel}</b>
          {s.datum && <small aria-hidden="true">{s.datum}</small>}
        </li>
      ))}
    </ol>
  );
}
