import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteSource } from '../api';
import { fmtNum } from '../format';
import { healthTitle, pvBreakdown, type PvPart } from '../pvSources';

/**
 * The calm per-source PV breakdown under the live PV figure: "39,0 kW = Deye 8,3
 * + Fronius Anlage 21,3 + Fronius WR 2 9,3", each part with a freshness dot.
 *
 * It renders ONLY when it explains something (2+ measuring devices) - a
 * single-inverter site is byte-identical to before. All derivation lives in the
 * pure, unit-tested `pvSources.ts`; this component only renders it.
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
