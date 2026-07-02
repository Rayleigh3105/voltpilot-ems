Text input with optional label, hint and error states. Focus shows a blue border + 3px brand ring.

```jsx
<Input label="E-Mail" type="email" placeholder="name@firma.de" />
<Input label="PLZ" error="Bitte gültige PLZ eingeben" />
```

Props: `label`, `hint`, `error`, plus all native `<input>` attributes.
Forwards its ref to the native `<input>`, so callers can focus a field (e.g. focus-the-first-invalid-field on submit).
