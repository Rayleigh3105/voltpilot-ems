# Steuerstand des Speichers im Herzschlag

Der Status-Herzschlag der Box (`ems/{tenant_id}/{site_id}/{device_id}/status`, alle 15 s) trägt seit 07.10.2026 den additiven Block `battery_control`: Steuert VoltPilot den Speicher dieser Box, oder beobachtet die Box ihn nur? Fälle und Lesarten aller drei Seiten: [Vektoren](speicher-steuerstand-vectors.json).

```json
"battery_control": {"state": "beobachtet", "control_enabled": false, "certified": false}
```

| Feld | Bedeutung |
|---|---|
| `state` | `gesteuert`: Steuerschalter (`VP_CONTROL_ENABLED`) an und Modell-/Gerätefreigabe, die Box schreibt den Speicher. `beobachtet`: Schalter an, keine Freigabe; die Box schreibt nichts, der Wechselrichter regelt selbst. `not_aus`: Schalter aus; die Box schreibt weder Speicher noch Wallbox. |
| `control_enabled` | Schalter UND Freigabe, dieselbe Bedeutung wie im `control`-Block und auf `edge/setpoint` |
| `certified` | Modell-/Gerätefreigabe (Umgebungsliste, First-Light oder Plattform-Register), wie `control.certified` |

## Warum ein eigener Block

Der `control`-Block meldet `control_enabled` und `certified` schon, aber nur mit einer Rücklesung des Wechselrichters (`controlSummary` gibt ohne sie nichts zurück). Edge Light liest nicht zurück und hat der Cloud deshalb nie gesagt, dass es den Speicher nicht steuert. `battery_control` reist in jedem Herzschlag, unabhängig von der Rücklesung, und kommt aus demselben Tor, das die Freigabe für „Sonne + Speicher“ liest (`commanded` in `applySetpoint`). Der Block gilt für den gemeinsamen Go-Core, also für Docker-Box und Edge Light.

Ohne gewählten Wechselrichter schickt die Box keinen Block: Unbekannt ist nicht beobachtet.

## Leser

| Seite | Regel | Ort |
|---|---|---|
| Box (schreibt) | Wort aus Schalter und Freigabe; kein Block ohne Wechselrichter | `edge-app/core/internal/agent/battery_control.go` |
| API (speichert) | streng: unbekanntes Wort, fehlendes oder nicht boolesches Flag und ein Wort, das seinen Flags widerspricht, werden verworfen. Eine Zeile je Box in `device_battery_control`, `reported_at` mit der Uhr der API beim Empfang, `state_since` bleibt bei gleichem Wort stehen | `ControlStatusListener`, `BatteryControlRepository`, Migration `V20261007120000` |
| Optimierer (plant) | frische Zeile (höchstens 10 min alt, `OPTIMIZER_BATTERY_CONTROL_MAX_AGE_MINUTES`) mit `beobachtet` oder `not_aus`: Eigenverbrauchs-Plan. Keine Zeile, eine veraltete Zeile oder ein unbekanntes Wort: gesteuert, wie vorher | `services/optimization/…/inputs.py` (`battery_observed`) |

Was der Optimierer daraus macht, steht in der Fachregel: [Fahrplan und Steuerstand](../verbrauchssteuerung.md#sonne--speicher).

## Verträglichkeit

- Eine ältere Box schickt keinen Block. Die API lässt dann keine Zeile entstehen beziehungsweise die alte veraltet, und der Optimierer plant den Speicher als gesteuert.
- Eine ältere API kennt den Block nicht und ignoriert ihn; ohne Migration gibt es keine Tabelle, und der Optimierer liest fail-soft „keine Meldung“.
- Neue Wörter sind ein Vertragswechsel: Box, API (`BatteryControlRepository.State`, CHECK-Bedingung der Tabelle), Optimierer und die Vektoren ändern sich zusammen.
