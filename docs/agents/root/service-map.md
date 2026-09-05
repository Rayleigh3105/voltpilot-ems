# Service map

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 3).


| Path | Lang | Responsibility (architecture section 8) | State |
|---|---|---|---|
| `services/api` | Spring Boot | Portal backend / API: REST/WS, tenancy, business logic | stateless |
| `services/ingest` | Spring Boot | Consume MQTT (EMQX), validate, publish to Redpanda | stateless |
| `services/timescale-writer` | Spring Boot | Redpanda -> TimescaleDB writer | stateless |
| `services/optimization` | Python | Battery-dispatch MILP (HiGHS): 24h/15-min cost-optimal schedule -> `schedule` hypertable + retained MQTT | stateless (job) |
| `services/forecast` | Python | Load/PV forecast: shadow-mode model registry (baselines active, XGBoost challengers shadow) + daily evaluation | stateless (job) |
| `services/marketing-adapter` | Python | Generic Direktvermarktung adapter (stub) | stateless |
| `services/market-data` | Python | ENTSO-E day-ahead price adapter (anti-corruption layer) -> `day_ahead_prices` | stateless (job) |
| `edge/node-red` | Node-RED | Thin edge: acquisition, publish, schedule-exec, watchdog, guards (runnable via the SunSpec sim) | edge |
| `edge/sim` | Node.js | Simulated SunSpec Modbus TCP inverter/battery (dev only, no hardware) | dev tool |
| `edge-app/core` | Go | Customer-side edge core agent: enrollment, mTLS cloud link, buffering, schedule exec + guards, local bus + web app | edge (stateful data dir) |
| `edge-app/nodered` | Node-RED | Customer-side I/O flows (vp-palette; wired by VoltPilot per customer) | edge |
| `frontend/portal` | React/Vite | Web portal | - |

