/**
 * Der BILDFAHRPLAN (Konzept „Tagesuhr und Bildfahrplan", E10: ab 900 px
 * Inhaltsbreite statt der Uhr). Die Zeit läuft nach rechts; von oben nach
 * unten stehen die Ursachen über der Wirkung: Strompreis, Sonne und
 * Verbrauch, der Ladestand als Fahrlinie zwischen „leer" und „voll", darunter
 * die Tätigkeit mit Symbol und Wort. Wer eine Spalte von oben nach unten
 * liest, liest das Warum.
 *
 * Render-only: Formen aus `fahrplanBildfahrplan.ts`, Wörter und Werte aus
 * `fahrplanTagesbild.ts`, Farben aus `chartTheme()`/`roleColor` (dieselbe
 * Farbsprache wie die Uhr). Mit der Maus zeigt eine LUPE die Viertelstunde
 * unter dem Zeiger (geplanter Energiefluss, Preise, Ladestand); ein Klick
 * wählt sie für Moment-Zeile, Antworten und Waage. Tastatur wie an der Uhr.
 */

import { useMemo, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import type { AntwortZiel } from '../fahrplanAntworten';
import { BILD_LINKS, bildGeometrie, bildModell } from '../fahrplanBildfahrplan';
import { phaseVon, uhrzeit, viertelBei, type TagModell } from '../fahrplanTag';
import {
  FLUSS_WORT,
  ROLLEN_SYMBOL,
  ladestandText,
  lupe,
  type TagesbildEbene,
} from '../fahrplanTagesbild';
import type { SlotRole } from '../fahrplanWhy';
import { fmtNum } from '../format';
import { ProvBadge } from './HistorieWelt';
import { roleColor } from './FahrplanWhy';

/** Rollen, deren Band dunkel genug für weiße Schrift ist. */
const DUNKEL: ReadonlySet<SlotRole> = new Set(['pv_speichern', 'eigenverbrauch', 'verkaufen', 'spitze_kappen']);
const RUHE: ReadonlySet<SlotRole> = new Set(['warten', 'reserve_halten']);

export interface FahrplanBildfahrplanProps {
  tag: TagModell;
  /** Die gemessene Inhaltsbreite (px) — das Bild zeichnet 1 : 1, Schrift bleibt Schrift. */
  breite: number;
  auswahl: number;
  istJetzt: boolean;
  markierung: AntwortZiel | null;
  fokus: TagesbildEbene | null;
  onWahl: (i: number) => void;
  onJetzt: () => void;
}

export function FahrplanBildfahrplan({
  tag,
  breite,
  auswahl,
  istJetzt,
  markierung,
  fokus,
  onWahl,
  onJetzt,
}: FahrplanBildfahrplanProps) {
  const t = chartTheme();
  const g = useMemo(() => bildGeometrie(breite), [breite]);
  const m = useMemo(() => bildModell(tag, g), [tag, g]);
  const [schwebt, setSchwebt] = useState<number | null>(null);

  /** Die Viertelstunde unter einem Zeiger- oder Klick-Ereignis; -1 = keine. */
  const indexBei = (ev: { clientX: number; currentTarget: SVGSVGElement }) => {
    const b = ev.currentTarget.getBoundingClientRect();
    const x = b.width > 0 ? ((ev.clientX - b.left) * g.breite) / b.width : 0;
    const minute = g.minuteBei(x);
    return minute == null ? -1 : viertelBei(tag, minute);
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
    const schritt: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 4, PageDown: -4 };
    let i: number;
    if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = n - 1;
    else if (schritt[ev.key] != null) i = Math.max(0, Math.min(n - 1, auswahl + schritt[ev.key]));
    else return;
    ev.preventDefault();
    if (i !== auswahl) onWahl(i);
  };

  const leise = (e: TagesbildEbene) => (fokus != null && fokus !== e ? ' is-leise' : '');
  const oben = g.preis[0];
  const unten = g.taetigkeit[1];
  const v = tag.viertel[auswahl];
  const ph = phaseVon(tag, auswahl);
  const soc = tag.slots[auswahl]?.socPct;
  const wertText = v
    ? `${istJetzt ? 'Jetzt' : `${uhrzeit(v.von)} Uhr`}${ph ? `, ${ph.label}` : ''}${
        soc != null && Number.isFinite(Number(soc)) ? `, ${ladestandText(Number(soc), v.vorbei)}` : ''
      }`
    : undefined;

  // Die Stelle einer Antwort auf der Ladestandslinie.
  const markY = (() => {
    if (!markierung || markierung.punkt == null) return null;
    const iPunkt = tag.viertel.findIndex((q) => q.bis >= markierung.punkt! - 0.01);
    const s = iPunkt >= 0 ? tag.slots[iPunkt]?.socPct : null;
    return s == null || !Number.isFinite(Number(s)) ? null : g.y(Number(s));
  })();

  const lupeI = schwebt;
  const lupeView = lupeI == null ? null : lupe(tag, lupeI);
  const lupeX = lupeI == null ? 0 : g.x(tag.viertel[lupeI].bis);
  const lupeLinks = lupeX + 16 + 300 > g.breite ? Math.max(0, g.x(tag.viertel[lupeI!].von) - 16 - 300) : lupeX + 16;

  return (
    <div className="vp-bf" onPointerLeave={() => setSchwebt(null)}>
      <svg
        className="vp-bf-svg"
        viewBox={`0 0 ${g.breite} ${g.hoehe}`}
        width={g.breite}
        height={g.hoehe}
        role="slider"
        tabIndex={0}
        aria-label="Bildfahrplan des Tages: eine Viertelstunde wählen"
        aria-roledescription="Bildfahrplan"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, tag.slots.length - 1)}
        aria-valuenow={auswahl}
        aria-valuetext={wertText}
        onPointerMove={(ev) => {
          if (ev.pointerType !== 'mouse') return;
          const i = indexBei(ev);
          setSchwebt(i >= 0 ? i : null);
        }}
        onClick={(ev) => {
          const i = indexBei(ev);
          if (i >= 0) onWahl(i);
        }}
        onKeyDown={taste}
      >
        {/* Die Spuren-Namen links. */}
        <g className="vp-bf-namen" aria-hidden="true">
          <text x={0} y={(g.preis[0] + g.preis[1]) / 2 + 4}>
            {tag.preis?.art === 'boerse' ? 'Börsenpreis' : 'Strompreis'}
          </text>
          <text x={0} y={(g.sonne[0] + g.sonne[1]) / 2 - 2}>Sonne</text>
          <text x={0} y={(g.sonne[0] + g.sonne[1]) / 2 + 13} className="is-klein">
            Verbrauch
          </text>
          <text x={0} y={(g.ladestand[0] + g.ladestand[1]) / 2 + 4}>Ladestand</text>
          <text x={0} y={(g.taetigkeit[0] + g.taetigkeit[1]) / 2 + 4}>Tätigkeit</text>
          <text x={BILD_LINKS - 8} y={g.y(100) + 4} textAnchor="end" className="is-klein">
            voll
          </text>
          <text x={BILD_LINKS - 8} y={g.y(0) + 4} textAnchor="end" className="is-klein">
            leer
          </text>
        </g>

        {/* Strompreis: ein Balken je Viertelstunde, hell günstig, dunkel teuer. */}
        <g className={`vp-bf-spur${leise('preis')}`}>
          <rect x={g.x(0)} y={g.preis[0]} width={g.x(1440) - g.x(0)} height={g.preis[1] - g.preis[0]} className="vp-bf-grund" />
          {m.preis.map((b) => (
            <rect key={b.i} x={b.x} y={b.y} width={b.w} height={Math.max(0.5, b.h)} fill={t.price} fillOpacity={0.18 + 0.82 * (b.stufe ?? 0.5)} />
          ))}
          {m.preisNull != null && (
            <line x1={g.x(0)} x2={g.x(1440)} y1={m.preisNull} y2={m.preisNull} stroke={t.ink} strokeWidth={1} strokeDasharray="3 3" />
          )}
          {m.preisMarken.map((p) => (
            <text key={p.art} x={p.x} y={p.y} textAnchor="middle" className="vp-bf-marke" fill={t.price}>
              {fmtNum(p.ct, 'ct', 1)}
            </text>
          ))}
        </g>

        {/* Sonne (Fläche) und Verbrauch (Linie): kräftig gemessen, hell erwartet. */}
        <g className={`vp-bf-spur${leise('sonne')}`}>
          <rect x={g.x(0)} y={g.sonne[0]} width={g.x(1440) - g.x(0)} height={g.sonne[1] - g.sonne[0]} className="vp-bf-grund" />
          {m.sonnePrognose && <path d={m.sonnePrognose} fill={t.pv} fillOpacity={0.3} />}
          {m.sonneGemessen && <path d={m.sonneGemessen} fill={t.pv} fillOpacity={0.85} />}
          {m.verbrauchPrognose && (
            <path d={m.verbrauchPrognose} fill="none" stroke={t.loadLine} strokeWidth={1.4} strokeDasharray="4 3" />
          )}
          {m.verbrauchGemessen && <path d={m.verbrauchGemessen} fill="none" stroke={t.loadLine} strokeWidth={1.8} />}
          {m.sonneSpitze && (
            <text x={m.sonneSpitze.x} y={m.sonneSpitze.y} textAnchor="middle" className="vp-bf-marke" fill={t.pvLine}>
              {fmtNum(m.sonneSpitze.kw, 'kW')} {m.sonneSpitze.gemessen ? 'gemessen' : 'erwartet'}
            </text>
          )}
        </g>

        {/* Ladestand: die Fahrlinie zwischen leer und voll, gefärbt nach Tätigkeit. */}
        <g className={`vp-bf-spur${leise('ladestand')}`}>
          <line x1={g.x(0)} x2={g.x(1440)} y1={g.y(100)} y2={g.y(100)} className="vp-bf-grenze" />
          <line x1={g.x(0)} x2={g.x(1440)} y1={g.y(0)} y2={g.y(0)} className="vp-bf-grenze" />
          {m.ladestandFlaeche && <path d={m.ladestandFlaeche} fill={t.soc} fillOpacity={0.1} />}
          {m.ladestandLinie.map((s, k) => (
            <path
              key={k}
              d={s.d}
              fill="none"
              stroke={RUHE.has(s.role) ? t.neutral : roleColor(s.role, t)}
              strokeOpacity={s.vorbei ? 0.5 : 1}
              strokeWidth={3.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {m.ladestandMarken.map((mk) => (
            <g key={mk.art}>
              {mk.art !== 'ende' && <circle cx={mk.px} cy={mk.py} r={3.4} fill={t.surface} stroke={t.ink} strokeWidth={1.6} />}
              <text x={mk.x} y={mk.y} textAnchor={mk.anker} className="vp-bf-marke" fill={t.ink}>
                {mk.text}
              </text>
            </g>
          ))}
        </g>

        {/* Tätigkeit: je Phase ein Band mit Symbol und Wort (wenn es passt). */}
        <g className={`vp-bf-spur${leise('taetigkeit')}`}>
          {m.baender.map((b) => {
            const hell = !DUNKEL.has(b.role);
            const tinte = hell ? t.ink : '#FFFFFF';
            const mitte = (g.taetigkeit[0] + g.taetigkeit[1]) / 2;
            return (
              <g key={b.phaseIndex} opacity={b.vorbei ? 0.55 : 1}>
                <rect
                  x={b.x}
                  y={g.taetigkeit[0]}
                  width={b.w}
                  height={g.taetigkeit[1] - g.taetigkeit[0]}
                  rx={2}
                  fill={roleColor(b.role, t)}
                  stroke={RUHE.has(b.role) ? t.axisLine : 'none'}
                />
                {b.symbol && (
                  <Icon
                    name={ROLLEN_SYMBOL[b.role]}
                    size={14}
                    strokeWidth={2.2}
                    x={b.text ? b.x + 7 : b.x + b.w / 2 - 7}
                    y={mitte - 7}
                    stroke={tinte}
                  />
                )}
                {b.text && (
                  <text x={b.x + 26} y={mitte + 4} className="vp-bf-band" fill={tinte}>
                    {b.text}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Die Zeitachse. */}
        <g className="vp-bf-achse" aria-hidden="true">
          {m.achse.map((a) => (
            <g key={a.x}>
              <line x1={a.x} x2={a.x} y1={unten + 2} y2={unten + (a.gross ? 7 : 4)} />
              {a.text && (
                <text x={a.x} y={g.achseY} textAnchor="middle">
                  {a.text.slice(0, 2)}
                </text>
              )}
            </g>
          ))}
        </g>

        {/* Die angetippte Antwort: ihr Zeitraum über alle Spuren, ihr Punkt auf der Linie. */}
        {markierung && markierung.von != null && markierung.bis != null && (
          <rect
            x={g.x(markierung.von)}
            y={oben - 3}
            width={Math.max(2, g.x(markierung.bis) - g.x(markierung.von))}
            height={unten - oben + 6}
            className="vp-bf-markierung"
            stroke={t.plan}
          />
        )}
        {markierung && markierung.punkt != null && markY != null && (
          <circle cx={g.x(markierung.punkt)} cy={markY} r={6} className="vp-uhr-markpunkt" stroke={t.plan} />
        )}

        {/* Die gewählte Viertelstunde - bei „jetzt" markiert sie die Jetzt-Linie. */}
        {v && !istJetzt && (
          <rect
            x={g.x(v.von)}
            y={oben - 2}
            width={Math.max(2, g.x(v.bis) - g.x(v.von))}
            height={unten - oben + 4}
            className="vp-bf-wahl"
            stroke={t.ink}
          />
        )}
        {lupeI != null && lupeI !== auswahl && (
          <rect
            x={g.x(tag.viertel[lupeI].von)}
            y={oben}
            width={Math.max(2, g.x(tag.viertel[lupeI].bis) - g.x(tag.viertel[lupeI].von))}
            height={unten - oben}
            className="vp-bf-schwebt"
          />
        )}

        {/* Jetzt. */}
        {m.jetztX != null && (
          <g className="vp-bf-jetzt">
            {/* Bis zur Ladestandsspur - das Wort im Tätigkeitsband bleibt lesbar. */}
            <line x1={m.jetztX} x2={m.jetztX} y1={oben - 6} y2={g.ladestand[1] + 4} stroke={t.ink} strokeWidth={1.6} />
            <rect x={m.jetztX - 22} y={2} width={44} height={16} rx={8} fill={t.ink} />
            <text x={m.jetztX} y={14} textAnchor="middle" fill={t.surface}>
              jetzt
            </text>
          </g>
        )}
      </svg>

      {lupeView && (
        <div className="vp-bf-lupe" style={{ left: lupeLinks, top: Math.max(0, g.preis[0] - 6) }} aria-hidden="true">
          <div className="vp-bf-lupe-kopf">
            <b>{lupeView.zeit}</b>
            <ProvBadge art="geplant" />
          </div>
          {lupeView.was && lupeView.role && (
            <p className="vp-bf-lupe-was">
              <i style={{ background: roleColor(lupeView.role, t) }} />
              {lupeView.art === 'vorbei' ? `War geplant: ${lupeView.was}` : lupeView.was}
            </p>
          )}
          {lupeView.fluss && lupeView.fluss.length > 0 && (
            <ul className="vp-bf-lupe-fluss">
              {lupeView.fluss.map((f) => (
                <li key={`${f.von}-${f.nach}`}>
                  {FLUSS_WORT[f.von]} → {FLUSS_WORT[f.nach]} <b>{fmtNum(f.kw, 'kW')}</b>
                </li>
              ))}
            </ul>
          )}
          <dl className="vp-bf-lupe-zeilen">
            {lupeView.zeilen.map((z) => (
              <span key={z.label} style={{ display: 'contents' }}>
                <dt>{z.label}</dt>
                <dd>{z.wert}</dd>
              </span>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
