Primary call-to-action button — gradient fill, brand-glow shadow, lifts on hover; use for the main action on a screen.

```jsx
<Button variant="primary" size="md">Beratung anfragen</Button>
<Button variant="outline">Mehr erfahren</Button>
<Button variant="white" iconRight={<span>→</span>}>Demo starten</Button>
```

Variants: `primary` (blue gradient, white text), `white` (white bg, deep-blue text — for hero/dark backgrounds), `outline` (blue border), `outline-light` (white border — on dark), `ghost` (text only). Sizes: `sm` · `md` · `lg`. Props: `fullWidth`, `disabled`, `iconLeft`, `iconRight`.
