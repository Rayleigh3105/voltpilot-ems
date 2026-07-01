import * as React from 'react';

export type IconName =
  | 'dashboard'
  | 'map-pin'
  | 'zap'
  | 'euro'
  | 'sun'
  | 'battery-charging'
  | 'battery'
  | 'history'
  | 'building'
  | 'users'
  | 'activity'
  | 'wifi'
  | 'list'
  | 'plus'
  | 'x'
  | 'menu'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'trending-up'
  | 'trending-down';

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export declare function Icon(props: IconProps): React.ReactElement;
