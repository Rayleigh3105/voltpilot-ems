# Vorschlag für gitops: `VoltPilotSicherungZuAlt` (AP-20 IP-19)

**Status: Vorschlag, nicht gemergt.** Die Dateien hier gehören ins gitops-Repo. Sie liegen im
Anwendungsrepo, damit Regel, Export und Test an einem Stand geprüft sind. Nach gitops kommen sie
als eigener Zweig; mergen tut der Captain (E11 = A, BT3, W6). Bis dahin gibt es keinen Alarm auf
das Alter der Sicherung, und L-003 bleibt `in_arbeit`.

Die Sicherung wird damit die neunte Überwachungsschicht (W6): das Alter als Metrik
(`tools/backup/vp-db-backup-metrics.sh`), die Regel hier und die Übung als Beleg
([`../../uebungen/`](../../uebungen/README.md)). Ein Alarm, der nie ausgelöst wurde, ist nicht
geliefert (NR8). Der promtool-Test löst ihn aus. Die Übung in Produktion ersetzt er nicht.

| Datei hier | Ziel in gitops |
|---|---|
| [`infra/monitoring/datenebene/prometheusrule-sicherung.yaml`](infra/monitoring/datenebene/prometheusrule-sicherung.yaml) | dieselbe Stelle, neue Datei |
| [`hack/alert-tests/sicherung_test.yaml`](hack/alert-tests/sicherung_test.yaml) | dieselbe Stelle, neue Datei |
| [`pruefe.sh`](pruefe.sh) | bleibt hier; in gitops fährt `hack/alert-tests/run.sh` dieselben zwei Schritte |

## Einbau in gitops (drei Zeilen)

1. `infra/monitoring/datenebene/kustomization.yaml`, unter `resources:` nach `prometheusrule.yaml`:

   ```yaml
     - prometheusrule-sicherung.yaml
   ```

   Das Verzeichnis `datenebene` ist in gitops heute **geparkt**. Es steht nicht in
   `infra/monitoring/kustomization.yaml`. Die Regel wird also erst mit dem Scharfschalten der
   Datenebene wirksam (Schritte 1–4 in `infra/monitoring/datenebene/README.md`). Vorher kommt
   kein Alarm, weder ein falscher noch ein richtiger.
2. `hack/alert-tests/run.sh`, in `PAIRS`:

   ```bash
     "infra/monitoring/datenebene/prometheusrule-sicherung.yaml|sicherung_test.yaml|sicherung_rules.yaml"
   ```

3. `infra/monitoring/datenebene/README.md`, Schritt 2, in `command:` des node-exporters:

   ```yaml
         # Sicherungsalter aus tools/backup/vp-db-backup-metrics.sh (AP-20 IP-19).
         # /host ist das Wurzelverzeichnis der VM, schon read-only eingehängt.
         - --collector.textfile.directory=/host/var/lib/node_exporter/textfile_collector
   ```

   Dazu in Schritt 3 eine Vorflug-Zeile: `curl -s 192.168.178.128:9100/metrics | grep voltpilot_sicherung_`
   zeigt drei Zeilen.

## Auf der VM (Hand des Betreibers)

Vor dem gitops-Merge, sonst meldet die Regel nach 30 min `teil=export, zustand=fehlt`:

```bash
# auf 192.168.178.128, als root, aus dem Deploy-Checkout /srv/docker/voltpilot
install -d -m 0755 /var/lib/node_exporter/textfile_collector
/srv/docker/voltpilot/tools/backup/vp-db-backup-metrics.sh      # einmal von Hand, Ausgabe ansehen
cp /srv/docker/voltpilot/tools/backup/systemd/vp-db-backup-metrics.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now vp-db-backup-metrics.timer
cat /var/lib/node_exporter/textfile_collector/voltpilot_sicherung.prom
```

Weicht `DB_BACKUP_DIR` von `/srv/backup/voltpilot-db` ab, `--backup-dir` in der Service-Unit
anpassen.

## Reihenfolge und Grenze

Export auf der VM → node-exporter mit Textfile-Verzeichnis → gitops-Merge (Regel + Test) →
Datenebene scharf → Alarm-Übung ([Ablauf](../../uebungen/README.md#alarm-übung-voltpilotsicherungzualt-nr8))
→ L-003 `behoben` mit dem Stand des gitops-Merges und der Übung als Nachweis (RF-06).

Q15 und die Rückweg-Übung AP-14 NW-8 hängen nicht an diesem Vorschlag. Sie gehören **vor den
Rollout** (Tor G1). Der Alarm kann danach kommen.

**Was die Regel nicht sieht:** eine Sicherung, die zwar frisch ist, sich aber nicht
wiederherstellen lässt. Das zeigt nur die Rückweg-Übung (BT1). Eine Kopie außer Haus und die
Verschlüsselung der ruhenden Daten fehlen weiter (L-004): ein Verlust der Daten-VM verliert auch
die Sicherung.

## Prüfen

```bash
docs/bewertung/vorschlaege/gitops/pruefe.sh     # promtool check rules + test rules
bash tools/backup/test-backup-metrics.sh        # der Export, offline
```

Fehlt `promtool`, bricht `pruefe.sh` mit Exit 2 ab. Der Vorschlag ist dann nicht bewiesen.
