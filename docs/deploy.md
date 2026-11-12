# Cloud deployen

Der im Repository implementierte Releaseweg ist **Forgejo → Registry → GitOps → Argo CD**. Die separate [Compose-Anleitung](deploy-compose.md) gilt für einen bewusst eigenständigen VM-Betrieb; sie ist kein zusätzlicher Deployment-Schritt für den Cluster.

## Releaseweg

```mermaid
flowchart LR
    Commit["Geprüfter Commit"] --> CI["Forgejo: Tests und Builds"]
    CI --> Images["Images mit Commit-SHA"]
    Images --> GitOps["GitOps: Image-Tags aktualisieren"]
    GitOps --> Argo["Argo CD: gewünschten Stand synchronisieren"]
    Argo --> Pods["Cluster-Dienste"]
```

1. Den Workflow **Build & Deploy** auslösen. Er führt Tests aus und baut die Cloud-Images. **Build & Deploy (fast)** überspringt Tests und setzt bereits erfolgte Prüfung voraus.
2. Den Job `gitops-tag-bump` prüfen: Er aktualisiert `apps/voltpilot/overlays/prod/kustomization.yaml` im separaten Repository `mamotec/gitops` auf den gebauten Commit-SHA. Er läuft nur bei einem Bau von `main` (`if: github.ref == 'refs/heads/main'`); ein Dispatch auf einem anderen Zweig baut Images, lässt den Job aber übersprungen und die Produktion unverändert.
3. Den gewünschten Stand in Argo CD synchronisieren und Rollout/Readiness prüfen. Die aktuelle Sync-Policy und Cluster-Manifeste sind im GitOps-Repository maßgeblich; ein erfolgreicher Image-Build belegt noch keinen Rollout. **Zwei Eigenschaften der Produktions-Application gehören dazu:** sie läuft auf Auto-Sync — ein gemergter Commit rollt selbsttätig aus —, und die Dienste tragen Sync-Wellen (`api` Welle 0, `timescale-writer`/`ingest`/`frontend` Welle 1). **Wellen ordnen die Aktualisierung, sie halten keine alten Pods an:** wer alten Code sicher aus dem Weg haben muss, setzt Replikas auf null und belegt den Nullstand.
4. Nach dem Rollout Anmeldung, aktuelle Telemetrie, Preisabdeckung und Fahrplanalter prüfen.

Quellen: [Workflow](../.forgejo/workflows/deploy.yaml), [Fast-Workflow](../.forgejo/workflows/deploy-fast.yaml), [Tag-Bump-Werkzeug](../tools/deploy/gitops-image-bump.sh).

## Nächtlicher Testlauf

Unabhängig vom releasegebundenen Testjob in **Build & Deploy** läuft nachts automatisch **Nightly test gate** (`.forgejo/workflows/nightly-tests.yaml`) gegen `main`: dieselben Testsuiten (api/ingest/timescale-writer per Maven, die Python-Dienste per Pytest, Portal-Typecheck/Vitest/Build), aber ohne Image-Build, Push oder gitops-Tag-Bump - reine Meldung, keine Secrets nötig. Ein roter Lauf ist im Actions-Tab des Repos sichtbar (Commit-Status); ein zusätzlicher Push-Kanal existiert noch nicht.

## CI-Zugangsdaten

| Secret | Zweck |
|---|---|
| `FORGEJO_USERNAME`, `FORGEJO_PASSWORD` | Registry |
| `DOMAIN` | Öffentliche Portal-/Auth-Adresse für den Build |
| `GITOPS_PUSH_TOKEN` | Schreibzugriff auf das GitOps-Repository |
| `GITOPS_PUSH_USER` | Optionaler Benutzername für den GitOps-Push |

Ohne `GITOPS_PUSH_TOKEN` wird der Bump ausdrücklich übersprungen; der Build kann trotzdem grün sein. Der Workflow deployt nicht per SSH auf eine VM. Cloud und Edge haben getrennte Releasewege: [Edge-Signaturen](ota-signing.md).

## Datenebene und Cluster

```mermaid
flowchart TB
    Browser["Browser"] --> Proxy["TLS-Reverse-Proxy"] --> Cluster["Cluster: Portal, API, Jobs, Keycloak"]
    Cluster -->|"freigegebene LAN-Ports"| Daten["Datenebene: Postgres, EMQX, Redpanda"]
    Box["Kunden-Box"] -->|"MQTT-mTLS 8883"| Daten
```

Die Produktions-Compose-Datei unterstützt eine getrennte Datenebene mit `DATA_PLANE=enabled` und verpflichtendem `DATA_PLANE_HOST`. Das aktiviert das [LAN-Overlay](../infra/prod/dataplane/enabled.yml).

| Host-Port, Standard | Zweck |
|---|---|
| 5432 | TimescaleDB |
| 5433 | Eigene Keycloak-Datenbank |
| 1883 | Interner MQTT-Verkehr |
| 18083 | EMQX-Verwaltung / Authz-Reload |
| 29092 | Redpanda-EXTERNAL-Listener; intern Containerport 29093 |

Die Bindung muss an die tatsächliche LAN-Adresse erfolgen. Firewallzugriff auf die vorgesehenen Cluster-Nodes begrenzen. Kafka-Clients brauchen auch die annoncierte Adresse; bei abweichendem DNS `DATA_PLANE_ADVERTISED_HOST` prüfen. `ExternalName` setzt keine Portnummer um: Keycloak benötigt den passenden Datenbankport.

Auf einer reinen Daten-VM ausschließlich die benötigten Datendienste verwalten. **Kein ungezieltes `compose up` des gesamten Stacks:** sonst können API/Jobs und insbesondere ein zweiter Optimierer neben dem Cluster starten.

## Datenbank und Wiederherstellung

- Produktion verwendet standardmäßig ein leeres `SPRING_PROFILES_ACTIVE`. `local` ergänzt Demomigrationen.
- Angewandte Migrationen unverändert lassen. `out-of-order: true` erlaubt später eintreffende Versionen; nicht umnummerieren.
- Selbstheilende Prüfsummenkorrektur ersetzt keine SQL-Migration. Unerwartete Flyway-Warnungen untersuchen. [Migrationen](api.md#schema-und-migrationen).
- **Die Grenze der Selbstheilung:** `SelfHealingFlywayMigrationStrategy` ruft nach einer gescheiterten Validierung `repair()` auf. Startet damit ein **älterer** Build gegen ein neueres Schema, markiert Flyway jede ihm unbekannte angewandte Migration in `flyway_schema_history` als `type='DELETE'` — die Tabellen bleiben, aber der neue Build sieht diese Versionen danach als `PENDING`, migriert sie erneut und **bricht beim Start ab** (`relation … already exists`, Exit 1). Ein einziger alter Fehlstart nach einer Migration legt also den neuen Betrieb lahm. Der Schutz ist der belegte Nullstand vor der Migration, nicht die Selbstheilung.
- Rücknahme eines App-Releases: vorherigen geprüften Image-Stand im GitOps wiederherstellen und synchronisieren. Das setzt die Datenbank nicht zurück. **Das trägt nur bei additiven Migrationen** (Expand-Contract). Hat das Release eine Spalte umbenannt, eine Spalte oder einen Primärschlüssel fallen lassen, ist ein Image-Revert **kein** Rückweg: er stellt den alten Code auf das neue Schema. Dann gilt die Reihenfolge api und Writer auf null und belegt null → Wiederherstellung auf den Punkt → Gegenprobe → erst dann alte Images.
- Vor zustandsverändernden Wartungsarbeiten eine zur Umgebung passende, getestete Wiederherstellung für Datenbank, CA, ACL und Konfiguration bereithalten.
- Die erste UEMS-Produktfreigabe ist die benannte Ausnahme mit Wartungsfenster und Wiederherstellungspunkt; ihr wörtlicher Ablauf steht im [Rollout-Drehbuch](rollout/uems-erste-freigabe.md). Danach gilt Expand-Contract wirklich — bewacht von `MigrationHygieneTest`: eine neue Migration mit `RENAME COLUMN`, `DROP COLUMN` oder `DROP CONSTRAINT …_pkey` braucht den Marker `-- freigabe: fenster`, mit dem sie ausdrücklich ein Wartungsfenster anmeldet.

## Kundenbereich löschen (Vertragsende)

**Regel (UEMS AP-20, seit vp-kunde-sofort-loeschen-mit-daten, Captain 12.11.2026):** der Plattform-Admin löscht
jeden Kundenbereich sofort endgültig - mit oder ohne Datenbestand, aktiv oder beendet, ohne vorheriges
Vertragsende und ohne Wartefrist. Es wird nicht anonymisiert: der Gesamtabzug bleibt im Löschdialog ein Angebot
an den Kundenadministrator, keine Pflicht und keine Bedingung fürs Löschen (E10 = A, BT4).

1. **Beenden (eigene, unabhängige Funktion):** `POST /api/v1/admin/tenants/{id}/beenden` mit Auftrag, Begründung,
   Name eintippen und Frist in Tagen (Startwert 90; die geltende steht im Vertrag). Danach schreibt niemand mehr
   in den Bereich, nur der Kundenadministrator liest. `…/wiederaufnehmen` nimmt ihn jederzeit zurück - derselbe
   Bereich, kein neuer. Diese Frist sperrt das Löschen nicht (mehr); sie ist reine Vertragsdokumentation.
2. **Mitnahme anbieten:** der Kundenadministrator kann jederzeit den Gesamtabzug laden (`GET
   /api/v1/unternehmen/abzug`; im Portal im Hinweis „beendet“ und unter „Unternehmen › Einstellungen“, und als
   Angebot im Löschdialog). Jeder abgeschlossene Abruf steht mit Prüfsumme im Protokoll `kundenbereich_abzug`.
3. **Sofort löschen:** `POST /api/v1/admin/tenants/{id}/delete` (Name eintippen) löscht sofort, unabhängig vom
   Zustand des Vertrags oder vom Datenbestand. Nie gemeldete Boxen werden dabei einzeln über „Vom Kunden lösen"
   freigegeben (Kennung sofort wieder anmeldbar); eine Box, die doch gemeldet hat, geht stattdessen über die
   Kaskade - das lehnt die Löschung selbst nicht ab.
4. **Der Löschnachweis bleibt:** `mandant_loeschnachweis`, Kennzeichen `LN-JJJJ-nnnn`, auch im Bericht der Route
   unter `loeschnachweis`: Kennung des Bereichs, Anlass (`sofort_keine_daten` | `sofort_mit_daten`; `beendet_am`
   nur, wenn der Vertrag zum Löschzeitpunkt beendet war - sonst leer, wie Frist und Fristtag), gelöscht am und von
   wem (Betrieb), Zeilen je Tabelle, `verblieben` und die Prüfsumme des letzten Gesamtabzugs - ohne Namen, Konten
   oder Auftragstexte des Kunden. Niemand ändert oder löscht ihn; nur die Admin-Rolle der Datenbank liest ihn.

- **`verblieben` ist leer:** die append-only-Protokolle ohne Fremdschlüssel (`ort_aenderung`, `messstelle_aenderung`, `data_source_aenderung`, `component_change_event`, `device_site_assignment`) tragen Firmen- und Personennamen und gehen im Löschzug nach der Mandantenzeile mit. Ihr Trigger lässt ein Löschen nur zu, wenn die Mandantenzeile nicht mehr existiert — während der Vertragslaufzeit, auch „beendet“, ändert oder löscht sie niemand (`V20260925234500`). Alles Übrige mit `tenant_id` ohne Fremdschlüssel (`telemetry_v2` und ihre Rollups, Status-, Befehls- und Plantabellen der Boxen, Fluss-Quittungen, Ausgangslisten — einige mit `actor_name`) löscht der letzte Schritt des Löschzugs über den **Katalog** (`TenantRepository.KATALOG_MIT_MANDANT`, keine Handliste): jede Tabelle, die die Admin-Rolle löschen darf, bekommt ein DELETE nach Kennung — eine neue Tabelle geht also ohne Pflege mit. Nennt ein Nachweis trotzdem eine Tabelle, ist das ein Befund (kein Löschrecht der Admin-Rolle oder ein append-only-Trigger; einen scheiternden Trigger nennt zusätzlich das Log „Löschzug …: nicht löschbar“). Zeilen früher gelöschter Mandanten (vor diesen Regeln, in den Protokollen und in den Tabellen ohne Fremdschlüssel) liegen noch; das ist ein eigener, bewusster Handgriff des Betreibers, kein Teil des Löschwegs und keine Migration — finden lassen sie sich je Katalog-Tabelle mit `WHERE tenant_id IS NOT NULL AND tenant_id NOT IN (SELECT id FROM tenant)`.
- **Sicherungen** ([Backup-Runbook](backup-restore.md)) enthalten den Bereich weiter, bis sie nach ihrer eigenen Aufbewahrung wegfallen; der Löschweg erreicht sie nicht.
- `POST …/offboarding/cleanup` löscht nur übrige Keycloak-Konten eines schon gelöschten Bereichs und verweigert, solange der Bereich existiert.

## Betrieb prüfen

[Kubernetes-Betriebsvertrag](k8s-readiness.md): Probes, Singleton-Grenzen, Shutdown, Metriken und Logformat. [MQTT-Sicherheit](security-mqtt.md): Zertifikate, ACL-Mounts und Reload.

Keycloak übernimmt Realm-Änderungen nur in einen neuen Realm (`--import-realm`); den laufenden Realm `voltpilot` stellt der Betreiber von Hand um. Die Anmelde-Härtung (Ereignisse, Passwort-Vorgabe, zweiter Faktor für `platform-admin`; UEMS AP-20 E12) hat dafür ein Prüfskript und eine Bestätigung mit Datum: [Live-Realm = Import](../infra/prod/keycloak/live-realm-import.md). Dasselbe gilt für den Client `grafana` (Anmeldung an Grafana über Keycloak, nur `platform-admin`; sein Zugriffstoken trägt mit Absicht keine Rolle): [Client für Grafana](../infra/prod/keycloak/live-realm-grafana.md).

```bash
bash tools/deploy/test-gitops-image-bump.sh
bash tools/deploy/test-gitops-bump-workflow.sh
```

Diese Selbstchecks testen den Deployment-Code offline. Sie prüfen keinen Live-Cluster.

## Backup der Datenebene

`DB_BACKUP=enabled` und `DB_BACKUP_DIR` aktivieren das Backup-Overlay in `infra/prod/backup/`: physische TimescaleDB-Sicherung mit WAL-Archiv sowie täglicher Keycloak-DB-Dump. Einrichtung und Wiederherstellung: [Backup-Runbook](backup-restore.md). Der isolierte Nachweis steht in `tools/backup/test-backup-restore.sh`.
