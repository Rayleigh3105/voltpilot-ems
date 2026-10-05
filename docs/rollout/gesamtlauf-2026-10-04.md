# Gesamtlauf `uems` vor der Zusammenführung — 04./05.10.2026

Dieser Lauf misst den Sammelzweig `uems` **in einem Stück**. Anlass ist die Regel des Captains vom
04.10.2026: `mispel` geht erst nach `main`, wenn auch `uems` **komplett grün gebaut** ist — alle
Suiten, nicht nur die gezielten Klassen der einzelnen Pakete. Auf Forgejo läuft kein PR-CI. Der
letzte lückenlose Lauf war der vom 19.09.2026 ([gesamtlauf-2026-09-19.md](gesamtlauf-2026-09-19.md));
seither kamen AP-17 bis AP-20, der Nachzug der neuen Steuerung von `main` (#1363 mit 1b/1c/1d),
#1370 und SZ-1/SZ-2 (#1376) dazu.

**Gemessener Stand:** `9bd63484f` (`origin/uems`, #1376). Während des Laufs sind zwei Nachzüge
von `main` gelandet: #1379 (#1378, drei Portal-Dateien der Steuerung) und #1384 (#1380–#1382,
`edge-app/core` agent/csms/lastmgmt und zwei Portal-Dateien). Der **PR-Stand** steht auf
`9c764fc32` (#1384) plus den Reparatur-Commits. Was danach wiederholt wurde, steht unten.
**Jede Java-Zahl stammt aus einem `clean`-Lauf**, die Phasen wörtlich im Aufruf.

**Ergebnis:** Der Zweig trug **zwölf rote Ursachen**, dazu drei rote
api-Klassen aus dem **Ruhezustand des Rechners** (allein unverändert grün). **Zwei der zwölf sind
Produktfehler** — beide im Blatt der neuen Steuerung, das mit dem Nachzug von `main` (#1363) kam,
und beide **stecken auch auf `main`, also in Produktion**: Escape schloss das Blatt in Safari/WebKit
nicht, und der Fokus kehrte dort nicht zum Auslöser zurück. Die übrigen zehn: vier Tests mit Uhr,
Kalender oder Zeitzone, eine Abnahme und eine E2E-Bühne, die einer entschiedenen Änderung nicht
nachgezogen wurden, eine verschobene Fundstelle der Nachweismatrix, eine Spec ohne eigene Breite,
ein Kaltstart des Entwicklungsservers, eine Node-Version. **Alle zwölf sind repariert**, je Ursache
ein Commit; die Produktfehler und die Flatterer erst nach dem Entscheid von firstmate. Keine
Zusicherung gelockert, kein Test abgeschaltet, kein `retries`, kein verlängerter Timeout.

## Die Summen je Suite

| Suite | Lauf | Ergebnis |
|---|---|---|
| **`services/api`** (Vollsuite, gemessener Stand) | `./mvnw clean test -Dspring.test.context.cache.maxSize=4`, EIN Lauf | `Tests run: 10427, Failures: 9, Errors: 9, Skipped: 4` · 670 von 670 Klassen · `Total time: 10:44 h` (davon gut sechs Stunden Ruhezustand) |
| **`services/api`** (die sechs roten Klassen, Stand `8fd679ebc` + Reparaturen; #1384 und alles danach ändern in `services/api` nichts) | `clean`, `-Dtest=` die sechs Klassen | **`Tests run: 42, Failures: 0, Errors: 0, Skipped: 0`** · BUILD SUCCESS |
| **`services/timescale-writer`** | `./mvnw clean test` | **`Tests run: 249, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/ingest`** | `./mvnw clean test` | **`Tests run: 125, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/optimization`** | `PYTHONPATH=.:../forecast .venv/bin/python -m pytest` (vorher `import highspy`) | **`1570 passed`**, 0 übersprungen |
| **`services/forecast`** | `pytest` mit den Extras `ml` und `db` (die DB-Datei startet eine Timescale) | **`163 passed`**, 0 übersprungen |
| `services/market-data` · `services/marketing-adapter` | `pytest` (zusätzlich) | `134 passed` · `1 passed` |
| **`frontend/portal`** vitest (PR-Stand) | `npx vitest run`, vollständig | **`Test Files 605 passed (605)` · `Tests 12235 passed (12235)`** |
| **`frontend/portal`** typecheck · build (PR-Stand) | `npm run typecheck` · `npm run build` | Exit 0 · `✓ built in 6.75s` |
| **`frontend/portal`** Playwright (PR-Stand) | `npx playwright test`, vier Projekte einzeln | siehe unten — alle **3 172 Fälle in 106 Dateien** gestartet, WebKit eingeschlossen |
| **`catalog/measurement-points`** (PR-Stand) | `pytest tests` (inkl. `test_core_mirrors.py`) | **`50 passed`** |
| | `generate.py --check` · `package_edge_runtime.py --check` | beide Exit 0; „runtime derivatives of catalog 2026.09.23.3 match its runtime version“ |
| `catalog/control-profiles` | `validate.py`, `unittest`, `package_edge_runtime.py --check` (zusätzlich, wie CI) | `Ran 24 tests … OK`, Exit 0 |
| **`edge-app/core`** (PR-Stand) | `go build ./...` · `go vet ./...` · `go test ./...` | Exit 0 · Exit 0 · **49 Pakete `ok`**, 11 ohne Testdateien, 0 FAIL |
| | `go test -race ./internal/lastmgmt/... ./internal/agent/... ./internal/csms/...` (von #1384 berührt) | alle drei `ok`, Exit 0 |
| **`edge-app/nodered`** | `npm test` (`node --test`) | **`tests 1159, pass 1159, fail 0, skipped 0`** |
| **`edge-app/nodered/vp-palette`** | `npm test` (Mocha) | **`224 passing`** |
| `edge/sim` | `node --test` (zusätzlich) | `tests 9, pass 9` |
| **`tools/`** mit eigenen Tests | `pytest` je Ordner | `edge-simulator` 77 · `generalprobe` 24 · `freigabe` 46 · `lastprofil-messung` 11 · `bewertung` **342** (vorher 14 rot, siehe unten) · `uems-verbund-sim` 46 · `nw3-box-image` 3 · `tools/tests` 4 — alle grün |
| **`shellcheck`** | alle 33 Skripte unter `tools/` | `-S warning` Exit 0; 28 Infos (SC2015, SC2016, SC1091, SC2018/2019) |
| **Doku-Werkzeuge** | `check_auswirkungen.sh` · `check_belege.sh` · `build_fachmodell.py --check` · `agents-md-budget.sh` | „44 Tabellen und 12 Dateien geprüft · 0 Fehler“ · „214 Belege geprüft · 0 fehlende Dateien · 0 veraltete Zeilen“ · „aktuell“ · alle Budgets ok |

**Lückenlosigkeit — nachgewiesen, nicht behauptet.** Je Suite `find … -name "*Test.java"` (SOLL)
gegen die Klassen mit einer `Tests run: … in <FQCN>`-Zeile (IST):

```
services/api              SOLL 670 · IST 670 · nicht gelaufen: keine · gelaufen aber nicht im SOLL: keine
services/timescale-writer SOLL  21 · IST  20 · nicht gelaufen: EreignisTabelleImTest
services/ingest           SOLL  23 · IST  23 · nicht gelaufen: keine
```

`EreignisTabelleImTest` ist wie am 19.09. ein Helfer mit privatem Konstruktor (`:33`), keine Testklasse.

### Playwright — alle vier Projekte, 3 172 Fälle

| Projekt | Stand | Ergebnis |
|---|---|---|
| `desktop-chromium` | `8fd679ebc` + Reparaturen | **792 passed · 1 skipped · 0 rot** (17,2 min) |
| `tablet-chromium` | `8fd679ebc` + Reparaturen | 783 passed · 9 skipped · **1 rot** (`berichte.spec.ts:210`) (13,9 min) |
| `mobile-chromium` | `9c764fc32` + Reparaturen | 782 passed · 10 skipped · **1 rot** (`erloese-minus.spec.ts:107`) (13,5 min) |
| `mobile-webkit` | `9c764fc32` + Reparaturen | 778 passed · 11 skipped · **4 rot** (`erloese-minus.spec.ts:107`, `portal-rechte.spec.ts` R1 ×2, `steuerung.spec.ts:79`) (16,2 min) |
| **Summe** | | **3 135 passed · 31 skipped · 6 rot = 3 172** |

Nach #1384 auf `desktop` und `tablet` wiederholt: die 29 Specs, die Aufbau, Ladepunkte, Komponenten
oder die zentrale Liste öffnen — **207/207** und **201 + 6 skipped**, 0 rot. Nach den Reparaturen:
`erloese-minus`, `portal-rechte`, `einstieg` in allen vier Projekten **88 passed**; die 23 Specs, die
die Steuerung betreten oder Blätter öffnen, in allen vier Projekten **876 passed** (je 219), 0 rot, 0 flaky — `steuerung.spec.ts:79` auch in WebKit; `berichte.spec.ts`
in tablet dreimal kalt allein je **7/7**; und der Beleg für den dritten Vorwärm-Wirt: das
Anfangssegment des Gesamtlaufs (`e2e/[ab]*.spec.ts`, 22 Dateien, tablet, vier Worker, frischer
Server) mit altem und mit neuem Vorwärmen je **150 passed**, `berichte.spec.ts:210` 5,8 s bzw.
6,4 s. **Der Unterschied ist nicht messbar** — der Stau des Gesamtlaufs ließ sich bei 64 % freiem
Speicher ohne Fremdlast nicht erzeugen. Der Wirt ist trotzdem gebaut (firstmate-Entscheid), weil der
Fall sonst im nächsten Gesamtlauf unter Last wiederkommen kann.

### Übersprungen ist nicht grün — die vier Sprünge der api, namentlich

| Fall | Grund |
|---|---|
| `UemsQuellenUebergabeTest.a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` | bewusst offen: AP-07 IP-7 schreibt `event.site_id()`, die Herkunft trägt keine Anlage aus der Entität |
| `LoeschzugKatalogApiTest.laufzeitAnEinemGrossenBereich` | Lastmessung, läuft nur mit `-Dloeschzug.zeilen` |
| `MessstellenregisterNachbarbedarfTest.a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen` | Nachbarbedarf A5: eine Wandlerfassung wird noch nicht an die Box zugestellt |
| `UemsBestandSteuerungAusEinemStueckTest.buehneVorherNachherAntwortenAufzeichnen` | nimmt nur unter `tools/buehne-vorher-nachher/run.sh` auf |

Die **31 Playwright-Sprünge** sind alle per Projekt gewollt und annotiert: Telefon-Haptik nur mit
bzw. ohne Berührung und `navigator.vibrate` nur in Chromium (`fahrplan-haptik.spec.ts:72/:105`),
Rechner-Anordnung und gezielte Breiten nur einmal (`erloese-preise.spec.ts:94`, `box-updates.spec.ts:39`,
`summenwert-geraetkarte.spec.ts:198/:303`, `summenwert-hybrid.spec.ts:27/:56`) und die Quelle-Spalte
nur am Rechner (`messstelle-seite.spec.ts:1133`).

## Jedes Rot, eingeordnet

Art: **a** Test/Bühne nicht nachgezogen · **b** Produktfehler · **c** Flatterer (Uhr, Last, Reihenfolge) · **d** Umgebung.

| Klasse / Fall | Fehlerbild | Seit | Art | Hier |
|---|---|---|---|---|
| `tools/bewertung/test_zusagen.py` (14 Fälle, eine Ursache) | „der Wortlaut steht nicht an `glossar.ts:478–479` … steht jetzt an :497–498“ (Z-018), dann dasselbe für Z-075 (722–723 → 746–747) | **#1303** (`e3dda023c`), weiter verschoben durch **#1363** | **a** | repariert: nur die Zeilenangaben, Prüfpaket neu gebaut |
| `AuthScreen.test.tsx` (16 Fälle) | `SecurityError: Cannot initialize local storage without a --localstorage-file path` | `756537d84` (erste Testdatei mit `window.localStorage`) unter Node 25 | **d** | repariert: `--no-experimental-webstorage` für die vitest-Worker |
| `KostenstelleEnergieApiTest.dasSetzenWarntUndLehntNichtAb` | Vorher/Nachher-Text ungleich nur in `berechnet_am` (22:02:18 vs. 22:02:19) | **#1127** (`569ab3336`) | **c** Uhr | repariert: Uhr fest wie die drei Schwesterfälle (firstmate `gl-kostenstelle-uhr` = A) |
| `UemsKennzahlFlaecheNennerTest.eineRueckwirkendGeaenderteFlaeche…KeinenTagFrueher` | „die Kaskade um 2026-10-04T21:05:42Z liegt nicht nach der neuesten Zeile (2026-10-09T22:00:00Z)“ | **#842** (`a4bee91e9`), rot an den Tagen 1–9 jedes Monats | **c** Kalender | repariert: Takt nach dem Lauf vom 10. |
| `UemsEnergiemanagementAbnahmeTest.verantwortungsSatzAufJederFlaeche` | 19 Flächen „ohne Verantwortungs-Satz“ / „ohne Grenz-Satz“ | **#1303** (`e3dda023c`, Entscheid D5) | **a** | repariert: dieselben drei Formen wie `copy.test.ts` (firstmate `gl-grenzsatz-flaechen` = A) |
| `SteuerungSection.test.tsx` „SZ-2 A · befristet pausiert“ | nach 23 Uhr „Pausiert bis morgen 00:30“ statt `/^Pausiert bis \d{2}:\d{2}$/` | **#1376** (`9bd63484f`) | **c** Uhr | repariert: `vi.setSystemTime` auf 12:00 (firstmate 003) |
| `steuerung/messen.test.ts` „messBild (SZ-1 A)“ | mit `TZ=UTC` „Jetzt · 11:10“ statt „13:10“ | **#1376** (`9bd63484f`) | **c** Zeitzone | repariert: Raster aus der Ortszeit (firstmate 003) |
| `AnlageUmzugApiTest` (6 F + 1 E) | `expected: 201 but was: 401`; Klasse lief **5 938 s** | — | **d** Ruhezustand | allein grün (8/0/0/0, 53 s) — nicht angefasst |
| `RegistrationApiTest` (1 F + 2 E) | „cannot retry due to server authentication“; **2 923 s** | — | **d** Ruhezustand | allein grün (5/0/0/0, 34 s) — nicht angefasst |
| `FlowPeakShavingApiTest` (5 E) | `bootstrap` ist `null` (leere Antwort hinter der Anmeldung); **1 075 s** | — | **d** Ruhezustand | allein grün (5/0/0/0, 71 s) — nicht angefasst |
| `PortalApiTest.earningsExpose…WeightedByPvForecast` (vorab als Basis-Rot genannt) | — | — | — | **in diesem Lauf grün** (siehe unten) |
| `AnlagenPage.test.tsx` „AP-13 Bestandsschutz · Cockpit ohne Messfunktion“ (vorab genannt) | — | — | **c** Last | **in diesem Lauf grün**, 431 ms unter api-Last (siehe unten) |
| Playwright `berichte.spec.ts:210` (tablet) | `page.goto` 30 s ohne `load`; Trace: 139 Modulanfragen an den Vite-Server ohne Antwort, erste Welle eine Minute nach Serverstart | — | **c** kalte Übersetzung des Dev-Servers unter Last | repariert: Berichtsseite als dritter Vorwärm-Wirt (firstmate `gl-berichte-kaltstart` = A) |
| Playwright `erloese-minus.spec.ts:107` (beide Telefon-Projekte) | `tr` mit „Pilsting / Herzogau“ nicht gefunden — am Telefon zeigt `AnlagenTabelle` seit #505 Karten, ohne datierten Ladestand | **#1223** (`35261d41c`) | **a** | repariert: der Fall prüft fest bei 1440 px |
| Playwright `portal-rechte.spec.ts` R1 · MD (mobile-webkit, 375 + 1440) | fünf Aufrufe der neuen Steuerung ohne Attrappe an `localhost:8090`, WebKit: „… due to access control checks“ als `pageerror` | **#1363** (Spec in 1b nachgezogen, Bühne nicht) | **a** | repariert: dieselbe Absage ohne Netz in `e2e/startansicht.tsx` |
| Playwright `steuerung.spec.ts:79` (mobile-webkit) | nach Tipp im Blatt schließt Escape das Blatt nicht | `d5ab86a6a` via **#1363** — **auch auf `main`** | **b** | repariert: Escape über `document` mit Stapel (firstmate `gl-blatt-escape` = A) |
| dieselbe Spec, nächste Zusicherung | nach dem Schließen ist der Auslöser `#dev-e-hs` nicht fokussiert | `d5ab86a6a` via **#1363** — **auch auf `main`** | **b** | repariert: 22 Öffner fokussieren ihren Knopf (firstmate `gl-blatt-ausloeser` = A) |

### Der Ruhezustand — warum drei Klassen rot waren, ohne dass etwas kaputt ist

Der Rechner lag ab etwa 23:30 in kurzen Schlafphasen (Log-Lücken von je ~16 Minuten) und von
etwa 01:30 bis 07:55 im Akku-Ruhezustand. Alle drei Klassen melden sich an einem
Keycloak-Container an und liefen mitten in diese Lücken; danach endeten ihre Anfragen mit 401
bzw. Anmeldefehlern — abgelaufene Token oder ein im Schlaf gestörter Container, genauer ist es
nicht untersucht, weil es nichts am Code ist. Belegt durch die
Laufzeiten (5 938 s, 2 923 s, 1 075 s statt 34–71 s) und durch die Wiederholung auf dem
PR-Stand: unverändert, allein, **42 von 42 grün** zusammen mit den drei reparierten Klassen.

### Die zwei vorab genannten Basis-Roten

- **`PortalApiTest.earningsExposeTheForwardExpectedMarketValueWeightedByPvForecast`** war hier
  grün (Vollsuite: `Tests run: 93, Failures: 0` in der Klasse). Am Code lässt sich der
  Mechanismus benennen, reproduziert ist er nicht: die Klasse teilt EINE Datenbank, der Fall legt
  seine CH-Preise mit `ON CONFLICT DO NOTHING` auf `now() + 1/2/3/4 h`, und `price_slot` nimmt je
  Viertelstunde den gespeicherten Preis. Die früher beobachtete Zahl 17,777 ist genau 1600/9/10
  statt 1360/9/10 — der −40-Slot trug also einen fremden Preis 200. Kandidaten im heutigen Code
  sind die drei Schwesterfälle, die CH 200 ebenfalls mit `DO NOTHING` auf feste
  Kalender-Viertelstunden legen (`:4525`, `:4781`, `:7291`: der 11., 13. und 15. des Monats,
  18:00 Europe/Berlin) — sie treffen den Fall nur, wenn er an einem dieser Tage zwischen 15:00 und
  15:15 Uhr läuft und der Schwesterfall vor ihm. Ob die früheren Beobachtungen genau so lagen, ist nicht mehr nachprüfbar.
  Kleinste Reparatur, wenn er wieder auftaucht (nicht in diesem PR): die vier Preiszeilen dieses
  Falls mit `ON CONFLICT (bidding_zone, resolution, ts) DO UPDATE` setzen — die Hausregel, die der
  Nachbarfall `:4654` schon trägt („Die Preise gehören diesem Test“).
- **`AnlagenPage.test.tsx` „AP-13 Bestandsschutz · Cockpit ohne Messfunktion“** war hier grün,
  im vollen vitest-Lauf unter der api-Last 431 ms, allein fünfmal 234–357 ms. Bis `205f42e15`
  (Nachzug 1a) fotografierte der Fall deterministisch den Platzhalter `vp-eb-warten` der lazy
  geladenen Energie-Bühne; seither wartet er auf sie. Übrig ist die 1-s-Vorgabe von `waitFor`
  für diesen Chunk: unter starker Fremdlast kann die erste Übersetzung der Bühne im Worker
  länger dauern. Kein Befund dieses Laufs.

## Die Reparaturen — ein Commit je Ursache

| Commit | Ursache | Art | Auslöser |
|---|---|---|---|
| Nachweismatrix: Fundstellen von Z-018 und Z-075 mitziehen (+ Prüfpaket neu gebaut) | Wortlaut in `glossar.ts` verschoben | a | #1303, #1363 |
| Portal-vitest: Node-Web-Storage in den Test-Workern abschalten | Node 25 verdeckt jsdoms `localStorage` | d | Maschine (seit `756537d84` sichtbar) |
| `KostenstelleEnergieApiTest`: Uhr beim Vorher/Nachher-Vergleich fest | `berechnet_am` der Live-Uhr | c | #1127 |
| `UemsKennzahlFlaecheNennerTest`: Takt der Kaskade nach dem Lauf vom 10. | Kalender, Tage 1–9 | c | #842 |
| `SteuerungSection`-Test: befristete Pause zu fester Mittagszeit | nach 23 Uhr „morgen“ | c | #1376 |
| `messen`-Test: Raster aus der Ortszeit | Zeitzone der Maschine | c | #1376 |
| `UemsEnergiemanagementAbnahmeTest`: Flächen in der D5-Form | Abnahme nicht nachgezogen | a | #1303 (D5) |
| E2E: Berichtsseite als dritter Vorwärm-Wirt | kalte Übersetzung unter Last | c | — |
| `erloese-minus`-Spec: „Meine Anlagen“ fest bei 1440 px | Telefon zeigt Karten | a | #1223 |
| E2E-Bühne `startansicht`: Steuerungs-Aufrufe von R1 ohne Netz | Bühne nicht nachgezogen | a | #1363 |
| Steuerungs-Blatt: Escape über den Stapel | **Produkt**, auch auf `main` | b | `d5ab86a6a` via #1363 |
| Steuerungs-Blätter: Öffner fokussieren ihren Knopf | **Produkt**, auch auf `main` | b | `d5ab86a6a` via #1363 |

Zu den beiden Produktfehlern: sie betreffen Safari/WebKit (iPhone, iPad, Safari am Mac mit Tastatur);
Chromium fokussiert einen angeklickten Knopf und zeigte sie nie. Neue Vitest-Fälle halten beide fest
(`Blatt.test.tsx`, `SteuerungSection.test.tsx` „Safari: …“; mit dem alten Code je rot). **Nicht**
geändert, weil kein fokussierbarer Knopf als Auslöser da ist: die Balken-Segmente als `<span>`
(`GeraeteReiter.tsx:190/243/565`), die SVG-Zeilen des Zeitbands (`onRow`, `Zeitband.tsx:121`) und die
programmatischen Öffnungen (`SteuerungSeite.tsx:123/425/455`). `EnergieBuehne` merkt sich ihren
Auslöser schon selbst; `AnlageTechnik` nutzt kein Steuerungs-Blatt, sondern ein Haus-Modal.

## Der Tor-Prüfer gegen den gemessenen Stand

`stand.txt` nennt `9bd63484f`; die Surefire-Berichte der Vollsuite liegen außerhalb des Repos
(`--laeufe`). „Bericht vom“ ist die Kopierzeit der Berichte (06:09 UTC), nicht die Laufzeit.

```
Tor G0 - Zusammenfuehren - uems nach main in einem Stueck
Geprueft am 2026-10-05 06:09 UTC gegen 9bd63484 (HEAD, 2026-10-04 19:20 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [belegt] V0  Migrations-Waechter: erst der Satz von main, dann der Rest  (§3.4)
      TEST-com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-10-05 06:09 UTC (Stand 9bd63484 laut stand.txt, derselbe Commit)
  [belegt] NW-2  Steuerung aus einem Stueck  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest.xml: 11 Tests, 0 Fehler, 1 uebersprungen, Bericht vom 2026-10-05 06:09 UTC (Stand 9bd63484 laut stand.txt, derselbe Commit)
  [offen] M-2  Probe-Zweig gruen, PR-904-Tabelle  (§3.4)
      main 38b2b0f8 ist kein Vorfahre von 9bd63484; die Zusammenfuehrung ist nicht geprobt oder main ist weitergewandert (Crew)
  [belegt] IP-3  Halb-Zustand geschlossen  (§3.4)
      54f69318 vom 2026-09-18: UEMS: Halb-Zustand bei Standortzuordnung schließen (#963)
  [belegt] IP-4  Die erste Minute des Messkunden  (§3.4)
      be04abcf vom 2026-09-18: UEMS AP-14 IP-4: Die erste Minute des Messkunden (#965)
  [belegt] IP-14  Uebergang mit "Was sich aendert"  (§3.4)
      ff89d779 vom 2026-09-18: UEMS AP-14 IP-14: Portal-Bestandsschutz für den Übergang (#967)
  [belegt] IP-15  Zuordnung korrigieren  (§3.4)
      f020278b vom 2026-09-18: AP-14 IP-15: Zuordnung geführt korrigieren (#968)
  [belegt] IP-9  UEMS-Metriken in der api  (§3.4)
      c45fc08f vom 2026-09-18: UEMS-Metriken in der api: Arbeitslisten, Läufer, Messkunden-Eingang und Bestands-Läufer (AP-14 IP-9) (#966)
  [belegt] IP-19  Sprach-Waechter und Release-Notiz  (§3.4)
      a1072ed3 vom 2026-09-18: AP-14 IP-19: Sprach-Wächter und Release-Notiz (#978)

8 belegt · 1 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt
Tor G0: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.
```

**M-2 war offen, weil `main` weitergewandert war** — #1380, #1381 und #1382 standen auf `main`,
aber noch nicht auf `uems`. Das ist kein Test, sondern ein fehlender Nachzug; #1384 hat ihn
während des Laufs geliefert, auf dem PR-Stand ist `main` wieder Vorfahre. Die Ausgaben gegen den
PR-Stand (mit frischen Berichten der Nachweisklassen) stehen im PR-Text.

**G1** gegen denselben Stand: `3 belegt · 13 offen · 1 mit hingenommenem Befund`. Belegt sind die
maschinellen Punkte NW-4 (Messkunden-Lauf), NW-6k und R1 (Standort-Zaun); offen sind
ausschließlich Punkte des Betreibers (M-1a/b, NW-1, NW-8, NW-5, NW-6, L6, P, M-4/M-4b, F6, B9, W1).

## Der Rebase am Ende — und was danach wiederholt wurde

Zweimal gelandet, zweimal rebased:

| Gelandet | berührt | Wiederholt auf dem PR-Stand |
|---|---|---|
| #1379 (`8fd679ebc`, Nachzug #1378) | `frontend/portal/src/steuerung/laden.ts`, `laden.test.ts`, `SteuerungSeite.tsx` | vitest vollständig, typecheck, build |
| #1384 (`9c764fc32`, Nachzug #1380–#1382) | `edge-app/core/internal/{agent,csms,lastmgmt}` (12 Dateien), `frontend/portal/src/komponenten.ts`, `zentraleListe.ts` und ihre Tests | Go build/vet/test, `-race` für die drei Pakete, Katalog-Wächter, vitest vollständig, typecheck, build, Playwright `mobile-chromium` und `mobile-webkit` komplett, auf `desktop`/`tablet` die 29 berührten Specs |

Dazu auf dem PR-Stand: die sechs roten api-Klassen (`clean`) und für den Tor-Prüfer die sechs
Nachweisklassen. **Nicht wiederholt**, weil von #1379, #1384 und den Reparaturen unberührt:
api-Vollsuite, writer, ingest, Python, Node-RED, Werkzeuge, Doku-Werkzeuge — ihre Zahlen stammen
vom gemessenen Stand `9bd63484f`, der Vorfahre des PR-Standes ist.

## Hausregeln und wie gemessen wurde

- **`clean` überall**; jede Java-Zahl aus `./mvnw clean test`, die Phasen wörtlich im Aufruf.
- **Die api-Vollsuite als EIN Lauf**, allein; daneben nur container-freie Läufe (Go, Node-RED,
  Python, vitest) und nacheinander writer, ingest und die Forecast-DB-Datei — höchstens zwei
  Testcontainers-Läufe zugleich, jeder Start bei ≥ 35 % freiem Speicher. Nie der lokale
  Docker-Stack.
- **Playwright erst nach der api-Suite und nie neben einem Testcontainers-Lauf**, projektweise,
  auf eigenem Port (4291) über eine unversionierte Kopie der Konfiguration; die Browser liegen im
  Worktree (`PLAYWRIGHT_BROWSERS_PATH`, WebKit `webkit-2336` dort installiert — nichts außerhalb).
  Als #1384 landete, lief `tablet-chromium` zu Ende und die Kette wurde per PID beendet, damit die
  Telefon-Projekte erst auf dem neuen Stand liefen. Fremdlast: zeitweise eine vitest-Bahn im
  Worktree 1.
- Die Summenwert-Specs schreiben bei jedem Lauf 15 versionierte Bilder unter `e2e/shots/` neu;
  diese Nebenwirkung wurde jedes Mal verworfen und ist nicht Teil dieses Berichts.
- vitest des gemessenen Standes lief **unter** der api-Last vollständig; nur AuthScreen war rot.

## Was dieser Lauf NICHT sagt

- **Er sagt nichts über Produktion** — außer dass die zwei Blatt-Fehler der Steuerung dort heute
  stecken (`main`). Alles lief gegen Testcontainers und die E2E-Bühne, nie gegen eine
  Produktionsdatenbank oder eine echte Box.
- **Er sagt nichts über die Lücken, die kein Test hat.** Ein grüner Lauf beweist keine Abdeckung.
  Die zwei Produktfehler zeigten sich nur, weil diesmal WebKit lief.
- **Er sagt nichts über die api-Vollsuite AUF dem PR-Stand.** Sie lief auf `9bd63484f`; der
  PR-Stand ändert in `services/api` nur drei Testklassen, die mit den drei Schlaf-Klassen allein
  grün gefahren wurden.
- **Er sagt nichts über weitere Uhr-, Kalender- und Zeitzonen-Fälle.** Vier der zwölf Ursachen
  hingen daran und fielen nur, weil der Lauf nachts, am 4. eines Monats und auf einer Maschine mit
  Node 25 lief. Weitere solche Fälle findet nur ein Lauf zu anderer Zeit oder unter `TZ=UTC`.
- **Er sagt nichts über die Tore G1, GA und GB** außer den maschinellen Punkten; den Rest liefert
  der Betreiber.
- **Er sagt nicht, dass ein Tor offen ist** — das öffnet nur der Betreiber.
