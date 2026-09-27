# Demo-Umgebung zum Durchklicken

Das ganze Produkt lokal auf einem Rechner: die UEMS-Welt von Ahrenberg, die Betreiber-Sicht und die Live-Flächen einer
Anlage mit Speicher. Nie gegen Produktion, nie gegen eine echte Box, keine echten Kundendaten.

```bash
infra/local/demo/demo.sh start          # einmal ~15 min (Images, Flyway, Welt 1.10), danach idempotent
infra/local/demo/demo.sh status         # Dienste, Datenfrische, Speicher; Exit ≠ 0, wenn etwas fehlt
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
| Börsenpreise, Wetter, Prognose, Fahrplan, Ersparnis-Simulation | `market-data`, `weather-collector`, `forecast-collector`, `optimizer`, `simulation` (Preise und Wetter aus dem Internet) |
| Demo-Zugänge | `pruefer` (Einsicht bei Ahrenberg, über `ahrenberg.sh einsicht`), zwei Demo-Kundenbereiche für das Vertragsende über die Betreiber-Routen; einer davon ist beendet |

Die Logins des lokalen Realms (`jonas`, `support-voss`, `demo`, …) stehen in
`infra/local/keycloak/voltpilot-realm.json`. Die Passwörter der hier angelegten Konten erzeugt das Skript zufällig und
schreibt sie nur nach `~/.voltpilot-demo/zugang.txt` (Rechte 600, Pfad über `DEMO_ZUGANG`).

## Was die Datei `docker-compose.demo.yml` ändert

- Init-SQL, Realm und Login-Theme stecken im Image statt als Bind-Mount: die Demo läuft weiter, wenn der
  Arbeitsbaum verschwindet, aus dem sie gestartet wurde.
- Speichergrenzen und kleinere Heaps: der Stapel braucht ≈ 2,7 GiB und teilt sich die Docker-VM mit Testläufen.
- `max_connections=200`: das Tuning für 1 GB setzt sonst 25, und der Welt-Aufbau bekommt neben der Live-Strecke keine
  Verbindung mehr.

## Fallen

- Zwei Zeitachsen: das Energiemanagement liest auf der Bühne (30.04.2029), Portal, Live-Flächen, Unterstützung und
  „Stand am“ laufen auf dem echten Datum. Standorte und Messstellen zeigen den Stand der Welt erst mit „Stand am“
  30.04.2029.
- `demo.sh start --neu` baut das Portal aus dem aktuellen Arbeitsbaum; `start` ohne `--neu` behält das gebaute Portal.
  Plattform-Konten sehen die Plattform-Seiten erst mit #1294 (seit 27.09.2026 im Sammelzweig).
- Die Container tragen die festen Namen `voltpilot-*`: ein Entwicklungs-Stapel oder die Prüfumgebung daneben geht
  nicht; `demo.sh start` bricht dann ab und fasst nichts an.
