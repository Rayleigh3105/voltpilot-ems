import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { chartTheme } from '../chartTheme';
import { useContainerWidth } from '../useContainerWidth';
import type { Betrieb } from '../leitungsplan';
import { uhrzeit, type Tag } from '../tagesleiste';

/**
 * **Die Tagesleiste** unter dem Energiefluss (Konzept
 * `docs/konzepte/cockpit-tagesfilm`): ein Fingerzug durch den heutigen Tag.
 * Links von „Jetzt“ stehen Messwerte, rechts der Plan (grau hinterlegt,
 * gestrichelt). Was die Leiste zeigt, folgt dem Betriebsmodell:
 *
 * - Eigenverbrauch: PV als Fläche, Verbrauch als Linie.
 * - Marktoptimierung: Börsenpreis je Viertelstunde (grün Laden, rot Verkaufen
 *   laut Plan), darunter Speicher laden und abgeben.
 * - Lastspitzenkappung: Netzbezug, Ziel als Linie.
 *
 * Bedienung: Ziehen oder Tippen, Pfeiltasten (Umschalt = Stunde), Pos1/Ende.
 */
export function Tagesleiste({
  tag,
  betrieb,
  q,
  heute,
  zielKw = null,
  onQ,
}: {
  tag: Tag;
  betrieb: Betrieb;
  q: number;
  /** „Heute · kWh“: rechts von jetzt gibt es nichts zu wählen. */
  heute: boolean;
  zielKw?: number | null;
  onQ: (q: number) => void;
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const ziehen = useRef(false);
  const T = chartTheme();
  const N = tag.viertel.length;
  const w = Math.max(240, Math.round(breite || 320));
  const h = 88;
  const base = 70;
  const top = 6;
  const X = (i: number) => ((i + 0.5) * w) / N;
  const jetztX = ((tag.jetzt + 1) * w) / N;
  const ende = heute ? tag.jetzt : N - 1;
  const max = heute ? tag.jetzt : N - 1;

  const qAus = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.min(max, Math.floor(f * N));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const s = e.shiftKey ? 4 : 1;
    let n = q;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') n -= s;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') n += s;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = max;
    else if (e.key === 'PageUp') n += 8;
    else if (e.key === 'PageDown') n -= 8;
    else return;
    e.preventDefault();
    onQ(Math.min(max, Math.max(0, n)));
  };

  const linie = (werte: (number | null)[], von: number, bis: number, skala: number, farbe: string, strich = false) => {
    let d = '';
    let offen = false;
    for (let i = von; i <= bis; i++) {
      const v = werte[i];
      if (v == null) { offen = false; continue; }
      const y = top + (base - top) * (1 - Math.min(1, Math.max(0, v / skala)));
      d += `${offen ? 'L' : 'M'}${X(i).toFixed(1)},${y.toFixed(1)} `;
      offen = true;
    }
    return d ? <path d={d} fill="none" stroke={farbe} strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={strich ? '3 3' : undefined} /> : null;
  };
  const flaeche = (werte: (number | null)[], von: number, bis: number, skala: number, farbe: string, op: number) => {
    const teile: string[] = [];
    let akt: string[] = [];
    const schliessen = () => {
      if (akt.length > 1) teile.push(`M${akt[0].split(',')[0]},${base} L${akt.join(' L')} L${akt[akt.length - 1].split(',')[0]},${base} Z`);
      akt = [];
    };
    for (let i = von; i <= bis; i++) {
      const v = werte[i];
      if (v == null) { schliessen(); continue; }
      const y = top + (base - top) * (1 - Math.min(1, Math.max(0, v / skala)));
      akt.push(`${X(i).toFixed(1)},${y.toFixed(1)}`);
    }
    schliessen();
    return teile.length ? <path d={teile.join(' ')} fill={farbe} opacity={op} /> : null;
  };

  const V = tag.viertel;
  const gem = (f: (i: number) => number | null) => V.map((_, i) => (i <= tag.jetzt ? f(i) : null));
  const pl = (f: (i: number) => number | null) => V.map((_, i) => (i >= tag.jetzt ? f(i) : null));
  const skala = Math.max(0.1, tag.maxKw * 1.05);
  let spuren: JSX.Element | null = null;
  let beschriftung = 'PV und Verbrauch';

  if (betrieb === 'markt') {
    beschriftung = 'Börsenpreis';
    const preise = V.map((v, i) => (i <= tag.jetzt ? v.preisCt ?? v.planPreisCt : v.planPreisCt ?? v.preisCt));
    const pMax = Math.max(0.1, ...preise.map((p) => (p == null ? 0 : p)));
    const bw = Math.max(1, w / N - 1);
    const pH = 22;
    const mid = 52;
    const sH = 15;
    const bMax = Math.max(0.1, ...V.map((v) => Math.abs((v.gemessen ?? v.plan)?.batt ?? 0)));
    spuren = (
      <>
        {preise.map((p, i) => {
          if (p == null || i > ende) return null;
          const r = V[i].rolle;
          const farbe = r === 'guenstig_laden' ? T.guenstig : r === 'verkaufen' ? T.discharge : T.neutral;
          const hh = Math.max(1.5, (pH * Math.max(0, p)) / pMax);
          return <rect key={`p${i}`} x={X(i) - bw / 2} y={top + pH - hh} width={bw} height={hh} fill={farbe} opacity={i > tag.jetzt ? 0.45 : 0.85} />;
        })}
        <line x1={0} x2={w} y1={mid} y2={mid} stroke={T.axisLine} />
        {V.map((v, i) => {
          if (i > ende) return null;
          const b = (i <= tag.jetzt ? v.gemessen : v.plan)?.batt;
          if (b == null || Math.abs(b) < 0.05) return null;
          const hb = (sH * Math.min(1, Math.abs(b) / bMax));
          return <rect key={`b${i}`} x={X(i) - bw / 2} y={b > 0 ? mid - hb : mid} width={bw} height={hb} fill={b > 0 ? T.charge : T.battDischarge} opacity={i > tag.jetzt ? 0.45 : 0.9} />;
        })}
        <text x={2} y={base - 1} className="vp-tl-lbl">Speicher</text>
      </>
    );
  } else if (betrieb === 'spitze') {
    beschriftung = 'Netzbezug';
    const g = (i: number) => (i <= tag.jetzt ? V[i].gemessen?.grid ?? null : V[i].plan?.grid ?? null);
    const zy = zielKw != null ? top + (base - top) * (1 - Math.min(1, zielKw / skala)) : null;
    spuren = (
      <>
        {linie(gem(g), 0, tag.jetzt, skala, T.flowGridLine)}
        {!heute && linie(pl(g), tag.jetzt, N - 1, skala, T.flowGridLine, true)}
        {zy != null && (
          <>
            <line x1={0} x2={w} y1={zy} y2={zy} stroke={T.plan} strokeWidth={1.2} strokeDasharray="5 3" />
            <text x={w - 2} y={zy - 3} textAnchor="end" className="vp-tl-lbl">Ziel</text>
          </>
        )}
      </>
    );
  } else {
    const pv = (i: number) => (i <= tag.jetzt ? V[i].gemessen?.pv ?? null : V[i].plan?.pv ?? null);
    const load = (i: number) => (i <= tag.jetzt ? V[i].gemessen?.load ?? null : V[i].plan?.load ?? null);
    spuren = (
      <>
        {flaeche(gem(pv), 0, tag.jetzt, skala, T.pv, 0.3)}
        {linie(gem(pv), 0, tag.jetzt, skala, T.cPv)}
        {!heute && flaeche(pl(pv), tag.jetzt, N - 1, skala, T.pv, 0.12)}
        {!heute && linie(pl(pv), tag.jetzt, N - 1, skala, T.cPv, true)}
        {linie(gem(load), 0, tag.jetzt, skala, T.cLoad)}
        {!heute && linie(pl(load), tag.jetzt, N - 1, skala, T.cLoad, true)}
      </>
    );
  }

  const kopfX = heute ? ((q + 1) * w) / N : ((q + (q === tag.jetzt ? 0.95 : 0.5)) * w) / N;
  const text = `${uhrzeit(V[q]?.start ?? tag.beginn)} Uhr, ${heute ? 'Energie bis dahin' : q > tag.jetzt ? 'Plan und Prognose' : q === tag.jetzt ? 'jetzt' : 'gemessen'}`;

  return (
    <div
      ref={ref}
      className="vp-tl"
      role="slider"
      tabIndex={0}
      aria-label="Tageszeit"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={q}
      aria-valuetext={text}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        ziehen.current = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ältere Browser */ }
        onQ(qAus(e));
      }}
      onPointerMove={(e) => { if (ziehen.current) onQ(qAus(e)); }}
      onPointerUp={() => { ziehen.current = false; }}
      onPointerCancel={() => { ziehen.current = false; }}
    >
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {!heute && <rect x={jetztX} y={0} width={Math.max(0, w - jetztX)} height={base + 2} rx={6} className="vp-tl-plan" />}
        {spuren}
        <text x={2} y={top + 9} className="vp-tl-lbl">{beschriftung}</text>
        {[0, 6, 12, 18, 24].map((hr) => {
          const x = (hr * w) / 24;
          return (
            <g key={hr}>
              <line x1={x} x2={x} y1={base + 2} y2={base + 5} stroke={T.axisLine} />
              <text x={Math.min(w - 6, Math.max(6, x))} y={h - 2} textAnchor={hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle'} className="vp-tl-ax">
                {hr === 24 ? '24 Uhr' : hr}
              </text>
            </g>
          );
        })}
        <path d={`M${jetztX - 4},${base + 1} L${jetztX},${base + 6} L${jetztX + 4},${base + 1} Z`} className="vp-tl-jetzt" />
        {!heute && jetztX + 60 < w && <text x={w - 4} y={base - 3} textAnchor="end" className="vp-tl-lbl">Plan</text>}
      </svg>
      <span className="vp-tl-kopf" style={{ left: kopfX }} aria-hidden="true">
        <span className="vp-tl-knauf" />
      </span>
    </div>
  );
}
