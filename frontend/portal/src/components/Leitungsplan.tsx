import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { useContainerWidth } from '../useContainerWidth';
import {
  anteile,
  geometrie,
  PAAR_TEXT,
  PAARE,
  quelleVon,
  spurBild,
  zielAnteil,
  type Herkunft,
  type KnotenText,
  type Paar,
  type Rolle,
} from '../leitungsplan';

/**
 * **Der Energiefluss als Leitungsplan** (Konzept `docs/konzepte/cockpit-tagesfilm`,
 * dritte Fassung, abgenommen am 29.09.2026).
 *
 * Vier feste Plätze - Sonne oben, Haus unten, Speicher links, Netz rechts - und
 * eine Spur je Weg in der Farbe ihrer Herkunft, so breit wie ihre Leistung.
 * Grün kommt deshalb immer aus dem Speicher, Petrol immer aus dem Netz: die
 * Richtung braucht keinen Pfeil.
 *
 * **Bewegung heißt live:** Nur wenn das Bild „jetzt“ zeigt, wandern kleine
 * helle Punkte langsam die Spuren entlang. Zurückgezogen, im Plan, bei „Heute“
 * und mit reduzierter Bewegung steht das Bild still (Schalter am Ende von
 * `index.css`). Werte gleiten beim Wechsel in `--vp-motion-base`.
 *
 * Render-only: Herkunft, Breiten, Pfade und Texte kommen aus `leitungsplan.ts`.
 */
export function Leitungsplan({
  herkunft,
  skala,
  totband,
  texte,
  hat,
  zeit,
  socPct,
  gridKw,
  zielKw = null,
  reserveProzent = null,
  stale = false,
  onKnoten,
}: {
  /** Herkunft je Weg (kW bzw. kWh); null = unvollständig, dann keine Spuren. */
  herkunft: Herkunft | null;
  /** Maßstab: die größte Leistung des Tages (bzw. der größte Tageswert). */
  skala: number;
  totband: number;
  texte: Record<Rolle, KnotenText>;
  /** Welche Knoten die Anlage hat. Ohne Speicher entfällt er samt Spuren. */
  hat: { pv: boolean; batt: boolean };
  zeit: 'live' | 'gemessen' | 'plan' | 'heute';
  socPct: number | null;
  /** + Bezug; nur für die Ziel-Skala am Netz. */
  gridKw: number | null;
  zielKw?: number | null;
  reserveProzent?: number | null;
  stale?: boolean;
  onKnoten: (rolle: Rolle, ausloeser: HTMLElement) => void;
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const g = geometrie(breite || 330);
  const ziel = anteile(herkunft, skala, totband);
  if (!hat.batt) for (const p of PAARE) if (p.includes('batt')) ziel[p] = 0;
  if (!hat.pv) for (const p of PAARE) if (p.startsWith('pv')) ziel[p] = 0;
  const a = useGleiten(ziel);
  const bild = spurBild(a, g);
  const live = zeit === 'live' && !stale;
  const ziele = zielAnteil(gridKw, zielKw);

  const pos = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, width: w, height: h });
  const unten = g.hubY + Math.max(g.r, g.bh / 2) + 10;
  const eng = g.stufe !== 'breit';

  return (
    <div
      ref={ref}
      className={`vp-lp vp-lp-${g.stufe}${live ? ' is-live' : ''}${zeit === 'plan' ? ' is-plan' : ''}${stale ? ' is-stale' : ''}`}
      style={{ height: g.h }}
      role="group"
      aria-label="Energiefluss Ihrer Anlage"
    >
      <svg className="vp-lp-fx" width={g.w} height={g.h} viewBox={`0 0 ${g.w} ${g.h}`} aria-hidden="true">
        <defs>
          {(['pv', 'batt', 'grid'] as const).map((r) => (
            <pattern key={r} id={`vp-lp-plan-${r}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect width="6" height="6" className={`vp-lp-f-${r}`} opacity=".25" />
              <rect width="3" height="6" className={`vp-lp-f-${r}`} />
            </pattern>
          ))}
        </defs>
        <g className="vp-lp-schiene">
          {hat.pv && <path d={`M${g.cx},${g.sonneY}V${g.hubY}`} />}
          <path d={`M${g.cx},${g.hubY}V${g.hausY}`} />
          {hat.batt && <path d={`M${g.speicherX},${g.hubY}H${g.cx}`} />}
          <path d={`M${g.cx},${g.hubY}H${g.netzX}`} />
        </g>
        {bild.spuren.map((s) => (
          <g key={s.paar}>
            {s.paar === 'pv>load' && bild.kreuzung && (
              <path className="vp-lp-rand" d={bild.kreuzung.d} strokeWidth={bild.kreuzung.breite} />
            )}
            <path
              className={`vp-lp-spur vp-lp-s-${quelleVon(s.paar)}`}
              d={s.d}
              strokeWidth={s.breite}
              stroke={zeit === 'plan' ? `url(#vp-lp-plan-${quelleVon(s.paar)})` : undefined}
            >
              <title>{spurTitel(s.paar, herkunft, zeit)}</title>
            </path>
            {s.punkte && <path className="vp-lp-punkte" d={s.d} strokeWidth={s.punktBreite} />}
          </g>
        ))}
      </svg>

      {hat.pv && (
        <>
          <span
            className="vp-lp-glanz"
            aria-hidden="true"
            style={{ left: g.cx, top: g.sonneY, width: 2 * g.r, height: 2 * g.r, ['--k' as string]: texte.pv.ruhig ? 0 : 1 }}
          />
          <Knoten rolle="pv" text={texte.pv} style={pos(g.cx, g.sonneY, 2 * g.r, 2 * g.r)} ruhig={texte.pv.ruhig} onKnoten={onKnoten}>
            <Icon name="sun" size={g.stufe === 'breit' ? 26 : 20} />
          </Knoten>
          <Beschriftung text={texte.pv} klasse="r" style={{ left: g.cx + g.r + g.abstand, top: g.sonneY }} />
        </>
      )}
      {hat.batt && (
        <>
          <button
            type="button"
            className="vp-lp-batt"
            style={pos(g.speicherX, g.hubY, g.bw, g.bh)}
            aria-label={texte.batt.aria}
            title={texte.batt.aria}
            onClick={(e) => onKnoten('batt', e.currentTarget)}
          >
            <span className="vp-lp-lvl" style={{ height: `calc((100% - 6px) * ${Math.min(1, Math.max(0, (socPct ?? 0) / 100)).toFixed(3)})` }} />
            {reserveProzent != null && (
              <span className="vp-lp-res" style={{ bottom: 3 + ((g.bh - 10) * reserveProzent) / 100 }} />
            )}
          </button>
          <Beschriftung
            text={texte.batt}
            klasse={eng ? '' : 'c'}
            style={
              eng
                ? { left: Math.max(2, g.speicherX - g.bw / 2 - 2), top: unten, maxWidth: g.stufe === 'eng' ? g.cx - g.maxBreite - g.luecke - 8 - 9 : undefined }
                : { left: g.speicherX, top: unten }
            }
          />
        </>
      )}
      <Knoten rolle="grid" text={texte.grid} style={pos(g.netzX, g.hubY, 2 * g.r, 2 * g.r)} onKnoten={onKnoten}>
        <Icon name="pole" size={g.stufe === 'breit' ? 24 : 18} />
      </Knoten>
      <Beschriftung
        text={texte.grid}
        klasse={eng ? 'e' : 'c'}
        skala={ziele}
        style={
          eng
            ? { right: Math.max(2, g.w - g.netzX - g.r), top: unten, maxWidth: g.stufe === 'eng' ? g.cx - g.maxBreite - g.luecke - 10 : undefined }
            : { left: g.netzX, top: unten }
        }
      />
      <Knoten rolle="load" text={texte.load} style={pos(g.cx, g.hausY, 2 * g.r, 2 * g.r)} onKnoten={onKnoten}>
        <Icon name="home" size={g.stufe === 'breit' ? 26 : 20} />
      </Knoten>
      <Beschriftung text={texte.load} klasse="r" style={{ left: g.cx + g.r + g.abstand, top: g.hausY }} />
    </div>
  );
}

function spurTitel(p: Paar, h: Herkunft | null, zeit: string): string {
  const x = h ? h[p] : null;
  if (x == null) return PAAR_TEXT[p];
  const u = zeit === 'heute' ? 'kWh' : 'kW';
  return `${PAAR_TEXT[p]}: ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(x)} ${u}`;
}

function Knoten({
  rolle,
  text,
  style,
  ruhig = false,
  onKnoten,
  children,
}: {
  rolle: Rolle;
  text: KnotenText;
  style: React.CSSProperties;
  ruhig?: boolean;
  onKnoten: (rolle: Rolle, ausloeser: HTMLElement) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`vp-lp-knoten vp-lp-k-${rolle}${ruhig ? ' is-ruhig' : ''}`}
      style={style}
      aria-label={text.aria}
      title={text.aria}
      onClick={(e) => onKnoten(rolle, e.currentTarget)}
    >
      {children}
    </button>
  );
}

function Beschriftung({
  text,
  klasse,
  style,
  skala = null,
}: {
  text: KnotenText;
  klasse: string;
  style: React.CSSProperties;
  /** Ziel-Skala am Netz (Lastspitzenkappung), 0..1. */
  skala?: number | null;
}) {
  return (
    <div className={`vp-lp-lab ${klasse}`} style={style} aria-hidden="true">
      <b>{text.wert}</b>
      {text.zeilen.map((z, i) => (
        <span key={i} className={`vp-lp-zeile${z === 'Sollwert bestätigt' ? ' vp-flow-confirm' : ''}`}>
          {z === 'Sollwert bestätigt' && <Icon name="check" size={12} />}
          {skala != null && z.startsWith('Ziel') && (
            <span className="vp-lp-gz">
              <i style={{ width: `${(skala * 100).toFixed(1)}%` }} />
            </span>
          )}
          {z}
        </span>
      ))}
    </div>
  );
}

/**
 * Breiten gleiten beim Wechsel (etwa beim Ziehen der Tagesleiste) in 200 ms;
 * sonst steht das Bild. Unter reduzierter Bewegung springen sie sofort.
 */
function useGleiten(ziel: Record<Paar, number>): Record<Paar, number> {
  const [cur, setCur] = useState(ziel);
  const vonRef = useRef(ziel);
  const key = PAARE.map((p) => ziel[p].toFixed(4)).join('|');
  useEffect(() => {
    const von = vonRef.current;
    const reduziert =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduziert || typeof requestAnimationFrame !== 'function') {
      vonRef.current = ziel;
      setCur(ziel);
      return undefined;
    }
    const t0 = performance.now();
    const D = 200;
    let raf = 0;
    const schritt = (t: number) => {
      const k = Math.min(1, (t - t0) / D);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const o = {} as Record<Paar, number>;
      for (const p of PAARE) o[p] = von[p] + (ziel[p] - von[p]) * e;
      vonRef.current = o;
      setCur(o);
      if (k < 1) raf = requestAnimationFrame(schritt);
    };
    raf = requestAnimationFrame(schritt);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return cur;
}
