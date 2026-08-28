import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type PricePoint, type ScheduleSlot, type TarifArt } from '../api';
import { chartTheme } from '../chartTheme';
import { PROVENIENZ } from '../historieWelten';
import type { PlanWordingKind } from '../schedule';
import {
  bezugspreisKontext,
  KOPPLUNG_PREFIX,
  kurveBeschreibung,
  LEER_TEXT,
  planKopplung,
  praemieRuhtNote,
  streifenFenster,
  strompreisView,
  type StreifenFenster,
} from '../strompreis';
import { withAlpha } from '../chartStyle';
import { useContainerWidth } from '../useContainerWidth';
import { preisZeile } from '../cockpitWidgets';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { MobileRowCard } from './CockpitBlocks';
import './StrompreisStrip.css';

/**
 * Der Börsenpreis-Streifen (Konzept `vp-cockpit-unten-ux-n3`, PR 1) — der
 * Kopf der unteren Cockpit-Hälfte. Render-only + Datenholen; JEDE Regel
 * (Urteil, Anker, Kopplung, Notizen, Gating) ist die pure `strompreis.ts`.
 *
 * Datenwege, bewusst sparsam:
 * - `api.prices` einmal beim Mount und dann im Stunden-Takt bzw. beim
 *   Sichtbarwerden des Tabs (`useFreshnessPoll`) — Preise ändern sich einmal
 *   täglich gegen 13 Uhr, ein 30-s-Poll wäre Verschwendung.
 * - Eine Minuten-Uhr bewegt nur den Jetzt-Marker/das Urteil — kein Fetch.
 * - Der Plan kommt vom Elternteil (liegt auf der Seite schon geladen).
 *
 * Fail-soft: solange nichts geladen ist (oder der Abruf scheitert), rendert
 * der Streifen NICHTS — ein Fehler ist keine Datenlage. Erst eine
 * Server-Antwort ohne heutige Preise zeigt den ehrlichen Leerzustand.
 */

/** Preise ändern sich einmal täglich — stündlich nachsehen genügt. */
const PRICE_POLL_MS = 60 * 60 * 1000;
/** Minuten-Uhr für Jetzt-Marker + Urteil (bewegt sich je 15-min-Slot). */
const CLOCK_MS = 60 * 1000;
/** Höhe der Kurve in Pixeln — sie ist auch die viewBox-Höhe (K11: 1 Einheit = 1 px). */
const CURVE_H = 76;
/** Rückfallbreite, solange der ResizeObserver noch nicht gemessen hat. */
const CURVE_W_FALLBACK = 600;

export function StrompreisStrip({
  siteId,
  isDv,
  tarifArt,
  kind,
  slots,
  slotMinutes,
  activeSlot,
  onOpenMarktpreise,
  compact = false,
}: {
  siteId: string;
  /** Direktvermarktungs-Anlage (nur dort gibt es die § 51-Prämien-Zeile). */
  isDv: boolean;
  tarifArt: TarifArt | null;
  kind: PlanWordingKind;
  /** Der geladene Plan der Seite (für die Kopplung; leer = keine Zeile). */
  slots: ScheduleSlot[];
  slotMinutes: number;
  /** Der laufende Plan-Slot der Seite (trägt den Bezugspreis), oder null. */
  activeSlot: ScheduleSlot | null;
  onOpenMarktpreise: () => void;
  /**
   * Die Telefon-Fassung (Mobil-Umbau Stufe 2, `<= 720px`): EINE Zeile mit
   * Absprung — Preis jetzt + Urteil, darunter Bezugspreis + Tageshoch. Kurve,
   * Anker-Paar, Prämien-/Morgen-Notizen und die Plan-Kopplung wohnen auf der
   * Marktpreise- bzw. Fahrplan-Seite, die seit Mobil-Stufe 1 in der Bottom-Bar
   * sitzen; die Kopplung stand am Telefon zusätzlich direkt neben derselben
   * Aussage der Fahrplan-Zeile.
   */
  compact?: boolean;
}) {
  const [points, setPoints] = useState<PricePoint[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Erst-Abruf + der ruhige Stunden-/Sichtbarkeits-Takt. Fehlschläge sind
  // stumm — vorhandene Daten bleiben stehen, ohne Daten bleibt es leer.
  useEffect(() => {
    let active = true;
    api.prices(siteId).then(
      (s) => {
        if (active) setPoints(s.points);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [siteId]);
  useFreshnessPoll(() => {
    api.prices(siteId).then(
      (s) => setPoints(s.points),
      () => {},
    );
  }, PRICE_POLL_MS);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const view = useMemo(
    () => (points == null ? null : strompreisView(points, now)),
    [points, now],
  );
  const kopplung = useMemo(
    () => planKopplung(slots, now, slotMinutes, kind, view?.urteil === 'negativ'),
    [slots, now, slotMinutes, kind, view?.urteil],
  );

  if (view == null) return null;

  const bezug = bezugspreisKontext(tarifArt, activeSlot);
  const praemie = praemieRuhtNote(view.urteil, isDv);
  const fenster = streifenFenster(view);

  if (compact) {
    if (view.state === 'leer') return null;
    const row = preisZeile({
      jetztWert: view.jetztWert,
      urteilLabel: view.urteilLabel,
      bezug: bezug?.wert ?? null,
      bezugDetail: bezug?.detail ?? null,
      tarifWarnung: bezug?.warning ?? null,
      hoch: view.anker?.hoch ?? null,
    });
    if (!row) return null;
    return (
      <MobileRowCard icon="euro" row={row} linkLabel="Marktpreise" onOpen={onOpenMarktpreise} />
    );
  }

  return (
    <Card padding="lg" radius="lg" className="vp-strompreis" style={{ minWidth: 0 }}>
      <div className="vp-sp-head">
        <h3>Börsenpreis</h3>
        <button type="button" className="vp-sp-link" onClick={onOpenMarktpreise}>
          Marktpreise
          <Icon name="chevron-right" size={15} />
        </button>
      </div>

      {view.state === 'leer' ? (
        <p className="vp-muted" style={{ margin: '6px 0 0' }}>
          {LEER_TEXT}
        </p>
      ) : (
        <>
          {view.jetztWert != null && (
            <div className="vp-sp-now">
              <span className="vp-sp-val">{view.jetztWert}</span>
              <span className={`vp-sp-urteil tone-${view.urteil}`}>· {view.urteilLabel}</span>
            </div>
          )}
          {bezug != null && (
            <div className={`vp-sp-bezug${bezug.warning ? ' is-warning' : ''}`}>
              {bezug.wert != null && (
                <span className="vp-sp-bezug-main">
                  <span>Ihr Bezugspreis jetzt:</span>
                  <b>{bezug.wert}</b>
                  {bezug.detail && <span className="vp-sp-bezug-detail">{bezug.detail}</span>}
                </span>
              )}
              {bezug.warning && <span className="vp-sp-bezug-warning">{bezug.warning}</span>}
            </div>
          )}
          <Kurve view={view} />
          {/* K10: eine Hinterlegung ohne Wort ist ein Rätsel - die zwei
              benannten Fenster sagen im selben Block, was sie sind. */}
          {fenster.length > 0 && (
            <div className="vp-sp-fenster">
              {fenster.map((f) => (
                <span key={f.art} className={`vp-sp-fenster-item art-${f.art}`}>
                  <i aria-hidden="true" />
                  {f.wort} · {f.zeit}
                </span>
              ))}
            </div>
          )}
          {view.anker != null && (
            <div className="vp-sp-anker">
              <span>{view.anker.tief}</span>
              <span>{view.anker.hoch}</span>
            </div>
          )}
          {praemie != null && <p className="vp-sp-praemie">{praemie}</p>}
          {view.morgenNote != null && <p className="vp-sp-note">{view.morgenNote}</p>}
        </>
      )}

      {kopplung != null && (
        <div className="vp-sp-plan">
          <Icon name="zap" size={15} />
          <span className="vp-sp-plan-text">
            {KOPPLUNG_PREFIX}
            {kopplung.pre}
            <b>{kopplung.action}</b>
            {kopplung.post}
          </span>
          <span className="vp-sp-geplant" title={PROVENIENZ.geplant.satz}>
            {PROVENIENZ.geplant.label}
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * Die 24-h-Kurve als abhängigkeitsfreies SVG (der Sparkline/EnergyFlow-
 * Präzedenzfall) — seit Chart-Redesign Stufe 4 in DERSELBEN Preis-Grammatik
 * wie die Marktpreise-Seite.
 *
 * Was sich geändert hat und warum:
 *
 *  - **Der JS-Farbverlauf grün → orange → rot ist weg.** Er war eine Farbskala
 *    ohne Skala (K10) und die satteste Fläche des Cockpits. Jetzt: EINE ruhige
 *    Stufenlinie in Preis-Blau plus höchstens zwei benannte Fenster als zarte
 *    Hinterlegung — und ihre Wörter stehen als Zeile darunter.
 *  - **Kein `preserveAspectRatio="none"` mehr.** Das gestreckte SVG verzerrte
 *    jeden Kreis und jede Strichstärke. Die viewBox ist jetzt die GEMESSENE
 *    Pixelbreite (K11: 1 Einheit = 1 px), also gibt es nichts mehr zu
 *    verzerren — und die Texte brauchen keine HTML-Overlay-Krücke mehr.
 *  - **Mini-Anker:** die Nulllinie ist immer da (sie ist der Bezug, an dem ein
 *    Negativpreis überhaupt erst als solcher lesbar wird), Tief und Hoch
 *    tragen einen kleinen Punkt.
 *  - **`aria-label` statt `aria-hidden`:** die Kurve trägt die Tagesform, sie
 *    war für Vorlesesoftware schlicht nicht vorhanden.
 *
 * Ehrliche Skala unverändert: Lücken bleiben Lücken, Negativpreise hängen
 * unter der Nulllinie, Vergangenheit ist gedimmt, Morgen liegt blass hinter
 * dem Trenner.
 */
function Kurve({ view }: { view: ReturnType<typeof strompreisView> }) {
  const t = chartTheme();
  const [wrapRef, gemessen] = useContainerWidth<HTMLDivElement>();
  const bars = view.bars;
  const n = bars.length;
  if (n === 0) return <div ref={wrapRef} className="vp-sp-curve" />;

  const W = gemessen > 0 ? gemessen : CURVE_W_FALLBACK;
  const H = CURVE_H;
  const cts = bars.map((b) => b.ct);
  const werte = cts.filter((v): v is number => v != null);
  const min = Math.min(0, ...werte);
  const max = Math.max(0, ...werte);
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * (H - 10) - 5;
  const y0 = y(0);
  const bw = W / n;
  const x = (i: number) => i * bw;

  const fenster = streifenFenster(view);
  const farbe = (f: StreifenFenster) => (f.art === 'teuer' ? t.discharge : t.guenstig);

  // Die Stufenlinie: ein Viertelstundenpreis GILT bis zum nächsten Slot.
  // Eine Lücke unterbricht den Zug, statt über sie hinweg zu interpolieren.
  const zuege: string[] = [];
  let zug: string[] = [];
  bars.forEach((b, i) => {
    if (b.ct == null) {
      if (zug.length > 1) zuege.push(zug.join(' '));
      zug = [];
      return;
    }
    const yv = y(b.ct);
    if (zug.length === 0) zug.push(`M ${x(i).toFixed(1)} ${yv.toFixed(1)}`);
    else zug.push(`L ${x(i).toFixed(1)} ${yv.toFixed(1)}`);
    zug.push(`L ${x(i + 1).toFixed(1)} ${yv.toFixed(1)}`);
  });
  if (zug.length > 1) zuege.push(zug.join(' '));

  const jetztIdx = bars.findIndex((b) => b.jetzt);
  let tiefIdx = -1;
  let hochIdx = -1;
  cts.forEach((v, i) => {
    if (v == null) return;
    if (tiefIdx < 0 || v < (cts[tiefIdx] as number)) tiefIdx = i;
    if (hochIdx < 0 || v > (cts[hochIdx] as number)) hochIdx = i;
  });

  return (
    <div ref={wrapRef} className="vp-sp-curve">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={kurveBeschreibung(view)}
      >
        {/* Die benannten Fenster - ihr WORT steht in der Zeile darunter. */}
        {fenster.map((f) => (
          <rect
            key={f.art}
            x={x(f.von)}
            y={0}
            width={Math.max(x(f.bis + 1) - x(f.von), 1)}
            height={H}
            fill={withAlpha(farbe(f), 0.14)}
          />
        ))}
        {/* Morgen liegt blass hinter dem Trenner. */}
        {view.morgenAb >= 0 && (
          <rect
            x={x(view.morgenAb)}
            y={0}
            width={Math.max(W - x(view.morgenAb), 1)}
            height={H}
            fill={withAlpha(t.price, 0.05)}
          />
        )}
        {/* Mini-Anker: die Nulllinie ist immer da. */}
        <line x1={0} x2={W} y1={y0} y2={y0} stroke={t.axisLine} strokeWidth={1} />
        {zuege.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={t.price} strokeWidth={1.6} strokeLinejoin="round" />
        ))}
        {/* Vergangenheit dimmen: ein Schleier über den gelaufenen Teil. */}
        {jetztIdx > 0 && (
          <rect x={0} y={0} width={x(jetztIdx)} height={H} fill={t.surface} opacity={0.45} />
        )}
        {view.morgenAb >= 0 && (
          <line
            x1={x(view.morgenAb)}
            x2={x(view.morgenAb)}
            y1={0}
            y2={H}
            stroke={t.axis}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.7}
          />
        )}
        {[tiefIdx, hochIdx].map((i, k) =>
          i < 0 || i === (k === 0 ? hochIdx : tiefIdx) ? null : (
            <circle
              key={k}
              cx={x(i) + bw / 2}
              cy={y(cts[i] as number)}
              r={2.6}
              fill={t.surface}
              stroke={k === 0 ? t.guenstig : t.discharge}
              strokeWidth={1.6}
            />
          ),
        )}
        {jetztIdx >= 0 && (
          <>
            <line
              x1={x(jetztIdx) + bw / 2}
              x2={x(jetztIdx) + bw / 2}
              y1={0}
              y2={H}
              stroke={t.ink}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            {bars[jetztIdx].ct != null && (
              <circle
                cx={x(jetztIdx) + bw / 2}
                cy={y(bars[jetztIdx].ct as number)}
                r={3}
                fill={t.price}
              />
            )}
          </>
        )}
      </svg>
    </div>
  );
}
