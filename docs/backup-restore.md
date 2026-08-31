# Backup & Restore der VoltPilot-Datenebene

Physisches Backup der TimescaleDB (Basis-Backup + kontinuierliches WAL-Archiv, Point-in-Time-Recovery) plus täglicher Dump der keycloak-db.
Gebaut für die tatsächliche Topologie: die Datenebene läuft als Docker-Compose-Stack auf der Prod-VM (`/srv/docker/voltpilot`, Projekt `voltpilot`), TimescaleDB `timescale/timescaledb:2.17.2-pg16` mit dem Datenvolume `voltpilot_timescale-data`.
Der 5432-Port ist standardmäßig nicht veröffentlicht, deshalb läuft alles über `docker exec` gegen den laufenden Container - die Skripte brauchen auf dem Host weder Postgres-Werkzeuge noch besondere Pfade.

**Der Beweis:** `tools/backup/test-backup-restore.sh` fährt den echten Zyklus (seed -> Backup -> Totalverlust -> Restore -> Daten identisch, inkl. PITR, komprimierter Chunks, Rotation und Alterscheck) in Wegwerf-Containern gegen das Prod-Image.
Ein Backup ohne getesteten Restore gilt in diesem Haus als nicht geliefert.

Bausteine:

| Teil | Datei | Läuft wo |
|---|---|---|
| WAL-Archivierung (kontinuierlich) | `infra/prod/backup/enabled.yml` + `archive-wal.sh`, aktiviert über `DB_BACKUP=enabled` | im timescaledb-Container, vom Server selbst |
| Basis-Backup + keycloak-Dump + Rotation (täglich) | `tools/backup/vp-db-backup.sh` | auf der VM (systemd-Timer) |
| Alterscheck | `tools/backup/vp-db-backup-check.sh` | auf der VM (stündlicher Timer) |
| Wiederherstellung | `tools/backup/vp-db-restore.sh` | auf der VM (oder jeder Maschine mit Docker + den Backup-Dateien) |
| Timer-Units | `tools/backup/systemd/` | VM, systemd |

## Warum physisch (und was aus timescaledb_pre_restore/post_restore wird)

Ein logischer Dump (`pg_dump`) ist bei dieser Datenbank die falsche Werkzeugklasse:

- Bei 0,7-1,8 TB (die 100-Anlagen-Projektion aus dem Skalierungs-Gutachten `vp-scale-readiness-p4` §2.2) ist Dump UND Restore je ein Mehr-Stunden- bis Tage-Fenster.
- Die `forecast`-Hypertable ist seit `V20260809000000` komprimiert. Ein logischer Restore braucht dafür die Sonderprozedur `timescaledb_pre_restore()`/`timescaledb_post_restore()`, und jede Abweichung davon endet in einem kaputten Katalog.

`pg_basebackup` + WAL-Archiv kopiert dagegen die Cluster-**Bytes**: komprimierte Chunks reisen als komprimierte Chunks, Timescale-Kataloge, Hintergrund-Jobs, Rollups, RLS-Policies und Rollen kommen exakt so zurück, wie sie waren.
`timescaledb_pre_restore`/`post_restore` werden auf diesem Weg **nie** aufgerufen - sie gehören ausschließlich zum logischen Weg und wären hier sogar falsch.
Der Test beweist die Kompressionstransparenz ausdrücklich (Prüfsummen über komprimierte Chunks nach dem Restore, Kompressions-Policy-Job lebt weiter).

Zusatznutzen des WAL-Archivs: **Point-in-Time-Recovery**.
Ein "oops, Tabelle geleert um 14:32" ist auf den Stand 14:31 wiederherstellbar, nicht nur auf das letzte nächtliche Backup.

## Aufbewahrung: 7 tägliche + 4 wöchentliche

- **7 tägliche** decken die Klasse "gestern/diese Woche ist etwas kaputtgegangen und wir haben es binnen Tagen gemerkt" mit Tages-Granularität - zusammen mit dem WAL-Archiv sogar minutengenau innerhalb der 7 Tage.
- **4 wöchentliche** (das Sonntags-Backup wird aufgehoben) decken "wir merken es erst nach zwei, drei Wochen" - mit Wochen-Granularität, ohne die Platte mit 28 vollen Kopien zu belegen.
- Das WAL-Archiv wird bei jeder Rotation bis zum Start-Segment des ältesten **behaltenen** Basis-Backups gekürzt (`pg_archivecleanup`). PITR reicht damit lückenlos über die ganzen ~28 Tage zurück; älter als das älteste Basis-Backup kann kein WAL-Replay ansetzen, also wäre längeres Aufheben totes Gewicht.

Platzbedarf grob: 11 Basis-Backups (gzip, bei Zeitreihen typischerweise 3-5x kleiner als die DB; der schon komprimierte `forecast`-Anteil bleibt ~1x) plus ~28 Tage WAL (gzip; wächst mit dem Schreibvolumen, bei 10-s-Telemetrie je Anlage grob einige hundert MB/Tag ab zweistelliger Anlagenzahl).
Faustregel fürs Sizing von `DB_BACKUP_DIR`: **mindestens 4x die aktuelle DB-Größe** (`docker exec <timescaledb> psql -U voltpilot -d voltpilot -Atc "SELECT pg_size_pretty(pg_database_size('voltpilot'))"`), auf einer anderen physischen Platte als das Docker-Datenverzeichnis.

Andere Werte: `vp-db-backup.sh --keep-daily N --keep-weekly M --weekly-dow D` (im Timer-Unit ergänzen).

## Einrichtung auf der VM (einmalig, ~15 min)

Alles Folgende macht der Captain auf der Prod-VM; kein Schritt braucht Downtime außer dem einen `up -d` (kurzer DB-Neustart, Schritt 3).

**1. Backup-Verzeichnis anlegen** (idealerweise eigene Platte/Partition; uid 70 = der Postgres-Benutzer im Alpine-Container):

```bash
sudo install -d -o 70 -g 70 /srv/backup/voltpilot-db /srv/backup/voltpilot-db/base /srv/backup/voltpilot-db/wal /srv/backup/voltpilot-db/keycloak
```

⚠ Ohne diesen Schritt schlägt die WAL-Archivierung nach dem Aktivieren dauerhaft fehl und `pg_wal` wächst, bis die Platte voll ist.
Der Alterscheck (Schritt 5) macht genau das binnen einer Stunde sichtbar - aber richtig ist, die Verzeichnisse **vor** Schritt 3 anzulegen.

**2. `.env` ergänzen** (`/srv/docker/voltpilot/.env`, Vorlage in `.env.prod.example`):

```bash
DB_BACKUP=enabled
DB_BACKUP_DIR=/srv/backup/voltpilot-db
```

**3. timescaledb mit dem Overlay neu erstellen** (aus dem Deploy-Checkout, der `infra/prod/backup/` enthält - vorher `git pull`):

```bash
cd /srv/docker/voltpilot
docker compose -f docker-compose.prod.yml config | grep -A8 'archive_mode'   # Kontrolle: archive_mode=on + /backup-Mount
docker compose -f docker-compose.prod.yml up -d
```

Nur `timescaledb` wird neu erstellt (geänderte Kommandozeile + neue Mounts); das ist ein DB-Neustart von wenigen Sekunden, die App-Dienste verbinden sich selbst neu.
Danach prüfen, dass die Archivierung wirklich läuft:

```bash
docker exec voltpilot-timescaledb-1 psql -U voltpilot -d voltpilot -c "SELECT * FROM pg_stat_archiver"
ls /srv/backup/voltpilot-db/wal/      # spaetestens nach 5 min (archive_timeout) liegt hier ein *.gz
```

**4. Erstes Basis-Backup ziehen** (danach macht es der Timer):

```bash
/srv/docker/voltpilot/tools/backup/vp-db-backup.sh
```

**5. Timer installieren:**

```bash
sudo cp /srv/docker/voltpilot/tools/backup/systemd/vp-db-backup.{service,timer} /etc/systemd/system/
sudo cp /srv/docker/voltpilot/tools/backup/systemd/vp-db-backup-check.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vp-db-backup.timer vp-db-backup-check.timer
systemctl list-timers 'vp-db-*'
```

Cron-Alternative (falls Timer unerwünscht), in `/etc/cron.d/vp-db-backup`:

```
40 2 * * * root /srv/docker/voltpilot/tools/backup/vp-db-backup.sh >> /var/log/vp-db-backup.log 2>&1
15 * * * * root /srv/docker/voltpilot/tools/backup/vp-db-backup-check.sh >> /var/log/vp-db-backup-check.log 2>&1
```

**Secrets:** keine neuen.
Die Skripte lesen `POSTGRES_USER`/`POSTGRES_DB` aus dem laufenden Container; die Replikations-Verbindung läuft über den Unix-Socket im Container (`local replication ... trust` ist die Standard-pg_hba des Images - kein Passwort, keine pg_hba-Änderung, kein neuer Benutzer).

## Täglicher Betrieb

- **Sehen, dass es läuft:** `systemctl list-timers 'vp-db-*'` und `journalctl -u vp-db-backup.service -n 30`.
- **Der Alterscheck ist der Wächter:** `vp-db-backup-check.sh` (stündlich) wird rot (Unit failed, sichtbar in `systemctl --failed`), wenn das jüngste Basis-Backup älter als 26 h ist, die jüngste WAL-Archivdatei älter als 60 min, oder der Archiver im Fehlerzustand ist. Von Hand: `/srv/docker/voltpilot/tools/backup/vp-db-backup-check.sh` (Exit 0 = gut, jede Zeile sagt was).
- **Platz im Blick behalten:** `du -sh /srv/backup/voltpilot-db/*` - der Backup-Lauf loggt die Belegung bei jedem Lauf mit.
- Ein einzelner fehlgeschlagener Backup-Lauf ist kein Notfall (das WAL-Archiv läuft weiter, PITR bleibt lückenlos); zwei in Folge sind einer.

## Restore-Runbook

Vorab-Fakten, die man im Ernstfall nicht suchen will:

- Compose-Projekt `voltpilot`, Datenvolume `voltpilot_timescale-data`, Deploy-Verzeichnis `/srv/docker/voltpilot`.
- `vp-db-restore.sh` stellt in ein **leeres** Ziel her, niemals über Bestehendes.
- Das Backup-Verzeichnis wird beim Restore **read-only** gemountet - die Wiederherstellung kann die Backups nicht beschädigen.
- Ohne `--target-time` wird bis zum Ende des WAL-Archivs wiederhergestellt (= Verlust höchstens der letzten ~5 min, siehe RPO unten); mit `--target-time` bis zu einem Zeitpunkt (PITR).

### Fall A: TimescaleDB kaputt/verloren, VM lebt

```bash
cd /srv/docker/voltpilot

# 1. Stack stoppen (die App-Dienste sollen nicht gegen eine halbe DB schreiben):
docker compose -f docker-compose.prod.yml down

# 2. Kaputtes Datenvolume beiseite stellen (Beweissicherung; kostet Platz in
#    DB-Groesse - wenn der Platz fehlt, diesen Schritt bewusst auslassen):
docker volume create voltpilot-timescale-broken-$(date +%F)
docker run --rm -v voltpilot_timescale-data:/old:ro -v voltpilot-timescale-broken-$(date +%F):/save \
  alpine sh -c 'cp -a /old/. /save/'

# 3. Datenvolume entfernen und LEER mit den Compose-Labels neu anlegen
#    (up --no-start legt Volumes an, ohne Container zu starten - so gehoert
#    das Volume wieder Compose und `up -d` meckert nicht):
docker volume rm voltpilot_timescale-data
docker compose -f docker-compose.prod.yml up --no-start timescaledb

# 4. Wiederherstellen (juengstes Backup, bis zum Ende des WAL-Archivs):
tools/backup/vp-db-restore.sh --backup /srv/backup/voltpilot-db \
  --dest-volume voltpilot_timescale-data --yes

# 5. Stack starten und pruefen:
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps          # alles healthy?
docker exec voltpilot-timescaledb-1 psql -U voltpilot -d voltpilot -c "SELECT count(*) FROM site"

# 6. SOFORT ein frisches Basis-Backup ziehen - der Cluster laeuft jetzt auf
#    einer NEUEN Zeitleiste, und das neue Backup verankert die neue Kette:
tools/backup/vp-db-backup.sh
```

Danach im Portal stichprobenartig prüfen (Login, eine Anlage, Historie); die Edge-Geräte puffern per Store-and-forward und spielen die Ausfallzeit von selbst nach (Ingest ist idempotent je (device, time)).

### Fall B: "oops" - Datenpanne, Stand von vorhin zurückholen (PITR)

Erst auf ein **Probe-Volume** herstellen und ansehen, dann entscheiden - nie direkt über die Live-DB:

```bash
# Backup-Stand VOR dem Unglueck waehlen (Liste ansehen):
ls /srv/backup/voltpilot-db/base/

tools/backup/vp-db-restore.sh --backup /srv/backup/voltpilot-db \
  --from 20260831T024000Z \
  --target-time '2026-08-31 14:31:00+00' \
  --dest-volume restore-probe --yes

# Ansehen (Wegwerf-Container auf dem Probe-Volume):
docker run -d --name restore-probe -e POSTGRES_PASSWORD=egal \
  -v restore-probe:/var/lib/postgresql/data timescale/timescaledb:2.17.2-pg16
docker exec restore-probe psql -U voltpilot -d voltpilot -c "..."
docker rm -f restore-probe
```

Ist der Stand der richtige, weiter wie Fall A ab Schritt 1 (mit denselben `--from`/`--target-time`-Argumenten in Schritt 4; das Probe-Volume vorher wegräumen: `docker volume rm restore-probe`).
`--target-time` mit Zeitzonen-Offset angeben; der Zeitpunkt muss **nach** dem Ende des gewählten Basis-Backups liegen.

### Fall C: VM komplett verloren

Voraussetzung: `DB_BACKUP_DIR` liegt auf einer Platte, die den VM-Verlust überlebt, oder wird zusätzlich außer Haus kopiert (siehe Grenzen).

1. Neue VM nach `docs/deploy.md` "Erstes Deployment" aufsetzen (git clone, `.env` aus der Passwort-Ablage, MQTT-Zertifikate aus deren Sicherung), aber **noch nicht** `up -d`.
2. Backup-Platte/Kopie einhängen (z. B. wieder als `/srv/backup/voltpilot-db`).
3. `docker compose -f docker-compose.prod.yml up --no-start timescaledb`, dann Fall A ab Schritt 4.
4. keycloak-db wiederherstellen (nächster Abschnitt), dann `up -d`.

### keycloak-db wiederherstellen

Die keycloak-db ist klein und ohne Timescale; ihr Backup ist ein `pg_dump -Fc` unter `/srv/backup/voltpilot-db/keycloak/<Stempel>.dump`.

```bash
docker compose -f docker-compose.prod.yml up -d keycloak-db
docker compose -f docker-compose.prod.yml stop keycloak     # niemand schreibt waehrenddessen
docker exec -i voltpilot-keycloak-db-1 dropdb  -U keycloak --if-exists keycloak
docker exec -i voltpilot-keycloak-db-1 createdb -U keycloak keycloak
docker exec -i voltpilot-keycloak-db-1 pg_restore -U keycloak -d keycloak --no-owner \
  < /srv/backup/voltpilot-db/keycloak/20260831T024000Z.dump
docker compose -f docker-compose.prod.yml up -d
```

TimescaleDB und keycloak-db sind zwei unabhängige Cluster; ein TimescaleDB-Restore fasst die Auth nie an (und umgekehrt).
Nach einem reinen TimescaleDB-PITR können in Keycloak Benutzer existieren, deren Mandant im älteren DB-Stand fehlt - die Admin-Konsole (Benutzer-Seite) zeigt das, Aufräumen von Hand.

## Grenzen (ehrlich)

- **RPO (maximaler Datenverlust) ~5 min:** `archive_timeout=300` erzwingt spätestens alle 5 min ein archiviertes Segment. Verlust betrifft nur die Zeit zwischen letzter Archivierung und Ausfall - und Telemetrie spielen die Edge-Geräte aus ihrem eigenen Puffer nach, sobald der Ingest wieder läuft (48-h-Ring je Gerät); endgültig verloren ist im Normalfall nur, was weder archiviert noch edge-gepuffert war (z. B. die letzten Minuten Fahrplan-/Registry-Schreibvorgänge).
- **Restore-Fenster wächst mit der DB:** Entpacken des Basis-Backups + WAL-Replay laufen mit Platten-/CPU-Geschwindigkeit. Größenordnung: zweistellige GB = Minuten; 1 TB = eher 2-6 h (gzip-Entpacken ist single-threaded ~100-300 MB/s, dazu Replay des Tages-WAL). Bei TB-Skala das Restore-Fenster gegen die Anforderungen halten und ggf. auf häufigere Basis-Backups (kleineres Replay-Fenster) oder einen Standby umsteigen - siehe Ausblick.
- **Backup-Fenster:** `pg_basebackup` läuft online (kein Lock, `--checkpoint=fast`), kostet aber Lese-I/O über die ganze DB. Bei TB-Skala den Timer in ein ruhiges Fenster legen und mit `ionice`/`nice` drosseln, falls nötig.
- **Gleiche Platte = halber Schutz:** liegt `DB_BACKUP_DIR` auf derselben Platte wie `/var/lib/docker`, schützt das Backup gegen Software-/Bedienfehler, nicht gegen Plattenausfall. **Außer-Haus-Kopie ist nicht Teil dieses Inkrements** - empfohlen: `rsync`/restic des Backup-Verzeichnisses auf einen zweiten Host oder S3 (die tar.gz-Basis-Backups + WAL-Dateien sind dafür ideal, weil append-only bis auf die Rotation).
- **Ein Archiv gehört genau einem Cluster:** nie zwei Datenbanken in dasselbe `DB_BACKUP_DIR/wal` archivieren lassen (`archive-wal.sh` verweigert Überschreiben mit abweichendem Inhalt laut - dieser Fehlerfall bedeutet genau das).
- **`monitoring`/Metriken:** der Alterscheck ist ein Kommando + Timer, kein Prometheus-Export. Wenn die §6.3-Monitoring-Lücken (Skalierungs-Gutachten) angegangen werden, gehört `letztes Backup-Alter` als Gauge dazu; bis dahin ist `systemctl --failed` der Alarm.
- **Dev-Stack:** `docker-compose.yml` (dev) bekommt bewusst kein Backup - Wegwerfdaten.

## Ausblick (bewusst nicht in diesem Inkrement)

- Außer-Haus-Kopie (rsync/restic/S3) + Verschlüsselung at rest.
- Streaming-Standby (zweite VM, `primary_conninfo`) sobald das Restore-Fenster bei TB-Skala die Anforderungen reißt - das WAL-Archiv hier ist dafür die halbe Miete.
- Backup-Alter als Prometheus-Gauge (zusammen mit den §6.3-Gauges des Skalierungs-Gutachtens).
