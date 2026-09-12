# Timescale-Writer

Konsumiert Telemetrie-/Messwertereignisse aus Redpanda und schreibt sie mandantengebunden in TimescaleDB. Bestätigung erfolgt nach Verarbeitung; Wiederholungen dürfen keine doppelten Messwerte erzeugen. Die API/Flyway besitzt das Schema.

## Start und Tests

Java 21; Befehle in diesem Verzeichnis:

```bash
./mvnw spring-boot:run
./mvnw test
./mvnw clean package
```

Standardport: `8092`. Health: `/health`; Kubernetes: `/health/liveness` und `/health/readiness`. Testcontainers-Fälle benötigen Docker.

Konfiguration: [`application.yml`](src/main/resources/application.yml), lokale/prod Compose-Dateien. Zugangsdaten nicht aus Entwicklungsbeispielen in Produktion übernehmen.

## Referenzen

[Verträge](../../docs/contracts/README.md), [Datenbankregeln](../../docs/api.md); [Betriebsvertrag](../../docs/k8s-readiness.md).
