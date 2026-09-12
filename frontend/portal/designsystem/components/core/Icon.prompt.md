# Icon

Gemeinsamer SVG-Iconsatz: 24er-Raster, abgerundete 2-Pixel-Linie, `currentColor`. Navigation, Buttons, Status und IconTiles verwenden denselben Satz; keine Emoji-Ersatzzeichen.

```jsx
<Icon name="zap" size={18} />
<Icon name="check" size={13} strokeWidth={3} />
```

| Prop | Vorgabe | Bedeutung |
|---|---|---|
| `name` | erforderlich | `IconName` aus `Icon.d.ts` |
| `size` | 20 | Breite und Höhe in Pixeln |
| `strokeWidth` | 2 | Linienstärke |

Das SVG ist `aria-hidden`; bei einem Button ohne Text muss der Button einen zugänglichen Namen tragen. Pfade stammen aus Lucide (ISC-Lizenz); Raster und Linienkonvention bei Ergänzungen erhalten.
