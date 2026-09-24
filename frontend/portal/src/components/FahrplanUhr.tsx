/**
 * Die TAGESUHR des Fahrplans (Konzept „Tagesuhr und Bildfahrplan", E1: am
 * Telefon ganz oben, direkt darunter die Antworten).
 *
 * Render-only: jede Form kommt aus `fahrplanUhr.ts`, jede Zahl aus dem
 * Tagesmodell (`fahrplanTag.ts`). Hier stehen nur Farben, Wörter und die
 * Bedienung:
 *  - **Ziehen oder Tippen** auf den Ringen stellt den Zeiger auf eine
 *    Viertelstunde; kurz vor einer Phasengrenze rastet er an ihrem Beginn ein.
 *  - **Tipp in die Mitte** holt die Gegenwart zurück.
 *  - **Tasten:** Pfeile je Viertelstunde, Bild auf/ab je Stunde, Pos1/Ende,
 *    Escape zurück zu jetzt (die Uhr ist ein `slider`).
 *  - **Haptik** (Telefon): ein kurzer Impuls an jeder Phasengrenze, ein
 *    doppelter bei „jetzt" (`haptik.ts`; ohne Unterstützung passiert nichts).
 *
 * Farben kommen aus `chartTheme()`/`roleColor` — dieselbe Farbsprache wie
 * Diagramm, Film und Erklär-Panel. Die Identität einer Phase hängt nie an der
 * Farbe allein: jede Phase ab 45 Minuten trägt ihr Symbol, jede Auswahl nennt
 * ihr Wort (Zeile unter der Uhr, `aria-valuetext`).
 *
 * Ehrlichkeit: die Uhr zeigt den PLAN. Vergangenes ist der Plan, der damals
 * galt (blasser); gemessen sind nur die kräftigen Sonnenstrahlen.
 */

import { memo, useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import type { AntwortZiel } from '../fahrplanAntworten';
import { phaseVon, uhrzeit, viertelBei, type TagModell } from '../fahrplanTag';
import {
  UHR_C,
  UHR_MASS,
  UHR_R,
  socRadius,
  uhrAntwortRahmen,
  uhrPhasenRahmen,
  uhrPunkt,
  uhrzeitAus,
  type UhrModell,
} from '../fahrplanUhr';
import { haptik } from '../haptik';
import { roleColor } from './FahrplanWhy';
import { ROLLEN_SYMBOL, ladestandText, type TagesbildEbene } from '../fahrplanTagesbild';

/** Unter diesem Abstand zur Mitte (Einheiten des 440er-Quadrats) meint ein Tipp die Mitte. */
const MITTE_TIPP = 68;
/** Ab hier greift ein Finger den Zeiger statt die Seite zu rollen. */
const GRIFF_INNEN = 92;
const GRIFF_AUSSEN = 216;
/** So viele Minuten vor einer Phasengrenze rastet der Zeiger an ihrem Beginn ein. */
const EINRASTEN_MIN = 6;
/**
 * Wo „voll" und „leer" an der Ladestandsfläche stehen (Minute des Tages):
 * 16:30 liegt rechts, knapp über der Mitte — „leer" innen links, „voll" außen
 * rechts, gelesen wie eine Skala. Der Zeiger kreuzt die Stelle nur kurz.
 */
const BESCHRIFTUNG_MIN = 990;

export interface FahrplanUhrProps {
  tag: TagModell;
  modell: UhrModell;
  /** Die Viertelstunde am Zeiger (Index in `tag.slots`). */
  auswahl: number;
  istJetzt: boolean;
  /** Die Zeigerstellung in Minuten — während einer Animation zwischen zwei Viertelstunden. */
  zeiger: number;
  /** Die hervorgehobene Ebene (Werte am Zeiger, Einführung); null = keine. */
  fokus: TagesbildEbene | 'zeiger' | null;
  /** Die Stelle einer angetippten Antwort; null = keine. */
  markierung: AntwortZiel | null;
  spielt: boolean;
  onWahl: (i: number) => void;
  onJetzt: () => void;
  onSpielen: () => void;
  onErklaeren: () => void;
  /** Wird bei jeder Berührung gerufen (hält Abspielen und Einführung an). */
  onBeruehrt: () => void;
}

export function FahrplanUhr({
  tag,
  modell,
  auswahl,
  istJetzt,
  zeiger,
  fokus,
  markierung,
  spielt,
  onWahl,
  onJetzt,
  onSpielen,
  onErklaeren,
  onBeruehrt,
}: FahrplanUhrProps) {
  const t = chartTheme();
  // Eine eigene Kennung je Uhr: `url(#…)` greift sonst in die falsche Uhr.
  const tankId = `vp-uhr-tank-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zug = useRef<{ art: 'mitte' | 'ring'; phase: number | null } | null>(null);

  // Ein Finger auf den Ringen greift den Zeiger, statt die Seite zu rollen —
  // anderswo (Mitte, Rand) rollt die Seite wie gewohnt. Das geht nur mit
  // einem NICHT-passiven `touchstart` (React meldet ihn passiv an).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const halten = (ev: TouchEvent) => {
      const b = svg.getBoundingClientRect();
      const touch = ev.touches[0];
      if (!touch || b.width === 0) return;
      const k = UHR_MASS / b.width;
      const dx = (touch.clientX - b.left - b.width / 2) * k;
      const dy = (touch.clientY - b.top - b.height / 2) * k;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= GRIFF_INNEN && r <= GRIFF_AUSSEN) ev.preventDefault();
    };
    svg.addEventListener('touchstart', halten, { passive: false });
    return () => svg.removeEventListener('touchstart', halten);
  }, []);

  const polar = (ev: PointerEvent<SVGSVGElement>) => {
    const b = ev.currentTarget.getBoundingClientRect();
    const k = b.width > 0 ? UHR_MASS / b.width : 1;
    return uhrzeitAus((ev.clientX - b.left - b.width / 2) * k, (ev.clientY - b.top - b.height / 2) * k);
  };

  const phaseIndexVon = (i: number) => phaseVon(tag, i)?.phaseIndex ?? null;

  const waehle = (ev: PointerEvent<SVGSVGElement>) => {
    let { minute } = polar(ev);
    // Einrasten: kurz vor einer Phasengrenze springt der Zeiger auf ihren Beginn.
    for (const ph of tag.phasen) {
      if (minute > ph.von - EINRASTEN_MIN && minute < ph.von) minute = ph.von;
    }
    const i = viertelBei(tag, minute);
    if (i < 0 || i === auswahl) return;
    if (ev.pointerType !== 'mouse') {
      const ph = phaseIndexVon(i);
      if (i === tag.jetztIndex) haptik('jetzt');
      else if (zug.current && ph !== zug.current.phase) haptik('tick');
      if (zug.current) zug.current.phase = ph;
    }
    onWahl(i);
  };

  const unten = (ev: PointerEvent<SVGSVGElement>) => {
    onBeruehrt();
    const { abstand } = polar(ev);
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // ältere Browser: ohne Einfangen geht das Ziehen nur über der Uhr
    }
    if (abstand < MITTE_TIPP) {
      zug.current = { art: 'mitte', phase: null };
      return;
    }
    zug.current = { art: 'ring', phase: phaseIndexVon(auswahl) };
    waehle(ev);
  };

  const ziehen = (ev: PointerEvent<SVGSVGElement>) => {
    if (zug.current?.art === 'ring') waehle(ev);
  };

  const oben = (ev: PointerEvent<SVGSVGElement>) => {
    const z = zug.current;
    zug.current = null;
    if (z?.art === 'mitte' && polar(ev).abstand < MITTE_TIPP + 4 && !istJetzt && tag.jetztIndex >= 0) {
      if (ev.pointerType !== 'mouse') haptik('jetzt');
      onJetzt();
    }
  };

  const taste = (ev: KeyboardEvent<SVGSVGElement>) => {
    const n = tag.slots.length;
    if (n === 0) return;
    if (ev.key === 'Escape') {
      if (!istJetzt && tag.jetztIndex >= 0) {
        ev.preventDefault();
        onJetzt();
      }
      return;
    }
    const schritt: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 4,
      PageDown: -4,
    };
    let i: number;
    if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = n - 1;
    else if (schritt[ev.key] != null) i = Math.max(0, Math.min(n - 1, auswahl + schritt[ev.key]));
    else return;
    ev.preventDefault();
    onBeruehrt();
    if (i !== auswahl) onWahl(i);
  };

  const v = tag.viertel[auswahl];
  const ph = phaseVon(tag, auswahl);
  const soc = tag.slots[auswahl]?.socPct;
  const socZahl = soc == null || !Number.isFinite(Number(soc)) ? null : Number(soc);
  const griffFarbe = ph ? roleColor(ph.role, t) : t.neutral;
  const knopfFarbe = ph && (ph.role === 'warten' || ph.role === 'reserve_halten') ? t.neutral : griffFarbe;
  const zeitText = istJetzt && tag.jetzt != null ? `Jetzt · ${uhrzeit(tag.jetzt)}` : v ? uhrzeit(v.von) : '';
  const wertText = v
    ? `${istJetzt ? 'Jetzt' : `${uhrzeit(v.von)} Uhr`}${ph ? `, ${ph.label}` : ''}${
        socZahl != null ? `, ${ladestandText(socZahl, v.vorbei)}` : ''
      }`
    : undefined;
  const winkel = 90 + (zeiger / 1440) * 360;
  const tankHoehe = socZahl == null ? 0 : (2 * UHR_R.mitte * Math.max(0, Math.min(100, socZahl))) / 100;

  return (
    <div className="vp-uhr">
      <svg
        ref={svgRef}
        className={`vp-uhr-svg${fokus ? ' has-fokus' : ''}`}
        viewBox={`0 0 ${UHR_MASS} ${UHR_MASS}`}
        role="slider"
        tabIndex={0}
        aria-label="Tagesuhr: Zeiger auf eine Uhrzeit stellen"
        aria-roledescription="Tagesuhr"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, tag.slots.length - 1)}
        aria-valuenow={auswahl}
        aria-valuetext={wertText}
        onPointerDown={unten}
        onPointerMove={ziehen}
        onPointerUp={oben}
        onPointerCancel={() => {
          zug.current = null;
        }}
        onKeyDown={taste}
      >
        <defs>
          <clipPath id={tankId}>
            <circle cx={UHR_C} cy={UHR_C} r={UHR_R.mitte - 1.5} />
          </clipPath>
        </defs>

        <UhrRinge tag={tag} modell={modell} fokus={fokus} markierung={markierung} />

        {/* Der Zeiger und der Umriss seiner Phase. */}
        {ph && <path d={uhrPhasenRahmen(ph.von, ph.bis)} fill="none" stroke={t.ink} strokeWidth={2} />}
        <g className={`vp-uhr-zeiger${fokus === 'zeiger' ? ' is-fokus' : ''}`} transform={`rotate(${winkel.toFixed(2)} ${UHR_C} ${UHR_C})`}>
          <line
            x1={UHR_C + UHR_R.mitte}
            y1={UHR_C}
            x2={UHR_C + 191}
            y2={UHR_C}
            stroke={t.ink}
            strokeWidth={2.6}
            strokeLinecap="round"
          />
          <circle cx={UHR_C + 150.5} cy={UHR_C} r={10.5} fill={t.surface} stroke={t.ink} strokeWidth={2.6} />
          <circle cx={UHR_C + 150.5} cy={UHR_C} r={4.2} fill={knopfFarbe} />
        </g>

        {/* Die Mitte füllt sich wie ein Tank mit dem Ladestand am Zeiger. */}
        <g className="vp-uhr-mitte">
          <circle cx={UHR_C} cy={UHR_C} r={UHR_R.mitte} fill={t.surface} stroke={t.axisLine} />
          <rect
            x={UHR_C - UHR_R.mitte}
            y={UHR_C + UHR_R.mitte - tankHoehe}
            width={UHR_R.mitte * 2}
            height={tankHoehe}
            fill={t.soc}
            fillOpacity={0.13}
            clipPath={`url(#${tankId})`}
          />
          <text x={UHR_C} y={UHR_C - 30} textAnchor="middle" className="vp-uhr-m1">
            {zeitText.toUpperCase()}
          </text>
          <text x={UHR_C} y={UHR_C + 6} textAnchor="middle" className="vp-uhr-m2">
            {socZahl == null ? '–' : `${Math.round(socZahl).toLocaleString('de-DE')} %`}
          </text>
          <text x={UHR_C} y={UHR_C + 24} textAnchor="middle" className="vp-uhr-m3">
            Ladestand
          </text>
          <text x={UHR_C} y={UHR_C + 40} textAnchor="middle" className="vp-uhr-m3">
            {v?.vorbei ? 'war geplant' : 'geplant'}
          </text>
        </g>
      </svg>

      <button
        type="button"
        className="vp-uhr-ecke is-links"
        onClick={onSpielen}
        aria-label={spielt ? 'Anhalten' : 'Den Tag abspielen'}
        title={spielt ? 'Anhalten' : 'Den Tag abspielen'}
      >
        {spielt ? <PauseSymbol /> : <PlaySymbol />}
      </button>
      <button
        type="button"
        className="vp-uhr-ecke is-rechts"
        onClick={onErklaeren}
        aria-label="Die Uhr erklären"
        title="Die Uhr erklären"
      >
        <Icon name="help-circle" size={18} />
      </button>
    </div>
  );
}

/**
 * Die RINGE der Uhr — alles außer Zeiger und Mitte. Gemerkt (`memo`): während
 * sich der Zeiger dreht, ändern sich weder Tag noch Hervorhebung, und die
 * rund 300 Formen bleiben stehen, statt je Bild neu zu entstehen.
 */
const UhrRinge = memo(function UhrRinge({
  tag,
  modell,
  fokus,
  markierung,
}: {
  tag: TagModell;
  modell: UhrModell;
  fokus: TagesbildEbene | 'zeiger' | null;
  markierung: AntwortZiel | null;
}) {
  const t = chartTheme();
  const ebene = (name: TagesbildEbene) =>
    fokus == null || fokus === 'zeiger' || fokus === name ? '' : ' is-leise';
  // Die Stelle einer Antwort: der Zeitraum am Tätigkeitsring, der Punkt am Ladestand.
  const markPunkt = (() => {
    if (!markierung || markierung.punkt == null) return null;
    const iPunkt = tag.viertel.findIndex((q) => q.bis >= markierung.punkt! - 0.01);
    const s = iPunkt >= 0 ? tag.slots[iPunkt]?.socPct : null;
    if (s == null || !Number.isFinite(Number(s))) return null;
    return uhrPunkt(socRadius(Number(s)), markierung.punkt);
  })();

  return (
    <>
      {/* Ladestand: je weiter außen, desto voller. */}
      <g className={`vp-uhr-ebene${ebene('ladestand')}`}>
        <circle cx={UHR_C} cy={UHR_C} r={UHR_R.soc1 + 4} className="vp-uhr-grund" />
        {[0, 50, 100].map((p) => (
          <circle
            key={p}
            cx={UHR_C}
            cy={UHR_C}
            r={socRadius(p)}
            fill="none"
            className={p === 50 ? 'vp-uhr-hilfslinie is-mitte' : 'vp-uhr-hilfslinie'}
          />
        ))}
        {modell.ladestand && (
          <>
            <path d={modell.ladestand.flaeche} fill={t.soc} fillOpacity={0.16} />
            <path d={modell.ladestand.kante} fill="none" stroke={t.soc} strokeWidth={2} strokeLinejoin="round" />
          </>
        )}
        <HaloText x={uhrPunkt(UHR_R.soc1 - 8, BESCHRIFTUNG_MIN).x} y={uhrPunkt(UHR_R.soc1 - 8, BESCHRIFTUNG_MIN).y + 4} text="voll" />
        <HaloText x={uhrPunkt(UHR_R.soc0 + 8, BESCHRIFTUNG_MIN).x} y={uhrPunkt(UHR_R.soc0 + 8, BESCHRIFTUNG_MIN).y + 4} text="leer" />
      </g>

      {/* Sonne: ein Strahl je Viertelstunde — hell erwartet, kräftig gemessen. */}
      <g className={`vp-uhr-ebene${ebene('sonne')}`}>
        {modell.strahlen.map((s, k) => (
          <path
            key={k}
            d={s.d}
            stroke={s.gemessen ? t.pvLine : t.pv}
            strokeOpacity={s.gemessen ? 1 : 0.45}
            strokeWidth={2.3}
            strokeLinecap="round"
          />
        ))}
      </g>

      {/* Strompreis: hell günstig, dunkel teuer; beide Enden beschriftet. */}
      <g className={`vp-uhr-ebene${ebene('preis')}`}>
        {modell.preis.map((p) =>
          p.stufe == null ? null : (
            <path key={p.i} d={p.d} fill={t.price} fillOpacity={0.14 + 0.86 * p.stufe} />
          ),
        )}
        {modell.preisMarken.map((m) => (
          <g key={m.art}>
            <path d={m.d} fill={t.price} />
            <HaloText
              x={m.x}
              y={m.y + 4}
              text={`${ct(m.ct)}`}
              className="vp-uhr-preismarke"
              fill={t.price}
            />
          </g>
        ))}
      </g>

      {/* Stunden: ein Strich je Stunde, alle drei Stunden eine Zahl. */}
      <g className="vp-uhr-stunden" aria-hidden="true">
        {modell.stunden.map((s) => (
          <g key={s.minute}>
            <path d={s.d} className={s.gross ? 'is-gross' : ''} />
            {s.text && (
              <text x={s.x} y={s.y + 4.5} textAnchor="middle" className={s.gross ? 'is-gross' : ''}>
                {s.text}
              </text>
            )}
          </g>
        ))}
      </g>

      {/* Tätigkeit: der breite Ring, immer mit Symbol ab 45 Minuten. */}
      <g className={`vp-uhr-ebene${ebene('taetigkeit')}`}>
        {modell.phasen.map((p, k) => {
          const ruhe = p.role === 'warten' || p.role === 'reserve_halten';
          return (
            <path
              key={k}
              d={p.d}
              fill={roleColor(p.role, t)}
              fillOpacity={p.vorbei ? 0.45 : 1}
              stroke={ruhe ? t.axisLine : 'none'}
              strokeWidth={ruhe ? 0.8 : 0}
            />
          );
        })}
        {modell.symbole.map((s) => {
          const ruhe = s.role === 'warten' || s.role === 'reserve_halten' || s.role === 'abregeln';
          const vorbei = tag.phasen.find((q) => q.phaseIndex === s.phaseIndex)?.vorbei ?? false;
          return (
            <Icon
              key={s.phaseIndex}
              name={ROLLEN_SYMBOL[s.role]}
              size={15}
              strokeWidth={2.2}
              x={s.x - 7.5}
              y={s.y - 7.5}
              stroke={ruhe ? t.ink : '#FFFFFF'}
              opacity={vorbei ? 0.6 : 1}
            />
          );
        })}
      </g>

      {/* Die Stelle einer angetippten Antwort. */}
      {markierung && markierung.von != null && markierung.bis != null && (
        <path
          d={uhrAntwortRahmen(markierung.von, markierung.bis)}
          className="vp-uhr-markierung"
          stroke={t.plan}
        />
      )}
      {markPunkt && (
        <circle cx={markPunkt.x} cy={markPunkt.y} r={7} className="vp-uhr-markpunkt" stroke={t.plan} />
      )}

      {/* Jetzt: das Dreieck am Außenrand. */}
      {modell.jetzt && <path d={modell.jetzt} fill={t.ink} />}
    </>
  );
});

/** „19,3 ct" — eine Nachkommastelle, geschütztes Leerzeichen. */
function ct(v: number): string {
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct`;
}

/** Text mit hellem Hof, damit er über Strahlen und Flächen lesbar bleibt. */
function HaloText({
  x,
  y,
  text,
  className = 'vp-uhr-halo',
  fill,
}: {
  x: number;
  y: number;
  text: string;
  className?: string;
  fill?: string;
}) {
  return (
    <text x={x} y={y} textAnchor="middle" className={className} fill={fill}>
      {text}
    </text>
  );
}

function PlaySymbol() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />
    </svg>
  );
}

function PauseSymbol() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />
    </svg>
  );
}
