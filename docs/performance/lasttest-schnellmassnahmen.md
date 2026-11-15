# Lasttest-Schnellmaßnahmen (15.11.2026)

Umsetzung der Rangliste aus dem Lasttest `vp-lasttest` (05./06.11.2026, Flotte bis 2 000 Boxen) für die
Schnellmaßnahmen Rang 1–8. Je Maßnahme ein eigener PR; diese Seite hält die Messung im Labor fest, damit ein
späterer Lauf vergleichen kann. **Laborwerte, keine Produktions-Perzentile.**

## Labor

| Teil | Stand |
|---|---|
| Datenbank | `timescale/timescaledb:2.17.2-pg16`, 1,2 GB, `pg_stat_statements`, alle Migrationen der api |
| Broker | `emqx/emqx:5.8.3` (wie `docker-compose.prod.yml`) |
| api | Jar je Stand aus `git archive` gebaut, Container, Profil `local`, **Produktions-Einstellung**: `DB_POOL_MAX_SIZE=30`, `SPRING_TASK_SCHEDULING_POOL_SIZE=8` (gitops `apps/voltpilot/base/api/api.env`) |
| Flotte | 2 000 Boxen in 500 Kundenbereichen (je 4 Anlagen, Privatkunden), Werkzeug `fleet.sql` aus dem Lasttest |
| Bestand | v1-Telemetrie alle 2 h über 56 Tage (9 Chunks, 1,34 Mio. Zeilen), Börsenpreise DE-LU 35 Tage, 6 Releases, gemeldeter Stand je Box |
| Herzschlag | `device_status_seen_at` aller Boxen alle 15 s auf jetzt (die DB-Wirkung des Status-Herzschlags; ohne ihn fielen mehrere Abfragen auf den Telemetrie-Rückgriff, den Produktion überspringt) |

Der Mac war während aller Läufe stark fremdbelastet (Load 30–80). Belastbar sind **Anweisungen, Aufrufe und Buffer**
(lastunabhängig); Laufzeiten nur im Verhältnis innerhalb desselben Fensters, `uptime` steht je Messreihe dabei.
Messfenster: 7 min nach Bereitschaft + 60 s, `pg_stat_statements` zurückgesetzt, Laufzeit je `@Scheduled`-Job aus
`tasks_scheduled_execution_seconds`.

## Ergebnisse je Maßnahme

| Rang | Maßnahme | PR |
|---:|---|---|
| 1 | Größe je Hypertable alle 15 min statt jede Minute | #1900 (gemergt) |
| 2 | Broker-Verluste: Vertrag + Vertragstest; Scrape und Alarm in gitops | #1901 (gemergt), gitops #76 (Captain) |
| 3 | Erlös-Abfragetakt (schon vorher live) | #1854 |
| 4 | `PriceSlots` zwischenspeichern – **nicht gebaut**, Prämisse widerlegt (s. u.) | – |
| 5 | Admin-Flotte: Register einmal, „zuletzt gesehen“ nur ohne Herzschlag, 15 s festgehalten | #1912 |
| 6 | Überwachung sät nur, was fehlt; Flotten-Kennzahlen erst in frischen Chunks | #1913 |
| 7 | Admin-Rolle mit eigenem Hintergrund-Pool | #1914 |
| 8 | Doppelten Index auf `telemetry` ohne Schreibsperre entfernen | dieser PR |

### Rang 1 – Größenmessung

| 7-min-Fenster | `hypertable_size` | DB-Zeit |
|---|---:|---:|
| `main` | 6 × 10,3 s | 61,7 s |
| Rang 1 | 0 (nächster nach 15 min) | 0 |

Je Stunde ≈ 10 min → 41 s DB-Zeit. Job-Status und Optimierer-Zyklus bleiben im 60-s-Takt.

### Rang 2 – Broker-Verluste

1 500 QoS-1-Nachrichten an einen Abonnenten mit dauerhafter Sitzung, der nicht liest (EMQX 5.8.3):
`emqx_delivery_dropped_queue_full` = 499, abrufbar ohne Anmeldung unter `:18083/api/v5/prometheus/stats`.

### Rang 4 – warum kein Zwischenspeicher

Die 57 % aus dem Lasttest (B5) waren die ganzen Erlös-Abfragen, deren Text mit `WITH price_slot …` beginnt.

| | Zeit | Buffer |
|---|---:|---:|
| `price_slot` allein, Zwei-Tage-Fenster | 0,8 ms | 13 |
| Abfragen, die damit beginnen (1 004 Aufrufe in 7 min) | 20–23 ms | ~3 050 |

### Rang 5 – Admin-Flotte (Hintergrundjobs aus, je Route 6 Abrufe)

| Je Berechnung | `main` | Rang 5 |
|---|---:|---:|
| `/admin/edge-updates` | ~2 030 Anweisungen, ~81 500 Buffer | ~20, ~1 200 |
| `/admin/devices` | ~56 000 Buffer | ~2 200 |
| `/admin/fleet` | ~156 000 Buffer | ~102 000 |

Mit 3 gleichzeitigen Tabs rechnet jede Route 1-mal statt 6-mal (Edge-Updates 489 000 → 1 200 Buffer, Geräte
339 000 → 2 300, Übersicht 936 000 → 102 000).

### Rang 6 – Hintergrundjobs (7-min-Fenster)

| | `main` | Rang 6 |
|---|---:|---:|
| `UeberwachungsLaeufer.takt` je Lauf | 191,9 s | 85,6 s |
| 30-Tage-Preisstatistik | 4 412 Aufrufe | 0 |
| Aussaat-`INSERT … ON CONFLICT DO NOTHING` | 8 828 | 0 |
| jüngste Ankunft je Anlage (Flotten-Kennzahlen) | 54 500 Buffer je Takt | 9 000 |
| App-Rolle gesamt | 97,5 s DB, 4,18 Mio. Buffer | 58,4 s DB, 2,91 Mio. Buffer |

### Rang 7 – Admin-Pool (240 s, 8 parallele Kunden-Schleifen, Hintergrund an)

| Pool | `main` (geteilt) | Rang 7 |
|---|---|---|
| Admin, Anfragen | Ø 0,66 ms, max 267 ms | Ø 0,06 ms, max 7 ms |
| Admin, Hintergrund | – | Ø 2,95 ms, max 45 ms |

Mit 2 statt 4 Hintergrund-Verbindungen stauten sich die Sammler (max 6,8 s, 4 wartend) – daher die Vorgabe 4.

### Rang 8 – Doppelter Index

| | mit `idx_telemetry_device_time` | ohne |
|---|---:|---:|
| Größe (10 Teile, `telemetry` 502 MB) | 72 MB | – |
| WAL je v1-Zeile (eine Zeile je Anweisung, 2 × 20 000) | 1 518 / 984 B | 670 / 790 B |
| INSERT während `DROP INDEX` und eines 10-s-Lesers | 7,8 s (schlicht) | 0,5 s (`CONCURRENTLY`) |

„Jüngster Wert je Box“ läuft danach über `uq_telemetry_device_time` (5 Buffer).

## Wiederholen

Werkzeug in [`lasttest-schnell/`](lasttest-schnell/) (eigenes Compose-Projekt `vpls`, Ports 25xxx, keine festen Containernamen –
nie ohne `-f compose.yml` starten, die Repo-Compose-Datei träfe die Demo):

```bash
cd docs/performance/lasttest-schnell
export WT=$(git rev-parse --show-toplevel)
mkdir -p jars jwt results
# Laborschlüssel und JWKS (Token wie der lokale Keycloak, mint.py), JWKS auf :25181
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt/key.pem
python3 -I jwks.py jwt/key.pem > jwt/jwks.json && (cd jwt && python3 -I -m http.server 25181 &)
WT=$WT JAR=/dev/null docker compose -f compose.yml up -d timescaledb emqx
./jar-bauen.sh <commit> main          # api-Jar aus git archive, nie im Worktree
./api-tauschen.sh main                # erster Start migriert
./q.sh -c "create extension if not exists pg_stat_statements"
./q.sh -v lo=1 -v hi=2000 -f fleet.sql && ./q.sh -f bestand.sql && ./q.sh -f releases.sql
nohup ./herzschlag.sh &               # DB-Wirkung des Status-Herzschlags, alle 15 s
./messen.sh main-leerlauf 420         # Fenster: Top-Anweisungen, Scheduler-Laufzeiten, uptime
python3 -I sched.py results/main-leerlauf
ENVFILE=api-ruhig.env ./api-tauschen.sh main && ./admin-routen.sh main-admin 6 1   # Rang 5, Hintergrund aus
./admin-pool-last.sh main-poollast 180 8 && python3 -I hikari.py results/main-poollast   # Rang 7
./q.sh -f rang8.sql                   # Rang 8: Indexgröße, WAL je Zeile mit/ohne Doppelindex
touch herzschlag.stop; docker compose -f compose.yml --profile jvm down -v
```
