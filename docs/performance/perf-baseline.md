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

Je Repository-Aufruf setzte die api damals die Sitzungsvariablen der Mandantentrennung und setzte sie bei der Rückgabe
zurück. Ein `/overview` erzeugte deshalb 102 Statements der App-Rolle, davon 67 `set_config`; `/profiles` 86, davon 56.
Seit 15.11.2026 einmal je Anfrage ([Mandanten-Sockel](mandanten-sockel.md)).

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

## Portal-Reaktivität (Runde 13.11.2026)

Runde `vp-perf-portal-reaktiv`, nur Portal, Stand `b3ed4c5ff`. Der Host lief mit Load 30 bis 80 aus anderen Bahnen.
Seitenzeiten gegen die echte Labor-API streuten so stark, dass eine unveränderte Seite zwischen 1,5 und 6,2 s lag.
Deshalb misst diese Runde im **Wiedergabe-Labor**: Die Antworten der Labor-API (`labor.sh`, Bestand `befuellung-4-monate.sql`)
werden einmal aufgezeichnet und dann je Variante mit fester Antwortzeit wiedergegeben. Server- und Keycloak-Last fallen
damit heraus (`baseline/wiedergabe.mjs`). Der Build wird mit gzip und Cache-Kopf wie in `nginx.conf` ausgeliefert
(`baseline/serve-dist.mjs`), Varianten laufen verzahnt (`baseline/wechsel.mjs`). Bytes, Abrufzahlen und Kettenzeiten
sind lastunabhängig. Absolute Seitenzeiten sind es auch hier nicht: Mobil mit 4-facher CPU-Drosselung streuten sie bei
Load 40 bis 80 zwischen 4 und 11 s.

### Ausgangswerte

JS, das eine Seite in den ersten 8 s lädt (gzip, Einstieg inklusive, ohne Leerlauf-Vorladen; `baseline/js-je-route.mjs`):

| Seite | JS | Stücke |
|---|---:|---:|
| Anlagen-Cockpit `#/anlage/{id}` (demo2) | 355,9 kB | 21 |
| Aufbau `…/modell` | 462,8 kB | 46 |
| Verlauf `…/messwerte` | 526,5 kB | 29 |
| Steuerung › Geräte `…/steuerung` | 391,3 kB | 31 |
| Meldungen `#/meldungen` | 327,4 kB | 24 |
| Übersicht / Portfolio `#/portfolio` (demo, 3 Anlagen) | 560,7 kB | 78 |
| Gerätedetail `…/geraet/{box}/{gerät}` | 765,4 kB | 67 |

Jede Anlagenseite lädt danach im Leerlauf (spätestens nach 4 s) Verlauf und Diagramme vor, rund 250 kB gz (`useVerlaufVorladen`).

Start-Kette jedes Aufrufs (Neuladen, Direktlink), beobachtet im Netzprotokoll:
`Token (refreshStoredTokens)` → `Token (keycloak-js init, updateToken(-1))` → `/me` → `sites, devices, tenant-context, standorte, unternehmen` → Seitendaten.
Beim Anlagen-Cockpit warten 25 bis 34 Seitenabrufe auf diese Kette. Die Rollen (`rollen/pv|consumer|grid`) fragt es einmal vor und einmal nach `/overview`.

Abfragetakte, 65 s offene Seite (`wiedergabe.mjs takt`):

| Seite | Abrufe | davon |
|---|---:|---|
| Übersicht / Portfolio | 16 | `overview` 6, `earnings?range=day` 6, `meldungen/zahl` 2, `devices` 2 |
| Anlagen-Cockpit | 52 | je 7× `topology`, `overview`, `control-status`, `curtailment-status`, `erzeuger/jetzt`, `chargers`; je 2× `earnings`, `schedule`, `history?range=day`, `meldungen/zahl`, `devices` |

React bei 60 s offenem Anlagen-Cockpit (Profiling-Build, Desktop, `wiedergabe.mjs profil`): 47 Übergaben mit zusammen
297 ms Renderzeit. Davon 213 ms im Funktionskörper von `AnlageSeite`, also gut 5 ms je Neu-Rendern. Auslöser sind die Uhr
(alle 5 s) und je eine Übergabe pro Antwort des Live-Takts. Mit 4-facher CPU-Drosselung ergibt das rund 1,2 s Hauptthread
je Minute.

### Geändert

| PR | Was | Nachher |
|---|---|---|
| [#1853](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1853) | Dialoge und Diagramm der Kundenseiten erst beim Öffnen laden (Anlage anlegen samt Leaflet, Steuern einrichten, Geräte-Assistent, Box wechseln, Messwert-Verlauf mit echarts); ihre Stile tragen die Seiten selbst | Übersicht 560,7 → 457,6 kB, Gerätedetail 765,4 → 528,1 kB, Aufbau 462,8 → 447,3 kB, Steuerung 391,3 → 378,7 kB; Einstieg unverändert (256,15 kB gz) |
| [#1854](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1854) | Erlöse im eigenen Takt `ERLOES_POLL_MS` = 5 min statt 10 s (Übersicht, Portfolio-Cockpit) bzw. 30 s (Anlagen-Seite); Lasttest Rang 3 | 65 s offen: Übersicht 16 → 10 Abrufe, Anlagen-Cockpit 52 → 50; `/earnings` je Seite und Stunde 360 bzw. 120 → 12 |
| [#1856](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1856) | Stammdaten beim Start gleichzeitig mit `/me` | Seitendaten starten nach `/me`-Start nach 425 statt 805 ms (150 ms je Antwort, Median aus 5 Läufen; `baseline/start-kette.mjs`) |

### Offene Hebel, nach Wirkung gereiht

1. **Zweiter Token-Abruf vor jedem ersten Bild.** keycloak-js 26 frischt beim `init` mit Tokens immer einmal auf
   (`updateToken(-1)`, `node_modules/keycloak-js/lib/keycloak.js`). Das passiert direkt nach dem eigenen Abruf in
   `refreshStoredTokens`. Das kostet eine Keycloak-Runde je Aufruf. Abhilfe braucht `timeSkew` und den Ablauf-Zeitgeber
   von keycloak-js. Das ist Anmeldung und gehört deshalb in eine eigene Aufgabe mit Auth-Tests.
2. **Seitendaten warten auf die Stammdaten.** Die Anlagen-Seite fragt erst, wenn `/sites` da ist, obwohl die
   Anlagen-ID in der Adresse steht. Abhilfe: nach Route vorab anfragen, mit einem kurzen Teilfenster wie
   `STARTFENSTER_MS` für `/funktionen`.
3. **Live-Takt des Anlagen-Cockpits.** Es fragt sechs Endpunkte alle 10 s ab, rund 42 Abrufe je Minute und offener Seite,
   und rendert dabei je Antwort neu. Abhilfe: unveränderte Antworten behalten (keine Übergabe), Takte bündeln
   (API-seitig ein Live-Lesemodell) und die teuren Ableitungen in `AnlageSeite` memoisieren.
4. **Leerlauf-Vorladen von Verlauf und echarts** (rund 250 kB gz) auf jeder Anlagenseite nach spätestens 4 s. Am
   Telefon konkurriert das mit dem Live-Takt. Abhilfe: erst nach der ersten Interaktion oder ohne festen Timeout vorladen.
5. **Doppelte Rollen-Abrufe beim Start** (3 Abrufe je Aufruf, vor und nach `/overview`).
6. **Meldungen** ziehen rund 70 kB statisch mit (Messstellen-, Kennzahl- und Energieziel-Bilder); nach Meldungsart teilen.
7. **Summenwert-Dialoge auf der Gerätedetailseite** (≈ 18 kB gz) hängen am Hook `useSummenwertAssistent`.

Ebenfalls aufgefallen: Nachgeladene Stücke plus kalter Vite-Server reißen unter Last `findBy`- und 5-s-Grenzen in
Vitest und Playwright. Die Seiten-Tests laden die Stücke deshalb in `beforeAll` vor.

## Portal-Reaktivität, Welle 2 (14.11.2026)

Diese Runde (`vp-perf2-portal`, Stand `fd7412880`) setzt die Hebel 2 bis 5 der ersten Runde um. Sie misst im selben
Wiedergabe-Labor wie diese, mit dem Band `demo2` vom 13.11. und 150 ms je Antwort. Der Host lief mit Load 10 bis 190 aus
anderen Bahnen. Belastbar sind Abrufzahlen, Bytes, React-Übergaben und der Beginn der Abrufe; Seitenzeiten in Sekunden
streuten auch hier stärker als jeder Effekt.

### Neu im Labor

- **Zeit im Band** (`baseline/band.mjs`, Schalter `--zeit` bzw. `zeit`):
  - `ruhig` gibt die Antworten wie aufgenommen wieder. Die Live-Zeit steht dann still, und ein Takt bekommt immer dieselbe Antwort.
  - `lebendig` verschiebt alle Zeitpunkte auf jetzt. Die Live-Pfade (`overview`, `topology`, `rollen/*` …) wandern dabei mit jeder Anfrage, wie an einer laufenden Anlage.
  - Erst `lebendig` zeigt den echten Takt: Die Rollen folgen der Live-Zeit, also 65 s offene Seite = 62 Abrufe statt 44.
  - Ein Datum in der Adresse (`history?at=…`) findet die Antwort des aufgenommenen Tages.
- **`baseline/wasserfall.mjs`:** jeder Abruf eines Starts mit Beginn ab `/me`. Die Zusatzlatenz für `/overview` stellt nach, dass sie am Server langsamer ist als die Rollen (p50 330 gegen 82 ms). Erst damit erscheint das Doppel der Rollen.
- **`baseline/cpu-profil.mjs`:** CPU-Profil einer offenen Seite, Zeit innerhalb einer Komponente. Braucht den unminifizierten Profiling-Build `baseline/vite.profil.config.mjs`.
- **Bestehende Werkzeuge erweitert:**
  - `js-je-route.mjs` zählt optional mit Vorladen, am Telefon und mit Bedienung.
  - `wiedergabe.mjs interaktion --kaltKlick n` klickt mit leerem Cache.
  - `blick.mjs` macht Bildschirmfotos für den Vorher-Nachher-Vergleich.

### Geändert

| PR | Was | Nachher |
|---|---|---|
| [#1870](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1870) Vorab | Die Seitendaten einer Anlagen-Adresse gehen beim ersten Laden gleichzeitig mit `/me` hinaus (`seitenVorab.ts`): Grundabrufe jeder Anlagen-Route, auf dem Cockpit seine 16 unbedingten Abrufe. Startfenster 2 s wie `/funktionen`. | Erster Seitendaten-Abruf ab `/me`: Cockpit 284–422 → 0–2 ms, Aufbau 507 → 6 ms; letzte Antwort der ersten 4 s 100–260 ms früher; Abrufe je Start 34 → 34, Aufbau 28 → 27 |
| [#1873](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1873) Takt | Unveränderte Takt-Antworten behalten das alte Objekt (`useTaktZustand`); die heißen Intl-Formatierer (`berlinDay`, `fmtNum`, `eur`, `uhrzeit`, `monatsAnker`) und `todaySlots` werden nicht mehr je Aufruf gebaut. | React-Übergaben je Minute 49–50 → 24 (ruhig 39 → 18); Zeit in `AnlageSeite` je Minute Desktop 151–226 → 73 ms, Telefon 642 → 236 ms; Abrufe unverändert 62 / 65 s |
| [#1869](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1869) Vorladen | Verlauf und echarts im Leerlauf ohne Frist; am Telefon erst nach der ersten Bedienung. | Telefon ohne Bedienung, erste 15 s: 652,9 → 357,1 kB JS (47 → 21 Stücke); Desktop unverändert |
| [#1868](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1868) Rollen | Eine neue Live-Zeit holt die Rollen nur, wenn die vorliegende Antwort älter ist als die geltende Übersicht. | `rollen/*` je Start 6 → 3 (Abrufe 37 → 34), Telefon: letzte Start-Antwort 2,1 → 0,9 s |

Das CPU-Profil verortete die Renderzeit von `AnlageSeite` in je Aufruf gebauten Intl-Formatierern (`toLocaleString` und
Verwandte), nicht in der Fachlogik. Memoisieren half dort wenig, weil fast jede Ableitung an der Uhr (`now`, alle 5 s)
hängt. Alle vier Zweige zusammen (Probe-Merge ohne Konflikte) ergeben einen Einstieg von 257,97 kB gz bei der Grenze 258.

### Offene Hebel, nach Wirkung gereiht

1. **Zweiter Token-Abruf vor jedem ersten Bild** (unverändert, Hebel 1 oben): eigene Aufgabe mit Auth-Tests.
2. **Start der installierten App ohne Anlage in der Adresse** (`start_url` = `/`): Der Vorab-Abruf greift nicht, die
   Startweiche entscheidet erst nach `/sites`. Abhilfe: die zuletzt geöffnete Anlage merken und vorab anfragen.
3. **Die Rollen im Live-Takt:** 3 von 9 Live-Abrufen je 10 s, auch ohne Zuordnung (`zuordnung_vorhanden = false`,
   `stand` leer). Die Zuordnung ändert sich nur mit der Konfiguration. Abhilfe: ohne Zuordnung im Listentakt fragen,
   oder serverseitig ein gebündeltes Live-Lesemodell.
4. **Uhr-Übergabe am Taktbeginn:** `setNow` beim Start jedes Live-Takts rendert einmal, bevor die Daten da sind. Das
   sind 6 der verbleibenden 24 Übergaben je Minute; die anderen sind 12 Uhrtakte (5 s) und 6 Datenübergaben.
5. **Übrige Formatierer im Cockpit:** `periodLabel` mit gut 45 ms je Minute am Telefon, außerdem die Formatierer in
   Ortszeit (`hhmm`, `control.ts`). Letztere bewusst offen: Tests stellen `TZ` zur Laufzeit um.
6. **Bündel-Budget:** Der Einstieg steht mit allen vier PRs bei 257,97 von 258 kB gz.
7. **Meldungen** (≈ 70 kB statisch) und **Summenwert-Dialoge** (≈ 18 kB gz): unverändert, Hebel 6 und 7 oben.

## Kunden-API, Welle 2 (14.11.2026)

Diese Runde (`vp-perf2-server`, Ausgang `fd7412880`) setzt die Befunde B7, B3 und B4 der ersten Server-Runde um. Labor
wie dort: eigener Compose-Stapel, TimescaleDB 2.17.2 mit `pg_stat_statements` und `track_planning`, api als Container,
Modus „ruhig“ (Überwachung und Steuerungs-Vorsprung aus), 400 Lasttest-Anlagen, „Zuhause“ mit vier Monaten. Neu: zwei
Lasttest-Mandanten mit 12 Anlagen und je einem Hauptzähler (Messstellen, Stellungen, Tages- und Monatswerte), damit
`/portfolio/kpis` die Bilanz-Kette wirklich rechnet. Load 7 bis 60 aus anderen Bahnen; belastbar sind Anweisungen und
Buffer je Aufruf und die Planungszeit in einer warmen Sitzung (`EXPLAIN` zwölfmal in einer Verbindung, Median).

| Messung | vorher | nachher |
|---|---:|---:|
| `/portfolio/kpis`, 12 Anlagen ohne Hauptzähler, Anweisungen | 503 | 62 |
| `/portfolio/kpis`, 4 Anlagen ohne Hauptzähler, Anweisungen | 211 | 62 |
| `/portfolio/kpis`, 12 Anlagen mit Hauptzähler, Anweisungen | 1 539 | 869 |
| `/earnings?range=day`, 4 Anlagen, Buffer je Aufruf | 89 335 | 28 756 |
| `/earnings?range=day`, „Zuhause“, Buffer je Aufruf | 28 797 | 12 820 |
| Erlös-Aggregat (3× je `/earnings?range=day`): SQL-Text, warme Planung | 64 280 Zeichen, 4,2–5,1 ms | 25 732, 2,3–2,5 ms |
| `/earnings?range=day`, 4 Anlagen, p50 (A-B-A-B, Load 9–16) | 244 / 191 ms | 156 / 156 ms |

### Geändert

- B7 (#1877): `BilanzService.bilanzen` rechnet die Bilanzen aller Anlagen auf einem gemeinsamen Lesestand; Netzanschluss
  gebündelt. Ohne Hauptzähler hängt die Anweisungszahl nicht mehr an der Anlagenzahl.
- B3 (#1878): die Preis-Bedingung steht nicht mehr im WHERE der Zeilen-Abfragen. Dort machte sie den `LEFT JOIN
  price_slot` zum inneren Join, und der Planer begann bei der Preis-CTE (geschätzt 9, tatsächlich 5 392 Zeilen) mit
  einer Probe je Slot in jeden Rollup-Chunk.
- B4: das Erlös-Aggregat rechnet Import-Preis und Export-Wert einmal je Viertelstunde (`LATERAL … OFFSET 0`) statt in
  sieben Geldtermen.

### Offene Hebel, nach Wirkung gereiht

1. Mit Hauptzählern bleibt je Anlage ≈ +60 Anweisungen in `/portfolio/kpis`: das Werte-Lese-Modell
   (`MessstelleWerteService.werte`) liest je Term und Periode ≈ 10 Abfragen, darunter mandantenweite Stände neu.
2. Der Vergleichsspeicher-Walk behält ≈ 21 000 Buffer (4 Anlagen, 14 Tage): PV-Asset und Monatsmarktwert werden je
   Viertelstunde per Index nachgeschlagen, weil der Join Anlage ⋈ Speicher auf eine Zeile geschätzt wird.
3. Je Repository-Aufruf `set_config` und je Anfrage der Zugriffs-Kontext (B1/B2 der ersten Runde, sicherheitskritisch,
   nicht Teil dieser Welle): rund zwei Drittel der Anweisungen jeder Kundenroute; die Zugriffs-Abfrage läuft je
   `/earnings?range=day` rund zehnmal und wird jedes Mal neu geplant.

## Portal-Reaktivität, Welle 3: Live-Takt (15.11.2026)

Diese Runde (`vp-perf3-portal-takt`, Stand `44734c3c7`) setzt die Hebel 3 bis 5 von Welle 2 um: Rollen, Uhr und
Formatierer im Live-Takt der offenen Anlagen-Seite. Labor wie in Welle 2: Band `demo2`, 150 ms je Antwort,
`--zeit lebendig`. Der Host lief mit Load 7 bis 170 bei 12 GB belegtem Swap. Belastbar sind Abrufe und Übergaben je
Minute sowie die Selbstzeit je Formatierer, also die Arbeit je Aufruf. Renderzeiten in ms nur aus verzahnten Reihen
mit ähnlicher Last (`vorher3`/`kombi`, Load 27 bis 80).

### Neu im Labor

- **`wiedergabe.mjs profil`** druckt die Zeitleiste der Übergaben und der `/api/`-Abrufe (ms ab Seitenstart). Erst sie
  zeigte, dass die Übergabe „am Taktbeginn“ aus Welle 2 der 5-s-Uhrtick war. Uhr-Intervall und Live-Takt starten mit
  derselben Übergabe und laufen phasengleich, der Tick kam 10–15 ms nach dem Taktbeginn.
- **`intl-heiss.mjs`:** Selbstzeit der Funktionen eines CPU-Profils, deren Rumpf je Aufruf `Intl` baut.

### Geändert

| PR | Was | Nachher |
|---|---|---|
| [#1903](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1903) Rollen | Haben alle drei Rollen keine Zuordnung, fragt die Seite sie im Listentakt (30 s) statt mit jeder Live-Zeit. | Abrufe je 65 s 62 → 50 (`rollen/*` 18 → 6) |
| [#1904](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1904) Uhr | `useTaktUhr`: Der Tick setzt aus, solange ein Live-Takt unterwegs ist; die Antwort stellt Uhr und Daten in einer Übergabe. Nach Stillstand (verdeckter Tab) stellt der Taktbeginn die Uhr sofort. | Übergaben je Minute 24 → 18, Desktop und Telefon |
| [#1905](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1905) Formatierer | Diese Formatierer werden nicht mehr je Aufruf gebaut: `periodLabel`, `ctFmt`/`numFmt`/`pctFmt`, `kwhWort`/`ctWort`, `spurTitel`. Die Ortszeit-Uhrzeit `hhmm` und `slotTime` laufen über `ortsUhrzeit` (`getHours`/`getMinutes`) und tragen so jede `TZ`-Umstellung. | Intl-Selbstzeit je Minute Telefon 72–99 → 3–10 ms, Desktop 15–20 → 0–1 ms |

Alle drei zusammen (Probe-Merge ohne Konflikte, Typecheck grün), 60 s offene Cockpit-Seite:

| | vorher | nachher |
|---|---:|---:|
| Abrufe je 65 s | 62 | 50 |
| Übergaben je Minute, Desktop / Telefon | 24 / 24 | 18 / 19 |
| Renderzeit `AnlageSeite` je Minute (React-Profiler), Desktop / Telefon | 80 / 239 ms | 32 / 163 ms |
| CPU unter `AnlageSeite` je Minute, Desktop / Telefon | 50 / 149 ms | 18 / 122 ms |
| Intl-Formatierer je Minute, Desktop / Telefon | 15 / 72 ms | 1 / 10 ms |
| Einstieg gz | 251,90 kB | 252,26 kB |

### Offene Hebel, nach Wirkung gereiht

1. **Ein gebündeltes Live-Lesemodell** (Server): Die verbleibenden 50 Abrufe je 65 s sind 6 Live-Endpunkte × 6 und
   die Listen. Ein Endpunkt je Takt spart 30 Anfragen je Minute und Seite.
2. **Rollen mit Zuordnung:** Weiter 3 Abrufe je Live-Takt. Sie hängen an der Live-Zeit der Übersicht und kommen
   darum eine Antwortzeit später als eigene Übergabe. Das löst nur das gebündelte Lesemodell (1).
3. **Gleiche Uhr auf weiteren Seiten:** `PortfolioCockpit`, `EbenenCockpit` und `DataPages` stellen die Uhr wie vorher
   am Taktbeginn und ticken phasengleich. `useTaktUhr` passt dort ohne Umbau.
4. **`toLocaleDateString` im Zeitraum-Verlauf** des Cockpits (`rangeHistoryLoadRef`, 30-s-Abruf): 3–10 ms je Minute am
   Telefon, `berlinDay` steht bereit.
5. **Übrige Arbeit je Übergabe:** Im CPU-Profil stehen jetzt React-Interna, `fetch` und `AnlageSeite` selbst oben.
   Weniger Arbeit je Übergabe bringt nur noch ein Schnitt der Seite in Teile, die nicht an der Uhr hängen.

## Kunden-API, Welle 3 (15.11.2026)

Diese Runde (`vp-perf3-server`, Ausgang `44734c3c7`) baut die offenen Hebel H5, H2/H3 und H1 der zweiten Welle. Labor
wie dort (eigener Compose-Stapel, `pg_stat_statements` mit `track_planning`, Modus „ruhig“). Neu im Bestand: ein Jahr
Viertelstunden für die 12 Anlagen von `lt-kunde-0101` (die Lastspitze liest das Jahresfenster) und für
`lt-kunde-0001` Stammdaten wie im Betrieb (PV-Asset je Anlage, bestätigte PV-Einheiten, ein Preisblatt). Load 17 bis 57
aus anderen Bahnen; belastbar sind Anweisungen und Buffer je Aufruf und gepaarte `EXPLAIN`-Läufe in einer Sitzung.

| Messung | vorher | nachher |
|---|---:|---:|
| Lastspitze allein, 12 Anlagen × Jahr | 1 071–1 113 ms, 6 335 Buffer + Sortierung auf Platte | 3,1 ms, 554 Buffer |
| `/portfolio/kpis`, 12 Anlagen mit Hauptzähler, DB-Ausführung je Aufruf | 723 ms | 26,5 ms (H5) |
| `/portfolio/kpis`, 12 Anlagen mit Hauptzähler, Anweisungen | 857 | 115 |
| `/portfolio/kpis`, 4 Anlagen mit Hauptzähler, Anweisungen | 377 | 113 |
| `/portfolio/kpis`, 12 Anlagen mit Hauptzähler, Buffer / Planung je Aufruf | 5 364–6 065 / 374–462 ms | 1 784 / 202 ms |
| Vergleichsspeicher-Walk, 4 Anlagen, Buffer | 45 327 | 843 |
| `/earnings?range=day`, 4 Anlagen, Buffer je Aufruf | 60 547 | 10 434 |
| `/earnings?range=day`, „Zuhause“, Buffer je Aufruf | 11 806 | 4 974 |

### Geändert

- H5 (#1895): die Lastspitze je Anlage über den Teilindex `idx_telemetry_rollup_15m_netzbezug_spitze` (ein Griff je
  Anlage und Chunk) statt `DISTINCT ON` über alle Viertelstunden des Jahresfensters. Der Index entsteht je Chunk in
  eigener Transaktion (`timescaledb.transaction_per_chunk`).
- H2/H3 (#1899): Walk, Tagesreihe und Eimer lesen die Stammdaten je Anlage (Speicher, Preisblatt, PV-Asset, feste
  Vergütung, Registereinheiten) aus einer Zeile je Anlage und den Monatsmarktwert je Preis-Slot, statt sie je
  Viertelstunde per Index zu proben.
- H1: `BilanzService.bilanzen` sammelt vorab, welche Werte die Abschnitte aller Anlagen und Stichtage lesen werden, und
  liest sie über `MessstelleWerteService.vorrat` in einem Zug je Art (Messstellen, Bindungen, Ablesung, Zone je Anlage
  und Stichtag, Zone des Unternehmens einmal, Tage/Perioden, Versionen, Ereignisse, Zuordnung; je Schlüssel die
  Einzel-Abfrage als `LATERAL`). Den Live-Wert aller Hauptzähler liest `MessstelleFormelService.restLiveVieler`
  ebenso gebündelt. Die Anweisungszahl hängt nicht mehr an der Zahl der Hauptzähler (12 Anlagen 115, 4 Anlagen 113).

### Offene Hebel, nach Wirkung gereiht

1. Je Repository-Aufruf `set_config` und je Anfrage der Zugriffs-Kontext (B1/B2 der ersten Runde, H4 der zweiten;
   sicherheitskritisch, nicht Teil dieser Welle): bei `/portfolio/kpis` jetzt 70 von 115 Anweisungen, bei
   `/earnings?range=day` 47 von 66.
2. Das Erlös-Aggregat (dreimal je `/earnings?range=day`) liest PV-Asset, Preisblatt und Marktwert weiter je
   Viertelstunde und trägt die Tranchen-Tabelle viermal im SQL-Text; dieselbe Zeile je Anlage wie Walk und Tagesreihe
   (#1899) passt dort ebenso (B4 hat schon die `LATERAL`-Form).
3. Die Zeile je Anlage (#1899) entsteht für alle sichtbaren Anlagen, auch wenn eine Abfrage nur eine fragt
   (`/sites/{id}/earnings`); erst ab mehreren hundert Anlagen je Kundenbereich teurer als vorher, mit einem
   Anlagen-Filter in der CTE ganz zu vermeiden.

## Portal, Welle 3: erster Start (15.11.2026)

Diese Runde (`vp-perf3-portal-start`, Ausgang `44734c3c7`) setzt Hebel 1 der ersten Runde und Hebel 2 und 6 der
zweiten um: zweiter Token-Abruf, Start der App ohne Anlage in der Adresse, Bündel. Labor wie in Welle 2 (Bänder `demo2`
und `demo`, 150 ms je Antwort), für die Anmeldung zusätzlich ein echtes Keycloak 26.0.5 aus dem Realm von
`infra/local`. Der Host lief mit Load 6 bis 134. Belastbar sind Token-Abrufe und Abrufe je Start, Bytes und der Beginn
der Abrufe; Zeiten sind Mediane verzahnter Reihen und streuten oft stärker als der Effekt.

### Neu im Labor

- **`keycloak-runde.mjs`:** Token-Abrufe vor `/me`, Zeit vom Laden und vom ersten Token-Abruf bis `/me`, und mit
  welchem Token `/me` hinausging (Alter, Lebensdauer, Scope, Rollen). Gegen ein echtes Keycloak (Passwort-Grant je Lauf,
  frischer Browser-Kontext) oder mit `band` in der Wiedergabe. Varianten laufen verzahnt.
- `wasserfall.mjs` mit leerem Hash (`""`) misst den Start der installierten App auf `/`.

### Geändert

| PR | Was | Nachher |
|---|---|---|
| [#1894](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1894) Keycloak | `init` übernimmt die eben geprüften Tokens mit `timeSkew` aus dem eigenen Abruf; die erzwungene Auffrischung von keycloak-js (`updateToken(-1)`) entfällt nur während `init`. Der `onTokenExpired`-Zeitgeber stellt keycloak-js selbst. | Token-Abrufe vor `/me` 2 → 1 (160 von 160 Starts). Kette erster Token-Abruf → `/me`: echtes Keycloak Telefon 875 → 419 ms, Desktop 317 → 156 ms; Wiedergabe 480 → 297 / 366 → 229 ms. Gleicher Scope und gleiche Lebensdauer. |
| [#1896](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1896) Vorab | Die Schale merkt je Nutzer (`sub`) und Kundenbereich, auf welchem Anlagen-Cockpit ein Start ohne Adresse landet (`startAnlage.ts`), und stellt beim nächsten leeren Start dessen Seitendaten mit `/me` vorab. Abmelden und Nutzerwechsel verwerfen sie. | Start auf `/`: erster Seitendaten-Abruf ab `/me` Desktop 179–190 → 2–3 ms, Telefon 233–707 → 1–2 ms; Abrufe je Start 36 → 36 |
| [#1898](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1898) Meldungen | Die Ortswahl der neuen Überwachung brauchte aus `energiezielBild.ts` nur den Namen; jetzt `energiezielName.ts`, die Wörter aus `glossarEinstieg.ts`. | Meldungen statisch 106,1 → 46,8 kB gz; JS der ersten 8 s 359,7 → 300,2 kB gz |
| [#1902](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1902) Summenwert | Summenwert-Assistent (hinter `useSummenwertAssistent`) und Formel-Dialog der Gerätedetailseite kommen mit dem Klick. | Gerätedetail statisch 273,4 → 262,1 kB gz; JS der ersten 8 s 534,4 → 523,1 kB gz |
| [#1907](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1907) api | Das `api`-Objekt geteilt: `api.ts` behält die 40 Routen des ersten Bilds, die übrigen stehen in `apiVoll.ts` und hängen sich an dasselbe Objekt. Die Grenze hält der Typ. | Einstieg 252,52 → 244,53 kB gz (−7,99); `apiVoll` 8,64 kB gz kommt mit der ersten Seite, die es braucht (am Cockpit als zweite Welle) |
| [#1910](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/1910) Einstieg | Einrichtungspfad (`setupPathWeiche.ts`), Flotten-Karten (`lazy`) und Anpassen-Modus (mit dem Klick) aus dem ersten Bild. | Einstieg 252,11 → 247,25 kB gz (−4,86) |

Alle drei Bündel-PRs zusammen (#1902, #1907, #1910, gemergt; `test/bundle-smoke.sh` auf `main` @ `07570568c`): Einstieg
**252,52 → 239,50 kB gz**. „Richtung 230“ ist damit nicht erreicht; was bleibt, sind Fach-Module, die das Cockpit-Bild
selbst braucht (Hebel 2 unten). Die Grenze in `test/bundle-smoke.sh` bleibt 258.

Rollup legt ein Modul nur als Ganzes in ein Stück. Was der Einstieg statisch importiert, liegt mit allen Exporten im
ersten Bild, auch mit denen, die nur nachgeladene Seiten brauchen. Beide Einstiegs-Schnitte folgen diesem Befund, wie
schon V-01 und der UEMS-Schnitt (`test/bundle-smoke.sh`). Die Wächter `einstiegLuft.test.ts` und
`seitenBuendel.test.ts` halten die Schnitte fest.

### Offene Hebel, nach Wirkung gereiht

1. **Token-Abruf vor dem Bündel:** Die verbleibende Keycloak-Runde beginnt erst, wenn das Einstiegs-Bündel geparst ist
   (Telefon ≈ 1 s nach dem Laden). Ein kleines Skript in `index.html` könnte den Refresh-Grant parallel zum Bündel
   stellen; `initAuth` nähme dessen Ergebnis. Das ist Anmeldung, also eine eigene Aufgabe mit Auth-Tests.
2. **Weitere Fach-Module im Einstieg:** `fahrplanWhy` (≈ 6,5 kB gz), `schedule` (≈ 5,2), `ladepunkte` (≈ 4,5),
   `profiles` (≈ 4,1) und `erloesKomposition` (≈ 3,8) liegen ganz im ersten Bild. Wo das Cockpit nur eine Hilfe braucht,
   hilft ein Zwilling-Modul wie bei `setupPathWeiche.ts`. Vorher den tatsächlichen Bedarf des Cockpits prüfen.
3. **Anmeldekarte (`AuthScreen`, ≈ 2,7 kB gz):** Sie liegt im Einstieg, auch für jeden angemeldeten Start.
4. **Gerätedetail:** Das Stück `GeraetSeiteSection` selbst trägt 74,6 kB gz (mit `OcppWallboxPage`, 59 kB Quelle),
   dazu `glossar` (7,1 kB gz).
5. **Meldungen, Reiter „Einstellen“:** `EinstellungenPage` mit `rechte` und `uemsOrtsbaum` (≈ 14 kB gz) ist statisch,
   auch wenn der Reiter nicht offen ist.
6. **Gemeinsamer Vorwärm-Schritt der Testinfrastruktur** (Idee 8 der ersten Runde): Auch in dieser Runde rissen
   nachgeladene Stücke unter Last die Fristen von `waitFor` und `findBy` (Hook-Test, M5 der Anlagen-Seite).

## Kunden-API, Mandanten-Sockel (15.11.2026)

Der offene Hebel 1 der dritten Welle (B1/B2 der ersten Runde, H4 der zweiten, Lasttest Rang 13): eine Verbindung je
Anfrage, `set_config` dreimal je Anfrage statt zweimal je Repository-Aufruf (`AnfrageVerbindung`). Über die 19 Kundenrouten
764 → 333 Anweisungen (−56 %), `/earnings?range=day` 66 → 23, `/portfolio/kpis` 113 → 48, `/overview` 105 → 40; bei 40
Nutzern auf 10 Verbindungen 276–368 → 428–439 Anfragen/s. Die Zugriffs-Abfrage je Anfrage (H4, zweiter Teil) bleibt
offen. Messung und Methode: [mandanten-sockel.md](mandanten-sockel.md).

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

Portal-Reaktivität (Wiedergabe-Labor, nach `labor.sh start`, `api`, `befuellen`; Bänder und Builds außerhalb des Repos):

```bash
cd docs/performance/baseline
W=$TMPDIR/vp-perf-labor; S2=10000000-0000-0000-0000-000000000002
node wiedergabe.mjs aufnehmen --user demo2 --band $W/demo2.json --seiten "cockpit=#/anlage/$S2;aufbau=#/anlage/$S2/modell;verlauf=#/anlage/$S2/messwerte"
# je Variante ein Build (VITE_API_BASE= VITE_KEYCLOAK_URL=http://localhost:15744/auth npx vite build --outDir $W/dist-<v>) und ein Port
node serve-dist.mjs 15861 $W/dist-vorher & node serve-dist.mjs 15862 $W/dist-nachher &
node wechsel.mjs --user demo2 --band $W/demo2.json --profil mobil --varianten "vorher=15861;nachher=15862" --seiten "cockpit=#/anlage/$S2"
node js-je-route.mjs 15861 $W/demo2.json "#/anlage/$S2" $W/dist-vorher       # JS je Route, ohne Leerlauf-Vorladen
node start-kette.mjs 15861 $W/demo2.json "#/anlage/$S2" 5 150                 # Start-Wasserfall ab /me
node wiedergabe.mjs takt --base http://localhost:15861 --user demo2 --band $W/demo2.json --sek 65 --seiten "cockpit=#/anlage/$S2"

# Welle 2 (--zeit lebendig: die Live-Zeit wandert wie in Produktion; ein Band ohne Labor-API genügt)
node wiedergabe.mjs takt --base http://localhost:15861 --user demo2 --band $W/demo2.json --sek 65 --zeit lebendig --seiten "cockpit=#/anlage/$S2"
node wasserfall.mjs 15861 $W/demo2.json "#/anlage/$S2" 3 150 lebendig mobil 180        # Start je Pfad, /overview +180 ms
node js-je-route.mjs 15861 $W/demo2.json "#/anlage/$S2" $W/dist-vorher 15 1 mobil      # mit Vorladen, Telefon, ohne Bedienung
node wiedergabe.mjs interaktion --base http://localhost:15861 --user demo2 --band $W/demo2.json --profil mobil --zeit lebendig \
  --runs 3 --kaltKlick 3 --schritte "Bereich Cockpit → Verlauf"
# Profiling-Build (aus frontend/portal), dann React-Übergaben und CPU-Profil der offenen Seite
VITE_API_BASE= VITE_KEYCLOAK_URL=http://localhost:15744/auth npx vite build --config ../../docs/performance/baseline/vite.profil.config.mjs --outDir $W/dist-profil
node serve-dist.mjs 15871 $W/dist-profil &
node wiedergabe.mjs profil --base http://localhost:15871 --user demo2 --band $W/demo2.json --sek 60 --zeit lebendig --seiten "cockpit=#/anlage/$S2"
node cpu-profil.mjs 15871 $W/demo2.json "#/anlage/$S2" $W/cockpit.cpuprofile 60 lebendig mobil AnlageSeite
# Welle 3: Intl-Formatierer im CPU-Profil (die Zeitleiste der Übergaben druckt `wiedergabe.mjs profil` selbst)
node intl-heiss.mjs $W/cockpit.cpuprofile $W/dist-profil
# Welle 3, erster Start: Token-Abrufe vor /me - in der Wiedergabe (`band`) und gegen ein echtes Keycloak
# (eigener Container, Realm aus infra/local mit den Ports der Varianten in redirectUris/webOrigins, KC_HTTP_RELATIVE_PATH=/auth)
node keycloak-runde.mjs band "vorher=15861;nachher=15862" $W/demo2.json "#/anlage/$S2" 15 mobil 150
node keycloak-runde.mjs http://localhost:15944/auth "vorher=15861;nachher=15862" $W/demo2.json "#/anlage/$S2" 15 mobil 150
# Start der installierten App auf `/` (leerer Hash; der erste Lauf lernt die Anlage)
node wasserfall.mjs 15861 $W/demo2.json "" 5 150 lebendig mobil
```

Die Bänder enthalten Labor-Tokens: nach dem Lauf löschen, nie einchecken.
