import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteSource } from '../api';
import { fmtNum } from '../format';
import { shareOf, type PvComposition, type PvContribution } from '../pvComposition';
import { healthTitle, pvBreakdown, type PvPart } from '../pvSources';
import './PvComposition.css';

/**
 * The calm per-source PV breakdown under the live PV figure: "39,0 kW = Deye 8,3
 * + Fronius Anlage 21,3 + Fronius WR 2 9,3", each part with a freshness dot.
 *
 * It renders ONLY when it explains something (2+ measuring devices) - a
 * single-inverter site is byte-identical to before. All derivation lives in the
 * pure, unit-tested `pvSources.ts`; this component only renders it.
 *
 * This is the V1 (un-migrated) surface, where the flow is the fixed 4-node
 * `EnergyFlow` and there is no clickable PV node. A migrated plant carries the
 * composition INSIDE the flow instead - see {@link PvCompositionDetails}.
 */
export function PvBreakdownLine({ sources }: { sources: SiteSource[] | null }) {
  const b = pvBreakdown(sources);
  if (!b) return null;
  return (
    <div className="vp-pvsplit">
      <span className="vp-pvsplit-head">
        <Icon name="sun" size={14} />
        Solar {fmtNum(b.totalKw, 'kW')} verteilt sich auf
      </span>
      <ul className="vp-pvsplit-parts">
        {b.parts.map((p) => (
          <Part key={p.id} part={p} />
        ))}
      </ul>
      {b.note && <p className="vp-pvsplit-note">{b.note}</p>}
    </div>
  );
}

function Part({ part }: { part: PvPart }) {
  const title = healthTitle(part.health, part.label);
  return (
    <li className="vp-pvsplit-part">
      <span className={`vp-pvsplit-dot ${part.health}`} title={title} aria-label={title} />
      <span className="vp-pvsplit-label">{part.label}</span>
      <span className="vp-pvsplit-val">{fmtNum(part.kw, 'kW')}</span>
    </li>
  );
}

/**
 * „Woraus setzt sich die Erzeugung zusammen?" - the panel a click on the
 * aggregated PV node opens (owner decision A1). It carries the concept's
 * designed content: a proportional share bar, then one row per inverter with
 * its value, its name and its freshness - and, below, every device that has no
 * own value NAMED with a plain-German reason instead of a bare "–".
 *
 * The rows sum to the number in the circle by construction: both come from the
 * one `pvComposition` derivation. Render-only.
 */
export function PvCompositionDetails({ composition }: { composition: PvComposition }) {
  const { parts, unmeasured, totalKw } = composition;
  return (
    <div className="vp-pvcomp">
      <div className="vp-pvcomp-head">
        <span className="vp-pvcomp-title">PV-Erzeugung setzt sich zusammen aus</span>
        <span className="vp-pvcomp-count">
          {composition.deviceCount} {composition.deviceCount === 1 ? 'Gerät' : 'Geräte'}
        </span>
      </div>

      {totalKw != null && parts.length > 0 && (
        <div className="vp-pvcomp-bar" aria-hidden="true">
          {parts.map((p, i) => (
            <span
              key={p.key}
              className="vp-pvcomp-seg"
              style={{
                flexGrow: Math.max(shareOf(p, composition), 0.001),
                opacity: 1 - i * 0.24,
              }}
            />
          ))}
        </div>
      )}

      <ul className="vp-pvcomp-rows">
        {parts.map((p) => (
          <Row key={p.key} row={p} />
        ))}
        {unmeasured.map((p) => (
          <Row key={p.key} row={p} />
        ))}
      </ul>
    </div>
  );
}

function Row({ row }: { row: PvContribution }) {
  const title = row.kw == null ? row.title : healthTitle(row.health, row.label);
  return (
    <li className={`vp-pvcomp-row${row.kw == null ? ' quiet' : ''}`}>
      <span
        className={`vp-pvsplit-dot ${row.kw == null ? 'never' : row.health}`}
        title={healthTitle(row.health, row.label)}
        aria-hidden="true"
      />
      <span className="vp-pvcomp-name" title={title}>
        {row.label}
      </span>
      {row.kw == null ? (
        <span className="vp-pvcomp-note">{row.note}</span>
      ) : (
        <span className="vp-pvcomp-val">{fmtNum(row.kw, 'kW')}</span>
      )}
    </li>
  );
}
