import React from 'react';
import { CardProps } from '../core/Card';

export interface KpiCardProps extends Omit<CardProps, 'children'> {
  /** Glyph for the category IconTile. */
  icon: React.ReactNode;
  /** IconTile category gradient. Default 'primary'. */
  category?: 'solar' | 'battery' | 'ev' | 'home' | 'industry' | 'dynamic' | 'primary';
  /** The big number/value. */
  value: React.ReactNode;
  /** Muted label under the value. */
  label: React.ReactNode;
}

/**
 * One KPI tile of the dashboard hero row (Card + IconTile + Stat composition).
 */
export function KpiCard(props: KpiCardProps): JSX.Element;
