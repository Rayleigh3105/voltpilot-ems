# Prognose-Service

Erstellt Last-/PV-Prognosen, trainiert optionale XGBoost-Kandidaten und bewertet gespeicherte Vorhersagen gegen Messungen. Ein gesonderter Collector im selben Paket holt Wetterdaten.

## Start und Tests

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev,ml]'
python -m voltpilot_forecast
pytest
```

`python -m voltpilot_forecast` ist eine **Offline-Demo**, kein Collector. Für den Datenbankbetrieb:

```bash
python -m voltpilot_forecast.forecast_collect --help
python -m voltpilot_forecast.weather_collect --help
```

Beide bieten einmaligen und periodischen Betrieb. Im lokalen Compose-Profil `feeds` laufen Wetter- und Prognose-Collector. Ohne `[ml]` sind Basismodelle nutzbar; XGBoost benötigt die passende OpenMP-Laufzeit der Plattform.

## Quellen

- `registry.py`, `ml.py`, `features.py`: Modelle und Trainingsvoraussetzungen.
- `model_choice.py`: Auswahl je Anlage vor Plattformvorgabe und Env-Default.
- `evaluate.py`: Tagesbewertung ohne zukünftige Vorhersagen.
- `openmeteo.py`: Wetteradapter.

[Modelllebenszyklus und fachliche Regeln](../../docs/forecasting.md), [Betriebsvertrag](../../docs/k8s-readiness.md).

## Stundenwerte und physikalische PV-Grenze

Die Strahlungswerte des Wetteradapters beziehen sich auf die vorhergehende Stunde. `OpenMeteoWeatherProvider` verteilt deren Energie nach Sonnenstand auf Viertelstunden; ihr Mittel bleibt gleich, Viertelstunden ohne Sonne werden null. Die gespeicherten Testdaten stehen in `tests/fixtures/README-pilsting.md`.

`pvceiling.py` begrenzt Prognosen einschließlich Residualmodell durch die zur Anlagengeometrie passende Klarhimmel-Hülle. `VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED` ist standardmäßig true; `VOLTPILOT_PV_CLEAR_SKY_HEADROOM` beträgt 1,25 und muss mindestens 1 sein. Direktstrahlung erhält ihre eigene Luftmassenkurve; die Hülle wird nicht enger als die horizontale Ebene.
