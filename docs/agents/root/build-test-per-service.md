# Build & test per service

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 43).


```bash
# JVM (Maven wrapper committed; distributionUrl points at Maven Central)
(cd services/api && ./mvnw test)
(cd services/ingest && ./mvnw test)
(cd services/timescale-writer && ./mvnw test)

# Python
(cd services/optimization && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev,solver]' -e ../forecast && pytest)  # 'solver' pulls the HiGHS wheel (behavioral MILP tests skip without it); ../forecast is the sibling path dep for the persistence fallback
(cd services/forecast && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)
(cd services/marketing-adapter && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)
(cd services/market-data && python3 -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]' && pytest)  # add ',db' for the psycopg TimescaleDB writer; tests run fixture-only, no live ENTSO-E

# Frontend (also runs tsc type-check)
(cd frontend/portal && npm install && npm run build)

# Edge simulator (SunSpec Modbus TCP source; sanity syntax check)
(cd edge/sim && npm install && node -e "require('./sunspec-sim.js')" & sleep 2; kill %1)

# Edge-App (customer-side edge; see its AGENTS.md section)
(cd edge-app/core && go test ./...)                          # Go 1.24+; incl. in-process mTLS integration test
(cd edge-app/nodered/vp-palette && npm install && npm test)  # vp-palette node tests
edge-app/test/e2e-compose.sh                                 # isolated compose e2e (Docker; own project/ports)
edge-app/test/e2e-ocpp.sh                                    # OCPP-Lastmanagement-/Daten-/Command-Rig (L1-L12; Docker-FREI, nur Go + curl)
```

Health endpoints on the JVM services are mapped to root: `GET /health` (Spring Boot Actuator).

**⚠ Writer: jede `@SpringBootTest`-Klasse mit eigenen Containern stoppt in `@AfterAll` ihre Zuhörer** (`KafkaListenerEndpointRegistry.stop()`, Vorbild `WriterPipeTest`). Spring cacht den Testkontext, Testcontainers stoppt die Container nach der Klasse - die `@KafkaListener` des alten Kontexts (Gruppe `timescale-writer`) verbinden sich danach mit dem Broker der NÄCHSTEN Klasse, gewinnen dort die Partition (kleinere Member-Id) und schreiben in ihre gestoppte Datenbank; die Folgeklasse wartet vergeblich (`WriterPipeTest` nach `EventsRawConsumerTest`: 4 bis 17 Fehlschläge nach je 45 s). Dieselbe Falle wie der `@Scheduled`-Job in [Kubernetes-Readiness](kubernetes-readiness-der-betriebsvertrag.md).

Dependency resolution uses **Maven Central** (matching the committed wrapper `distributionUrl`). On a clean machine `./mvnw test` just works. If your `~/.m2/settings.xml` pins a corporate mirror (`<mirrorOf>*</mirrorOf>`) that a sandbox/CI can't reach, build with a Central-only settings override: `./mvnw -s .mvn-central-settings.xml test` (that helper file is git-ignored, create it locally with a single `central-direct` mirror at `https://repo.maven.apache.org/maven2`).

The edge flows are exercised end-to-end against the simulator (not a unit test): bring up `emqx` + the `edge` profile, subscribe to `.../telemetry`, publish a retained `.../schedule`, and watch `edge-sim` log the slot setpoint writes. See `edge/node-red/README.md`. Telemetry conformance to `docs/contracts/mqtt-telemetry.schema.json` was validated with ajv (2020-12).

