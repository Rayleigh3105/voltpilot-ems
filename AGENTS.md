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

## Themen-Index (der ausgelagerte Bestand)

Jede Zeile ist ein frueherer Abschnitt DIESER Datei. Der Text ist unveraendert, er
wohnt nur woanders. **Alle Pfade unten sind relativ zu `docs/agents/root/`.**
**Nicht ganze Dateien in den Kontext lesen - greppen.** Inhaltsverzeichnis aller
Bereiche: `docs/agents/README.md`.

- **What this is** — Self-hosted multi-tenant EMS (PV / … · `what-this-is.md`
- **Stack & versions** — `stack-versions.md`
- **Service map** — `service-map.md`
- **Ports (local dev)** — `ports-local-dev.md`
- **Run the local stack** — cp .env.example .env · `run-the-local-stack.md`
- **Portal API: auth, tenancy & RLS (services/api)** — The user-facing spine · `portal-api-auth-tenancy-rls-services-api.md`
- **Admin API & the Portal-Admin / Portal-User split (services/api + frontend)** — Two distinct kinds of principal … · `admin-api-the-portal-admin-portal-user-s.md`
- **Der EINE Fleet-Endpoint `GET /api/v1/admin/fleet` (Admin-Umbau Stufe 2)** — Eine Zeile je Anlage über ALLE Mandanten … · `der-eine-fleet-endpoint-get-api-v1-admin.md`
- **Edge-Stand: installierter Core + Palette werden endlich gelesen** — Die Edge sendet ihren installierten … · `edge-stand-installierter-core-palette-we.md`
- **OTA Stufe 0 „Sehen": der Edge-Stand wird flottenweit WOHLDEFINIERT** — Sie schafft flottenweite Versions-Beobacht … · `ota-stufe-0-sehen-der-edge-stand-wird-fl.md`
- **OTA Stufe 1 „Vertrauen": jedes künftige Anwenden ist kryptografisch gedeckt** — Sie schafft die Signaturkette, die JEDES … · `ota-stufe-1-vertrauen-jedes-kuenftige-an.md`
- **Edge-Updates: EIN Schritt — Release wählen, Geräte wählen, fertig** — Die Zusammenfassung der OTA-Stufen 2–4 … · `edge-updates-ein-schritt-release-waehlen.md`
- **Trust-Set-Bereitstellung beim Einrichten: das Portal ist der Auslieferpunkt** — oder seine Signatur fehlt." abgelehnt … · `trust-set-bereitstellung-beim-einrichten.md`
- **OTA Release-Automatik: `git tag` → signiert, geprüft, registriert** — Sie revidiert D3 bewusst: der … · `ota-release-automatik-git-tag-signiert-g.md`
- **Eigene Namen für Komponenten (Alias): `measurement_point.label` trägt NUR noch Menschen-Namen** — Der Kunde benennt seine Komponenten … · `eigene-namen-fuer-komponenten-alias-meas.md`
- **Steuerungs-Zertifizierung: das PLATTFORM-Register (einmal pro Modell, nie wieder pro Kunde)** — „der Kunde hat auch einen Deye und da … · `steuerungs-zertifizierung-das-plattform.md`
- **Einheitsmodell Stufe 0a: „Vorlagen werden Daten" (`component_template`)** — Das Fundament des EINEN Anlege-Assistenten … · `einheitsmodell-stufe-0a-vorlagen-werden.md`
- **Katalog-Neustruktur (Anlegen-Rework Stufe 1): Gerätetyp · Marke · Modell — und der WEG gehört dem Modell** — Sie ist eine PRÄSENTATIONS-Neuordnung … · `katalog-neustruktur-anlegen-rework-stufe.md`
- **Probe-Kanal: die Einmal-Anfrage Cloud→Box (Einheitsmodell Stufe 0b)** — Der Unterbau, aus dem später jede … · `probe-kanal-die-einmal-anfrage-cloudbox.md`
- **Regel-Protokoll: der Verlaufsspeicher (Einheitsmodell Stufe 5b)** — „Diese Regel hat heute 3× geschaltet" … · `regel-protokoll-der-verlaufsspeicher-ein.md`
- **Einheitsmodell Stufe 1: EIN Anlege-Weg — das Portal wird die Wahrheit über die Geräte** — Wechselrichter, Erzeuger, Zähler und … · `einheitsmodell-stufe-1-ein-anlege-weg-da.md`
- **Die MODELL-SUCHE: getippt wird der Name vom Typenschild, nicht die Marke** — Geräteseiten Stufe 2 (Scout … · `die-modell-suche-getippt-wird-der-name-v.md`
- **VpPicker: EIN Picker-System, und die Box hat seine Vanilla-Fassung** — „alle Picker … eigene Komponenten · `vppicker-ein-picker-system-und-die-box-h.md`
- **Der AUSWEG aus der Sackgasse: eine Anlage OHNE Ladestand ist anlegbar (nur lesend)** — SUN-30K-SG02HP3-EU-AM3 mit … · `der-ausweg-aus-der-sackgasse-eine-anlage.md`
- **Einheitsmodell Stufe 2: die Bestands-Übernahme — die LAUFENDEN Anlagen kommen ins Portal** — Erst diese Stufe holt Pilsting, Auernheim … · `einheitsmodell-stufe-2-die-bestands-uebe.md`
- **Die RE-PIN-BRÜCKE: eine gerissene Geräte-Bindung heilt sich selbst** — Der Live-Defekt (Anlage Pilsting/Herzogau … · `die-re-pin-bruecke-eine-gerissene-geraet.md`
- **ALIAS-KONTINUITÄT: ein Kundenname überlebt jeden Reparatur- und Anlege-Weg** — „beim neu hinzufügen sind · `alias-kontinuitaet-ein-kundenname-ueberl.md`
- **Einheitsmodell Stufe 3: die SELBSTBAU-TÜR — der Kunde legt sein eigenes Modbus-Gerät an** — vp-komponenten-einheit-h2 §4.1 Tür c … · `einheitsmodell-stufe-3-die-selbstbau-tue.md`
- **Der generische Batterie-Anschluss (P5 Ebene 1): `user-defined-battery` + `vp.mqtt.read`** — BMS-unabhaengig lesen und per Feld-Zuordnung (inkl. Aggregat min/max ueber viele Topics) auf die Standard-Batteriekanaele abbilden · `der-generische-batterie-anschluss-p5-ebe.md`
- **Der SoC-Ableitungs-Baustein (P5b Ebene 2): `vp.soc.derive` + `soc_source_code`** — Ladestand direkt / aus der Spannungskennlinie (konservatives Min aus Min-/Max-Zelle) / aus der Ladungszaehlung, die Herkunft reist je Messzeitpunkt als Kanal mit · `der-soc-ableitungs-baustein-p5b-ebene-2.md`
- **Die SPEISER-BINDUNG (P6): die eigene Batterie speist den Speicher-Knoten** — AUSDRÜCKLICH gebunden (nie geraten): SoC/Grenzen/Freigaben kommen aus der Batterie, die Leistung bleibt beim Wechselrichter · `die-speiser-bindung-p6-die-eigene-batter.md`
- **Die VORSCHAU und die KURVEN-VORLAGEN (P5d, api-Hälfte)** — zwei kleine Routen unter der Batterie-Fläche: der Kurven-Katalog und die Zuordnungs-Vorschau über den bestehenden Probe-Kanal (`samples`, additiv) · `die-vorschau-und-die-kurven-vorlagen-p5d.md`
- **Einheitsmodell Stufe 6: die VORLAGEN-VERWALTUNG — eine geprüfte Vorlage ist ein DATENSATZ** — vp-modbus-baukasten-k6 §2.8 Stufe 3) · `einheitsmodell-stufe-6-die-vorlagen-verw.md`
- **Einheitsmodell Stufe 4: „STEUERN FREIGEBEN" — aus dem Sensor wird ein schaltbares Gerät** — Die Stufe, die die Captain-Vision einlöst … · `einheitsmodell-stufe-4-steuern-freigeben.md`
- **Verbrauchsmanagement v1 — Paket 3b: „Laden pausieren" als Geschwister des Boosts** — des Boosts: charging-boost.action … · `verbrauchsmanagement-v1-paket-3b-laden-p.md`
- **Entity lifecycle: edit + delete (Standorte/Geräte/Mandanten/Benutzer/Registry)** — Every entity the portal can create can … · `entity-lifecycle-edit-delete-standorte-g.md`
- **Device data purge ("Datenaufzeichnungen löschen")** — Delete ALL recorded timeseries data of … · `device-data-purge-datenaufzeichnungen-lo.md`
- **Live ingest pipe (`services/ingest` + `services/timescale-writer`)** — The MVP core data loop: real edge … · `live-ingest-pipe-services-ingest-service.md`
- **Zero-touch device onboarding (provisioning handshake)** — The customer enters ONLY the … · `zero-touch-device-onboarding-provisionin.md`
- **Secure MQTT broker (real remote-device onboarding, mTLS)** — The path for a physical Node-RED edge to … · `secure-mqtt-broker-real-remote-device-on.md`
- **First-boot device enrollment over HTTPS (kinderleicht mTLS onboarding)** — The automatic path to a device … · `first-boot-device-enrollment-over-https.md`
- **Broker authz auto-reload (`BrokerAuthzReloader`)** — Closes the "claimed-but-refused" timing … · `broker-authz-auto-reload-brokerauthzrelo.md`
- **Standalone edge simulator (`tools/edge-simulator`)** — An installable-anywhere simulated edge … · `standalone-edge-simulator-tools-edge-sim.md`
- **VoltPilot Edge-App (`edge-app/`): the installable customer-side edge** — The productized two-layer edge the … · `voltpilot-edge-app-edge-app-the-installa.md`
- **Production deployment (single VM/VPS, "deploy like saalo")** — MVP-on-one-server: an external reverse … · `production-deployment-single-vm-vps-depl.md`
- **Kubernetes-Readiness: der Betriebsvertrag je Cloud-Dienst** — docs/k8s-readiness.md ist die Referenz … · `kubernetes-readiness-der-betriebsvertrag.md`
- **Build & test per service** — (cd services/api && ./mvnw test) · `build-test-per-service.md`
- **Contracts (binding)** — docs/contracts/ holds the interface … · `contracts-binding.md`
- **v2 entity model - pilot minimum (E1a)** — A device without a pushed registry (and a … · `v2-entity-model-pilot-minimum-e1a.md`
- **v2 entity model - generalization (E1b)** — Everything E1a deferred, on the proven … · `v2-entity-model-generalization-e1b.md`
- **Steuerbare Verbraucher - Inkrement 5 (Produktivierung)** — The FIFTH increment (docs/verbrauchssteuer … · `steuerbare-verbraucher-inkrement-5-produ.md`
- **Steuerbare Verbraucher - Inkrement 6 (Lokaler Deadline-Fallback)** — The SIXTH increment (docs/verbrauchssteuer … · `steuerbare-verbraucher-inkrement-6-lokal.md`
- **Steuerbare Verbraucher - go-e-Wallbox-Treiber (D4/D10/D11: Phasenumschaltung + Verbindungs-Schreibtest)** — Edge-Details: edge-app/AGENTS.md "go-e … · `steuerbare-verbraucher-go-e-wallbox-trei.md`
- **Steuerbare Verbraucher - Shelly-Heizstab-Treiber (D3/D10/D11: Generationserkennung + Totmann-Timer + Bestätigungsstufen)** — Heizstab über Shelly) · `steuerbare-verbraucher-shelly-heizstab-t.md`
- **Steuerbare Verbraucher - Inkrement 4 (Reaktive Regeln)** — The FOURTH increment (docs/verbrauchssteue … · `steuerbare-verbraucher-inkrement-4-reakt.md`
- **Steuerbare Verbraucher - Inkrement 3 (Edge + Simulator)** — Consumer plan vectors are contract-pinned … · `steuerbare-verbraucher-inkrement-3-edge.md`
- **Steuerbare Verbraucher - Inkrement 2 (Optimizer im Shadow-Modus)** — SHADOW heißt: der Optimizer plant … · `steuerbare-verbraucher-inkrement-2-optim.md`
- **Steuerbare Verbraucher - Inkrement 1 (Vertrag + Stammdaten + CRUD + Assistent)** — A consumer STAYS a v2 entity (a … · `steuerbare-verbraucher-inkrement-1-vertr.md`
- **v1 -> v2 site migration mechanism (MIG)** — The rehearsed, REVERSIBLE, per-site … · `v1-v2-site-migration-mechanism-mig.md`
- **Anlagen-Topologie-Read-Model (AE1): the ONE adaptive energy-flow read-model** — The foundation of the adaptive EMS-UI … · `anlagen-topologie-read-model-ae1-the-one.md`
- **Nutzungsprofil / EMS-Modus (AE7): the SECOND adaptation axis (usage profile)** — The usage profile (arbitrage | peak | … · `nutzungsprofil-ems-modus-ae7-the-second.md`
- **Flow-Editor MVP (E3a): admin-only build → validate → simulate → rollout** — Deliberately WITHOUT live monitoring/SSE … · `flow-editor-mvp-e3a-admin-only-build-val.md`
- **Peak-shaving flow node (E5a): the `vp.strategy.peakshaving` runtime path** — The honest remainder of E5a - the … · `peak-shaving-flow-node-e5a-the-vp-strate.md`
- **Customer flow release (E3b): the Kunden-Freigabe of the flow editor** — The customer-facing half of the flow … · `customer-flow-release-e3b-the-kunden-fre.md`
- **Generic Modbus READ node (MB-M1): `vp.modbus.read` + `modbus-generic` entities** — Phase 1 of "lease any Modbus device" … · `generic-modbus-read-node-mb-m1-vp-modbus.md`
- **Web portal (frontend/portal) - unified dashboard shell** — React + Vite + TypeScript SPA. npm run … · `web-portal-frontend-portal-unified-dashb.md`
- **Fleet overview (adaptive Übersicht): `GET /api/v1/overview` + `site.plant_kind`** — Phase 1 of the multi-site fleet overview … · `fleet-overview-adaptive-uebersicht-get-a.md`
- **Realized earnings engine (fleet overview Phase 2): `GET /api/v1/earnings`** — The hero's money number is MEASURED, not … · `realized-earnings-engine-fleet-overview.md`
- **Das BESTANDSKONTO des gemessenen Zeitraums (die FK2-Gutschrift auf der Erlöse-Seite)** — Diagnose data/vp-tagesbild-minus-f3 §6 … · `das-bestandskonto-des-gemessenen-zeitrau.md`
- **Negative-price curtailment + Marktprämie (fleet overview Phase 3)** — One api migration V20260706040000 carries … · `negative-price-curtailment-marktpraemie.md`
- **Per-site grid-charging switch (`site.netzladen_erlaubt`, EEG compliance)** — EEG-funded plants must never charge their … · `per-site-grid-charging-switch-site-netzl.md`
- **Arbitrage-Ausweis ("davon Arbitrage-Gewinn" in the earnings hero)** — No schema change - a read-side … · `arbitrage-ausweis-davon-arbitrage-gewinn.md`
- **Dynamic Marktprämie (anzulegender Wert x Monatsmarktwert Solar) + Marktwert-Benchmark** — Field: site.anzulegender_wert_ct_kwh (api … · `dynamic-marktpraemie-anzulegender-wert-x.md`
- **Money-centric "Meine Anlage" v2 (`GET /api/v1/earnings` money-view fields + `site.tarif_art`/`tarif_param_ct_kwh`)** — The portal side is in frontend/portal/AGEN … · `money-centric-meine-anlage-v2-get-api-v1.md`
- **Forward expected Marktwert Solar (`GET /api/v1/earnings` `expectedMarketValueSolarCtKwh`)** — The forward companion to the … · `forward-expected-marktwert-solar-get-api.md`
- **Market data (ENTSO-E day-ahead prices)** — services/market-data is the … · `market-data-entso-e-day-ahead-prices.md`
- **Forecast service (`services/forecast`)** — Load/PV forecasts for the optimizer … · `forecast-service-services-forecast.md`
- **Keyless data feeds: 15-min day-ahead prices + weather (portal widgets)** — Two KEYLESS public collectors bring real … · `keyless-data-feeds-15-min-day-ahead-pric.md`
- **Die MORGENPROGNOSE: der Optimierer korrigiert die PV-Prognose um ihren eigenen GEMESSENEN Fehler** — Der Fahrplan-Lauf von 09:36 hatte die · `die-morgenprognose-der-optimierer-korrig.md`
- **Die DÄMMERUNG: eine Stundenprognose wird sonnenstandsgerecht auf Viertelstunden verteilt** — Der Plan von 19:30 Uhr · `die-daemmerung-eine-stundenprognose-wird.md`
- **Optimization engine (`services/optimization`)** — The product's heart: a deterministic … · `optimization-engine-services-optimizatio.md`
- **Optimierer ehrlich ohne Ladestand (P7)** — ohne frische ECHTE SoC-Messung plant der Optimierer den Speicher GAR NICHT (Ruhe-Plan, `soc_source=unbekannt`, keine SoC-Bahn, keine geplante Ersparnis) · `optimierer-ehrlich-ohne-ladestand-p7.md`
- **Planungshorizont: 48 h angefragt, auf echte Eingaben gekürzt (28.08.2026)** — Der produktive Zyklus plante eine harte … · `planungshorizont-48-h-angefragt-auf-echt.md`
- **Fahrplan-Warum backend (per-slot "why" facts: optimizer explain layer + schedule columns)** — The optimizer computes + persists the … · `fahrplan-warum-backend-per-slot-why-fact.md`
- **Price-aware in-slot trim: the cloud prices, the edge enforces (2026-07-30)** — The 15-min setpoint stands for the whole … · `price-aware-in-slot-trim-the-cloud-price.md`
- **In-slot load following: the DISCHARGE mirror of the trim (2026-07-30, P1)** — The same quarter-hour gap with the sign … · `in-slot-load-following-the-discharge-mir.md`
- **Netz-null-Reduzieren: die Reduzieren-Erlaubnis ohne Wirtschafts-Test (2026-09-08, P1)** — Begrenzen ist nie unwirtschaftlich … · `netz-null-reduzieren-die-reduzieren-erl.md`
- **Nacht-Wertfunktion: der Ladestand bei Sonnenaufgang bekommt einen Preis (2026-09-08, P3)** — Preisabstand mal Fehlerwahrscheinlichkeit statt fester Reserve … · `nacht-wertfunktion-der-ladestand-bei-son.md`
- **In-slot surplus absorption: the only duty that RAISES a charge (2026-08-02)** — PV 23,9 · Haus 4,3 · Netz-EINSPEISUNG … · `in-slot-surplus-absorption-the-only-duty.md`
- **Die ABREGELUNG folgt der Messung statt dem 15-Minuten-Planwert (2026-08-29)** — §2 Glied 1b / §8 Fix D) · `die-abregelung-folgt-der-messung-statt-d.md`
- **Dynamische Einspeisebegrenzung: der Netzpunkt wird GEREGELT, nicht nur geplant (2026-08-06)** — Der Echtzeit-Wächter, der die … · `dynamische-einspeisebegrenzung-der-netzp.md`
- **E2 flow platform core (edge): arbitration runtime + flowc compiler + flow deployment** — The v2 track's edge runtime slice (branch … · `e2-flow-platform-core-edge-arbitration-r.md`
- **Portal-Admin optimizer surface (diagnostics + config + what-if, `services/api` `optimizer/` package)** — Backend for the admin "understand + tune … · `portal-admin-optimizer-surface-diagnosti.md`
- **What-if re-optimize (`POST /api/v1/admin/sites/{siteId}/optimizer-what-if`, design §4.3)** — The last piece of the admin optimizer … · `what-if-re-optimize-post-api-v1-admin-si.md`
- **Peak Shaving / Lastspitzenkappung (PS-1 + PS-2, cloud side)** — RLM sites pay a Leistungspreis (€/kW per … · `peak-shaving-lastspitzenkappung-ps-1-ps.md`
- **Historie (history/reporting: `services/api` history package + portal "Historie" page)** — The customer-facing history view … · `historie-history-reporting-services-api.md`
- **Shadow-mode forecasting (model registry + Prognosequalität)** — The captain-approved ML path with … · `shadow-mode-forecasting-model-registry-p.md`
- **Prognose-Beförderung: der Schalter im Portal, JE ANLAGE (`site_forecast_model_choice`)** — Die Messung des Schattenbetriebs lief … · `prognose-befoerderung-der-schalter-im-po.md`
- **MaStR integration ("Anlage verknüpfen": registry-fed asset master data)** — The OPTIONAL site-level onboarding step … · `mastr-integration-anlage-verknuepfen-reg.md`
- **Self-maintaining battery-asset <-> device link + manual battery editor** — Before this, MaStR-created (and dev-seed) … · `self-maintaining-battery-asset-device-li.md`
- **Inverter control: physical execution + register-level readback (`vp-inverter-control`)** — The write side MIRRORS the read … · `inverter-control-physical-execution-regi.md`
- **„Grenzen & Wächter" Stufe 0: der Einspeisewächter und die Grenze IM GERÄT** — Herzogau Runde 2 §2/§7 Punkte 3+4 · `grenzen-waechter-stufe-0-der-einspeisewa.md`
- **Register schreiben über das Portal, Stufe 1 „Der Portal-Trigger"** — Register einer Kundenanlage aus der Ferne … · `register-schreiben-ueber-das-portal-stuf.md`
- **⚠ Register schreiben: DIE ADRESSE IST NICHT DAS ZIEL (Produktionsvorfall 20.08.2026)** — Der Auftrag reist auf ems/{t}/{s}/{d}/v2/r … · `register-schreiben-die-adresse-ist-nicht.md`
- **Register schreiben über das Portal, Stufe 2 (Box): freie Register, drei Lanes** — Sie löst die harte 0x00E7-Allowlist des … · `register-schreiben-ueber-das-portal-stuf-2.md`
- **Register schreiben über das Portal, Stufe 2 (Cloud): Register-Wissen, Picker, Zähler** — Die Cloud-Hälfte der Stufe 2 (Konzept … · `register-schreiben-ueber-das-portal-stuf-3.md`
- **Register schreiben über das Portal, Stufe 3 „Bis zum Endkunden"** — D1 = freie LAN-Adresse auch für Endkunden … · `register-schreiben-ueber-das-portal-stuf-4.md`
- **Geräteseiten Stufe 2: die LANE verschwindet für den Benutzer (E4)** — transparent per Server-Alias) · `geraeteseiten-stufe-2-die-lane-verschwin.md`
- **Kommando-Transparenz V1 „Der Verlauf": was VoltPilot an ein Gerät schickt, ist kundensichtbar** — belegt: ein Kunde fragte „drosselt IHR … · `kommando-transparenz-v1-der-verlauf-was.md`
- **Multi-source Anlage (Phase 1): N Erzeuger per site, aggregated ON THE EDGE** — The fix for the general "AC-coupled PV … · `multi-source-anlage-phase-1-n-erzeuger-p.md`
- **Edge `:8484` web app: TWO pages (Betrieb / Einrichten) + Technikmodus** — Structure (concept data/vp-edge-ux-concept … · `edge-8484-web-app-two-pages-betrieb-einr.md`
- **Datenhaltung: Retention/Kompression-Policies (Phase 1+2+3)** — The time-series tables grew unbounded … · `datenhaltung-retention-kompression-polic.md`
- **Portal-Performance-Welle (audit `data/vp-portal-perf-a4`)** — Five measured fixes to the portal's … · `portal-performance-welle-audit-data-vp-p.md`
- **Portal-Performance-Welle II: die UNGEBUNDENE Hypertable-Lesung (HAR-Befund 24.08.2026)** — Die Fortsetzung des Abschnitts darüber … · `portal-performance-welle-ii-die-ungebund.md`
- **Conventions & decisions worth knowing** — Maven over Gradle for JVM services: mvn … · `conventions-decisions-worth-knowing.md`
- **Ersparnis-Simulation (Inkrement 1, design `vp-sim-design-t6`)** — The operator what-if instrument (captain … · `ersparnis-simulation-inkrement-1-design.md`
- **Portal v3 build spec (approved design, not yet built)** — The owner-approved UX/UI rework of the … · `portal-v3-build-spec-approved-design-not.md`
- **Cockpit Phase 1 / E1+E2: die Wallbox wird eine MESSENDE Komponente** — Bis hierher lebten die Kilowatt eines … · `cockpit-phase-1-e1-e2-die-wallbox-wird-e.md`
- **Cockpit Phase 1 / C1: WO eine Ladesäule hängt (`haus` | `eigen`)** — Bis hierher gab es die Unterscheidung … · `cockpit-phase-1-c1-wo-eine-ladesaeule-ha.md`
- **Cockpit Phase 1 / C2: die Topologie-Rolle `charging` (und `charging-own`)** — (Abzweig vom Haus; eigener Anschluss als … · `cockpit-phase-1-c2-die-topologie-rolle-c.md`
- **Verbrauchsmanagement v1 — Paket 6: die RANGLISTE erreicht die Box** — P4 hat die Reihenfolge gebaut und auf … · `verbrauchsmanagement-v1-paket-6-die-rang.md`
- **Anwendungen (im Code: Modus-Profile): the per-Anlage profile state (Portal v3 M3)** — ⚠ The CUSTOMER word is „BETRIEBSMODELL" … · `anwendungen-im-code-modus-profile-the-pe.md`
- **Der EINE Anwendungs-Katalog (`anwendungen/catalog.json`, Anwendungs-Programm Stufe 1)** — Der beschreibende Teil einer Anwendung … · `der-eine-anwendungs-katalog-anwendungen.md`
- **Steuerung Stufe 0 „Entwirrung": das Regal sind die BETRIEBSMODELLE** — Reines Ausblenden — KEINE Datenänderung … · `steuerung-stufe-0-entwirrung-das-regal-s.md`
- **Steuerung Stufe 5: es läuft immer nur EIN Betriebsmodell** — „es fährt immer nur EIN Betriebsmodell … · `steuerung-stufe-5-es-laeuft-immer-nur-ei.md`
- **`site.profil`: das PRESET der Anlage (Anwendungs-Programm Stufe 2)** — „Ja: site.profil (privat|gewerbe … · `site-profil-das-preset-der-anlage-anwend.md`
- **Cockpit anpassen: der LAYOUT-SPEICHER mit drei Schichten (Anwendungs-Programm Stufe 3)** — Anlagen-Vorgabe gewinnt) · E2 (Kunde … · `cockpit-anpassen-der-layout-speicher-mit.md`
- **Eigene Auswertung: der Kunde baut seine KENNZAHL (Anwendungs-Programm Stufe 5)** — Die Stufe B der Cockpit-Freiheit (Scout … · `eigene-auswertung-der-kunde-baut-seine-k.md`
- **Das PORTFOLIO-COCKPIT: EINE Flotten-Fläche für jeden Mehr-Anlagen-Kunden (Stufe 4, Rev. 2)** — steuert nur noch DICHTE und TONALITÄT … · `das-portfolio-cockpit-eine-flotten-flaec.md`
- **Automationen / flow editor at Node-RED quality (Portal v3 M5)** — The customer-facing automation editor + … · `automationen-flow-editor-at-node-red-qua.md`
- **Wechselrichter-Automatik (Selbstregel-Modus): der Deckungs-Slot ohne 10-s-Sollwert** — der Fahrplan Verbrauch decken vorsieht … · `wechselrichter-automatik-selbstregel-mod.md`
- **Überschuss-Einlagerung im Fahrplan-Modus: der Ladeboden unter der Ökonomie** — Der SPIEGEL der Defizit-Deckung darunter … · `ueberschuss-einlagerung-im-fahrplan-modu.md`
- **Defizit-Deckung im Fahrplan-Modus: die Kundenvertrauens-Regel unter der Ökonomie** — 19:37: 92 % Speicher, PV 1,3 kW, Haus 2,7 … · `defizit-deckung-im-fahrplan-modus-die-ku.md`
- **Known future work (not yet built)** — Historie v2 (captain-agreed deferred … · `known-future-work-not-yet-built.md`
- **Erklärbarkeit Stufe 0: die Echtheits-Regel für Begründungs-Sätze** — JEDE Fläche, die erklärt, warum der … · `erklaerbarkeit-stufe-0-die-echtheits-reg.md`
- **Erklärbarkeit Stufe 1 „Der Echtheits-Kern": die Treiber werden EXPORTIERT** — Der Auftrag der Regel oben · `erklaerbarkeit-stufe-1-der-echtheits-ker.md`
- **Erklärbarkeit Stufe 2 „Die Lage": die Prognose-Erzählung auf der Fahrplan-Seite** — Sie ist REIN Portal — kein Endpunkt … · `erklaerbarkeit-stufe-2-die-lage-die-prog.md`
- **Erklärbarkeit Stufe 3 „Grenzen als Gründe": die Abregelung nennt ihren Urheber** — Stufe 3, Captain-Entscheide F1–F6) · `erklaerbarkeit-stufe-3-grenzen-als-gruen.md`
- **OCPP-Lastmanagement (Ladepunkte): Stufe 0-2** — Die Box ist das Central System, das die … · `ocpp-lastmanagement-ladepunkte-stufe-0-2.md`
- **OCPP-Lastmanagement Stufe 3: die Ladepunkte werden CLOUD-sichtbar** — Die Cloud sieht zu, sie entscheidet nicht … · `ocpp-lastmanagement-stufe-3-die-ladepunk.md`
- **OCPP-Lastmanagement Stufe 3: der MODUS und die Konfiguration aus dem Portal** — Der eigenständige Modus als Regal-Profil … · `ocpp-lastmanagement-stufe-3-der-modus-un.md`
- **OCPP-Lastmanagement Stufe 4: PV-Überschussladen und „Jetzt voll laden" aus dem Portal** — Die Cloud-Hälfte der letzten Stufe … · `ocpp-lastmanagement-stufe-4-pv-ueberschu.md`
- **OCPP-Datenfundament (Slice 10): vollständig lesen, noch NICHT fernsteuern** — Der Edge bleibt das lokale CSMS. Slice 10 … · `ocpp-datenfundament-slice-10-vollstaendi.md`
- **OCPP Command Gateway (Slices 11/12): Antwort ist nicht Wirkung** — Der vollständige CSMS→Station-Pfad liegt … · `ocpp-command-gateway-slices-11-12-antwor.md`
- **Anlagen-Zentrale Stufe 1: jedes Gerät hat EINE deep-linkbare Seite** — Reine Portal-Arbeit — es entsteht kein · `anlagen-zentrale-stufe-1-jedes-geraet-ha.md`
- **D5: die Box meldet ihre Adresse im KUNDEN-LAN, getrennt vom Zugriffsweg** — Anlagen-Zentrale Stufe 2 PR 2c (Konzept … · `d5-die-box-meldet-ihre-adresse-im-kunden.md`
- **Anlagen-Zentrale Stufe 2: das STRUKTUR-SCHALTBILD** — Revision 2: es wohnt in einem EIGENEN … · `anlagen-zentrale-stufe-2-das-struktur-sc.md`
- **Geräte-Erlebnis Slice 1: Anlagenbild als direkte Navigation (27.08.2026)** — Die aktuelle Komponenten-Seite … · `geraete-erlebnis-slice-1-anlagenbild-als.md`
- **Anlagen-Zentrale Stufe 3: die KONSOLIDIERUNG — ein Ding, ein Ort** — (Konsolidierungs-Landkarte §9, Redirects … · `anlagen-zentrale-stufe-3-die-konsolidier.md`
- **Der WEG zu einem Gerät reist auf `/entities` (Anlagen-Zentrale Stufe 2, PR 2b)** — Anlagen-Zentrale Stufe 2 PR 2b (Konzept … · `der-weg-zu-einem-geraet-reist-auf-entiti.md`
- **Geräteseiten Stufe 1: die ATTRIBUTION „Ziel-Gerät führt"** — Der behobene Befund war eine ZWEITE … · `geraeteseiten-stufe-1-die-attribution-zi.md`
- **Geräteseiten Stufe 1: die ABREGELUNG sagt, an WEN sie geht (`per_unit`)** — Bis hierher konnte die Cloud die … · `geraeteseiten-stufe-1-die-abregelung-sag.md`
- **Geräteseiten Stufe 0: EIN Rückweg, und die Messbibliothek gehört dem GERÄT** — D1a/D5a, 27.08.2026) · `geraeteseiten-stufe-0-ein-rueckweg-und-d.md`
- **Geräteseiten Stufe 1: die BOX ist eine TOR-Seite (`/box`)** — Box teilte sich eine Seite mit den … · `geraeteseiten-stufe-1-die-box-ist-eine-t.md`
- **Der Kommando-Verlauf JE GERÄT: `?device=` auf `/command-history`** — Anlagen-Zentrale Stufe 1 PR 1b (Konzept … · `der-kommando-verlauf-je-geraet-device-au.md`
- **Der Befehls-Verlauf hat eine SUCHE und einen FILTER (Geräteseiten Stufe 3, R3)** — Der Verlauf kannte nur Heute/Woche und … · `der-befehls-verlauf-hat-eine-suche-und-e.md`
- **Der OCPP-ANBINDE-ASSISTENT: die Adresse zum Kopieren, die Kennung aus dem Portal** — Bis hierher waren „eine Säule anbinden" … · `der-ocpp-anbinde-assistent-die-adresse-z.md`
- **Eine Ladepunkt-Kennung ZURÜCKNEHMEN: der GRABSTEIN, nicht das Löschen** — kennungen zu löschen") · `eine-ladepunkt-kennung-zuruecknehmen-der.md`
- **Der Verbindungstest bietet HEBEL an (Geräteseiten Stufe 3, NACHTRAG 2)** — „Konkrete Hebel direkt im Dialog anbieten … · `der-verbindungstest-bietet-hebel-an-gera.md`
- **KACO: EINE Marke, ZWEI Plattformen - und die brand-neutrale SunSpec-Kennung** — Die KACO-Palette in Deye-Dichte (70 … · `kaco-eine-marke-zwei-plattformen-und-die.md`
- **Versionierter Messpunktkatalog (`catalog/measurement-points`)** — Eine Wahrheit für Portal, Cloud und Edge · `versionierter-messpunktkatalog-catalog-m.md`
- **Zusätzliche Messwerte: Auswahl- und Auditfundament (Slice 5)** — Die Cloud speichert Soll, nicht … · `zusaetzliche-messwerte-auswahl-und-audit.md`
- **Zusätzliche Messwerte: Bibliothek und Historie (Slice 9)** — Die gemeinsame Messbibliothek hängt an … · `zusaetzliche-messwerte-bibliothek-und-hi.md`
- **Mess-Selektion JE KOMPONENTE (Geräteseite Stufe 3b, Server)** — Bis hierher war die Auswahl je … · `mess-selektion-je-komponente-geraeteseit.md`
- **Geräteseite Stufe 3c: die Box liest einen Punkt über SEINE Komponente** — Die Edge-Hälfte der Mess-Selektion (Scout … · `geraeteseite-stufe-3c-die-box-liest-eine.md`
- **Steuerung Stufen 8+9: die UMZÜGE und die Datenbereinigung** — Portfolio/Nav data/vp-portfolio-konzept-r2 … · `steuerung-stufen-8-9-die-umzuege-und-die.md`
- **Steuerung Stufe 3 „Vorrang technisch": die Regel gewinnt, weil kein Fahrplan mehr konkurriert** — Der Arbiter, die Prioritätsklassen und … · `steuerung-stufe-3-vorrang-technisch-die.md`
- **Steuerung Stufe 4 „Handeingriffe": der Speicher von Hand, und die Anlage kurz in Ruhe** — Es entsteht kein zweiter Steuerweg: der … · `steuerung-stufe-4-handeingriffe-der-spei.md`
- **Zusätzliche Messwerte: Desired State bis Timescale (Slices 6–8)** — Drei additive v2-Verträge, keine Änderung … · `zusaetzliche-messwerte-desired-state-bis.md`
- **Verbrauchsmanagement v1 / P8: die SG-Ready-Wärmepumpe ist ein eigener Typ** — Zustand 3 „Anlaufempfehlung", EIN Relais · `verbrauchsmanagement-v1-p8-die-sg-ready.md`
- **Verbrauchsmanagement v1 — Paket 1: die Verbraucher-Zone LESEND** — data/vp-verbrauchsmgmt-programm §6/§7/§8 … · `verbrauchsmanagement-v1-paket-1-die-verb.md`
- **Verbrauchsmanagement v1 — Paket 2: die Steuerart SCHREIBEN** — Der Schreibweg zu P1s Lese-Aggregat … · `verbrauchsmanagement-v1-paket-2-die-steu.md`
- **Verbrauchsmanagement v1 — Paket 4: die RANGLISTE wird bedienbar** — (frei sortierbar · Speicher oben · … · `verbrauchsmanagement-v1-paket-4-die-rang.md`
- **Verbrauchsmanagement v1 — Paket 5: der Ladepunkt wird eine Komponente wie jede andere** — Das größte Paket des Programms (Konzept … · `verbrauchsmanagement-v1-paket-5-der-lade.md`
- **Verbrauchsmanagement v1 — Paket 7: FAHRZEUG-PROFILE (je Ladekarte eine Steuerart)** — Pseudonym-Profile über tag_ref, KEIN … · `verbrauchsmanagement-v1-paket-7-fahrzeug.md`
- **Verlauf-Sprache P0: die Token des Bereichs „Verlauf" und ihre drei Wächter** — Reines Fundament: kein Stylesheet und … · `verlauf-sprache-p0-die-token-des-bereich.md`
- **Maintaining this file** — Keep this file for knowledge useful to … · `maintaining-this-file.md`

## Maintaining this file

**Größen-Budget (seit 05.09.2026, hart bewacht):** `AGENTS.md` ≤ 60 KB,
`frontend/portal/AGENTS.md` ≤ 45 KB, `edge-app/AGENTS.md` ≤ 45 KB. Wächter:
`bash tools/agents-md-budget.sh` (Matrix-Leg `agents-md` in `.forgejo/workflows/deploy.yaml`),
im Portal zusätzlich `npm run test:agents-md`. **Die Zahl wird nur KLEINER, nie größer** —
wer sie anhebt, hat den Wächter abgeschafft, nicht bestanden.

Der Grund: Claude Code lädt `CLAUDE.md` → diese Datei bei JEDEM Sitzungsstart. Am 05.09.2026
waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB angewachsen und haben Worker binnen
Minuten an der Kontextgrenze sterben lassen.

**Die Regel daraus: hier steht ein POINTER, das Detail wohnt in `docs/agents/`.** Ein neuer
Abschnitt wird `docs/agents/<bereich>/<slug>.md` und bekommt hier EINE Index-Zeile
(`**Thema** — ein Satz Kern · \`<slug>.md\``). In den Wegweiser gehört nur, was FAST JEDE
Sitzung braucht: Aufbau, Befehle, die harten Hausregeln. Was der Code schon zeigt, gehört
gar nicht hierher — dann reicht der Verweis auf Datei, Befehl oder Test.

Der Umbau ist wiederholbar: `python3 tools/agents-md-split.py` erzeugt aus dem Kern
(`tools/agents-md-kern/<bereich>.md`) plus dem Bestand denselben Zustand, `--verify` beweist
die Byte-Gleichheit jedes ausgelagerten Abschnitts.
