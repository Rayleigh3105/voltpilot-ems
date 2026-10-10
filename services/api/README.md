# Portal-API

Validiert Keycloak-Tokens und stellt mandantengebundene Anlagen-, Geräte-, Messwert- und Betriebsfunktionen bereit. Plattformverwaltung verwendet getrennte Rollen und Datenbankzugänge.

## Start und Tests

Java 21; Befehle in diesem Verzeichnis:

```bash
./mvnw spring-boot:run
./mvnw test
./mvnw clean package
```

Standardport: `8090`. Health: `/health`; Kubernetes: `/health/liveness` und `/health/readiness`. Testcontainers-Fälle benötigen Docker.

Konfiguration: [`application.yml`](src/main/resources/application.yml), lokale/prod Compose-Dateien. Zugangsdaten nicht aus Entwicklungsbeispielen in Produktion übernehmen.

## Referenzen

[API und Datenbank](../../docs/api.md), [OpenAPI](../../docs/contracts/openapi.yaml); [Betriebsvertrag](../../docs/k8s-readiness.md).

Die ergänzende Cloud-Dokumentation für WAGO-Energiekarten, ihre vorhandenen
Fassungswege und die Pilotgrenze stehen in [WAGO.md](WAGO.md).
