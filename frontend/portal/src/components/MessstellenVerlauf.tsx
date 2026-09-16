/**
 * Der VERLAUF einer Messstelle (UEMS AP-13 IP-4 = AP-08 IP-10) — die Render-Hälfte. Jede Zahl, jedes Wort, jede
 * Fläche und jeder Marker kommen aus der reinen `src/uemsVerlauf.ts` (dort aus dem Ergebnis-Vertrag, dem
 * Ereignis-Vokabular und der Route); hier wird nur gezeichnet.
 *
 * Ein eigenes SVG wie die Mini-Flächen (`MiniChart`, `SoVerdientChart`), keine ECharts-Leinwand: jeder Schritt ist
 * ein Element mit Zustand (`data-zustand`), die Lücke eine Fläche mit Muster, die Marke ein Kreis mit Nummer — so
 * prüfen vitest und Playwright, was gezeichnet ist, statt Pixel zu raten. Die Breite ist die GEMESSENE (K11).
 *
 * - Farbe UND Wort (V3, K10): die Legende nennt nur die Zustände im Bild; „mit Ersatzwert“ und „keine Werte“ tragen
 *   eine Schraffur statt einer weiteren Farbe (Farbe allein ist keine Aussage).
 * - Höchstens drei Marken im Bild (K6), ihre Sätze mit Nummer in der Liste darunter — dort auch jede weitere.
 * - Tipp statt Hover (M2): jeder Schritt ist über die volle Höhe ein Ziel; die Karte des gewählten Schritts steht
 *   unter dem Bild, ‹ › wandert zum Nachbarn (44 px), am Rechner auch die Pfeiltasten. Der Tooltip (K7, ein Satz)
 *   kommt nur mit der Maus.
 *
 * Seit AP-13 IP-5 (E6 = A) trägt dasselbe Bild den VERGLEICH — und nur eine der beiden Formen (VG1):
 *  - `vergleich`: dieselbe Messstelle in ihrer Vorperiode bzw. ihrem Vorjahr, blass im SELBEN Schlitz hinter der
 *    eigenen Reihe (die Überlagerung des Bestands). Die Zustandsfarben bleiben — es ist dieselbe Reihe.
 *  - `weitere`: bis zwei weitere PASSENDE Messstellen, nebeneinander im Schlitz. Dann trägt die Farbe die REIHE
 *    (Legende mit Namen, jede Reihe hat unten ihre eigene Karte), nicht mehr den Zustand: zwei Bedeutungen auf einer
 *    Farbe wären keine. Zwischen den Reihen steht nie eine Differenz (VG4).
 */
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { MessstelleWerte } from '../api';
import type { Kernaussage } from '../chartKopf';
import { UEMS_VERGLEICH, UEMS_VERLAUF, UEMS_VERLAUF_EREIGNISSE, UEMS_VERLAUF_WAHL } from '../glossar';
import { useContainerWidth } from '../useContainerWidth';
import { ZUSTAND_WORT, bild, luecken, marker, schrittKarte, schritte, tooltipSatz, type Schritt } from '../uemsVerlauf';
import type { BoxWechsel } from '../boxAnQuelle';
import { ChartHeadline } from './ChartExplain';
import type { QuellenNamen } from '../uemsWerteKarte';
import { WerteKarte } from './WerteKarte';
import './MessstellenVerlauf.css';

/** Eine weitere Reihe im Bild (AP-13 IP-5): ihr Name in der Legende und ihre Antwort im Raster des Zeitraums. */
export interface VerlaufReihe {
  name: string;
  antwort: MessstelleWerte;
}

/** Die Namen der Reihen-Farben in der Reihenfolge des Bildes — mehr als drei Reihen gibt es nicht (VG1). */
export const REIHEN_FARBE = ['eigen', 'zwei', 'drei'] as const;

export function MessstellenVerlauf({
  antwort,
  kern,
  versionen,
  markerAktion,
  namen,
  eigenName,
  vergleich = null,
  weitere = [],
  boxWechsel = [],
}: {
  /** Die Antwort der Werte-Route im Raster des Zeitraums (V1). */
  antwort: MessstelleWerte;
  /** Der Name der eigenen Reihe in der Legende — nur nötig, wo mehr als eine Reihe liegt. */
  eigenName?: string;
  /** AP-13 IP-5: die Vergleichsperiode DERSELBEN Messstelle, blass im selben Schlitz (VG1a). */
  vergleich?: VerlaufReihe | null;
  /** AP-13 IP-5: bis zwei weitere passende Messstellen, nebeneinander im Schlitz (VG1b) — dann ohne Überlagerung. */
  weitere?: readonly VerlaufReihe[];
  /** Der Kernaussage-Satz aus der Karte der Periode (`uemsVerlauf.kernaussage`). */
  kern: Kernaussage | null;
  /** Der Einstieg „Versionen“ an der Karte eines gewählten Schritts — nur, wo der Wirt die Historie öffnet. */
  versionen?: (s: Schritt) => ReactNode;
  markerAktion?: (kennung: string) => ReactNode;
  /** Die Namen der Bindungen aus dem Register — für den Grund-Satz der Schritt-Karte (AP-13 IP-6). */
  namen?: QuellenNamen;
  /**
   * AP-13 IP-12 (L6): die Box-Wechsel der Datenquelle dieser Messstelle aus der Zeitachse — mit ihnen
   * sprechen Übergabe und Box-Tausch ihren vollen Satz. Ohne sie bleibt der Kurz-Satz der Art.
   */
  boxWechsel?: readonly BoxWechsel[];
}) {
  const [ref, breite] = useContainerWidth<HTMLDivElement>();
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const [zeiger, setZeiger] = useState<number | null>(null);
  const muster = `vp-mv-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const s = useMemo(() => schritte(antwort), [antwort]);
  const l = useMemo(() => luecken(s), [s]);
  const m = useMemo(() => marker(antwort, s, l, boxWechsel), [antwort, s, l, boxWechsel]);
  // VG1: entweder die Überlagerung der eigenen Vergangenheit ODER weitere Messstellen — nie beides im selben Bild.
  const gruppiert = weitere.length > 0;
  const reihen: VerlaufReihe[] = gruppiert ? [...weitere] : vergleich ? [vergleich] : [];
  const weitereSchritte = reihen.map((r) => schritte(r.antwort));
  const b = bild(antwort, s, l, m, breite, weitereSchritte, gruppiert);
  const wahl = UEMS_VERLAUF_WAHL[antwort.raster as keyof typeof UEMS_VERLAUF_WAHL] ?? UEMS_VERLAUF_WAHL.tag;
  // Mit mehreren Messstellen trägt die Farbe die REIHE; die Zustände stehen dann an den Karten, nicht in der Legende.
  const arten = gruppiert ? [] : ZUSTAND_WORT.filter((z) => s.some((x) => x.art === z.art));
  const reihenLegende = reihen.length > 0 ? [{ name: eigenName ?? UEMS_VERLAUF, art: gruppiert ? 'reihe' : 'eigen' }, ...reihen.map((r) => ({ name: r.name, art: gruppiert ? 'reihe' : 'vergleich' }))] : [];
  // Eine neue Antwort (anderer Zeitraum) hebt die Wahl auf, statt einen fremden Schritt zu zeigen.
  const auswahl = gewaehlt !== null && gewaehlt < s.length ? s[gewaehlt] : null;
  const hervor = zeiger ?? auswahl?.index ?? null;
  const unten = b.flaeche.y + b.flaeche.h;

  const waehle = (i: number | null) => setGewaehlt(i === null ? null : Math.min(s.length - 1, Math.max(0, i)));
  const taste = (e: KeyboardEvent<HTMLDivElement>) => {
    const jetzt = auswahl?.index ?? -1;
    const ziel =
      e.key === 'ArrowRight' ? jetzt + 1 : e.key === 'ArrowLeft' ? Math.max(0, jetzt - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? s.length - 1 : null;
    if (e.key === 'Escape') {
      setGewaehlt(null);
      return;
    }
    if (ziel === null) return;
    e.preventDefault();
    waehle(ziel);
  };

  return (
    <section className="vp-mv" aria-label={UEMS_VERLAUF} data-testid="verlauf">
      <h3 className="vp-mv-titel">{UEMS_VERLAUF}</h3>
      <ChartHeadline kern={kern} />
      {arten.length > 0 && (
        <ul className="vp-mv-legende" data-testid="verlauf-legende">
          {arten.map((z) => (
            <li key={z.art}>
              <span className={`vp-mv-farbe is-${z.art}`} aria-hidden="true" />
              {z.wort}
            </li>
          ))}
        </ul>
      )}
      {/* VG1: die Legende nennt jede Reihe beim Namen — die Farbe allein sagt nie, welche Messstelle gemeint ist. */}
      {reihenLegende.length > 0 && (
        <ul className="vp-mv-legende vp-mv-reihen" data-testid="verlauf-reihen" aria-label={UEMS_VERGLEICH}>
          {reihenLegende.map((r, i) => (
            <li key={r.name} data-testid="verlauf-reihe" data-reihe={i}>
              <span className={`vp-mv-farbe is-${r.art} is-r${i}`} aria-hidden="true" />
              {r.name}
            </li>
          ))}
        </ul>
      )}
      <div
        ref={ref}
        className="vp-mv-bild"
        tabIndex={0}
        role="group"
        aria-label={`${UEMS_VERLAUF} · ${wahl.tipp}`}
        onKeyDown={taste}
        onPointerLeave={() => setZeiger(null)}
      >
        <svg viewBox={`0 0 ${b.breite} ${b.hoehe}`} role="img" aria-label={kern?.satz ?? kern?.grund ?? UEMS_VERLAUF}>
          <defs>
            <pattern id={`${muster}-luecke`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="vp-mv-luecke-grund" />
              <line x1="0" y1="0" x2="0" y2="6" className="vp-mv-luecke-strich" />
            </pattern>
            <pattern id={`${muster}-ersatz`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="5" className="vp-mv-ersatz-strich" />
            </pattern>
          </defs>

          <line x1={b.flaeche.x} x2={b.flaeche.x + b.flaeche.w} y1={b.skala.y} y2={b.skala.y} className="vp-mv-linie" />
          {b.skala.text && (
            // Rechts: links beginnen Lücken und Marken am häufigsten (Tagesanfang, Jahresanfang).
            <text x={b.flaeche.x + b.flaeche.w} y={b.skala.y - 5} textAnchor="end" className="vp-mv-skala">
              {b.skala.text}
            </text>
          )}

          {/* V4: eine Folge „keine Werte“ ist eine Fläche über die volle Höhe — keine Linie, keine Null. */}
          {b.luecken.map((x) => (
            <rect
              key={`luecke-${x.x}`}
              data-testid="verlauf-luecke"
              x={x.x}
              y={b.flaeche.y}
              width={x.w}
              height={b.flaeche.h}
              fill={`url(#${muster}-luecke)`}
            />
          ))}

          {/* Die blasse Vergleichsreihe liegt HINTER der eigenen — sonst verdeckte die Vergangenheit die Gegenwart. */}
          {[...b.balken].sort((a, z) => (gruppiert ? 0 : z.reihe - a.reihe)).map((x) => (
            <rect
              key={`${x.reihe}-${x.index}`}
              data-testid="verlauf-balken"
              data-reihe={x.reihe}
              className={
                gruppiert
                  ? `vp-mv-balken is-reihe is-r${x.reihe}`
                  : `vp-mv-balken is-${x.art}${x.reihe > 0 ? ' is-vergleich' : ''}`
              }
              x={x.x}
              y={x.y}
              width={x.w}
              height={x.h}
              fill={!gruppiert && x.art === 'ersatzwert' ? `url(#${muster}-ersatz)` : undefined}
            />
          ))}

          <line x1={b.flaeche.x} x2={b.flaeche.x + b.flaeche.w} y1={b.skala.nullY} y2={b.skala.nullY} className="vp-mv-null" />

          {hervor !== null && (
            <rect
              className="vp-mv-zeiger"
              x={b.flaeche.x + hervor * b.schritt}
              y={b.flaeche.y}
              width={Math.max(2, b.schritt)}
              height={b.flaeche.h}
            />
          )}

          {/* K6: höchstens drei Marken, jede mit ihrer Nummer aus der Liste. */}
          {b.marken.map((x) => (
            <g key={x.nummer} data-testid="verlauf-marke" data-nummer={x.nummer}>
              <line x1={x.x1} x2={x.x2} y1={x.y} y2={x.y} className="vp-mv-marke-spanne" />
              <line x1={x.x1} x2={x.x1} y1={x.y} y2={unten} className="vp-mv-marke-lot" />
              <circle cx={x.x1} cy={x.y} r="8" className="vp-mv-marke-kreis" />
              <text x={x.x1} y={x.y + 4} textAnchor="middle" className="vp-mv-marke-zahl">
                {x.nummer}
              </text>
            </g>
          ))}

          {b.ticks.map((t) => (
            <text key={`tick-${t.x}`} x={t.x} y={unten + 15} className="vp-mv-tick">
              {t.text}
            </text>
          ))}

          {/* Ein Ziel je Schritt über die volle Höhe — auch dort, wo kein Balken steht. */}
          {s.map((x) => (
            <rect
              key={`ziel-${x.index}`}
              data-testid="verlauf-schritt"
              data-von={x.von}
              data-zustand={x.art}
              className="vp-mv-ziel"
              x={b.flaeche.x + x.index * b.schritt}
              y={0}
              width={b.schritt}
              height={unten}
              onClick={() => waehle(auswahl?.index === x.index ? null : x.index)}
              onPointerEnter={(e) => e.pointerType === 'mouse' && setZeiger(x.index)}
            />
          ))}
        </svg>
        {zeiger !== null && s[zeiger] && (
          <p
            className="vp-mv-tooltip"
            role="tooltip"
            // Nie breiter als das eigene Bild: der Kasten ist höchstens 320 px breit (K7), links bleibt er im Rahmen.
            style={{ left: Math.min(Math.max(0, b.flaeche.x + zeiger * b.schritt - 80), Math.max(0, b.breite - 320)) }}
          >
            {tooltipSatz(s[zeiger])}
          </p>
        )}
      </div>

      {m.length > 0 && (
        <ol className="vp-mv-ereignisse" aria-label={UEMS_VERLAUF_EREIGNISSE}>
          {m.map((x) => (
            <li key={x.schluessel} data-testid="verlauf-ereignis">
              {x.nummer !== null ? (
                <span className="vp-mv-nummer" aria-hidden="true">
                  {x.nummer}
                </span>
              ) : (
                <span className="vp-mv-nummer is-leer" aria-hidden="true" />
              )}
              <span>{x.satz}{markerAktion?.(x.schluessel)}</span>
            </li>
          ))}
        </ol>
      )}

      {auswahl ? (
        <div className="vp-mv-schritt" data-testid="verlauf-auswahl">
          <div className="vp-mv-schritt-leiste">
            <button
              type="button"
              className="vp-mv-blaettern"
              aria-label={wahl.vorher}
              disabled={auswahl.index === 0}
              onClick={() => waehle(auswahl.index - 1)}
            >
              <Icon name="chevron-left" size={18} />
            </button>
            <button
              type="button"
              className="vp-mv-blaettern"
              aria-label={wahl.weiter}
              disabled={auswahl.index === s.length - 1}
              onClick={() => waehle(auswahl.index + 1)}
            >
              <Icon name="chevron-right" size={18} />
            </button>
          </div>
          <SchrittKarte antwort={antwort} schritt={auswahl} versionen={versionen} namen={namen} />
        </div>
      ) : (
        <p className="vp-mv-tipp">{wahl.tipp}</p>
      )}
    </section>
  );
}

function SchrittKarte({
  antwort,
  schritt,
  versionen,
  namen,
}: {
  antwort: MessstelleWerte;
  schritt: Schritt;
  versionen?: (s: Schritt) => ReactNode;
  namen?: QuellenNamen;
}) {
  const k = schrittKarte(antwort, schritt, namen);
  return <WerteKarte karte={k} grund={k.grund} testId="verlauf-schritt-karte" versionen={versionen?.(schritt)} />;
}
