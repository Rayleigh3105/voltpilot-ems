# AGENTS.md — Voltpilot-EMS: der Wegweiser

**Diese Datei wird bei JEDEM Sitzungsstart in den Kontext geladen** (`CLAUDE.md` ist ein
Symlink darauf). Sie ist deshalb ein WEGWEISER, keine Chronik: hier steht nur, was fast
jede Sitzung braucht. Jedes Detail wohnt byte-verbatim in `docs/agents/root/` und ist über
den **Themen-Index** am Ende zu finden. **Nie eine `docs/agents/`-Datei ganz in den Kontext
lesen — greppen** (`grep -n` + `sed -n` auf die Fundstelle).

Produkt-Architektur: [`docs/architecture.md`](docs/architecture.md). Bindende Schnittstellen:
`docs/contracts/`. Portal-Wissen: `frontend/portal/AGENTS.md`; Edge-Wissen: `edge-app/AGENTS.md`
(beide ebenfalls Wegweiser mit eigenem Index).

## Was das ist

Self-hosted multi-tenant EMS (PV / Batterie / Lastmanagement), DACH-Markt, Monorepo.
Datenpfad `Edge → EMQX → Ingest → Redpanda → Writer → TimescaleDB`, darüber die
Spring-Boot-`api` (OIDC + Postgres-RLS) und das React-Portal. Der Optimierer plant alle
15 min einen 48-h-Fahrplan (MILP, Pyomo+HiGHS) und veröffentlicht ihn retained per MQTT an
die Box, die ihn unter ihren eigenen Wächtern ausführt. Status je Dienst: dessen README.

## Stack & Versionen

| Concern | Choice | Version |
|---|---|---|
| JVM-Dienste | Java + Spring Boot (Maven, Wrapper committet) | Java 21, Boot 3.3.5 |
| Python-Dienste | setuptools + pyproject, pytest | Python >= 3.10 |
| Solver | Pyomo + HiGHS (`highspy`) | pyomo >= 6.7 |
| Frontend | React + Vite + TypeScript | React 18, Vite 5 |
| Edge | Go (Core) + Node-RED (Layer 1) | Go 1.24, node-red 4.0 |
| Zeitreihen + Stammdaten | TimescaleDB (EINE Postgres-Instanz) | timescale/timescaledb 2.17.2-pg16 |
| MQTT-Broker | EMQX | 5.8.3 |
| Event-Log | Redpanda (Kafka-API) | v24.2.7 |
| Auth (OIDC) | Keycloak | 26.0.5 |

## Service-Map

| Pfad | Sprache | Verantwortung |
|---|---|---|
| `services/api` | Spring Boot | Portal-Backend: REST/WS, Mandanten, Geschäftslogik, Flyway-Eigentümer des Kernschemas |
| `services/ingest` | Spring Boot | MQTT (EMQX) konsumieren, validieren, nach Redpanda |
| `services/timescale-writer` | Spring Boot | Redpanda → TimescaleDB |
| `services/optimization` | Python | Batterie-Dispatch-MILP + Ersparnis-Simulation + what-if/replan-Dienst |
| `services/forecast` | Python | Last-/PV-Prognose, Schattenbetrieb-Modellregister, Wetter-Sammler |
| `services/market-data` | Python | Day-Ahead-Preise (energy-charts keyless / ENTSO-E), Monatsmarktwert |
| `services/marketing-adapter` | Python | Direktvermarktung (Skelett) |
| `edge/*` | Node-RED | dünne Dev-Edge + SunSpec-Simulator (NICHT die Kunden-Box) |
| `edge-app/core` | Go | Kunden-Box: Enrollment, mTLS-Link, Puffer, Plan-Ausführung, Wächter, `:8484` |
| `edge-app/nodered` | Node-RED | Layer 1: I/O-Flows, Treiber, Palette `vp-*` |
| `frontend/portal` | React/Vite | Web-Portal |
| `catalog/measurement-points` | Python | versionierter Messpunkt-Katalog (deterministisch) |
| `tools/*` | Shell/Python | PKI, Edge-Simulator, Deploy-/OTA-Werkzeuge |

## Ports (lokal)

5432 TimescaleDB · 1883/8883/8083 EMQX · 18083 EMQX-Dashboard · 9092/9644 Redpanda ·
8080 Redpanda-Console · 8081 Keycloak · 8090/8091/8092 api/ingest/writer · 5173 Portal ·
1880 Node-RED · 8484 Box-Weboberfläche · 15020 SunSpec-Simulator.

## Den lokalen Stack fahren

```bash
cp .env.example .env
docker compose up -d                      # Backbone + api
(cd frontend/portal && npm install && npm run dev)          # http://localhost:5173
docker compose --profile edge up -d --build                 # ganze Live-Strecke
docker compose --profile feeds --profile optimize up -d --build   # Preise/Wetter + Optimierer
docker compose down                                          # -v wischt die Volumes
```

⚠ Die `infra/local/timescale/*.sql` laufen NUR auf einem FRISCHEN Volume — nach gemergten
Inkrementen `down -v`, sonst fehlen neue Tabellen still. Port-Kollisionen löst die
git-ignorierte `.env` (`API_PORT` + passendes `VITE_API_BASE`), nie die Compose.
Dev-Logins: `admin`/`admin` (platform-admin), `demo`/`demo` (Mandant A), `demo2`/`demo2` (B).

## Bauen & testen

```bash
(cd services/api && ./mvnw test)             # ~1600 Tests, ~55 min mit Docker (Testcontainers)
(cd services/ingest && ./mvnw test)
(cd services/timescale-writer && ./mvnw test)
(cd services/optimization && pip install -e '.[dev,solver]' -e ../forecast && pytest)
(cd services/forecast && pip install -e '.[dev,ml]' && pytest)
(cd services/market-data && pip install -e '.[dev]' && pytest)
(cd frontend/portal && npm run build && npm test)   # build = tsc + vite; test = vitest run
(cd edge-app/core && go test ./...)
(cd edge-app/nodered && npm test)            # NICHT `node --test` an der Wurzel
bash tools/agents-md-budget.sh               # Größen-Wächter dieser drei Wegweiser
```

⚠ **Im selben Maven-Modul läuft IMMER nur EIN Prozess** — zwei parallele Läufe löschen sich
`target/` gegenseitig, und der Schaden sieht aus wie ein echter Testfehler
(`FileNotFoundException` auf eine `.class`, deren QUELLE existiert). Nach jedem Umbenennen
oder Löschen einer Migration `./mvnw clean test`, nie nur `test`.
Maven zieht von **Maven Central**; hinter einem Firmen-Mirror `-s .mvn-central-settings.xml`.

## Die harten Hausregeln

- **Ehrlichkeit der Zahlen.** `null` statt einer erfundenen `0`; „nicht gemessen" ist nie
  „gemessen 0"; Schweigen ist nie ein bewiesener Fehlschlag. Ein Wort außerhalb eines
  geschlossenen Vokabulars wird beim Ingest VERWORFEN, nie geraten oder auf einen Vorgabewert
  aufgelöst. Eine Fläche, die eine URSACHE behauptet, braucht einen exportierten Fakt, der
  genau diese Ursache trägt — sonst sagt sie nur die BEOBACHTUNG.
- **RLS ist der Mandanten-Zaun, nicht die Query.** Repositories tragen KEIN `tenant_id`-Prädikat;
  eine fremde Anlage ist **404, nie 403**. Die api verbindet als `voltpilot_app`
  (NOBYPASSRLS); die BYPASSRLS-Rolle `voltpilot_admin` lebt ausschließlich hinter
  `/api/v1/admin/**`. Jede neue mandantengebundene Tabelle braucht Policy + `FORCE ROW LEVEL
  SECURITY` + Grants in ihrer Migration.
- **Eine angewandte Flyway-Migration ist UNVERÄNDERLICH** — nicht editieren (Prüfsumme), nicht
  umnummerieren (Versionsordnung = Autorenzeit, Ankunft = Merge-Reihenfolge; `out-of-order:
  true` ist deshalb gesetzt). Neue Migrationen sind datums-versioniert und müssen NACH dem
  höchsten ausgelieferten Stand sortieren. Ein `BIGSERIAL` braucht sein EIGENES
  `GRANT USAGE ON SEQUENCE`. Ein CHECK wird geweitet, indem man den AKTUELLEN Stand
  abschreibt — nie den der Ur-Migration.
- **Ein `@Scheduled`-Job ist im Testlauf AUS** (surefire-Systemeigenschaft) und in Produktion AN
  (`application.yml`); beides gehört zusammen geprüft. Spring cacht Testkontexte, Testcontainers
  stoppt seine Container — ein weiterlaufender Takt vergiftet FOLGENDE Testklassen.
- **Ein Flag hat die Vorgabe AN.** Ein per Vorgabe ausgeschaltetes Flag muss im gitops-Repo
  nachgezogen werden und läuft sonst in prod nachweislich nie (die dokumentierte
  OTA-Listener-Falle).
- **Zwillinge ändert man zusammen mit ihrer Vektor-Datei.** Dieselbe Regel lebt oft in Go, Java
  und TypeScript; die geteilten Vektoren in `docs/contracts/v2/*-vectors.json` sind der Beweis,
  dass sie nicht auseinanderlaufen.
- **Verträge sind additiv.** `schema_version` bleibt; ein abwesendes Feld heißt „der Zustand von
  vorher", nie ein geratener Wert; eine ältere Box überliest ein neues Feld. Eine signierte
  Datei wird nie umformatiert und nie in eine `jsonb`-Spalte gelegt.
- **Eine Edge-Änderung wirkt erst mit dem nächsten Edge-Release** (eine laufende Box behält ihr
  Image); `edge-app/core/internal/web/static/*` ist `//go:embed`-t, also Binär neu bauen.
- **Nie Geheimnisse committen.** `.env`/`.env.prod` sind lokal, `tools/pki/out/` ist
  git-ignoriert, die kalte OTA-Wurzel liegt offline beim Owner.

## Lieferweg

Forgejo (`git.tecmaxx.de`), nicht GitHub: CI in `.forgejo/workflows/` (`deploy.yaml` mit
Test-Gate, `deploy-fast.yaml` OHNE), Images nach `git.tecmaxx.de/mamotec/voltpilot-ems/*`,
Deploy = ein Commit ins gitops-Repo (`gitops-tag-bump`), Argo CD synct.
⚠ **`deploy-fast.yaml` hat kein Test-Gate**, also gilt ein neu eingehängter Gate-Schritt als
UNGEPRÜFT, bis `deploy.yaml` einmal von Hand lief. Zwei Runner-Fallen: ein veröffentlichter
Port und ein Bind-Mount aus dem Workspace gehören dem DOCKER-HOST, nicht dem Job; der Runner
läuft als ROOT (ein Fehlschlag darf nie über Dateirechte erzwungen werden). Wie man einen
roten Lauf untersucht: `docs/agents/root/production-deployment-single-vm-vps-depl.md`
(Abschnitt „Einen ROTEN CI-Lauf untersuchen").
