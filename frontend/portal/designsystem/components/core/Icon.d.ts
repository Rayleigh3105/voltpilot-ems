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
  | 'alert-triangle'
  | 'info'
  | 'pencil'
  | 'trash'
  | 'settings'
  | 'calendar'
  | 'refresh-cw'
  | 'eye'
  | 'eye-off'
  | 'star'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'more-horizontal'
  | 'arrow-up'
  | 'arrow-down'
  | 'trending-up'
  | 'trending-down'
  | 'home'
  | 'cpu'
  | 'file-text'
  | 'link'
  | 'search'
  | 'lock'
  | 'shield'
  | 'log-out'
  | 'help-circle'
  | 'layers'
  | 'sliders'
  | 'smartphone'
  | 'code';

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}

export declare function Icon(props: IconProps): React.ReactElement;
