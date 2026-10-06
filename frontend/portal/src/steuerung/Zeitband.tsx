/**
 * DAS ZEITBAND — ein SVG für Tagesbild, Geräte-Verlauf, Ladeplan und
 * Regel-Probelauf (Prototyp `ui-geraete.js` `zeitband`).
 *
 * Oben Bänder (Sonne, Börsenpreis, Temperatur, Ladestand, eine Bedingung),
 * darunter je Gerät eine Zeile: seine Leistung je Viertelstunde, gefärbt nach
 * der Herkunft des Stroms (anteilig, `quellenAnteil`). Vor „jetzt“ ruhig, ab
 * „jetzt“ schraffiert (Plan oder Erwartung). Unbekannte Viertelstunden bleiben
 * leer - nie eine gezeichnete Null.
 */
import { liste } from './liste';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PFADE } from './Ic';
import { quellenAnteil, type GeraetBild, type Reihen } from './bild';
import { TAG, zahl0, zahl1 } from './zeit';

export interface Band {
  art: 'pv' | 'preis' | 'temp' | 'soc' | 'hl';
  h: number;
  gap?: number;
  /** Markierung je Viertelstunde (Preis: hervorgehoben, Temperatur/hl: Fläche). */
  hl?: (t: number) => boolean | null;
  /** Unterkante der Sonnen-Fläche markieren (Überschuss). */
  frei?: (t: number) => boolean;
  /** Eine Grenzlinie mit Wert (Preis in ct, Temperatur in °C). */
  linie?: number | null;
  /**
   * Ladestand-Band: eine Untergrenze je Viertelstunde (%), gestrichelt über
   * die Ladestand-Linie gelegt („Sonne + Speicher“). `null` = dort keine.
   */
  grenze?: (number | null)[];
  symbol?: string;
  label?: string;
  name?: string;
}

export interface Zeile {
  g: GeraetBild;
  h?: number;
  gap?: number;
  /** Eine andere Reihe als die des Geräts (Vorschau). */
  kw?: (number | null)[];
}

export interface ZeitbandProps {
  id: string;
  t0: number;
  t1: number;
  reihen: Reihen;
  jetzt: number;
  sel?: number | null;
  bands?: Band[];
  rows?: Zeile[];
  ticks?: number[];
  tage?: boolean;
  padT?: number;
  label: string;
  /** Namen neben den Zeilen (ab 520 px Breite von selbst). */
  namen?: boolean;
  onRow?: (id: string) => void;
}

export interface Geometrie {
  padL: number;
  bw: number;
  t0: number;
  t1: number;
  W: number;
}

/** Breite eines Elements, die sich mitzieht (ResizeObserver). */
export function useBreite(start = 340): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(start);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const miss = () => setW(Math.max(260, Math.round(el.clientWidth || start)));
    miss();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(miss);
    ro.observe(el);
    return () => ro.disconnect();
  }, [start]);
  return [ref, w];
}

const FARBE = { pv: 'var(--pv-fill)', sp: 'var(--batt-fill)', netz: 'var(--grid)' } as const;

function Symbol({ n, x, y, s }: { n: string; x: number; y: number; s: number }) {
  return (
    <svg
      x={x}
      y={y}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#475569"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: (PFADE as Record<string, string>)[n] ?? '' }}
    />
  );
}

export function zeitband(W: number, o: ZeitbandProps): { svg: ReactNode; geo: Geometrie } {
  const { t0, t1, reihen: rh } = o;
  const n = t1 - t0;
  const namen = o.namen ?? W >= 520;
  const padL = namen ? 112 : 28;
  const padR = 6;
  const bw = (W - padL - padR) / n;
  const x = (t: number) => padL + (t - t0) * bw;
  let y = o.padT ?? 14;
  const teile: ReactNode[] = [];
  let k = 0;
  const key = () => `${o.id}-${k++}`;
  const add = (el: ReactNode) => {
    teile.push(el);
  };
  const zeilenKopf = (symbol: string, yy: number, h: number, label: string, kurz: string, id: string | null) => {
    const s = Math.min(15, h - 1);
    const ix = namen ? 2 : padL - s - 8;
    const klick = id && o.onRow ? { onClick: () => o.onRow?.(id), style: { cursor: 'pointer' } } : {};
    add(
      <g key={key()} className="row-hit" {...klick}>
        <title>{label}</title>
        <rect x={0} y={yy - 1} width={padL - 4} height={h + 2} fill="transparent" />
        <Symbol n={symbol} x={ix} y={yy + (h - s) / 2} s={s} />
        {namen && (
          <text x={ix + s + 7} y={yy + h / 2 + 4} fontSize={12} fontWeight={600} fill="#334155">
            {kurz.length > 12 ? `${kurz.slice(0, 11)}…` : kurz}
          </text>
        )}
      </g>,
    );
  };
  const bandTop = y;
  const jetzt = o.jetzt;

  for (const b of liste(o.bands)) {
    const h = b.h;
    if (b.art === 'pv') {
      const max = Math.max(1, ...rh.pv.slice(t0, t1).map((v) => v ?? 0)) * 1.08;
      let d = '';
      let offen = false;
      for (let t = t0; t < t1; t++) {
        const v = rh.pv[t];
        if (v == null) {
          if (offen) { d += `L${x(t).toFixed(1)},${y + h}Z`; offen = false; }
          continue;
        }
        const px = (x(t) + bw / 2).toFixed(1);
        const py = (y + h - (v / max) * h).toFixed(1);
        if (!offen) { d += `M${x(t).toFixed(1)},${y + h}L${px},${py}`; offen = true; }
        else d += `L${px},${py}`;
      }
      if (offen) d += `L${x(t1).toFixed(1)},${y + h}Z`;
      zeilenKopf('sun', y, h, 'Sonne (PV-Leistung, gemessen bis jetzt, danach Prognose)', 'Sonne', null);
      add(<path key={key()} d={d} fill="var(--pv-soft)" stroke="var(--pv)" strokeWidth={1.2} />);
      if (b.frei) {
        for (let t = t0; t < t1; t++) {
          if (b.frei(t)) add(<rect key={key()} x={x(t)} y={y + h - 3} width={bw + 0.3} height={3} fill="var(--pv)" />);
        }
      }
    }
    if (b.art === 'preis') {
      const werte = rh.preis.slice(t0, t1).filter((v): v is number => v != null);
      zeilenKopf('euro', y, h, 'Börsenpreis je Viertelstunde (ct/kWh)', 'Börsenpreis', null);
      if (!werte.length) {
        add(<rect key={key()} x={padL} y={y} width={W - padL - padR} height={h} rx={6} fill="#f1f5f9" />);
        add(
          <text key={key()} x={padL + 8} y={y + h / 2 + 4} fontSize={11.5} fontWeight={600} fill="#475569">
            {t0 >= TAG ? 'Börsenpreise für morgen kommen gegen 13 Uhr' : 'Keine Börsenpreise'}
          </text>,
        );
      } else {
        const max = Math.max(24, ...werte);
        const min = Math.min(-2, ...werte);
        const zero = y + h * (max / (max - min));
        for (let t = t0; t < t1; t++) {
          const p = rh.preis[t];
          if (p == null) continue;
          const hh = Math.max(0.8, (Math.abs(p) / (max - min)) * h);
          const yy = p >= 0 ? zero - hh : zero;
          const an = b.hl ? b.hl(t) : null;
          const fill = an === null || an ? (p < 0 ? 'var(--neg)' : 'var(--price)') : 'var(--price-off)';
          add(
            <rect
              key={key()}
              x={x(t) + 0.3}
              y={yy}
              width={Math.max(0.6, bw - 0.6)}
              height={hh}
              fill={fill}
              fillOpacity={an === null && t < jetzt ? 0.55 : undefined}
            />,
          );
        }
        add(<line key={key()} x1={padL} x2={W - padR} y1={zero} y2={zero} stroke="#94a3b8" strokeWidth={0.8} />);
        if (b.linie != null) {
          const ly = zero - (b.linie / (max - min)) * h;
          add(<line key={key()} x1={padL} x2={W - padR} y1={ly} y2={ly} stroke="var(--c-fg)" strokeWidth={1.2} strokeDasharray="4 3" />);
          add(
            <text key={key()} x={W - padR - 2} y={ly - 3} fontSize={10.5} fontWeight={700} textAnchor="end" fill="var(--c-fg)">
              {zahl1(b.linie)} ct
            </text>,
          );
        }
      }
    }
    if (b.art === 'temp') {
      const lo = -5;
      const hi = 35;
      zeilenKopf('thermo', y, h, 'Außentemperatur (Vorhersage)', 'Temperatur', null);
      if (b.hl) for (let t = t0; t < t1; t++) if (b.hl(t)) add(<rect key={key()} x={x(t)} y={y} width={bw + 0.3} height={h} fill="var(--price-soft)" />);
      let d = '';
      let offen = false;
      for (let t = t0; t < t1; t++) {
        const v = rh.temp[t];
        if (v == null) { offen = false; continue; }
        d += `${offen ? 'L' : 'M'}${(x(t) + bw / 2).toFixed(1)},${(y + h - ((v - lo) / (hi - lo)) * h).toFixed(1)}`;
        offen = true;
      }
      add(<path key={key()} d={d} fill="none" stroke="var(--pv)" strokeWidth={1.6} />);
      if (b.linie != null) {
        const ly = y + h - ((b.linie - lo) / (hi - lo)) * h;
        add(<line key={key()} x1={padL} x2={W - padR} y1={ly} y2={ly} stroke="var(--c-fg)" strokeWidth={1.2} strokeDasharray="4 3" />);
        add(
          <text key={key()} x={W - padR - 2} y={ly - 3} fontSize={10.5} fontWeight={700} textAnchor="end" fill="var(--c-fg)">
            {zahl0(b.linie)} °C
          </text>,
        );
      }
    }
    if (b.art === 'soc' || b.art === 'hl') {
      zeilenKopf(b.symbol ?? 'battery', y, h, b.label ?? 'Ladestand des Speichers', b.name ?? (b.art === 'soc' ? 'Speicher' : 'Bedingung'), null);
      add(<rect key={key()} x={padL} y={y} width={W - padL - padR} height={h} rx={4} fill="#eef2f6" />);
      if (b.art === 'hl' && b.hl) {
        for (let t = t0; t < t1; t++) if (b.hl(t)) add(<rect key={key()} x={x(t)} y={y} width={bw + 0.3} height={h} fill="var(--price)" />);
      } else {
        let d = '';
        let offen = false;
        for (let t = t0; t < t1; t++) {
          const v = rh.soc[t];
          if (v == null) { offen = false; continue; }
          d += `${offen ? 'L' : 'M'}${(x(t) + bw / 2).toFixed(1)},${(y + h - 1 - (v / 100) * (h - 2)).toFixed(1)}`;
          offen = true;
        }
        add(<path key={key()} d={d} fill="none" stroke="var(--batt)" strokeWidth={1.6} />);
        if (b.grenze) {
          let g = '';
          let auf = false;
          for (let t = t0; t < t1; t++) {
            const v = b.grenze[t];
            if (v == null) { auf = false; continue; }
            const yy = (y + h - 1 - (v / 100) * (h - 2)).toFixed(1);
            g += `${auf ? 'L' : 'M'}${x(t).toFixed(1)},${yy}L${(x(t) + bw).toFixed(1)},${yy}`;
            auf = true;
          }
          if (g) add(<path key={key()} d={g} fill="none" stroke="var(--c-fg)" strokeWidth={1.2} strokeDasharray="4 3" />);
        }
      }
    }
    y += h + (b.gap ?? 6);
  }

  for (const row of liste(o.rows)) {
    const g = row.g;
    const h = row.h ?? 16;
    const reihe = row.kw ?? g.kw;
    zeilenKopf(g.symbol, y, h, g.name, g.kurz, g.id);
    add(<rect key={key()} x={padL} y={y} width={W - padL - padR} height={h} rx={4} fill="#eef2f6" />);
    const max = Math.max(g.nennKw ?? 0, ...reihe.slice(t0, t1).map((v) => v ?? 0)) || 1;
    for (let t = t0; t < t1; t++) {
      const kw = reihe[t];
      if (!(kw != null && kw > 0.02)) continue;
      const xx = x(t);
      const ww = bw + 0.35;
      if (g.form === 'freigabe') {
        add(<rect key={key()} x={xx} y={y + 1.5} width={ww} height={h - 3} fill="var(--load-soft)" />);
        add(<rect key={key()} x={xx} y={y + 1.5} width={ww} height={2} fill="var(--load)" />);
        add(<rect key={key()} x={xx} y={y + h - 3.5} width={ww} height={2} fill="var(--load)" />);
        continue;
      }
      const a = quellenAnteil(rh, t) ?? { pv: 1, sp: 0, netz: 0 };
      const hh = Math.max(3, Math.min(1, kw / max) * (h - 2));
      let yy = y + h - 1;
      for (const q of ['pv', 'sp', 'netz'] as const) {
        if (!(a[q] > 0.01)) continue;
        const part = hh * a[q];
        yy -= part;
        add(<rect key={key()} x={xx} y={yy} width={ww} height={part} fill={FARBE[q]} />);
      }
    }
    y += h + (row.gap ?? 5);
  }
  const bottom = y - 4;
  const nowX = jetzt >= t0 && jetzt <= t1 ? x(jetzt) : jetzt < t0 ? padL : null;
  if (nowX != null) {
    add(
      <rect
        key={key()}
        x={nowX}
        y={bandTop}
        width={Math.max(0, W - padR - nowX)}
        height={Math.max(0, bottom - bandTop)}
        fill={`url(#hatch-${o.id})`}
        pointerEvents="none"
      />,
    );
  }
  if (jetzt > t0 && jetzt < t1 && nowX != null) {
    add(<line key={key()} x1={nowX} x2={nowX} y1={bandTop - 6} y2={bottom + 2} stroke="var(--navy)" strokeWidth={1.6} />);
    add(
      <text key={key()} x={nowX} y={bandTop - 8} fontSize={10.5} fontWeight={800} textAnchor="middle" fill="var(--navy)">
        jetzt
      </text>,
    );
  }
  if (o.sel != null && o.sel >= t0 && o.sel < t1) {
    const sx = x(o.sel) + bw / 2;
    add(
      <g key={key()}>
        <line x1={sx} x2={sx} y1={bandTop - 2} y2={bottom + 2} stroke="var(--c-fg)" strokeWidth={1.2} strokeDasharray="2 2" />
        <circle cx={sx} cy={bottom + 4} r={3.5} fill="var(--c-fg)" />
      </g>,
    );
  }
  if (o.tage && t0 < TAG && t1 > TAG) {
    const mx = x(TAG);
    add(<line key={key()} x1={mx} x2={mx} y1={bandTop - 12} y2={bottom + 2} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />);
    add(<text key={key()} x={mx - 4} y={bandTop - 4} fontSize={10.5} fontWeight={700} textAnchor="end" fill="#475569">heute</text>);
    add(<text key={key()} x={mx + 4} y={bandTop - 4} fontSize={10.5} fontWeight={700} fill="#475569">morgen</text>);
  }
  const ticks = o.ticks ?? [0, 24, 48, 72, 96];
  for (const tk of ticks) {
    const t = t0 + tk;
    if (t > t1) continue;
    const lab = tk === n && t % TAG === 0 ? '24' : String(Math.floor((t % TAG) / 4));
    add(
      <text
        key={key()}
        x={x(t)}
        y={bottom + 16}
        fontSize={11}
        fontWeight={600}
        fill="#475569"
        textAnchor={tk === 0 ? 'start' : tk === n ? 'end' : 'middle'}
      >
        {lab}
        {tk === n ? ' Uhr' : ''}
      </text>,
    );
  }
  const H = bottom + 22;
  const svg = (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={o.label}>
      <defs>
        <pattern id={`hatch-${o.id}`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={2.2} height={5} fill="#fff" fillOpacity={0.55} />
        </pattern>
      </defs>
      {teile}
    </svg>
  );
  return { svg, geo: { padL, bw, t0, t1, W } };
}

/** Ein Zeitband, das seine Breite selbst misst. */
export function Zeitband(props: ZeitbandProps & { className?: string }) {
  const [ref, w] = useBreite();
  const { svg } = zeitband(w, props);
  return (
    <div className={`tl ${props.className ?? ''}`} ref={ref}>
      {svg}
    </div>
  );
}
