import { useEffect, useMemo, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type PricePoint, type ScheduleSlot, type TarifArt } from '../api';
import { chartTheme } from '../chartTheme';
import { PROVENIENZ } from '../historieWelten';
import type { PlanWordingKind } from '../schedule';
import {
  bezugspreisJetzt,
  KOPPLUNG_PREFIX,
  LEER_TEXT,
  planKopplung,
  praemieRuhtNote,
  strompreisView,
} from '../strompreis';
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

/** Farbverlauf grün → orange → rot über die Tagesspanne (Marktpreise-Sprache). */
function grade(t: { charge: string; pv: string; discharge: string }, p: number): string {
  const mix = (c1: string, c2: string, f: number): string => {
    const h = (c: string) => {
      const n = parseInt(c.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const a = h(c1);
    const b = h(c2);
    const ch = (i: number) => Math.round(a[i] + (b[i] - a[i]) * f);
    return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
  };
  const clamped = Math.max(0, Math.min(1, p));
  return clamped < 0.5 ? mix(t.charge, t.pv, clamped * 2) : mix(t.pv, t.discharge, (clamped - 0.5) * 2);
}

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

  const bezug = bezugspreisJetzt(tarifArt, activeSlot);
  const praemie = praemieRuhtNote(view.urteil, isDv);

  if (compact) {
    if (view.state === 'leer') return null;
    const row = preisZeile({
      jetztWert: view.jetztWert,
      urteilLabel: view.urteilLabel,
      bezug,
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
            <p className="vp-sp-bezug">
              Ihr Bezugspreis jetzt: <b>{bezug}</b>
            </p>
          )}
          <Kurve view={view} />
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
 * Präzedenzfall). Ehrliche Skala: Balken ab 0, Negativpreise hängen unter der
 * sichtbaren Nulllinie; Vergangenheit gedimmt, Morgen blass hinter dem
 * Trenner. Texte („Jetzt"/„Morgen") liegen als HTML-Overlays, damit das
 * gestreckte SVG sie nicht verzerrt.
 */
function Kurve({ view }: { view: ReturnType<typeof strompreisView> }) {
  const t = chartTheme();
  const bars = view.bars;
  const n = bars.length;
  if (n === 0) return null;

  const W = 600;
  const H = 76;
  const todayCts = bars
    .filter((b) => b.tag === 'heute' && b.ct != null)
    .map((b) => b.ct as number);
  const min = Math.min(0, ...todayCts, ...bars.map((b) => b.ct ?? 0));
  const max = Math.max(0, ...bars.map((b) => b.ct ?? 0));
  const tMin = Math.min(...todayCts);
  const tMax = Math.max(...todayCts);
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * (H - 6) - 3;
  const y0 = y(0);
  const bw = W / n;

  const jetztIdx = bars.findIndex((b) => b.jetzt);
  const jetztPct = jetztIdx < 0 ? null : ((jetztIdx + 0.5) / n) * 100;
  const morgenPct = view.morgenAb < 0 ? null : (view.morgenAb / n) * 100;

  return (
    <div className="vp-sp-curve">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {bars.map((b, i) => {
          if (b.ct == null) return null;
          const top = Math.min(y(b.ct), y0);
          const h = Math.abs(y(b.ct) - y0) || 1;
          const dim = b.vergangen ? 0.35 : b.tag === 'morgen' ? 0.45 : 1;
          return (
            <rect
              key={i}
              x={i * bw}
              y={top}
              width={Math.max(bw - 0.7, 1)}
              height={h}
              fill={grade(t, tMax - tMin === 0 ? 0.5 : ((b.ct as number) - tMin) / (tMax - tMin))}
              opacity={dim}
            />
          );
        })}
        <line x1={0} x2={W} y1={y0} y2={y0} stroke={t.axisLine} strokeWidth={1} />
        {view.morgenAb >= 0 && (
          <line
            x1={view.morgenAb * bw}
            x2={view.morgenAb * bw}
            y1={0}
            y2={H}
            stroke={t.price}
            strokeWidth={1.2}
            strokeDasharray="4 4"
          />
        )}
        {jetztIdx >= 0 && (
          <>
            <line
              x1={jetztIdx * bw + bw / 2}
              x2={jetztIdx * bw + bw / 2}
              y1={0}
              y2={H}
              stroke={t.plan}
              strokeWidth={1.6}
            />
            {bars[jetztIdx].ct != null && (
              <circle
                cx={jetztIdx * bw + bw / 2}
                cy={y(bars[jetztIdx].ct as number)}
                r={3.4}
                fill={t.plan}
              />
            )}
          </>
        )}
      </svg>
      {jetztPct != null && (
        <span
          className="vp-sp-overlay jetzt"
          style={
            jetztPct > 82
              ? { left: `${jetztPct}%`, transform: 'translateX(calc(-100% - 5px))' }
              : { left: `calc(${jetztPct}% + 5px)` }
          }
        >
          Jetzt
        </span>
      )}
      {morgenPct != null && (
        <span
          className="vp-sp-overlay morgen"
          style={
            morgenPct > 82
              ? { left: `${morgenPct}%`, transform: 'translateX(calc(-100% - 5px))' }
              : { left: `calc(${morgenPct}% + 5px)` }
          }
        >
          Morgen
        </span>
      )}
    </div>
  );
}
