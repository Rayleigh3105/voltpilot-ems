import { useEffect, useRef, type ReactNode } from 'react';
import type { EarningsRange, EarningsSite } from '../api';
import {
  eigenverbrauchProvenance,
  einspeiseProvenance,
  energyLabel,
  energyTiles,
  gesamtertragProvenance,
  savedProvenance,
  stripValueLabel,
  type StripSlot,
} from '../anlage';
import { marktwertBenchmark } from '../fleet';
import { eurAmount } from '../format';
import { InfoTip } from './InfoTip';
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

/**
 * The vertical 12-month rail (desktop Zone C navigator): the same 12-month data
 * as {@link MonthStrip}, laid out as a compact column of rows - each a month
 * name, a proportional bar and its Gesamtertrag. Tapping a month re-scopes the
 * whole page. The bar width is relative to the best month; null months render an
 * empty bar (never a fake zero). Desktop-only; phones keep the horizontal strip.
 */
export function MonthRail({
  slots,
  selectedMonth,
  onSelect,
}: {
  slots: StripSlot[];
  selectedMonth: string;
  onSelect: (monthIso: string) => void;
}) {
  const max = Math.max(1, ...slots.map((s) => (s.value != null && s.value > 0 ? s.value : 0)));
  return (
    <div className="vp-mrail">
      <span className="vp-card-label">12-Monats-Verlauf</span>
      <div className="vp-mrail-list" role="tablist" aria-label="Monat wählen">
        {slots.map((s) => {
          const pct = s.value != null && s.value > 0 ? Math.max(4, Math.round((s.value / max) * 100)) : 0;
          const on = s.month === selectedMonth;
          return (
            <button
              key={s.month}
              role="tab"
              aria-selected={on}
              className={`vp-mrail-m${on ? ' on' : ''}`}
              onClick={() => onSelect(s.month)}
              title={s.value == null ? s.label : `${s.label}: ${stripValueLabel(s.value)} €`}
            >
              <span className="mn">{s.label}</span>
              <span className="mb">
                <span className="mbf" style={{ width: `${pct}%` }} />
              </span>
              <span className="mv">{stripValueLabel(s.value)}</span>
            </button>
          );
        })}
      </div>
      <span className="vp-mrail-cap">Tippen wechselt den Zeitraum der Seite.</span>
    </div>
  );
}

/**
 * One money tile inside the hero. An optional `info` renders an InfoTip after
 * the label so the number's provenance is one tap away (decision 3) while the
 * collapsed tile stays as calm as before.
 */
function Tile({ t, v, info }: { t: string; v: string; info?: ReactNode }) {
  return (
    <div className="vp-money-tile">
      <span className="t">
        {t}
        {info && <InfoTip label={`Herkunft: ${t}`}>{info}</InfoTip>}
      </span>
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

  const tiles: { t: string; v: string; info?: ReactNode }[] = [];
  let provisional = false;
  if (money && gesamt != null) {
    tiles.push({
      t: 'Einspeise-Erlös',
      v: money.einspeiseErloesEur != null ? eurAmount(money.einspeiseErloesEur) : '–',
      info: einspeiseProvenance(money),
    });
    const eigenInfo = eigenverbrauchProvenance(money);
    tiles.push(
      money.eigenverbrauchsWertEur != null
        ? { t: 'Wert des Eigenverbrauchs', v: eurAmount(money.eigenverbrauchsWertEur), info: eigenInfo }
        : { t: 'Eigenverbrauch', v: energyLabel(money.selbstverbrauchKwh), info: eigenInfo },
    );
    if (
      money.plantKind === 'direktvermarktung' &&
      money.realizedExportCtKwh != null &&
      money.marketValueSolarCtKwh != null
    ) {
      provisional = money.marketValueProvisional === true;
      tiles.push({
        t: 'Ihr Marktwert',
        v: ctLabel(money.realizedExportCtKwh),
        info: marktwertBenchmark(money),
      });
      tiles.push({
        t: 'Ø Markt (Solar)',
        v: `${ctLabel(money.marketValueSolarCtKwh)}${provisional ? ' *' : ''}`,
      });
    }
  }

  const gesamtInfo = money ? gesamtertragProvenance(money) : null;
  const savedInfo = money ? savedProvenance(money) : null;

  return (
    <section className="vp-fleet-hero vp-money-hero" aria-label={`Gesamtertrag ${period}`}>
      <span className="vp-fleet-hero-label">
        Gesamtertrag · {period}
        {gesamt != null && gesamtInfo && (
          <InfoTip label="Herkunft: Gesamtertrag">{gesamtInfo}</InfoTip>
        )}
      </span>
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
              {savedInfo && (
                <InfoTip label="Herkunft: VoltPilots Steuerung">{savedInfo}</InfoTip>
              )}
            </span>
          )}
          <div className="vp-money-tiles">
            {tiles.map((tile) => (
              <Tile key={tile.t} t={tile.t} v={tile.v} info={tile.info} />
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

/**
 * The energy-stats row (captain decision 4): "Eingespeist / Selbst genutzt /
 * Über Batterie", each with a one-line everyday-language mini-explanation
 * underneath ("ins Netz verkauft" / "direkt im Haus verbraucht" /
 * "zwischengespeichert"). The wording is the pure `energyTiles`.
 */
export function EnergyStatsRow({ money }: { money: EarningsSite | null }) {
  return (
    <div className="vp-estats">
      {energyTiles(money).map((s) => (
        <div className="vp-estat" key={s.label}>
          <span className="t">{s.label}</span>
          <span className="v">{s.value}</span>
          <span className="e">{s.hint}</span>
        </div>
      ))}
    </div>
  );
}
