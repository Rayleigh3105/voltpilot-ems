import React from 'react';
import { Card } from '../core/Card';
import { IconTile } from '../core/IconTile';

/**
 * VoltPilot KpiCard — one tile of the dashboard KPI row: category IconTile
 * next to a big Stat-style number with a muted label. Composition of the
 * existing Card/IconTile primitives (tokens only).
 */
export function KpiCard({
  icon,
  category = 'primary',
  value,
  label,
  style = {},
  ...props
}) {
  return (
    <Card className="vp-kpi" style={{ display: 'flex', ...style }} {...props}>
      <IconTile category={category} size={40}>{icon}</IconTile>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
        <span className="vp-stat-val">{value}</span>
        <span className="vp-stat-lbl">{label}</span>
      </div>
    </Card>
  );
}
