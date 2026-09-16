import { Recht } from './Recht';
import { Icon } from '../../designsystem/components/core/Icon';
import type { SiteSource } from '../api';
import { standLabel } from '../datenAlter';
import { fmtNum } from '../format';
import { shareOf, type PvComposition, type PvContribution } from '../pvComposition';
import { healthTitle, pvBreakdown, type PvPart } from '../pvSources';
import './PvComposition.css';
import { MiniShareBar } from './MiniChart';

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
export function PvBreakdownLine({
  sources,
  now = new Date(),
}: {
  sources: SiteSource[] | null;
  /**
   * Die Bezugszeit, gegen die das Daten-Alter geprüft wird. Sie entscheidet
   * AUSSCHLIESSLICH, ob der „Stand: HH:MM"-Ausweis erscheint — der Text selbst
   * ist statisch der Messzeitpunkt (`datenAlter.ts`).
   */
  now?: Date;
}) {
  const b = pvBreakdown(sources);
  if (!b) return null;
  const stand = standLabel(b.asOf, now);
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
      {/* Der Daten-Alter-Ausweis: er erscheint erst, wenn die Werte das
          Live-Fenster verlassen haben — eine frische Anlage sieht ihn nie. */}
      {stand && <p className="vp-pvsplit-stand">{stand}</p>}
    </div>
  );
}

function Part({ part }: { part: PvPart }) {
  const title = healthTitle(part.health, part.label);
  return (
    <li className="vp-pvsplit-part">
      <span className={`vp-pvsplit-dot ${part.health}`} title={title} aria-label={title} />
      <span className="vp-pvsplit-label">
        {part.label}
        {/* Eine gemessene Null neben produzierenden Geschwistern wird
            EINGEORDNET, nie stumm gelassen. Kein Alarm, kein Rot. */}
        {part.note && <span className="vp-pvsplit-hint"> · {part.note}</span>}
      </span>
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
export function PvCompositionDetails({
  composition,
  onRename,
  renameHref,
  now = new Date(),
}: {
  composition: PvComposition;
  /** Bezugszeit für den „Stand: HH:MM"-Ausweis — siehe {@link PvBreakdownLine}. */
  now?: Date;
  /**
   * Open the rename dialog for this row's component - the SHORTCUT of the alias
   * concept (§5): the wish is born looking at THIS list, so the pencil is here
   * too, opening the SAME mask as the Anlagen-Modell. Absent = no pencils (the
   * host has no rename path), and a `src:` row never gets one - assign it to a
   * component first.
   */
  onRename?: (row: PvContribution) => void;
  renameHref?: (row: PvContribution) => string | null;
}) {
  const { parts, unmeasured, totalKw } = composition;
  const stand = standLabel(composition.asOf, now);
  return (
    <div className="vp-pvcomp">
      <div className="vp-pvcomp-head">
        <span className="vp-pvcomp-title">PV-Erzeugung setzt sich zusammen aus</span>
        <span className="vp-pvcomp-count">
          {composition.deviceCount} {composition.deviceCount === 1 ? 'Gerät' : 'Geräte'}
        </span>
      </div>

      {totalKw != null && parts.length > 0 && (
        /* ⚠ Die Serien werden durch die FUGE getrennt, nicht mehr durch eine
           Deckkraft-Rampe. Die alte `opacity: 1 - i * 0,24` war ab dem
           fünften Gerät bei 0,04 - also unsichtbar (Befund §3b Nr. 22), und
           sie benannte ohnehin nichts: die Zuordnung Segment→Gerät trägt die
           REIHENFOLGE der Zeilen darunter. Eine Trennung über die Position
           ist skalenfrei und hält für beliebig viele Geräte; eine über die
           Deckkraft geht nach vier Stufen aus. Die eine PV-Farbe bleibt (F10:
           PV ist orange - fünf erfundene Farbtöne wären die andere,
           schlechtere Antwort). */
        <MiniShareBar
          className="vp-pvcomp-bar"
          segments={parts.map((p) => ({
            key: p.key,
            weight: Math.max(shareOf(p, composition), 0.001),
            className: 'vp-pvcomp-seg',
            title: p.label,
          }))}
        />
      )}

      <ul className="vp-pvcomp-rows">
        {parts.map((p) => (
          <Row key={p.key} row={p} onRename={onRename} renameHref={renameHref} />
        ))}
        {unmeasured.map((p) => (
          <Row key={p.key} row={p} onRename={onRename} renameHref={renameHref} />
        ))}
      </ul>
      {/* Der Daten-Alter-Ausweis: statisch der Messzeitpunkt, und nur, wenn die
          Werte das Live-Fenster verlassen haben (`datenAlter.ts`). */}
      {stand && <p className="vp-pvsplit-stand">{stand}</p>}
    </div>
  );
}

function Row({
  row,
  onRename,
  renameHref,
}: {
  row: PvContribution;
  onRename?: (row: PvContribution) => void;
  renameHref?: (row: PvContribution) => string | null;
}) {
  // R2: the technical name stays reachable as the row's tooltip even once the
  // customer's own name is what the row SAYS.
  const title = row.kw == null ? row.title : healthTitle(row.health, row.label);
  const href = row.entityId == null ? null : (renameHref?.(row) ?? null);
  const renameable = row.entityId != null && (href != null || onRename != null);
  return (
    <li className={`vp-pvcomp-row${row.kw == null ? ' quiet' : ''}`}>
      <span
        className={`vp-pvsplit-dot ${row.kw == null ? 'never' : row.health}`}
        title={healthTitle(row.health, row.label)}
        aria-hidden="true"
      />
      <span className="vp-pvcomp-name" title={title}>
        {row.label}
        {/* A row that HAS a value can still need an aside - a delivering device
            no component is pinned to says so instead of silently sliding its
            kW onto a neighbour (`vp-pin-werte-f8`). */}
        {row.kw != null && row.note && <span className="vp-pvcomp-hint"> · {row.note}</span>}
      </span>
      {renameable && href ? (
        <a
          className="vp-pvcomp-pencil"
          aria-label={`„${row.label}“ umbenennen`}
          href={href}
        >
          <Icon name="pencil" size={14} />
        </a>
      ) : renameable ? (
        <Recht aktion="geraet.einrichten"><button
          type="button"
          className="vp-pvcomp-pencil"
          aria-label={`„${row.label}“ umbenennen`}
          onClick={() => onRename!(row)}
        >
          <Icon name="pencil" size={14} />
        </button></Recht>
      ) : null}
      {row.kw == null ? (
        <span className="vp-pvcomp-note">{row.note}</span>
      ) : (
        <span className="vp-pvcomp-val">{fmtNum(row.kw, 'kW')}</span>
      )}
    </li>
  );
}
