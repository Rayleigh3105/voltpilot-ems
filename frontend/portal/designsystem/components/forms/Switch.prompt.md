# Switch

Beschrifteter Ein-/Aus-Schalter; aktiv mit blauem Verlauf. Der Zustand wird von außen geführt.

```jsx
const [on, setOn] = React.useState(false);
<Switch checked={on} onChange={() => setOn(!on)} label="Dynamischer Tarif" />
```

Props: `checked`, `onChange`, `disabled`, `label`, `id`. Immer eine verständliche Beschriftung beziehungsweise einen zugänglichen Namen setzen.
