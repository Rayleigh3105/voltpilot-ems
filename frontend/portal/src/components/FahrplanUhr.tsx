/**
 * Die TAGESUHR am Telefon - eine Uhr, die geht wie eine echte Uhr (Überblick
 * 20.10.2026, Variante A). Render-only: jede Form kommt aus `fahrplanUhr.ts`.
 *
 * Ein Ring und ein Zeiger. Heute steht der Stundenzeiger wie am Handgelenk,
 * der Ring zeigt, was ab jetzt kommt; gestern und morgen zeigt die Uhr den
 * Vor- bzw. Nachmittag ohne Zeiger. Farbe ist die Richtung des Speichers
 * (`roleColor`: grün lädt, beere gibt ab, grau wartet), das Symbol sagt
 * wofür - die Identität einer Phase hängt nie an der Farbe allein.
 *
 * Bedienung: jeder Bogen ist ein Knopf (Tipp, Eingabe, Leertaste) und öffnet
 * das Warum seiner Phase. Am Telefon gibt der Tipp den Haptik-Tick.
 */

import type { KeyboardEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import { uhrzeit } from '../fahrplanTag';
import { ROLLEN_SYMBOL } from '../fahrplanTagesbild';
import { UHR_C, UHR_MASS, type UhrModell, type UhrPhase } from '../fahrplanUhr';
import { haptik } from '../haptik';
import { roleColor } from './FahrplanWhy';

/** Rollen mit heller Farbe: ihr Symbol steht dunkel. */
const HELL = new Set(['warten', 'reserve_halten', 'abregeln']);

function zeit(m: number): string {
  return m >= 1440 ? (m === 1440 ? '24:00' : uhrzeit(m - 1440)) : uhrzeit(m);
}

export function FahrplanUhr({
  modell,
  beschriftung,
  onPhase,
}: {
  modell: UhrModell;
  /** Wofür die Uhr steht („Die Uhr: was ab jetzt kommt"). */
  beschriftung: string;
  /** Ein Tipp auf einen Bogen: das Warum dieser Phase. */
  onPhase: (p: UhrPhase) => void;
}) {
  const t = chartTheme();
  const waehlen = (p: UhrPhase) => {
    haptik('tick');
    onPhase(p);
  };
  return (
    <div className="vp-uhr">
      <svg className="vp-uhr-svg" viewBox={`0 0 ${UHR_MASS} ${UHR_MASS}`} role="group" aria-label={beschriftung}>
        <circle cx={UHR_C} cy={UHR_C} r={139} className="vp-uhr-blatt" />
        {modell.boegen.map((b) => {
          const farbe = roleColor(b.phase.role, t);
          const satz = `${zeit(b.von)} bis ${zeit(b.bis)}: ${b.phase.label}`;
          return (
            <g
              key={`${b.phase.quelle}-${b.phase.phaseIndex}-${b.von}`}
              className="vp-uhr-bogen"
              role="button"
              tabIndex={0}
              aria-label={`${satz}. Warum?`}
              onClick={() => waehlen(b.phase)}
              onKeyDown={(ev: KeyboardEvent<SVGGElement>) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  waehlen(b.phase);
                }
              }}
            >
              <title>{satz}</title>
              <path d={b.d} fill={farbe} />
              {b.symbol && (
                <Icon
                  name={ROLLEN_SYMBOL[b.phase.role]}
                  size={16}
                  strokeWidth={2.2}
                  x={b.symbol.x - 8}
                  y={b.symbol.y - 8}
                  stroke={HELL.has(b.phase.role) ? t.ink : '#FFFFFF'}
                />
              )}
            </g>
          );
        })}
        <g aria-hidden="true">
          {modell.striche.map((s, k) => (
            <line key={k} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className={`vp-uhr-strich${s.lang ? ' is-lang' : ''}`} />
          ))}
          {modell.zahlen.map((z) => (
            <text key={z.text} x={z.x} y={z.y + 7} textAnchor="middle" className="vp-uhr-zahl">
              {z.text}
            </text>
          ))}
          {modell.marken.map((m) => (
            <text key={m.minute} x={m.x} y={m.y + 4} textAnchor="middle" className="vp-uhr-marke">
              {m.text}
            </text>
          ))}
          {modell.zeiger && (
            <>
              <line x1={UHR_C} y1={UHR_C} x2={modell.zeiger.x} y2={modell.zeiger.y} className="vp-uhr-zeiger" />
              <circle cx={modell.zeiger.x} cy={modell.zeiger.y} r={10} className="vp-uhr-knopf" />
            </>
          )}
          <circle cx={UHR_C} cy={UHR_C} r={8} className="vp-uhr-nabe" />
        </g>
      </svg>
    </div>
  );
}
