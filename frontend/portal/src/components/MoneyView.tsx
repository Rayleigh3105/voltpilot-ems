import { useEffect, useRef } from 'react';
import type { EarningsRange, EarningsSite } from '../api';
import { energyLabel, stripValueLabel, type StripSlot } from '../anlage';
import { eurAmount } from '../format';
import { useCountUp } from './FleetOverview';

/**
 * Render-only pieces of the money-centric "Meine Anlage" v2 view (captain
 * 2026-07-07, Deye-Copilot-style): the period tabs that govern the whole page,
 * the Gesamtertrag hero with its four money tiles, the tappable 12-month strip
 * and the energy-stats row. All derivation is the pure `anlage.ts`; these only
 * render it.
 */

const RANGES: { id: EarningsRange; label: string }[] = [
  { id: 'day', label: 'Heute' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
  { id: 'all', label: 'Gesamt' },
];

/** ct/kWh for the benchmark tiles: German comma, one decimal + unit. */
function ctLabel(value: number): string {
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} ct/kWh`;
}

/** The page-level period tabs (Heute/Monat/Jahr/Gesamt) - default Monat. */
export function PeriodTabs({
  range,
  onRange,
}: {
  range: EarningsRange;
  onRange: (r: EarningsRange) => void;
}) {
  return (
    <div className="vp-period-tabs" role="tablist" aria-label="Zeitraum">
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
 */
export function MonthStrip({
  slots,
  selectedMonth,
  onSelect,
}: {
  slots: StripSlot[];
  selectedMonth: string;
  onSelect: (monthIso: string) => void;
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

  return (
    <div className="vp-mstrip" ref={ref} role="tablist" aria-label="Monat wählen">
      {slots.map((s) => (
        <button
          key={s.month}
          role="tab"
          aria-selected={s.month === selectedMonth}
          className={`vp-mstrip-m${s.month === selectedMonth ? ' on' : ''}`}
          onClick={() => onSelect(s.month)}
          title={s.value == null ? s.label : `${s.label}: ${stripValueLabel(s.value)} €`}
        >
          <span className="mn">{s.label}</span>
          <span className="mv">{stripValueLabel(s.value)}</span>
        </button>
      ))}
    </div>
  );
}

/** One money tile inside the hero. */
function Tile({ t, v }: { t: string; v: string }) {
  return (
    <div className="vp-money-tile">
      <span className="t">{t}</span>
      <span className="v">{v}</span>
    </div>
  );
}

/**
 * The Gesamtertrag hero on the brand gradient: the big measured number for the
 * period, the "davon durch VoltPilots Steuerung" subline (the Mehrerlös), and
 * up to four money tiles (Einspeise-Erlös, Wert des Eigenverbrauchs OR the
 * kWh-only fallback when no tariff is set, plus the DV benchmark Ihr Marktwert /
 * Ø Markt Solar). Nothing computable -> an honest "–" with the why.
 */
export function AnlageHero({
  money,
  period,
  unavailable = false,
  emptyHint,
}: {
  money: EarningsSite | null;
  period: string;
  unavailable?: boolean;
  emptyHint?: string;
}) {
  const gesamt = money?.gesamtertragEur ?? null;
  const animated = useCountUp(gesamt);

  const tiles: { t: string; v: string }[] = [];
  let provisional = false;
  if (money && gesamt != null) {
    tiles.push({
      t: 'Einspeise-Erlös',
      v: money.einspeiseErloesEur != null ? eurAmount(money.einspeiseErloesEur) : '–',
    });
    tiles.push(
      money.eigenverbrauchsWertEur != null
        ? { t: 'Wert des Eigenverbrauchs', v: eurAmount(money.eigenverbrauchsWertEur) }
        : { t: 'Eigenverbrauch', v: energyLabel(money.selbstverbrauchKwh) },
    );
    if (
      money.plantKind === 'direktvermarktung' &&
      money.realizedExportCtKwh != null &&
      money.marketValueSolarCtKwh != null
    ) {
      provisional = money.marketValueProvisional === true;
      tiles.push({ t: 'Ihr Marktwert', v: ctLabel(money.realizedExportCtKwh) });
      tiles.push({
        t: 'Ø Markt (Solar)',
        v: `${ctLabel(money.marketValueSolarCtKwh)}${provisional ? ' *' : ''}`,
      });
    }
  }

  return (
    <section className="vp-fleet-hero vp-money-hero" aria-label={`Gesamtertrag ${period}`}>
      <span className="vp-fleet-hero-label">Gesamtertrag · {period}</span>
      {gesamt == null ? (
        <>
          <span className="vp-fleet-hero-value">–</span>
          <span className="vp-fleet-hero-sub">
            {unavailable
              ? 'Der Wert ist gerade nicht verfügbar. Bitte versuchen Sie es später erneut.'
              : emptyHint ??
                'Für diesen Zeitraum liegen noch keine berechenbaren Messwerte vor. Sobald Ihre Anlage misst und Börsenpreise vorliegen, erscheint hier Ihr Ertrag.'}
          </span>
        </>
      ) : (
        <>
          <span className="vp-fleet-hero-value">
            {(animated ?? gesamt) >= 0 ? '+' : ''}
            {eurAmount(animated ?? gesamt)}
          </span>
          {money?.savedEur != null && (
            <span className="vp-fleet-hero-sub">
              davon {money.savedEur >= 0 ? '+' : ''}
              {eurAmount(money.savedEur)} durch VoltPilots Steuerung
            </span>
          )}
          <div className="vp-money-tiles">
            {tiles.map((tile) => (
              <Tile key={tile.t} t={tile.t} v={tile.v} />
            ))}
          </div>
          {provisional && (
            <p className="vp-money-note">* vorläufiger Monatswert (Marktdaten noch nicht endgültig)</p>
          )}
        </>
      )}
    </section>
  );
}

/** The energy-stats row: eingespeist / selbst verbraucht / Batterie bewegt. */
export function EnergyStatsRow({ money }: { money: EarningsSite | null }) {
  const stats: { t: string; v: string }[] = [
    { t: 'Eingespeist', v: energyLabel(money?.eingespeistKwh) },
    { t: 'Selbst verbraucht', v: energyLabel(money?.selbstverbrauchKwh) },
    { t: 'Batterie bewegt', v: energyLabel(money?.batterieBewegtKwh) },
  ];
  return (
    <div className="vp-estats">
      {stats.map((s) => (
        <div className="vp-estat" key={s.t}>
          <span className="t">{s.t}</span>
          <span className="v">{s.v}</span>
        </div>
      ))}
    </div>
  );
}
