# Demo-Umgebung zum Durchklicken

Das ganze Produkt lokal auf einem Rechner: die UEMS-Welt von Ahrenberg, die Betreiber-Sicht und die Live-Flächen einer
Anlage mit Speicher. Nie gegen Produktion, nie gegen eine echte Box, keine echten Kundendaten.

```bash
infra/local/demo/demo.sh start          # einmal ~15 min (Images, Flyway, Welt 1.10), danach idempotent
infra/local/demo/demo.sh status         # Dienste, Datenfrische, Speicher; Exit ≠ 0, wenn etwas fehlt
infra/local/demo/demo.sh rundgang       # Login `rundgang`: jede UEMS-Fläche mit Daten (Teil von start, idempotent)
infra/local/demo/demo.sh stop           # anhalten, Daten bleiben
infra/local/demo/demo.sh zuruecksetzen  # Container UND Volumes weg, dann neu aufbauen
```

Portal: **http://localhost:5173** (gebautes Portal im Container `voltpilot-portal`, nginx reicht `/api` an die api).
Voraussetzungen: Docker, JDK 21, Node.js 22.

## Was läuft

| Teil | Woher |
|---|---|
| Stapel, Seed 1.4, Welt der Referenzdatei 1.10, Bühnen-Uhr 30.04.2029 | `infra/local/pruefumgebung/ahrenberg.sh aufbauen` im Projekt `voltpilot-demo` ([Prüfumgebung](../../../docs/agents/root/uems-pruefumgebung.md)) |
| Simulierte Box der Anlage „Demo Site Berlin“ (Mandant `demo`) | `edge-simulator` → EMQX → ingest → Redpanda → writer |
| Simulierte Boxen der drei Ahrenberg-Anlagen (Mandant Ahrenberg) | `edge-sim-ahrenberg-halle1/-halle2/-lindach` mit je eigenem Profil passend zur Referenzwelt: Halle 1 steuernd (PV + Speicher + Lastspitzenkappung), Halle 2 und Werk Lindach reine Messung ohne Einspeisung ([Profile](../../../tools/edge-simulator/README.md)) |
| Börsenpreise, Wetter, Prognose, Fahrplan, Ersparnis-Simulation | `market-data`, `weather-collector`, `forecast-collector`, `optimizer`, `simulation` (Preise und Wetter aus dem Internet) |
| Demo-Zugänge | `pruefer` (Einsicht bei Ahrenberg, über `ahrenberg.sh einsicht`), zwei Demo-Kundenbereiche für das Vertragsende über die Betreiber-Routen; einer davon ist beendet |

Die Logins des lokalen Realms (`jonas`, `support-voss`, `demo`, …) stehen in
`infra/local/keycloak/voltpilot-realm.json`. Die Passwörter der hier angelegten Konten erzeugt das Skript zufällig und
schreibt sie nur nach `~/.voltpilot-demo/zugang.txt` (Rechte 600, Pfad über `DEMO_ZUGANG`).

## Rundgang: ein Login für alles aus dem UEMS-Programm

`demo.sh rundgang` (auch am Ende von `start`) legt den Kundenadministrator `rundgang` bei Ahrenberg an (über
`POST /api/v1/benutzer`, Passwort nach `$DEMO_ZUGANG`) und fährt `DemoRundgangAufbau` (Testquelle, nur mit
`-Drundgang.jdbc`):

- „Messen & Auswerten“ an ST-1 und ST-2, eingerichtet nach der Zeitachse der Referenz (01.10./15.10.2026). Die Welt legt
  die Funktion nie an, und ohne einen messenden Standort blendet das Portal Messstellen, Bezugsgrößen, Kennzahlen,
  Berichte, Bewertung, Ziele und Energiemanagement aus (`ebenenNav.ts`, `ebenenBereiche`). `eingerichtet_am` ist ein
  direkter Stand: keine Route setzt ihn für „Messen“.
- Ablesungen an MS-20 und Monatswerte an BZ-1 ab 10/2024 über die Routen des Portals, bis zum letzten abgeschlossenen
  Monat der echten Zeit; danach ein Kennzahl-Lauf. Alle sechs Kennzahlen der Welt lesen MS-20 ÷ BZ-1.

## Was die Datei `docker-compose.demo.yml` ändert

- Init-SQL, Realm und Login-Theme stecken im Image statt als Bind-Mount: die Demo läuft weiter, wenn der
  Arbeitsbaum verschwindet, aus dem sie gestartet wurde.
- Speichergrenzen und kleinere Heaps: der Stapel braucht ≈ 2,7 GiB und teilt sich die Docker-VM mit Testläufen.
- `max_connections=200`: das Tuning für 1 GB setzt sonst 25, und der Welt-Aufbau bekommt neben der Live-Strecke keine
  Verbindung mehr.

## Abnahme einer API-Änderung neben der Demo

Die laufende Demo bleibt, wie sie ist; eine geänderte API läuft daneben auf einer Kopie der Demo-Datenbank.

- Kopie als Klartext, die Demo wird nur gelesen: `docker exec voltpilot-timescaledb pg_dump -U voltpilot -Fp voltpilot | sed "/^SELECT pg_catalog.set_config('search_path', '', false);$/d" > demo.sql`.
  Ein Wegwerf-Container aus `voltpilot-demo-timescaledb` (eigener Port, `POSTGRES_DB=voltpilot_init`) bekommt die Rollen `voltpilot_app` (ohne BYPASSRLS) und `voltpilot_admin` (BYPASSRLS) mit eigenen Passwörtern, dann `CREATE DATABASE voltpilot`, `CREATE EXTENSION timescaledb`, `timescaledb_pre_restore()`, `psql < demo.sql`, `timescaledb_post_restore()` und `ANALYZE`.
  Das dauert für die Demo rund 15 Sekunden; danach stimmen Zeilenzahlen und `pg_constraint` mit der Demo überein (bis auf die laufende Telemetrie).
- ⚠ Kein `pg_restore` aus `-Fc`: es setzt `search_path` leer, und CHECK-Regeln, die Funktionen ohne Schema rufen (`bezugsarten()`, `messreihe_ereignis_vokabular()`), lassen das Laden von `bezugsgroesse`, `messreihe_korrektur` und den Chunks von `messreihe_ereignis` scheitern, mit ihnen die Fremdschlüssel darauf.
  Genau diese eine Zeile entfernt der `sed` oben.
- Die API vom Host: `POSTGRES_JDBC_URL` auf die Kopie setzen (der Vorgabewert ist die Demo-Datenbank), `MQTT_BROKER_URL` und `KEYCLOAK_ADMIN_BASE_URL` auf einen toten Port, alle `VOLTPILOT_*_MQTT_LISTENER_ENABLED=false` (der Status-Zuhörer der Datenquellen steht sonst auf `true`), `OIDC_ISSUER_URI=http://localhost:8081/realms/voltpilot` mit den Schlüsseln von dort, `VOLTPILOT_PRUEFUMGEBUNG_BUEHNEN_UHR` wie die Demo.
- Das Portal mit `VITE_API_BASE=` bauen und mit der CSP des Demo-Portals ausliefern; im Test-Browser `http://localhost:5173/**` umleiten (die Anmeldung bei Keycloak bleibt gültig): `/api/` an die eigene API, alles andere an die eigene Vorschau.

## Fallen

- Zwei Zeitachsen: das Energiemanagement liest auf der Bühne (30.04.2029), Portal, Live-Flächen, Unterstützung und
  „Stand am“ laufen auf dem echten Datum. Standorte und Messstellen zeigen den Stand der Welt erst mit „Stand am“
  30.04.2029.
- `demo.sh start --neu` baut das Portal aus dem aktuellen Arbeitsbaum; `start` ohne `--neu` behält das gebaute Portal.
  Plattform-Konten sehen die Plattform-Seiten erst mit #1294 (seit 27.09.2026 im Sammelzweig).
- Bezugswerte gibt es nur für Monate, die in echter Zeit vorbei sind: `bezugsgroesse_wert_abgeschlossen_chk` verlangt
  Periodenende ≤ `created_at`. Die Kennzahl-Werte liegen darum auf der echten Zeitachse, das Energiemanagement auf der
  Bühne. Ablesungen verlangen ab vier Stellen Tausenderpunkte („1.250.000“), sonst 422 „nicht negativer Zählerstand“.
- Die Container tragen die festen Namen `voltpilot-*`: ein Entwicklungs-Stapel oder die Prüfumgebung daneben geht
  nicht; `demo.sh start` bricht dann ab und fasst nichts an.
- MS-03 „PV-Erzeugung Dach Halle 1“ ist die eine Messstelle, die automatisch von einem Gerät liest: die Mess-Seite der
  Box Halle 1 (`edge-mess-ahrenberg-halle1`, `tools/edge-simulator/uems_messbox.py`) liefert den Ertragszähler des
  Wechselrichters, der Rundgang legt Datenquelle („Vorschlag übernehmen“), eigenen Messwert und Quelle über die Routen an.
  Ein Wert zählt nur mit vollständiger Herkunft: Komponente mit Datenquelle und zuständiger Box, Gerät zur Messzeit und
  die Quittung der Auswahl (`MesswertHerkunft`). Werte vor der Quittung gibt es nicht; Tag und Woche füllen sich darum
  ab dem Tag der Einrichtung Tag für Tag.
  Die Sequenz eines Umschlags zählt Umschläge (Messzeit ÷ Kadenz), nicht Sekunden: sonst meldet der Writer je Umschlag
  `sequence_gap`.
