# Prognosen und Modellwahl

VoltPilot erzeugt mehrere Prognosereihen, verwendet für die Planung aber jeweils das ausgewählte Last- und PV-Modell. Kandidaten können parallel bewertet werden, ohne den laufenden Betrieb zu ändern.

```mermaid
flowchart TD
    Daten["Messhistorie und Wetter"] --> Basis["Basismodelle"]
    Daten --> Gate{Genügend Trainingsdaten?}
    Gate -->|Nein| Sammeln["Sammelt Daten"]
    Gate -->|Ja| ML["XGBoost-Kandidaten"]
    Basis --> Speicher["Prognosen mit Modell und Erstellzeit speichern"]
    ML --> Speicher
    Speicher --> Bewertung["Mit späteren Messungen vergleichen"]
    Speicher --> Wahl["Aktives Modell je Anlage"]
    Bewertung --> Portal["Prognosequalität: Auswahl begründen"]
    Portal --> Wahl
    Wahl --> Plan["Optimierer: ausgewählte Reihe und Nowcast"]
```

## Modelle

| Modellkennung | Aufgabe |
|---|---|
| `load-persistence` | Last aus vorhandener Historie / Baseline |
| `pv-physical` | Physikalische PV-Prognose |
| `load-xgb` | Gelernte Lastprognose |
| `pv-residual-xgb` | Gelernte Korrektur der physikalischen PV-Prognose |

Trainingsvoraussetzungen und Defaults stehen in [Registry](../services/forecast/voltpilot_forecast/registry.py) und [ML](../services/forecast/voltpilot_forecast/ml.py). Ohne ausreichende Daten wird `collecting` mit Fortschritt gemeldet; der Kandidat liefert dann keine vorgetäuschte Prognose. Training und Bewertung verwenden den vorgesehenen Berlin-Tagesbezug.

## Auswahl und Rücknahme

Die wirksame Auswahl folgt dieser Reihenfolge:

1. Letzte Entscheidung der Anlage in `site_forecast_model_choice`.
2. Plattformvorgabe in `forecast_model_choice`.
3. `VOLTPILOT_ACTIVE_LOAD_MODEL` beziehungsweise `VOLTPILOT_ACTIVE_PV_MODEL`.
4. Basismodell der Registry.

Die Auswahl im Portal gilt nur für diese Anlage und wird append-only protokolliert. Ein späterer Env-Wechsel überschreibt sie nicht. Die API prüft auch serverseitig, ob ein Kandidat noch sammelt beziehungsweise ob eine Tagesbewertung vorliegt. Rücknahme erfolgt durch erneute Wahl eines verfügbaren Modells.

API, Collector und Optimierer müssen dieselbe Auswahl auflösen. Quellen: `ForecastModels`, `model_choice.py`, `inputs.py`.

## Qualität richtig lesen

Pro Viertelstunde zählt die jüngste Prognose, die **vor oder zum Slotbeginn** vorlag. Spätere Vorhersagen dürfen den Rückblick nicht verbessern.

| Kennzahl | Bedeutung |
|---|---|
| MAE | Mittlere absolute Abweichung in kW |
| nMAE | Normierte Abweichung; bei nicht sinnvoller Bezugsgröße unbekannt |
| Bias | Vorzeichenbehaftete mittlere Abweichung |
| Skill | Vergleich mit dem aktiven Modell dieser Anlage; positiv bedeutet besser |

Die historische Spalte `skill_vs_baseline` trägt weiterhin ihren Namen, obwohl die Referenz das aktive Modell sein kann. `plan_accuracy` vergleicht nur Slots mit den erforderlichen Plan-, Mess- und Preisdaten. Fehlende Daten sind keine Nullabweichung.

## PV-Nowcast

Der Optimierer kann den nahen PV-Horizont anhand des jüngsten gemessenen Fehlers korrigieren. Diese begrenzte, abklingende Korrektur wird nicht unter dem Namen des ursprünglichen Prognosemodells zurückgeschrieben.

Daher misst `forecast_accuracy` die gespeicherte Modellprognose; die tatsächlich zur Planung verwendete Korrektur gehört in die Plandiagnose. Schalter und Grenzen: `OPTIMIZER_PV_ANCHOR_*` in [config.py](../services/optimization/voltpilot_optimization/config.py), Berechnung in [nowcast.py](../services/optimization/voltpilot_optimization/nowcast.py).

## Unsicherheit für „Sonne + Speicher“

Die Prognosen liefern keine Quantile. Die [Speicheruntergrenze](verbrauchssteuerung.md#sonne--speicher) liest deshalb gemessene Fehlerverteilungen der gespeicherten Prognosen, je Anlage und aktivem Modell, letzte 28 abgeschlossene Nächte beziehungsweise Tage:

| Reihe | Fehler je Nacht/Tag | Verwendet | Quelle |
|---|---|---|---|
| Last | `Σ gemessen / Σ prognostiziert − 1` der Nacht, Abendlauf 17:45 des Vortags | Q0,9 als Aufschlag | `night_reserve.night_error_quantiles` |
| PV | dasselbe über 06–21 Uhr Berlin, mindestens 51 der 60 Viertelstunden gepaart, Tage unter 1 kWh Prognose ausgelassen | Q0,1 als Abschlag | `storage_release.pv_day_error_quantiles` |

Beide Zahlen wirken nur in die vorsichtige Richtung. Unter sieben auswertbaren Nächten/Tagen gelten dokumentierte Vorgaben (+25 % / −30 %). Gemessen wird die gespeicherte Modellprognose, nicht die Planzeitkorrektur des Nowcasts. Reicht der Fahrplan nicht bis zur nächsten Erzeugung, liest die Untergrenze die frischen gespeicherten Läufe darüber hinaus; sind sie älter als `OPTIMIZER_STORAGE_RELEASE_FORECAST_MAX_AGE_MINUTES` (120), gibt es keine Freigabe.

## Betrieb

[Forecast-Service](../services/forecast/README.md) nennt Start- und Testbefehle. Tabellen und Rechte werden über die API-Migrationen gepflegt. Modellwahl und Kundenauswertung sind mandantengebunden; Backend-Collector haben eigene Schreibzugänge.

Eine neue Modellidee ist erst verfügbar, wenn Registry, Datengrundlage, Trainings-/Bewertungsweg und Tests existieren. Automatische Beförderung wird durch dieses Dokument nicht zugesagt.
