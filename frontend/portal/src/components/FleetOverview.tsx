import { type KeyboardEvent, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsSite, OverviewSite } from '../api';
import {
  BATTERY_NO_DEVICE_SHORT,
  berlinDay,
  notComputableHint,
  savedOnDay,
  siteEarnText,
  siteLiveFresh,
} from '../fleet';
import { fmtNum, fmtRelative } from '../format';
import { batteryState, deriveBatteryKw, gridState } from '../live';
import { sanitizeSoc } from '../plausible';
import { MiniShareBar } from './MiniChart';
import { NetzladenBadge } from './NetzladenBadge';

/**
 * Die KARTE einer Anlage — die letzte verbliebene Fläche dieser Datei.
 *
 * ⚠ Der Geld-HELD (`EarningsHero`) und die Status-KARTE (`FleetStatusCard`)
 * sind mit der Portfolio-Revision 2 ERSATZLOS entfallen (Captain 25.08.2026):
 * der Marken-Verlauf gehört Login und Marketing, im Betriebs-Portal ist Geld
 * eine Zelle der Kennzahlen-Leiste, und die Flotten-Aussage ist EINE Zeile
 * unter dem Titel (`portfolioCockpit.flottenAussage`). Ihre Ehrlichkeitsregeln
 * (Verlusttag unter der Nulllinie, Strich statt Mindesthöhe, kein Nullbalken)
 * sind unberührt — sie wohnen im reinen `miniChart.ts` und sind dort geprüft.
 *
 * `FleetSiteCard` selbst lebt weiter: sie ist die Karte der Anlagen-LISTE
 * (`#/anlagen`). Das Portfolio rendert am Telefon seine eigene Karte in der
 * Zeilen-Grammatik der Tabelle (`AnlagenTabelle`).
 *
 * Alles Formulierende liegt im reinen `fleet.ts`/`live.ts`; hier wird nur
 * gezeichnet.
 */

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
