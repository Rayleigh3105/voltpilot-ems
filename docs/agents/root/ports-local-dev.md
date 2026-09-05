# Ports (local dev)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 4).


| Port | Service |
|---|---|
| 5432 | TimescaleDB / Postgres |
| 1883 / 8883 / 8083 | EMQX MQTT / MQTT-TLS / MQTT-WS |
| 18083 | EMQX dashboard |
| 9092 | Redpanda Kafka API (external listener; internal is `redpanda:29092`) |
| 9644 | Redpanda admin |
| 8080 | Redpanda Console |
| 8081 | Keycloak (maps to container 8080) |
| 8090 / 8091 / 8092 | api / ingest / timescale-writer (Spring Boot) |
| 5173 | frontend/portal (Vite dev) |
| 1880 | Node-RED editor (edge) |
| 15020 | SunSpec Modbus TCP simulator (host debug; in-cluster `edge-sim:502`) |

