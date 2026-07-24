import { useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import { boardHint, hasAnySpark } from '../livePuls';
import type { LivePulsChannel, LivePulsRow, Spark } from '../livePuls';

import './LivePuls.css';

/**
 * Live-Daten „Komponenten-Board" (design report §1/§4 V3): one row per
 * component — health dot, icon, name, the live value with its state word, a
 * 60-minute sparkline and a „Verlauf →" jump into the explorer pre-focused on
 * that measurement. A component with several Messwerte expands to list them all
 * (each its own jump). Thin + render-only — every value/state/target is the
 * pure `livePuls.ts`; this component only draws it.
 */

const HEALTH: Record<string, { cls: string; title: string }> = {
  ok: { cls: 'vp-health-ok', title: 'Liefert Daten' },
  stale: { cls: 'vp-health-warn', title: 'Meldet gerade keine Daten' },
  never: { cls: 'vp-health-off', title: 'Noch keine Daten' },
  // H2: nichts gemeldet ist NICHT „liefert Daten" - grau, mit ehrlichem Titel.
  unknown: { cls: 'vp-health-off', title: 'Noch keine Rückmeldung' },
};

/** Sparkline hue: by the plotted channel first (a hybrid's PV reads orange),
 *  else the component role. Mirrors the VerlaufChart palette. */
function sparkColor(row: LivePulsRow): string {
  const t = chartTheme();
  const ch = row.target?.channel ?? '';
  switch (ch) {
    case 'soc_pct':
    case 'soc':
      return t.soc;
    case 'pv_power_kw':
    case 'pv':
      return t.pv;
    case 'battery_power_kw':
      return t.charge;
    case 'load_kw':
    case 'haus':
      return t.load;
    case 'temperature_c':
      return t.temp;
  }
  switch (row.role) {
    case 'pv':
      return t.pv;
    case 'storage':
      return t.soc;
    case 'grid':
      return t.price;
    case 'consumer':
    default:
      return t.load;
  }
}

/** A dependency-free 60-minute SVG sparkline; gaps (null) break the line. */
function Sparkline({ spark, color }: { spark: Spark; color: string }) {
  const W = 100;
  const H = 30;
  const pad = 2;
  const n = spark.values.length;
  const span = spark.max - spark.min || 1;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => H - pad - ((v - spark.min) / span) * (H - pad * 2);

  // Break the polyline on null so an absent bucket is an honest gap.
  const segments: string[] = [];
  let cur: string[] = [];
  spark.values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segments.push(cur.join(' '));
      cur = [];
      return;
    }
    cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) segments.push(cur.join(' '));

  return (
    <svg
      className="vp-puls-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
    >
      {segments.map((pts, i) => (
        <polyline
          key={i}
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** One measurement in the expanded list — its own „Verlauf →" jump. */
function ChannelItem({
  channel,
  onOpen,
}: {
  channel: LivePulsChannel;
  onOpen: (t: { entityId: string; channel: string }) => void;
}) {
  return (
    <button
      type="button"
      className="vp-puls-ch"
      onClick={() => onOpen({ entityId: channel.entityId, channel: channel.channel })}
      title={`„${channel.label}" im Verlauf öffnen`}
    >
      <span className="vp-puls-ch-label">{channel.label}</span>
      {channel.unit && <span className="vp-puls-ch-unit">{channel.unit}</span>}
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

function Row({
  row,
  spark,
  showSparkSlot,
  onOpen,
}: {
  row: LivePulsRow;
  spark: Spark | null;
  /** V5: der Platz wird nur reserviert, wenn das Board überhaupt Linien hat. */
  showSparkSlot: boolean;
  onOpen: (t: { entityId: string; channel: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const dot = HEALTH[row.health] ?? HEALTH.unknown;
  const canExpand = row.channels.length > 1;

  return (
    <div className={`vp-puls-row${row.stateTone === 'muted' ? ' muted' : ''}`}>
      <div className="vp-puls-line">
        <button
          type="button"
          className="vp-puls-jump"
          disabled={row.target == null}
          onClick={() => row.target && onOpen(row.target)}
          title={row.fullTitle ?? row.title}
        >
          <span className={`vp-health-dot ${dot.cls}`} title={dot.title} aria-hidden="true" />
          <span className="vp-puls-ico">
            <Icon name={row.icon} size={16} />
          </span>
          <span className="vp-puls-body">
            <span className="vp-puls-name">{row.title}</span>
            <span className="vp-puls-state">
              {row.arrow && <Icon name={row.arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={13} />}
              {row.stateLabel}
              {row.subLine && <span className="vp-puls-sub"> · {row.subLine}</span>}
            </span>
            {row.socPct != null && (
              <span className="vp-puls-socbar" aria-hidden="true">
                <span style={{ width: `${row.socPct}%` }} />
              </span>
            )}
          </span>
          {spark ? (
            <Sparkline spark={spark} color={sparkColor(row)} />
          ) : showSparkSlot ? (
            <span className="vp-puls-spark vp-puls-spark-none" aria-hidden="true" />
          ) : null}
          <span className="vp-puls-val">{row.value}</span>
          <span className="vp-puls-go" aria-hidden="true">
            Verlauf
            <Icon name="chevron-right" size={15} />
          </span>
        </button>
        {canExpand ? (
          <button
            type="button"
            className={`vp-puls-expand${open ? ' is-open' : ''}`}
            aria-expanded={open}
            aria-label={open ? 'Messwerte einklappen' : 'Alle Messwerte anzeigen'}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={18} />
          </button>
        ) : (
          /* V10: die Spalte bleibt reserviert, sonst sind Zeilen MIT Chevron
             schmaler als Zeilen ohne - am Telefon fiel das sofort auf. */
          <span className="vp-puls-expand-spacer" aria-hidden="true" />
        )}
      </div>
      {canExpand && open && (
        <div className="vp-puls-channels">
          {row.channels.map((c) => (
            <ChannelItem key={`${c.entityId}:${c.channel}`} channel={c} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

export function LivePuls({
  rows,
  sparks,
  onOpenVerlauf,
}: {
  rows: LivePulsRow[];
  /** Sparks keyed by row.key (a missing / null entry = no sparkline, honest). */
  sparks: Map<string, Spark | null>;
  onOpenVerlauf: (target: { entityId: string; channel: string }) => void;
}) {
  // V5: „letzte 60 Min" wird nur versprochen, wenn wirklich eine Linie da ist.
  const anySpark = hasAnySpark(sparks);
  const hint = boardHint(anySpark);
  return (
    <div className="vp-puls" aria-label="Komponenten im Detail">
      <div className="vp-puls-head">
        <h3>Komponenten</h3>
        <span className="vp-puls-hint">
          {hint.spark && <span className="vp-puls-hint-spark">{hint.spark} · </span>}
          {hint.jump}
        </span>
      </div>
      <div className="vp-puls-rows">
        {rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            spark={sparks.get(row.key) ?? null}
            showSparkSlot={anySpark}
            onOpen={onOpenVerlauf}
          />
        ))}
      </div>
    </div>
  );
}
