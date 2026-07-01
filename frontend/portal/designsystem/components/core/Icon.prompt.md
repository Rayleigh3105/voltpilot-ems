# Icon

The shared stroke icon set of the VoltPilot design system: 24px grid, 2px rounded stroke, `currentColor`.
Use it everywhere an icon appears (navigation, IconTile contents, buttons, status marks, timelines).
Never use unicode/emoji glyphs (⚡ ☀ ⌂ …) as icons - they render as colored emoji on some platforms and break the visual language.

```jsx
import { Icon } from './Icon';

<Icon name="zap" size={18} />
<Icon name="check" size={13} strokeWidth={3} />
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `name` | `IconName` | - | See `Icon.d.ts` for the full list (dashboard, map-pin, zap, euro, sun, battery-charging, battery, history, building, users, activity, wifi, list, plus, x, menu, check, chevron-left/right, arrow-up/down, trending-up/down). |
| `size` | number | 20 | Width and height in px. |
| `strokeWidth` | number | 2 | Bump to 2.5-3 for very small sizes (<14px). |

The SVG inherits `color`, is `aria-hidden` and never shrinks in flex rows.
Inside an `IconTile`, pass roughly `size = tileSize / 2`.

Paths are from Lucide (ISC license); add new icons there first and keep the 24px/2px stroke convention.
