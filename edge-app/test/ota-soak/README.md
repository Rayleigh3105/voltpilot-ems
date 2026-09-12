# OTA-Fehlerfälle prüfen

Die Matrix testet den echten Updater mit Docker, Registry und einer temporären Signaturkette. Core und Node-RED sind kleine Stellvertreter; geprüft wird der Tauschablauf, keine Hardwaresteuerung.

Aus diesem Verzeichnis:

```bash
./run.sh --list      # verfügbare Fälle
./run.sh            # gesamte Matrix
./run.sh happy prune
./run.sh --keep      # Arbeitsstand zur Diagnose erhalten
```

| Fälle | Prüffrage |
|---|---|
| `happy`, `selftest_fail` | Neuer Stand bestätigt oder alter wiederhergestellt? |
| `registry_outage`, `wedged_pull` | Läuft der alte Stand bei Downloadproblemen weiter? |
| `mid_flip_reboot`, `clock_skew` | Bleibt der Zustand nach Unterbrechung nachvollziehbar? |
| `broker_outage`, `disk_full` | Greifen Rückfall und Ressourcenprüfungen? |
| `prune`, `image_cleanup` | Bleiben benötigte Images verfügbar? |

Ziel jedes Falls: alter Stack läuft oder neuer Stack ist bestätigt. Das ist eine Testanforderung und keine pauschale Garantie für jede Störung auf realer Hardware.

Eigenes Compose-Projekt `vp-ota-soak`, eigene Ports/Volumes; jeweils ein Stack. Unter 2 GiB freiem Platz wird abgebrochen. Aufräumen betrifft eigene Artefakte; es gibt keinen unbeschränkten `docker system prune`. Der Updater wird mit einer Wegwerf-Wurzel gebaut, weil die Produktionswurzel kein Runtime-Schalter ist.

Fehlerbelege werden vor dem Aufräumen unter `last-failure/` gesichert. `core-signal.json` und `self-test.json` liefern den simulierten Core-Zustand; die Core-Hälfte prüfen die Go-Tests in `internal/agent/ota_autonomy_test.go`.

Dauerhafte Regeln: zurückgerollte Zuweisungen nicht automatisch wiederholen; vorausgeladene neuere Images nicht beim Aufräumen entfernen. [Betrieb und Hardwareprüfung](../../../docs/ota-autonomie.md)
