# Arbeitsregeln für VoltPilot EMS

Mandantenfähiges EMS für PV, Speicher und Verbraucher. Einstieg: [Dokumentation](docs/README.md), [Architektur](docs/architecture.md), [Entwicklung](docs/development.md).

## Orientierung

| Bereich | Aufgabe / lokale Regeln |
|---|---|
| `services/api` | Spring Boot, Portal-API, RLS, Flyway; [API-Regeln](docs/api.md) |
| `services/ingest`, `services/timescale-writer` | MQTT → Redpanda → TimescaleDB |
| `services/forecast`, `services/market-data` | Prognosen und externe Daten |
| `services/optimization` | Planung; [README](services/optimization/README.md) |
| `edge-app` | Kunden-Box; [lokale Regeln](edge-app/AGENTS.md) |
| `frontend/portal` | React-Portal; [lokale Regeln](frontend/portal/AGENTS.md) |
| `catalog/measurement-points` | Geprüfte Herstellerquellen und generierte Messpunkte |
| `edge/` | Lokaler Node-RED-/SunSpec-Testpfad |

## Arbeiten und prüfen

- Vorhandene Änderungen erhalten. Versions- und Defaultwerte aus Manifesten/Konfiguration lesen.
- JVM: Java 21, Maven-Wrapper je Service. Python: jeweiliges `pyproject.toml`; Optimierung benötigt Solver und Forecast-Paket. Portal: `npm run typecheck`, passende Tests, `npm run build`. Details: [Entwicklung](docs/development.md).
- Testcontainers benötigt Docker. Übersprungene Integrationstests ausdrücklich benennen.
- Ein Umzug von Java-Klassen oder Migrationen kann alte Dateien in `target/classes` hinterlassen; bei solchen Änderungen `./mvnw clean test` verwenden.
- Produktionsdeployments laufen über Forgejo/GitOps. Keine gestoppten VM-Dienste neben Cluster-Instanzen starten; insbesondere keinen zweiten Optimierer. [Deployment](docs/deploy.md).

## Datenbank und Mandanten

- Angewandte Flyway-Migrationen niemals ändern oder umnummerieren, auch keine Kommentare. Neue Änderungen brauchen neue, eindeutige Versionen.
- `out-of-order: true` unterstützt unterschiedliche Merge-Reihenfolgen. Neue Migrationen müssen sowohl in Versionsreihenfolge auf frischer DB als auch nach späterer Ankunft funktionieren.
- Dev-Seeds mit Fremdschlüsseln auf Demomandanten müssen bei fehlendem Mandanten ohne Änderung enden. Prüfungen: `DevSeedGuardTest`, `MigrationHygieneTest`.
- Schema-Änderungen gehören zur API/Flyway. Bootstrap-/Service-Migrationsspiegel und Versionsreservierungen vor Änderungen prüfen.
- Laufzeitrolle der API: `voltpilot_app`, kein Superuser. Neue mandanteneigene Tabellen benötigen Rechte, RLS und `FORCE ROW LEVEL SECURITY`.
- Mandant aus JWT/TenantContext, niemals aus einem Kunden-Requestbody übernehmen. Cross-Tenant-Verwaltung verwendet getrennte, admin-geschützte Repositories.
- Flyway-Selbstheilung ersetzt keine Migrationsdisziplin: Checksum-Reparatur führt keine SQL-Änderung aus und kann keine fehlende Migration anwenden. Details: [API](docs/api.md).

## Verträge und Identitäten

- MQTT-/Ereignisverträge stehen unter [docs/contracts](docs/contracts/README.md). Schema-Versionen sind pro Vertrag; additive Änderungen und v1/v2-Koexistenz erhalten.
- Topic- und Payload-Identität müssen übereinstimmen. v1/v2-Topics und retained Nachrichten dürfen sich nicht überschreiben.
- Geräte-Claim ist innerhalb des Mandanten idempotent; externe Referenzen bleiben global eindeutig. Sticker- und generierte Edge-Referenzen haben unterschiedliche Prüfungen.
- Prüfziffernalgorithmus und Vektoren in Go/Java sowie Referenz-Normalisierung in API/Portal synchron halten. Keine neue Gerätekennung bei Umbenennung oder Wiederanbindung erzeugen.
- Auswahl eines physischen Geräts, Transportverbindung und Registerziel sind getrennte Identitäten. Ein Port, eine Adresse oder derselbe Transport beweist keine Gerätegleichheit.
- Quellkennungen sind stabil; Aliasänderungen dürfen keine neue Quelle oder Messhistorie erzeugen. Messpunkte werden über ihre zugeordnete Komponente gelesen.

## Energie und Ausführung

- Cloud plant; der Go-Core entscheidet über lokale Ausführung und Schutzgrenzen. Normale Entitätsflows äußern Wünsche; generische Modbus-Knoten haben die gesonderte Governance-Grenze im [Graphvertrag](docs/contracts/v2/flow-graph.md#katalogausnahmen).
- Plan, angenommener Auftrag, Registerantwort und gemessene Wirkung getrennt halten. Unbekannt ist keine Null; veraltete Telemetrie ist nicht aktuell.
- Vorzeichen und Einheiten an bestehenden Verträgen prüfen: kW ≠ kWh; Batterie laden/entladen und Netzbezug/Einspeisung nicht vertauschen.
- Physische Schreibfreigaben sind modell-/gerätebezogen. Simulatornachweise ersetzen keinen Hardware-Prüfstand. [Edge-Laufzeitregeln](docs/edge-runtime.md).
- Optimierung und Erlösanzeige müssen dieselben Tarif-/Vergütungsgrundlagen verwenden. Prognosebewertung misst gespeicherte Prognosen; Planzeitkorrekturen sind davon getrennt.
- Fachregeln stehen in [Verbrauchersteuerung](docs/verbrauchssteuerung.md), [Prognosen](docs/forecasting.md), [Optimierung](services/optimization/README.md).

## Maintaining this file

Nur Regeln behalten, die künftige Arbeit beeinflussen. Bestehende Einträge überarbeiten statt neue Vorfallchroniken anzuhängen. Fachwissen knapp am zuständigen Thema dokumentieren und hier verlinken. `CLAUDE.md` bleibt ein Symlink auf diese Datei.

## Weiterführende Arbeitsregeln

- Der ergänzende [Themenindex](docs/agents/README.md) enthält die auf `main` ausgelagerten Detailregeln. Dort gezielt mit `rg` nachschlagen; keine Vorfallchronik hierher kopieren.
- Pro Maven-Modul nur einen Build gleichzeitig ausführen. `@Scheduled`-Jobs im Testlauf abschalten; Produktionsvorgaben getrennt prüfen.
- Neue Migrationen nach dem höchsten ausgelieferten Stand versionieren. Sequenzen benötigen eigene Grants; CHECK-Erweiterungen auf dem aktuellen Schema aufbauen.
- Geschlossene Vokabulare und Regeln in mehreren Sprachen gemeinsam mit ihren Vertragsvektoren ändern. Signierte Dateien nicht umformatieren oder als `jsonb` speichern.
- Neue Feature-Flags und ihre tatsächliche Produktionskonfiguration gemeinsam prüfen. `deploy-fast.yaml` hat kein Test-Gate.
- UEMS-Begriffe und Umsetzungsbelege stehen im [Fachmodell](docs/fachmodell/README.md); Verträge, Vektoren und tatsächliche Aufrufer zusammen prüfen. Tagesgenaue Zuordnungen schließen den letzten Tag ein; minutengenaue Intervalle sind halboffen.
- Größenbudgets erhalten: Root höchstens 60 KB, Portal/Edge je 45 KB. Prüfen mit `bash tools/agents-md-budget.sh`; Budgets nicht erhöhen.

## Themen-Index (der ausgelagerte Bestand)

Der [gemeinsame Themenindex](docs/agents/README.md) erschließt die Detailregeln unter `docs/agents/`. Neue dauerhafte Details am zuständigen Thema ergänzen und dort verlinken; dieser Wegweiser bleibt kurz.
