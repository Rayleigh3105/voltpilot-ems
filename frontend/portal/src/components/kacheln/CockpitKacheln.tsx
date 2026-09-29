import { useId, type ComponentProps, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from '../../../designsystem/components/core/Icon';
import type { HistoryTotals, WeatherPoint } from '../../api';
import { chartTheme } from '../../chartTheme';
import type { HeroMoney } from '../../cockpitWidgets';
import {
  autarkieKachel,
  bezugKurve,
  eigenverbrauchKachel,
  fahrplanKachel,
  handelKachel,
  netzKachel,
  sonneKachel,
  speicherKachel,
  type AnteilKachel,
} from '../../kacheln';
import { kwh, prozent, zahl } from '../../leitungsplan';
import type { PeakBandView } from '../../peakBand';
import type { PlanWordingKind } from '../../schedule';
import type { Tag } from '../../tagesleiste';
import type { VerbrauchTeil } from '../../verbrauchKomposition';
import { SwapNumber } from '../SwapNumber';
import { roleMark } from '../FahrplanWhy';
import { LadenKachel as Laden } from '../LadenKachel';
import { StrompreisStrip as Strompreis } from '../StrompreisStrip';
import { Gross, Kachel, Marke, type RasterGroesse } from './Kachel';

/**
 * **Die Kacheln des Cockpits** (Konzept `docs/konzepte/cockpit-tagesfilm`,
 * „Kachelkatalog“), ein eigenes Stück, das nachgeladen wird. Jede Kachel ist
 * reine Anzeige; ihr Kopf springt auf ihre Seite. Die Zahlen kommen aus den
 * reinen Ableitungen in `kacheln.ts`.
 *
 * Eine Zahl hat einen Ort (R2): Ladestand, Leistung und Netzwert stehen an den
 * Knoten der Bühne, nicht noch einmal hier.
 */

interface Basis {
  groesse?: RasterGroesse;
  lead?: boolean;
  onOpen?: (() => void) | null;
  platzRef?: Ref<HTMLDivElement>;
  fuss?: ReactNode;
}

const FARBE = {
  pv: 'var(--vp-k-pv-fill)',
  batt: 'var(--vp-k-batt-fill)',
  grid: 'var(--vp-k-grid)',
  load: 'var(--vp-k-load)',
} as const;

function Legende({ teile }: { teile: { key: keyof typeof FARBE; label: string; wert: string; blass?: boolean }[] }) {
  return (
    <p className="vp-k-legende">
      {teile.map((t) => (
        <span key={t.key + t.label}>
          <i style={{ background: FARBE[t.key], opacity: t.blass ? 0.5 : 1 }} aria-hidden="true" />
          {t.label} {t.wert}
        </span>
      ))}
    </p>
  );
}

/* ------------------------------------------------------------------ Geld */

/** **Unterm Strich**: die eine Geldzahl je Schirm, mit Zeitraum. */
export function GeldKachel({
  money,
  periodSeg,
  ...b
}: Basis & { money: HeroMoney | null; periodSeg?: ReactNode; nachtragHref?: string }) {
  if (!money && !periodSeg) return null;
  // Wie im Prototyp: die eine Zahl groß, der Zeitraum daneben, darunter ein
  // Satz zur Zurechnung und die Marke „Zwischenstand“. Die Langform (Speicher,
  // Rechenweg) steht auf der Erlöse-Seite, ein Tipp auf den Kopf führt hin.
  const zeitraum = money ? money.label.replace(/^Unterm Strich\s*·\s*/, '') : null;
  return (
    <Kachel {...b} id="geld" name="Unterm Strich" icon="euro" ton="geld" ziel="Erlöse" groesse={b.groesse ?? 'breit'}>
      <div className="vp-k-zeile vp-k-geld">
        <div>
          {money ? (
            <p className={`vp-c-stm-zahl vp-k-geldzahl${money.kosten ? ' is-kosten' : ''}`}>
              <SwapNumber value={money.value} />
            </p>
          ) : (
            <p className="vp-k-sub">Für diesen Zeitraum liegt noch kein Ergebnis vor.</p>
          )}
          {zeitraum && <p className="vp-k-sub">{zeitraum}</p>}
        </div>
        {periodSeg && <div className="vp-k-zeitraum">{periodSeg}</div>}
      </div>
      {money?.attribution && (
        <p className="vp-k-sub" title={money.attributionTitel ?? undefined}>
          {money.attribution}
        </p>
      )}
      {money?.winterSatz && <p className="vp-k-sub">{money.winterSatz}</p>}
      {money?.attributionInterim && <Marke>Zwischenstand</Marke>}
    </Kachel>
  );
}

/* ------------------------------------------------------ Autarkie & Co. */

function HausBild({ a }: { a: AnteilKachel }) {
  const clip = useId();
  const H0 = 57;
  const span = 52;
  const anteil = (key: string) => (a.teile.find((t) => t.key === key)?.pct ?? 0) / 100;
  const sonne = a.teile.length === 2 ? a.pct / 100 : anteil('pv');
  const speicher = anteil('batt');
  const ya = H0 - span * sonne;
  const yb = ya - span * speicher;
  const haus = 'M6 26 L32 5 L58 26 V57 H6 Z';
  return (
    <svg className="vp-k-bild" viewBox="0 0 64 60" width={64} height={60} aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path d={haus} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x={0} y={0} width={64} height={60} style={{ fill: FARBE.grid, opacity: 0.28 }} />
        <rect x={0} y={ya} width={64} height={H0 - ya} style={{ fill: FARBE.pv }} />
        <rect x={0} y={yb} width={64} height={Math.max(0, ya - yb)} style={{ fill: FARBE.batt }} />
      </g>
      <path d={haus} fill="none" style={{ stroke: 'var(--vp-c-fg, #1e293b)' }} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

/** **Autarkie**: wie viel des Verbrauchs heute nicht aus dem Netz kam. */
export function AutarkieKachel({ totals, tag, ...b }: Basis & { totals: HistoryTotals | null; tag: Tag | null }) {
  const a = autarkieKachel(totals, tag);
  if (!a) return null;
  return (
    <Kachel {...b} id="autarkie" name="Autarkie" icon="home" ton="load" ziel="Verlauf">
      <div className="vp-k-reihe">
        <HausBild a={a} />
        <div>
          <Gross wert={String(Math.round(a.pct))} einheit="%" />
          <p className="vp-k-sub">heute selbst gedeckt</p>
        </div>
      </div>
      <Legende
        teile={a.teile.map((t) => ({ key: t.key, label: t.label, wert: prozent(t.pct), blass: t.key === 'grid' }))}
      />
    </Kachel>
  );
}

function Ring({ teile }: { teile: { farbe: string; anteil: number }[] }) {
  const r = 24;
  const U = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg className="vp-k-bild" viewBox="0 0 60 60" width={60} height={60} aria-hidden="true">
      <circle cx={30} cy={30} r={r} fill="none" style={{ stroke: 'var(--vp-k-base)' }} strokeWidth={7} />
      {teile.map((t, i) => {
        const L = Math.max(0, t.anteil * U - 2);
        const el =
          L > 0.5 ? (
            <circle
              key={i}
              cx={30}
              cy={30}
              r={r}
              fill="none"
              style={{ stroke: t.farbe }}
              strokeWidth={7}
              strokeDasharray={`${L.toFixed(2)} ${U.toFixed(2)}`}
              strokeDashoffset={(-off).toFixed(2)}
              transform="rotate(-90 30 30)"
            />
          ) : null;
        off += t.anteil * U;
        return el;
      })}
      <g transform="translate(20 20) scale(.84)" fill="none" style={{ stroke: 'var(--vp-k-pv)' }} strokeWidth={2} strokeLinecap="round">
        <circle cx={12} cy={12} r={4} />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </g>
    </svg>
  );
}

/** **Eigenverbrauch**: wohin die Erzeugung heute ging. */
export function EigenverbrauchKachel({ totals, tag, ...b }: Basis & { totals: HistoryTotals | null; tag: Tag | null }) {
  const e = eigenverbrauchKachel(totals, tag);
  if (!e) return null;
  return (
    <Kachel {...b} id="eigenverbrauch" name={"Eigen\u00adverbrauch"} icon="sun" ton="pv" ziel="Verlauf">
      <div className="vp-k-reihe">
        <Ring teile={e.teile.map((t) => ({ farbe: FARBE[t.key], anteil: t.pct / 100 }))} />
        <div>
          <Gross wert={String(Math.round(e.pct))} einheit="%" />
          <p className="vp-k-sub">heute selbst genutzt</p>
        </div>
      </div>
      <Legende
        teile={e.teile.map((t) => ({
          key: t.key,
          label: t.label,
          wert: t.key === 'grid' && e.einspeisungKwh != null ? kwh(e.einspeisungKwh) : prozent(t.pct),
        }))}
      />
    </Kachel>
  );
}

/** **Netz heute**: Bezug und Einspeisung seit Mitternacht. */
export function NetzKachel({ totals, ...b }: Basis & { totals: HistoryTotals | null }) {
  const nz = netzKachel(totals);
  if (!nz) return null;
  const max = Math.max(nz.bezug, nz.einspeisung, 0.1);
  return (
    <Kachel {...b} id="netz" name="Netz heute" icon="pole" ton="grid" ziel="Verlauf">
      <ul className="vp-k-minis">
        <li className="vp-k-mini">
          <span>Bezug</span>
          <b>{kwh(nz.bezug)}</b>
          <span className="vp-k-spur" aria-hidden="true"><i style={{ width: `${(100 * nz.bezug) / max}%`, background: FARBE.grid }} /></span>
        </li>
        <li className="vp-k-mini">
          <span>Einspeisung</span>
          <b>{kwh(nz.einspeisung)}</b>
          <span className="vp-k-spur" aria-hidden="true"><i style={{ width: `${(100 * nz.einspeisung) / max}%`, background: FARBE.grid, opacity: 0.5 }} /></span>
        </li>
      </ul>
      <p className="vp-k-sub">seit 0 Uhr, gemessen am Netzanschluss</p>
    </Kachel>
  );
}

/* ------------------------------------------------------------- Speicher */

function Batterie({ soc, laedt }: { soc: number | null; laedt: boolean }) {
  const w = 38;
  const h = 60;
  const ih = h - 10;
  const fh = soc == null ? 0 : Math.max(2, (ih * Math.min(100, Math.max(0, soc))) / 100);
  return (
    <svg className="vp-k-bild" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <rect x={w / 2 - 6} y={0} width={12} height={5} rx={2} style={{ fill: 'var(--vp-k-batt)' }} />
      <rect x={1.5} y={5.5} width={w - 3} height={h - 7} rx={8} style={{ fill: 'var(--vp-c-card, #fff)', stroke: 'var(--vp-k-batt)' }} strokeWidth={2} />
      <rect x={5} y={h - 5 - fh} width={w - 10} height={fh} rx={5} style={{ fill: FARBE.batt }} />
      {laedt && fh > 16 && (
        <path d={`M${w / 2 - 5},${h - 5 - fh / 2 + 3} l5,-6 l5,6`} fill="none" style={{ stroke: 'var(--vp-c-card, #fff)' }} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

/** **Speicher**: Ladestand, was er gerade tut, was der Plan vorhat (wie im Prototyp). */
export function SpeicherKachel({
  tag,
  kind,
  socPct,
  battKw,
  ...b
}: Basis & { tag: Tag | null; kind: PlanWordingKind; socPct: number | null; battKw: number | null }) {
  const s = speicherKachel(tag, kind, socPct, battKw);
  if (!s) return null;
  const breit = b.groesse === 'breit';
  return (
    <Kachel {...b} id="speicher" name="Speicher" icon="battery" ton="batt" ziel="Fahrplan">
      <div className="vp-k-reihe">
        <Batterie soc={s.socPct} laedt={s.laedt} />
        <div>
          <Gross wert={s.socPct == null ? '—' : String(Math.round(s.socPct))} einheit={s.socPct == null ? undefined : '%'} />
          <p className="vp-k-zustand">{s.zustand}</p>
        </div>
      </div>
      {s.ausblick && (
        <p className="vp-k-sub">
          {s.ausblick}
          {breit && s.naechster ? ` · Ab ${s.naechster.ab}: ${s.naechster.text}` : ''}
        </p>
      )}
      {s.taetigkeit && <Marke art="plan">Plan: {s.taetigkeit}</Marke>}
    </Kachel>
  );
}

/* ------------------------------------------------------------- Fahrplan */

function Tagesuhr({ ring, jetzt }: { ring: { rolle: Parameters<typeof roleMark>[0] | null; spaeter: boolean }[]; jetzt: number }) {
  const t = chartTheme();
  const R = 40;
  const N = ring.length;
  const bogen = (i: number) => {
    const a0 = (i / N) * 2 * Math.PI - Math.PI / 2 + 0.012;
    const a1 = ((i + 1) / N) * 2 * Math.PI - Math.PI / 2 - 0.012;
    return `M${(50 + R * Math.cos(a0)).toFixed(2)},${(50 + R * Math.sin(a0)).toFixed(2)} A${R},${R} 0 0 1 ${(50 + R * Math.cos(a1)).toFixed(2)},${(50 + R * Math.sin(a1)).toFixed(2)}`;
  };
  const an = ((jetzt + 0.8) / N) * 2 * Math.PI - Math.PI / 2;
  return (
    <svg className="vp-k-bild" viewBox="-12 -12 124 124" width={112} height={112} aria-hidden="true">
      {ring.map((s, i) => (
        <path
          key={i}
          d={bogen(i)}
          fill="none"
          stroke={s.rolle ? roleMark(s.rolle, t).color : t.idle}
          strokeWidth={12}
          opacity={s.rolle ? (s.spaeter ? 1 : 0.55) : 0.35}
        />
      ))}
      <line x1={50} y1={50} x2={(50 + (R + 8) * Math.cos(an)).toFixed(1)} y2={(50 + (R + 8) * Math.sin(an)).toFixed(1)} stroke={t.ink} strokeWidth={2.4} strokeLinecap="round" />
      <circle cx={50} cy={50} r={4} fill={t.ink} />
      {[['0', 50, -4], ['6', 106, 53], ['12', 50, 110], ['18', -6, 53]].map(([l, x, y]) => (
        <text key={l} x={x} y={y} textAnchor="middle" className="vp-k-uhrzahl">{l}</text>
      ))}
    </svg>
  );
}

/** **Fahrplan** als Tagesuhr: was der Speicher laut Plan in jeder Viertelstunde tut. */
export function FahrplanKachel({ tag, kind, leer, ...b }: Basis & { tag: Tag | null; kind: PlanWordingKind; leer?: string | null }) {
  const f = fahrplanKachel(tag, kind);
  const t = chartTheme();
  return (
    <Kachel {...b} id="fahrplan" name="Fahrplan" icon="calendar" ton="plan" ziel="Fahrplan" groesse={b.groesse ?? 'breit'} className="vp-k-fahrplan">
      {!f ? (
        <p className="vp-k-sub">{leer ?? 'Für heute liegt noch kein Plan vor.'}</p>
      ) : (
        <>
          <div className="vp-k-reihe">
            <Tagesuhr ring={f.ring} jetzt={f.jetztIndex} />
            <ul className="vp-k-minis">
              <li className="vp-k-mini"><span>jetzt</span><b className="is-text">{f.jetzt ?? '—'}</b></li>
              {f.schritte.map((s) => (
                <li key={s.ab} className="vp-k-mini"><span>ab {s.ab}</span><b className="is-text">{s.text}</b></li>
              ))}
            </ul>
          </div>
          {f.legende.length > 0 && (
            <p className="vp-k-legende">
              {f.legende.map((l) => (
                <span key={l.rolle}>
                  <i style={{ background: roleMark(l.rolle, t).color }} aria-hidden="true" />
                  {l.text}
                </span>
              ))}
            </p>
          )}
          {/* Was der Speicher als Nächstes erreicht, sagt die Speicher-Kachel (R2). */}
          <Marke art="plan">Plan · alle 15 Minuten neu</Marke>
        </>
      )}
    </Kachel>
  );
}

/* ---------------------------------------------------------------- Handel */

/** **Handel**: Lade- und Verkaufsfenster des Tages mit Energie und mittlerem Preis. */
export function HandelKachel({ tag, kind, ...b }: Basis & { tag: Tag | null; kind: PlanWordingKind }) {
  const h = handelKachel(tag, kind);
  if (!h) return null;
  const ct = (x: number) => `${x.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ct/kWh`;
  return (
    <Kachel {...b} id="handel" name="Handel" icon="trending-up" ton="grid" ziel="Fahrplan" groesse={b.groesse ?? 'breit'}>
      <ul className="vp-k-handel">
        {h.fenster.map((f) => (
          <li key={f.von + f.art}>
            <span className={`vp-k-pfeil is-${f.art}`} aria-hidden="true">
              <Icon name={f.art === 'laden' ? 'arrow-up' : 'arrow-down'} size={14} />
            </span>
            <span>
              <b>{f.von}–{f.bis}</b>
              <small>{f.text}{f.kwh != null ? ` · ${kwh(f.kwh)}` : ''}</small>
            </span>
            <span className="is-preis">
              {f.preisCt != null ? `Ø ${ct(f.preisCt)}` : '—'}
              <small>{f.stand === 'geplant' ? 'erwartet · geplant' : f.stand}</small>
            </span>
          </li>
        ))}
      </ul>
      {h.spanneCt != null && <p className="vp-k-sub">Preisspanne heute: {ct(h.spanneCt)}</p>}
    </Kachel>
  );
}

/* ----------------------------------------------------------------- Sonne */

function SonnenBogen({ f, ghi, w, h }: { f: number | null; ghi: number | null; w: number; h: number }) {
  const x0 = 8;
  const x1 = w - 8;
  const base = h - 10;
  const cy = 2 * 6 - base;
  const p = f ?? 0;
  const u = 1 - p;
  const sx = x0 + (x1 - x0) * p;
  const sy = u * u * base + 2 * u * p * cy + p * p * base;
  const d = `M${x0},${base} Q${w / 2},${cy} ${x1},${base}`;
  return (
    <svg className="vp-k-bild" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <path d={d} fill="none" style={{ stroke: 'var(--vp-c-border, #e2e8f0)' }} strokeWidth={1.5} />
      {f != null && (
        <path d={d} fill="none" style={{ stroke: FARBE.pv }} strokeWidth={2.5} strokeDasharray={`${(p * (x1 - x0) * 1.25).toFixed(0)} 999`} />
      )}
      <line x1={0} x2={w} y1={base} y2={base} style={{ stroke: 'var(--vp-c-border, #e2e8f0)' }} />
      {f != null && f > 0 && f < 1 && (
        <>
          <circle cx={sx} cy={sy} r={8 + 8 * Math.min(1, Math.max(0, (ghi ?? 0) / 860))} style={{ fill: FARBE.pv }} opacity={0.22} />
          <circle cx={sx} cy={sy} r={6} style={{ fill: FARBE.pv, stroke: 'var(--vp-c-card, #fff)' }} strokeWidth={2} />
        </>
      )}
    </svg>
  );
}

/** **Sonne**: Sonnenstärke am Standort und die Erzeugung heute, gemessen und erwartet. */
export function SonneKachel({
  points,
  now,
  totals,
  tag,
  ...b
}: Basis & { points: WeatherPoint[] | null; now: Date; totals: HistoryTotals | null; tag: Tag | null }) {
  const s = sonneKachel(points, now, totals, tag);
  if (!s) return null;
  const breit = b.groesse !== 'klein';
  const anteil = s.heuteKwh != null && s.erwartetKwh ? Math.min(1, s.heuteKwh / s.erwartetKwh) : null;
  const zahl = (
    <div>
      <Gross wert={s.ghi == null ? '—' : String(Math.round(s.ghi))} einheit="W/m²" />
      <p className="vp-k-sub">Sonnenstärke jetzt</p>
    </div>
  );
  return (
    <Kachel {...b} id="sonne" name="Sonne" icon="sun" ton="pv" ziel="Wetter" groesse={b.groesse ?? 'breit'}>
      {breit ? (
        <div className="vp-k-reihe">
          <SonnenBogen f={s.bogen} ghi={s.ghi} w={150} h={58} />
          {zahl}
        </div>
      ) : (
        <>
          <SonnenBogen f={s.bogen} ghi={s.ghi} w={140} h={50} />
          {zahl}
        </>
      )}
      {s.heuteKwh != null && (
        <ul className="vp-k-minis">
          <li className="vp-k-mini">
            <span>PV heute gemessen</span>
            <b>{kwh(s.heuteKwh)}</b>
            {anteil != null && (
              <span className="vp-k-spur is-erwartet" aria-hidden="true">
                <i style={{ width: `${(100 * anteil).toFixed(1)}%`, background: FARBE.pv }} />
              </span>
            )}
          </li>
        </ul>
      )}
      {s.erwartetKwh != null && <p className="vp-k-sub">Erwartet heute: {kwh(s.erwartetKwh)} (Prognose)</p>}
    </Kachel>
  );
}

/* ------------------------------------------------------------ Lastspitze */

/** **Lastspitze**: Viertelstundenmittel gegen das Ziel, Monatswerte, Tageslinie. */
export function LastspitzeKachel({
  peak,
  tag,
  zielKw,
  ...b
}: Basis & { peak: PeakBandView; tag: Tag | null; zielKw: number | null }) {
  const W = 220;
  const cx = W / 2;
  const cy = 112;
  const r = 88;
  const winkel = (pct: number) => Math.PI * (1 - Math.min(1, Math.max(0, pct / 100)));
  const P = (pct: number, rr: number) => [cx + rr * Math.cos(winkel(pct)), cy - rr * Math.sin(winkel(pct))];
  const bogen = (a: number, e: number) => {
    const [x0, y0] = P(a, r);
    const [x1, y1] = P(e, r);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const kurve = bezugKurve(tag);
  const werte = kurve.filter((x): x is number => x != null);
  const km = Math.max(0.1, ...werte, zielKw ?? 0) * 1.05;
  const w = 320;
  const h = 70;
  const Y = (x: number) => 4 + (h - 8) - (h - 8) * Math.min(1, Math.max(0, x / km));
  let pfad = '';
  kurve.forEach((x, i) => {
    if (x == null) return;
    pfad += `${pfad ? 'L' : 'M'}${(((i + 0.5) * w) / kurve.length).toFixed(1)},${Y(x).toFixed(1)} `;
  });
  return (
    <Kachel {...b} id="lastspitze" name="Lastspitze" icon="activity" ton="grid" ziel="Lastspitzen" groesse={b.groesse ?? 'hoch'}>
      {peak.fillPct != null ? (
        <svg className="vp-k-bild" viewBox={`0 0 ${W} 128`} style={{ maxWidth: W, margin: '0 auto', width: '100%' }} aria-hidden="true">
          <path d={bogen(0, 100)} fill="none" style={{ stroke: 'var(--vp-k-base)' }} strokeWidth={12} strokeLinecap="round" />
          {peak.fillPct > 0 && (
            <path d={bogen(0, peak.fillPct)} fill="none" style={{ stroke: peak.breach ? 'var(--vp-chart-discharge, #e53935)' : 'var(--vp-k-grid-line)' }} strokeWidth={12} strokeLinecap="round" opacity={peak.fresh ? 1 : 0.5} />
          )}
          {peak.limitPct != null && (() => {
            const [a0, b0] = P(peak.limitPct, r - 12);
            const [a1, b1] = P(peak.limitPct, r + 12);
            const [lx, ly] = P(peak.limitPct, r + 22);
            return (
              <>
                <line x1={a0} y1={b0} x2={a1} y2={b1} style={{ stroke: 'var(--vp-k-plan)' }} strokeWidth={2.5} />
                <text x={lx} y={ly} textAnchor="middle" className="vp-k-ziel">Ziel</text>
              </>
            );
          })()}
          <text x={cx} y={cy - 26} textAnchor="middle" className="vp-k-tacho-zahl">{peak.currentLabel}</text>
          <text x={cx} y={cy - 8} textAnchor="middle" className="vp-k-tacho-text">Netzbezug, Viertelstunde</text>
          <text x={cx - r} y={cy + 14} textAnchor="middle" className="vp-k-tacho-text">0</text>
          {peak.scaleMaxLabel && <text x={cx + r} y={cy + 14} textAnchor="middle" className="vp-k-tacho-text">{peak.scaleMaxLabel}</text>}
        </svg>
      ) : (
        <div>
          <Gross wert={peak.currentLabel} />
          <p className="vp-k-sub">Netzbezug, Viertelstunde</p>
        </div>
      )}
      {(peak.metrics.length > 0 || peak.targetLabel) && (
        <ul className="vp-k-minis">
          {peak.targetLabel && <li className="vp-k-mini"><span>Ziel</span><b>{peak.targetLabel}</b></li>}
          {peak.metrics.map((m) => (
            <li key={m.label} className="vp-k-mini"><span>{m.label}</span><b>{m.value}</b></li>
          ))}
        </ul>
      )}
      {pfad && (
        <div>
          <svg className="vp-k-bild" viewBox={`0 0 ${w} ${h}`} width="100%" aria-hidden="true">
            <path d={pfad} fill="none" style={{ stroke: 'var(--vp-k-grid-line)' }} strokeWidth={1.8} strokeLinejoin="round" />
            {zielKw != null && <line x1={0} x2={w} y1={Y(zielKw)} y2={Y(zielKw)} style={{ stroke: 'var(--vp-k-plan)' }} strokeDasharray="5 3" strokeWidth={1.2} />}
          </svg>
          <div className="vp-k-achse" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 Uhr</span></div>
          <p className="vp-k-legende">
            <span><i className="is-linie" style={{ background: 'var(--vp-k-grid-line)' }} aria-hidden="true" />Netzbezug heute</span>
            {zielKw != null && <span><i className="is-linie" style={{ background: 'var(--vp-k-plan)' }} aria-hidden="true" />Ziel</span>}
          </p>
        </div>
      )}
      {peak.note && <p className="vp-k-sub">{peak.note}</p>}
    </Kachel>
  );
}

/* ------------------------------------------------------------ Wärmepumpe */

/** **Wärmepumpe**: Zustand und Leistung, wenn gemessen. */
export function WaermepumpeKachel({ teil, ...b }: Basis & { teil: VerbrauchTeil }) {
  return (
    <Kachel {...b} id="waermepumpe" name="Wärmepumpe" icon="heatpump" ton="load" ziel="Steuerung">
      <div>
        <Gross wert={teil.kw == null ? '—' : zahl(teil.kw)} einheit={teil.kw == null ? undefined : 'kW'} />
        <p className="vp-k-zustand">{teil.word}</p>
      </div>
      {teil.note && <p className="vp-k-sub">{teil.note}</p>}
      {teil.todayKwh != null && <p className="vp-k-sub">heute {kwh(teil.todayKwh)}</p>}
    </Kachel>
  );
}

/* ------------------------------------------------------ Einfache Kacheln */

/** Eine Kachel mit einer Zahl und einer ruhigen Zeile (Wetter, Geräte-Automatik). */
export function WertKachel({
  id,
  name,
  icon,
  ton,
  wert,
  sub,
  ...b
}: Basis & { id: string; name: string; icon: IconName; ton: 'pv' | 'batt' | 'grid' | 'load' | 'neutral'; wert: string; sub: string | null }) {
  return (
    <Kachel {...b} id={id} name={name} icon={icon} ton={ton}>
      <Gross wert={wert} />
      {sub && <p className="vp-k-sub">{sub}</p>}
    </Kachel>
  );
}

/** Ein Auftrag an das nachgeladene Stück: welche Kachel mit welchen Daten. */
export type KachelAuftrag =
  | ({ art: 'geld' } & ComponentProps<typeof GeldKachel>)
  | ({ art: 'autarkie' } & ComponentProps<typeof AutarkieKachel>)
  | ({ art: 'eigenverbrauch' } & ComponentProps<typeof EigenverbrauchKachel>)
  | ({ art: 'netz' } & ComponentProps<typeof NetzKachel>)
  | ({ art: 'speicher' } & ComponentProps<typeof SpeicherKachel>)
  | ({ art: 'fahrplan' } & ComponentProps<typeof FahrplanKachel>)
  | ({ art: 'handel' } & ComponentProps<typeof HandelKachel>)
  | ({ art: 'sonne' } & ComponentProps<typeof SonneKachel>)
  | ({ art: 'lastspitze' } & ComponentProps<typeof LastspitzeKachel>)
  | ({ art: 'waermepumpe' } & ComponentProps<typeof WaermepumpeKachel>)
  | ({ art: 'wert' } & ComponentProps<typeof WertKachel>)
  | ({ art: 'strompreis' } & ComponentProps<typeof Strompreis>)
  | ({ art: 'laden' } & ComponentProps<typeof Laden>);

/** Der eine Einstieg des nachgeladenen Stücks (React.lazy braucht einen Standard-Export). */
export default function KachelSchalter(a: KachelAuftrag) {
  switch (a.art) {
    case 'geld': return <GeldKachel {...a} />;
    case 'autarkie': return <AutarkieKachel {...a} />;
    case 'eigenverbrauch': return <EigenverbrauchKachel {...a} />;
    case 'netz': return <NetzKachel {...a} />;
    case 'speicher': return <SpeicherKachel {...a} />;
    case 'fahrplan': return <FahrplanKachel {...a} />;
    case 'handel': return <HandelKachel {...a} />;
    case 'sonne': return <SonneKachel {...a} />;
    case 'lastspitze': return <LastspitzeKachel {...a} />;
    case 'waermepumpe': return <WaermepumpeKachel {...a} />;
    case 'wert': return <WertKachel {...a} />;
    case 'strompreis': return <Strompreis {...a} />;
    case 'laden': return <Laden {...a} />;
    default: return null;
  }
}
