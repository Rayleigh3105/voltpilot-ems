# Stack & versions

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 2).


| Concern | Choice | Version |
|---|---|---|
| JVM services | Java + Spring Boot (Maven, wrapper committed) | Java 21, Spring Boot 3.3.5 |
| Python services | setuptools + pyproject, pytest | Python >= 3.10 |
| Optimization solver | Pyomo + HiGHS (`highspy`) | pyomo >= 6.7 |
| Frontend | React + Vite + TypeScript | React 18, Vite 5 |
| Edge | Node-RED (container) | node-red 4.0 |
| Timeseries + master data | TimescaleDB (one Postgres instance) | timescale/timescaledb 2.17.2-pg16 |
| MQTT broker | EMQX | 5.8.3 |
| Event log | Redpanda (Kafka API) | v24.2.7 |
| Auth (OIDC) | Keycloak | 26.0.5 |

