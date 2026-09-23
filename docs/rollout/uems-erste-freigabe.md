# Rollout-Drehbuch: die erste UEMS-Produktfreigabe

**Wer das hier fährt:** der Betreiber, allein, an seinem Cluster. Kein Werkzeug dieses
Repositorys führt einen dieser Befehle aus, keine Crew hat Produktionszugang. Die Befehle
unten sind **geschrieben und gegengelesen**, nicht gelaufen — was sich auf einer
Entwicklungsmaschine nicht gegenlesen lässt, ist als
**⧉ vom Betreiber beim ersten Lauf zu bestätigen** gekennzeichnet.

**Was das hier ist:** der wörtliche Ablauf zu §5.3 des entschiedenen Konzepts
„Erste Produktfreigabe" (AP-14, Entscheid vom 18.09.2026: **E1 = B** kein Freigabe-Tor,
**E2 = A** Wartungsfenster mit Wiederherstellungspunkt). Das Konzept nennt Reihenfolge,
Beleg und Abbruch; hier steht die Syntax.

**Was das hier nicht ist:** kein Ersatz für die Generalprobe (`tools/generalprobe/README.md`)
und kein Go. Jede Zahl, die dieses Drehbuch braucht — Fensterlänge, Migrationsdauern,
Vergleichszählungen — kommt aus einem echten Lauf der Generalprobe an einer
wiederhergestellten Kopie, nicht aus diesem Text.

---

## 1. Was gegenüber dem Konzept §5.3 geändert ist — und warum

Die Untersuchung **„W1: alte API repariert die neue Flyway-Historie" (19.09.2026)** hat
belegt, dass die Annahme des Konzepts zu Kasten W1 falsch war. Das Konzept ging davon aus,
die heute ausgelieferte api **breche** am neuen Schema. Sie bricht nicht:

> Die alte api startet gegen das vollständig migrierte Schema, meldet nach ~4,8 s
> Bereitschaft, und ihre eigene `SelfHealingFlywayMigrationStrategy` schreibt dabei
> **18 Zeilen mit `type='DELETE'`** in `flyway_schema_history` (235 → 253 Zeilen; keine
> bestehende Zeile wird geändert oder entfernt). Danach **startet die neue api nicht mehr**:
> sie sieht dieselben 18 Versionen als `PENDING`, migriert erneut und bricht mit
> `42P07 relation "netzanschluss_vorschlag_entscheidung" already exists` und Exit-Code 1 ab.

Ein einziger alter Fehlstart nach der Migration legt also den neuen Betrieb lahm. Daraus
folgen fünf Änderungen an §5.3. Sie sind hier eingearbeitet und im Ablauf jeweils mit
**⟲ geändert gegenüber §5.3** markiert.

| # | Änderung | Grund |
|---|---|---|
| **a** | **Erzwungener Nullstand vor der Migration.** Aus zwei gitops-Commits werden **drei**: ein vorbereitender Commit setzt das NEUE api-Image **zusammen mit** api-Replikas 0 und Writer-Replikas 0. Erst wenn Nullbestand belegt ist, folgt der Wiederherstellungspunkt; erst dann der Commit, der nur die Replika-Zahl der api auf 1 hebt. | Untersuchung §5 Option a. Ein Commit, der nur den alten Replikawert wieder öffnet, lässt einen alten Pod starten. Zeigt der Sollzustand schon auf das neue Image, **kann** kein alter Pod mehr starten. „Image plus 0 in einem Commit" ersetzt nicht das **Abwarten** auf null Prozesse. |
| **b** | **Neuer Prüfpunkt Z08 „Historie unverändert"** nach der Migration **und noch einmal** unmittelbar vor dem Öffnen des Portals. | Untersuchung §5, „Konkreter neuer Prüfpunkt". Das bestehende Z01 zählt jede Zeile mit `success` — auch die 18 erfolgreichen DELETE-Marker. `angewandt=253, fehlgeschlagen=0` sähe **gesund aus**, obwohl die Historie beschädigt ist. |
| **c** | **Rückweg R mit harter Reihenfolge**: api und Writer auf null und **belegt** null → Wiederherstellung auf den Punkt → Gegenprobe → **erst dann** alte Images. Ein gewöhnlicher Image-Revert ist ausdrücklich **kein** Rückweg. | Untersuchung §4, Zeile R: werden alte Images **vor** der Wiederherstellung aktiv, tritt der Befund erneut auf — und die DB, auf die sie dann treffen, ist die migrierte. |
| **d** | **Eigener Kasten „Es ist doch passiert"** (§8): alte api lief nach der Migration auch nur kurz → nicht das neue Image wieder ausrollen, sondern anhalten, Befund sichern, physischer Rückweg auf den Punkt. | Untersuchung §5, letzter Absatz: der Wechsel zurück zum neuen Image repariert nichts — die neue api startet auf der beschädigten Historie gar nicht erst. |
| **e** | **Abschnitt „Offen beim Betreiber"** (§9) mit der Entscheidung über den Start-Wächter auf `main` samt Vorab-Deploy. Das Drehbuch ist **mit und ohne** ihn fahrbar. | Untersuchung §5 Optionen c/d. Der Wächter beseitigt den stillen Selbstheilungspfad beim **versehentlichen** Neustart; einen bereits laufenden alten Prozess stoppt er nicht — Änderung **a** bleibt in jedem Fall nötig. |

**Was unverändert gilt:** E2 = A und die fachlichen Brüche. Der Befund macht das
Wartungsfenster nicht überflüssig, sondern **strenger**. Die Korrektur an W1/M-3 lautet:
nachzuweisen ist künftig „die alte api darf diesen Schemastand weder bedienen noch die
Historie umschreiben" — nicht „die alte api muss beim Start brechen".

---

## 2. Bevor der Tag beginnt

### 2.1 Voraussetzungen (alle vor G1)

| Voraussetzung | Beleg | Quelle |
|---|---|---|
| Rollout-Satz eingefroren (G0) | ein Commit-SHA auf `uems`; er ist der Wert von `${UEMS_SHA}` in allen Diffs unten | Konzept D9 = F7 |
| Generalprobe gelaufen, `probe.json` gelesen | Exit 0; `startbudget_reicht=1`; Rubrik A trägt Summe und `je_migration_ms` | `tools/generalprobe/README.md` |
| Rückweg-Übung gelaufen (NW-8) | `rueckweg.json`, `wiederherstellung_ms` bekannt; Flyway-Stand und Q01 bytegleich | `rueckweg.sh` |
| WAL-Archiv läuft, Basis-Backup < 24 h | `bash tools/backup/vp-db-backup-check.sh` | Q15, Konzept E2 |
| Bus-Aufbewahrung ≥ Fenster + Rückweg + Reserve, als Zahl notiert | Betreiber-Notiz | Regel D5 |
| **PR 37 (gitops, IP-10) gemergt und ausgerollt — mindestens einen Tag vorher** | ein Sync, ein api-Neustart auf dem **alten** Schema, beobachtet | siehe 2.2 |
| Die zwei Platzhalter aus PR 37 gesetzt | siehe 2.3 | |
| Kundennachricht 48 h vorher raus | §10 | Schritt 1 |
| Support-Weg einmal gegangen (F6) | §11 | Schritt 1 |
| Box-Release zurückgehalten bis nach Schritt 10 | kein Box-Update mit dem neuen Laufzeitstand vor dem api-Deploy | §2.8, PR 1143 |

### 2.2 PR 37 gehört **vor** das Fenster, nicht hinein

`apps/voltpilot/overlays/prod/uems-betrieb.md` sagt es selbst: die ConfigMap mit den
ausdrücklichen Schaltern (seit Commit `5ad2f32` alle 24, §12) bekommt einen neuen Hash,
**„api wird neu gestartet, auch bei unverändertem Image"**, und die nginx-ConfigMap löst
zusätzlich einen Frontend-Rollout aus.

Dieser Neustart ist harmlos, **solange er auf dem alten Schema stattfindet**: die alte api
kennt die neuen `VOLTPILOT_UEMS_*`-Schlüssel nicht und ignoriert sie. Im Fenster wäre
derselbe Neustart genau der Fehlstart, den Änderung **a** verhindern soll.

> **Regel:** PR 37 wird mindestens einen Tag vor dem Fenster gemergt und sein Sync
> vollständig beobachtet. **Danach geht bis Schritt 2 kein weiterer Commit nach
> `apps/voltpilot/` oder `clusters/prod/`.**

### 2.3 Die zwei Platzhalter aus PR 37

Beide stehen in `apps/voltpilot/overlays/prod/prometheusrule.yaml` und sind als
`CHANGE-ME` markiert. Sie sind **vor G1** zu setzen, sonst alarmiert die Überwachung am
Rollout-Tag falsch oder gar nicht.

1. **`voltpilot:uems_datenbank_warnschwelle_bytes`** — vorbelegt mit 100 GiB, „keine
   behauptete Kapazität". Die Metrik ist die **Summe der Hypertables**, nicht die ganze
   Datenbank, nicht WAL, nicht freier Plattenplatz. Wert aus **Q14** (Datenbankgröße,
   Vorher-Blatt) **und** der tatsächlich nutzbaren Platte bilden; anschließend den
   Grenztest in `hack/alert-tests/uems_test.yaml` nachziehen.
2. **`voltpilot:uems_dauerlaeufer`**, Label `tenant: CHANGE-ME-dauerlaeufer-tenant` — die
   interne UUID des Dauerläufer-Kundenbereichs (IP-18). Erst sie macht
   `VoltPilotDauerlaeuferStumm` scharf. Woher die UUID kommt und wohin sie noch gehört:
   §14.

### 2.4 Die Fensterlänge (Regel D4)

> **Fenster = Summe der gemessenen Migrationsdauern × 3, mindestens 30 Minuten.**

Die Summe kommt aus Rubrik **A** von `probe.json`: `je_migration_ms` in
Ausführungsreihenfolge plus Summe. `tools/generalprobe/README.md` nennt dieselbe Regel
maschinell: „D4: Fenster = Summe × 3, mindestens 1 800 000 ms".

> ⚠ **Die Zahl muss aus der echten Generalprobe an der Kopie kommen.** Der synthetische
> Nachweis (`test-fixture.sh`) fährt einen Wegwerf-Bestand mit einem einzigen
> Kundenbereich; eine Summe in der Größenordnung von Sekundenbruchteilen ist dort normal
> und für die Fensterplanung **wertlos**. Nur die Kopie trägt die echte Datenmenge, an der
> die Migrationen ihre Zeit verbringen.

**Was die Generalprobe vom 23.09.2026 dazu gemessen hat** (Bericht Teil 1, synthetischer
Bestand, siehe §2.7): Flyway 24,1 s bei 2,8 Mio. Samples, hochgerechnet ≈ 41 s bei 6 Mio.
Summe × 3 = **72–123 s**. Es gilt also das **Minimum von 30 Minuten**; erst ab rund zehn
Minuten Flyway-Summe an der Kopie wird das Fenster länger. Eine kleine Summe in `probe.json`
verkürzt das Fenster nie unter 30 Minuten.

Das Fenster liegt dort, wo **Q13** keinen Handeingriff auslaufen sieht und die wenigsten
Kunden am Portal sind.

### 2.5 Das Startbudget von 180 s

`docs/k8s-readiness.md` nennt drei Minuten `startupProbe`-Budget als dokumentierte
Ausgangskonfiguration; `uems-betrieb.md` bestätigt: „Das Startbudget bleibt 3 Minuten;
IP-11 muss belegen, ob es für die echten Migrationen genügt."

Dieser Beleg ist `probe.json`: **`startbudget_reicht`**. Steht dort `0`, bricht
`probe.sh` mit **Exit 24** ab („Deployment-Startbudget 180 s reicht nicht") — und dann ist
der Rollout-Tag **nicht** vorbereitet: entweder das Budget wird in gitops gehoben (eigener
Commit, eigener Sync, vor dem Fenster) oder die lange Migration wird zerlegt. Das Fenster
darf nicht mit einer api beginnen, die das Kubelet mitten in Flyway abschießt.

**Gemessen in der Generalprobe vom 23.09.2026** (Bericht Teil 1, Hochrechnung): api bereit nach
**54 s** bei 2,8 Mio. Samples, ≈ **71 s** bei 6 Mio. Der feste Anteil (JVM, Spring, übrige
Migrationen) liegt bei ≈ 39 s, je Sample-Zeile kommen ≈ **5,3 µs** dazu. Ein Start reicht damit
bis etwa **26,7 Mio. Zeilen ≈ 9,3 GB** `hypertable_size('device_measurement_sample')` (§2.7,
Abfrage dort). Darüber setzt `V20260922236500` beim nächsten Start je Chunk fort;
`V20260916180000` dagegen muss in einen Start passen (§2.7). Gemessen wurde auf einem
Entwicklungsrechner, nicht auf der Produktionshardware.

⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** ob der gemessene `start_ms` der Kopie
auf der Produktionshardware zutrifft. Die Kopie ist eine andere Maschine.

### 2.6 Die Variablen dieses Drehbuchs

```sh
export UEMS_SHA=…                 # der eingefrorene Rollout-Satz (G0), Commit-SHA auf `uems`
export ALT_SHA=4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3   # der heute ausgerollte Stand
export NS=voltpilot-prod          # Namespace (apps/voltpilot/overlays/prod/namespace.yaml)
export APP=voltpilot-prod         # Argo-CD-Application (clusters/prod/apps/voltpilot.yaml)
export GITOPS=…                   # lokaler Klon von mamotec/gitops, Zweig main
export PUNKT=…                    # Name des Wiederherstellungspunkts, in Schritt 5 vergeben
```

⧉ `ALT_SHA` ist der Wert, der am Tag **tatsächlich** im `images:`-Block steht — vor dem
Fenster ablesen, nicht aus diesem Dokument übernehmen.

### 2.7 Die Fenster-Migrationen auf `device_measurement_sample`

Drei Migrationen des Rollout-Satzes ändern die größte Tabelle selbst; zwei davon kosten Zeit je
Zeile. Gemessen hat sie die Generalprobe vom 23.09.2026
(Bericht `/Users/mvogt/…/vp-uems-rollout-generalprobe/report.md`, Teil 1): das gebaute uems-api-Image
migriert beim Start wie am Rollout-Tag einen main-Stand mit **2 800 000 Samples** (14 Tages-Chunks à
200 000 Zeilen, 979 MB, synthetisch), parallel dazu 10 INSERT/s in den heutigen Chunk. Alle 108
neuen Migrationen zusammen: **24,1 s**; die übrigen 102 davon 9,4 s, keine länger als 793 ms.

| Migration | gemessen (2,8 Mio.) | hochgerechnet (6 Mio.) | Transaktion | Sperrverhalten |
|---|---|---|---|---|
| `V20260913150000` Löschwege (zwei Fremdschlüssel `NOT VALID`) | 332 ms | – | eine | prüft den Bestand nicht (`NOT VALID`), darum kurz |
| `V20260916180000` Ablesungen (CHECK, Fremdschlüssel, `uq_device_measurement_sample_ablesung`) | **7 470 ms** (2,67 µs je Zeile) | ≈ 16,0 s | **eine** | **sperrt den Schreiber für ihre ganze Dauer**: der parallele INSERT wartete 7 426 ms, bis zum `COMMIT` |
| `V20260922236500` Box-Schlüssel bauen | **7 280 ms** (2,60 µs je Zeile) | ≈ 15,6 s | je Chunk eine | sperrarm: 0 wartende Sperren, längster INSERT 139 ms |

`V20260912140000` und `V20260912170000` gehören **nicht** in diese Liste: beide sind seit #691 auf
`main` und in Produktion längst gelaufen.

**Die verbindliche Zahl kommt trotzdem aus der Kopie** (`tools/generalprobe/probe.sh`, §2.4):
der synthetische Satz hat keine Auswahlzeilen mit `entity_id` und keine `measurement_point`-Daten
(Bericht Teil 1, „Grenze der Messung“). Die Tabelle oben sagt, **welche** `je_migration_ms` in
`probe.json` man zuerst ansieht und welche Größenordnung zu erwarten ist.

#### `V20260922236500`: der Index-Umbau

Die Migration baut zwei neue UNIQUE-Indexe auf der größten Tabelle und entfernt danach den alten.
`device_measurement_sample` ist eine Hypertable, deshalb gibt es kein `CONCURRENTLY`. Die
Migration läuft ohne Flyway-Transaktion und arbeitet **je Chunk in einer eigenen Transaktion**.
Während des Baus ist nur der Chunk gesperrt, der gerade gebaut wird. Im Fenster steht der Writer
ohnehin (Schritt 3); der Umbau zählt trotzdem voll gegen die Fensterlänge (§2.4) und das
Startbudget (§2.5). Beendet das Kubelet die api mitten im Bau, macht der nächste Start beim
nächsten offenen Chunk weiter. Bricht die Migration mit einer Meldung ab (zwölfmal 5 s auf eine
Sperre gewartet), repariert die Selbstheilung beim nächsten Start die Historie, und der Umbau
setzt fort. Vorher mit `pg_blocking_pids` (unten) den Sperrenden suchen.

**Vorher messen, an der Kopie und lesend an Produktion.** `pg_total_relation_size` zeigt bei
einer Hypertable nur die leere Wurzel:

```sql
SELECT pg_size_pretty(hypertable_size('device_measurement_sample')) AS gesamt;
SELECT count(*) AS chunks, pg_size_pretty(max(total_bytes)) AS groesster_chunk
  FROM chunks_detailed_size('device_measurement_sample');
```

Die Dauer ist `je_migration_ms` von `20260922236500` in `probe.json` (Rubrik A). Der größte Chunk
bestimmt die längste Einzelsperre, und ein Chunk muss in einen Start passen (180 s).

#### `V20260916180000` und `V20260913150000`: eine Transaktion

Beide arbeiten in **einer** Transaktion; `V20260916180000` liest dabei jeden Chunk. Im Fenster
sperrt sie niemanden, weil der Writer steht (Schritt 3). Ein Abbruch durch das Kubelet rollt sie
aber ganz zurück, und der nächste Start beginnt von vorn. Anders als der Index-Umbau muss sie
deshalb **in einen Start passen**: nach der Hochrechnung des Berichts allein bis etwa 53 Mio.
Zeilen. Ist ihr `je_migration_ms` in `probe.json` länger als das Startbudget, wird das Budget
vor dem Fenster gehoben (§2.5).

**Während des Laufs beobachten** (zweite Sitzung):

```sql
-- Fortschritt: Chunks mit beiden neuen Schlüsseln / alle Chunks
SELECT count(*) FILTER (WHERE n = 2) AS fertig, count(*) AS chunks FROM (
  SELECT c.id, count(ci.index_name) AS n FROM _timescaledb_catalog.chunk c
    JOIN _timescaledb_catalog.hypertable h ON h.id = c.hypertable_id
     AND h.table_name = 'device_measurement_sample'
    LEFT JOIN _timescaledb_catalog.chunk_index ci ON ci.chunk_id = c.id
     AND ci.hypertable_index_name IN ('uq_device_measurement_sample_box',
                                      'uq_device_measurement_sample_box_komponente')
   WHERE NOT c.dropped GROUP BY c.id) x;
-- der Chunk im Bau
SELECT relid::regclass, phase, blocks_done, blocks_total FROM pg_stat_progress_create_index;
-- wer auf wen wartet
SELECT pid, pg_blocking_pids(pid), wait_event_type, left(query, 80) FROM pg_stat_activity
 WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

**Fertig**, wenn `fertig = chunks` und dieser Zähler `0` zeigt:
`SELECT count(*) FROM pg_class WHERE relname LIKE '%uq_device_measurement_sample_idempotency%';`

### 2.8 Box-Release erst nach dem api-Deploy

Der Laufzeitstand der Box (Palette `catalog.json`) und der Katalogstand der api sind gekoppelt.
Der Planer der Box verlangt exakte Gleichheit (`measurement-planner.js`, `buildPlan`); eine
Mess-Konfiguration in einem anderen Stand lehnt die Box mit `unsupported_catalog` ab. Das gilt in
beide Richtungen:

- **Box mit alter Palette, neue api:** jede neue oder geänderte Mess-Konfiguration wird abgelehnt.
  Der bisher angewandte Plan läuft an der Box weiter, aber die api setzt die Auswahl auf
  `rejected`, und der Writer verwirft deren Samples (Bericht Teil 4). Unverändert bestätigte
  Boxen bekommen durch den Deploy allein nichts Neues geschickt.
- **Box mit neuer Palette:** nach dem Neustart spielt der Core die gespeicherte Konfiguration
  alten Stands wieder ein, die neue Palette lehnt sie ab, und die Box misst nicht (Befund B2 der
  Generalprobe).

**Nachlieferung durch die api (PR 1143):** der Reconciler erkennt eine Box, deren letzte
Revision mit `unsupported_catalog` abgelehnt wurde und einen anderen Stand trägt als die api, und
liefert **einmal** Revision + 1 im heutigen Stand nach (Akteur `system:katalogstand`, keine
Auswahlzeile ändert sich). Lehnt die Box auch den heutigen Stand ab, folgt nichts mehr. Regel und
Grenzen: `docs/agents/root/uems-messplan-nach-box-update.md`.

> **Regel:** Das Box-Release geht **nach** dem api-Deploy (nach Schritt 10) an die Boxen. Nur die
> neue api kann nachliefern. Eine Box, die ihr Update vorher bekommt, misst bis zum api-Deploy
> nicht; die neue api liefert beim Start nach. Tor GA, Punkt `NW-3u`, verlangt dafür den grünen
> Bericht von `MessplanNachBoxUpdateApiTest`.

---

## 3. Die Sync-Klammer: Auto-Sync für die Dauer des Fensters anhalten

**Warum überhaupt:** `clusters/prod/apps/voltpilot.yaml` steht seit dem 15.09.2026 auf
Auto-Sync (`automated`, `prune: false`, `selfHeal: false`). Ein gemergter Commit rollt
also **selbsttätig** aus. Für dieses Fenster soll jeder einzelne Sync eine Handlung sein.

**Der Befund, der dabei zu beachten ist:** ein bloßes
`argocd app set voltpilot-prod --sync-policy none` ist **keine belegbare Sperre**. Die
Root-Application (`clusters/prod/root-app.yaml`) läuft mit `prune: true` **und
`selfHeal: true`** und verwaltet die Kind-Application aus git — sie dreht eine nur live
abgeschaltete Sync-Policy binnen Sekunden zurück. Der einzige saubere Weg im vorliegenden
gitops-Repo ist deshalb **ein Commit**.

**Klammer zu (F1)** — vor Schritt 2:

```diff
--- a/clusters/prod/apps/voltpilot.yaml
+++ b/clusters/prod/apps/voltpilot.yaml
@@
   syncPolicy:
-    automated:
-      prune: false    # Stufe 2 (später): true = löscht aus git entfernte Ressourcen
-      selfHeal: false  # Stufe 3 (später): true = dreht manuelle kubectl-Eingriffe zurück
+    # UEMS-Wartungsfenster am TT.MM.JJJJ: Auto-Sync ausgesetzt, damit jeder Sync
+    # dieses Fensters eine Handlung ist (docs/rollout/uems-erste-freigabe.md §3).
+    # Nach Schritt 10 oder nach R mit F2 wiederherstellen.
     syncOptions:
       - CreateNamespace=false
```

```sh
git -C "$GITOPS" commit -am 'UEMS-Fenster: Auto-Sync aussetzen (F1)' && git -C "$GITOPS" push
# Belegen, dass die Root-App die Änderung übernommen hat:
argocd app get "$APP" -o json | jq '.spec.syncPolicy'      # erwartet: kein "automated"-Schlüssel
```

Ab hier synct **jeder** Commit erst auf ausdrückliches `argocd app sync "$APP"`.

**Klammer auf (F2)** — nach Schritt 10 (oder nach abgeschlossenem Rückweg): denselben
Diff zurücknehmen, pushen, `argocd app sync "$APP"`, `argocd app get "$APP"` zeigt
`automated` wieder.

⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** dass die Root-App den Kind-Zustand
innerhalb ihres Sync-Intervalls übernimmt, bevor Schritt 2 beginnt.

---

## 4. Die drei gitops-Commits, als Diff gegen den Stand von PR 37

Alle drei liegen im Zweig `fm/vp-uems-b14-ip10-gitops` (PR 37) bzw. auf `main`, nachdem
PR 37 gemergt ist. Die Datei- und Feldnamen sind an diesem Zweig gegengelesen.

### C1 — vorbereitend: neues api-Image **und** Nullstand ⟲ geändert gegenüber §5.3

Zwei Teile in **einem** Commit.

**(1) Neue Datei `apps/voltpilot/overlays/prod/patches/rollout-fenster-null.yaml`:**

```yaml
# UEMS-Wartungsfenster: api und timescale-writer auf null Replikas.
# Der Nullstand ist die Bedingung dafuer, dass die Migration laufen darf
# (docs/rollout/uems-erste-freigabe.md §5, Schritt 2-4). Er wird mit C2 fuer
# die api und mit C3 fuer den Writer wieder aufgehoben.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 0
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: timescale-writer
spec:
  replicas: 0
```

**(2) `apps/voltpilot/overlays/prod/kustomization.yaml`:**

```diff
@@ patches:
   - path: patches/external-endpoints.yaml
   - path: patches/storage-class-nfs.yaml
+  # UEMS-Wartungsfenster: api + Writer auf null. Mit C2/C3 wieder heraus.
+  - path: patches/rollout-fenster-null.yaml
@@ images:
   - name: git.tecmaxx.de/mamotec/voltpilot-ems/api
-    newTag: 4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3
+    newTag: ${UEMS_SHA}
```

**Nur die api wechselt hier das Image.** `frontend`, `ingest`, `timescale-writer`,
`keycloak`, `market-data`, `forecast`, `optimization` und `flowc` bleiben auf `ALT_SHA`;
sie kommen mit C3 nach, damit die Flotte danach wieder auf **einem** Tag steht — die
ausdrückliche Invariante des `images:`-Blocks.

> **Warum das Image schon hier wechselt:** setzt der Sollzustand gleichzeitig das neue
> Image und 0 Replikas, kann ein alter Pod danach **überhaupt nicht mehr** starten — nicht
> nach Absturz, nicht nach Container-Neustart, nicht nach Node-Drain. Ein Commit, der nur
> `replicas: 1` wieder öffnet, während das Image noch das alte ist, könnte das.

> ⚠ **Nebenwirkung, die nichts kostet:** der `replacements:`-Block schreibt den api-Tag in
> `VOLTPILOT_BUILD` der ConfigMap `voltpilot-api`; ihr Hash ändert sich mit C1. Ohne Pod
> gibt es nichts neu zu starten — genau deshalb steht der Imagewechsel **vor** dem Hochfahren.

### C2 — nur die api auf 1

```diff
--- a/apps/voltpilot/overlays/prod/patches/rollout-fenster-null.yaml
+++ b/apps/voltpilot/overlays/prod/patches/rollout-fenster-null.yaml
@@
 metadata:
   name: api
 spec:
-  replicas: 0
+  replicas: 1
```

Der Writer-Teil der Datei bleibt auf 0. Die api zeigt bereits auf `${UEMS_SHA}`;
dieser Commit ändert **kein** Image.

### C3 — der Rest der Flotte

```diff
--- a/apps/voltpilot/overlays/prod/kustomization.yaml
+++ b/apps/voltpilot/overlays/prod/kustomization.yaml
@@ patches:
-  # UEMS-Wartungsfenster: api + Writer auf null. Mit C2/C3 wieder heraus.
-  - path: patches/rollout-fenster-null.yaml
@@ images:
   - name: git.tecmaxx.de/mamotec/voltpilot-ems/frontend
-    newTag: 4aa1e7fb39b25388f71f20d1d0fc2470a940e4a3
+    newTag: ${UEMS_SHA}
   … dieselbe Zeile fuer keycloak, ingest, timescale-writer, market-data,
     forecast, optimization, flowc …
```

Und die Datei `patches/rollout-fenster-null.yaml` wird mit demselben Commit gelöscht.

> **Sync-Wellen ordnen, sie halten nichts an.** `api` trägt
> `argocd.argoproj.io/sync-wave: "0"`, `timescale-writer`, `ingest` und `frontend` tragen
> `"1"`. Argo wartet auf die Gesundheit der aktualisierten Welle 0, **bevor** Welle 1
> deployt wird — aber **alte** Pods der Welle 1 stoppt das nicht. Genau dafür gibt es den
> Replika-Patch aus C1. (`uems-betrieb.md`: „Wellen stoppen keine alten
> Writer/ingest/Frontend-Pods.")

---

## 5. Das Drehbuch

Jede Zeile nennt den Befehl, den **Beleg** und den Abbruch. **„Abbruch → R"** heißt immer:
sofort zu §7, nichts anderes.

### Schritt 1 — Kundennachricht 48 h vorher, Support-Weg geprobt

Kein technischer Schritt. Wortlaut: §10. Checkliste F6: §11.

**Beleg:** Nachricht raus (Zeitstempel notiert), F6-Checkliste abgehakt.
**Abbruch:** ist die Nachricht nicht raus, wird das Fenster verschoben — nicht verkürzt.

### Schritt 2 — Sync-Klammer zu, C1 vorbereitet und gesynct ⟲ geändert gegenüber §5.3

```sh
# (a) Klammer zu, siehe §3
# (b) C1 pushen
git -C "$GITOPS" push
# (c) ein ausdruecklicher Sync, kein selbsttaetiger
argocd app sync "$APP" --prune=false
argocd app wait "$APP" --health --timeout 600
```

**Beleg:**

```sh
# Der gerenderte Sollzustand zeigt neues Image UND 0 Replikas:
kubectl -n "$NS" get deploy api -o jsonpath='{.spec.replicas}{"  "}{.spec.template.spec.containers[0].image}{"\n"}'
# erwartet:  0  git.tecmaxx.de/mamotec/voltpilot-ems/api:<UEMS_SHA>
kubectl -n "$NS" get deploy timescale-writer -o jsonpath='{.spec.replicas}{"\n"}'
# erwartet:  0
```

**Abbruch → R** (bzw. hier noch: Fenster abbrechen, nichts ist migriert), wenn das
Image nicht `${UEMS_SHA}` ist oder eine der beiden Replika-Zahlen nicht 0.

### Schritt 3 — Writer steht, belegt

Der Replika-Patch aus C1 hat den Writer bereits auf 0 gesetzt; hier wird **abgewartet und
belegt**. Der Ereignis-Bus puffert, `ingest` läuft weiter, der Rückstand wächst sichtbar —
das ist gewollt.

```sh
kubectl -n "$NS" rollout status deploy/timescale-writer --timeout=180s
kubectl -n "$NS" get pods -l app.kubernetes.io/name=timescale-writer -o name    # erwartet: leer
kubectl -n "$NS" get rs -l app.kubernetes.io/name=timescale-writer \
  -o custom-columns=NAME:.metadata.name,DESIRED:.spec.replicas,CURRENT:.status.replicas
# erwartet: jede Zeile DESIRED=0 CURRENT=0
```

> `terminationGracePeriodSeconds: 45` — ein Pod darf bis zu 45 s brauchen, bevor er
> wirklich weg ist. Die leere Pod-Liste ist der Beleg, nicht der abgesetzte Skalierbefehl.

**Beleg:** leere Pod-Liste, alle ReplicaSets auf 0.
**Abbruch → R**, wenn nach 180 s noch ein Writer-Pod steht.

### Schritt 4 — Alte api steht, belegt; Portal zeigt die Wartungsseite ⟲ geändert gegenüber §5.3

Das Konzept sagte „alte api auf null". Die Untersuchung verlangt den **überprüfbaren
Haltepunkt**: „Alle alten Pods beendet, alte ReplicaSets auf 0, keine alten api-DB-Sitzungen;
Neustart über alten Sollstand ausgeschlossen." Alle vier Belege:

```sh
# (1) kein api-Pod mehr
kubectl -n "$NS" rollout status deploy/api --timeout=180s
kubectl -n "$NS" get pods -l app.kubernetes.io/name=api -o name                 # erwartet: leer

# (2) alle alten ReplicaSets der api auf 0
kubectl -n "$NS" get rs -l app.kubernetes.io/name=api \
  -o custom-columns=NAME:.metadata.name,DESIRED:.spec.replicas,CURRENT:.status.replicas,IMAGE:.spec.template.spec.containers[0].image
# erwartet: jede Zeile DESIRED=0 CURRENT=0

# (3) keine offene DB-Sitzung der alten api mehr (Laufzeitrolle voltpilot_app)
psql "$VP_DB_URL" -Atc "SELECT count(*) FROM pg_stat_activity
                         WHERE usename = 'voltpilot_app' AND pid <> pg_backend_pid();"
# erwartet: 0

# (4) der Sollstand kann keinen alten Pod mehr erzeugen
kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
# erwartet: …/api:<UEMS_SHA>  -- NICHT <ALT_SHA>
```

Portal auf die Wartungsseite stellen (Weg des Betreibers am äußeren Proxy). Planer,
Prognose und Marktdaten laufen weiter — sie haben in diesem Release keinen Diff, und jede
Box hält 24 h Fahrplan.

**Beleg:** (1)–(4) wie angegeben.
**Weiterer Beleg:** die Bestands-Alarme `…OhneAktuellenFahrplan` bleiben stumm.
**Abbruch → R**, wenn (3) nicht 0 wird. Eine Sitzung, die nicht verschwindet, ist ein
laufender alter Prozess — die Wartungsseite sperrt MQTT- und Hintergrundarbeit **nicht**.

> ⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** ob andere Dienste ebenfalls als
> `voltpilot_app` verbinden. Ist das so, ist Abfrage (3) um `application_name` oder
> `client_addr` zu verengen, damit sie nur api-Sitzungen zählt.

### Schritt 5 — Wiederherstellungspunkt setzen

**Erst jetzt** — Regel D7: nachdem Writer und api stehen, vor der ersten Migration.

```sh
export PUNKT="uems-freigabe-$(date -u +%Y%m%dT%H%M%SZ)"
psql "$VP_DB_URL" -Atc "SELECT now(), pg_current_wal_lsn();"    # BEIDE Werte notieren
psql "$VP_DB_URL" -Atc "SELECT pg_switch_wal();"                # laufendes WAL-Segment archivieren
bash tools/backup/vp-db-backup-check.sh                          # Archiv frisch? Basis < 24 h?
```

Zusätzlich für den Rückweg notieren: der **Gruppenoffset des Writers am Punkt**.

```sh
rpk --config "$RPK_CONFIG" group describe timescale-writer
```

**Beleg:** Zeitstempel, LSN und Gruppenoffset notiert; Archivprüfung grün.
**Abbruch:** **ohne Punkt kein Schritt 6.** Meldet `vp-db-backup-check.sh` ein Archiv älter
als eine Stunde oder Fehler (Q15), ist das ein No-Go — nicht der Rückweg, sondern das
Fenster endet hier, ohne dass etwas migriert wurde.

### Schritt 6 — C2 syncen: die neue api migriert ⟲ geändert gegenüber §5.3

```sh
git -C "$GITOPS" push                       # C2: api-Replikas 0 -> 1
argocd app sync "$APP" --prune=false
argocd app wait "$APP" --health --timeout 900
kubectl -n "$NS" rollout status deploy/api --timeout=600s
```

Der Writer bleibt auf 0 (sein Teil des Patches ist unverändert).

**Beleg:**

```sh
kubectl -n "$NS" get pods -l app.kubernetes.io/name=api \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[0].ready,IMAGE:.spec.containers[0].image
# erwartet: genau EIN Pod, READY=true, IMAGE=…:<UEMS_SHA>
psql "$VP_DB_URL" -Atc "SELECT count(*) FILTER (WHERE success), count(*) FILTER (WHERE NOT success)
                          FROM flyway_schema_history;"
```

Die Dauer soll der Generalprobe entsprechen (Rubrik A). **Scheitert eine Migration → R.**

Zum Vergleich die Generalprobe vom 23.09.2026 (Bericht Teil 1 und §7, synthetischer Bestand):
108 Migrationen in 24,1 s, api bereit nach **54 s** bei 2,8 Mio. Samples, ≈ **71 s** bei 6 Mio.,
je weitere Sample-Zeile ≈ **5,3 µs** mehr. Die zwei langen Migrationen sind `V20260916180000` und
`V20260922236500` (§2.7); sie in `flyway_schema_history` (`execution_time`) zuerst ansehen, wenn
der Start deutlich länger dauert.

**Abbruch → R**, wenn: der Pod innerhalb des 180-s-Startbudgets nicht bereit wird · eine
Migration scheitert · `fehlgeschlagen > 0`.

### Schritt 7 — Nachher-Blatt Z01–Z07 **und Z08** gegen Produktion ⟲ geändert gegenüber §5.3

```sh
psql "$VP_DB_URL" -v ON_ERROR_STOP=1 -o /BETREIBER/nachher-$(date -u +%Y%m%dT%H%M%SZ).txt \
  -f tools/betriebsabfragen/bestand-nach-rollout.sql
```

**Beleg:** Zählungen = Generalprobe (± was seit dem Vorher-Blatt dazukam); **Z02 trägt
`rolle_gesetzt`**; Z06 entspricht der Generalprobe. Jede Abweichung → R.

**Z08 „Historie unverändert" — der neue Prüfpunkt.** Z01 zählt jede Zeile mit `success`
und würde die 18 DELETE-Marker eines alten Fehlstarts als gesund melden. Deshalb
zusätzlich:

```sql
BEGIN READ ONLY;
SELECT count(*) FILTER (WHERE type = 'DELETE')                    AS geloescht_markiert,
       count(*) FILTER (WHERE NOT success)                        AS fehlgeschlagen,
       count(*) FILTER (WHERE type = 'SQL' AND success)           AS sql_erfolgreich,
       count(DISTINCT version) FILTER (WHERE type = 'DELETE')     AS versionen_geloescht
  FROM flyway_schema_history;
ROLLBACK;
```

**Erwartet:** `geloescht_markiert = 0`, `fehlgeschlagen = 0`, `sql_erfolgreich` = die Zahl
des eingefrorenen Satzes (am geprobten Stand: 235). **Jeder Wert > 0 in
`geloescht_markiert` ist §8, nicht R-mit-Nachdenken.**

> ⬥ **Abgleich beim Rebase:** die parallele Bahn `vp-uems-flyway-startwaechter` baut
> diese Abfrage gerade als feste Zeile in
> [`tools/betriebsabfragen/bestand-nach-rollout.sql`](../../tools/betriebsabfragen/bestand-nach-rollout.sql)
> ein. Sobald sie dort steht, gilt **ihr** Name und **ihr** Wortlaut; die Abfrage oben ist
> die Fassung aus der Untersuchung (§5, „Konkreter neuer Prüfpunkt") und steht hier, damit
> das Drehbuch auch ohne sie vollständig ist.

**Nur DELETE zu zählen reicht für allgemeine Reparaturen nicht.** Zusätzlich müssen die
bereits vorhandenen `(installed_rank, version, type, checksum, success, description,
script)` unverändert sein und die neu hinzugekommenen Versionen und Prüfsummen exakt dem
eingefrorenen Release entsprechen. Der Fingerabdruck dafür liegt in der privaten
Zustandsdatei der Generalprobe (`--state`).

⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** die absoluten Ausgangszahlen. Auf einer
realen Kopie sind sie am gemessenen Vorher-Blatt festzulegen, nicht aus diesem Dokument.

### Schritt 8 — C3 syncen: Writer, ingest, Portal-Image

```sh
git -C "$GITOPS" push                       # C3: Null-Patch entfernt, restliche Images auf UEMS_SHA
argocd app sync "$APP" --prune=false
argocd app wait "$APP" --health --timeout 900
```

**Beleg:** der Writer läuft wieder und baut den Rückstand ab —
`VoltPilotEreignisStreckeRueckstand` löst aus und erholt sich. Zusätzlich:

```sh
# Der Commit darf den api-Stand nicht angefasst haben:
kubectl -n "$NS" get deploy api -o jsonpath='{.spec.replicas}{"  "}{.spec.template.spec.containers[0].image}{"\n"}'
# erwartet: 1  …/api:<UEMS_SHA>  -- unveraendert gegenueber Schritt 6
```

**Abbruch → R**, wenn C3 den api-Stand verändert hat oder die api dabei neu startet.

> **Warum das eigens geprüft wird:** die Untersuchung nennt für Schritt 8 ausdrücklich
> „unvollständige Commit-Sätze, ein Revert oder eine erneute Image-Bump-Automation" als den
> Weg, auf dem wieder ein altes Image zum Soll wird. Ein api-Neustart in diesem Moment wäre
> harmlos (das Image ist neu) — ein api-**Image**-Wechsel wäre es nicht.

### Schritt 9 — Rauchprobe, Portal noch zu

An **einer** bekannten steuernden Bestandsanlage, wörtlich:

| # | Probe | Beleg |
|---|---|---|
| 9.1 | **Plan-Alter** der Anlage | ein Fahrplan von heute; kein `…OhneAktuellenFahrplan` |
| 9.2 | **Telemetrie-Alter** derselben Anlage | jünger als die Fensterdauer + Nachlauf des Writers |
| 9.3 | **Ein Registry-Push**, Revision echot | die Box quittiert mit derselben Revision — das ist der Weg, der am gefallenen Primärschlüssel von `entity_registry_state` hängt |
| 9.4 | **Ein Handeingriff gesetzt und wieder aufgehoben** | beide Richtungen kommen an der Box an und verschwinden wieder |

**Beleg:** alle vier grün. **Jede Abweichung → R.**

⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** welche Anlage das ist und über welche
Fläche 9.3/9.4 bedient werden. Beides sind Betriebsentscheidungen, keine Repo-Angaben.

### Schritt 9b — Z08 noch einmal, unmittelbar vor dem Öffnen ⟲ geändert gegenüber §5.3

```sql
-- dieselbe Abfrage wie in Schritt 7
```

**Beleg:** `geloescht_markiert = 0` **und** die Zeilenzahl ist seit Schritt 7 unverändert.
Zwischen Schritt 7 und hier darf **keine weitere Migration und keine Reparatur**
stattgefunden haben.

**Grund:** die Untersuchung hält für Schritt 7 fest: „Bereitschaft und das jetzige Z01
allein beweisen keine intakte Historie. Ein alter Neustart kann vor oder nach dem Blatt
liegen." Zwischen Blatt und Portalöffnung liegen C3, der Wiederanlauf von Welle 1 und die
Rauchprobe — genug Zeit für einen unbeabsichtigten Neustart. Ist hier etwas anders: **§8.**

### Schritt 10 — Go: Portal öffnen

Wartungsseite weg. **Ab hier nur vorwärts (R2)** — und ab hier haben **alle alles**
(E1 = B): jeder Mehr-Anlagen-Kunde sieht die Karte „Noch nicht zugeordnet", jeder Kunde
kann „Standort anlegen" und „Messen & Auswerten" einrichten.

Danach: **Sync-Klammer auf (F2)**, siehe §3.

**Ab Schritt 10 gibt es keinen Rückweg mehr.** Was bleibt, ist der Not-Aus je Läufer
(§12) und die Vorwärts-Reparatur.

---

## 6. Übersicht: die Schritte auf einen Blick

| # | Schritt | Beleg | Abbruch |
|---|---|---|---|
| 1 | Kundennachricht 48 h vorher, F6 geprobt | Nachricht raus, Checkliste | Fenster verschieben |
| — | Sync-Klammer zu (F1) | `syncPolicy` ohne `automated` | Fenster verschieben |
| 2 | C1: neues api-Image **+** api/Writer auf 0, syncen | Soll = `UEMS_SHA` und 0/0 | Fenster abbrechen |
| 3 | Writer steht | Pod-Liste leer, RS 0 | → R |
| 4 | Alte api steht, gesperrt | Pods leer · RS 0 · DB-Sitzungen 0 · Soll-Image neu | → R |
| 5 | **Wiederherstellungspunkt** | Zeit, LSN, Gruppenoffset; Archiv frisch | ohne Punkt kein Schritt 6 |
| 6 | C2: api auf 1, Flyway läuft | 1 Pod ready auf `UEMS_SHA`; `fehlgeschlagen = 0` | → R |
| 7 | Nachher-Blatt Z01–Z07 **+ Z08** | Zählungen = Generalprobe; `geloescht_markiert = 0` | → R · bei Markern: §8 |
| 8 | C3: Writer, ingest, Portal-Image | Rückstand baut ab; api unverändert | → R |
| 9 | Rauchprobe (4 Proben) | alle vier grün | → R |
| 9b | **Z08 erneut** | 0 Marker, Zeilenzahl unverändert | → R · bei Markern: §8 |
| 10 | **Go:** Portal öffnen, Klammer auf (F2) | — | ab hier nur vorwärts |
| danach | **Box-Release** an die Boxen, erst jetzt (§2.8) | Boxen quittieren den heutigen Katalogstand | Release anhalten |

---

## 7. R — der Rückweg (nur vor Schritt 10) ⟲ geändert gegenüber §5.3

**Die Reihenfolge ist hart. Ein Image-Revert ist kein Rückweg.**

Das Konzept schrieb: „api und Writer auf null → Wiederherstellung auf den Punkt → alte
Images in gitops → Verbrauchergruppen zurücksetzen". Die Untersuchung verschärft: würden
alte Images **vor** der Datenbankwiederherstellung aktiv, träfen sie auf das migrierte
Schema — und der ganze Befund (18 DELETE-Marker, danach keine neue api mehr) tritt erneut
ein, diesmal mitten im Rückweg.

### R1 — api und Writer auf null, **belegt** null

Ein Commit, der `patches/rollout-fenster-null.yaml` wieder einhängt und **beide** Werte auf
0 setzt (also der Patch-Teil von C1, ohne den Image-Teil). Syncen, dann die vier Belege
aus Schritt 4 **und** die drei aus Schritt 3.

> **Die Images bleiben in diesem Schritt auf `${UEMS_SHA}`.** Sie werden erst in R4
> zurückgesetzt — ein Pod mit altem Image darf zwischen hier und der fertigen
> Wiederherstellung nicht startbar sein.

### R2 — Wiederherstellung auf den Punkt

```sh
bash tools/backup/vp-db-restore.sh --backup /BETREIBER/SICHERUNG \
  --target-time '<Zeitstempel aus Schritt 5>' --yes
```

Die Dauer ist aus NW-8 (`rueckweg.json`, `wiederherstellung_ms`) bekannt.

### R3 — Gegenprobe, **bevor** ein altes Image kommt

```sh
psql "$VP_DB_URL" -Atc "SELECT count(*), max(version) FROM flyway_schema_history;"
```

**Erwartet:** der Flyway-Stand **vor** der Migration (also `ALT_SHA`-Stand, höchste
Version `20260916203000`), und **Q01** des Vorher-Blatts bytegleich zum notierten
Fingerabdruck. Das ist genau die Zusicherung, die `rueckweg.sh` in der Übung prüft
(Exit 31: „Flyway-Stand oder Q01 am Rückweg abweichend").

**Weicht etwas ab, geht es nicht weiter** — dann ist der Punkt nicht der Punkt, und ein
altes Image darauf loszulassen macht es schlimmer.

### R4 — erst jetzt die alten Images, bei weiter 0 Replikas

Ein Commit, der im `images:`-Block **alle** Tags auf `${ALT_SHA}` zurücksetzt, während der
Null-Patch aus R1 stehen bleibt. Syncen; belegen, dass **kein** Pod läuft und der Sollstand
`ALT_SHA` zeigt.

### R5 — Writer-Verbrauchergruppen zurücksetzen (nur wenn der neue Writer schon gelesen hat)

Also nur, wenn R nach Schritt 8 ausgelöst wurde. Die geprüfte Vorlage druckt
`tools/generalprobe/writer-ruecksetzen-dry-run.sh`; sie führt nichts aus:

```sh
rpk --config "${RPK_CONFIG:?}" group describe "${WRITER_GROUP:-timescale-writer}"
rpk --config "${RPK_CONFIG:?}" group seek "${WRITER_GROUP:-timescale-writer}" \
  --to "${WRITER_REPLAY_EPOCH_MS:?}" \
  --topics "${WRITER_TOPICS:-telemetry.raw,telemetry-v2.raw,measurements.raw,events.raw}" \
  --allow-new-topics
rpk --config "${RPK_CONFIG:?}" group describe "${WRITER_GROUP:-timescale-writer}"
```

Bedingungen vor der Ausführung: **Writer auf null, keine Gruppenmitglieder, Aufbewahrung
bis zum gewählten Zeitpunkt vorhanden.** `seek` schreibt direkt — es gibt kein
`rpk --dry-run`.

> ⚠ **Bus-Zeitstempel sind keine DB-Commitzeit.** Rückstand vor dem Wiederherstellungspunkt
> kann ein **früheres** Replay-Ziel verlangen als der Zeitstempel des Punktes. Deshalb ist
> in Schritt 5 der Gruppenoffset notiert worden; er und eine Reserve bestimmen
> `WRITER_REPLAY_EPOCH_MS`, nicht der Punkt allein.
>
> ⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** ob die produktive Gruppe wirklich
> `timescale-writer` heißt und die vier Topics stimmen. Am Writer-Code und seiner
> `application.yml` sind sie geprüft; abweichende produktive Werte gehören in die
> Betreibervariablen.

### R6 — alte api und alter Writer starten

Der Null-Patch aus R1 wird entfernt (Commit), gesynct. Danach: Q01 gegen das Vorher-Blatt,
Anmeldung, Telemetrie-Alter, ein Fahrplan. **Kein Messwert fehlt, keiner steht doppelt**
(Regel D7).

Dann Sync-Klammer auf (F2).

### R-Reihenfolge in einer Zeile

> **api + Writer auf 0 und belegt 0 → Wiederherstellung → Gegenprobe (Flyway-Stand, Q01)
> → alte Images bei weiter 0 Replikas → ggf. Writer-Offsets → alte api/Writer starten.**

---

## 8. Kasten: „Es ist doch passiert" — eine alte api lief nach der Migration

**Auslöser:** `geloescht_markiert > 0` in Z08 · oder ein api-Pod mit `${ALT_SHA}` in der
Pod-Liste nach Schritt 6 · oder ein Neustart-Ereignis am api-Deployment zwischen Schritt 6
und Schritt 10, das niemand ausgelöst hat.

**Was jetzt NICHT getan wird:**

- **Nicht** das neue Image „noch einmal" ausrollen. Die neue api startet auf dieser
  Historie **gar nicht** — sie sieht die 18 markierten Versionen als `PENDING`, migriert
  erneut und bricht mit `42P07 … already exists` und Exit-Code 1 ab.
- **Kein** `repair`, **kein** Entfernen der DELETE-Zeilen von Hand, **kein** gewöhnlicher
  Image-Revert als vermeintliche Reparatur.
- **Nicht** warten, ob es sich einrenkt. Eine bereits laufende neue api validiert Flyway
  nicht erneut — der beschädigte Stand kann bis zu ihrem nächsten Neustart **verborgen**
  bleiben und schlägt dann zum ungünstigsten Zeitpunkt zu.

**Was getan wird — in dieser Reihenfolge:**

1. **Anhalten.** api und Writer auf 0 (R1), Portal bleibt zu bzw. wird wieder zugemacht.
2. **Befund sichern**, bevor irgendetwas wiederhergestellt wird:
   ```sql
   BEGIN READ ONLY;
   SELECT installed_rank, version, type, success, execution_time, installed_on
     FROM flyway_schema_history ORDER BY installed_rank;
   ROLLBACK;
   ```
   Dazu: `kubectl -n "$NS" get rs -l app.kubernetes.io/name=api -o wide` und die Events des
   Deployments (`kubectl -n "$NS" describe deploy api`) — sie sagen, **wodurch** der alte
   Pod startete.
3. **Rückweg auf den Punkt**, also §7 ab R2. Der physische Rückweg ist der einzige Weg, der
   die Historie wieder in den Zustand vor der Migration bringt.
4. **Vor dem zweiten Versuch:** die Startstelle schließen. Ohne Erklärung, **wodurch** der
   alte Pod startete, wird das Fenster nicht wiederholt.

**Nach dem Öffnen des Portals (Schritt 10)** gilt weiterhin der entschiedene Vorwärtsweg —
dann ist §12 (Not-Aus je Läufer) das Mittel, und die Reparatur ist ein Bau-Paket mit
Vorrang.

---

## 9. Offen beim Betreiber

### 9.1 Start-Wächter auf `main` und ein Vorab-Deploy — Entscheidung nötig

Die Untersuchung empfiehlt neben dem erzwungenen Nullstand (Option a, hier eingearbeitet)
zwei zusätzliche Absicherungen:

- **Option c — kleine Start-Härtung auf `main`, ausgerollt VOR dem Fenster.** Ein Wächter,
  der unbekannte angewandte Versionen **vor dem ersten `migrate()` und vor jeder Reparatur**
  erkennt und den Start verweigert — `MISSING_*` ebenso wie `FUTURE_*`, und bereits
  vorhandene DELETE-Markierungen von Produktionsmigrationen als harter Befund. Er
  verhindert, dass ein **versehentlich** gestarteter alter Build die Historie repariert und
  dann Bereitschaft meldet. Preis: ein zusätzlicher Produktions-Deploy der api vor dem
  UEMS-Fenster, der ausdrücklich geplant werden muss.
  Aufgabe: **`vp-uems-main-startwaechter-vor-rollout`**.
- **Option d — dieselbe Härtung auf `uems`.** Kein eigener Vorab-Deploy; sie kommt mit der
  Freigabe. Sie schützt den heute ausgelieferten `main`-Build **nicht** rückwirkend,
  verhindert aber, dass derselbe Fehler zur nächsten Freigabe wieder im dann „alten" Build
  steckt.

**Das Drehbuch ist mit und ohne c fahrbar. Was sich ändert:**

| | **ohne** Start-Wächter auf `main` (heute) | **mit** Start-Wächter auf `main` |
|---|---|---|
| Schritt 2/4 | tragen die volle Last: der Nullstand **ist** der einzige Schutz | unverändert nötig — der Wächter stoppt keinen bereits **laufenden** Prozess |
| Ein versehentlicher alter Pod-Start zwischen Schritt 6 und 10 | repariert die Historie still und meldet Bereitschaft → §8, Rückweg | **verweigert den Start**, meldet keine Bereitschaft, ändert die Historie nicht → der Pod fällt in CrashLoop, das Fenster läuft weiter |
| Z08 (Schritt 7, 9b) | der **einzige** Weg, einen solchen Start überhaupt zu bemerken | bleibt Pflicht — er belegt, was der Wächter verhindert haben soll |
| Vorbereitung | keine | ein zusätzlicher api-Deploy auf `main` **vor** dem Fenster, mit eigenem Nachweis, dass der laufende Build ihn wirklich trägt |

**Die Entscheidung gehört dem Betreiber**, weil sie einen zusätzlichen Produktions-Deploy
kostet. Wird sie nicht getroffen, fährt dieses Drehbuch unverändert — mit dem Unterschied,
dass ein unbeabsichtigter alter Start dann nur **nachträglich** über Z08 sichtbar wird und
zwingend in den Rückweg führt.

**Was nicht in Frage kommt (Option b der Untersuchung):** ein Wächter in einer neuen
DB-Migration. Alte und neue api benutzen dieselbe Flyway-Rolle mit Schemaeigentümer-/
Superuserrechten und dieselbe Historientabelle — sie sind auf DB-Ebene nicht
unterscheidbar, und ein gewöhnlicher Trigger auf einer Fachtabelle wird vor `repair()` gar
nicht erst aufgerufen. Manipulationen an `flyway_schema_history` oder künstliche Fehler
wären genau die verbotenen Tricks.

### 9.2 Der gitops-Kommentar ist falsch — Vorschlag für den Wortlaut

`apps/voltpilot/base/api/deployment.yaml` begründet in Zeile 36–39 die Strategie
`maxUnavailable: 0` so:

> „That is safe: Flyway is self-healing and additive (expand-contract rule), and the
> duplicated MQTT status upserts are idempotent."

**Der erste Halbsatz stimmt nicht mehr.** „Self-healing" ist der Mechanismus, der den
Schaden anrichtet: die Selbstheilung eines **alten** Builds markiert 18 angewandte
Migrationen als gelöscht, und „additive" gilt für den UEMS-Satz gerade nicht (drei der
Migrationen brechen den `main`-Code).

**Diese Berichtigung gehört in ein anderes Repository** (`mamotec/gitops`), und PR 37
liegt beim Betreiber. Deshalb hier nur der vorgeschlagene Wortlaut, zum Einsetzen an
derselben Stelle:

```
    # maxUnavailable: 0 keeps the portal answering across a rollout; with
    # replicas: 1 that means the new pod must become ready BEFORE the old one
    # goes away — which briefly runs two api pods. That is safe ONLY for
    # additive migrations: while both pods run, the old one serves the new
    # schema.
    #
    # It is NOT safe for a migration that renames or drops a column or drops a
    # primary key. Such a release needs a maintenance window with a restore
    # point — the old api does not fail fast on an unknown schema: it starts,
    # and its self-healing Flyway strategy REPAIRS the history, marking every
    # migration it does not know as DELETED. The next start of the NEW api then
    # fails, because it re-applies them.
    #
    # The guard that keeps this honest lives in the app repo:
    # MigrationHygieneTest rejects RENAME COLUMN / DROP COLUMN / DROP
    # CONSTRAINT …_pkey in a NEW migration unless it carries the marker
    # `-- freigabe: fenster`. The first UEMS release is the named exception and
    # its script is docs/rollout/uems-erste-freigabe.md in that repo.
```

Dieselbe Berichtigung betrifft `uems-betrieb.md` nicht — dort steht die Einschränkung
bereits richtig („Wellen stoppen keine alten Writer/ingest/Frontend-Pods", „Die
unveränderte RollingUpdate-Strategie macht inkompatible Migrationen nicht automatisch
sicher").

### 9.3 Weitere offene Punkte

- **Die zwei Platzhalter** aus §2.3 — `voltpilot:uems_datenbank_warnschwelle_bytes` (Q14)
  und der Dauerläufer-Tenant (IP-18, Einrichtung §14).
- **NW-6 bleibt eine reale Übung:** jeden der zwölf Alarme einmal auslösen, Zustellung an
  `betreiber` beobachten, jeden Läufer-Schalter umlegen. Lokale Regeltests beweisen weder
  Zustellung noch tatsächlichen Not-Aus.
- **Der echte Upload-Weg** einschließlich äußerem Proxy gehört vor G1 geprüft; die
  nginx-Ergänzung aus PR 37 ist nur lokal geprüft.

---

## 10. Die Kundennachricht, 48 Stunden vorher

**Regeln für den Wortlaut:** kein „Pilot", kein „Rollout", kein „Tor" — das sind unsere
Wörter, nicht die des Kunden. Und der Satz „für Sie ändert sich nichts" gilt **nur** für
Zahlen, Steuerung und Fahrpläne. Am Portal ändert sich sehr wohl etwas, und weil es mit
E1 = B **alle** am selben Tag betrifft, muss die Nachricht es nennen (B9).

> **Betreff: Wartung am TT.MM.JJJJ und neue Funktionen im Portal**
>
> Guten Tag,
>
> am TT.MM.JJJJ zwischen HH:MM und HH:MM ist das Portal nicht erreichbar. Ihre Anlage
> arbeitet währenddessen unverändert: Fahrplan, Schutzregeln und Messung laufen an der Box
> weiter, Messwerte werden nachgetragen.
>
> Danach finden Sie im Portal neue Funktionen:
>
> - **Standorte.** Wenn Sie mehrere Anlagen haben, sehen Sie auf der Übersicht eine Karte
>   „Noch nicht zugeordnet" mit einem Vorschlag, wie sich Ihre Anlagen zu Standorten
>   ordnen lassen. Sie sehen den Vorschlag zuerst und entscheiden selbst — von allein
>   ändert sich nichts.
> - **Standort anlegen** und **Messen & Auswerten**. Damit können Sie Zähler und weitere
>   Messstellen aufnehmen, Kennzahlen bilden und Berichte erzeugen.
> - **Benutzerverwaltung** unter Ihrem Namen oben rechts, unter Unternehmen und
>   Einstellungen.
>
> An Ihren Zahlen, Ihrer Steuerung und Ihren Fahrplänen ändert sich dadurch nichts. Beim
> ersten Aufruf nach der Wartung lädt das Portal einmal neu.
>
> Bei Fragen erreichen Sie uns unter <Support-Weg>.

**Was der Text bewusst nicht behauptet:** dass sich „nichts ändert". Mit E1 = B sieht jeder
Kunde ab diesem Tag dieselben Einstiege; wer das verschweigt, bekommt Rückfragen von Leuten,
die eine neue Karte auf ihrer Startseite finden.

**Nicht in die Kundennachricht gehören:** die ungeklemmten Historienquoten (E12 = A — am
Rollout-Tag **aus**, sie kommen mit einem eigenen angekündigten Termin) und das Ende des
Befehlsverlaufs abgemeldeter Boxen (Q11), sofern niemand betroffen ist.

**Release-Notiz:** Für diesen Tag wird der Abschnitt „Neue Einstiege im Portal“ aus der
[Vorlage für Release-Notizen](release-notiz-vorlage.md) ausgefüllt. Dieselbe Vorlage enthält
die getrennten Kundenfassungen für den später angekündigten Quoten-Termin und für jedes
Edge-Release. Die Release-Notiz gibt ausschließlich der Betreiber frei.

---

## 11. Support-Probe F6 — Checkliste

**Wann:** vor G1, einmal vollständig gegangen. **Wer:** Support-Weg ohne Vollzugriff.
**Warum:** am Rollout-Tag ist der Support der erste, der von einer Auffälligkeit erfährt —
und er darf dabei nicht auf einen Zugriff angewiesen sein, den es nicht gibt.

| # | Probe | Erwartung | abgehakt |
|---|---|---|---|
| F6.1 | **Gewährte Unterstützung**: der Kunde fragt an, ein Mitarbeiter gewährt sie | Beispiel Ahrenberg, 21.10.2026: Lena Voss fragt an, Jonas Wendlinger gewährt | ☐ |
| F6.2 | Der Unterstützer sieht **genau den Umfang**, der ihm gewährt wurde — nicht mehr | die Teilansicht trägt keine unternehmensweite Summe | ☐ |
| F6.3 | Die Unterstützung **endet** zum vereinbarten Zeitpunkt, ohne Handgriff | danach 404 auf den Kundenrouten, Protokollzeile vorhanden | ☐ |
| F6.4 | **Notfall-Zugriff** einmal gegangen | er gewährt sich selbst, geht **nicht** durch den Rechte-Prüfpunkt (E8) und hinterlässt eine Protokollzeile | ☐ |
| F6.5 | Der Weg ist **ohne Vollzugriff** gangbar | zu keinem Zeitpunkt war ein Plattform-Administrator nötig | ☐ |
| F6.6 | Der Support kennt §12 | „anhalten" heißt: Läufer aus — die Flächen bleiben | ☐ |

⧉ **Vom Betreiber beim ersten Lauf zu bestätigen:** Namen, Zeitpunkt und Kanal der Probe.
Das Beispiel oben stammt aus dem Referenzunternehmen, nicht aus dem Betrieb.

---

## 12. Anhang: Not-Aus je Läufer

**Mit E1 = B ist das nach dem Rollout-Tag das einzige Mittel zum Anhalten.** Es gibt kein
Freigabe-Tor und keinen Schalter, der Portalflächen verbirgt: ein Läufer auf `false` und
ein Sync hält **seine Arbeit** an — die Tabellen bleiben, die Flächen bleiben, nichts wird
gelöscht. Ein Image-Rückweg steht nach Schritt 10 nicht mehr zur Verfügung (W1).

**Wo:** `apps/voltpilot/base/api/api.env` (gitops). **Wie:** Wert auf `false`, Commit,
`argocd app sync "$APP"`. Die ConfigMap bekommt einen neuen Hash, die api startet neu.
**Die Namen sind die ausdrücklichen Umgebungsplatzhalter der Anwendung** — insbesondere
keine selbst hergeleiteten Spring-Namen einsetzen.

Die Tabelle nennt alle **24** `VOLTPILOT_UEMS_*_ENABLED`-Schalter aus
`services/api/src/main/resources/application.yml`, in derselben Reihenfolge; gitops PR 37 setzt
sie seit Commit `5ad2f32` vollständig (vorher 17, Befund B3 der Generalprobe vom 23.09.2026).

> ⚠ **`VOLTPILOT_UEMS_HISTORIE_UNGEKLEMMTE_QUOTEN_ENABLED` muss am Rollout-Tag `false` sein.**
> Die Vorgabe in `application.yml` ist `true` (Historienquoten außerhalb 0–100 % reisen
> ungeklemmt mit Unplausibel-Kennzeichen); ohne den ausdrücklichen Wert aus PR 37 gilt sie am
> Rollout-Tag (Befund B4). `false` hält die sichtbare 0–100-%-Klemme bis zum Quoten-Termin (E12).
> Vor Schritt 2 in der gerenderten ConfigMap nachsehen.

| Name | Vorgabe am Rollout-Tag | Was das Abschalten anhält |
|---|---|---|
| `VOLTPILOT_UEMS_UEBERGABE_ENABLED` | `true` | Quellenübergaben und die Zustellung beim Box-Tausch |
| `VOLTPILOT_UEMS_HISTORIE_UNGEKLEMMTE_QUOTEN_ENABLED` | **`false`** | (bleibt aus bis zum Quoten-Termin, E12 — sichtbare 0–100-%-Klemme) |
| `VOLTPILOT_UEMS_BEWERTUNG_ENABLED` | `true` | die Kaskaden- und Struktur-Naht der energetischen Bewertung; Routen und übrige Berichte bleiben, Bewertungs-Protokolle bekommen dann noch kein Wasserzeichen |
| `VOLTPILOT_UEMS_BERICHTE_ENABLED` | `true` | Berichte in der Korrekturkaskade; entfernt keine Route und keine Tabelle |
| `VOLTPILOT_UEMS_BERICHTE_STRUKTUR_ENABLED` | `true` | Strukturänderungen alle fünf Minuten (nur wirksam, wenn auch BERICHTE an ist) |
| `VOLTPILOT_UEMS_BESTANDSUEBERNAHME_ENABLED` | `true` | Standorte/Vorschläge für Bestandsanlagen beim Start |
| `VOLTPILOT_UEMS_FUNKTION_BESTAND_ENABLED` | `true` | Ableitung von Funktionen und Teilnahmen beim Start |
| `VOLTPILOT_UEMS_ZUGRIFF_BESTAND_ENABLED` | `true` | Übernahme der Bestandsrechte aus den Keycloak-Konten beim Start |
| `VOLTPILOT_UEMS_TAGESMENGE_NACHTRAG_ENABLED` | `true` | den Start-Lauf, der für vor AP-08 endgültige Tage ohne Menge eine Korrektur `menge_nachgetragen` vorschlägt (Freigabe von Hand) |
| `VOLTPILOT_UEMS_UNTERSTUETZUNG_ENABLED` | `true` | Protokoll abgelaufener Unterstützung und Erinnerung vor Ablauf |
| `VOLTPILOT_UEMS_UNTERSTUETZUNG_UMSCHALTER_ENABLED` | **`false`** | (alter `X-Tenant-Id`-Umschalter bleibt aus) |
| `VOLTPILOT_UEMS_VIERTELSTUNDE_ENABLED` | `true` | Fünfminutentakt und die einmalige 90-Tage-Rückrechnung |
| `VOLTPILOT_UEMS_KENNZAHLEN_ENABLED` | `true` | den Kennzahl-Schritt im Stundenlauf |
| `VOLTPILOT_UEMS_ENDGUELTIGKEIT_ENABLED` | `true` | stündlich Endgültigkeit, Tag/Periode, berechnete Messstellen, Kennzahlen |
| `VOLTPILOT_UEMS_LUECKEN_ENABLED` | `true` | Erkennen und Schließen von Datenlücken (füllt keine Werte auf) |
| `VOLTPILOT_UEMS_ERSATZWERT_ENABLED` | `true` | Verarbeitung der begründeten Ersatzwerte |
| `VOLTPILOT_UEMS_KASKADE_ENABLED` | `true` | das Durchziehen freigegebener Korrekturen durch abhängige Werte und Berichte |
| `VOLTPILOT_UEMS_ZEILENTEXTE_ENABLED` | `true` | das tägliche Entfernen abgelaufener CSV-Zeilentexte um 03:17 Europe/Berlin |
| `VOLTPILOT_UEMS_PLAN_ZUSTELLUNG_ENABLED` | `true` | das tägliche Löschen abgelaufener `plan_zustellung`-Zeilen um 03:47 (je Box bleiben die jüngste veröffentlichte und die jüngste angenommene) |
| `VOLTPILOT_UEMS_VERBUND_BILANZ_ENABLED` | `true` | die tägliche Vortagsbilanz je Anlage mit Gemeinsamer Steuerung um 04:37 (Netzpunkt gegen Summe der Box-Beiträge) |
| `VOLTPILOT_UEMS_VORBEHALT_ENABLED` | `true` | den täglichen Vorbehalt aus Messwerten um 04:52 (Erhöhen selbsttätig, Senken nur als Vorschlag); hält auch den Viertelstunden-Takt an |
| `VOLTPILOT_UEMS_VORBEHALT_VIERTELSTUNDE_ENABLED` | `true` | nur das Erhöhen des Vorbehalts im Viertelstunden-Takt; der Tageslauf bleibt |
| `VOLTPILOT_UEMS_LADEPARK_GRENZE_ENABLED` | `true` | den stündlichen Abgleich je Anlage mit Ladepark-Rahmen und die Neuzustellung des Ladepark-Dokuments bei Unterschied |
| `VOLTPILOT_UEMS_DATA_SOURCE_STATUS_MQTT_LISTENER_ENABLED` | `true` | die Verarbeitung von Quellenstatus aus MQTT |

Dazu `VOLTPILOT_METRICS_UEMS_ENABLED=true`: **nicht** abschalten, um etwas anzuhalten —
das nimmt der Überwachung nur die Sicht. Ein abgeschalteter Läufer exportiert kein Alter
mehr (`…_zustand` sagt `aus`), damit aus dem Not-Aus kein Daueralarm wird.

> **Ein Läufer geht erst mit Nachweis wieder an** (Konzept §5.7, Schritt 5).

---

## 13. Anhang: was gegengelesen wurde und was nicht

**Gegengelesen an:**

- `tools/generalprobe/README.md` (PR 974) — Aufruf, Exit-Codes 0/20/23/24/25/30/31,
  Rubriken A/B/C/W1, Feldnamen `je_migration_ms`, `startbudget_reicht`, `start_ms`,
  `flyway_historie_veraendert`, `wiederherstellung_ms`; die Writer-Vorlage samt Gruppe,
  vier Topics und `--allow-new-topics`.
- `tools/betriebsabfragen/README.md` und `bestand-nach-rollout.sql` (PR 964) — Z01–Z07 und
  ihre Entscheidungen; Z01 zählt `success` ohne Typfilter (der Grund für Z08).
- gitops PR 37, Zweig `fm/vp-uems-b14-ip10-gitops` — Dateipfade, `images:`-Block,
  `patches:`-Liste, Deployment-Namen, `replicas`-Felder, Sync-Wellen 0/1,
  `terminationGracePeriodSeconds: 45`, Namespace `voltpilot-prod`, Application
  `voltpilot-prod`, Root-App mit `selfHeal: true`, die Schalter (17, seit Commit `5ad2f32`
  alle 24) und die zwei
  `CHANGE-ME`-Platzhalter.
- `/Users/mvogt/…/vp-uems-w1-alte-api-repariert-historie/report.md` — §4 (jede Stelle, an
  der eine alte api starten kann) und §5 Option a samt neuem Prüfpunkt.
- `docs/deploy.md`, `docs/k8s-readiness.md`, `tools/backup/*`.
- Bericht der Rollout-Generalprobe vom 23.09.2026
  (`/Users/mvogt/…/vp-uems-rollout-generalprobe/report.md`) — Kurzfazit B2–B5, Teil 1
  (Migrationsdauern, Sperren, Hochrechnung), Teil 3 (Schalter-Inventar), Teil 4 (Box-Kopplung),
  §7 (Reihenfolge des Rollout-Tags); dazu PR 1143 und die 24 Schalter in `application.yml`.

**Nicht gegenlesbar auf einer Entwicklungsmaschine** (alles mit ⧉ markiert): jede Ausgabe
eines echten Clusters, die echten Dauern an Produktionsdaten, der Name des produktiven
Consumer-Group-Werts, die Anlage der Rauchprobe, die absoluten Ausgangszahlen des
Nachher-Blatts und das Verhalten der Root-App beim Aussetzen des Auto-Syncs.

**Der Wächter zu diesem Dokument:** `MigrationHygieneTest` lehnt in einer **neuen**
Migration (Version über dem eingefrorenen Satz) `RENAME COLUMN`, `DROP COLUMN` und
`DROP CONSTRAINT …_pkey` ab, wenn sie nicht die Kommentarzeile `-- freigabe: fenster`
trägt. Der Bestand bleibt ohne nachträgliche Marker grün — er ist gebaut, und dieses
Fenster macht ihn unschädlich.

---

## 14. Dauerläufer einrichten (IP-18, Kasten E11)

Der Dauerläufer ist ein interner Kundenbereich mit zwei simulierten Boxen, der in Produktion
dauerhaft den Weg Box → Bericht geht. Er gehört keinem Kunden, zählt in keiner
Flottenkennzahl und hat einen eigenen Alarm: `VoltPilotDauerlaeuferStumm` meldet sich, wenn
bei ihm länger als 15 Minuten kein Messwert ankam. Alles hier tust du; die Crew hat nur das
Werkzeug gebaut.

**Name:** „VoltPilot Dauerläufer (intern)“. **Kennung:** Die Plattform vergibt sie beim
Anlegen selbst. Eine vorgegebene Kennung wie `e1b07da2-…` lässt sich nicht eintragen: Die
Anlege-Route nimmt nur Name und Segment an (`CreateTenantRequest.java:10-12`), die Datenbank
vergibt die UUID (`TenantRepository.java:50-53`). Trag also die Kennung ein, die die Plattform
beim Anlegen vergibt.

### 14.1 Kundenbereich anlegen

1. Portal, Plattformverwaltung › **Mandanten** › „Mandant anlegen“: Name
   `VoltPilot Dauerläufer (intern)`, Segment Gewerbe & Industrie
   (`POST /api/v1/admin/tenants`, `AdminController.java:106-110`).
2. Den Mandanten öffnen. Die **volle interne Kennung** steht in der Kopfzeile des
   Detailbereichs (`MandantenPage.tsx:456`), in der Liste nur ihre ersten acht Zeichen.
   Schreib sie klein und vollständig ab. Das ist `<DL_TENANT>`.
3. Im Mandanten einen Benutzer anlegen, der den Dauerläufer pflegt, zum Beispiel
   `dauerlaeufer@voltpilot.de` als Kundenadministrator (`POST …/tenants/{id}/users`). Mit
   dieser Anmeldung erledigst du 14.2 und den Monatsbericht (14.5).

### 14.2 Aufbau wie ein Messkunde, zwei Boxen anmelden

Der Dauerläufer ist ein gewöhnlicher Messkunde und wird genau so eingerichtet. Sein
Messwert-Alter entsteht erst, wenn **Funktion „Messen“** an einem Standort eingerichtet ist und
jeder Box-Wert einer Komponente zugeordnet ist, deren Datenquelle die Box führt. Der
Lücken-Melder zählt nur solche Werte (`LueckenMelder.java:84`, `UemsMetricsRepository.java:88-99`).

**Was der Simulator selbst tut:** Er verhält sich wie eine echte Box
(`uems_dauerlaeufer.py`, Weg a+). Er beantwortet die Registerlesung aus dem Baukasten
(Schritt 3), er lernt die Mess-Auswahl, die die Plattform der Box zustellt (Schritt 4), er
quittiert sie, und er sendet genau die Schlüssel, die die Plattform vergeben hat. **Du überträgst
keinen Punktschlüssel.** Ohne Zustellung sendet der Simulator nichts, wie eine Box ohne Plan.

Die Zähler hinter den Boxen (fest im Simulator, `GATEWAY` und `register`):

| Box | Anlage | Gateway (Modbus TCP) | Messstellen und Register (Eingangsregister, u32, hohes Wort zuerst, ×0,1 kWh) |
|---|---|---|---|
| E-1 | AN-1 (Halle 1) | `10.99.1.10`, Port 502, Unit 1 | MS-05 → 500, MS-06 → 600, MS-07 → 700, MS-08 → 800 |
| E-2 | AN-2 (Halle 2) | `10.99.2.10`, Port 502, Unit 1 | MS-10 → 1000, MS-11 → 1100, MS-12 → 1200, MS-13 → 1300, MS-14 → 1400 |

1. Als Dauerläufer-Benutzer: Standort „Werk Dauerläufer“ anlegen, darin zwei Anlagen im Modus
   „nur messen“: `AN-1` (Halle 1) und `AN-2` (Halle 2). Am Standort Funktion **„Messen“**
   einrichten.
2. Zwei Boxen anmelden, je eine an ihrer Anlage. Das geht mit dem Betreiber-Werkzeug und der
   Anmeldung aus 14.1:
   ```bash
   cd tools/pki
   ./provision-device.sh --api-base https://portal.voltpilot.de --token "$DL_TOKEN" \
     --site <AN-1-UUID> --external-ref dauerlaeufer-e1 --domain <mqtt-host>
   ./provision-device.sh --api-base https://portal.voltpilot.de --token "$DL_TOKEN" \
     --site <AN-2-UUID> --external-ref dauerlaeufer-e2 --domain <mqtt-host>
   ```
   Das Werkzeug beansprucht die Box im Kundenbereich des Tokens (`POST /api/v1/devices/claim`),
   stellt ihr Zertifikat aus und schreibt die ACL-Zeile (`provision-device.sh:16-21`). Merk dir
   je Box die Geräte-UUID: `<DL_E1_DEVICE>` und `<DL_E2_DEVICE>`. **Dann zuerst 14.3 und 14.4
   erledigen und den Simulator starten**, denn die nächsten Schritte brauchen eine Box, die
   antwortet.
3. **Je Messstelle ein Zähler im Modbus-Baukasten** (Anlage › Komponenten › eigenes
   Modbus-Gerät; `POST …/components/custom/read`, dann `POST …/components/custom`):
   Geräte-Adresse = Gateway der Halle aus der Tabelle. Messwert „Wirkenergie Bezug“
   (bei MS-14 „OCPP-Zählerstand“): Eingangsregister, Adresse aus der Tabelle, Datentyp u32,
   Wortfolge „hohes Wort zuerst“, Skalierung 0,1, Einheit kWh. Name des Geräts = Messstelle
   (`MS-05` …). „Jetzt lesen“ muss einen Zählerstand zeigen: Das ist der Simulator, der
   antwortet. Ein Lesen je Halle genügt als Verbindungsbeleg; die übrigen Zähler derselben
   Halle speicherst du mit derselben Adresse. Es entstehen 4 + 5 Geräte.
4. **Je Messstelle „Eigenen Messwert hinzufügen“** an der Box (Box-Seite › Beobachtete
   Register; `POST /api/v1/devices/{box}/measurement-selection/custom?entityId=<Gerät>`), mit
   denselben Zahlen wie in Schritt 3 und dem Gerät der Messstelle als Komponente. Die Plattform
   vergibt den Schlüssel selbst (`custom.<32 Hexzeichen>`) und stellt die Auswahl der Box zu.
   **Ablesen:** Jede Zeile wechselt von „wartet“ auf „beobachtet“, spätestens mit dem ersten
   Wert (`beobachteteRegister.ts:197`). Möglich macht das die Quittung des Simulators
   (`apply_status` „applied“). Steht dort „abgelehnt“, stimmt eine Zahl nicht mit der Tabelle
   überein: Der Simulator nimmt nur u32-Eingangsregister auf den Adressen seiner Halle an.
5. **Datenquelle und Zuständigkeit: „Vorschlag übernehmen“**, je Anlage einmal. Das Portal hat
   dafür heute keinen Knopf, deshalb mit dem Dauerläufer-Token (`$DL_TOKEN`, derselbe wie in
   Schritt 2):
   ```bash
   curl -sS -H "Authorization: Bearer $DL_TOKEN" \
     https://portal.voltpilot.de/api/v1/sites/<AN-1-UUID>/data-sources/vorschlag
   ```
   Die Liste zeigt **einen** Vorschlag (das Gateway der Halle, die Box, die vier oder fünf
   Zähler). Genau so bestätigen:
   ```bash
   curl -sS -X POST -H "Authorization: Bearer $DL_TOKEN" -H 'Content-Type: application/json' \
     https://portal.voltpilot.de/api/v1/sites/<AN-1-UUID>/data-sources/vorschlag/uebernehmen \
     -d '{"vorschlaege":[{"device_id":"<box.id>","protokoll":"<protokoll>","adresse":"<adresse>",
          "komponenten":["<id>", …]}]}'
   ```
   Die Werte für `device_id`, `protokoll`, `adresse` und `komponenten` übernimmst du
   unverändert aus der Liste. Das legt die Datenquelle an, hängt sie an die Zähler
   (`DatenquelleBestandRepository.java:167-176`) und trägt die Box als zuständig ein
   (`DatenquelleVorschlagService.java:185-190`). Ohne diesen Schritt wären die Werte Spiegel
   (`MesswertHerkunft.java:447`), und der Lücken-Melder zählte sie nicht.

**Warum der Simulator lernt statt feste Schlüssel zu senden** (belegt in
`DauerlaeuferGanzerWegDbTest`): Die festen Schlüssel der AP-07-Szenarien
(`custom.ms-05.wirkenergie-bezug` …) nimmt die Katalog-Auswahl mit 400 ab
(`MeasurementSelectionService.java:416`), und „Eigenen Messwert hinzufügen“ vergibt den Schlüssel
selbst (`MeasurementSelectionService.java:291`). Ohne Auswahlzeile verwirft der Writer jeden
Wert (`MeasurementWriteRepository.java:145-150`). Weil der Simulator quittiert, steht die Fassung
vor dem ersten Wert, und auch der erste Wert je Schlüssel trägt seine Zuordnung
(`DauerlaeuferWriterNahtTest`).

**Solange noch kein Wert kam** (eingerichtet, Simulator aus oder noch nicht verbunden), hat
`…letzter_messwert_age_seconds` für den Dauerläufer keine Reihe. Stattdessen steht
`voltpilot_uems_kundenbereich_messwert_zustand{tenant="<DL_TENANT>",zustand="nie"}` auf 1.
Daran hängt die zweite Regel `VoltPilotDauerlaeuferStumm` (`zustand: nie`, nach 15 Minuten).

### 14.3 Geheimnis hinterlegen

Aus 14.2 hast du je Box einen Schlüssel und ein Zertifikat, dazu die Geräte-CA. Sie kommen als
**ein** Kubernetes-Secret `voltpilot-dauerlaeufer-boxen` in den Namespace `voltpilot-prod`,
mit den Schlüsseln `ca.crt`, `e1.crt`, `e1.key`, `e2.crt` und `e2.key`. Das Secret steht nie im
Repo und nie im gitops-Klartext; nimm den Weg, auf dem die anderen Produktionsgeheimnisse
hinkommen. Die Namen und die Form stehen in `tools/edge-simulator/.env.dauerlaeufer.example`.
**Punktschlüssel gehören nicht hinein**: die lernt der Simulator aus der Zustellung.

### 14.4 Schalter, Platzhalter, Sync

`<DL_TENANT>` gehört an **zwei** Stellen, beide Male derselbe Wert, klein geschrieben:

| Stelle | Datei im gitops-Repo | Eintrag |
|---|---|---|
| Alarmregel | `apps/voltpilot/overlays/prod/prometheusrule.yaml` | `voltpilot:uems_dauerlaeufer` → `tenant: <DL_TENANT>` (statt `CHANGE-ME-dauerlaeufer-tenant`) |
| api | Umgebung des api-Deployments | `VOLTPILOT_UEMS_DAUERLAEUFER_TENANT=<DL_TENANT>` |

Dazu kommt die Simulator-Arbeit aus dem Textblock für den gitops-Teil (PR von IP-18) mit
`VP_DAUERLAEUFER_TENANT`, `…_E1_SITE`, `…_E1_DEVICE`, `…_E2_SITE` und `…_E2_DEVICE`. Die
Sync-Welle liegt **nach** api und Writer. Dann syncen.

**Was der api-Schalter tut:** Ist er leer, bleibt jede Kennzahl so wie ohne Dauerläufer. Ist er
gesetzt, fehlt der Dauerläufer in `voltpilot_sites` und in allen `voltpilot_site_*`-Reihen.
Sein `voltpilot_uems_kundenbereich_letzter_messwert_age_seconds{tenant="<DL_TENANT>"}` bleibt
sichtbar, denn darauf schaut die Regel. Ein Wert, der keine UUID ist, zum Beispiel ein
vergessenes `CHANGE-ME`, lässt die api **nicht starten**. Das ist Absicht: Sonst würde ein
Tippfehler den Dauerläufer still wieder mitzählen.

**Nachsehen:** Die Probe des Simulator-Pods zeigt „bereit“. Im Lebenszeichen stehen
`verbunden: true` je Box und `gelernt`: vor 14.2 Schritt 4 `0`, danach `4` (E-1) und `5` (E-2).
Das Protokoll des Pods meldet je Box „Revision … angewendet, … angenommen, 0 abgelehnt“. Nach
14.2 Schritt 5 und etwa fünf Minuten liefert
`…letzter_messwert_age_seconds{tenant="<DL_TENANT>"}` einen Wert unter 300.

### 14.5 Monatsbericht als Dauerbeleg

Die gebauten Berichte (AP-12) erzeugen für den Dauerläufer ohne neuen Code einen
Monatsbericht, aber **nicht von selbst**. Es gibt keinen Lauf, der Berichte anlegt; ein
Bericht entsteht über `POST /api/v1/berichte` (Portal › Berichte). Freigeben lässt er sich
frühestens 7 Tage nach Monatsende (`docs/contracts/v2/bericht.md:134`).

- **Einmalig:** 14.1 bis 14.3. Wenn Kennzahlen im Bericht stehen sollen, zusätzlich eine
  Kennzahl am Standort.
- **Monatlich**, ab dem 8.: Mit der Dauerläufer-Anmeldung den Bericht für den Vormonat
  anlegen und freigeben. Der freigegebene Stand belegt, dass der ganze Weg einen Monat lang
  gegangen ist. Ein fehlender Monat ist ein Befund.

### 14.6 Übung: Simulator anhalten → Alarm nach 15 Minuten

1. Die Simulator-Arbeit auf 0 Replikas setzen, als ausdrücklichen gitops-Wert, und syncen.
2. Beobachten: `…letzter_messwert_age_seconds{tenant="<DL_TENANT>"}` wächst. Nach 15 Minuten
   plus einer Minute Stabilität geht `VoltPilotDauerlaeuferStumm` (critical) an `betreiber`.
   Zusätzlich meldet sich nach 30 Minuten `VoltPilotMesskundeOhneMesswerte` (warning), denn
   für diese Regel ist der Dauerläufer ein Messkunde wie jeder andere.
3. Wieder auf 1 Replika setzen. Das Alter fällt innerhalb von etwa drei Minuten
   (Lücken-Melder plus 60-s-Sammeltakt), und der Alarm löst sich. Sequenz und Zählerstand
   laufen nach dem Neustart weiter, ohne Reset (`uems_dauerlaeufer.py` `takt_von`).

Nach dem Neustart stellt der Broker die gehaltene Auswahl erneut zu; der Simulator lernt sie
neu und quittiert sie noch einmal. Einen Handgriff braucht das nicht.
Nur wenn der Broker selbst neu gestartet ist und dabei gehaltene Nachrichten verloren hat, bleibt
der Simulator nach seinem Neustart stumm (`gelernt: 0` im Lebenszeichen). Dann je Box einen
eigenen Messwert einmal aus- und wieder einschalten: Die Plattform stellt dadurch neu zu.

Lokal belegt ist Folgendes. `DauerlaeuferMetrikenDbTest` zeigt mit verstellter Uhr, dass die
Metrik bei ausbleibenden Werten über 900 s steigt. `DauerlaeuferGanzerWegDbTest` richtet alles
aus 14.1/14.2 über die Routen ein: Baukasten-Lesung, Geräte, eigene Messwerte, Zustellung und
Quittung, Vorschlag übernehmen. Die Box-Antworten stammen dabei aus dem echten Simulator. Vor dem
ersten Wert steht `zustand="nie"` auf 1. Danach steigt das Alter von 148 s auf 1 108 s, und der
Schalter nimmt die zwei Anlagen aus der Flotte. Am echten Writer trägt jeder Wert seine
Zuordnung, auch der erste (`DauerlaeuferWriterNahtTest`). Ob der Alarm in Produktion wirklich
zugestellt wird, zeigt nur diese Übung. Sie ist Betreiber-Punkt `nw6_alarmuebung` in Tor G1.
