# Kubernetes-Betriebsvertrag

Referenz für Probes, Shutdown, Speicherpfade und Skalierungsgrenzen der Cloud-Dienste. Der Releaseweg ist [GitOps/Argo CD](deploy.md); tatsächliche Cluster-Manifeste liegen im separaten GitOps-Repository.

## Probes und Replikation

| Dienst | Liveness | Readiness | Grace-Period | Replicas |
|---|---|---|---|---|
| `api` | `GET :8090/health/liveness` | `GET :8090/health/readiness` | 45 s | **1 (Singleton)** – siehe Blocker |
| `frontend` | `GET :80/healthz` | `GET :80/healthz` | 30 s | ja |
| `ingest` | `GET :8091/health/liveness` | `GET :8091/health/readiness` | 45 s | **1** (doppelter MQTT-Konsum) |
| `timescale-writer` | `GET :8092/health/liveness` | `GET :8092/health/readiness` | 45 s | ja (Consumer-Group) |
| `market-data` | `GET :8094/health` | `GET :8094/ready` | 30 s | 1 (Singleton) |
| `optimization` | `GET :8096/health` | `GET :8096/ready` | 60 s | 1 (Singleton, sequenziell) |
| `forecast` (Collector) | `GET :8097/health` | `GET :8097/ready` | 60 s | 1 (Singleton) |
| `weather-collector` | `GET :8098/health` | `GET :8098/ready` | 30 s | 1 (Singleton) |
| `simulation` | `GET :8095/health` | `GET :8095/health` | 30 s | **1** (In-Memory-Job-Registry) |
| `flowc` | `GET :8099/health` | `GET :8099/health` | 15 s | ja (zustandslos) |

Grace-Period-Werte sind die vorgesehenen Manifestwerte; im ausgerollten Manifest prüfen. Eine API-Aufteilung in mehrere eigenständige Instanzen ist hier keine bereits implementierte Skalierungszusage.

```mermaid
flowchart LR
    Start["Start: Abhängigkeiten können fehlen"] --> Startup["Startup-Probe mit Zeitbudget"]
    Startup --> Ready["Readiness: Verkehr zulassen"]
    Ready --> Run["Betrieb"]
    Run --> Drain["Abmelden und SIGTERM"]
    Drain --> Finish["Laufende Arbeit begrenzt beenden"]
```

## JVM-Dienste

- `/health` ist das Aggregat einschließlich möglicher externer Abhängigkeiten. Es ist kein geeigneter pauschaler Liveness-Neustartauslöser.
- `/health/liveness` und `/health/readiness` sind die expliziten Actuator-Probes. Readiness ist keine Zusage, dass jede externe Datenquelle gesund ist.
- `server.shutdown=graceful`; `SHUTDOWN_TIMEOUT` standardmäßig 20 s. Pod-Grace-Period muss Abmeldezeit, Shutdown und Reserve abdecken.
- API-Start benötigt Zeit für Flyway und ACL-Reconcile; ein `startupProbe`-Budget von drei Minuten ist die dokumentierte Ausgangskonfiguration.
- `DB_POOL_MAX_SIZE` gilt pro Instanz. Gesamtbudget gegenüber Postgres-Verbindungslimit planen.

API braucht beschreibbare CA- und ACL-Verzeichnisse. `acl.conf` als **Verzeichnis** mounten, damit atomarer Rename funktioniert. Ingest/Writer benötigen neben temporären Dateien keine eigene dauerhafte Datenablage.

## Singleton-Grenzen

| Dienst | Grund |
|---|---|
| API | Gemeinsame CA-/ACL-Dateien, In-Memory-Jobzustände und Rate-Limiter, pro Instanz konsumierende MQTT-Listener |
| Ingest | Normale MQTT-Abonnements vervielfachen Konsum; keine automatische Shared-Subscription-Skalierung |
| Collector / Optimierung | Periodische Aufgaben sind nicht als verteilte Arbeitswarteschlange gebaut |
| Simulation | In-Memory-Job-Registry; Neustart verliert laufende Jobs |

Writer kann über seine Kafka-Consumer-Group verteilt werden. Frontend und Flow-Compiler sind grundsätzlich zustandslos. Zusätzliche API-Instanzen verlangen zuvor eine Lösung für die genannten Zustände; Session-Affinity allein löst sie nicht vollständig.

## Python und Node

Die periodischen Python-Dienste besitzen Signalhandler, unterbrechbare Wartezeiten und Backoff. `/health` beschreibt den lebenden Prozess auch nach fehlgeschlagenen Zyklen; `/ready` zeigt die gestartete Schleife und verweigert beim Beenden. Immer zusätzlich Datenalter und letzte erfolgreiche Arbeit prüfen.

DSN-Verbindungen verwenden `POSTGRES_CONNECT_TIMEOUT` (Vorgabe 10 s). Der Optimierer beendet beim Shutdown die laufende Anlagenarbeit begrenzt; keine lange blockierende Sleep-Schleife einführen. `PYTHONUNBUFFERED=1` hält Logs sichtbar. Die drei `runtime.py`-Implementierungen werden durch einen Drift-Test abgeglichen.

`flowc` und Frontend haben eigene Health-Pfade gemäß Tabelle. Config-/Quellcode sind die Referenz für optionale Port-Overrides.

## Metriken

API: `GET /metrics`, intern ohne Token. Frontend-nginx veröffentlicht diesen internen Endpunkt nicht als API-Route. Keine Kundennamen/Adressen als Labels hinzufügen.

| Metrik | Labels | Bedeutung |
|---|---|---|
| `voltpilot_site_last_plan_age_seconds` | `site`, `tenant` | Alter des jüngsten Optimierer-Laufs. **Fehlt, wenn unbekannt.** |
| `voltpilot_site_plan_state` | `site`, `tenant`, `state` | 1 für den aktiven Zustand: `known` \| `older_than_window` \| `never` |
| `voltpilot_site_last_telemetry_age_seconds` | `site`, `tenant` | Alter der jüngsten Mess-ANKUNFT (`received_at`). **Fehlt, wenn nie gemessen.** |
| `voltpilot_site_telemetry_state` | `site`, `tenant`, `state` | 1 für den aktiven Zustand: `known` \| `never` |
| `voltpilot_priced_slots_ahead` | `zone` | Lückenlos bepreiste Viertelstunden ab jetzt (Deckel 96). Der Optimierer braucht 16. |
| `voltpilot_sites` | – | Anzahl Anlagen (Nenner für Quoten) |
| `voltpilot_site_plan_lookback_seconds` | – | Das Nachschaufenster (604800), damit eine Regel es nicht hart kodiert |
| `voltpilot_metrics_collect_age_seconds` | – | Sekunden seit dem letzten ERFOLGREICHEN Sammel-Lauf |
| `voltpilot_metrics_collect_duration_seconds` | – | Dauer des letzten Sammel-Laufs |

Unbekanntes Alter ist keine Null; dafür existieren Zustandsmetriken. Ein `never` bei einer neuen Anlage ist anders zu behandeln als `older_than_window` nach früheren Plänen. Aggregation über Instanzen verhindert doppelte Alarme.

```promql
max by (site, tenant) (voltpilot_site_last_plan_age_seconds) > 3600
  or max by (site, tenant) (voltpilot_site_plan_state{state="older_than_window"}) == 1
min by (zone) (voltpilot_priced_slots_ahead) < 16
max(voltpilot_metrics_collect_age_seconds) > 300
```

Diese Ausdrücke sind Ausgangspunkte der vorhandenen Betriebslogik; Alert-Dauer und Empfänger gehören in die tatsächliche Monitoringkonfiguration. Verbraucher-Metriken stehen im [Verbraucherhandbuch](verbrauchssteuerung-betrieb.md).

## Migrationen und Rollouts

Expand-Contract: Während eines Rollouts kann alter Code bereits das neue Schema sehen. Neue Felder zunächst kompatibel ergänzen, Leser/Schreiber umstellen und erst später entfernen. Flyway-Dateien nicht nachträglich ändern oder umnummerieren.

Ein Rollback des Images setzt keine Datenbankmigration zurück. Kein zweiter Compose-Optimierer neben dem Cluster. Nach Rollout MQTT-Verbindungen, Auth, Datenfrische und Preisabdeckung prüfen.

Belege: `K8sReadinessConfigTest` in den JVM-Diensten, Python-`test_runtime.py`, `MetricsEndpointSecurityTest`, `FleetMetricsScrapeTest` und Deployment-Selbstchecks.

## Zusätzliche Readiness und Datenhaltungsmetriken

Ingest verwendet `readinessState,eventsTopic`: `events.raw` muss einmal erfolgreich erkannt sein. Bis dahin bleiben Messwerte mit Ereignis-Fallback möglich, der Box-Ereignisadapter wartet. Ein späterer Broker-Ausfall entfernt die einmal erkannte Bereitschaft nicht. Details: [Ingest](../services/ingest/README.md).

API und Writer liefern interne `/metrics`-Endpunkte auf 8090 bzw. 8092. Die API ergänzt Datenhaltungsmetriken über `DbHealthMetricsCollector` (alle 60 s, `VOLTPILOT_METRICS_DB_ENABLED`, Vorgabe true). Der Writer ermittelt Gruppenrückstand über Kafka-AdminClient (`VOLTPILOT_METRICS_KAFKA_LAG_ENABLED`, Vorgabe true).

| Metrikfamilie | Bedeutung |
|---|---|
| `voltpilot_db_total_bytes{table}` | Größe je Hypertable |
| `voltpilot_db_job_last_run_failed`, `voltpilot_db_job_total_failures` | Status/Fehlerzahl der Timescale-Jobs; `policy_telemetry` wird ausgeblendet |
| `voltpilot_optimizer_cycle_seconds`, `…_sites_planned`, `…_sites_skipped`, `…_age_seconds` | Persistierter Optimierer-Zyklus; ohne Lauf `NaN` |
| `voltpilot_db_metrics_collect_age_seconds`, `…_duration_seconds` | Gesundheit des DB-Sammlers |
| `voltpilot_kafka_consumer_lag{group,topic}` | Committeter Offset bis Log-Ende; unbekannte Gruppe ohne Zeile |
| `voltpilot_kafka_consumer_lag_collect_age_seconds` | Alter der letzten Lag-Abfrage |

Ein nie gelaufener Job hat keinen erfundenen Erfolgsstatus. Altersmetriken wachsen bei ausgefallenem Sammler weiter. Für Betriebsalarme Größen summieren, Zyklus-/Lag-Alter überwachen und Label-Duplikate über Instanzen aggregieren. Nachweise: `DbHealthMetricsScrapeTest`, `DbHealthMetricsDbTest`, `KafkaConsumerLagScrapeTest`, `KafkaLagProbeTest`.
