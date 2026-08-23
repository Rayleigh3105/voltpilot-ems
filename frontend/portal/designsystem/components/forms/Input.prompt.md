Text input with optional label, hint and error states. Focus shows a blue border + 3px brand ring.

Borders come from tokens, not from literals: `--vp-field-border` at rest (3,2:1 — the field's
edge is the only thing saying where it begins, WCAG 1.4.11), `--vp-primary-deep` on focus,
`--vp-industry` on error; radius `--vp-radius-btn` (12 px), so field and button are one family.
The `VpPicker` trigger carries the same look — change both together.

```jsx
<Input label="E-Mail" type="email" placeholder="name@firma.de" />
<Input label="PLZ" error="Bitte gültige PLZ eingeben" />
```

Props: `label`, `hint`, `error`, plus all native `<input>` attributes.
Forwards its ref to the native `<input>`, so callers can focus a field (e.g. focus-the-first-invalid-field on submit).
