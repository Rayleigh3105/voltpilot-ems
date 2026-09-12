# Card

Weiße Fläche mit Rand und Schatten. `interactive` ergänzt Hover-Anhebung und Akzentleiste, erzeugt aber keine Klick- oder Tastaturaktion. Die tatsächliche Aktion braucht ein bedienbares Element.

```jsx
<Card accent="solar" padding="md">
  <h4>PV-Erzeugung</h4>
  <p>Messwerte und Verlauf der Anlage.</p>
</Card>
```

Props: `interactive`, `accent` (`primary`, `solar`, `battery`, `ev`, `home`, `industry`, `dynamic`), `padding` (`md`, `lg`), `radius` (`md`, `lg`).
