# Performance-Baseline

Erster Lauf: 08.11.2026, Stand `main` @ `373e67f09` plus die Zeitgrenzen-Fixes aus `vp-wartung-perf-p1`.
Gemessen im lokalen Labor (`baseline/labor.sh`), nie gegen Produktion.
Die Zahlen sind Labor-Werte und keine Produktions-Perzentile.

**So vergleicht der nächste Lauf:** dieselben Befehle (Abschnitt „Wiederholen“), dann je Tabelle eine Spalte mit Datum, Stand und Host-Last anfügen.
Absolute Zeiten nur bei ähnlicher Host-Last vergleichen; Statement- und Buffer-Zahlen sind lastunabhängig und immer vergleichbar.

## Labor und Last

| Teil | Stand |
|---|---|
| Datenbank | `timescale/timescaledb:2.17.2-pg16`, `pg_stat_statements` an, alle Migrationen der api |
| Keycloak | 26.0.5 unter `/auth`, Realm aus `infra/local/keycloak` plus Labor-Redirect |
| api | Jar aus diesem Checkout, JDK 21, Profil `local`, OIDC an; MQTT, Keycloak-Admin und Simulation auf toten Ports |
| Portal | `vite build` mit leerem `VITE_API_BASE` hinter der Prod-`nginx.conf` (gzip, Cache-Header, CSP) |
| Bestand | `demo2` („Zuhause“): vier Monate wie im Betrieb (`baseline/befuellung-4-monate.sql`), danach Kompaktierungs- und Sparzeilen-Job; `demo`: Dev-Seed mit drei Anlagen |
| Browser | Chrome stable über `playwright-core`, CSP-echt, ohne `bypassCSP` |

Der Host war während des ganzen Laufs stark fremdbelastet (Load-Mittel 120 bis 520 durch parallele Sitzungen).
Jede Tabelle nennt die Last, unter der sie entstand.

## Startzeit der api

| Fall | `Started ApiApplication in` | bereit (`/health/readiness`) | Flyway | Load |
|---|---:|---:|---:|---:|
| kalt, leere DB, 378 Migrationen | 71,3 s | 75,7 s | 38,2 s | 6 bis 119 |
| kalt, leere DB, 378 Migrationen | 186,3 s | 201,9 s | 88,7 s | 235 |
| warm (Lauf 1/2/3) | 17,7 / 18,8 / 57,1 s | 19,6 / 23,5 / 65,9 s | - | 124 / 147 / 158 |

## Antwortzeiten der Endpunkte

`baseline/endpunkte.py demo2 <site> <standort> 20 <label>`: je Endpunkt zwei Aufwärm- und 20 Messaufrufe, Zeit bis zum ersten Byte durch den Labor-nginx mit gzip.
Anlage „Zuhause“ mit vier Monaten Bestand; Load 402 bis 376.

| Endpunkt | p50 ms | p95 ms | gz-Bytes | Wo auf dem Nutzerweg |
|---|---:|---:|---:|---|
| `me` | 502 | 828 | 1080 | Boot |
| `sites` | 376 | 556 | 317 | Boot |
| `devices` | 450 | 830 | 246 | Boot, alle 30 s |
| `tenant-context` | 151 | 239 | 105 | Boot |
| `standorte` | 467 | 634 | 363 | Boot |
| `unternehmen` | 266 | 651 | 189 | Boot |
| `funktionen` | 203 | 455 | 417 | Boot |
| `overview` | 1093 | 2245 | 582 | Erstbild des Cockpits, alle 10 s |
| `portfolio/kpis` | 245 | 332 | 193 | Portfolio, einmal je Aufruf |
| `topology` (Fluss) | 89 | 132 | 585 | alle 10 s |
| `schedule` (Tagesleiste, Plan) | 149 | 209 | 7705 | alle 30 s |
| `history?range=day` (Tagesleiste, Messung) | 476 | 654 | 1400 | alle 30 s |
| `earnings?range=day` | 864 | 1863 | 942 | alle 30 s |
| `bilanz?periode=tag` | 251 | 386 | 149 | Cockpit |
| `rollen/pv` | 206 | 396 | 120 | alle 10 s (mit `consumer`, `grid`) |
| `profiles` | 644 | 1391 | 945 | Cockpit |
| `entities` | 222 | 265 | 692 | Cockpit |
| `cockpit-layout` | 274 | 383 | 632 | Cockpit |
| `control-status` | 268 | 401 | 0 (204) | alle 10 s |
| `sources` | 177 | 281 | 28 | Cockpit |
| `weather` | 294 | 541 | 367 | Cockpit |
| `standorte/{id}/ausfall` | 189 | 459 | 214 | Cockpit |
| `history?range=year` | 2146 | 3885 | 3477 | Reiter „Verlauf · Jahr“ |
| `earnings?range=year` | 3449 | 5503 | 1085 | Reiter „Erlöse · Jahr“ |

Bei dieser Last sind die Zeiten um ein Vielfaches aufgebläht.
Gegenprobe bei Load 190: `sites` 121 ms, `overview` 392 ms, `portfolio/kpis` 613 ms, `topology` 98 ms (`demo`, drei Anlagen, Dev-Seed, drei Läufe).

### SQL je Endpunkt (lastunabhängig)

`baseline/sqltrace.sh demo2 <pfad>`: ein warmer Aufruf, danach die Statements der App-Rolle aus `pg_stat_statements`.
Vergleich mit dem Bericht `vp-anlagen-cockpit-perf` vom 04.11.2026 (dieselbe Befüllung, damals ohne Kompaktierung).

| Endpunkt | 04.11.2026 | 08.11.2026 |
|---|---|---|
| `schedule`-Zeilen der Anlage | 2.322.624 | 76.731 |
| `overview` | 205 ms SQL, 29 Statements, Sparzeile 259.046 Buffer | 35 ms SQL, 29 Statements, 1.363 Buffer |
| `schedule`, Abfrage des jüngsten Laufs | 972 ms, 2.192.886 Buffer | 0,8 ms, 196 Buffer |
| `history?range=day` | 70 ms SQL | 60 ms SQL, 24 Statements |
| `earnings?range=day` | 81 ms SQL | 31 ms SQL, 22 Statements |
| `history?range=year` | 7,0 s SQL | 470 ms SQL, 563.209 Buffer |
| `earnings?range=year` | 973 ms SQL | 698 ms SQL, 909.169 Buffer |

Je Repository-Aufruf setzt die api die Sitzungsvariablen der Mandantentrennung und setzt sie bei der Rückgabe zurück.
Ein `/overview` erzeugt deshalb 102 Statements der App-Rolle, davon 67 `set_config`; `/profiles` 86, davon 56.

## Nutzerweg im Browser

`frontend/portal`-Bundle hinter dem Labor-nginx, Nutzer `demo2` (eine Anlage), Wasserfall per CDP (Werkzeug aus `vp-anlagen-cockpit-perf`).

| Phase | 04.11.2026 | 08.11.2026 |
|---|---|---|
| API-Aufrufe der Landung | 37 | 36 |
| doppelte Aufrufe der Landung | `overview`, `funktionen`, `devices`, `rollen/*` | nur `rollen/*` (Neuabruf, wenn `/overview` die Live-Zeit bringt) |
| Aufrufe je 10 s offener Cockpit-Seite | 11 | 9 (`earnings`, `schedule`, `history` alle 30 s) |
| Reload: letzte Antwort / LCP | 0,63 bis 1,06 s (Load 8 bis 15) | 0,78 s / 0,74 s (Load um 420) |

### Core Web Vitals

`baseline/vitals.mjs`: je Seite drei volle Dokument-Loads, Median; INP aus einer festen Interaktion (Cockpit: „Heute · kWh“, Portfolio: Reiter „Energie“).
Telefon: 390 × 844, DPR 3, Touch; Rechner: 1440 × 900.
Load 480 bis 524.

| Seite | Breite | TTFB ms | FCP ms | LCP ms | CLS | INP ms |
|---|---|---:|---:|---:|---:|---:|
| Cockpit „Zuhause“ (`demo2`) | Rechner | 12 | 88 | 2984 | 0,101 | 24 |
| Cockpit „Zuhause“ (`demo2`) | Telefon | 46 | 148 | 3924 | 0,014 | 8 |
| Portfolio (`demo`) | Rechner | 17 | 64 | 1308 | 0,054 | 24 |
| Portfolio (`demo`) | Telefon | 10 | 32 | 1496 | 0,170 | 32 |
| Anlage „Demo Site Berlin“ (`demo`) | Rechner | 6 | 32 | 1752 | 0,001 | - |
| Anlage „Demo Site Berlin“ (`demo`) | Telefon | 15 | 44 | 1480 | 0,001 | - |

CLS über 0,1 ist reproduzierbar und lastunabhängig (`--shifts` nennt die Elemente):
- Portfolio am Telefon: der Block „Heute“ erscheint erst nach seinem Datenabruf über „Jetzt“ und „Ihre Anlagen“ (Verschiebung 144 px), danach wächst er um die Tageskurve (130 px).
- Cockpit am Rechner: während das Skelett steht, rutschen die Badges der Kopfzeile um 103 px und das Skelett um 54 px nach unten; danach rutscht der Hero-Block um weitere 103 px.

## Bundle des Portals

`npm run build`, dann `baseline/bundle.py frontend/portal/dist` (gzip -9) und `npm run test:bundle` (Grenzen).

| Größe | Wert | Grenze |
|---|---:|---:|
| `dist` gesamt | 10,9 MB, 389 Dateien (252 JS, 97 CSS) | - |
| Einstieg `index-*.js` | 783,7 kB roh / 248,5 kB gz (`test:bundle`: 248,73 kB) | 258 kB gz |
| Erstladung (Einstieg + CSS) | 285,9 kB gz | - |
| `useEChart` (Diagramme) | 616,9 kB roh / 206,4 kB gz (`test:bundle`: 207,44 kB) | 210 kB gz |
| `GeraetSeiteSection` | 235,7 / 74,3 kB | - |
| `EnergiemanagementBereich` | 210,8 / 59,2 kB | - |
| `GeraeteRegistryPage` | 177,9 / 50,8 kB | - |
| `DataPages` | 155,1 / 49,1 kB | - |
| `LocationMap` | 154,9 / 45,3 kB | - |
| `index.html` | 24.962 B | 27.000 B |

## Speicher

Nach den Messläufen, api mit `-Xmx2g`.

| Dienst | Belegt |
|---|---|
| api: Heap / Nicht-Heap (`jvm_memory_used_bytes`) | 126 MB / 156 MB (zugesagt 249 MB / 181 MB) |
| api: Threads / Hikari-Verbindungen | 46 / 10 App + 4 Admin |
| TimescaleDB-Container (`shared_buffers` 1 GB) | 1,23 GiB, Datenbank 2,78 GB |
| Keycloak-Container | 653 MiB |
| nginx-Container | 9 MiB |

## Ausfallverhalten

| Fall | Vorher | Nachher | Beleg |
|---|---|---|---|
| Boot: `/api/v1/sites` antwortet nie | Lader steht nach 60 s noch, kein Ausweg | nach 21 s „Daten konnten nicht geladen werden“ mit „Erneut laden“; danach Cockpit in 0,9 bis 2,9 s | `baseline/boot-haenger.mjs`, `apiRequestTimeout.test.ts` |
| Web-Push-Dienst nimmt an und schweigt | Versand-Thread hängt unbegrenzt | Abbruch nach 10 s | `WebPushAdapterTest` |
| SMTP-Server nimmt an und schweigt | Zustell-Lauf hängt, mit ihm jeder `@Scheduled`-Job (ein Scheduler-Thread) | Abbruch nach 30 s | `VersandConfigSmtpZeitgrenzeTest` |
| Keycloak-Admin nimmt an und schweigt | Request-Thread hängt, der Token-Abruf hält alle weiteren auf | Abbruch nach 5 s Aufbau / 20 s Antwort | `KeycloakAdminClientZeitgrenzeTest` |

## Wiederholen

```bash
cd docs/performance/baseline
./labor.sh start                       # DB, Keycloak, nginx auf 15741/15742/15744 (VP_PERF_PORTS=158 für 158xx)
(cd ../../../services/api && ./mvnw -DskipTests package)
./labor.sh api ../../../services/api/target/voltpilot-api-0.1.0-SNAPSHOT.jar   # kalter Start: migriert, druckt die Startzeit
./labor.sh befuellen                   # vier Monate für demo2, dann die Fahrplan-Jobs und ANALYZE
./labor.sh lebendig                    # Boxen melden alle 10 s
./labor.sh portal                      # Bundle bauen, ausliefern, Größen drucken
python3 endpunkte.py demo2 10000000-0000-0000-0000-000000000002 <standort-id> 20 ep-$(date +%F)
./sqltrace.sh demo2 /api/v1/overview overview
node vitals.mjs --user demo2 --vp desktop --pages "cockpit=" --runs 3 --label vitals --interact 'main button:has-text("Heute · kWh")' --shifts
node vitals.mjs --user demo --vp phone --pages "portfolio=" --runs 3 --label vitals-tel --interact 'main [role=tab]:not(.active)' --shifts
node boot-haenger.mjs haenger 40
uptime                                  # Last mitschreiben
./labor.sh stop
```

Die Standort-ID der Anlage „Zuhause“ steht nach dem ersten api-Start in `anlage_standort`.
Warmstart: `./labor.sh stop` ist nicht nötig; die api per PID (`$TMPDIR/vp-perf-labor/api-15743.pid`) beenden und `labor.sh api` erneut rufen.
