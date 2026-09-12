# Telemetrie bis TimescaleDB nachweisen

Der Prüflauf sendet Simulatornachrichten durch EMQX, Ingest und Redpanda zum Writer. Er vergleicht anschließend die Zeilenzahl des Demo-Geräts in TimescaleDB. Damit prüft er den laufenden Datenpfad.

## Vorbereiten und ausführen

Vom Repository-Stamm, `.env` einmal aus `.env.example` anlegen:

```bash
docker compose up -d timescaledb keycloak api
docker compose --profile edge up -d --build emqx redpanda redpanda-init ingest timescale-writer
docker compose ps
tools/edge-simulator/proof/publish_and_verify.sh
```

Das Skript sendet standardmäßig 20 Nachrichten, wartet auf Verarbeitung und zeigt die neuesten Zeilen. `COUNT`, `HOST`, `PORT` passen den Lauf an. Voraussetzung sind API-Migrationen und die Demo-Identität. Einen bestehenden Datenbestand für ein Schema-Update nicht löschen; [Migrationsregeln](../../../docs/api.md) prüfen.

## Ergebnis einordnen

Mehr Zeilen mit neuen Zeitstempeln zeigen eingegangene Telemetrie. Bei gleichzeitig sendenden Geräten ist die reine Zählung kein eindeutiger Nachweis, dass jede einzelne Testnachricht ankam. Für eine isolierte Prüfung andere Sender derselben Identität anhalten oder eine eigene Testidentität verwenden.

Im lokalen Portal sieht `demo` die Anlage „Demo Site Berlin“ und das Gerät `demo-inverter-01`. Offline-Tests des Simulators prüfen Modell und Payload, ohne den Cloud-Pfad zu starten:

```bash
cd tools/edge-simulator
python3 -m pytest test_edge_sim.py -q
```
