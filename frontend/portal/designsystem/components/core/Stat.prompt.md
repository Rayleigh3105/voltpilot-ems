# Stat

Große Kennzahl über einer kurzen Beschriftung. Einheit und Zeitbezug nennen; fehlende Daten nicht durch Null ersetzen.

```jsx
// Fiktive Darstellungsbeispiele:
<Stat value="8,2 kW" label="Aktuelle PV-Leistung" />
<Stat value="24 kWh" label="Erzeugung heute" align="center" />
```

Props: `value`, `label`, `align` (`left` oder `center`). Farbe: `--vp-stat-ink` beziehungsweise `--vp-action`.
