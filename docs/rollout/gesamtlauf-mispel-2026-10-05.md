# Gesamtlauf `mispel` vor der Zusammenführung — 05.10.2026

Dieser Lauf misst den Zweig `mispel` **in einem Stück** — genau den Stand, der mit einem Merge
`mispel` → `main` nach Produktion geht. Anlass ist die Regel des Captains vom 04.10.2026:
`mispel` geht erst nach `main`, wenn auch `uems` **komplett grün gebaut** ist. `uems` ist das seit
dem Gesamtlauf vom 04./05.10. ([gesamtlauf-2026-10-04.md](gesamtlauf-2026-10-04.md), #1386);
`mispel` trägt seit dem Nachzug #1388 den ganzen grünen `uems`-Stand und `main` bis `e0053145f`.
Auf Forgejo läuft kein PR-CI. Form, Befehle und Regeln folgen dem `uems`-Lauf.

**Gemessener Stand:** `74485a840` (`origin/mispel`, #1388); `origin/uems` und `main` `e0053145f` sind
Vorfahren. Während des Laufs ist auf `mispel`, `uems` und `main` nichts gelandet. Der **PR-Stand**
ist `74485a840` plus die neun Reparatur-Commits unten. **Jede Java-Zahl stammt aus einem
`clean`-Lauf**, die Phasen wörtlich im Aufruf.

**Ergebnis:** Der Zweig trug **neun rote Ursachen** — alle repariert, je Ursache ein Commit, keine
Zusicherung gelockert, kein Test abgeschaltet, kein `retries`, keine Frist verlängert (die einzige
`test.slow`-Stelle bestand schon und bleibt an einem Teil des geteilten Falls, siehe unten). **Eine
davon ist ein Produktfehler, nur in `mispel`:** seit dem Subprotokoll-Mux der Box (#1349, MiSpeL
MP-35) kann eine Nachricht, die eine Säule beim Herunterfahren der Box noch sendet, den OCPP-Server mit
`panic: send on closed channel` abstürzen lassen — gefunden, weil `csms` diesmal unter `-race`
mehrfach und unter Last lief. Die übrigen acht: eine verschobene Fundstelle der Nachweismatrix (#1377),
eine Preis-Kollision in der geteilten Datenbank von `PortalApiTest` (das eine Rot der api-Vollsuite und
der vorab genannte Marktwert-Wackler), zwei Vitest-Fälle mit Last-Ursache, ein Port-Wettlauf im
Test-Pfad der Box, zwei MiSpeL-Aufrufe, die die E2E-Bühne nicht kannte (#1346, #1359), und
Playwright-Fälle mit mehreren vollen Bühnen-Aufrufen in einer Frist. **Alle vier vorab genannten
Wackler haben eine belegte Ursache und eine Reparatur.**

**Nicht komplett grün unter Last:** weitere Playwright-Fälle mit mehreren vollen Bühnen-Aufrufen
kippten im Nachweis-Schnitt vereinzelt (vier Fälle, je einmal), dazu ein unerklärter WebKit-Fall
(`anlage-umziehen.spec.ts:184`, allein dreimal grün). Ihre gemeinsame Wurzel — jede Bühne lädt ~745
Module einzeln vom Dev-Server — ist ein eigener Folgeauftrag. api **703 von 703 Klassen / 10 986 Tests**,
Box `-race` über alle 52 Pakete und `csms` 20-fach unter Last ohne Befund, alle **3 456
Playwright-Fälle in vier Projekten** gestartet.

## Die Summen je Suite

| Suite | Lauf | Ergebnis |
|---|---|---|
| **`services/api`** (Vollsuite, gemessener Stand) | `./mvnw clean test -Dspring.test.context.cache.maxSize=4`, EIN Lauf | `Tests run: 10986, Failures: 1, Errors: 0, Skipped: 4` · 703 von 703 Klassen · `Total time: 02:25 h` |
| **`services/api`** (`PortalApiTest`, PR-Stand) | `clean`, `-Dtest=PortalApiTest` | **`Tests run: 93, Failures: 0, Errors: 0, Skipped: 0`** · BUILD SUCCESS |
| **`services/timescale-writer`** | `./mvnw clean test` | **`Tests run: 249, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/ingest`** | `./mvnw clean test` | **`Tests run: 125, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/optimization`** | `PYTHONPATH=.:../forecast .venv/bin/python -m pytest` (vorher `import highspy`), unter der api-Last | **`2408 passed`** in 749 s, 0 übersprungen |
| **`services/forecast`** | `pytest` mit `xgboost`, `numpy`, `psycopg[binary]` (Extras `ml`, `db`; die DB-Datei startet einen Wegwerf-Postgres) | **`163 passed`**, 0 übersprungen |
| **`services/market-data`** · `services/marketing-adapter` | `pytest` | **`157 passed`** (uems: 134) · `1 passed` |
| **`frontend/portal`** vitest (gemessener Stand, unter der api-Last) | `npx vitest run`, vollständig | **`Test Files 617 passed (617)` · `Tests 12409 passed (12409)`** |
| **`frontend/portal`** typecheck · build (PR-Stand) | `npm run typecheck` · `npm run build` | Exit 0 · `✓ built in 12.26s` |
| **`frontend/portal`** Playwright (PR-Stand) | `npx playwright test`, vier Projekte einzeln | siehe unten — alle **3 456 Fälle in 115 Dateien** gestartet, WebKit eingeschlossen |
| **`catalog/measurement-points`** | `pytest tests` · `unittest` | **`50 passed`**, 56 Untertests · `Ran 50 tests … OK` |
| | `update_deye_key_lock.py --check` · `extract_shelly.py --check` · `generate.py --check` · `validate.py` · `package_edge_runtime.py --check` | alle Exit 0; „validated 2395 points in catalog 2026.09.23.3“, „runtime derivatives of catalog 2026.09.23.3 match its runtime version“ |
| **`catalog/control-profiles`** | `validate.py` · `unittest` · `package_edge_runtime.py --check` (wie CI) | „control profiles valid: 24 profiles“ · `Ran 24 tests … OK` · „up to date“ |
| **`edge-app/core`** (gemessener Stand) | `go build ./...` · `go vet ./...` · `go test -count=1 ./...` | Exit 0 · Exit 0 · **52 Pakete `ok`**, 11 ohne Testdateien, 0 FAIL |
| | `go test -race -count=1` für `agent`, `lastmgmt`, `csms`, `ocppsim`, `entladeschutz` | alle fünf `ok` (agent 333 s) — der Wackler kam erst in der Wiederholung, siehe unten |
| **`edge-app/core`** (PR-Stand) | dieselben drei Befehle · `-race` für die fünf Pakete · `-race` über **alle** Pakete | **52 `ok`**, 0 FAIL · alle fünf `ok` (agent 322 s) · **52 `ok`**, 11 ohne Testdateien, 0 FAIL, 0 Race-Berichte (`-timeout 40m`) |
| | `go test -race -count=20 -timeout 90m ./internal/csms/` unter der api-Last | **`ok` in 640,8 s**, 20 × 108 Fälle, **0 Race-Berichte** |
| **`edge-app/nodered`** | `npm test` (`node --test`), Abhängigkeiten per `npm install --no-package-lock` | **`tests 1159, pass 1159, fail 0, skipped 0`** |
| **`edge-app/nodered/vp-palette`** | `npm test` (Mocha) | **`224 passing`** |
| `edge/sim` | `node --test` | `tests 9, pass 9` |
| **`tools/`** mit eigenen Tests (pytest) | `pytest` je Ordner (`uv`, mit `jsonschema` und `paho-mqtt`) | `edge-simulator` 77 · `generalprobe` 24 · `freigabe` 46 · `lastprofil-messung` 11 · `bewertung` **342** (vorher 14 rot, siehe unten) · `uems-verbund-sim` 46 · `nw3-box-image` 3 · `tools/tests` 4 — alle grün |
| **`tools/`** Selbsttests (Shell, zusätzlich) | `bash tools/<ordner>/test-*.sh` | `ota/test-release-publish` 74 · `ota/test-release-workflow` 62 · `pki/test-acl-grants` 31 · `backup/test-backup-metrics` OK · `deploy/test-gitops-image-bump` OK · `deploy/test-gitops-bump-workflow` OK · `backup/test-backup-restore` **36 PASS, 0 FAIL** (echter Zyklus in Wegwerf-Containern) |
| **`shellcheck`** | alle 33 Skripte unter `tools/` | `-S warning` Exit 0; 28 Infos (SC2015 16, SC2016 4, SC1091 4, SC2018/2019 je 2) |
| **Doku-Werkzeuge** | `check_auswirkungen.sh` · `check_belege.sh` · `build_fachmodell.py --check` · `agents-md-budget.sh` | „44 Tabellen und 12 Dateien geprüft · 0 Fehler“ · „221 Belege geprüft · 0 fehlende Dateien · 0 veraltete Zeilen“ · „aktuell“ · alle Budgets ok |

**Lückenlosigkeit — nachgewiesen, nicht behauptet.** Je Suite die `*Test.java` des gemessenen
Standes (SOLL) gegen die Klassen mit einer `Tests run: … in <FQCN>`-Zeile (IST):

```
services/api              SOLL 703 · IST 703 · nicht gelaufen: keine · gelaufen aber nicht im SOLL: keine
services/timescale-writer SOLL  21 · IST  20 · nicht gelaufen: EreignisTabelleImTest
services/ingest           SOLL  23 · IST  23 · nicht gelaufen: keine
```

Gegenüber `uems` (670) kommen 33 api-Klassen dazu, 27 davon unter `com.voltpilot.api.mispel`.
`EreignisTabelleImTest` ist wie am 19.09. und 04.10. ein Helfer mit privatem Konstruktor, keine
Testklasse.

### Playwright — alle vier Projekte, 3 456 Fälle

`npx playwright test --list`: **3 456 Fälle in 115 Dateien** (864 je Projekt; die 116. Spec,
`buehne-vorher-nachher`, ist ohne `BUEHNE_PHASE` gewollt ausgenommen). Gegenüber `uems` (3 172 in 106)
kommen neun MiSpeL-Specs dazu.

| Projekt | Stand | Ergebnis |
|---|---|---|
| `desktop-chromium` | `caf9ea755` | 856 passed · 1 skipped · **7 rot** (`weg.spec.ts:190/:311` je 375 + 1440, `zaehlerwechsel.spec.ts:96`, `standort-ebenen.spec.ts:324` ×2) (18,8 min) |
| `tablet-chromium` | `caf9ea755` | 823 passed · 37 skipped · **4 rot** (`steuerquelle-gemeinsame-steuerung.spec.ts:46` ×2, `zaehlerwechsel.spec.ts:96`, `standort-ebenen.spec.ts:324` 1440) (21,8 min) |
| `mobile-chromium` | `caf9ea755` | 824 passed · 38 skipped · **2 rot** (`steuerquelle-gemeinsame-steuerung.spec.ts:46` ×2) (18,9 min) |
| `mobile-webkit` | `caf9ea755` | 822 passed · 39 skipped · **3 rot** (`portal-rechte.spec.ts` R1 · MD ×2, `anlage-umziehen.spec.ts:184` 1440) (21,8 min) |
| **Summe** | | **3 325 passed · 115 skipped · 16 rot = 3 456** |

Die Bühnen-Reparatur für `msb-abgleich` (`e2e/startansicht.tsx`) lag ab der Mitte des tablet-Laufs im
Arbeitsbaum; der Dev-Server lieferte sie aus, darum ist `weg` ab tablet grün. Die Spec-Attrappe von
`zaehlerwechsel` lädt der Worker beim Start — in tablet war sie noch rot, in den Telefon-Projekten grün. Nach den Reparaturen: der s–z-Schnitt (28 Dateien, 211 Fälle je
Projekt, vier Worker) — **tablet 203 · 6 skipped · 2 rot, mobile-chromium 204 · 6 · 1, mobile-webkit
204 · 6 · 1, desktop 209 · 0 · 2** (ein erster desktop-Durchgang lag in einer zweiten Playwright-Bahn
einer fremden Arbeitskopie auf derselben Maschine: 200 · 11, verworfen und ohne Fremdlast wiederholt).
**Alle geteilten Fälle (6 + 3 + 14 je Projekt) sind in allen vier Projekten grün**, `portal-rechte`
in WebKit 7/7, `anlage-umziehen` in WebKit allein dreimal 9/9. Rot blieben nur **ungeteilte Fälle mit
mehreren vollen Bühnen-Aufrufen** — `standort-ebenen.spec.ts:182` (desktop, webkit), `:228` (tablet),
`tageskarte.spec.ts:273` (tablet), `wallbox-karte.spec.ts:172` (desktop) — und `standorte.spec.ts:163`
(mobile-chromium, Options-Klick nach 30 s). Alle waren im vollen Lauf grün; es ist dieselbe Ursache
außerhalb des Entscheids, die Wurzel ist der Folgeauftrag (E2E gegen ein gebautes Bündel).

**Dieselben Zusicherungen, gezählt.** Die `expect`-, `ohneQuerlauf`- und `ablegen`-Zeilen sind vorher und
nachher identisch; ausgeführt (am Code mit Schleifen, `oeffne` trägt 3 bzw. 1, `ohneQuerlauf` 3):

| Fall vorher | `expect` vorher | Fälle nachher | `expect` nachher |
|---|---|---|---|
| `steuerquelle` je Breite (1 Fall, drei Aufrufe) | 20 | 3 Fälle | 5 + 6 + 9 = 20 |
| `standort-ebenen` Ü8 (1 Fall, vier Aufrufe) | 32 + n (n = Tippflächen) | 3 Fälle | (15 + n) + 12 + 5 |
| `standort-ebenen` O18 je Breite (1 Fall, sieben Aufrufe) | 70 | 7 Fälle | 10 + 6 × 11 = 76 (+6: die Kopf-Prüfung der Vergleichsaufrufe) |

Die alten Fassungen liefen dazu einmal unverändert (als temporäre Kopie) in tablet: 5/5 grün.

**Die Sprünge.** desktop 1 wie auf `uems`. In den drei anderen Projekten je **28 mehr** als auf
`uems` (9/10/11 → 37/38/39): drei MiSpeL-Specs laufen gewollt nur in `desktop-chromium` und setzen
375 und 1440 px selbst (`foerderweg` 8, `haushalt` 14, `mispel-check` 6 Fälle; je
`test.skip(info.project.name !== 'desktop-chromium', 'Die Spec setzt 375 und 1440 px selbst')`).

### Übersprungen ist nicht grün — die vier Sprünge der api, namentlich

Dieselben vier wie auf `uems`, MiSpeL bringt keinen dazu:

| Fall | Grund |
|---|---|
| `UemsQuellenUebergabeTest.a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` | bewusst offen: AP-07 IP-7 schreibt `event.site_id()`, die Herkunft trägt keine Anlage aus der Entität |
| `LoeschzugKatalogApiTest.laufzeitAnEinemGrossenBereich` | Lastmessung, läuft nur mit `-Dloeschzug.zeilen` |
| `MessstellenregisterNachbarbedarfTest.a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen` | Nachbarbedarf A5: eine Wandlerfassung wird noch nicht an die Box zugestellt |
| `UemsBestandSteuerungAusEinemStueckTest.buehneVorherNachherAntwortenAufzeichnen` | nimmt nur unter `tools/buehne-vorher-nachher/run.sh` auf |

## Jedes Rot, eingeordnet

Art: **a** Test/Bühne nicht nachgezogen · **b** Produktfehler · **c** Flatterer (Uhr, Last, Reihenfolge) · **d** Umgebung.

| Klasse / Fall | Fehlerbild | Seit | Art | Hier |
|---|---|---|---|---|
| `tools/bewertung/test_zusagen.py` (14 Fälle, eine Ursache) | „der Wortlaut steht nicht an `glossar.ts:497–498` … steht jetzt an :509–510“ (Z-018), dasselbe für Z-075 (746–747 → 758–759) | **#1377** (`be746834a`, MP-18c) | **a** | repariert: nur die Zeilenangaben, Prüfpaket neu gebaut |
| `PortalApiTest.theDailySeriesCarriesTheSteeringShareAgainstAStubbornBattery` | `savedEur` 0,3 statt 0,2 | **#622** (`dfab5595b`) gegen **#81** | **c** Uhr + Reihenfolge | repariert: Preise des Falls mit `DO UPDATE` (siehe unten) |
| Box `csms` `-race`, `TestAmpereOnlyStationUsesDeclaredWiringAndConfirmsSchedule/phases#1` (in der Wiederholung `-count=10`) | „der Ladepunkt-Server auf Port 64644 konnte nicht gestartet werden (Port belegt?)“ | `freePort()` seit dem csms-Anfang | **c** Port-Wettlauf | repariert: Port 0 wählt neu (nur Test-Pfad) |
| Box `csms` `-race`, `TestOCPP201AuthorizationGuardIsTheSameAsFor16` (Diagnoselauf `-count=15`) | `DATA RACE` `ws.(*server).error` gegen `ws.(*server).Stop`; ohne Race-Detektor `panic: send on closed channel` | **#1349** (MiSpeL MP-35) — **nur `mispel`** | **b** | repariert: Entscheid firstmate `gm-csms-stop-race` = A |
| `PortalApiTest.earningsExposeTheForwardExpectedMarketValueWeightedByPvForecast` (vorab genannt) | — (17,777 statt 15,111 im Klassenlauf früher) | **#110** gegen **#622** | **c** Uhr + Reihenfolge | **in diesem Lauf grün**; Ursache belegt und mit derselben Reparatur behoben |
| `AnlagenPage.test.tsx` „AP-13 Bestandsschutz · Cockpit ohne Messfunktion“ (vorab genannt) | — | `1fec2bc1c` via **#1363** | **c** Last + Reihenfolge | **in diesem Lauf grün** (1 590 ms); Ursache belegt, repariert |
| `VerlaufExplorer.test.tsx` „F2a producer empty state“ (vorab genannt) | — | Fall seit **#239**, Kette länger seit **#689** | **c** Last | **in diesem Lauf grün**; Ursache gemessen, repariert |
| `edge-app/nodered` ohne `node_modules` | `skipped 1`: „bcryptjs not installed in this checkout (present in the image)“ | — | **d** | kein Commit: mit `npm install --no-package-lock` 1159/1159 |
| `tools/edge-simulator`, `uems-verbund-sim`, `bewertung` ohne Python-Pakete | `No module named 'paho'` / `'jsonschema'` beim Sammeln, in `bewertung` 164 Folgefehler | — | **d** | kein Commit: mit `paho-mqtt` und `jsonschema` grün |
| Playwright `weg.spec.ts:190`, `:311` (desktop, je 375 + 1440) | „Konsolenfehler auf dem Weg / in den Welten“: CORS-Fehler für `localhost:8090/api/v1/messstellen/{id}/msb-abgleich` | **#1346** (`26fa4c9ce`, MP-15) | **a** | repariert: die Bühne antwortet wie ohne Zählerrolle |
| Playwright `zaehlerwechsel.spec.ts:96` (desktop, tablet) | „Failed to load resource … 404“ — die Attrappe der Spec kannte `/msb-abgleich` nicht | **#1346** | **a** | repariert: dieselbe Antwort in der Spec-Attrappe |
| Playwright `portal-rechte.spec.ts` R1 · MD (mobile-webkit, 375 + 1440) | „…/ladepunkte due to access control checks“ als Seitenfehler | **#1359** (MP-41a) gegen die R1-Absage aus #1386 | **a** | repariert: `ladepunkte` in der Absage ohne Netz |
| Playwright `steuerquelle-gemeinsame-steuerung.spec.ts:46` (tablet, mobile-chromium; im s–z-Schnitt auch desktop) | `waitForLoadState('networkidle')` nach 30 s nicht erreicht | Fall aus `uems` (**#1043**) | **c** Last | repariert: geteilt (Entscheid `gm-e2e-mehrfachaufruf` = A) |
| Playwright `standort-ebenen.spec.ts:324` (desktop ×2, tablet 1440), im s–z-Schnitt `:253` (desktop) | `.vp-topbar` nach 5 s nicht sichtbar · `page.goto` ohne `load` in 90 s · Test-Frist 30 s | Fälle aus `uems` (**#819**) | **c** Last | repariert: geteilt (derselbe Entscheid) |
| Playwright `anlage-umziehen.spec.ts:184` (mobile-webkit, 1440) | „Nächster Monat“ nicht gefunden; der Dialog ist zu, nachdem der Klick auf „Gültig ab“ in dieselben 250 ms fiel wie zwei gestellte Antworten | Fall aus `uems` (AP-02 IP-11) | **c** (vermutet) | **nicht repariert**: allein 3× wiederholt 9/9 grün; Ursache nicht belegt (siehe „Was dieser Lauf NICHT sagt“) |

## Die vier vorab genannten Wackler — Ursache und Reparatur

Alle vier waren im `uems`-Lauf (#1386) grün oder nur vermutet erklärt. Hier hat jeder eine Ursache —
gemessen oder reproduziert, nicht vermutet — und eine Reparatur ohne gelockerte Zusicherung, ohne `retries` und
ohne längere Frist.

### Box `internal/csms` unter `-race` — zwei Ursachen, eine davon ein Produktfehler

Im ersten Lauf waren alle fünf `-race`-Pakete grün. Die Wiederholung `go test -race -count=10
./internal/csms/` unter der api-Last war rot; ein Diagnoselauf (`-count=15`, Server-Warnungen auf
stderr, nicht committet) zeigte das zweite Fehlerbild, ein weiterer (`-count=20`) stieß ohne roten
Fall an die 10-Minuten-Grenze des Testbinaries:

1. **„Port belegt?“ (Art c, nur Test-Pfad).** `TestAmpereOnlyStationUsesDeclaredWiringAndConfirmsSchedule/phases#1`:
   „der Ladepunkt-Server auf Port 64644 konnte nicht gestartet werden (Port belegt?)“. Mit Port 0
   wählt `Server.Start` den Port vorab über `freePort()` (Probe auf `127.0.0.1:0`, Socket zu), die
   Bibliothek bindet `":port"` erst danach selbst. Dazwischen kann ein anderer Socket den Port
   nehmen. Auf dieser Maschine belegt ihn nur ein IPv6-/Dual-Stack-Socket wirksam (so lauscht Docker
   Desktop, `*:8090 IPv6`) — ein reiner IPv4-Socket lässt den Bind der Bibliothek durch. Die Box
   selbst nutzt Port 0 nie (`OcppPort` 8887).
2. **DATA RACE beim Stop (Art b, Produktfehler, nur `mispel`, seit #1349 MiSpeL MP-35).**
   `TestOCPP201AuthorizationGuardIsTheSameAsFor16`: um 12:04:29.954 trennt der Drain die Säule
   `WB-201-A`, im selben Millisekundenschritt meldet der Server „die Ladesäule spricht ein anderes
   OCPP-Protokoll“, dann `ws.(*server).error` (`server.go:226/227`) gegen `ws.(*server).Stop`
   (`server.go:294/295`). Der Leser der Verbindung hielt schon den nächsten Rahmen, als der
   Subprotokoll-Mux die Spur der getrennten Säule freigab; der Nachrichtenhandler gab `errWrongLane`
   an die Bibliothek zurück, und die schickte es in den Fehlerkanal, den `Stop` in diesem Moment
   schließt. **Außerhalb des Race-Detektors ist das `panic: send on closed channel` — in Produktion
   beim Herunterfahren der Box, solange eine Säule sendet.** Entscheid firstmate
   `gm-csms-stop-race` = A.

Die frühere Beobachtung „file exists“ war eine Fährte: das ist die **erwartete** Log-Zeile von
`TestStartIsNotAcknowledgedWithoutDurableState` (rename auf ein Verzeichnis meldet unter macOS
`file exists`), die neben jedem roten Paketlauf mit ausgegeben wird.

### `AnlagenPage.test.tsx` „AP-13 Bestandsschutz · Cockpit ohne Messfunktion“

Das Cockpit lädt **zwei** Stücke nach: die Energie-Bühne (`CockpitHero`, `lazy`) und seit
`1fec2bc1c` (main, über Nachzug 1a #1363) die Kacheln (`KachelStueck`, `lazy`). Der Fall wartete nur
auf die Bühne und fotografierte dann. Beleg: mit vorab übersetzter Bühne allein fällt der
Schnappschuss **3 von 3** Mal — er enthält dann die Platzhalter `vp-k-platz aria-hidden` statt der
Kacheln. Im Ganzlauf entscheidet die Reihenfolge der zwei ersten Übersetzungen im Worker, dazu
bezahlte der Fall beide (allein 200–300 ms) innerhalb seiner `waitFor`-Fristen. Im Ganzlauf dieses
Laufs grün (1 590 ms).

### `VerlaufExplorer.test.tsx` „F2a producer empty state“

Gemessen: die **erste** Darstellung des Explorers im Worker kostet ein Vielfaches jeder weiteren. 24
Läufe der Datei, je 6 gleichzeitig, neben der api-Vollsuite: F2a als erster Fall der Datei Median
~230 ms, Spitzen 767 ms und in einer Vorrunde 1 029 ms; derselbe Fall direkt danach ein zweites Mal
Median ~78 ms, Spitze 267 ms. Die Kette dahinter (Baum, Auswahl, Verlauf) läuft unter der
1-s-Vorgabe von `waitFor`. Im Ganzlauf dieses Laufs grün.

### `PortalApiTest.earningsExposeTheForwardExpectedMarketValueWeightedByPvForecast`

Die Klasse teilt EINE Datenbank, JUnit ordnet die Fälle fest nach `String.hashCode()` des Namens.
`theDailySeriesCarriesTheSteeringShareAgainstAStubbornBattery` (Hash −827 653 633) läuft **vor** dem
Marktwert-Fall (−237 241 621) und legt CH 200 €/MWh mit `ON CONFLICT DO NOTHING` auf **heute 12:00
und 12:15** (Berlin). Läuft der Marktwert-Fall zwischen 09:00 und 09:30, fällt sein −40-Slot (+3 h)
genau dorthin, `DO NOTHING` behält die 200: (100·2 + 200·6 + 200·1)/9/10 = **17,777** — genau die
früher beobachtete Zahl; zwischen 11:00 und 11:30 trifft es den +1-h-Slot (17,333). Umgekehrt legt
der Marktwert-Fall vier Zeilen auf +1 bis +4 h, die die zwei Fälle mit festen Monatstagen **danach**
(`earningsValueDynamic…` am 13., `siteEarningsAnswer…` am 15.) zur passenden Uhrzeit ebenso
blockieren; `earningsExposeGesamtertrag…` (am 11., läuft davor) trifft den Marktwert-Fall am 11. zu
mehreren Uhrzeiten (etwa 15:00–15:15: 17,777 wie oben).

**Und genau diese Ursache war das eine Rot der Vollsuite** — nur mit einem anderen Paar:
`earningsComputesRealizedSavingsPerSiteWithHonestDegradation` (Position 9 im Surefire-Bericht) legt
CH 150 auf `now() − 2 h`; die Klasse lief um 14:05, also auf **heute 12:00**, wo
`theDailySeries…` (Position 26) mit `DO NOTHING` seine 200 legen wollte. Slot A rechnete mit 150:
−2,0 × 0,15 + 0,60 = **0,30** statt 0,20.

**Beleg:** ein Gift-Lauf (nicht committet) legt vorab den fremden Preis, so wie ihn der frühere
Fall zur genannten Uhrzeit hinterlässt — CH 200 auf `+3 h` vor dem Marktwert-Fall und CH 150 auf
heute 12:00 vor `theDailySeries…` —, `clean`, nur diese zwei Fälle: **alter Code `Tests run: 2,
Failures: 2`** mit genau `0.3` statt `0.2` und `17.77777777777778` statt `15.11111111111111`;
**reparierter Code 2/2 grün**. Die Klasse auf dem PR-Stand: `93/0/0/0`.

**Reparatur:** alle sieben CH-Einfügungen der Klasse auf Slots, die vom Tag oder der Uhrzeit des
Laufs abhängen, nehmen die Hausregel des Nachbarfalls `:4654` („Die Preise gehören diesem Test“):
`ON CONFLICT (bidding_zone, resolution, ts) DO UPDATE`. Jeder Fall setzt seine Preise vor seiner
eigenen Prüfung; was ein späterer Fall danach überschreibt, hat der frühere schon geprüft — damit
hängt kein Fall mehr an Reihenfolge oder Uhrzeit. Feste Kalenderdaten und die DE-LU/AT-Fälle sind
unberührt: sie haben keinen zeitbezogenen Kollisionspartner.

## Die Reparaturen — ein Commit je Ursache

| Commit | Ursache | Art | Auslöser |
|---|---|---|---|
| Nachweismatrix: Fundstellen von Z-018 und Z-075 mitziehen (+ Prüfpaket neu gebaut) | Wortlaut in `glossar.ts` um zwölf Zeilen verschoben | a | #1377 |
| `AnlagenPage`-Test: Cockpit-Bestandsschutz wartet auf BEIDE nachladenden Stücke | Schnappschuss vor dem zweiten `lazy`-Stück | c | `1fec2bc1c` via #1363 |
| `VerlaufExplorer`-Test: die erste Darstellung vorwärmen | Erstdarstellung im Worker innerhalb der `waitFor`-Frist | c | #239, #689 |
| Box csms: Port 0 (nur Tests) wählt neu, wenn der freie Port inzwischen belegt ist | Port-Wettlauf zwischen Probe und Bind | c | `freePort()` |
| Box csms: späte Nachricht einer getrennten Säule verwerfen statt sie in den Stop zu melden | **Produkt**, nur `mispel` | b | #1349 (MP-35) |
| `PortalApiTest`: handgerechnete CH-Preise auf Tages-/Uhrzeit-Slots gehören ihrem Fall (`DO UPDATE`) | Preis-Kollision in der geteilten Klassen-DB | c | #81, #110, #622 |
| E2E: der MSB-Abgleich der Messstellen-Seite antwortet in den Bühnen wie ohne Zählerrolle | Bühne und Spec-Attrappe nicht nachgezogen | a | #1346 (MP-15) |
| E2E-Bühne `startansicht`: die Ladepunkte der Steuerung in der Rechte-Ansicht R1 ohne Netz | Absage-Liste nicht nachgezogen | a | #1359 (MP-41a) |
| E2E: Fälle mit mehreren vollen Bühnen-Aufrufen geteilt, je Fall ein Aufruf | Budget der Fälle unter Parallellast | c | Fälle aus `uems` #819, #1043 |
| Gesamtlauf `mispel` 05.10.2026: die gemessenen Summen als Beleg im Repo | — | — | (dieser Bericht) |

Keine Zusicherung gelockert, kein Test abgeschaltet, kein `retries`, keine längere Frist. Neue Fälle
halten die zwei csms-Ursachen fest und sind mit dem alten Code rot:
`TestStartPicksAgainWhenTheFreePortWasTakenMeanwhile` (mit einem Versuch: genau „…(Port belegt?)“) und
`TestStopWithFramesInFlightRacesNothing` (alt: im ersten Lauf 14 Race-Berichte, dann
`panic: send on closed channel`; neu: `-race -count=10`, 250 Stopps, ohne Befund).

## Der Tor-Prüfer

Die sechs Nachweisklassen liefen `clean` auf dem PR-Stand, `stand.txt` nennt ihn. Die Ausgaben von
G0 und G1 stehen im PR-Text — dieser Bericht ist Teil des Standes, den sie prüfen.

## Hausregeln und wie gemessen wurde

- **`clean` überall**; jede Java-Zahl aus `./mvnw clean test`, die Phasen wörtlich im Aufruf.
- **Die api-Vollsuite als EIN Lauf**, allein; daneben nur container-freie Läufe (Go, Node-RED,
  Python, vitest) und nacheinander writer, ingest, die Forecast-DB-Datei und der Backup-Zyklus —
  höchstens zwei Testcontainers-Sitzungen zugleich (`docker ps --filter label=org.testcontainers=true`,
  gezählt nach Sitzung: die api-Suite allein hält drei Container einer Sitzung), jeder Start bei
  ≥ 35 % freiem Speicher. Nie der lokale Docker-Stack.
- **Playwright erst nach der api-Suite und nie neben einem Testcontainers-Lauf**, projektweise,
  auf eigenem Port (4291) über eine unversionierte Kopie der Konfiguration; die Browser liegen im
  Worktree (`PLAYWRIGHT_BROWSERS_PATH`, WebKit `webkit-2336`).
- **Der Rechner schlief nicht:** jeder lange Lauf unter `caffeinate -i`. Bis etwa 12:45 lief er auf
  Akku (100 % → 68 %), danach am Netzteil. Keine Klasse lief in einer Schlafphase.
- Die Node-RED-Suite braucht ihre Abhängigkeiten: ohne `npm install` meldet sie `skipped 1`;
  gezählt ist der Lauf mit Abhängigkeiten. Die Werkzeug-Ordner `edge-simulator`, `bewertung` und
  `uems-verbund-sim` brauchen `paho-mqtt` bzw. `jsonschema`.
- Diagnoseläufe (Server-Warnungen auf stderr, Zeitmessungen, Gift-Zeilen) waren vorübergehende,
  nie committete Änderungen; jede wurde vor dem nächsten Commit zurückgesetzt.

## Was dieser Lauf NICHT sagt

- **Er sagt nichts über Produktion** — außer dass der Stop-Race der Box mit `mispel` dorthin
  gekommen wäre (er steckt nur in `mispel`, nicht auf `main`). Alles lief gegen Testcontainers, die
  E2E-Bühne und simulierte Säulen, nie gegen eine Produktionsdatenbank oder eine echte Box.
- **Er sagt nichts über die Lücken, die kein Test hat.** Ein grüner Lauf beweist keine Abdeckung.
  Der Produktfehler zeigte sich nur, weil diesmal `csms` unter `-race` mehrfach und unter Last lief.
- **Er sagt nichts über die api-Vollsuite AUF dem PR-Stand.** Sie lief auf `74485a840`; der
  PR-Stand ändert in `services/api` nur `PortalApiTest`, die `clean` allein grün lief, und die
  Nachweisklassen des Tor-Prüfers.
- **Er schließt nicht jedes Fenster des Box-Stops.** Vorbestehend und auch auf `main`: startet der
  Leser einer Verbindung erst, nachdem der Drain sie schon abgebaut hat, meldet die Bibliothek
  „readPump started … with nil connection“ ebenfalls in den Fehlerkanal, den `Stop` schließt. Das
  Fenster liegt zwischen Verbindungsaufbau und Stop; der Wiederholungslauf `-count=20` traf es
  nicht. Nicht Teil des Entscheids `gm-csms-stop-race`.
- **Er sagt nichts über weitere Preis-, Uhr- und Kalender-Kollisionen außerhalb von
  `PortalApiTest`.** Die Reparatur ordnet die CH-Preise dieser einen Klasse; andere Klassen mit
  geteilter Datenbank und zeitbezogenen Slots sind nicht durchgesehen.
- **Er erklärt nicht jedes Rot.** `anlage-umziehen.spec.ts:184` (mobile-webkit, 1440) war einmal rot und
  allein dreimal wiederholt grün; der Trace zeigt den Dialog geschlossen, nachdem der Klick auf
  „Gültig ab“ in dieselben 250 ms fiel wie zwei gestellte Antworten. Vermutet ist ein Klick während
  einer Layout-Verschiebung, belegt ist es nicht — nicht repariert.
- **Er beseitigt nicht die Wurzel der Playwright-Last.** Jeder volle Aufruf der Bühne lädt ~745 Module
  einzeln vom Vite-Dev-Server; die Teilung gibt jedem Fall nur einen Aufruf. E2E gegen ein gebautes
  Bündel statt den Dev-Server legt firstmate als eigenen Folgeauftrag an.
- **Er sagt nichts über die Tore G1, GA und GB** außer den maschinellen Punkten; den Rest liefert
  der Betreiber. **Er sagt nicht, dass ein Tor offen ist** — das öffnet nur der Betreiber.
