import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { ForecastValue, ScheduleSlot } from '../api';
import { chartTheme } from '../chartTheme';
import { withAlpha } from '../chartStyle';
import { batteryDirection } from '../control';
import {
  mengenSatz,
  morgenSatz,
  reichtSatz,
  uebrigSatz,
  verbrauchsSpitzeSatz,
  type PrognoseModell,
  type TeppichStunde,
  type TeppichTag,
} from '../prognoseSeite';
import { useContainerWidth } from '../useContainerWidth';
import { HIMMEL_WORT } from '../wetterTag';
import { WetterSymbol } from './WetterTag';
import './PreisZeitstrahl.css';
import './PrognoseTeppich.css';

/**
 * Die Bausteine des Sonnen-Teppichs (Konzept „Prognosen", E1 = C vom
 * 11.11.2026, Bericht Abschnitt 6.1/7). Sie rechnen nichts - jede Zahl kommt
 * aus `prognoseSeite.ts`. Antwort und Kopfzeile folgen dem Aufbau der
 * Preis-/Wetter-Seite (`vp-pz-*`-Klassen), Teppich, Balken und Streifen sind
 * neu.
 */

const kwh0 = (v: number) => Math.round(v).toLocaleString('de-DE');
const uhr = (ms: number) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const VIERTEL_MS = 15 * 60_000;

function InfoKnopf({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="vp-pz-info" aria-label="Woher die Werte kommen" onClick={onClick}>
      <Icon name="info" size={18} />
    </button>
  );
}

/* ===========================================================================
 * Die Antwort oben: Kopfsatz + zwei Balken
 * ========================================================================= */

/**
 * Ein Balken je Größe (Sonne, Verbrauch) auf einer GEMEINSAMEN kWh-Skala -
 * "der längere Balken gewinnt, ohne dass jemand Zahlen vergleichen muss"
 * (Bericht 6.1). Erwartet schraffiert über die ganze Tagesmenge, gemessen
 * voll bis zu "schon erzeugt/verbraucht".
 */
function Balken({
  titel,
  kwh,
  bisherKwh,
  bisherWort,
  max,
  farbe,
}: {
  titel: string;
  kwh: number | null;
  bisherKwh: number | null;
  bisherWort: string;
  max: number;
  farbe: string;
}) {
  const pct = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  return (
    <div className="vp-pt-balken-zeile">
      <span className="vp-pt-balken-titel">{titel}</span>
      <span className="vp-pt-balken-spur" aria-hidden="true">
        {kwh != null && (
          <i
            className="vp-pt-balken-erwartet"
            style={{
              width: `${pct(kwh)}%`,
              background: withAlpha(farbe, 0.18),
              backgroundImage: `repeating-linear-gradient(45deg, ${farbe} 0 1.5px, transparent 1.5px 5px)`,
            }}
          />
        )}
        {bisherKwh != null && bisherKwh > 0.05 && (
          <i className="vp-pt-balken-gemessen" style={{ width: `${pct(bisherKwh)}%`, background: withAlpha(farbe, 0.85) }} />
        )}
      </span>
      <span className="vp-pt-balken-zahl">{kwh != null ? <>≈ {kwh0(kwh)} kWh</> : '–'}</span>
      {bisherKwh != null && bisherKwh >= 0.5 && <span className="vp-pt-balken-sub">{kwh0(bisherKwh)} {bisherWort}</span>}
    </div>
  );
}

/**
 * Kopfsatz, Mengensatz, der Tipp (am Rechner) oder die Morgen-Zeile (ohne
 * PV) und zwei Balken für heute. Ohne PV bleibt nur der Verbrauchs-Balken
 * (E6 = B) - keine erfundene Sonnen-Zahl für eine Anlage ohne PV.
 */
export function PrognoseAntwort({
  m,
  heute,
  morgen,
  zeigeTipp,
  onInfo,
}: {
  m: PrognoseModell;
  heute: TeppichTag;
  morgen: TeppichTag | undefined;
  /** Der Tipp steht am Rechner in der Antwort, am Telefon über dem Bild (Bericht 6.1). */
  zeigeTipp: boolean;
  onInfo: () => void;
}) {
  const t = chartTheme();
  const satz = m.mitPv ? reichtSatz(heute) : verbrauchsSpitzeSatz(heute) ?? 'Noch keine Prognose für heute';
  const mengen = m.mitPv ? mengenSatz(heute.sonneKwh, heute.verbrauchKwh) : null;
  const tipp = m.mitPv && zeigeTipp ? uebrigSatz(heute) : null;
  const morgenZeile = !m.mitPv ? morgenSatz(morgen, false) : null;
  const max = Math.max(heute.sonneKwh ?? 0, heute.verbrauchKwh ?? 0, 0.1);

  return (
    <>
      <div className="vp-pz-label">
        <span>Prognose am Standort · jetzt {uhr(m.jetztMs)}</span>
        <InfoKnopf onClick={onInfo} />
      </div>
      <div className="vp-pt-kopfsatz">
        <b>{satz}</b>
        {mengen && <span>{mengen}</span>}
      </div>
      {morgenZeile && <p className="vp-pt-morgen">{morgenZeile}</p>}
      <div className="vp-pt-balken">
        {m.mitPv && (
          <Balken titel="Sonne" kwh={heute.sonneKwh} bisherKwh={heute.sonneBisherKwh} bisherWort="schon erzeugt" max={max} farbe={t.pv} />
        )}
        <Balken
          titel="Verbrauch"
          kwh={heute.verbrauchKwh}
          bisherKwh={heute.verbrauchBisherKwh}
          bisherWort="schon verbraucht"
          max={max}
          farbe={t.consumer}
        />
      </div>
      {tipp && <p className="vp-pt-tipp">{tipp}</p>}
    </>
  );
}

/** Der Tipp über dem Bild von heute, am Telefon (Bericht 6.1 Baustein 3). */
export function PrognoseTippPhone({ m, heute }: { m: PrognoseModell; heute: TeppichTag }) {
  if (!m.mitPv) return null;
  return <p className="vp-pt-tipp vp-pt-tipp-telefon">{uebrigSatz(heute)}</p>;
}

/* ===========================================================================
 * Der Teppich: 7 Tage × Stunden
 * ========================================================================= */

/**
 * Ein Tag je Zeile, eine Stunde je Spalte - Farbtiefe ist die Leistung
 * relativ zum stärksten Stunden-Mittel der Woche (`m.massstab`). Mit PV
 * färbt die Sonne orange, ohne PV der Verbrauch violett (Bericht 6.3: „ohne
 * PV trägt der Teppich violette Säulen"). Ab übermorgen (E3 = A) blasst die
 * Zeile - ein Ausblick, kein Versprechen.
 */
export function Teppich({
  m,
  gewaehlt,
  onWahl,
}: {
  m: PrognoseModell;
  gewaehlt: number;
  onWahl: (i: number) => void;
}) {
  const t = chartTheme();
  const farbe = m.mitPv ? t.pv : t.consumer;
  const stunden = Array.from(new Set(m.tage.flatMap((tag) => tag.stunden.map((s) => new Date(s.start).getHours())))).sort(
    (a, b) => a - b,
  );
  if (stunden.length === 0) return null;
  const spalten = Array.from({ length: stunden[stunden.length - 1] - stunden[0] + 1 }, (_, i) => stunden[0] + i);
  const raster = `72px repeat(${spalten.length}, minmax(0, 1fr))`;

  return (
    <div className="vp-pt-teppich" role="group" aria-label="Sonne und Verbrauch, die nächsten Tage">
      <div className="vp-pt-zeile vp-pt-kopfzeile" style={{ gridTemplateColumns: raster }} aria-hidden="true">
        <span />
        {spalten.map((h) => (
          <span key={h} className="vp-pt-stunde">
            {h}
          </span>
        ))}
      </div>
      {m.tage.map((tag, i) => {
        const wert = m.mitPv ? 'sonneKw' : 'verbrauchKw';
        return (
          <button
            key={tag.beginn}
            type="button"
            className={`vp-pt-zeile vp-pt-tagzeile${gewaehlt === i ? ' is-gewaehlt' : ''}${tag.ausblick ? ' is-ausblick' : ''}`}
            style={{ gridTemplateColumns: raster }}
            aria-pressed={gewaehlt === i}
            aria-label={`${tag.wort}${tag.art ? `, ${HIMMEL_WORT[tag.art]}` : ''}${tag.ausblick ? ', Ausblick' : ''}`}
            onClick={() => onWahl(i)}
          >
            <span className="vp-pt-tag-name">
              <WetterSymbol art={tag.art} groesse={16} />
              {tag.wort}
            </span>
            {spalten.map((h) => {
              const s = tag.stunden.find((x) => new Date(x.start).getHours() === h);
              const v = s?.[wert];
              const intensitaet = v != null ? Math.min(1, v / m.massstab) : 0;
              return (
                <span
                  key={h}
                  className={`vp-pt-zelle${s?.deckt ? ' is-deckt' : ''}`}
                  style={v != null ? { background: withAlpha(farbe, 0.12 + intensitaet * 0.68) } : undefined}
                />
              );
            })}
          </button>
        );
      })}
      {m.mitPv && (
        <p className="vp-pt-hinweis">
          <span className="vp-pt-punkt" aria-hidden="true" /> Sonne deckt den Verbrauch dieser Stunde
        </p>
      )}
    </div>
  );
}

/* ===========================================================================
 * Die Streifen unter dem Bild: "Sonne reicht" und "Speicher"
 * ========================================================================= */

function Streifen({
  titel,
  von,
  bis,
  markVon,
  markBis,
  farbe,
}: {
  titel: string;
  von: number;
  bis: number;
  markVon: number | null;
  markBis: number | null;
  farbe: string;
}) {
  const spanne = Math.max(1, bis - von);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - von) / spanne) * 100));
  return (
    <div className="vp-pt-streifen">
      <span className="vp-pt-streifen-titel">{titel}</span>
      <span className="vp-pt-streifen-spur" aria-hidden="true">
        {markVon != null && markBis != null && (
          <i style={{ left: `${pct(markVon)}%`, width: `${Math.max(1, pct(markBis) - pct(markVon))}%`, background: farbe }} />
        )}
      </span>
    </div>
  );
}

/** Streifen "Sonne reicht HH:MM–HH:MM" mit dem Deckungs-Fenster des Tages. */
export function SonneReichtStreifen({ tag, von, bis }: { tag: TeppichTag; von: number; bis: number }) {
  const t = chartTheme();
  return <Streifen titel={reichtSatz(tag)} von={von} bis={bis} markVon={tag.reicht?.von ?? null} markBis={tag.reicht?.bis ?? null} farbe={t.pv} />;
}

/**
 * Streifen "Speicher lädt / gibt ab" aus dem Fahrplan (nur mit Speicher,
 * Bericht 7: „in der Prognose nur ein Streifen"). Reicht nur so weit wie der
 * Fahrplan selbst (kein Plan jenseits dessen Horizont = kein Streifen -
 * "Fehlend ist keine Null").
 */
export function SpeicherStreifen({ slots, von, bis }: { slots: readonly ScheduleSlot[]; von: number; bis: number }) {
  const t = chartTheme();
  const spanne = Math.max(1, bis - von);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - von) / spanne) * 100));
  const runs: { start: number; ende: number; richtung: 'laden' | 'entladen' }[] = [];
  for (const s of slots) {
    const start = Date.parse(s.start);
    if (!Number.isFinite(start) || start < von || start >= bis) continue;
    const richtung = batteryDirection(s.batteryKw);
    if (richtung === 'pausieren') continue;
    const ende = start + VIERTEL_MS;
    const letzter = runs[runs.length - 1];
    if (letzter && letzter.richtung === richtung && letzter.ende === start) letzter.ende = ende;
    else runs.push({ start, ende, richtung });
  }
  if (runs.length === 0) return null;
  return (
    <div className="vp-pt-streifen">
      <span className="vp-pt-streifen-titel">Speicher</span>
      <span className="vp-pt-streifen-spur" aria-hidden="true">
        {runs.map((r, i) => (
          <i
            key={i}
            style={{
              left: `${pct(r.start)}%`,
              width: `${Math.max(1, pct(r.ende) - pct(r.start))}%`,
              background: r.richtung === 'laden' ? t.charge : t.discharge,
            }}
          />
        ))}
      </span>
    </div>
  );
}

/* ===========================================================================
 * Das Tagesbild: Stunde für Stunde
 * ========================================================================= */

interface Punkt {
  stunde: number;
  v: number;
  herkunft: 'gemessen' | 'erwartet';
}

function punkteAus(stunden: readonly TeppichStunde[], feld: 'sonneKw' | 'verbrauchKw'): Punkt[] {
  return stunden
    .filter((s) => s[feld] != null)
    .map((s) => ({ stunde: new Date(s.start).getHours(), v: s[feld] as number, herkunft: s.herkunft }));
}

/** Vorabend-Werte (gestern erwartet) für die bereits vergangenen Stunden - nur heute, nur am Rechner. */
function vorabendPunkte(werte: readonly ForecastValue[], tagBeginn: number, jetztMs: number): Punkt[] {
  return werte
    .map((w) => ({ stunde: new Date(Date.parse(w.ts)).getHours(), ms: Date.parse(w.ts), v: w.valueKw }))
    .filter((w) => Number.isFinite(w.ms) && w.ms >= tagBeginn && w.ms < jetztMs && w.v != null)
    .map((w) => ({ stunde: w.stunde, v: w.v as number, herkunft: 'erwartet' as const }));
}

/**
 * Sonne und Verbrauch des gewählten Tages: Sonne als Fläche (gemessen
 * gefüllt, erwartet schraffiert), Verbrauch als Stufenlinie im Stundenmittel
 * (Bericht 6.1 Baustein 3) - ohne PV trägt die Fläche den Verbrauch allein.
 * Am Rechner steht links von Jetzt gepunktet, was am Vorabend erwartet war.
 */
export function PrognoseTagesBild({
  m,
  tag,
  breit,
  vorabend,
}: {
  m: PrognoseModell;
  tag: TeppichTag;
  breit: boolean;
  vorabend?: { pvKw: readonly ForecastValue[]; loadKw: readonly ForecastValue[] } | null;
}): ReactNode {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const t = chartTheme();
  const istHeute = tag === m.tage[0];

  if (tag.stunden.length === 0) {
    return <p className="vp-pz-ohne">Für diesen Tag liegt noch keine Prognose vor.</p>;
  }

  const stundenDesTages = tag.stunden.map((s) => new Date(s.start).getHours());
  const vonStunde = Math.min(...stundenDesTages);
  const bisStunde = Math.max(...stundenDesTages);
  const n = bisStunde - vonStunde + 1;

  const W = Math.max(240, Math.round(breite || 0));
  const padL = breit ? 46 : 36;
  const padR = 6;
  const plotH = breit ? 220 : 140;
  const oben = 8;
  const basis = oben + plotH;
  const H = basis + 22;
  const schritt = (W - padL - padR) / n;
  const X = (stunde: number) => padL + (stunde - vonStunde) * schritt;

  const sonnePunkte = m.mitPv ? punkteAus(tag.stunden, 'sonneKw') : [];
  const verbrauchPunkte = punkteAus(tag.stunden, 'verbrauchKw');
  const flaechenPunkte = m.mitPv ? sonnePunkte : verbrauchPunkte;
  const flaechenFarbe = m.mitPv ? t.pv : t.consumer;

  const alleWerte = [...sonnePunkte, ...verbrauchPunkte].map((p) => p.v);
  const max = Math.max(0, ...alleWerte);
  const tick = max > 6 ? 2 : 1;
  const ymax = Math.max(tick * 2, Math.ceil((max * 1.12) / tick) * tick);
  const Y = (v: number) => basis - (v / ymax) * plotH;
  const mitte = (stunde: number) => X(stunde) + schritt / 2;

  // --- Die Fläche (Sonne mit PV, sonst Verbrauch allein) -------------------
  const gemessenF = flaechenPunkte.filter((p) => p.herkunft === 'gemessen');
  const ersterErwartetF = flaechenPunkte.findIndex((p) => p.herkunft === 'erwartet');
  const erwartetF = ersterErwartetF >= 0 ? flaechenPunkte.slice(Math.max(0, ersterErwartetF - (gemessenF.length ? 1 : 0))) : [];
  const flaeche = (punkte: Punkt[]) => {
    if (punkte.length < 2) return null;
    const a = mitte(punkte[0].stunde).toFixed(1);
    const b = mitte(punkte[punkte.length - 1].stunde).toFixed(1);
    const linie = punkte.map((p) => `${mitte(p.stunde).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    return { poly: `${a},${basis} ${linie} ${b},${basis}`, linie };
  };
  const fGemessen = flaeche(gemessenF);
  const fErwartet = flaeche(erwartetF);

  // --- Die Stufenlinie (Verbrauch, nur mit PV - sonst ist sie die Fläche) --
  const stufenPfade = (punkte: Punkt[]): { d: string; erwartet: boolean }[] => {
    const laeufe: { d: string; erwartet: boolean }[] = [];
    let d = '';
    let aktuellErwartet = false;
    let letzteStunde = -2;
    for (const p of punkte) {
      const x0 = X(p.stunde);
      const x1 = x0 + schritt;
      const y = Y(p.v).toFixed(1);
      const neu = p.stunde !== letzteStunde + 1 || p.herkunft === 'erwartet' !== aktuellErwartet;
      if (neu) {
        if (d) laeufe.push({ d, erwartet: aktuellErwartet });
        d = `M${x0.toFixed(1)},${y} L${x1.toFixed(1)},${y}`;
        aktuellErwartet = p.herkunft === 'erwartet';
      } else {
        d += ` L${x0.toFixed(1)},${y} L${x1.toFixed(1)},${y}`;
      }
      letzteStunde = p.stunde;
    }
    if (d) laeufe.push({ d, erwartet: aktuellErwartet });
    return laeufe;
  };
  const verbrauchStufen = m.mitPv ? stufenPfade(verbrauchPunkte) : [];

  // --- Vorabend (gestern erwartet), nur heute, nur am Rechner --------------
  const vorabendSonne = breit && istHeute && vorabend ? vorabendPunkte(vorabend.pvKw, tag.beginn, m.jetztMs) : [];
  const vorabendVerbrauch = breit && istHeute && vorabend ? vorabendPunkte(vorabend.loadKw, tag.beginn, m.jetztMs) : [];
  const gepunktet = (punkte: Punkt[]) =>
    punkte.length > 1 ? punkte.map((p) => `${mitte(p.stunde).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ') : null;

  const jetztX = istHeute && m.jetztMs >= tag.beginn ? X(new Date(m.jetztMs).getHours()) + (schritt * (new Date(m.jetztMs).getMinutes() / 60)) : null;

  return (
    <div ref={ref} className="vp-pt-bild">
      {breite > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
          <defs>
            <pattern id="vp-pt-erw-flaeche" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill={withAlpha(flaechenFarbe, 0.12)} />
              <line x1="0" y1="0" x2="0" y2="5" stroke={flaechenFarbe} strokeWidth="1.8" />
            </pattern>
          </defs>

          {Array.from({ length: Math.round(ymax / tick) + 1 }, (_, k) => k * tick).map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={Y(v)} y2={Y(v)} stroke={t.grid} />
              <text x={padL - 6} y={Y(v) + 3.5} className="vp-pz-achse" textAnchor="end">
                {v === ymax ? `${v} kW` : v}
              </text>
            </g>
          ))}

          {fGemessen && (
            <g>
              <polygon points={fGemessen.poly} fill={withAlpha(flaechenFarbe, 0.55)} />
              <polyline points={fGemessen.linie} fill="none" stroke={flaechenFarbe} strokeWidth={2} strokeLinejoin="round" />
            </g>
          )}
          {fErwartet && (
            <g>
              <polygon points={fErwartet.poly} fill="url(#vp-pt-erw-flaeche)" />
              <polyline points={fErwartet.linie} fill="none" stroke={flaechenFarbe} strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
            </g>
          )}

          {verbrauchStufen.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke={t.consumer}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeDasharray={p.erwartet ? '4 3' : undefined}
            />
          ))}

          {gepunktet(vorabendSonne) && (
            <polyline points={gepunktet(vorabendSonne) as string} fill="none" stroke={t.pvLine} strokeWidth={1.5} strokeDasharray="1.5 2.5" opacity={0.7} />
          )}
          {gepunktet(vorabendVerbrauch) && (
            <polyline points={gepunktet(vorabendVerbrauch) as string} fill="none" stroke={t.consumer} strokeWidth={1.5} strokeDasharray="1.5 2.5" opacity={0.7} />
          )}

          {jetztX != null && <line x1={jetztX} x2={jetztX} y1={oben} y2={basis} stroke={t.jetzt} strokeWidth={2} />}

          {stundenDesTages
            .filter((h, i) => stundenDesTages.indexOf(h) === i && h % (breit ? 1 : 2) === 0)
            .map((h) => (
              <text key={h} x={mitte(h)} y={H - 4} className="vp-pz-achse" textAnchor="middle">
                {h}
              </text>
            ))}
        </svg>
      )}
    </div>
  );
}

/** Die Legende: gemessen, erwartet, und am Rechner "am Vorabend erwartet". */
export function PrognoseLegende({ tag, mitPv, zeigeVorabend }: { tag: TeppichTag; mitPv: boolean; zeigeVorabend?: boolean }) {
  const t = chartTheme();
  const farbe = mitPv ? t.pv : t.consumer;
  const gemessen = tag.stunden.some((s) => s.herkunft === 'gemessen');
  const erwartet = tag.stunden.some((s) => s.herkunft === 'erwartet');
  if (!gemessen && !erwartet) return null;
  return (
    <div className="vp-pz-legende">
      {gemessen && (
        <span>
          <i style={{ background: withAlpha(farbe, 0.75) }} aria-hidden="true" />
          gemessen
        </span>
      )}
      {erwartet && (
        <span>
          <i
            style={{
              background: withAlpha(farbe, 0.15),
              backgroundImage: `repeating-linear-gradient(45deg, ${farbe} 0 1.5px, transparent 1.5px 5px)`,
            }}
            aria-hidden="true"
          />
          erwartet
        </span>
      )}
      {zeigeVorabend && (
        <span>
          <i className="vp-pt-legende-punkt" aria-hidden="true" />
          am Vorabend erwartet
        </span>
      )}
    </div>
  );
}
