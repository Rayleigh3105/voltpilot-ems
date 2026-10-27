/**
 * Das TAGESBAND - das Tagesbild der Fahrplan-Seite am Rechner (Überblick
 * 20.10.2026). Oben steht, was der Speicher tut (Phasen als beschriftete
 * Blöcke), darunter der Ladestand (links gemessen, rechts geplant), darunter
 * die Ursachen Sonne und Strompreis. Wer eine Spalte von oben nach unten
 * liest, liest: was - mit welchem Ergebnis - warum.
 *
 * Render-only: Formen aus `fahrplanTagesband.ts`, Wörter und Werte aus
 * `fahrplanTagesbild.ts`, Farben aus `chartTheme()`/`roleColor` (dieselbe
 * Farbsprache wie die Uhr am Telefon). Mit der Maus zeigt eine LUPE die
 * Viertelstunde unter dem Zeiger; ein Klick auf einen Block öffnet das Warum
 * der Phase, ein Klick ins Bild wählt die Viertelstunde für die Jetzt-Zeile.
 * Tastatur: Pfeile je Viertelstunde, Bild auf/ab je Stunde, Escape = jetzt.
 */

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import type { AntwortZiel } from '../fahrplanAntworten';
import { phaseVon, uhrzeit, viertelBei, type TagModell } from '../fahrplanTag';
import { BAND_LINKS, bandGeometrie, bandModell } from '../fahrplanTagesband';
import { FLUSS_WORT, ROLLEN_SYMBOL, lupe } from '../fahrplanTagesbild';
import type { SlotRole } from '../fahrplanWhy';
import { fmtNum } from '../format';
import { haptik } from '../haptik';
import { ProvBadge } from './HistorieWelt';
import { roleColor } from './FahrplanWhy';

/** Rollen, deren Block dunkel genug für weiße Schrift ist. */
const DUNKEL: ReadonlySet<SlotRole> = new Set(['pv_speichern', 'eigenverbrauch', 'verkaufen', 'spitze_kappen', 'guenstig_laden']);
const RUHE: ReadonlySet<SlotRole> = new Set(['warten', 'reserve_halten']);

export interface FahrplanTagesbandProps {
  tag: TagModell;
  /** Der gemessene Ladestand je Viertelstunde (`fahrplanIst.istLadestand`). */
  ist: readonly (number | null)[];
  /** Die gemessene Inhaltsbreite (px) - das Bild zeichnet 1 : 1. */
  breite: number;
  auswahl: number;
  istJetzt: boolean;
  /** Hat jemand eine Viertelstunde gewählt? Nur dann wird sie umrahmt. */
  gewaehlt: boolean;
  markierung: AntwortZiel | null;
  onWahl: (i: number) => void;
  onJetzt: () => void;
  /** Ein Klick auf einen Block: das Warum dieser Phase (Index in `tag.phasenRoh`). */
  onPhase: (phaseIndex: number) => void;
  /** Die Sonnen-Erzählung (§4.6): die Lupe zeigt den Fluss statt der drei Preiszeilen. */
  sonne?: boolean;
}

export function FahrplanTagesband({
  tag,
  ist,
  breite,
  auswahl,
  istJetzt,
  gewaehlt,
  markierung,
  onWahl,
  onJetzt,
  onPhase,
  sonne = false,
}: FahrplanTagesbandProps) {
  const t = chartTheme();
  const mitPreis = tag.preis != null;
  const g = useMemo(() => bandGeometrie(breite, mitPreis), [breite, mitPreis]);
  const m = useMemo(() => bandModell(tag, g, ist), [tag, g, ist]);
  const [schwebt, setSchwebt] = useState<number | null>(null);
  const letzterZeiger = useRef<string>('mouse');

  const punktBei = (ev: { clientX: number; clientY: number; currentTarget: SVGSVGElement }) => {
    const b = ev.currentTarget.getBoundingClientRect();
    const k = b.width > 0 ? g.breite / b.width : 1;
    return { x: (ev.clientX - b.left) * k, y: (ev.clientY - b.top) * k };
  };
  const indexBei = (x: number) => {
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
    if (ev.key === 'Enter' || ev.key === ' ') {
      const ph = phaseVon(tag, auswahl);
      if (ph) {
        ev.preventDefault();
        onPhase(ph.phaseIndex);
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

  const oben = g.ladestand[0];
  const unten = (g.preis ?? g.sonne)[1];
  const v = tag.viertel[auswahl];
  const ph = phaseVon(tag, auswahl);
  const wertText = v
    ? `${istJetzt ? 'Jetzt' : `${uhrzeit(v.von)} Uhr`}${ph ? `, ${ph.label}` : ''}`
    : undefined;

  const lupeI = schwebt;
  const lupeView = lupeI == null ? null : lupe(tag, lupeI, sonne);
  const lupeIst = lupeI == null ? null : (ist[lupeI] ?? null);
  const lupeX = lupeI == null ? 0 : g.x(tag.viertel[lupeI].bis);
  const LUPE_B = 280;
  const lupeLinks = lupeX + 16 + LUPE_B > g.breite ? Math.max(0, g.x(tag.viertel[lupeI!].von) - 16 - LUPE_B) : lupeX + 16;

  const markY = (() => {
    if (!markierung || markierung.punkt == null) return null;
    const iPunkt = tag.viertel.findIndex((q) => q.bis >= markierung.punkt! - 0.01);
    const s = iPunkt >= 0 ? tag.slots[iPunkt]?.socPct : null;
    return s == null || !Number.isFinite(Number(s)) ? null : g.y(Number(s));
  })();

  const kopfMitte = (g.kopf[0] + g.kopf[1]) / 2;
  const hatIst = m.istLinie != null;
  const breiteFlaeche = g.x(1440) - g.x(0);

  return (
    <div className="vp-tband" onPointerLeave={() => setSchwebt(null)}>
      <svg
        className="vp-tband-svg"
        viewBox={`0 0 ${g.breite} ${g.hoehe}`}
        width={g.breite}
        height={g.hoehe}
        role="slider"
        tabIndex={0}
        aria-label="Tagesband: eine Viertelstunde wählen, Eingabe öffnet das Warum der Phase"
        aria-roledescription="Tagesband"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, tag.slots.length - 1)}
        aria-valuenow={auswahl}
        aria-valuetext={wertText}
        onPointerDown={(ev) => {
          letzterZeiger.current = ev.pointerType;
        }}
        onPointerMove={(ev) => {
          if (ev.pointerType !== 'mouse') return;
          const p = punktBei(ev);
          const i = p.y > g.kopf[1] ? indexBei(p.x) : -1;
          setSchwebt(i >= 0 ? i : null);
        }}
        onClick={(ev) => {
          const p = punktBei(ev);
          const i = indexBei(p.x);
          if (i < 0) return;
          if (letzterZeiger.current !== 'mouse') haptik('tick');
          if (p.y <= g.kopf[1] + 2) {
            const phase = phaseVon(tag, i);
            if (phase) onPhase(phase.phaseIndex);
            return;
          }
          onWahl(i);
        }}
        onKeyDown={taste}
      >
        {/* Die Spuren-Namen links. */}
        <g className="vp-tband-namen" aria-hidden="true">
          <text x={0} y={kopfMitte + 4}>Speicher</text>
          <text x={0} y={(g.ladestand[0] + g.ladestand[1]) / 2 - 3}>Ladestand</text>
          <text x={0} y={(g.ladestand[0] + g.ladestand[1]) / 2 + 13} className="is-klein">
            in Prozent
          </text>
          <text x={BAND_LINKS - 8} y={g.y(100) + 4} textAnchor="end" className="is-klein">
            100
          </text>
          <text x={BAND_LINKS - 8} y={g.y(0) + 4} textAnchor="end" className="is-klein">
            0
          </text>
          <text x={0} y={(g.sonne[0] + g.sonne[1]) / 2 + 4}>Sonne</text>
          {g.preis && (
            <text x={0} y={(g.preis[0] + g.preis[1]) / 2 + 4}>
              {tag.preis?.art === 'boerse' ? 'Börsenpreis' : 'Strompreis'}
            </text>
          )}
        </g>

        {/* Vergangenes liegt auf grauem Grund - jetzt teilt den Tag. */}
        {m.jetztX != null && (
          <rect
            x={g.x(0)}
            y={oben - 6}
            width={Math.max(0, m.jetztX - g.x(0))}
            height={g.sonne[1] - oben + 6}
            className="vp-tband-vorbei"
          />
        )}

        {/* 1. Was der Speicher tut: Blöcke mit Wort, Zeit und Symbol. */}
        <g className="vp-tband-kopf">
          {m.bloecke.map((b) => {
            const farbe = roleColor(b.role, t);
            const vorbei = b.vorbei && tag.jetzt != null;
            // Vorbei: derselbe Farbton als Rand und helle Füllung - nicht
            // durchscheinend, sonst wird aus Beere Rosa und aus einer Tätigkeit
            // scheinbar eine andere.
            const voll = !vorbei && !RUHE.has(b.role);
            const tinte = voll && DUNKEL.has(b.role) ? '#FFFFFF' : t.ink;
            const mitText = b.text != null;
            return (
              <g key={b.phaseIndex} className={`vp-tband-block${b.laeuft ? ' is-jetzt' : ''}${vorbei ? ' is-vorbei' : ''}`}>
                <title>{`${b.text ?? ''} ${b.zeit ?? ''}`.trim() || undefined}</title>
                <rect
                  x={b.x}
                  y={g.kopf[0]}
                  width={b.w}
                  height={g.kopf[1] - g.kopf[0]}
                  rx={7}
                  fill={voll ? farbe : RUHE.has(b.role) && !vorbei ? t.surface : farbe}
                  fillOpacity={voll ? 1 : RUHE.has(b.role) && !vorbei ? 1 : 0.14}
                  stroke={voll ? 'none' : RUHE.has(b.role) ? t.axisLine : farbe}
                  strokeWidth={voll ? 0 : 1.3}
                />
                {b.symbol && (
                  <Icon
                    name={vorbei ? 'check' : ROLLEN_SYMBOL[b.role]}
                    size={15}
                    strokeWidth={2.2}
                    x={mitText ? b.x + 9 : b.x + b.w / 2 - 7.5}
                    y={mitText && b.zeit ? g.kopf[0] + 9 : kopfMitte - 7.5}
                    stroke={vorbei ? farbe : tinte}
                  />
                )}
                {b.text && (
                  <text x={b.x + 30} y={b.zeit ? g.kopf[0] + 21 : kopfMitte + 4.5} className="vp-tband-wort" fill={tinte}>
                    {b.text}
                  </text>
                )}
                {b.zeit && (
                  <text x={b.x + 30} y={g.kopf[0] + 38} className="vp-tband-zeit" fill={tinte} fillOpacity={0.82}>
                    {b.zeit}
                  </text>
                )}
                {b.ueber && (
                  <text x={b.ueber.x} y={g.kopf[0] - 6} textAnchor="middle" className="vp-tband-ueber" fill={t.ink}>
                    {b.ueber.text}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Feine Grenzen der Phasen durch das ganze Bild. */}
        <g className="vp-tband-grenzen" aria-hidden="true">
          {m.grenzen.map((x) => (
            <line key={x} x1={x} x2={x} y1={oben - 6} y2={unten} />
          ))}
        </g>

        {/* 2. Ladestand: links gemessen, rechts geplant. */}
        <g className="vp-tband-ladestand">
          <line x1={g.x(0)} x2={g.x(1440)} y1={g.y(100)} y2={g.y(100)} className="vp-tband-raster" />
          <line x1={g.x(0)} x2={g.x(1440)} y1={g.y(50)} y2={g.y(50)} className="vp-tband-raster is-mitte" />
          <line x1={g.x(0)} x2={g.x(1440)} y1={g.y(0)} y2={g.y(0)} className="vp-tband-raster" />
          {m.planFlaeche && <path d={m.planFlaeche} fill={t.soc} fillOpacity={0.08} />}
          {m.istFlaeche && <path d={m.istFlaeche} fill={t.soc} fillOpacity={0.16} />}
          {m.planVorbeiLinie && (
            <path d={m.planVorbeiLinie} fill="none" stroke={t.soc} strokeOpacity={0.45} strokeWidth={2} strokeDasharray="2 4" strokeLinecap="round" />
          )}
          {m.planLinie && (
            <path d={m.planLinie} fill="none" stroke={t.soc} strokeWidth={2.4} strokeDasharray="7 5" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {m.istLinie && (
            <path d={m.istLinie} fill="none" stroke={t.soc} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {m.marken.map((mk) => (
            <text key={mk.art} x={mk.x} y={mk.y} textAnchor={mk.anker} className="vp-tband-marke" fill={t.ink}>
              {mk.text}
            </text>
          ))}
        </g>

        {/* 3a. Sonne: kräftig gemessen, hell erwartet. */}
        <g className="vp-tband-sonne">
          <rect x={g.x(0)} y={g.sonne[0]} width={breiteFlaeche} height={g.sonne[1] - g.sonne[0]} className="vp-tband-grund" />
          {m.sonneErwartet && <path d={m.sonneErwartet} fill={t.pv} fillOpacity={0.3} />}
          {m.sonneGemessen && <path d={m.sonneGemessen} fill={t.pv} fillOpacity={0.85} />}
          {m.sonneSpitze && (() => {
            // N3: nur eine GEMESSENE Spitze darf an die Jetzt-Linie heranrücken -
            // eine geplante bleibt auf ihrer Seite, sonst läse sie sich als Messung.
            const anJetzt = m.sonneSpitze.gemessen && m.jetztX != null && Math.abs(m.sonneSpitze.x - m.jetztX) < 40;
            return (
              <text
                x={anJetzt ? m.jetztX! - 6 : m.sonneSpitze.x}
                y={Math.max(g.sonne[0] + 11, m.sonneSpitze.y)}
                textAnchor={anJetzt ? 'end' : 'middle'}
                className="vp-tband-marke"
                fill={t.pvLine}
              >
                {fmtNum(m.sonneSpitze.kw, 'kW')}
              </text>
            );
          })()}
        </g>

        {/* 3b. Strompreis: hell günstig, dunkel teuer. */}
        {g.preis && (
          <g className="vp-tband-preis">
            {m.preis.map((p, k) => (
              <rect key={k} x={p.x} y={g.preis![0]} width={p.w + 0.3} height={g.preis![1] - g.preis![0]} fill={t.price} fillOpacity={0.12 + 0.78 * p.stufe} />
            ))}
            {m.preisMarken.map((p) => (
              <text key={p.art} x={p.x} y={p.y} textAnchor="middle" className="vp-tband-preismarke" fill={t.price}>
                {p.art === 'min' ? 'günstig ' : 'teuer '}
                {fmtNum(p.ct, 'ct', 1)}
              </text>
            ))}
          </g>
        )}

        {/* Die Zeitachse. */}
        <g className="vp-tband-achse" aria-hidden="true">
          {m.achse.map((a) => (
            <g key={a.x}>
              <line x1={a.x} x2={a.x} y1={g.achseY - 14} y2={g.achseY - 14 + (a.gross ? 5 : 3)} />
              {a.text && (
                <text x={a.x} y={g.achseY + 2} textAnchor="middle">
                  {a.text.slice(0, 2)}
                </text>
              )}
            </g>
          ))}
        </g>

        {/* Die angetippte Antwort: ihr Zeitraum, ihr Punkt auf der Linie. */}
        {markierung && markierung.von != null && markierung.bis != null && (
          <rect
            x={g.x(markierung.von)}
            y={g.kopf[0] - 3}
            width={Math.max(2, g.x(markierung.bis) - g.x(markierung.von))}
            height={unten - g.kopf[0] + 6}
            className="vp-tband-markierung"
            stroke={t.plan}
          />
        )}
        {markierung && markierung.punkt != null && markY != null && (
          <circle cx={g.x(markierung.punkt)} cy={markY} r={6} className="vp-tband-markpunkt" stroke={t.plan} />
        )}

        {/* Die gewählte Viertelstunde. */}
        {v && gewaehlt && !istJetzt && (
          <rect
            x={g.x(v.von)}
            y={oben - 4}
            width={Math.max(2, g.x(v.bis) - g.x(v.von))}
            height={unten - oben + 4}
            className="vp-tband-wahl"
            stroke={t.ink}
          />
        )}
        {lupeI != null && lupeI !== auswahl && (
          <line x1={g.x(tag.viertel[lupeI].bis)} x2={g.x(tag.viertel[lupeI].bis)} y1={oben - 4} y2={unten} className="vp-tband-schwebt" />
        )}

        {/* Jetzt: die Linie teilt gemessen von geplant. */}
        {m.jetztX != null && (
          <g className="vp-tband-jetzt">
            <line x1={m.jetztX} x2={m.jetztX} y1={oben - 6} y2={unten + 2} stroke={t.ink} strokeWidth={1.6} />
            <text x={m.jetztX - 8} y={g.y(0) - 7} textAnchor="end" className="vp-tband-seite">
              {hatIst ? '← gemessen' : '← war geplant'}
            </text>
            <text x={m.jetztX + 8} y={g.y(0) - 7} textAnchor="start" className="vp-tband-seite">
              geplant →
            </text>
            {m.jetztPunkt && (
              <>
                <circle cx={m.jetztPunkt.x} cy={m.jetztPunkt.y} r={5.5} fill={t.surface} stroke={t.soc} strokeWidth={3} />
                <text
                  x={m.jetztPunkt.x + 10}
                  y={m.jetztPunkt.y + (m.jetztPunkt.y < oben + 30 ? 18 : -10)}
                  className="vp-tband-jetztwert"
                  fill={t.ink}
                >
                  {`${Math.round(m.jetztPunkt.pct).toLocaleString('de-DE')} %`}
                </text>
              </>
            )}
          </g>
        )}
      </svg>

      {lupeView && lupeI != null && (
        <div className="vp-tband-lupe" style={{ left: lupeLinks, top: g.ladestand[0] }} aria-hidden="true">
          <div className="vp-tband-lupe-kopf">
            <b>{lupeView.zeit}</b>
            <ProvBadge art={lupeIst != null ? 'gemessen' : 'geplant'} />
          </div>
          {lupeView.was && lupeView.role && (
            <p className="vp-tband-lupe-was">
              <i style={{ background: roleColor(lupeView.role, t) }} />
              {lupeView.art === 'vorbei' ? `War geplant: ${lupeView.was}` : lupeView.was}
            </p>
          )}
          {lupeView.fluss && lupeView.fluss.length > 0 && lupeView.art !== 'vorbei' && (
            <ul className="vp-tband-lupe-fluss">
              {lupeView.fluss.map((f) => (
                <li key={`${f.von}-${f.nach}`}>
                  {FLUSS_WORT[f.von]} → {FLUSS_WORT[f.nach]} <b>{fmtNum(f.kw, 'kW')}</b>
                </li>
              ))}
            </ul>
          )}
          <dl className="vp-tband-lupe-zeilen">
            {lupeIst != null && (
              <span style={{ display: 'contents' }}>
                <dt>Ladestand gemessen</dt>
                <dd>{`${Math.round(lupeIst).toLocaleString('de-DE')} %`}</dd>
              </span>
            )}
            {lupeView.zeilen
              .filter((z) => !(lupeIst != null && z.label === 'Ladestand danach'))
              .map((z) => (
                <span key={z.label} style={{ display: 'contents' }}>
                  <dt>{z.label === 'Ladestand danach' ? 'Ladestand geplant' : z.label}</dt>
                  <dd>{z.wert}</dd>
                </span>
              ))}
          </dl>
        </div>
      )}
    </div>
  );
}
