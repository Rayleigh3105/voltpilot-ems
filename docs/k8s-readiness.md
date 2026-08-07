# Kubernetes-Readiness: der Betriebsvertrag je Cloud-Dienst

Was ein Manifest über einen Dienst annehmen darf — Probe-Pfad, Shutdown-Verhalten,
Pflicht-Env, Skalierbarkeit. **Dies ist die Referenz, auf die die GitOps-Manifeste
zeigen** (Repo `voltpilot-deploy`, Konzept: Scout-Report `vp-zielinfra-k6`).

Der Compose-Betrieb (`docker-compose.prod.yml`) ist unverändert gültig und bleibt
die heutige Produktion; alles hier ist additiv. Wo Kubernetes sich anders verhält
als Compose, steht es als **k8s-Falle** dabei — die wichtigste vorweg:

> **Kubernetes kennt kein `depends_on`.** Jeder Pod startet, sobald der Scheduler
> ihn platziert; DB, Broker und Redpanda können noch fehlen. Ein Dienst muss das
> entweder selbst mit Retry überbrücken oder sauber sterben (CrashLoopBackOff ist
> ein legitimer Retry-Mechanismus) — er darf nur nicht *stillstehen*.

> **Ein Prozess als PID 1 bekommt keine Default-Signalbehandlung.** Der Kernel
> stellt PID 1 nur Signale zu, für die ein Handler registriert ist. Python und
> Node ohne expliziten SIGTERM-Handler ignorieren SIGTERM im Container also
> vollständig und werden nach Ablauf der `terminationGracePeriodSeconds` per
> SIGKILL beendet — bei jedem Rollout. Die JVM registriert ihre Handler selbst
> (Shutdown-Hooks), nginx ebenfalls.

---

## Überblick

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

Alle Dienste loggen ausschließlich nach stdout/stderr (kein File-Appender, kein
Logback-XML). Alle Konfiguration kommt aus Env; die Ausnahmen stehen unten je
Dienst unter *Schreibpfade*.

---

## JVM-Dienste (`api`, `ingest`, `timescale-writer`)

**Health.** Spring-Boot-Actuator unter Root-Base-Path (`management.endpoints.web.base-path: /`)
mit `management.endpoint.health.probes.enabled: true`. Damit existieren drei Pfade:

* `/health` — das Aggregat: `diskSpace`, `ping` und, wo eine Datasource
  konfiguriert ist (api, writer), `db`. **Nicht als Probe verwenden.** Eine
  Liveness-Probe darauf startet den Pod neu, wenn die *Datenbank* weg ist — ein
  Neustart repariert das nie und macht aus einem DB-Ausfall einen Restart-Sturm.
  (Der Compose-Healthcheck nutzt `/health` bewusst weiter: dort ist er ein
  Betriebs-Signal, kein Restart-Auslöser.)
* `/health/liveness` — nur `livenessState`. **Liveness-Probe.**
* `/health/readiness` — nur `readinessState` (Spring nimmt externe Systeme wie `db`
  per Default *nicht* auf). **Readiness-Probe.** Nicht per
  `management.endpoint.health.group.readiness.include=db` erweitern: sonst nimmt
  ein DB-Blip alle Replicas gleichzeitig aus dem Load-Balancer.

**Graceful Shutdown.** `server.shutdown: graceful` +
`spring.lifecycle.timeout-per-shutdown-phase: ${SHUTDOWN_TIMEOUT:20s}` sind
gesetzt (Guard: `K8sReadinessConfigTest` je Dienst). Auf SIGTERM nimmt Tomcat
keine neuen Verbindungen mehr an und lässt laufende Requests zu Ende laufen; die
MQTT-Listener trennen sich über ihre `@PreDestroy`.

Empfohlene Pod-Sequenz:

```yaml
lifecycle:
  preStop:
    exec: { command: ["sleep", "8"] }   # LB-Abmeldung abwarten, DANN SIGTERM
terminationGracePeriodSeconds: 45        # > preStop(8) + SHUTDOWN_TIMEOUT(20) + Puffer
```

**Startup.** Der `api` migriert beim Start (Flyway) und heilt die Broker-ACL
(`selfHealBrokerAclOnStartup`, inkl. eines synchronen EMQX-Reloads mit bis zu
~20 s Timeout-Budget, wenn der Broker nicht antwortet). Ohne erreichbare DB
bricht der Start ab → CrashLoopBackOff mit exponentiellem Backoff — das ist das
gewollte Verhalten, aber es braucht eine großzügige `startupProbe`:

```yaml
startupProbe:
  httpGet: { path: /health/liveness, port: 8090 }
  periodSeconds: 5
  failureThreshold: 36        # bis zu 3 min für Flyway + ACL-Heal
```

`ingest` und `writer` starten dagegen auch ohne Broker/DB: der Paho-Adapter hat
`automaticReconnect(true)`, der Kafka-Listener-Container retryt im Hintergrund.

**Env.** Pflicht wie in `docker-compose.prod.yml`; neu/relevant für k8s:

| Variable | Default | Zweck |
|---|---|---|
| `SHUTDOWN_TIMEOUT` | `20s` | Obergrenze des Graceful Shutdown |
| `DB_POOL_MAX_SIZE` | `10` | Hikari-Pool **pro Replica** (api, writer) |
| `JAVA_TOOL_OPTIONS` | – | **In k8s setzen:** `-XX:MaxRAMPercentage=75` — ohne Limit nimmt die JVM 25 % des *sichtbaren* RAM, was mit `resources.limits.memory` nicht zusammenpasst. Kein Dockerfile-Change nötig, die JVM liest die Variable selbst. |

**Schreibpfade.** `ingest`/`writer`: nur `/tmp`. `api` zusätzlich **beschreibbar**:
`voltpilot.enrollment.ca-dir` (openssl-Serial/`index.txt`/`newcerts/`) und das
Verzeichnis von `voltpilot.enrollment.acl-file` — siehe Singleton-Blocker.
**Niemals die `acl.conf` als Einzeldatei mounten**, immer ihr Verzeichnis (der
atomare Rename scheitert sonst mit EBUSY).

**Skalierung — die Blocker (unverändert, hier nur dokumentiert):**

1. **CA-Verzeichnis + `acl.conf`** sind gemeinsam beschriebene Dateien
   (openssl-Serial-Protokoll, ACL-Rewrite); EMQX mountet dasselbe Verzeichnis
   read-only. Nicht multi-writer-fähig. → Bis zum Umbau auf den
   EMQX-Postgres-Authorizer läuft der PKI-/Enrollment-Pfad als eigenes
   Singleton-Deployment (`api-enroll`, gleiches Image, Ingress routet
   `/api/v1/enrollment/*` dorthin, `strategy: Recreate`).
2. **`SimulationJobRegistry` ist In-Memory.** Ein Poll auf Replica B findet einen
   auf A gestarteten Job nicht (404) → das Portal startet ihn neu. Kurzfristig
   Session-Affinity auf `/api/v1/**/simulation*`, richtig: Registry in die DB.
3. **Rate-Limiter (Registration/Enrollment) sind In-Memory** — das Limit
   multipliziert sich mit der Replica-Zahl. Akzeptiert, hier dokumentiert.
4. **MQTT-Status-Listener** (control/entities/sources/flows/purge) konsumieren pro
   Replica. Die Upserts sind idempotent (kein Korrektheitsproblem), die DB-Last
   vervielfacht sich aber. Nativer Fix: Shared Subscriptions
   (`$share/api/ems/+/+/+/status`).
5. **Flyway läuft beim Start**, d. h. während eines Rollouts arbeitet Code N−1
   gegen Schema N → **Expand-Contract-Regel** (siehe unten).
6. **`ingest`** ist nur bedingt skalierbar: zwei Replicas mit `cleanSession(true)`
   und eigener Client-ID konsumieren jede Nachricht **doppelt**. Bis auf Shared
   Subscriptions umgestellt: `replicas: 1`.

---

## Metriken (Prometheus) — nur `api`

**Scrape:** `GET :8090/metrics`, **unauthentifiziert**, kein eigener
Management-Port.

Drei Dinge daran sind bewusst so und nicht anders:

* **Der Pfad ist `/metrics`, nicht `/prometheus` und nicht `/actuator/prometheus`.**
  Der Actuator-Endpunkt heißt `prometheus`; weil der Management-Base-Path die
  Wurzel ist, läge er auf `/prometheus`. `management.endpoints.web.path-mapping`
  hängt ihn auf `/metrics` um — die Ökosystem-Konvention und der
  ServiceMonitor-Default. Der JSON-`metrics`-Endpunkt ist NICHT exponiert, es
  gibt also keine Kollision.
* **Anonym, und das braucht eine ausdrückliche Freigabe.** Prometheus scrapt ohne
  Token. `SecurityConfig` erlaubt genau diesen einen Pfad (`GET /metrics`) —
  kein Platzhalter, dieselbe Disziplin wie bei den Probe-Pfaden, deren fehlende
  Freigabe am 02.08.2026 jeden api-Pod in den Neustart-Kreisel schickte.
  Regressionswächter: `MetricsEndpointSecurityTest` (echte Filterkette).
* **Von außen nicht erreichbar.** Die nginx des Frontends proxied nur `/api/`
  und `/auth/`; `https://<domain>/metrics` trifft die SPA. Der Endpunkt
  existiert nur im Pod-/Compose-Netz. Ein zweiter Management-Port hätte daran
  nichts verbessert und Deployment + Service verkompliziert.

**Was ausgegeben wird** (`com.voltpilot.api.metrics`, gesammelt alle 60 s;
Kill-Switch `VOLTPILOT_METRICS_FLEET_ENABLED=false`, Vorgabe AN):

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

**Die Labels sind INTERNE Kennungen — kein Name, keine Adresse, kein Messwert.**
Der Endpunkt antwortet unauthentifiziert und seine Ausgabe reist über
Alertmanager bis in Telegram und E-Mail, also aus der Plattform heraus; ein
Anlagen- oder Mandantenname wäre dort Kundenstammdaten (bei
Selbstregistrierung ist der Mandantenname der Personen- bzw. Firmenname des
Kunden). Ein Alarm benennt die Anlage über ihre UUID und verlinkt sie mit
`https://<portal>/#/anlage/{{ $labels.site }}`; der Klartext bleibt hinter der
Anmeldung. Gewächter von `FleetMetricsScrapeTest`.

**Ehrlichkeitsregel: was nicht gemessen ist, ist keine Zahl.** Eine Anlage ohne
bekanntes Alter hat **keine** Alters-Zeitreihe — weder eine 0 noch ein Sentinel
(mit `-1` rechnete früher oder später jemand weiter). Die Unterscheidung, auf der
jede Alarm-Regel steht, trägt stattdessen das Enum:
`never` (frische Anlage, **kein** Alarm) vs. `older_than_window` (hatte
Fahrpläne, aber keinen im 7-Tage-Fenster — **echter** Alarm, nur nicht mehr
bezifferbar). Das Fenster ist eine Kostenbremse, keine Nachlässigkeit: ohne es
wäre die Abfrage ein Scan über die ganze Plan-Historie.

**Alarm-Regeln immer aggregieren.** Heute läuft genau eine api-Replica; bei
mehreren sammelt jede für sich und exponiert dieselben `site`-Serien unter
eigenem `pod`/`instance`. Regeln deshalb von Anfang an so schreiben:

```promql
# Anlage fährt ohne Fahrplan (der Vorfall vom 06./07.08.2026)
max by (site, tenant) (voltpilot_site_last_plan_age_seconds) > 3600
  or max by (site, tenant) (voltpilot_site_plan_state{state="older_than_window"}) == 1

# Anlage verstummt (eine Neuanlage ohne Gerät fällt raus - die steht auf "never")
max by (site, tenant) (voltpilot_site_last_telemetry_age_seconds) > 900

# Die URSACHE des Vorfalls, der früheste Alarm von allen
min by (zone) (voltpilot_priced_slots_ahead) < 16

# Und der Wächter über dem Wächter
max(voltpilot_metrics_collect_age_seconds) > 300
```

**Kosten.** Gesammelt wird auf einem Zeitgeber (60 s), **nie pro Scrape** — ein
Scrape darf keine flottenweite Aggregat-Abfrage auslösen. Gemessen
(`FleetMetricsDbTest`, echte TimescaleDB): **Median 88–160 ms** (über mehrere
Läufe, maschinenabhängig) über 11.606 Telemetrie- und 69.206 Plan-Zeilen in
**106 Chunks** (ein Jahr Historie); bei nur 9 Chunks waren es 54 ms. Die
Chunk-Anzahl ist der Treiber, nicht die Zeilenzahl — `max(received_at)` je Gerät
und das `EXISTS` auf `schedule` fassen je Chunk einen Index an. Selbst am oberen
Ende bleibt ein Lauf ~400× unter dem Takt.

**Im Testlauf ist der Sammler AUS** (surefire-Systemeigenschaft, siehe
`services/api/pom.xml`): Spring cacht Testkontexte, während Testcontainers seine
Container nach der Klasse stoppt — ein getakteter Job liefe danach in jedem
zwischengespeicherten Kontext gegen eine tote Datenbank weiter. Die
ausgelieferte Vorgabe bleibt AN und wird an der echten `application.yml` geprüft.

**Das ALTER wird beim Scrape gerechnet, nicht beim Sammeln.** Läge eine feste
Zahl aus, fröre „Alter des Fahrplans" bei einem gesunden Wert ein, sobald der
Sammler stirbt — und **jeder** Alarm verstummte still. So wächst es weiter: ein
toter Sammler sieht aus wie ein toter Optimierer, die sichere Richtung.

**Andere Dienste exponieren nichts.** Die Betriebs-Wahrheit sitzt bewusst im
`api`: er läuft ohnehin, hat die Daten aggregiert und eine Actuator-Basis,
während der Optimierer eine Takt-Schleife ist.

---

## Python-Dienste (`market-data`, `weather-collector`, `forecast`, `optimization`, `simulation`)

Die vier Collector-Schleifen (`serve`) teilen sich ein Laufzeit-Modul
`runtime.py` — **byte-identisch in `voltpilot_optimization`,
`voltpilot_forecast` und `voltpilot_market_data`** (drei eigenständige
Distributionen ohne gemeinsames Paket; Drift-Guard:
`services/optimization/tests/test_runtime.py`). Es liefert drei Dinge:

**1. SIGTERM/SIGINT-Handler + unterbrechbarer Schlaf.** Ohne ihn ignoriert der
Container SIGTERM (PID-1-Regel oben) und wartet die volle Grace-Period ab — bei
`market-data` läge der Prozess sonst bis zu 6 h in `time.sleep`. Der Handler
setzt ein `threading.Event`, der Schlaf ist ein `Event.wait`, die Schleife endet
innerhalb von Millisekunden.

**2. `/health` und `/ready`** (stdlib-HTTP, eigener Daemon-Thread):

* `GET /health` — **immer 200**, solange der Prozess lebt. Der Body sagt die
  Wahrheit: `{"service","status":"starting|ok|degraded","cycles",
  "consecutive_failures","last_error","last_success_age_seconds","stopping"}`.
  Bewusst *kein* 503 bei fehlgeschlagenen Zyklen: einen Collector neu zu starten
  repariert keine unerreichbare Datenbank, und ein 503 würde aus einem DB-Blip
  einen flottenweiten Restart-Sturm machen.
* `GET /ready` — 503 bis der erste Zyklus durchgelaufen ist, danach 200; beim
  Shutdown wieder 503. Readiness heißt hier „die Schleife dreht sich", nicht
  „das Upstream ist gesund".
* Port über Env, **`0` schaltet den Endpoint ab** (die Unit-Suites nutzen das).

**3. Exponentieller Backoff nach fehlgeschlagenem Zyklus.** Bisher schlief die
Schleife nach *jedem* Ausgang die volle Kadenz — auf einem Cluster-Kaltstart
(kein `depends_on`!) scheitert der erste Zyklus an der noch nicht laufenden DB
und der Dienst tat danach 6 h (market-data) bzw. 3 h (weather) **gar nichts**.
Jetzt: 5 s → 10 s → 20 s … gedeckelt bei 300 s und nie länger als die konfigurierte
Kadenz; ein erfolgreicher Zyklus kehrt sofort zur Baseline zurück.

**`connect_timeout`.** Alle DSN-Builder hängen `?connect_timeout=${POSTGRES_CONNECT_TIMEOUT:-10}`
an. Ohne das wartet libpq den OS-TCP-Timeout ab — im streng sequenziellen
Optimizer-Zyklus blockiert *ein* hängender Connect alle folgenden Sites und den
Shutdown-Handler gleich mit.

**`PYTHONUNBUFFERED=1`** in allen drei Python-Images: stdout ist im Container eine
Pipe und damit block-gepuffert, die `print()`-Ausgaben der Schleifen hätten sonst
im 8-KB-Puffer gestanden statt in `kubectl logs`.

| Dienst | Health-Port (Env) | Kadenz (Env) | Bemerkung |
|---|---|---|---|
| `market-data` | `MARKET_DATA_HEALTH_PORT` = 8094 | `MARKET_DATA_REFRESH_SECONDS` = 21600 | Zyklus gilt nur als gescheitert, wenn **kein** Tag geholt werden konnte |
| `optimization` | `OPTIMIZER_HEALTH_PORT` = 8096 | `OPTIMIZER_INTERVAL_SECONDS` = 900 | siehe Deadline-Hinweis unten |
| `forecast` | `FORECAST_HEALTH_PORT` = 8097 | `FORECAST_INTERVAL_SECONDS` = 900 | ML-Retrain einmal pro Berlin-Tag → CPU-Spitze |
| `weather-collector` | `WEATHER_HEALTH_PORT` = 8098 | `WEATHER_REFRESH_SECONDS` = 10800 | |
| `simulation` | `SIM_PORT` = 8095 (fest `/health`) | – | HTTP-Dienst, keine Schleife |

**`optimization` — Shutdown mitten im Zyklus.** SIGTERM beendet die Schleife nach
dem *laufenden* Site-Plan; ein abgebrochener Zyklus ist unkritisch, weil der
`schedule`-Upsert idempotent ist (PK `site_id/generated_at/time`) und der
Edge-Failsafe ein 20-min-Staleness-Fenster hat — genau ein verpasster
15-min-Zyklus ist gedeckt. Grace-Period 60 s, damit ein laufender Site-Plan
(MILP ~70 ms + I/O) fertig wird. **Kein `terminationGracePeriodSeconds` unter
30 s**: der Zyklus läuft bei vielen Anlagen minutenlang und wird dann hart
abgeschnitten (folgenlos, aber unnötig laut im Log).

**`simulation` — Shutdown verwirft laufende Jobs, bewusst.** Die Job-Registry
liegt im Speicher (V1 ist zustandslos), ein Job überlebt den Neustart also
ohnehin nicht; das Portal reicht ihn neu ein, der Ergebnis-Cache macht die
Wiederholung sofort. Deshalb ist `replicas: 1` Pflicht (ein Poll auf einer
anderen Replica bekäme 404) und eine lange Grace-Period sinnlos. Der
`ProcessPoolExecutor` nutzt `spawn` (Fork nach HiGHS/OpenMP-Threads deadlockt);
seine Kinder sterben mit dem Container-Namespace, es bleiben keine Zombies.

**Schreibpfade.** Keine — außer `/tmp`. Der einzige Dateizugriff ist *lesend* und
optional: `SIM_BDEW_H25_JSON` (operator-bereitgestelltes Lastprofil, siehe
`services/optimization/README.md`). Der Solver nutzt die APPSI-HiGHS-Schnittstelle
(in-memory), schreibt also keine LP-Dateien.

---

## `flowc` (Node-Sidecar)

`GET /health` → `{"status":"ok","compiler_version":…}`, Port `FLOWC_PORT`
(Default 8099), Bind `FLOWC_BIND`. Zustandslos, beliebig skalierbar, aber ein
Pod reicht (Millisekunden pro Compile).

SIGTERM/SIGINT werden explizit behandelt (`installShutdownHandlers` in
`serve.js`): keine neuen Verbindungen, laufende Compiles zu Ende, dann `exit(0)`;
Backstop-Timer 10 s. Ohne diesen Handler würde der Sidecar als PID 1 SIGTERM
ignorieren (Beweis: `shutdown.test.js` startet den echten Entrypoint und verlangt
`signal === null`). Grace-Period 15 s reicht.

Die Log-Zeile beim Start nennt den **tatsächlich gebundenen** Port (relevant bei
`FLOWC_PORT=0`).

---

## `frontend` (nginx)

`GET /healthz` → `200 ok` (unlogged). Bewusst ohne Aussage über `api`/`keycloak`:
diese haben eigene Probes auf eigenen Pods; „ready" heißt hier nur „liefert die
SPA aus". Die SPA-Location beantwortet über `try_files` jeden Pfad mit 200, taugt
also nicht als Probe.

**k8s-Falle — DNS (zwei Konsequenzen):** nginx löst die Upstream-Namen in
`proxy_pass http://api:8090` **einmal beim Start** auf und cacht sie.

1. **Ein unauflösbarer Upstream verhindert den START.** Verifiziert:
   `nginx -t` mit dieser Config bricht mit `host not found in upstream "api"` ab.
   Ohne `depends_on` heißt das: solange die Services `api`/`keycloak` im Namespace
   fehlen, läuft das Frontend in CrashLoopBackOff. Das ist tolerierbar (der Pod
   heilt sich selbst, sobald die Services existieren) — aber die **Services müssen
   angelegt sein**, die Pods dahinter nicht.
2. **Kein *headless* Service für `api`/`keycloak`.** Bei einer normalen ClusterIP
   ist die gecachte Adresse über Rollouts hinweg stabil. Mit `clusterIP: None`
   (DNS → Pod-IPs) würde das Frontend nach dem ersten api-Rollout dauerhaft 502
   liefern. (Dieselbe Mechanik ist in Compose ein latentes Risiko, wenn nur `api`
   neu erstellt wird; dort hilft, das Frontend mit neu zu starten.)

**Shutdown:** Kubernetes sendet immer SIGTERM und ignoriert `STOPSIGNAL` aus dem
Image — für nginx ist SIGTERM ein *fast shutdown*, laufende Requests werden
abgeschnitten. Das Draining übernimmt deshalb der `preStop`-Sleep:

```yaml
lifecycle: { preStop: { exec: { command: ["sleep", "5"] } } }
terminationGracePeriodSeconds: 30
```

---

## Rolling-Update-Regeln

Für alle zustandslosen Deployments (`api`, `frontend`, `flowc`, `writer`):

```yaml
strategy:
  rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
```

plus `PodDisruptionBudget: minAvailable: 1`, `readinessProbe`, `preStop`-Sleep.
Die Collector-Singletons (`market-data`, `forecast`, `weather-collector`,
`optimization`, `simulation`, `ingest`) laufen mit `strategy: Recreate` —
zwei parallel laufende Instanzen wären dort schädlich (doppelter MQTT-Konsum,
doppelte Pläne) und eine Lücke von Sekunden ist folgenlos.

### Flyway Expand-Contract (Projektregel)

Während eines Rollouts laufen `api`-Pods der Version N−1 gegen das von Version N
migrierte Schema. **Jede Migration muss mit dem VORHERIGEN Release-Code
koexistieren.**

**Do:**
* Spalten nur additiv: nullable oder mit DEFAULT; neue Tabellen/Indexe frei.
* Umbenennen/Umtypen zweistufig: Release N legt die neue Spalte an und schreibt
  BEIDE (Code liest bevorzugt neu), Release N+1 entfernt Alt-Spalte + Dual-Write.
* `DROP COLUMN/TABLE` erst, wenn kein deployter Code sie mehr referenziert
  (frühestens Release N+1).
* `NOT NULL` nachziehen erst nach abgeschlossenem Backfill und nachdem das
  Vorrelease nicht mehr deployt ist.
* Große Backfills nicht in der Migration: Migration legt Struktur an, Backfill
  läuft gebatcht als Job/Runbook.
* Keine langen Locks im Deploy-Pfad (kein `ALTER TYPE`/Rewrite auf große
  Hypertables). Timescale-Policies (`add_*_policy`) sind additiv und unkritisch.

**Don't:**
* Kein RENAME von Spalten/Tabellen, die der Vorrelease-Code liest.
* Kein DROP / keine Constraint-Verschärfung im selben Release wie die
  Code-Änderung, die es „erlaubt".
* Keine Migration, die Daten umzieht UND die Quelle löscht, in einem Schritt.
* (Bestand:) Nie eine applied Migration editieren; Dev-Seeds existence-guarden.

Flyway läuft weiterhin beim api-Start (die Self-Healing-Strategy bleibt);
optional später als Argo-PreSync-Job, sobald Migrationen > 30 s auftreten.

### Was bei einem Rollout mit Keycloak / EMQX / MQTT passiert

* **Keycloak (1 Replica):** 60–90 s keine NEUEN Logins/Refreshes. Bestehende
  Access-Tokens (15 min) validiert der api lokal über den JWKS-Cache weiter —
  eingeloggte Nutzer merken nichts.
* **EMQX-Update:** alle Geräte fallen und reconnecten mit 5–60 s Backoff. **Kein
  Datenverlust** (Edge-Buffer 48 h + QoS1 + idempotenter Writer); Retained
  Messages liegen im PV. EMQX-Updates bewusst terminieren, nicht automatisch
  mitrollen.
* **Portal:** reines REST-Polling (kein WebSocket) — api-Rollouts sind mit
  Readiness + Drain unsichtbar; ein fehlgeschlagener 30-s-Poll heilt beim nächsten.
* **api-MQTT-Listener:** beim Rolling überlappen alte + neue Replica kurz →
  doppelte, idempotente Upserts. Harmlos.

---

## Tests, die diesen Vertrag halten

| Zusage | Beweis |
|---|---|
| JVM: graceful shutdown + Probe-Gruppen konfiguriert | `K8sReadinessConfigTest` (api, ingest, writer) |
| JVM: `/health/liveness` + `/health/readiness` existieren wirklich (200 UP) | `services/ingest/.../ProbeEndpointsTest` — bootet die echte App (der einzige JVM-Dienst ohne Datasource, also containerlos); alle drei tragen denselben Actuator-Block |
| Python: SIGTERM stoppt die Schleife | `test_runtime.py` + `test_serve_loop.py` (optimization, forecast) |
| Python: Backoff statt voller Kadenz | `test_runtime.py`, `test_serve_loop.py` |
| Python: `/health` bleibt 200, `/ready` gated | `test_runtime.py` |
| Python: die drei `runtime.py` driften nicht | `services/optimization/tests/test_runtime.py` |
| market-data: Kadenz-Logik unverändert | `services/market-data/tests/test_refresh.py` |
| flowc: SIGTERM beendet den echten Entrypoint | `edge-app/nodered/flowc/shutdown.test.js` |
| api: `/metrics` ist anonym erreichbar und hat sonst nichts geöffnet | `MetricsEndpointSecurityTest` (echte Filterkette, echte `application.yml`) |
| Metrik-Namen/Labels sind der Vertrag mit den Alarm-Regeln | `FleetMetricsScrapeTest` — liest den ECHTEN Scrape-Rumpf zurück, nicht die Meter-Namen im Code |
| „nie gehabt" ≠ „veraltet", und die 7-Tage-Grenze | `FleetMetricsTest` (rein) + `FleetMetricsDbTest` (echte TimescaleDB) |
| Ein Sammel-Lauf bleibt weit unter dem Takt | `FleetMetricsDbTest.aCollectRunCostsLittleEnoughToRunEveryMinute` |
