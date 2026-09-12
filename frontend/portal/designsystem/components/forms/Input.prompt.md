# Input

Textfeld mit optionaler Beschriftung, Hinweis und Fehlermeldung. Der Ref zeigt auf das native Eingabefeld, etwa zum Fokussieren des ersten Fehlers nach Submit.

```jsx
<Input label="E-Mail" type="email" placeholder="name@firma.de" />
<Input label="PLZ" error="Bitte gültige PLZ eingeben" />
```

Props: `label`, `hint`, `error` und native Input-Attribute. Feldrand über `--vp-field-border`, Fokus über `--vp-primary-deep`, Fehler über `--vp-industry`; Radius `--vp-radius-btn`. `VpPicker` und Input verwenden dieselben Feldregeln. Kontrast nach Tokenänderungen erneut prüfen.
