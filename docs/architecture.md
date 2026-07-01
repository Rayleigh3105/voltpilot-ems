# Energiemanagementsystem (EMS) - Voltpilot-EMS

## Technische Projektdokumentation

**Version:** 1.3 · **Datum:** 01.07.2026 · **Autor:** Max · **Status:** Architektur final; TimescaleDB + Redpanda (ab MVP) gesetzt, Node-RED-Edge, §14a präzisiert

> This is the canonical architecture document provided by the captain. The scaffold task derives the repository structure and local dev stack from it. Where the MVP scope narrows the target, follow section 4 (MVP-Schnitt).

---

## 1. Executive Summary

Ein SaaS-Energiemanagementsystem für PV-, Batteriespeicher- und Lastmanagement, das je Kundenanlage den wirtschaftlich optimalen Betrieb ermittelt: Speicher laden bei günstigem Strom bzw. PV-Überschuss, entladen bei teurem Strom - unter Maximierung der Eigenverbrauchsdeckung und perspektivisch Vermarktung der Flexibilität über einen Direktvermarkter.

Das Produkt besteht aus einer Node-RED-basierten Edge beim Kunden auf günstiger Hardware (Ziel <= 200 EUR, Raspberry-Pi-Klasse; spricht per Modbus TCP mit den Wechselrichtern, liest Messwerte, führt den Cloud-Fahrplan slot-weise aus und beobachtet die tatsächlich wirksame Netzbetreiber-Leistungsgrenze) und einer hochskalierbaren Cloud-Plattform (Multi-Tenant-Portal, Optimierung, Prognose, Vermarktung). Die Intelligenz liegt in der Cloud; die Edge bleibt bewusst dünn.

Zielmarkt: DACH. Segmente: B2C-Heimanlagen und C&I-Gewerbe. Betrieb: self-hosted auf EU-Infrastruktur (Hetzner), DSGVO by design. Team: 2-5 Entwickler. MVP-Ziel: 3 Monate.

Leitidee: Vorhersage (Prognose) und Entscheidung (Optimierung) sind getrennt. Die Entscheidung ist ein MILP/MPC-Optimierungsproblem und kommt im ersten Release ohne ML aus. ML (XGBoost) folgt als spätere Stufe für die Lastprognose.

## 2. Leitprinzipien

- Schlank starten, Hyperscale-fähig bleiben.
- EU-Souveränität & DSGVO by design (self-hosted EU, keine US-Provider in der Datenebene).
- Trennung von Vorhersage und Entscheidung.
- Edge-Autonomie (schlank) - Eigenverbrauchs-Default bei Cloud-Ausfall.
- Durables Event-Log ab Tag 1 (Redpanda).
- Zwei Segmente, eine Plattform.

## 3. Kernentscheidungen (Decision Record)

- Zielmarkt: DACH (DE zuerst, AT/CH-fähig), ENTSO-E Gebotszonen DE-LU/AT/CH.
- Segmente: B2C-Heim und C&I.
- Messaging Edge->Cloud: MQTT-Ingress (EMQX) + Redpanda (Kafka-API) als internes Event-Log ab MVP.
- Cloud-Plattform: Self-hosted Kubernetes auf Hetzner (EU).
- MQTT-Broker: EMQX (MQTT 5.0, Clustering, Tenant-ACLs).
- Skalierung: MVP-first, Hyperscale-fähig designt.
- SLA: Best-Effort im MVP.
- Regelkreis: Hybrid (Cloud rechnet Fahrplan, Edge führt slot-weise autonom aus + einfacher Eigenverbrauchs-Default).
- Produktklasse: Nur langsame Produkte im 15-Min-Takt (Day-Ahead-Arbitrage, Eigenverbrauch, Fahrplan-Vermarktung). Kein FCR/aFRR.
- §14a-Durchsetzung: Netzbetreiber setzt §14a über eigene, parallele Steuereinrichtung durch; EMS beobachtet die wirksame Grenze und optimiert im freigegebenen Rahmen.
- Edge-Laufzeit: Node-RED direkt am Edge (bewusst dünn); kompilierter Agent (Go/Rust) optionaler späterer Pfad. Läuft auf Pi-Klasse.
- Entscheidungslogik: MILP-Optimierung im MPC-Stil (15-Min-Takt, 24-48h-Horizont), Solver HiGHS.
- Prognose/ML: Kein eigenes ML in v1; danach XGBoost/LightGBM für Lastprognose.
- Time-Series-DB: TimescaleDB (PostgreSQL-Extension), hinter Repository gekapselt.
- Relationale DB: PostgreSQL (+ TimescaleDB-Extension) + Row-Level-Security; kann dieselbe Instanz sein.
- Inverter-Anbindung: Modbus TCP + SunSpec (generisch). RTU aktuell nicht im Scope.
- Auth/Multi-Tenancy: Keycloak (OIDC) + tenant_id + Postgres-RLS.
- Backend: Spring Boot (Kern) + Python (ML/Optimierung).
- Frontend: React, Responsive Web zuerst (ECharts/uPlot).
- API-Stil: REST (OpenAPI) + WebSocket/SSE.
- Marktdaten: ENTSO-E Transparency (Day-Ahead), hinter Adapter.
- Direktvermarktung: Kernfeature, früh - generischer Adapter zuerst.
- Billing: Nicht im MVP.
- MLOps: Pragmatisch (MLflow + Batch-Training, erst bei ML-Bedarf).
- Edge-Fleet/OTA: Containerisiert (ARM+x86) + Mender (self-hosted), Config via MQTT, x.509.

## 4. Architektur-Zielbild vs. MVP-Schnitt (3 Monate)

Die Architektur trägt beide Segmente, DACH und Direktvermarktung; der MVP-Scope wird bewusst eng geschnitten:

- Segment: MVP ein Segment zuerst (Empfehlung C&I).
- Markt: MVP DE (DE-LU) zuerst.
- Inverter: MVP 1-2 konkrete SunSpec-fähige Geräte (Modbus TCP).
- Messaging: MVP EMQX + Redpanda + Timescale-Writer.
- Datenhaltung: MVP TimescaleDB (eine Postgres-Instanz für Stammdaten + Zeitreihen).
- Optimierung: MVP MILP für Eigenverbrauch + Spotpreis-Arbitrage unter beobachteter §14a-Grenze.
- Direktvermarktung: MVP Mechanik demonstriert, Adapter-Stub; zertifizierte Anbindung Fast-Follow.
- Prognose: MVP simple Baseline + physikalische PV-Prognose.
- Portal: MVP Auth, Geräte-Claiming, Telemetrie- & Fahrplan-Ansicht, Wirtschaftlichkeits-KPIs.
- Billing: keins. SLA: Best-Effort.

## 5. Architekturüberblick (Datenfluss)

Node-RED-Edge liest Inverter (inkl. wirksamer §14a-Grenze) -> MQTT (EMQX) -> Ingest -> Redpanda (Event-Log) -> TimescaleDB -> Prognose -> Optimierung (HiGHS-MILP gegen Day-Ahead-Preise, Last-/PV-Prognose, §14a-Grenze als harte Restriktion, optional Vermarktungssignale) -> 24h-Fahrplan zurück per MQTT -> Edge führt slot-weise autonom aus.

## 6. Edge-Layer (Node-RED, schlank)

Flows: Acquisition (Modbus TCP/SunSpec poll inkl. wirksamer Grenze), Publish (mTLS-MQTT QoS1), Schedule-Exec (retained Fahrplan, 15-Min-Slots), Default-Watchdog (Eigenverbrauchs-Default bei Ausfall), Guards (lokale Plausibilitätsprüfung vor Schreibzugriff). Containerisiert (ARM+x86). OTA via Mender (A/B + Rollback). x.509-Identität je Gerät. Keine eingehenden Ports (nur ausgehende MQTT).

## 7. Messaging & Ingest

- MQTT (EMQX) = Geräte-Eingang (QoS, retained, kleine Payloads, instabile Netze).
- Redpanda (Kafka-API) = internes Event-Log ab MVP (durables Replay, Entkopplung mehrerer Consumer). Ein Binary, kein Zookeeper/JVM.
- MVP-Datenpfad: EMQX -> Ingest-Service -> Redpanda -> TimescaleDB-Writer -> TimescaleDB. Weitere Consumer (Feature-Pipeline, Alerting, Live-View) hängen unabhängig am selben Log.

MQTT-Topics (Edge <-> Cloud):

```
ems/{tenant_id}/{site_id}/{device_id}/telemetry   # Edge -> Cloud, Messwerte (QoS1)
ems/{tenant_id}/{site_id}/{device_id}/status      # Edge -> Cloud, Heartbeat/Health
ems/{tenant_id}/{site_id}/{device_id}/schedule    # Cloud -> Edge, Fahrplan (retained)
ems/{tenant_id}/{site_id}/{device_id}/command     # Cloud -> Edge, Ad-hoc-Befehl
ems/{tenant_id}/{site_id}/{device_id}/config      # Cloud -> Edge, Konfiguration (retained)
```

Ingest mappt Telemetrie auf Redpanda-Topics (z. B. `telemetry.raw`), partitioniert nach tenant_id/site_id.

## 8. Cloud-Plattform

Kubernetes auf Hetzner (k3s/RKE2 oder managed), GitOps (Argo CD/Flux). Zustandslose Services (Ingest, Writer, API, Prognose, Optimierung) horizontal per HPA; zustandsbehaftete Teile (TimescaleDB/Postgres, EMQX, Redpanda, Keycloak) als StatefulSets.

Service-Landschaft:

| Service | Sprache | Aufgabe | Zustand |
|---|---|---|---|
| Ingest-Service | Spring Boot | MQTT konsumieren, validieren, in Redpanda publizieren | zustandslos |
| TimescaleDB-Writer | Spring Boot/JVM | Redpanda -> TimescaleDB schreiben | zustandslos |
| Portal-Backend / API | Spring Boot | REST/WS, Tenancy, Business-Logik | zustandslos |
| Prognose-Service | Python | Last-/PV-Prognose, Features | zustandslos |
| Optimierungs-Engine | Python | MILP/MPC-Fahrplan (HiGHS) | zustandslos (Job) |
| Vermarktungs-Adapter | Python/JVM | generische DV-Schnittstelle | zustandslos |
| Scheduler/Worker | JVM/Python | 15-Min-Takt, Jobs | zustandslos |
| Keycloak | - | Auth/OIDC | zustandsbehaftet |
| TimescaleDB / EMQX / Redpanda | - | Daten / Transport / Event-Log | zustandsbehaftet |

## 9. Backend (Spring Boot)

REST (OpenAPI) + WebSocket/SSE. Multi-Tenancy: tenant_id-Claim aus Keycloak-Token; zentrale Schicht setzt Tenant-Kontext (`SET app.tenant_id`) für RLS. Python-Services lose angebunden (interne REST/gRPC oder Queue-Jobs).

## 10. Datenhaltung (TimescaleDB)

Eine DB-Technologie: TimescaleDB (PostgreSQL-Extension) hält Zeitreihen (Hypertables: Telemetrie, Prognosen, Fahrpläne, KPIs) mit Kompression + Continuous Aggregates. Stammdaten (Tenants, Sites, Devices, Assets, Tariffs, Audit-Log, Modell-Metadaten) als relationale Tabellen in derselben Postgres-Instanz. Zugriff hinter Repository-Interface. RLS greift einheitlich.

Datenmodell (Auszug): TENANT (id, name, segment, plan) -> USER, SITE (id, tenant_id, name, bidding_zone); SITE -> DEVICE, ASSET (type, capacity_kwh, max_charge_kw, max_discharge_kw), TARIFF, SCHEDULE, FORECAST_RUN; DEVICE -> DEVICE_CERT (x.509).

Datenlebenszyklus: Hot (<90 Tage) volle Auflösung; Warm (90 Tage-2 Jahre) Continuous Aggregates + Kompression; Cold Aggregate; Retention Policies pro Hypertable. Redpanda hält zusätzlich das rohe Event-Log begrenzt.

## 11. Optimierungs-Engine (Herzstück)

MILP im MPC-Stil (rollierender Horizont): alle 15 Minuten optimaler Lade-/Entlade-Fahrplan über 24-48h (15-Min-Slots). Nur der erste Slot wird ausgeführt. Solver HiGHS (Pyomo-kompatibel). Zielfunktion: Minimierung Netto-Energiekosten = Bezugskosten - Erlöse (Einspeisung, Direktvermarktung), Eigenverbrauch berücksichtigt. Restriktionen: SoC-Grenzen, max Lade-/Entladeleistung, Wirkungsgrade, optional Zyklen-/Degradationskosten, Netzanschlussgrenzen, beobachtete §14a-Grenze als harte Obergrenze. Eingaben: Last-/PV-Prognose, Day-Ahead-Preise (ENTSO-E), SoC, §14a-Grenze, Tarif, Vermarktungssignale.

## 12. Prognose & ML (gestaffelt, kein ML in v1)

- Strompreis Day-Ahead: gegeben via ENTSO-E, kein Forecast.
- PV: physikalisches Modell (Wetter-Einstrahlung + Anlagenparameter); später ML-Korrektur.
- Last: Baseline (Persistenz/Profil) in v1; später XGBoost/LightGBM (Quantil-Objective für Unsicherheitsbänder).
- MLOps: MLflow + Batch-Training (K8s-Jobs), erst bei ML-Bedarf.

## 13. Externe Integrationen

- ENTSO-E Transparency (Day-Ahead-Preise je Gebotszone), hinter Adapter.
- Direktvermarkter: generischer Adapter zuerst; §9-EEG-Fernsteuerbarkeit.
- Wetterdaten (PV-/Lastprognose), EU-Hosting.
- Anti-Corruption-Layer je Integration; Caching, Retry/Circuit-Breaker.

## 14. Sicherheit, Compliance & Regulatorik

- Keycloak (OIDC), tenant_id + Postgres-RLS. Onboarding = ein Insert. Schema-/DB-pro-Tenant nachrüstbar.
- DSGVO: EU-Hosting (Hetzner DE), Zweckbindung/Datenminimierung, Betroffenenrechte inkl. Zeitreihen- und Redpanda-Log-Retention, TLS in transit + at rest, Audit-Log.
- §14a EnWG (Lesart A): Netzbetreiber setzt Drosselung über eigene parallele Steuereinrichtung durch; EMS nur beobachtend -> keine steuernde Einrichtung, günstige Hardware.
- §9 EEG / Direktvermarktung: Fernsteuerbarkeit + Zertifizierung; mögliche steuernde Rolle in Phase 2.
- Mess- und Eichrecht: abrechnungsrelevante Messung ggf. geeichte Zähler.

## 15. Observability & Betrieb

Prometheus + Grafana (Service-Health, Ingest-Durchsatz, Redpanda-Consumer-Lag, Optimierungs-Laufzeit, Forecast-Error). Logging zentral (Loki/ELK), strukturiert mit tenant_id/site_id. Tracing OpenTelemetry. Alerting (Gerät offline, Ingest-/Consumer-Stau, fehlende externe Daten, fehlgeschlagene Optimierung, Prognose-Drift). Fleet-Health-Dashboard.

## 16. CI/CD & Deployment

Monorepo mit klaren Service-Grenzen. CI: Build/Test/Lint je Service, signierte Container-Images in EU-Registry. CD: GitOps (Argo CD/Flux). Umgebungen dev -> staging -> prod mit Schema-Migrationen (Flyway/Liquibase inkl. Timescale-Hypertable-Setup). Edge-CD: getrennte Pipeline -> Mender-Artefakte (Node-RED-Container), Canary + Rollback.

## 17. Skalierungsstrategie

Stabile Verträge (MQTT-Topics, Redpanda-Schemas, DB-Repository-Interfaces) entkoppeln Skalierungs-Upgrades. MVP: EMQX + Ingest + Redpanda; TimescaleDB gekapselt; synchrone Optimierungs-Jobs; Baseline-Prognose; shared DB + RLS; Node-RED-Edge; Single-Region Best-Effort. Hyperscale-Pfad ohne Architektur-Bruch.

## 19. Tech-Stack-Zusammenfassung

- Edge-Steuerung: Node-RED (Container, ARM+x86), SunSpec/Modbus TCP.
- Edge-Fleet/OTA: Mender (self-hosted), x.509.
- Transport: MQTT - EMQX, mTLS.
- Event-Log: Redpanda (Kafka-API, ab MVP).
- Backend-Kern: Java / Spring Boot, REST (OpenAPI) + WebSocket/SSE.
- ML & Optimierung: Python - HiGHS (Pyomo), XGBoost/LightGBM (später).
- Datenbank: TimescaleDB (PostgreSQL-Extension), RLS, Repository-gekapselt.
- Auth: Keycloak (OIDC).
- Frontend: React (Responsive Web) + ECharts/uPlot.
- Marktdaten: ENTSO-E Transparency (Adapter).
- MLOps: MLflow + Batch-Training (K8s-Jobs).
- Orchestrierung: Kubernetes auf Hetzner (EU), GitOps (Argo CD/Flux).
- Observability: Prometheus, Grafana, Loki/ELK, OpenTelemetry.
- CI/CD: Container-Build + GitOps, Flyway/Liquibase.

## 18. Roadmap

- Phase 1 - MVP-Kern (~3 Monate): ein Segment (C&I), DE. Node-RED-Edge -> EMQX -> Ingest -> Redpanda -> TimescaleDB-Writer -> TimescaleDB. Portal (Keycloak-Auth, Geräte-Claiming, Telemetrie-/Fahrplan-Ansicht, KPIs). Optimierung (HiGHS-MILP). Eigenverbrauchs-Default. OTA via Mender. Vermarktungs-Mechanik via Adapter-Stub.
- Phase 2 - Direktvermarktung live.
- Phase 3 - Prognose & ML.
- Phase 4 - Hyperscale & DACH-Breite.
