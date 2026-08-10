import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsDaily, EarningsRange, EarningsSite, Overview, OverviewSite } from '../api';
import {
  arbitrageLine,
  BATTERY_NO_DEVICE_SHORT,
  berlinDay,
  composeFleetSentence,
  fleetHeadline,
  notComputableHint,
  proofLine,
  realizedFinePrint,
  realizedSubline,
  savedOnDay,
  siteEarnText,
  siteLiveFresh,
  sparkAussage,
  sparkDays,
  type FleetKind,
  type PremiumDetail,
} from '../fleet';
import { eurAmount, fmtNum, fmtRelative } from '../format';
import { batteryState, deriveBatteryKw, gridState } from '../live';
import type { MiniPoint } from '../miniChart';
import { sanitizeSoc } from '../plausible';
import { useIsPhone } from '../useIsPhone';
import { InfoTip } from './InfoTip';
import { MiniBarSpark, MiniShareBar, type MiniMark } from './MiniChart';
import { NetzladenBadge } from './NetzladenBadge';

/**
 * Presentational pieces of the adaptive Übersicht: the realized-money hero on
 * the brand gradient (fleet AND single-site since Phase 2), the fleet status
 * sentence, and the per-site cards. All wording/derivation lives in the pure
 * `fleet.ts` and `live.ts`; these components only render it.
 */

/**
 * Count-up of the hero number (~0.8 s, ease-out) - the small "Verdien-Moment"
 * on every open. Animates from the previous value on refresh so a background
 * poll never snaps the number. Honors prefers-reduced-motion.
 */
export function useCountUp(target: number | null, ms = 800): number | null {
  const [value, setValue] = useState<number | null>(target);
  const fromRef = useRef<number>(0);
  useEffect(() => {
    if (target == null) {
      setValue(null);
      fromRef.current = 0;
      return;
    }
    if (
      typeof window === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Near-zero day values render as exactly 0 (never "-0,00 €"). */
function heuteValue(savedEur: number): number {
  return Math.abs(savedEur) < 0.005 ? 0 : savedEur;
}

/** „12.08." — der Tagesschlüssel als Wort, für Marke und Ablese-Zeile. */
function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return m && d ? `${d}.${m}.` : day;
}

/**
 * Der 14-Tage-Spark des Flotten-Helden.
 *
 * Er hatte die zwei gemessenen Ehrlichkeitsfehler des Mini-Inventars zugleich
 * (`vp-charts-filigran-c7` §4 Nr. 9): `Math.max(0, savedEur)` machte aus jedem
 * VERLUSTTAG einen Nulltag, und `Math.max(8, …)` zog jeden kleinen Tag auf 8 %
 * hoch. Beides ist mit dem Baustein strukturell weg — hier bleibt nur die
 * Zuordnung „welcher Punkt trägt welche Marke".
 *
 * Er liegt auf dem Marken-Verlauf, also die „on-gradient"-Fassung.
 */
function FleetSpark({
  spark,
  today,
  aussage,
}: {
  spark: { day: string; savedEur: number | null }[];
  today: string;
  aussage: ReturnType<typeof sparkAussage>;
}) {
  const points: MiniPoint[] = spark.map((d) => ({
    key: d.day,
    value: d.savedEur,
    label: dayLabel(d.day),
  }));
  const heuteHatWert = spark.some((d) => d.day === today && d.savedEur != null);

  // K6: höchstens die zwei Punkte, die wirklich etwas bedeuten. „heute" nur,
  // wenn es dort auch einen Wert gibt - eine Fahne über einer Lücke wäre eine
  // Behauptung.
  const marks: MiniMark[] = [];
  if (heuteHatWert) marks.push({ key: today, label: 'heute' });
  if (aussage.verlustTag) {
    marks.push({
      key: aussage.verlustTag.day,
      label: aussage.verlustTag.label,
      place: 'below',
      tone: 'warn',
    });
  }

  return (
    <MiniBarSpark
      className="vp-fleet-spark"
      points={points}
      emphasisKey={heuteHatWert ? today : null}
      tone="gradient"
      marks={marks}
      ariaLabel={`Tageswerte der letzten ${spark.length} Tage`}
      readout={(p) =>
        p.value == null
          ? `${p.label}: keine Daten`
          : `${p.label}: ${heuteValue(p.value) >= 0 ? '+' : ''}${eurAmount(heuteValue(p.value))}`
      }
      caption={aussage.satz ?? aussage.grund}
    />
  );
}

const RANGES: { id: EarningsRange; label: string }[] = [
  { id: 'day', label: 'Heute' },
  { id: 'month', label: 'Monat' },
  { id: 'year', label: 'Jahr' },
  { id: 'all', label: 'Gesamt' },
];

/** The money numbers the hero renders (fleet totals or one site's row). */
export interface HeroMoney {
  baselineEur: number | null;
  actualEur: number | null;
  savedEur: number | null;
  /** Grid-charging attribution ("davon Arbitrage-Gewinn"); null = no line. */
  arbitrageEur: number | null;
  firstCoveredDate: string | null;
}

/**
 * The realized-money hero on the brand gradient: the MEASURED saved/earned
 * number for the selected Berlin period, the two-number proof line ("Erlös mit
 * VoltPilot / Ungeregelt wären es" resp. cost framing - sign-honest via
 * proofLine), the Heute/Monat/Jahr/Gesamt switch (default Monat, captain
 * decision), realized 14-day spark bars, and the plain-German fine print.
 * Nothing computable => an honest "-" with the why, never a fake zero.
 */
export function EarningsHero({
  kind,
  money,
  dailySaved,
  range,
  dataRange,
  onRange,
  now,
  unavailable = false,
  emptyHint,
  premium = false,
  premiumDetail = null,
  benchmark = null,
}: {
  kind: FleetKind;
  money: HeroMoney | null;
  dailySaved: EarningsDaily[];
  range: EarningsRange;
  /** The range the DATA belongs to (the response's range): while a switch is
   *  in flight the hero keeps the previous numbers, so the wording must keep
   *  describing them - the seg alone reflects the new selection. */
  dataRange?: EarningsRange;
  onRange: (r: EarningsRange) => void;
  now: Date;
  /** True when the earnings request itself failed (outage, not "no data"). */
  unavailable?: boolean;
  /** Reason-specific hint when nothing is computable (site drill-down). */
  emptyHint?: string;
  /** True when a configured Marktprämie is INCLUDED in the numbers shown. */
  premium?: boolean;
  /**
   * The two numbers behind the premium (site-scoped hero): anzulegender Wert
   * vs Monatsmarktwert Solar - the fine print then names them instead of the
   * generic "inkl. Marktprämie" sentence.
   */
  premiumDetail?: PremiumDetail | null;
  /**
   * The Direktvermarktung benchmark line ("Sie haben X ct/kWh erzielt - ...");
   * null = no line (Eigenverbrauch, or no exported energy in the window).
   */
  benchmark?: string | null;
}) {
  const worded = dataRange ?? range;
  const saved = money?.savedEur ?? null;
  const animated = useCountUp(saved);
  const isPhone = useIsPhone();

  const today = berlinDay(now);
  const spark = sparkDays(dailySaved, now);
  // K1/K8: der Satz zum Spark - heutiger Wert, Vergleichsanker und der
  // BENANNTE Verlusttag. Vorher stand dort nur "Tageswerte, letzte 14 Tage"
  // neben einer Zahl, und ein Verlusttag war per `Math.max(0, …)` unsichtbar.
  const aussage = sparkAussage(spark, now);
  const proof =
    money != null && money.baselineEur != null && money.actualEur != null
      ? proofLine(kind, money.baselineEur, money.actualEur)
      : null;
  // The calm "davon durch Netzladen verdient" extra line - only when an
  // arbitrage attribution exists (grid-charging sites with grid-charged
  // energy in the window; captain pick 2026-07-07).
  const arbitrage = saved != null ? arbitrageLine(money?.arbitrageEur ?? null) : null;

  return (
    <section className="vp-fleet-hero" aria-label={fleetHeadline(kind)}>
      <span className="vp-fleet-hero-label">{fleetHeadline(kind)}</span>
      {saved == null ? (
        <>
          <span className="vp-fleet-hero-value">–</span>
          <span className="vp-fleet-hero-sub">
            {unavailable
              ? 'Der Wert ist gerade nicht verfügbar. Bitte versuchen Sie es später erneut.'
              : emptyHint ??
                'Für diesen Zeitraum liegen noch keine berechenbaren Messwerte vor. Sobald Ihre Anlage misst und Börsenpreise vorliegen, erscheint hier Ihr Wert.'}
          </span>
        </>
      ) : (
        <>
          <span className="vp-fleet-hero-value">
            {animated != null && animated >= 0 ? '+' : ''}
            {eurAmount(animated ?? saved)}
          </span>
          <span className="vp-fleet-hero-sub">
            {realizedSubline(kind, worded, now, money?.firstCoveredDate ?? null)}
          </span>
        </>
      )}

      {proof && (
        <div className="vp-fleet-hero-proof">
          <div>
            <span>{proof.mitLabel}</span>
            <span className="v">{eurAmount(proof.mitEur)}</span>
          </div>
          <div>
            <span>{proof.ohneLabel}</span>
            <span className="v">{eurAmount(proof.ohneEur)}</span>
          </div>
        </div>
      )}

      {arbitrage && <p className="vp-fleet-hero-arb">{arbitrage}</p>}

      {saved != null && benchmark && <p className="vp-fleet-hero-arb">{benchmark}</p>}

      <div className="vp-fleet-seg" role="tablist" aria-label="Zeitraum">
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

      {dailySaved.length > 1 && (
        <FleetSpark spark={spark} today={today} aussage={aussage} />
      )}

      {/* Das Kleingedruckte sind ~9 Zeilen. Am Telefon standen sie offen
          zwischen dem Geld und den Anlagen-Karten; jetzt tragen sie ein
          InfoTip - dasselbe Muster wie ueberall sonst im Portal, und der Text
          ist unveraendert erreichbar (Mobil-Umbau Stufe 4). */}
      {isPhone ? (
        <p className="vp-fleet-hero-fine vp-fleet-fine-tip">
          <InfoTip title="Wie diese Zahl zu lesen ist" label="Erläuterung zur Zahl">
            {realizedFinePrint(
              kind,
              worded,
              money?.firstCoveredDate ?? null,
              premium,
              arbitrage != null,
              premiumDetail,
            )}
          </InfoTip>
          <span>Wie diese Zahl zu lesen ist</span>
        </p>
      ) : (
        <p className="vp-fleet-hero-fine">
          <span className="vp-fleet-fine-ico" aria-hidden="true">
            <Icon name="info" size={13} />
          </span>
          {realizedFinePrint(kind, worded, money?.firstCoveredDate ?? null, premium, arbitrage != null, premiumDetail)}
        </p>
      )}
    </section>
  );
}

/** The one fleet-level German sentence: green calm, amber when a device is silent. */
export function FleetStatusCard({ overview, now }: { overview: Overview; now: Date }) {
  const sentence = composeFleetSentence(overview.sites, now);
  return (
    <Card padding="lg" radius="lg" className="vp-fleet-status" style={{ minWidth: 0 }}>
      <p className={`vp-fleet-sentence tone-${sentence.tone}`}>
        <span className="vp-fleet-dot" aria-hidden="true" />
        <span>{sentence.text}</span>
      </p>
    </Card>
  );
}

/** Compact verdict tile of a fleet site card (Solar/Batterie/Haus/Netz). */
function FleetTile({
  cls,
  label,
  value,
  children,
}: {
  cls: string;
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className={`vp-ftile ${cls}`}>
      <span className="vp-ftile-head">
        <i className="vp-ftile-ic" aria-hidden="true" />
        {label}
      </span>
      <span className="vp-ftile-val">{value}</span>
      {children}
    </div>
  );
}

/**
 * One site of the fleet: pulsing status dot (worst device status), the four
 * verdict tiles with direction words (never signed numbers), the SoC bar, and
 * the per-site money teaser - since Phase 2 the MEASURED "Heute +X €" in the
 * site's own wording (it is history, so it shows even while the live snapshot
 * is stale); a structurally non-computable site says so honestly. A site
 * without fresh data degrades honestly ("Keine aktuellen Daten · zuletzt vor
 * X") - stale numbers never render as live.
 */
export function FleetSiteCard({
  site,
  earnings,
  now,
  onOpen,
}: {
  site: OverviewSite;
  earnings: EarningsSite | null;
  now: Date;
  onOpen: () => void;
}) {
  const fresh = siteLiveFresh(site, now);
  const reason = earnings?.reason ?? null;
  const earn = earnings
    ? siteEarnText(site.plantKind, savedOnDay(earnings.dailySaved, berlinDay(now)))
    : null;
  // "nicht berechenbar" only for structural reasons; a site that simply has no
  // measurements yet keeps the calmer onboarding/prüfen copy below.
  const notComputable = reason != null && reason !== 'no_data';
  const dotTone =
    site.worstStatus === 'online' ? 'ok' : site.worstStatus === 'stale' ? 'warn' : 'off';

  const live = site.live;
  const soc = live ? sanitizeSoc(live.socPct) : null;
  const battKw = live ? deriveBatteryKw(live.pvKw, live.loadKw, live.gridKw) : null;
  const batt = batteryState(soc, battKw);
  const grid = live ? gridState(live.gridKw) : 'unbekannt';
  const battWord =
    batt === 'laedt' ? 'lädt' : batt === 'entlaedt' ? 'entlädt' : batt === 'voll' ? 'voll' : 'bereit';
  const gridWord =
    grid === 'bezug'
      ? 'Netzbezug'
      : grid === 'einspeisung'
        ? 'Einspeisung'
        : grid === 'ausgeglichen'
          ? 'ausgeglichen'
          : '–';

  return (
    <Card
      interactive
      className="vp-fleet-site"
      style={{ minWidth: 0 }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Anlage ${site.name} öffnen`}
    >
      <div className="vp-fleet-site-head">
        <span className="vp-fleet-site-name">
          <span className={`vp-fleet-dot tone-${dotTone}`} aria-hidden="true" />
          {site.name}
        </span>
        <span className="vp-fleet-site-count">
          {site.deviceCount === 1 ? '1 Gerät' : `${site.deviceCount} Geräte`}
        </span>
      </div>

      <div className="vp-fleet-site-mode">
        <NetzladenBadge erlaubt={site.netzladenErlaubt} small />
        {site.batteryWithoutDevice && (
          <span className="vp-fleet-batt-warn" title={BATTERY_NO_DEVICE_SHORT}>
            <Icon name="alert-triangle" size={13} />
            {BATTERY_NO_DEVICE_SHORT}
          </span>
        )}
      </div>

      {site.deviceCount === 0 ? (
        <p className="vp-fleet-site-body">
          Hier ist noch kein Gerät verbunden.
        </p>
      ) : fresh && live ? (
        <div className="vp-ftiles">
          <FleetTile cls="pv" label="Solar" value={fmtNum(live.pvKw, 'kW')} />
          <FleetTile
            cls="batt"
            label="Batterie"
            value={soc == null ? '–' : `${fmtNum(soc, '%', 0)} · ${battWord}`}
          >
            {soc != null && (
              // Der Ladestand ist ein ANTEIL (0-100 %), also der Anteils-
              // Baustein in seiner kleinsten Höhe - nicht die Sparkline.
              <MiniShareBar
                className="vp-ftile-soc"
                size="micro"
                fraction={soc / 100}
                color="var(--vp-flow-batt, #34c77b)"
              />
            )}
          </FleetTile>
          <FleetTile cls="load" label="Haus" value={fmtNum(live.loadKw, 'kW')} />
          <FleetTile cls="grid" label="Netz" value={gridWord} />
        </div>
      ) : (
        <p className="vp-fleet-site-body">
          {site.waitingCount === site.deviceCount
            ? 'Wartet auf die ersten Daten Ihres Geräts.'
            : `Keine aktuellen Daten · zuletzt ${fmtRelative(live?.ts ?? site.lastSeenAt, now)}`}
        </p>
      )}

      <div
        className={`vp-fleet-site-earn${earn && !notComputable ? '' : ' muted'}`}
        title={notComputable && reason ? notComputableHint(reason) : undefined}
      >
        <span>
          {site.deviceCount === 0
            ? 'Gerät hinzufügen'
            : notComputable
              ? 'Für diese Anlage nicht berechenbar'
              : earn ??
                (fresh ? 'Details ansehen' : 'Anlage prüfen')}
        </span>
        <span className="vp-fleet-chev" aria-hidden="true">
          ›
        </span>
      </div>
    </Card>
  );
}
