import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { Overview, OverviewSite } from '../api';
import {
  composeFleetSentence,
  fleetFinePrint,
  fleetHeadline,
  fleetKind,
  fleetSubline,
  siteEarnText,
  siteLiveFresh,
  type FleetKind,
} from '../fleet';
import { eurAmount, fmtNum, fmtRelative } from '../format';
import { batteryState, deriveBatteryKw, gridState } from '../live';
import { sanitizeSoc } from '../plausible';

/**
 * Presentational pieces of the fleet-mode Übersicht (multi-site customers):
 * the money hero on the brand gradient, the fleet status sentence, and the
 * per-site cards. All wording/derivation lives in the pure `fleet.ts` and
 * `live.ts`; these components only render it.
 */

/**
 * Count-up of the hero number (~0.8 s, ease-out) - the small "Verdien-Moment"
 * on every open. Animates from the previous value on refresh so a background
 * poll never snaps the number. Honors prefers-reduced-motion.
 */
function useCountUp(target: number | null, ms = 800): number | null {
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

/** Today's date in the platform timezone (Berlin) as an ISO day string. */
function berlinToday(now: Date): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/**
 * The money hero on the brand gradient: today's PLANNED savings/extra revenue,
 * honestly labelled, with the 14-day mini bar chart (per-day ex-ante savings)
 * and a plain-German fine-print line. No plan today => an honest "-", never a
 * fake zero.
 */
export function FleetHero({ overview, now }: { overview: Overview; now: Date }) {
  const kind: FleetKind = fleetKind(overview.sites.map((s) => s.plantKind));
  const savings = overview.totals.plannedSavingsTodayEur;
  const animated = useCountUp(savings);

  const days = overview.dailySavings;
  const today = berlinToday(now);
  const todayEntry = days.find((d) => d.day === today);
  const maxDay = days.reduce((m, d) => Math.max(m, d.savingsEur), 0);

  return (
    <section className="vp-fleet-hero" aria-label="Ihr VoltPilot-Vorteil heute">
      <span className="vp-fleet-hero-label">{fleetHeadline(kind)}</span>
      {savings == null ? (
        <>
          <span className="vp-fleet-hero-value">–</span>
          <span className="vp-fleet-hero-sub">
            Für heute liegt noch kein Fahrplan vor. Sobald VoltPilot Ihre Speicher plant,
            erscheint hier Ihr Tageswert.
          </span>
        </>
      ) : (
        <>
          <span className="vp-fleet-hero-value">
            {animated != null && animated >= 0 ? '+' : ''}
            {eurAmount(animated ?? savings)}
          </span>
          <span className="vp-fleet-hero-sub">{fleetSubline(kind)}</span>
        </>
      )}

      {days.length > 1 && (
        <>
          <div className="vp-fleet-spark" role="img" aria-label="Tageswerte der letzten 14 Tage">
            {days.map((d) => (
              <i
                key={d.day}
                className={d.day === today ? 'hi' : undefined}
                style={{
                  height: `${maxDay > 0 ? Math.max(8, Math.round((Math.max(0, d.savingsEur) / maxDay) * 100)) : 8}%`,
                }}
                title={`${d.day}: ${eurAmount(d.savingsEur)}`}
              />
            ))}
          </div>
          <div className="vp-fleet-spark-cap">
            <span>Tageswerte, letzte 14 Tage</span>
            {todayEntry && (
              <span>
                heute: {todayEntry.savingsEur >= 0 ? '+' : ''}
                {eurAmount(todayEntry.savingsEur)}
              </span>
            )}
          </div>
        </>
      )}

      <p className="vp-fleet-hero-fine">
        <span className="vp-fleet-fine-ico" aria-hidden="true">
          <Icon name="info" size={13} />
        </span>
        {fleetFinePrint(kind)}
      </p>
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
 * the per-site money teaser in the site's OWN wording. A site without fresh
 * data degrades honestly ("Keine aktuellen Daten · zuletzt vor X") - stale
 * numbers never render as live.
 */
export function FleetSiteCard({
  site,
  now,
  onOpen,
}: {
  site: OverviewSite;
  now: Date;
  onOpen: () => void;
}) {
  const fresh = siteLiveFresh(site, now);
  const earn = siteEarnText(site.plantKind, site.plannedSavingsTodayEur);
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
      aria-label={`Standort ${site.name} öffnen`}
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
              <span className="vp-ftile-soc" aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, soc))}%` }} />
              </span>
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

      <div className={`vp-fleet-site-earn${fresh && earn ? '' : ' muted'}`}>
        <span>
          {fresh && earn
            ? earn
            : site.deviceCount === 0
              ? 'Gerät hinzufügen'
              : fresh
                ? 'Details ansehen'
                : 'Standort prüfen'}
        </span>
        <span className="vp-fleet-chev" aria-hidden="true">
          ›
        </span>
      </div>
    </Card>
  );
}
