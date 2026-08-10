import { useEffect, useRef } from 'react';
import type { EarningsRange } from '../api';
import { stripValueLabel, type StripSlot } from '../anlage';
import { MINI_HEIGHT, miniBars } from '../miniChart';
import { MiniBarCell } from './MiniChart';

/**
 * Render-only pieces of the period navigation shared across "Meine Anlage",
 * Historie and Portfolio: the period tabs and the tappable 12-month strip.
 * All derivation is the pure `anlage.ts`; these only render it.
 *
 * `AnlageHero`/`EnergyStatsRow`/`MonthRail` (the v1 zone-dashboard's money
 * hero, energy stats row and desktop month rail) were REMOVED with the v1
 * render path (Captain-Nachtrag 06.08.2026, `fm/vp-erst-alt-layout-r5`) - the
 * migrated cockpit's money summary lives in `cockpitWidgets.ts` `cockpitHero`
 * + `components/CockpitHero.tsx` instead, and every real Anlage today reaches
 * it (the automatic v2 backfill runs on every deploy).
 */

const RANGES: { id: EarningsRange; label: string }[] = [
  { id: 'day', label: 'Heute' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
  { id: 'all', label: 'Gesamt' },
];

/**
 * Der Zeitraum-Umschalter (Heute/Monat/Jahr/Gesamt) — **Voreinstellung „Heute"**
 * (`anlage.ts` `DEFAULT_EARNINGS_RANGE`).
 *
 * Zwei Erscheinungsformen, EIN Bauteil:
 *  - `tabs` (Default) — die vollbreite Pillenzeile.
 *  - `seg`  — das KOMPAKTE Segment der Bilanz-Leiste (Konzept „Die Bühne" §6.3):
 *    es steht direkt über den Zahlen, die es regiert, statt eine volle
 *    Seitenzeile für vier Knöpfe zu belegen. Es benutzt den bestehenden
 *    `.vp-seg`-Baustein — kein neues Farb-/Typo-System.
 */
export function PeriodTabs({
  range,
  onRange,
  variant = 'tabs',
}: {
  range: EarningsRange;
  onRange: (r: EarningsRange) => void;
  variant?: 'tabs' | 'seg';
}) {
  return (
    <div
      className={variant === 'seg' ? 'vp-seg vp-seg-compact' : 'vp-period-tabs'}
      role="tablist"
      aria-label="Zeitraum"
    >
      {RANGES.map((r) => (
        <button
          key={r.id}
          role="tab"
          aria-selected={range === r.id}
          className={range === r.id ? 'active' : ''}
          onClick={() => onRange(r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The 12-month strip (month mode): a fixed row of the last 12 Berlin months,
 * each a tappable chip with its Gesamtertrag. Horizontally scrollable so all
 * twelve fit on a phone. The selected month is highlighted.
 *
 * **Zwei Nutzungen, ein Baustein** (F2 des Historie-Konzepts): die Geld-Ansicht
 * zeigt je Monat seinen Gesamtertrag; die Historie benutzt denselben Streifen
 * als reinen **Sprung-Navigator** (`showValues={false}`) — sie kennt keine
 * Monatswerte, ohne zwölf weitere Abrufe zu bezahlen, und eine erfundene Zahl
 * käme nicht in Frage. Ein Monat, der laut Datenabdeckung garantiert nichts
 * trägt (`slot.hasData === false`), ist ausgegraut und nicht tippbar;
 * `undefined` heißt unbekannt und wird nie ausgegraut.
 */
export function MonthStrip({
  slots,
  selectedMonth,
  onSelect,
  showValues = true,
  ariaLabel = 'Monat wählen',
}: {
  slots: StripSlot[];
  selectedMonth: string;
  onSelect: (monthIso: string) => void;
  showValues?: boolean;
  ariaLabel?: string;
}) {
  // Keep the selected month in view - the recent months matter most, and on a
  // phone the strip scrolls, so a fresh render must not strand the customer on
  // the oldest months.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const chip = box?.querySelector<HTMLElement>('.vp-mstrip-m.on');
    if (box && chip) {
      box.scrollLeft = chip.offsetLeft - box.clientWidth / 2 + chip.clientWidth / 2;
    }
  }, [selectedMonth, slots]);

  // Größenkodierung (Stufe 5): die Chips trugen ihre Zahl, aber die Reihe war
  // ohne Zahlenlesen ununterscheidbar. EIN Balkensatz über ALLE Chips - also
  // EINE Skala, sonst wäre der Vergleich zwischen den Monaten wertlos. Die
  // Ehrlichkeitsregeln kommen aus `miniBars`: ein kleiner Monat sieht klein
  // aus (kein Mindesthöhen-Trick), ein Monat ohne Wert bekommt gar keinen
  // Balken, und ein negativer hängt unter der Nulllinie.
  const balken = showValues
    ? miniBars(
        slots.map((s) => ({ key: s.month, value: s.hasData === false ? null : s.value })),
        { height: MINI_HEIGHT.spark, emphasisKey: selectedMonth },
      )
    : null;

  return (
    <div className="vp-mstrip" ref={ref} role="tablist" aria-label={ariaLabel}>
      {slots.map((s, i) => {
        const leer = s.hasData === false;
        return (
          <button
            key={s.month}
            role="tab"
            aria-selected={s.month === selectedMonth}
            className={`vp-mstrip-m${s.month === selectedMonth ? ' on' : ''}${leer ? ' leer' : ''}`}
            onClick={() => onSelect(s.month)}
            disabled={leer}
            title={
              leer
                ? `${s.label}: keine Daten`
                : showValues && s.value != null
                  ? `${s.label}: ${stripValueLabel(s.value)} €`
                  : s.label
            }
          >
            <span className="mn">{s.label}</span>
            {balken && (
              <MiniBarCell className="vp-mstrip-bar" view={balken} index={i} />
            )}
            {showValues && <span className="mv">{stripValueLabel(s.value)}</span>}
          </button>
        );
      })}
    </div>
  );
}
