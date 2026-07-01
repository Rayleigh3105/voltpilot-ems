import React from 'react';

export type IconCategory = 'solar' | 'battery' | 'ev' | 'home' | 'industry' | 'dynamic' | 'primary';

export interface IconTileProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Category gradient fill. Default 'home'. */
  category?: IconCategory;
  /** Pixel size of the square/circle. Default 56. */
  size?: number;
  /** 'rounded' (16px) or 'circle'. Default 'rounded'. */
  shape?: 'rounded' | 'circle';
}

/**
 * Gradient-filled icon container. Drop an SVG/glyph child inside.
 */
export function IconTile(props: IconTileProps): JSX.Element;
