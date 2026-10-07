import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  abweichungsGrafik,
  spaltenGrafik,
  zielSkala,
  zusammenGrafik,
  type AchsenText,
  type SaeulenArt,
} from '../auswertenGrafik';
import './AuswertenGrafik.css';

/**
 * Die Grafiken der Seite einer Kennzahl (Konzept Auswerten a1 §6.12): Abweichung je Monat, Monatssäulen mit Vorjahr,
 * Zusammengezählt und das Energieziel auf einer Skala. Das SVG trägt nur Marken; Achse, Monate und Jahre stehen als HTML
 * daneben (am Handy lesbar, nie aus dem Rahmen). Die Geometrie ist rein (`auswertenGrafik.ts`).
 *
 * Wahl eines Monats (§6.12 „Antippen und Ziehen“): die ganze Grafikfläche ist Tippziel, Ziehen mit dem Finger wechselt
 * den Monat, am Rechner die Pfeiltasten; die Infozeile darüber zeigt ihn - nichts legt sich über die Säulen.
 */

export interface GrafikMonat {
  periode: string;
  kurz: string;
}

interface Wahl {
  gewaehlt: number;
  onWahl: (i: number) => void;
  /** Was die Infozeile gerade sagt - der Wert des Schiebers für Vorlesen. */
  wahlText: string;
}

function Achse({ texte }: { texte: AchsenText[] }) {
  return (
    <div className="vp-graf-y" aria-hidden="true">
      {/* Unsichtbare Kopien aller Texte geben der Spalte ihre Breite. */}
      {texte.map((t) => (
        <span key={`m-${t.text}`} className={`vp-graf-mass${t.wort ? ' is-wort' : ''}`}>
          {t.text}
        </span>
      ))}
      {texte.map((t) => (
        <span key={t.text} className={`vp-graf-at is-${t.art}${t.wort ? ' is-wort' : ''}`} style={{ top: `${t.oben.toFixed(2)}%` }}>
          {t.text}
        </span>
      ))}
    </div>
  );
}

function Monate({ monate, gewaehlt }: { monate: readonly GrafikMonat[]; gewaehlt: number | null }) {
  const spalten = { gridTemplateColumns: `repeat(${monate.length}, minmax(0, 1fr))` };
  // Die Jahreszahl unter dem ersten Monat und unter jedem Januar.
  const jahre = monate
    .map((m, i) => ({ i, jahr: m.periode.slice(0, 4), start: i === 0 || m.periode.endsWith('-01') }))
    .filter((j) => j.start);
  return (
    <>
      <div className="vp-graf-x" aria-hidden="true" style={spalten}>
        {monate.map((m, i) => (
          <span key={m.periode} className={i === gewaehlt ? 'is-wahl' : undefined}>
            <span className="vp-graf-ml">{m.kurz}</span>
            <span className="vp-graf-mk">{m.kurz.slice(0, 1)}</span>
          </span>
        ))}
      </div>
      <div className="vp-graf-j" aria-hidden="true" style={spalten}>
        {jahre.map((j, k) => (
          <span key={j.jahr + j.i} style={{ gridColumn: `${j.i + 1} / ${(jahre[k + 1]?.i ?? monate.length) + 1}` }}>
            {j.jahr}
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * Der Rahmen jeder Monatsgrafik: Achse links, Zeichenfläche, Monate und Jahre darunter. Mit `wahl` ist die ganze Fläche
 * ein Schieber (Tippen, Ziehen, Pfeiltasten); ohne ist sie ein Bild mit `titel` als Bezeichnung.
 */
function Rahmen({
  titel,
  achse,
  monate,
  breite,
  hoehe,
  wahl,
  klasse,
  notiz,
  children,
}: {
  titel: string;
  achse: AchsenText[];
  monate: readonly GrafikMonat[];
  breite: number;
  hoehe: number;
  wahl?: Wahl;
  klasse: string;
  notiz?: ReactNode;
  children: ReactNode;
}) {
  const flaeche = useRef<HTMLDivElement>(null);
  const n = monate.length;
  const aus = (e: PointerEvent<HTMLDivElement>) => {
    const r = flaeche.current?.getBoundingClientRect();
    if (!r || r.width === 0 || n === 0) return null;
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
  };
  const zeiger = wahl
    ? {
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const i = aus(e);
          if (i !== null) wahl.onWahl(i);
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
          if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return;
          const i = aus(e);
          if (i !== null && i !== wahl.gewaehlt) wahl.onWahl(i);
        },
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          const ziel =
            e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? wahl.gewaehlt - 1
              : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? wahl.gewaehlt + 1
                : e.key === 'Home' ? 0
                  : e.key === 'End' ? n - 1
                    : null;
          if (ziel === null) return;
          e.preventDefault();
          wahl.onWahl(Math.max(0, Math.min(n - 1, ziel)));
        },
      }
    : {};
  const rolle = wahl
    ? {
        role: 'slider',
        tabIndex: 0,
        'aria-label': titel,
        'aria-valuemin': 1,
        'aria-valuemax': n,
        'aria-valuenow': wahl.gewaehlt + 1,
        'aria-valuetext': wahl.wahlText,
      }
    : { role: 'img', 'aria-label': titel };
  return (
    <div className={`vp-graf ${klasse}${wahl ? ' is-wahl' : ''}`} {...rolle} {...zeiger}>
      <Achse texte={achse} />
      <div className="vp-graf-p" ref={flaeche}>
        <svg viewBox={`0 0 ${breite} ${hoehe.toFixed(1)}`} aria-hidden="true" focusable="false">
          {children}
        </svg>
        {notiz}
      </div>
      <Monate monate={monate} gewaehlt={wahl ? wahl.gewaehlt : null} />
    </div>
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Abweichung je Monat um die Nulllinie (§6.12): oben mehr als erwartet, unten weniger, grau das Band „im Rahmen“. */
export function AbweichungsGrafik({
  titel,
  monate,
  bandProzent,
  dicht = false,
  ...wahl
}: {
  titel: string;
  monate: readonly (GrafikMonat & { delta: string | null; art: SaeulenArt })[];
  bandProzent: string | null;
  dicht?: boolean;
} & Wahl) {
  const g = abweichungsGrafik(monate, bandProzent, dicht ? { breite: 560, flaeche: 168, dicht } : {});
  const w = g.saeulen[wahl.gewaehlt];
  return (
    <Rahmen titel={titel} achse={g.achse} monate={monate} breite={g.breite} hoehe={g.hoehe} wahl={wahl} klasse="is-abw">
      <rect className="vp-graf-band" x={0} y={r1(g.band.y)} width={g.breite} height={r1(g.band.hoehe)} />
      {g.linien.map((l) => (
        <line key={l.y} className={l.istNull ? 'vp-graf-null' : 'vp-graf-linie'} x1={0} x2={g.breite} y1={r1(l.y)} y2={r1(l.y)} />
      ))}
      {g.saeulen.map((s) =>
        s.leer ? (
          <rect key={s.periode} className="vp-graf-leer" x={r1(s.leer.x)} y={r1(s.leer.y)} width={r1(s.leer.w)} height={r1(s.leer.h)} rx={3} />
        ) : (
          <path key={s.periode} className={`vp-graf-s is-${s.art}`} d={s.pfad ?? ''} />
        ),
      )}
      {w && <rect className="vp-graf-wahl" x={r1(w.x - 2)} y={r1(g.wahl.y)} width={r1(w.w + 4)} height={r1(g.wahl.h)} rx={5} />}
    </Rahmen>
  );
}

/** Monatssäulen ab null mit dem Vorjahr als Punkt (§6.12) - ohne Urteilsfarbe. */
export function SpaltenGrafik({
  titel,
  monate,
  ...wahl
}: {
  titel: string;
  monate: readonly (GrafikMonat & { wert: string | null; vorjahr: string | null })[];
} & Wahl) {
  const g = spaltenGrafik(
    monate.map((m) => m.wert),
    monate.map((m) => m.vorjahr),
  );
  const w = g.saeulen[wahl.gewaehlt];
  return (
    <Rahmen titel={titel} achse={g.achse} monate={monate} breite={g.breite} hoehe={g.hoehe} wahl={wahl} klasse="is-spalten">
      {g.linien.map((l) => (
        <line key={l.y} className="vp-graf-linie" x1={0} x2={g.breite} y1={r1(l.y)} y2={r1(l.y)} />
      ))}
      <line className="vp-graf-null" x1={0} x2={g.breite} y1={r1(g.nullY)} y2={r1(g.nullY)} />
      {g.saeulen.map((s, i) =>
        s.leer ? (
          <rect key={monate[i].periode} className="vp-graf-leer" x={r1(s.leer.x)} y={r1(s.leer.y)} width={r1(s.leer.w)} height={r1(s.leer.h)} rx={3} />
        ) : (
          <path key={monate[i].periode} className={`vp-graf-s is-wert${i === wahl.gewaehlt ? ' is-gewaehlt' : ''}`} d={s.pfad ?? ''} />
        ),
      )}
      {g.punkte.map((p, i) => (p ? <circle key={`vj-${monate[i].periode}`} className="vp-graf-vorjahr" cx={p.x} cy={p.y} r={3.6} /> : null))}
      {w && <rect className="vp-graf-wahl" x={r1(w.x - 2)} y={r1(g.wahl.y)} width={r1(w.w + 4)} height={r1(g.wahl.h)} rx={5} />}
    </Rahmen>
  );
}

/** „Zusammengezählt“ (nur am Rechner): die Abweichungen der Monate mit Urteil als Linie, der Endwert beschriftet. */
export function ZusammenGrafik({
  titel,
  monate,
  endText,
  ton,
}: {
  titel: string;
  monate: readonly (GrafikMonat & { zusammen: string | null })[];
  endText: string;
  ton: 'warn' | 'ok';
}) {
  const g = zusammenGrafik(monate.map((m) => m.zusammen));
  return (
    <Rahmen
      titel={titel}
      achse={g.achse}
      monate={monate}
      breite={g.breite}
      hoehe={g.hoehe}
      klasse={`is-zusammen is-${ton}`}
      notiz={
        g.ende && (
          <span className="vp-graf-notiz" style={{ left: `${g.ende.links.toFixed(2)}%`, top: `${g.ende.oben.toFixed(2)}%` }}>
            {endText}
          </span>
        )
      }
    >
      {g.linien.map((l) => (
        <line key={l.y} className={l.istNull ? 'vp-graf-null' : 'vp-graf-linie'} x1={0} x2={g.breite} y1={r1(l.y)} y2={r1(l.y)} />
      ))}
      {g.strecken.map((s) => (
        <g key={s.linie}>
          <path className="vp-graf-flaeche" d={s.flaeche} />
          <polyline className="vp-graf-kurve" points={s.linie} />
        </g>
      ))}
      {g.ende && <circle className="vp-graf-ende" cx={g.ende.x} cy={g.ende.y} r={4.5} />}
    </Rahmen>
  );
}

/** Das Energieziel auf einer Skala (§6.12): mehr links, weniger rechts, die Bezugsbasis in der Mitte, Ziel als Strich. */
export function ZielSkala({
  jetzt,
  jetztText,
  ziel,
  zielText,
  mitte,
  links,
  rechts,
  ton,
}: {
  jetzt: string | null;
  jetztText: string | null;
  ziel: string;
  zielText: string;
  mitte: string;
  links: string;
  rechts: string;
  ton: 'warn' | 'ok' | 'neutral' | null;
}) {
  const s = zielSkala(jetzt, ziel);
  const titel = [jetztText ? `Energieziel auf einer Skala: ${jetztText}` : 'Energieziel auf einer Skala', zielText, `${mitte} in der Mitte`].join(', ');
  return (
    <div className="vp-skala" role="img" aria-label={titel}>
      <div className="vp-skala-o" aria-hidden="true">
        {s.texte.jetzt && jetztText && (
          <span className={`is-${s.texte.jetzt.anker}`} style={{ left: `${s.texte.jetzt.links.toFixed(2)}%` }}>
            {jetztText}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${s.breite} ${s.hoehe}`} aria-hidden="true" focusable="false">
        <rect className="vp-skala-spur" x={s.spur.x} y={8} width={s.spur.w} height={8} rx={4} />
        <rect className="vp-skala-weg" x={r1(s.weg.x)} y={8} width={r1(s.weg.w)} height={8} />
        <line className="vp-skala-mitte" x1={r1(s.mitte)} x2={r1(s.mitte)} y1={3} y2={21} />
        <line className="vp-skala-ziel" x1={r1(s.ziel)} x2={r1(s.ziel)} y1={2} y2={22} />
        {s.jetzt !== null && <circle className={`vp-skala-jetzt is-${ton ?? 'neutral'}`} cx={r1(s.jetzt)} cy={12} r={7} />}
      </svg>
      <div className="vp-skala-m" aria-hidden="true">
        <span className={`is-${s.texte.mitte.anker}`} style={{ left: `${s.texte.mitte.links.toFixed(2)}%` }}>
          {mitte}
        </span>
        <span className={`is-${s.texte.ziel.anker} is-ziel`} style={{ left: `${s.texte.ziel.links.toFixed(2)}%` }}>
          {zielText}
        </span>
      </div>
      <div className="vp-skala-u" aria-hidden="true">
        <span>{links}</span>
        <span>{rechts}</span>
      </div>
    </div>
  );
}

/** Die Infozeile über einer Grafik: immer ein Monat, mit Wert, Erwartung und Urteil in Worten (nie nur Farbe). */
export function Infozeile({
  monat,
  wert,
  statt,
  urteil,
}: {
  monat: string;
  wert: string | null;
  statt: string | null;
  urteil: { text: string; ton: 'warn' | 'ok' | 'neutral' | 'leise' } | null;
}) {
  return (
    <div className="vp-info" data-testid="grafik-infozeile">
      <b>{monat}</b>
      {wert && <span className="vp-info-w">{wert}</span>}
      {statt && <span>{statt}</span>}
      {urteil && <span className={`vp-info-u is-${urteil.ton}`}>{urteil.text}</span>}
    </div>
  );
}

/** Die Legende mit Wörtern: Farbe und Lage sagen dasselbe wie das Wort (§6.12 „zugänglich“). */
export function Legende({ eintraege }: { eintraege: { text: string; art: string }[] }) {
  return (
    <div className="vp-legende">
      {eintraege.map((e) => (
        <span key={e.text}>
          <i className={`is-${e.art}`} aria-hidden="true" />
          {e.text}
        </span>
      ))}
    </div>
  );
}
