Pill toggle — blue gradient track when on, white knob slides right.

```jsx
const [on, setOn] = React.useState(false);
<Switch checked={on} onChange={() => setOn(!on)} label="Dynamischer Tarif" />
```

Props: `checked`, `onChange`, `disabled`, `label`.
