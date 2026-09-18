# AP-14 IP-11: Generalprobe und Rückweg

Der Betreiber fährt diese Werkzeuge **ausschließlich auf seinem Kopie-Rechner**.
Die Crew bekommt nur `probe.json` und `rueckweg.json`, niemals die Datenbank,
Sicherung, Zugangsdaten oder private Zustandsdatei. Kein Produktionscode, keine
Migration und kein Deployment werden durch dieses Paket geändert.

## Voraussetzungen und Sicherheitsgrenze

- Bash, Python 3.10+, Docker mit **lokalem Unix-Socket** und freie Kapazität für
  Datenbank + eine API. Kein Compose, keine festen Host-Ports. Die Werkzeuge
  erzeugen ein eigenes internes Docker-Netz ohne externen Zugang.
- Ein **bereits physisch wiederhergestelltes**, nicht anderweitig eingebundenes
  Docker-Volume mit Präfix `vp-generalprobe-` und Label
  `org.voltpilot.generalprobe.copy=true`. Auch ein gestoppter fremder Container
  mit diesem Volume sperrt den Start. Bind-/Netzwerk-Volumes werden abgelehnt.
- `--ich-bin-eine-kopie` **und** eine betreibergepflegte Policy sind Pflicht.
  `policy.example.json` kopieren: `copy_volume` und `copy_database` müssen exakt
  stimmen. In `deny_hosts` die Namen aller Produktionsrechner/Docker-Engines,
  in `deny_databases` und `deny_volumes` die Produktionsziele eintragen; Wildcards
  sind erlaubt, jede Liste muss nichtleer sein. Geprüft werden Rechnername,
  Docker-Engine-Name, der feste Kopie-Alias, DB-Name und Volume. Eine Kopie darf
  ihren ursprünglichen DB-Namen behalten, wenn er nicht auf der Sperrliste steht.
- Das Label wird beim Anlegen eines **neuen leeren** Volumes gesetzt; niemals
  einen bestehenden Produktionsdatenträger nachträglich als Kopie markieren.
  Die Policy ist eine Betreibererklärung, kein Herkunftsbeweis aus Kundendaten.
  Zusätzlich verhindert das interne Netz Zugriffe der API auf externe DBs,
  Broker, Boxen oder Keycloak. Ein bösartiges API-Image ist nicht Teil dieses
  Vertrauensmodells; nur die zuvor gebauten/geprüften Release-Images verwenden.
- Neue und alte API liegen lokal als verschiedene Image-Referenzen vor, am
  besten per Digest. Die alte API muss dem tatsächlich ausgelieferten `main`
  entsprechen. Das Werkzeug baut/pullt keine Images. Das DB-Image entspricht
  `tools/backup/vp-db-restore.sh`: `timescale/timescaledb:2.17.2-pg16`;
  `--db-image` muss zur Sicherung passen.
- Für reale Kundenbereiche benötigt der Rechte-Läufer auch eine **Keycloak-Kopie**.
  Optional `--keycloak-container` auf einen bereits laufenden, ebenso mit dem
  Kopie-Label versehenen Container richten. Er darf nur interne Netze und keine
  veröffentlichten Ports haben; das Werkzeug verbindet ihn zeitweise als
  `copy-keycloak:8080`. Realm/Client: `voltpilot`/`voltpilot-api`; Client-Secret
  nur über `GENERALPROBE_KEYCLOAK_SECRET`. Ohne diese Kopie kann Z05 auffällig
  sein; das wird ausdrücklich als Exit 22 vorgelegt, nicht als bestandener Lauf.

Die Skripte starten nur eigene Container mit Zufallspräfix. Beim Ende entfernen
sie diese und ihr Netz, **nie ein Daten- oder Sicherungsvolume**, nie fremde
Container. Die Kopie bleibt nach der Probe offline erhalten. Eine übergebene
Keycloak-Kopie bleibt laufen; entfernt wird nur die eigene Netzverbindung.
Docker-Logs sind für die gestarteten Container abgeschaltet; API-Text wird im
Speicher auf feste Fehler-/Läufer-Muster reduziert und sofort verworfen. Auch
Fehler von SQL und Restore gelangen nicht ins Protokoll. Nicht mit Shell-Tracing
oder einem externen Rohlog-Mitschnitt betreiben.

## Vorbereiten und aufrufen

Zunächst mit dem bestehenden [Restore-Werkzeug](../backup/vp-db-restore.sh)
Basis-Backup + WAL auf dem Kopie-Rechner wiederherstellen. Beispiel für ein
neues Ziel (alle Pfade und Sicherungsangaben sind **Betreibereingaben**):

```sh
docker volume create --label org.voltpilot.generalprobe.copy=true vp-generalprobe-kopie
bash tools/backup/vp-db-restore.sh --backup /BETREIBER/SICHERUNG \
  --dest-volume vp-generalprobe-kopie --target-time '2026-09-18 20:00:00+00' --yes
```

Eine private Datei `credentials.json` mit Modus **0600** enthält genau diese
Schlüssel; Passwörter kommen vom Betreiber, nicht aus der Kommandozeile:

```json
{
  "database": "voltpilot",
  "postgres_user": "voltpilot",
  "postgres_password": "BETREIBERWERT",
  "app_user": "voltpilot_app",
  "app_password": "BETREIBERWERT",
  "admin_user": "voltpilot_admin",
  "admin_password": "BETREIBERWERT"
}
```

Die Lesemessung benötigt Superuser oder BYPASSRLS (sonst wären Zählungen unter
Mandanten-RLS irreführend). Die API selbst verwendet weiterhin `voltpilot_app`,
Flyway die Migrationsrolle und die Bestands-Läufer die Admin-Rolle. Es werden
keine frei übergebenen Spring/JDBC-URLs oder Java-Optionen übernommen.

```sh
bash tools/generalprobe/probe.sh --ich-bin-eine-kopie \
  --policy /BETREIBER/policy.json --credentials /BETREIBER/credentials.json \
  --volume vp-generalprobe-kopie \
  --new-image REGISTRY/api@sha256:NEU --old-image REGISTRY/api@sha256:ALT \
  --state /BETREIBER/vorher-privat.json --output /BETREIBER/probe.json
```

Dateien werden ausschließlich neu mit Modus 0600 angelegt, nicht überschrieben.
Die private Zustandsdatei hält Fingerabdrücke der vollständigen Flyway-Historie
und des unveränderten Vorher-Blatts Q01. Sie gehört zum genau notierten
Wiederherstellungszeitpunkt **vor dieser Probe**. Bei einer Wiederholung zuerst
wiederherstellen und neue Dateinamen wählen. Das Werkzeug setzt keinen
Produktions-Wiederherstellungspunkt und öffnet kein Produktions-Wartungsfenster.

`--timeout` (Vorgabe 900 s) ist das Beobachtungsbudget, **nicht** eine Verlängerung
des Deployment-Startbudgets. Der Bericht prüft dessen feste 180 s separat.

## Ausgabe lesen

Die JSON-Datei enthält nur feste Rubriken, Zähler, Dauern in Millisekunden,
0/1-Prüfwerte und `null` für nicht bekannte Werte. Keine Kennungen, Kundennamen,
Seriennummern, Zeitstempel, SQL-Zeilen, Versionsbezeichnungen oder Passwörter.

- **A:** ausschließlich seit dem Vorher-Stand neu eingetragene Migrationen,
  `je_migration_ms` in Ausführungsreihenfolge, Summe, zehn längste Dauern. Die
  Zuordnung zu Skripten bleibt beim Betreiber in `flyway_schema_history`.
  D4: Fenster = Summe × 3, mindestens 1 800 000 ms. `start_ms` misst bis zur
  ersten erfolgreichen Readiness; `laeufer_abwarten_ms` bis zum Abschluss der
  drei Bestands-Läufer. `startbudget_reicht=0` heißt ausdrücklich: drei Minuten
  reichen nicht oder Bereitschaft konnte nicht nachgewiesen werden.
- **Sperren in A:** etwa alle 250 ms plus Abfragedauer `pg_locks.waitstart`,
  `pg_stat_activity`, Muttertabelle `device_measurement_sample` und ihre
  Timescale-Chunks; Ende bei der Flyway-Erfolgsmeldung. Fehlt diese, bleibt
  die Zeitgrenze unbelegt und der Lauf wird unvollständig (23). Gemessen wird die **längste beobachtete bisherige Wartezeit**
  einer nicht gewährten Relationssperre, keine exakte abgeschlossene Dauer,
  keine Sperrhaltezeit, keine Transaktions-/Advisory-/Index-Sperre. Kurze Wartezeiten
  zwischen Stichproben werden verpasst. Ohne Writer-Last beweist 0 keinen
  unterbrechungsfreien Produktionsbetrieb. Fehlende Stichproben/Abfragefehler
  machen den Nachweis unvollständig (23).
- **B:** `voltpilot_uems_bestandslaeufer_total{laeufer,ergebnis}` für Standort,
  Funktion und Rechte. Zusätzlich muss der Abschlusszustand `gelaufen` vorliegen.
  Nur wenn die Metrik des Läufers fehlt, zählt die feste aggregierte Log-Zeile
  als Ersatz (`metrik=0`, `betrachtet` statt `erledigt`). Keine Log-Zeile bedeutet
  unbekannt, niemals null erledigte Kundenbereiche.
- **C:** sämtliche SQL-Abfragen Z01–Z07 aus dem unveränderten
  [Nachher-Blatt](../betriebsabfragen/bestand-nach-rollout.sql), in lesenden
  Transaktionen. Nur freigegebene Zählspalten werden übernommen; Z01-Dauern
  stehen gezielt für diese Probe in A statt im unscharfen Tagesfenster. Die
  Rubriken A–C sind die Berichtsteile; das Nachher-SQL selbst hat keine A–C-Titel.
- **W1:** neue API wird beendet, alte API wird genau einmal gestartet.
  `bereit=1` bedeutet, dass sie im beobachteten Start nicht brach — es ist kein
  Beweis aller alten Endpunkte. Bei einem Bruch stehen nur feste Fehlerklassen
  und Stellen im Bericht: Flyway/Initialisierung, Schema/SQL-Abfrage oder
  Start/unbestimmte Stelle. `flyway_diagnose` und `flyway_reparaturen` zählen auch
  abgefangene Startdiagnosen; bei erreichter Readiness sind sie kein Startabbruch.
  Nach erreichter Readiness wird weitere fünf Sekunden beobachtet;
  `flyway_historie_veraendert` prüft danach, ob die alte API die neue
  Flyway-Historie verändert hat (etwa durch ihre Selbstheilung). `ungeprobt=1` ist ausdrücklich kein W1-Nachweis.
- `pruefen_Z03` und `pruefen_Z05` sind **Prüfaufträge an den Betreiber**.
  Jede eingerichtete Anlage wird konservativ zur Prüfung vorgelegt; das
  Werkzeug behauptet nicht, aus der Zählung zu wissen, welche Anlage steuert.
  Bei mehreren Auffälligkeiten stehen alle Zähler im Bericht, der Exit nennt
  die erste nach der unten stehenden Priorität.

## Rückweg (NW-8)

Neues leeres Kopie-Volume mit Label anlegen, eine zweite Policy mit dessen
`copy_volume` bereitstellen. Die migrierte Kopie wird nicht gelöscht. Dann:

```sh
bash tools/generalprobe/rueckweg.sh --ich-bin-eine-kopie \
  --policy /BETREIBER/rueckweg-policy.json --credentials /BETREIBER/credentials.json \
  --volume vp-generalprobe-rueckweg --state /BETREIBER/vorher-privat.json \
  --backup /BETREIBER/SICHERUNG --from-backup 20260918T190000Z \
  --target-time '2026-09-18 20:00:00+00' --output /BETREIBER/rueckweg.json
```

`rueckweg.sh` ruft tatsächlich `tools/backup/vp-db-restore.sh --target-time …`
auf. Zeit bis zum fertigen Datenverzeichnis steht in `wiederherstellung_ms`.
Danach startet nur die Datenbank: komplette Flyway-Historie **und Q01** müssen
bytegleich im kanonischen Fingerabdruck sein. Keine API startet am Rückweg.
Das Ziel bleibt als offline nutzbare Kopie für weitere Übungen erhalten.

### Writer-Verbrauchergruppe zurücksetzen — Vorlage für IP-13

```sh
bash tools/generalprobe/writer-ruecksetzen-dry-run.sh
```

Dieses Skript **druckt nur** den vollständig ausgeschriebenen Befehl mit
unaufgelösten Umgebungsvariablen. Es führt weder `rpk` noch eine Broker-Verbindung
aus. Die Vorlage verwendet `rpk --config "${RPK_CONFIG:?}" group seek
"${WRITER_GROUP:-timescale-writer}" --to "${WRITER_REPLAY_EPOCH_MS:?}"
--topics "${WRITER_TOPICS:-telemetry.raw,telemetry-v2.raw,measurements.raw,events.raw}"
--allow-new-topics`, davor/danach `group describe`.

Die Syntax wurde mit **rpk aus `redpandadata/redpanda:v24.2.7`** (`group seek
--help`) geprüft: Unixzeit in Sekunden/Millisekunden/Nanosekunden, hier
Millisekunden. Kein erfundenes `rpk --dry-run`; `seek` würde direkt schreiben.
Gruppe und vier Topics sind am Writer-Code und seiner `application.yml` geprüft.
Alle vier Consumer verwenden dieselbe Gruppe; abweichende produktive Werte
muss IP-13 in die Betreibervariablen übernehmen. [rpk-Referenz](https://docs.redpanda.com/streaming/current/reference/rpk/rpk-group/rpk-group-seek/).

Vor echter Ausführung: Writer auf null, keine Gruppenmitglieder, Aufbewahrung
bis zum gewählten Zeitpunkt vorhanden. Bus-Zeitstempel sind keine DB-Commitzeit:
Rückstand vor dem Wiederherstellungspunkt kann ein **früheres** Replay-Ziel
verlangen; den notierten Gruppenoffset am Punkt und die Reserve im Drehbuch
beachten. Diese Vorlage setzt nichts selbst zurück und beweist keinen
Produktions-Replay. `--allow-new-topics` berücksichtigt auch neue Topics ohne
bisherigen Commit der Gruppe.

## Benannte Exit-Codes

| Code | Bedeutung |
|---|---|
| 0 | Alle verlangten Beobachtungen abgeschlossen; Bericht lesen, kein Deployment-Go |
| 10 | Kopie-Schalter fehlt |
| 11 | Konfiguration, Policy oder private Datei fehlt/ungültig |
| 12 | Gesperrtes Ziel, Remote-Docker, unmarkiertes/belegtes/ungeeignetes Volume |
| 13 | Werkzeug-/SQL-/Dateifehler; Rohfehler bewusst nicht ausgegeben |
| 14 | Unterbrochen; eigene Probe-Container werden entfernt, Volumes bleiben |
| 20 | Migration gescheitert; keine alte API mehr starten |
| 21 | Z03: eingerichtete Anlagen; Betreiber muss gegen Steuerbestand prüfen |
| 22 | Z05: Kundenbereiche ohne Stichtag; Betreiber muss Ursache erklären |
| 23 | Readiness, Läuferabschluss oder Sperrmessung unvollständig/fehlerhaft |
| 24 | Deployment-Startbudget 180 s reicht nicht |
| 25 | Alte API fehlt lokal: W1 UNGEPROBT |
| 30 | Physische Wiederherstellung gescheitert |
| 31 | Flyway-Stand oder Q01 am Rückweg abweichend |

## Prüfen ohne Produktionsdaten

```sh
python3 -m unittest discover -s tools/generalprobe -p 'test_*.py'
shellcheck tools/generalprobe/*.sh
JAVA_HOME=/PFAD/ZU/JDK21 tools/generalprobe/test-fixture.sh \
  --new-jar /NEU/voltpilot-api.jar --old-jar /MAIN/voltpilot-api.jar \
  --artifacts /tmp/generalprobe-neuer-nachweis
```

Beide Jars zuvor im jeweiligen Checkout mit `./mvnw clean package -DskipTests`
bauen. Der macOS-Nachweis wartet selbst auf **0 laufende Container und mindestens
35 % freien Speicher**, bevor er höchstens zwei Container gleichzeitig nutzt.
Er bildet die physische Mechanik von `tools/backup/test-backup-restore.sh` nach,
verwendet dieselben echten Backup-/Restore-Skripte und den **exakten** Satz aus
`services/api/src/test/resources/migration/main-migrations.txt` (keine
Versionsobergrenze), wie `UemsProduktionsreihenfolgeMigrationTest`. Jede
Ressource hat ein eigenes Präfix; nur die Fixture entfernt am Schluss auch ihre
eigenen Volumes/Images. Ein zufälliger Loopback-Port wird nur für die initiale
Flyway-Fixture benötigt, die Operator-Werkzeuge öffnen keinen Host-Port.

Der Nachweis enthält einen synthetischen Kundenbereich mit Anlage und keine
Keycloak-Kopie: Z03/Z05 müssen damit ausdrücklich die Betreiberprüfung auslösen.
Eine echte Relationssperre vor dem Backup prüft zusätzlich den Messpfad.
Der Nachweis ist synthetisch und enthält keine Keycloak-Kopie. Er ersetzt keine
Probe mit realer Datenmenge/Last und keine Hardwareprüfung. Die beiden
JSON-Ausgaben können an den PR; private Dateien und Fixture-Logs bleiben lokal.
