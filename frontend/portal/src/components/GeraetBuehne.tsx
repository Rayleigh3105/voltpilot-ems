import { useId, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { fmtNum } from '../format';
import type { BuehneWerte, Held, HeldKachel } from '../geraetGesicht';
import type { GeraetTon } from '../geraetSeite';
import { NO_DATA } from '../nodata';
import { DirectionArrow, type FlowPoint } from './FlowArrow';
import { SwapNumber, SwapText } from './SwapNumber';
import { useFlowTempo } from './useFlowTempo';
import './GeraetBuehne.css';

/**
 * Die BÜHNE einer Geräteseite (Konzept „Geräteseiten: Ein Blick, eine
 * Antwort", Baustein 2): die EINE große Zahl, ein Satz in Klartext und eine
 * Grafik, die zeigt, was das Gerät gerade tut.
 *
 * <p>Diese Datei RENDERT nur. Zahl, Satz und Kacheln kommen aus
 * `geraetGesicht.ts` (dieselben Ableitungen wie bisher), die Grafik liest die
 * ROHEN Zahlen derselben Stelle (`Held.werte`) - Grafik und Zahl zeigen nie
 * Verschiedenes.
 *
 * <p><b>Bewegung ohne Ladezeit</b> (nur CSS und kleine Inline-SVGs):
 * <ul>
 *   <li>Fluss-Punkte sind die Energiefluss-Linien des Portals
 *       (`.vp-flow-line` + `useFlowTempo`): ihr Tempo kommt aus der Leistung,
 *       unter 0,05 kW gibt es keine Punkte, und unter reduzierter Bewegung
 *       stehen sie - dann zeigt die Richtungs-Spitze, wohin es fließt.</li>
 *   <li>Füllstände erscheinen sofort mit dem wahren Wert und gleiten nur
 *       zwischen zwei echten Messungen - nichts wächst aus der Null.</li>
 *   <li>Die Zahl wechselt über `SwapNumber` - es wird nie gezählt.</li>
 * </ul>
 */

/** Die große Zahl der Bühne - aus der FÜHRENDEN Kachel eines Helds. */
export interface BuehneZahl {
  zahl: string;
  einheit: string | null;
  wort: string | null;
  ton: GeraetTon | null;
  key: string;
}

/**
 * Die große Zahl aus der führenden Kachel (`gross`), sonst der ersten.
 * „64 %" wird zu Zahl + Einheit, „Gesetzt" bleibt ein Wort; ohne Wert gibt es
 * keine große Zahl - nie ein großes „—".
 */
export function grosseZahl(held: Pick<Held, 'kacheln'>): BuehneZahl | null {
  const k = held.kacheln.find((x) => x.gross) ?? held.kacheln[0];
  if (!k || k.wert === NO_DATA) return null;
  const m = /^(.*\d)\s+(\S+)$/.exec(k.wert);
  return {
    zahl: m ? m[1] : k.wert,
    einheit: m ? m[2] : null,
    wort: k.wort,
    ton: k.ton ?? null,
    key: k.key,
  };
}

/**
 * Welche Kacheln die Grafik SELBST beschriftet - sie stehen darunter nicht
 * noch einmal als Chip. Dieselbe Zahl zweimal auf einer Bühne war der Befund
 * der Browser-Prüfung.
 *
 * ⚠ Nur, was die Grafik wirklich als Zahl zeigt: Haus und Netz zeichnet sie
 * nur, wo dieses Gerät sie misst, den Maßstab nur mit gepflegter Nennleistung.
 */
export function grafikZeigt(grafik: BuehneGrafik | null | undefined): ReadonlySet<string> {
  if (!grafik) return new Set();
  switch (grafik.art) {
    case 'speicher': {
      const w = grafik.werte;
      return new Set([
        'pv',
        ...(w.netzKw != null ? ['netz'] : []),
        ...(w.hausKw != null ? ['haus'] : []),
      ]);
    }
    case 'sonne':
      return new Set(grafik.werte.kwp != null && grafik.werte.kwp > 0 ? ['kwp'] : []);
    default:
      return new Set();
  }
}

/**
 * Die übrigen Kacheln als ruhige Chips - ohne die große, ohne leere und ohne
 * die, deren Zahl die Grafik schon beschriftet.
 */
export function nebenKacheln(
  held: Pick<Held, 'kacheln'>,
  gross: BuehneZahl | null,
  grafik?: BuehneGrafik | null,
): HeldKachel[] {
  const inGrafik = grafikZeigt(grafik);
  return held.kacheln.filter((k) => k.key !== gross?.key && k.wert !== NO_DATA && !inGrafik.has(k.key));
}

/** Welche Grafik eine Bühne zeigt. */
export type BuehneGrafik =
  | { art: 'speicher'; werte: BuehneWerte }
  | { art: 'sonne'; werte: BuehneWerte }
  | { art: 'netz'; werte: BuehneWerte }
  | { art: 'verbraucher'; werte: BuehneWerte; freigabe: boolean }
  | { art: 'wallbox'; kw: number | null; laedt: boolean }
  | { art: 'box'; verbunden: boolean; geraete: number };

export function GeraetBuehne({
  zahl,
  satz,
  satzTon = 'ok',
  grafik,
  inhalt,
  chips = [],
  zeilen = [],
  hinweis,
  markiert,
  aktion,
}: {
  zahl: BuehneZahl | null;
  satz: string | null;
  satzTon?: GeraetTon;
  grafik?: BuehneGrafik | null;
  /** Statt einer Grafik ein eigener Inhalt (Klemmenplan, eigene Kanäle). */
  inhalt?: ReactNode;
  chips?: HeldKachel[];
  zeilen?: string[];
  hinweis?: string | null;
  /**
   * Die angesprungene Kachel (`?kachel=speicher`): die Batterie hat keine
   * eigene Seite, ihr Absprung aus dem Anlagen-Modell markiert sie HIER.
   */
  markiert?: string | null;
  /** Eine Handlung direkt an der Bühne (die Hauptaktion einer Wallbox). */
  aktion?: ReactNode;
}) {
  // ⚠ Markiert wird GENAU die angesprungene Kachel - die große Zahl oder ein
  // Chip, nie die ganze Bühne (sonst trüge die Zahl den Rahmen eines Chips).
  const zahlMarkiert = Boolean(markiert && zahl?.key === markiert);
  return (
    <div
      className={`vp-buehne${grafik ? ` is-${grafik.art}` : ''}${inhalt ? ' is-inhalt' : ''}`}
      data-testid="geraet-held"
    >
      {(zahl || satz) && (
        <div className="vp-buehne-text">
          {zahl && (
            <div className={`vp-buehne-zahlzeile${zahlMarkiert ? ' is-markiert' : ''}`} data-kachel={zahl.key}>
              <span className={`vp-buehne-zahl${/\d/.test(zahl.zahl) ? '' : ' ist-wort'}`}>
                <SwapNumber value={zahl.zahl} />
                {zahl.einheit && <small>{zahl.einheit}</small>}
              </span>
              {zahl.wort && (
                <span className={`vp-buehne-wort${zahl.ton ? ` is-${zahl.ton}` : ''}`}>{zahl.wort}</span>
              )}
            </div>
          )}
          {satz && (
            <p className={`vp-buehne-satz is-${satzTon}`} data-testid="geraet-heldsatz">{satz}</p>
          )}
        </div>
      )}
      {grafik && (
        <div className="vp-buehne-grafik">
          <Grafik grafik={grafik} />
        </div>
      )}
      {inhalt && <div className="vp-buehne-inhalt">{inhalt}</div>}
      {(chips.length > 0 || zeilen.length > 0 || hinweis || aktion) && (
        <div className="vp-buehne-fuss">
          {chips.length > 0 && (
            <ul className="vp-buehne-chips" aria-label="Weitere Werte">
              {chips.map((k) => (
                <li
                  key={k.key}
                  className={`vp-buehne-chip${k.ton ? ` is-${k.ton}` : ''}${
                    markiert && k.key === markiert ? ' is-markiert' : ''}`}
                  data-kachel={k.key}
                >
                  {k.label} <b>{k.wert}</b>
                  {k.wort && <span className="w"> {k.wort}</span>}
                </li>
              ))}
            </ul>
          )}
          {zeilen.length > 0 && (
            <ul className="vp-buehne-zeilen">
              {zeilen.map((z) => <li key={z}>{z}</li>)}
            </ul>
          )}
          {hinweis && <p className="vp-buehne-hinweis">{hinweis}</p>}
          {aktion && <div className="vp-buehne-aktion">{aktion}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Die Grafiken
// ---------------------------------------------------------------------------

/** Unter dieser Leistung fließt nichts - die `live.ts`-Schwelle. */
const TOTBAND_KW = 0.05;

const FARBE = {
  pv: 'var(--vp-flow-pv)',
  pvSoft: 'var(--vp-flow-pv-soft)',
  load: 'var(--vp-flow-load)',
  loadSoft: 'var(--vp-flow-load-soft)',
  grid: 'var(--vp-flow-grid)',
  gridSoft: 'var(--vp-flow-grid-soft)',
  gridInk: 'var(--vp-chart-grid-line)',
  batt: 'var(--vp-flow-batt)',
  battSoft: 'var(--vp-flow-batt-soft)',
  battInk: 'var(--vp-flow-batt-ink)',
  battLite: 'var(--vp-flow-batt-lite)',
  ink: 'var(--vp-flow-ink)',
  base: 'var(--vp-flow-base)',
  box: 'var(--vp-action)',
  aus: 'var(--vp-text-gray)',
} as const;

function kw(v: number | null): string {
  return v == null ? NO_DATA : fmtNum(Math.abs(v), 'kW');
}

function Grafik({ grafik }: { grafik: BuehneGrafik }) {
  switch (grafik.art) {
    case 'speicher':
      return <SpeicherGrafik w={grafik.werte} />;
    case 'sonne':
      return <SonneGrafik w={grafik.werte} />;
    case 'netz':
      return <NetzGrafik w={grafik.werte} />;
    case 'verbraucher':
      return <VerbraucherGrafik w={grafik.werte} freigabe={grafik.freigabe} />;
    case 'wallbox':
      return <WallboxGrafik kw={grafik.kw} laedt={grafik.laedt} />;
    case 'box':
      return <BoxGrafik verbunden={grafik.verbunden} geraete={grafik.geraete} />;
    default:
      return null;
  }
}

/**
 * Eine Fluss-Linie: die ruhige Spur, darüber die laufenden Punkte des
 * Energieflusses (`.vp-flow-on`/`.vp-flow-rev`) und die Richtungs-Spitze, die
 * nur unter reduzierter Bewegung erscheint.
 *
 * ⚠ „Ruhe bei Null" durch Abwesenheit: unter 0,05 kW gibt es keine Punkte.
 */
function Fluss({
  von,
  nach,
  farbe,
  kwWert,
}: {
  /** Woher es fließt. */
  von: FlowPoint;
  /** Wohin es fließt. */
  nach: FlowPoint;
  farbe: string;
  /** Die Leistung - sie setzt das Tempo; null/klein = keine Punkte. */
  kwWert: number | null;
}) {
  const aktiv = kwWert != null && Math.abs(kwWert) > TOTBAND_KW;
  return (
    <g>
      <line
        x1={von.x}
        y1={von.y}
        x2={nach.x}
        y2={nach.y}
        stroke={FARBE.base}
        strokeWidth={4}
        strokeLinecap="round"
      />
      {aktiv && (
        <>
          <line
            className="vp-flow-line vp-flow-on"
            data-vp-kw={Math.abs(kwWert as number).toFixed(3)}
            x1={von.x}
            y1={von.y}
            x2={nach.x}
            y2={nach.y}
            stroke={farbe}
            strokeWidth={4}
          />
          <DirectionArrow from={von} to={nach} color={farbe} />
        </>
      )}
    </g>
  );
}

/** Ein runder Knoten mit Symbol. */
function Knoten({
  x,
  y,
  r,
  fill,
  stroke,
  children,
}: {
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  children: ReactNode;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth={2} />
      {children}
    </g>
  );
}

/** Ein Symbol aus dem Haus-Satz, mittig auf einen Punkt gesetzt. */
function Symbol({ name, x, y, size, color }: { name: IconName; x: number; y: number; size: number; color: string }) {
  return (
    <Icon name={name} size={size} x={x - size / 2} y={y - size / 2} style={{ color }} />
  );
}

/**
 * Zeichen, die der Haus-Satz nicht kennt - als Pfade aus Lucide (ISC, dieselbe
 * Quelle wie `designsystem/components/core/Icon`).
 */
function Zeichen({
  pfad,
  x,
  y,
  size,
  color,
  strokeWidth = 2,
}: {
  pfad: 'mast' | 'auto' | 'stecker' | 'wolke' | 'schalter';
  x: number;
  y: number;
  size: number;
  color: string;
  strokeWidth?: number;
}) {
  const d: Record<typeof pfad, ReactNode> = {
    mast: (
      <>
        <path d="M12 9v13" />
        <path d="M3 6h18" />
        <path d="M5 6l3 3" />
        <path d="M19 6l-3 3" />
        <path d="M12 2 7 6" />
        <path d="M12 2l5 4" />
        <path d="M9 22h6" />
      </>
    ),
    auto: (
      <>
        <path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" />
        <circle cx="7" cy="17" r="2" />
        <path d="M9 17h6" />
        <circle cx="17" cy="17" r="2" />
      </>
    ),
    stecker: (
      <>
        <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
        <path d="m2 22 3-3" />
        <path d="M7.5 13.5 10 11" />
        <path d="M10.5 16.5 13 14" />
        <path d="m18 3-4 4h6l-4 4" />
      </>
    ),
    wolke: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
    schalter: (
      <>
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
      </>
    ),
  };
  return (
    <svg
      x={x - size / 2}
      y={y - size / 2}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ color }}
    >
      {d[pfad]}
    </svg>
  );
}

/** Die Richtung am Netz als Wort - nie ein Vorzeichen. */
function netzWort(v: number | null): string {
  if (v == null || Math.abs(v) <= TOTBAND_KW) return '';
  return v < 0 ? ' Einspeisung' : ' Bezug';
}

/**
 * Hybrid-Wechselrichter: Sonne, Haus und Netz um den Wechselrichter, rechts
 * die Batterie mit ihrem Füllstand und der GELESENEN Reserve als Linie.
 *
 * ⚠ Haus und Netz stehen nur da, wo DIESES Gerät sie misst - zwei Striche an
 * einem Wechselrichter ohne Wandler wären keine Auskunft.
 */
function SpeicherGrafik({ w }: { w: BuehneWerte }) {
  const ref = useRef<SVGSVGElement>(null);
  useFlowTempo(ref);
  const id = useId().replace(/:/g, '');
  const innen = 104;
  const soc = w.ladestandPct == null ? null : Math.max(0, Math.min(100, w.ladestandPct));
  const fuell = soc == null ? 0 : (innen * soc) / 100;
  const reserveY = w.reservePct == null ? null : 146 - (innen * Math.max(0, Math.min(100, w.reservePct))) / 100;
  const netzAktivBezug = (w.netzKw ?? 0) > 0;
  const battLaedt = (w.batterieKw ?? 0) > 0;
  return (
    <svg
      ref={ref}
      className="vp-buehne-svg"
      viewBox="0 0 320 204"
      role="img"
      aria-label="Energiefluss am Wechselrichter: Solar, Haus, Netz und Speicher"
    >
      <defs>
        <linearGradient id={`batt-${id}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={FARBE.batt} />
          <stop offset="1" stopColor={FARBE.battLite} />
        </linearGradient>
        <clipPath id={`battclip-${id}`}>
          <rect x="216" y="40" width="76" height={innen + 4} rx="11" />
        </clipPath>
      </defs>
      <Fluss von={{ x: 62, y: 50 }} nach={{ x: 112, y: 76 }} farbe={FARBE.pv} kwWert={w.pvKw} />
      {w.hausKw != null && (
        <Fluss von={{ x: 112, y: 100 }} nach={{ x: 62, y: 124 }} farbe={FARBE.load} kwWert={w.hausKw} />
      )}
      {w.netzKw != null && (
        <Fluss
          von={netzAktivBezug ? { x: 134, y: 140 } : { x: 134, y: 108 }}
          nach={netzAktivBezug ? { x: 134, y: 108 } : { x: 134, y: 140 }}
          farbe={FARBE.grid}
          kwWert={w.netzKw}
        />
      )}
      <Fluss
        von={battLaedt ? { x: 156, y: 88 } : { x: 204, y: 88 }}
        nach={battLaedt ? { x: 204, y: 88 } : { x: 156, y: 88 }}
        farbe={FARBE.batt}
        kwWert={w.batterieKw}
      />
      <Knoten x={42} y={38} r={22} fill={FARBE.pvSoft} stroke={FARBE.pv}>
        <Symbol name="sun" x={42} y={38} size={20} color={FARBE.pv} />
      </Knoten>
      <SwapText x={42} y={78} textAnchor="middle" className="vp-buehne-wert" value={kw(w.pvKw)} />
      {w.hausKw != null && (
        <>
          <Knoten x={42} y={136} r={22} fill={FARBE.loadSoft} stroke={FARBE.load}>
            <Symbol name="home" x={42} y={136} size={20} color={FARBE.load} />
          </Knoten>
          <SwapText x={42} y={176} textAnchor="middle" className="vp-buehne-wert" value={kw(w.hausKw)} />
          {/* ⚠ Am Wechselrichter ist das Haus eine RECHNUNG, keine Messung -
              das Wort steht direkt am Wert, weil es keinen Chip mehr gibt. */}
          <text x={42} y={190} textAnchor="middle" className="vp-buehne-klein">abgeleitet</text>
        </>
      )}
      <circle cx={134} cy={88} r={21} fill="#fff" stroke={FARBE.ink} strokeWidth={1.5} />
      <Symbol name="zap" x={134} y={88} size={20} color={FARBE.ink} />
      {w.netzKw != null && (
        <>
          <Knoten x={134} y={156} r={14} fill={FARBE.gridSoft} stroke={FARBE.grid}>
            <Zeichen pfad="mast" x={134} y={156} size={16} color={FARBE.gridInk} />
          </Knoten>
          <SwapText x={134} y={186} textAnchor="middle" className="vp-buehne-wert" value={kw(w.netzKw)} />
          {netzWort(w.netzKw) && (
            <text x={134} y={199} textAnchor="middle" className="vp-buehne-klein">{netzWort(w.netzKw).trim()}</text>
          )}
        </>
      )}
      <rect x="210" y="34" width="88" height="120" rx="16" fill="#fff" stroke={FARBE.battInk} strokeWidth={2.5} />
      <rect x="238" y="24" width="32" height="10" rx="4" fill={FARBE.battInk} />
      {soc != null && (
        <g clipPath={`url(#battclip-${id})`}>
          <rect
            className="vp-buehne-morph"
            x="216"
            y={146 - fuell}
            width="76"
            height={fuell + 2}
            fill={`url(#batt-${id})`}
          />
        </g>
      )}
      {reserveY != null && (
        <line
          className="vp-buehne-morph"
          x1="216"
          x2="292"
          y1={reserveY}
          y2={reserveY}
          stroke={FARBE.battInk}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}
      {battLaedt && Math.abs(w.batterieKw ?? 0) > TOTBAND_KW && (
        <Symbol name="zap" x={254} y={86} size={26} color="#fff" />
      )}
    </svg>
  );
}

/**
 * Wechselrichter ohne Speicher und PV-Wechselrichter: der Sonnenbogen -
 * Leistung auf Nennleistung.
 *
 * ⚠ Nur mit BELEGTEM Maßstab: ohne gepflegte Nennleistung gibt es keinen
 * Bogen-Anteil und keine Prozentzahl - ein Anteil ohne Maßstab wäre erfunden.
 */
function SonneGrafik({ w }: { w: BuehneWerte }) {
  const massstab = w.kwp != null && w.kwp > 0 ? w.kwp : null;
  const pct = massstab != null && w.pvKw != null
    ? Math.max(0, Math.min(1, w.pvKw / massstab))
    : null;
  return (
    <svg
      className="vp-buehne-svg"
      viewBox="0 0 320 172"
      role="img"
      aria-label={pct != null
        ? `Erzeugung: ${Math.round(pct * 100)} Prozent der Nennleistung`
        : 'Erzeugung'}
    >
      <path d="M50 150 A110 110 0 0 1 270 150" fill="none" stroke={FARBE.base} strokeWidth={18} strokeLinecap="round" />
      {pct != null && (
        <path
          className="vp-buehne-morph"
          d="M50 150 A110 110 0 0 1 270 150"
          pathLength={100}
          fill="none"
          stroke={FARBE.pv}
          strokeWidth={18}
          strokeLinecap="round"
          strokeDasharray="100 100"
          strokeDashoffset={(100 - pct * 100).toFixed(1)}
        />
      )}
      <Symbol name="sun" x={160} y={86} size={44} color={FARBE.pv} />
      {pct != null && (
        <SwapText x={160} y={140} textAnchor="middle" className="vp-buehne-gross" value={`${Math.round(pct * 100)} %`} />
      )}
      <text x={50} y={168} textAnchor="middle" className="vp-buehne-klein">0</text>
      {massstab != null && (
        <text x={270} y={168} textAnchor="middle" className="vp-buehne-klein">{fmtNum(massstab, 'kWp')}</text>
      )}
    </svg>
  );
}

/** Ein runder Skalen-Endwert, der den Wert sicher umfasst (nie abgeschnitten). */
function skalaFuer(v: number): number {
  const betrag = Math.abs(v);
  for (const s of [5, 10, 20, 50, 100, 200, 500, 1000]) if (betrag <= s) return s;
  return Math.ceil(betrag / 1000) * 1000;
}

/**
 * Zähler: am maßgeblichen Netzanschluss Haus ⇄ Netz mit Richtungs-Punkten,
 * darunter die Waage um die Nulllinie (links Einspeisung, rechts Bezug).
 *
 * ⚠ Ein Unterzähler (K2) misst einen Abzweig, nicht „Ihre Anlage" gegen „das
 * Netz" - er bekommt nur die Waage, ohne die zwei beschrifteten Knoten.
 */
function NetzGrafik({ w }: { w: BuehneWerte }) {
  const ref = useRef<SVGSVGElement>(null);
  useFlowTempo(ref);
  const v = w.netzKw;
  const skala = v == null ? 10 : skalaFuer(v);
  const halb = 120;
  const breite = v == null ? 0 : Math.min(halb, (halb * Math.abs(v)) / skala);
  const einspeisung = v != null && v < 0;
  return (
    <svg
      ref={ref}
      className="vp-buehne-svg"
      viewBox={`0 ${w.massgeblich ? 0 : 100} 320 ${w.massgeblich ? 176 : 58}`}
      role="img"
      aria-label={w.massgeblich ? 'Richtung am Netzanschluss' : 'Richtung an diesem Zähler'}
    >
      {w.massgeblich && (
        <>
          <Fluss
            von={einspeisung ? { x: 80, y: 56 } : { x: 240, y: 56 }}
            nach={einspeisung ? { x: 240, y: 56 } : { x: 80, y: 56 }}
            farbe={FARBE.grid}
            kwWert={v}
          />
          <Knoten x={50} y={56} r={28} fill={FARBE.loadSoft} stroke={FARBE.load}>
            <Symbol name="home" x={50} y={56} size={24} color={FARBE.load} />
          </Knoten>
          <text x={50} y={102} textAnchor="middle" className="vp-buehne-klein">Ihre Anlage</text>
          <Knoten x={270} y={56} r={28} fill={FARBE.gridSoft} stroke={FARBE.grid}>
            <Zeichen pfad="mast" x={270} y={56} size={24} color={FARBE.gridInk} />
          </Knoten>
          <text x={270} y={102} textAnchor="middle" className="vp-buehne-klein">Netz</text>
        </>
      )}
      {/* Am Netzanschluss rückt die Waage unter die Knoten-Namen - ihre
          Skalen-Enden standen sonst direkt auf „Ihre Anlage" und „Netz". */}
      <g transform={w.massgeblich ? 'translate(0 18)' : undefined}>
        <rect x="40" y="118" width="240" height="12" rx="6" fill={FARBE.base} />
        {v != null && breite > 0 && (
          <rect
            className="vp-buehne-morph"
            x={einspeisung ? 160 - breite : 160}
            y="118"
            width={breite}
            height="12"
            rx="6"
            fill={einspeisung ? FARBE.grid : FARBE.gridInk}
          />
        )}
        <line x1="160" x2="160" y1="112" y2="136" stroke={FARBE.ink} strokeWidth={2} />
        <text x="40" y="152" textAnchor="start" className="vp-buehne-klein">← Einspeisung</text>
        <text x="160" y="152" textAnchor="middle" className="vp-buehne-klein">0</text>
        <text x="280" y="152" textAnchor="end" className="vp-buehne-klein">Bezug →</text>
        <text x="40" y="112" textAnchor="start" className="vp-buehne-klein">{fmtNum(skala, 'kW', 0)}</text>
        <text x="280" y="112" textAnchor="end" className="vp-buehne-klein">{fmtNum(skala, 'kW', 0)}</text>
      </g>
    </svg>
  );
}

/**
 * Verbraucher: die Leitung hinein und das Gerät, das leuchtet, wenn es läuft.
 *
 * ⚠ Punkte laufen nur mit GEMESSENER Leistung - ein Relais, das nur „ein"
 * meldet, sagt nichts über ein Tempo. Eine SG-Ready-Freigabe misst gar nichts:
 * sie leuchtet als „gesetzt", ohne Fluss.
 */
function VerbraucherGrafik({ w, freigabe }: { w: BuehneWerte; freigabe: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  useFlowTempo(ref);
  const an = w.laeuft === true;
  const unbekannt = w.laeuft == null;
  return (
    <svg
      ref={ref}
      className="vp-buehne-svg"
      viewBox="0 0 320 150"
      role="img"
      aria-label={unbekannt ? 'Zustand unbekannt' : an ? (freigabe ? 'Freigabe gesetzt' : 'Läuft') : 'Aus'}
    >
      <Fluss von={{ x: 74, y: 75 }} nach={{ x: 152, y: 75 }} farbe={FARBE.load} kwWert={freigabe ? null : w.verbraucherKw} />
      <circle cx={52} cy={75} r={20} fill="#fff" stroke={FARBE.ink} strokeWidth={2} />
      <Symbol name="zap" x={52} y={75} size={18} color={FARBE.ink} />
      {an && <circle cx={206} cy={75} r={62} fill={FARBE.load} opacity={0.18} />}
      <circle
        cx={206}
        cy={75}
        r={48}
        fill={an ? FARBE.loadSoft : 'var(--vp-bg-light, #f8f9fa)'}
        stroke={an ? FARBE.load : FARBE.aus}
        strokeWidth={3}
        strokeDasharray={unbekannt ? '6 6' : undefined}
      />
      {freigabe
        ? <Symbol name={an ? 'check' : 'shield'} x={206} y={75} size={40} color={an ? FARBE.load : FARBE.aus} />
        : <Zeichen pfad="schalter" x={206} y={75} size={40} color={an ? FARBE.load : FARBE.aus} />}
    </svg>
  );
}

/** Wallbox: Säule, Kabel, Auto - die Punkte laufen ins Auto, solange es lädt. */
function WallboxGrafik({ kw: leistung, laedt }: { kw: number | null; laedt: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  useFlowTempo(ref);
  return (
    <svg
      ref={ref}
      className="vp-buehne-svg"
      viewBox="0 0 320 150"
      role="img"
      aria-label={laedt ? 'Die Wallbox lädt das Fahrzeug' : 'Die Wallbox lädt gerade nicht'}
    >
      <Fluss von={{ x: 78, y: 104 }} nach={{ x: 196, y: 104 }} farbe={FARBE.batt} kwWert={laedt ? leistung : null} />
      <rect x="24" y="22" width="52" height="100" rx="12" fill={FARBE.battSoft} stroke={FARBE.battInk} strokeWidth={2.5} />
      <rect x="34" y="34" width="32" height="18" rx="4" fill="#fff" stroke={FARBE.battInk} strokeWidth={1.5} />
      <Zeichen pfad="stecker" x={50} y={78} size={24} color={FARBE.battInk} />
      <Zeichen pfad="auto" x={246} y={88} size={104} color={laedt ? FARBE.ink : FARBE.aus} strokeWidth={1.25} />
    </svg>
  );
}

/**
 * Die Box: Geräte → Box → VoltPilot. Die Punkte laufen, solange die Box
 * verbunden ist - sie stehen für die Verbindung, nicht für eine Leistung, und
 * laufen deshalb im Ruhetempo des Energieflusses.
 */
function BoxGrafik({ verbunden, geraete }: { verbunden: boolean; geraete: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useFlowTempo(ref);
  const ruhe = verbunden ? 0.1 : null;
  return (
    <svg
      ref={ref}
      className="vp-buehne-svg"
      viewBox="0 0 320 130"
      role="img"
      aria-label={verbunden ? 'Geräte, Box und VoltPilot sind verbunden' : 'Die Box ist gerade nicht verbunden'}
    >
      <Fluss von={{ x: 78, y: 60 }} nach={{ x: 128, y: 60 }} farbe={FARBE.box} kwWert={ruhe} />
      <Fluss von={{ x: 192, y: 60 }} nach={{ x: 242, y: 60 }} farbe={FARBE.box} kwWert={ruhe} />
      <circle cx={50} cy={60} r={28} fill="var(--vp-bg-light, #f8f9fa)" stroke={FARBE.box} strokeWidth={2} />
      <text x={50} y={68} textAnchor="middle" className="vp-buehne-gross">{String(geraete)}</text>
      <text x={50} y={108} textAnchor="middle" className="vp-buehne-klein">{geraete === 1 ? 'Gerät' : 'Geräte'}</text>
      <rect x="130" y="30" width="60" height="60" rx="16" fill="#fff" stroke={FARBE.box} strokeWidth={2.5} />
      <Symbol name="cpu" x={160} y={60} size={28} color={FARBE.box} />
      <text x={160} y={108} textAnchor="middle" className="vp-buehne-klein">Box</text>
      <circle cx={270} cy={60} r={28} fill="var(--vp-bg-light, #f8f9fa)" stroke={verbunden ? FARBE.box : FARBE.aus} strokeWidth={2} />
      <Zeichen pfad="wolke" x={270} y={60} size={28} color={verbunden ? FARBE.box : FARBE.aus} />
      <text x={270} y={108} textAnchor="middle" className="vp-buehne-klein">VoltPilot</text>
    </svg>
  );
}
