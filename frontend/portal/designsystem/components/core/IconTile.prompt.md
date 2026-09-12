# IconTile

Kategoriefläche für ein Icon aus dem gemeinsamen Satz. Keine Emoji-Glyphen verwenden.

```jsx
<IconTile category="solar" size={64}><Icon name="sun" size={32} /></IconTile>
<IconTile category="ev" shape="circle"><Icon name="zap" size={28} /></IconTile>
```

Props: `category` (`solar`, `battery`, `ev`, `home`, `industry`, `dynamic`, `primary`), `size` in Pixeln, `shape` (`rounded`, `circle`). Das Icon ist ungefähr halb so groß wie die Fläche.
