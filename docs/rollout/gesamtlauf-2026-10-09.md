# Gesamtlauf `uems` vor der Zusammenführung — 09.10.2026

Der Sammelzweig `uems` geht als Ganzes nach `main`; MiSpeL folgt erst danach. Die Regel des
Betreibers vom 04.10.2026 gilt: `uems` muss **komplett grün gebaut** sein — alle Suiten, nicht nur
die Klassen der einzelnen Pakete. Auf Forgejo läuft kein PR-CI. Dieses Paket
(`vp-uems-gesamtlauf-1009`) misst den Zweig zum dritten Mal in einem Stück, ordnet jedes Rot ein und
repariert nur das Eindeutige. Muster: PR #970, `gesamtlauf-2026-09-19.md`, `gesamtlauf-2026-10-04.md`.

- **Gemessener Stand:** `b36bb9e71` (nach dem ersten Nachzug von `main`, PR #1474). Darauf lief die
  api-Vollsuite und einmal jede andere Suite.
- **Endstand:** `7d5f9e6be` — `uems` `bec5d1134` plus sieben Reparatur-Commits. Dazwischen
  landeten acht PRs, darunter der zweite Nachzug von `main` (PR #1481, aus diesem Lauf). Was sie
  berühren, lief auf dem Endstand noch einmal; der Abschnitt „Was während des Laufs landete“ sagt, was.
- **Jede zitierte Java-Zahl stammt aus einem `clean`-Lauf.**

## Das Ergebnis in fünf Sätzen

Der Zweig trug **elf Ursachen für Rot**; zwei davon hätten nach dem Merge das Deploy oder einen
Neuaufbau aufgehalten: der Einstieg des Portals lag mit 357,89 kB gz weit über der Grenze des
Deploy-Tors, und die Realm-Vorlage ließ sich in ein neues Keycloak nicht mehr importieren. **Beide
sind auf `uems` behoben** (PR #1479, PR #1473), beide an diesem Tag aus Parallelpaketen. Sieben
weitere sind erledigt, ohne dass eine Zusicherung gelockert oder ein Test abgeschaltet wurde: sechs
Tests und Attrappen, die einer Änderung nicht nachgezogen waren (eine davon im zweiten Nachzug von
`main`), und ein Zeitzonen-Fall. **Offen bleiben vier Fälle, alle nur in mobilem WebKit, aus zwei
Ursachen:** in Safari kehrt der Fokus nach einem Blatt oder Dialog nicht zum auslösenden Knopf zurück
(drei Fälle, Produktverhalten), und ein Spec urteilt nach der Breite, wo das Portal nach der
Fähigkeit des Browsers urteilt (ein Fall). **Das Tor G0 zeigt auf dem Endstand 8 von 9 Punkten belegt:**
offen ist allein M-2, weil `main` gegen Ende des Laufs noch einmal weitergewandert ist (dritter Nachzug,
eigenes Paket); vor diesem Schritt von `main` waren es 9 von 9.

## Die Summen je Suite

Spalte „Stand“: **M** = Messstand `b36bb9e71`, **E** = Endstand (bei api und Portal nach den
gelandeten PRs wiederholt; „baumgleich“ heißt: der Pfad ist zwischen M und E unverändert).

| Suite | Lauf | Stand | Ergebnis |
|---|---|---|---|
| **`services/api`** Vollsuite | `./mvnw clean test -Dspring.test.context.cache.maxSize=4`, EIN Lauf, 3:09 h | M | `Tests run: 10693, Failures: 2, Errors: 1, Skipped: 4` · **696 von 696 Klassen** · 3 Klassen rot aus 2 Ursachen |
| **`services/api`** gezielter Stapel, 151 Klassen | `clean`, `-Dtest=` die Liste | E¹ | `Tests run: 2227, Failures: 1, Errors: 0, Skipped: 1` · das eine Rot ist NW-5 aus dem zweiten Nachzug, im Nachzug behoben |
| **`services/api`** Tor-Nachweisklassen + NW-3 + NW-5 | `clean`, 8 Klassen | E | **`Tests run: 41, Failures: 0, Errors: 0, Skipped: 1`** · BUILD SUCCESS |
| **`services/timescale-writer`** | `./mvnw clean test` | E (baumgleich) | **`Tests run: 249, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/ingest`** | `./mvnw clean test` | E (baumgleich) | **`Tests run: 125, Failures: 0, Errors: 0, Skipped: 0`** |
| **`services/optimization`** | `PYTHONPATH=.:../forecast .venv/bin/python -m pytest` (vorher `import highspy`) | M · E | `1655 passed` · **`1656 passed`**, 0 übersprungen |
| **`services/forecast`** | `pytest` mit den Extras `ml` und `db` (die DB-Datei startet ein Postgres) | E (baumgleich) | **`163 passed`**, 0 übersprungen |
| `services/market-data` · `services/marketing-adapter` | `pytest` | M (baumgleich) | `134 passed` · `1 passed` |
| **`services/tunnel-dienst`** | `go build ./...` · `go vet ./...` · `go test ./...` | M · E | Exit 0 · Exit 0 · 7 Pakete ok, 46 → **47 Tests** |
| **`frontend/portal`** Vitest | `npx vitest run`, vollständig | M · E | `Tests 13119 passed` · **`Test Files 663 passed (663)` · `Tests 13153 passed (13153)`** |
| | dasselbe unter `TZ=UTC` | M · E | 6 rot in 6 Dateien · **`Tests 13153 passed (13153)`** |
| **`frontend/portal`** typecheck · build | `npm run typecheck` · `npm run build` | M · E | Exit 0 · Exit 0 |
| **`frontend/portal`** Bündel-Rauchtest (Deploy-Tor) | `npm run test:bundle` | M · E | **FAIL 357,89 kB gz** (Grenze 230) · **PASS 252,27 kB gz** (Grenze 256) |
| **`frontend/portal`** Playwright | `npx playwright test`, vier Projekte einzeln | E | **3 616 Fälle in 115 Dateien gestartet: 3 579 grün, 29 gewollt übersprungen, 8 rot aus 3 Ursachen**; nach der Reparatur der einen (`boot-flow.spec.ts`, 32 von 32 in vier Projekten) bleiben 4 bekannt rote Fälle in `mobile-webkit` |
| **`catalog/measurement-points`** | wie CI: `update_deye_key_lock.py --check`, `extract_shelly.py --check`, `generate.py --check`, `validate.py`, `unittest discover`, dazu `pytest tests` (inkl. `test_core_mirrors.py`), `package_edge_runtime.py --check` | M (baumgleich) | alle Exit 0 · „validated 2395 points in catalog 2026.09.23.3“ · `Ran 50 tests … OK` · `50 passed, 56 subtests passed` · „runtime derivatives … match“ |
| `catalog/control-profiles` | `validate.py`, `unittest`, `package_edge_runtime.py --check` | M (baumgleich) | „control profiles valid: 24 profiles“ · `Ran 24 tests … OK` · „up to date“ |
| **`edge-app/core`** | `go build ./...` · `go vet ./...` · `go test ./...` | M | Exit 0 · Exit 0 · **53 Pakete `ok`**, 15 ohne Testdateien, 0 FAIL (68 von 68 Paketen) |
| | `go test -race` für `lastmgmt`, `agent`, `csms` | M | `lastmgmt` ok · `csms` ok · **`agent` FAIL: DATA RACE** (repariert) |
| | `go test -race -p 1 -timeout 40m ./...` — der ganze Core, wie `edge-images.yaml` | E² | **53 Pakete `ok`, 0 FAIL, kein DATA RACE** |
| **`edge-app/nodered`** | `npm test` (`node --test`, 59 Dateien) | M (baumgleich) | **`tests 1165, pass 1165, fail 0, skipped 0`** |
| **`edge-app/nodered/vp-palette`** | `npm ci`, `npm test` (Mocha) | M (baumgleich) | **`224 passing`** |
| `edge/sim` | `node --test` | M (baumgleich) | `tests 9, pass 9` |
| **`tools/`** mit eigenen Tests | `pytest` je Ordner | M · E | `edge-simulator` 95 · `generalprobe` 24 → 25 · `freigabe` 46 → 48 · `lastprofil-messung` 11 · `uems-verbund-sim` 46 · `nw3-box-image` 3 · `tools/tests` 4 · `bewertung` **15 rot → 342 grün** |
| `tools/deploy` · `tools/ota` (Deploy-Tor) | `test-gitops-image-bump.sh`, `test-gitops-bump-workflow.sh`, `test-release-publish.sh`, `test-release-workflow.sh`, `test-manifest-schema.py` | M (baumgleich) | „all checks passed“ ×2 · „80 bestanden“ · „66 bestanden“ · „alles gruen“ |
| **`shellcheck`** | `-S warning` über 46 Skripte (`tools/**/*.sh`, `edge-app/**/*.sh`) | M | `tools/` ohne Warnung · **4 Warnungen in `edge-app`**, Altbestand `main` |
| **Doku-Werkzeuge** | `check_auswirkungen.sh` · `check_belege.sh` · `build_fachmodell.py --check` · `agents-md-budget.sh` | M · E | „44 Tabellen und 12 Dateien geprüft · 0 Fehler“ · „219 Belege geprüft · 0 fehlende Dateien · 0 veraltete Zeilen“ · „aktuell“ · alle Budgets ok |

¹ gefahren auf `94a942420`; der Endstand unterscheidet sich davon in `services/api` nur in vier
Testdateien des zweiten Nachzugs (NW-2/NW-5), deren drei Klassen danach einzeln grün liefen und im
Lauf der Tor-Nachweisklassen noch einmal mitliefen. ² gefahren mit der reparierten Testdatei, sonst
ist `edge-app/core` baumgleich mit dem Messstand.

**Lückenlosigkeit — nachgewiesen, nicht behauptet.** Je Suite die Testklassen im Baum (SOLL) gegen
die Klassen mit einer Zeile `Tests run: … -- in <FQCN>` (IST):

```
services/api              SOLL 696 · IST 696 · nicht gelaufen: keine · gelaufen aber nicht im SOLL: keine
services/timescale-writer SOLL  21 · IST  20 · nicht gelaufen: EreignisTabelleImTest
services/ingest           SOLL  23 · IST  23 · nicht gelaufen: keine
frontend/portal vitest    SOLL 663 Testdateien · IST 663
edge-app/core             SOLL  68 Pakete · IST 53 ok + 15 ohne Testdateien
services/tunnel-dienst    SOLL   8 Pakete · IST  7 ok +  1 ohne Testdateien
api, gezielter Stapel     SOLL 151 Klassen · IST 151
```

`EreignisTabelleImTest` ist wie bei beiden früheren Läufen ein Helfer mit privatem Konstruktor,
keine Testklasse.

### Übersprungen ist nicht grün — die vier Sprünge der api, namentlich

Dieselben vier wie am 04.10., jeder bewusst und annotiert:

| Fall | Grund |
|---|---|
| `UemsQuellenUebergabeTest.a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` | bewusst offen: AP-07 IP-7 schreibt `event.site_id()`, die Herkunft trägt keine Anlage aus der Entität |
| `LoeschzugKatalogApiTest.laufzeitAnEinemGrossenBereich` | Lastmessung, läuft nur mit `-Dloeschzug.zeilen` |
| `MessstellenregisterNachbarbedarfTest.a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen` | Nachbarbedarf A5: eine Wandlerfassung wird noch nicht an die Box zugestellt |
| `UemsBestandSteuerungAusEinemStueckTest.buehneVorherNachherAntwortenAufzeichnen` | nimmt nur unter `tools/buehne-vorher-nachher/run.sh` auf |

Optimierer, Forecast, writer, ingest, Node-RED und Vitest: 0 übersprungen.

### Playwright — alle vier Projekte, 3 616 Fälle in 115 Dateien

Gefahren auf `a2cf54402` (dem Endstand vor der letzten Spec-Reparatur), projektweise, ohne
Wiederholungen (`retries` ist nicht gesetzt), nie neben einem Testcontainers-Lauf. `--list` nennt
3 616 Fälle in 115 Dateien; alle wurden gestartet, kein Projekt fiel aus, kein Browser fehlte.

| Projekt | grün | rot | übersprungen | Dauer |
|---|---:|---:|---:|---|
| `desktop-chromium` | 902 | 1 | 1 | 14,7 min |
| `tablet-chromium` | 894 | 1 | 9 | 14,6 min |
| `mobile-chromium` | 894 | 1 | 9 | 14,4 min |
| `mobile-webkit` | 889 | 5 | 10 | 17,7 min |
| **Summe** | **3 579** | **8** | **29** | 61 min |

Die acht roten Fälle haben drei Ursachen (die K2-Attrappe, den Safari-Fokus und einen Spec-Zuschnitt):

| Fall | Projekte | Ursache | Stand |
|---|---|---|---|
| `boot-flow.spec.ts:272` „UEMS-Übersicht (Unternehmensebene): der Cover hebt mit ihrem ersten Bild ab“ | alle vier | `waitForRequest('**/api/v1/portfolio/kpis')` läuft in die 30 s: seit PR #1482 (K2) ist die Unternehmensebene erst die Landung, wenn ein Standort misst; die Attrappe des Specs meldete „niemand misst“ | **repariert**, Art (a): der Spec danach 32 von 32 grün in vier Projekten |
| `fernwartung.spec.ts:51` und `:252` | `mobile-webkit` | Fokus kehrt nach dem Dialog nicht zum Knopf zurück (Safari-Fokus, unten) | **bekannt rot**, Art (b) |
| `energiemanagement-mappe.spec.ts:65` (1440 px) | `mobile-webkit` | vordergründig `grantPermissions: Unknown permission: clipboard-write` (Werkzeug); dahinter: das Portal bietet in WebKit „Teilen“ an, der Spec erwartet bei 1440 px „Link kopiert“ | **bekannt rot**, Spec-Zuschnitt (a), Folgepaket |
| `nachweisen-blattwechsel.spec.ts:24` | `mobile-webkit` | vordergründig `mouse.wheel is not supported in mobile WebKit` (Werkzeug); dahinter: der Fokus kehrt nicht zum Auslöser zurück (Safari-Fokus, unten) | **bekannt rot**, Art (b), Folgepaket |

**`gesamtwert.spec` (der E2E-Wettlauf aus §7.3) ist in allen vier Projekten grün.** Die acht bewusst
roten P1/P2-Fälle der neuen Übersicht aus PR #1407 sind es nicht mehr: PR #1471 („Avatar-Menü
‚Funktionen‘“, „Zuordnung korrigieren“) hat beide Produktfehler behoben, die Fälle laufen grün.

Die **29 Sprünge** sind per Projekt gewollt und an acht Dateien annotiert: Telefon-Haptik nur mit bzw.
ohne Berührung und `navigator.vibrate` nur in Chromium (`fahrplan-haptik.spec.ts`), Rechner-Anordnung
und gezielte Breiten nur einmal (`erloese-preise.spec.ts`, `box-updates.spec.ts`,
`summenwert-geraetkarte.spec.ts`, `summenwert-hybrid.spec.ts`), dazu die Varianten-Schalter in
`ort-aenderungen.spec.ts` und `ort-verschieben.spec.ts`.

**Ein abgebrochener Lauf davor, zur Einordnung:** der erste komplette Lauf begann auf dem Stand vor
PR #1482. Sein erstes Projekt endete mit 896 grün, 3 rot, 4 nicht gelaufen — drei Zeitüberschreitungen
in den ersten drei Minuten (`betreiberblatt.spec.ts:70` und `:82`, `bericht-freigeben.spec.ts:226`,
je „Element nicht gefunden“ nach 5 s). Dann landete #1482 mit Änderungen an `App.tsx` und der geteilten
Bühne; die Kette wurde per PID angehalten und nach dem Rebase ganz neu gestartet. Auf dem Endstand
sind diese drei Fälle in allen vier Projekten grün. Sie sind damit als Kaltstart-Wackler einmal
gesehen, nicht erklärt — siehe „Was dieser Lauf NICHT sagt“.

## Jedes Rot, eingeordnet

Art: **a** = Test/Bühne nicht nachgezogen · **b** = Produktfehler · **c** = Flatterer/Last/Zeitzone ·
**d** = Umgebung. Repariert wurden nur (a) und eindeutiges (d); (b) und (c) gingen als
`needs-decision` an firstmate und wurden erst nach dem Entscheid angefasst.

| Klasse / Fall | Fehlerbild | seit | Art | In diesem PR |
|---|---|---|---|---|
| `npm run test:bundle` (Schritt des Deploy-Tors) | Einstiegs-Chunk 357,89 kB gz, Grenze 230 | über viele UEMS-PRs gewachsen; `main` 220,32 | **b** | nein — Entscheid `gl3-buendel-einstieg` = A, behoben durch **PR #1479**; auf dem Endstand PASS 252,27 kB gz |
| `ProduktionsRealmAnmeldungTest` · `ProduktionsRealmImportTest` | `/clients[1]/description (293)` · Keycloak 26.0.5: `Value too long for column "DESCRIPTION CHARACTER VARYING(255)"`, Server startet nicht | **PR #1458** (`5641f62b3`, Fernwartung 1/4 auf `main`) | **b** aus `main` | nein — parallel behoben durch **PR #1473** (`d48e84f76`); die eigene Kürzung entfiel beim Rebase |
| `tools/bewertung` `test_zusagen.py` u. a. (14 Fälle, eine Ursache) | „der Wortlaut steht nicht an `glossar.ts:497–498` … Zeilen verschoben“ (Z-018), dasselbe für Z-075 | **PR #1396**, **#1417** und neun weitere; während des Laufs erneut durch **PR #1479** | **a** | **repariert**: nur die Zeilenangaben, Prüfpaket neu gebaut |
| `tools/bewertung` `HilfeArtikel.test_der_artikel_im_repo_haelt_und_der_check_meldet_ihn` | erwartet „14 Sätze“, der Wächter meldet 13 | **PR #1453** (`fb886b219`, Nachweisen PR7, Befund A20) | **a** | **repariert** |
| `edge-app/core` `TestTheHeartbeatWordAndTheReleasePathReadTheSameGate` unter `-race` | `WARNING: DATA RACE` — Test schreibt `a.Cfg` auf dem laufenden Agenten | Steuerstand 1/3 (`2c9bb10e4` auf `main`), mit Nachzug **PR #1462** | **a** | **repariert** (nur die Testdatei) |
| `AhrenbergDemoLoginTest.dasRealmIstGueltigesJsonUndKenntDenLoginAhrenberg` | `not expected: ["service-account-voltpilot-tunnel-dienst"]` | **PR #1458** (`5641f62b3`), mit dem Nachzug vom 08.10. | **a** | **repariert** |
| Vitest unter `TZ=UTC`: `fahrplanJetzt`, `ladenKachel`, `uemsReferenzunternehmen`, drei AP-13-Bestandsschutz-Schnappschüsse | Berliner Wanduhr erwartet („21:30“ gegen 19:30) | #514 und älter auf `main`; AP-19 IP-1; AP-13 | **c** Zeitzone | **repariert** nach Entscheid `gl3-vitest-utc` = A: `test.env.TZ` in `vitest.config.ts` |
| `KundenbereichBeendetApiTest.jederSchreibwegDesBeendetenKundenbereichsIst409UndNichtsWirdGeschrieben` | „Plattform-Schreibwege ohne Kundenbereich = die Liste, genau“ — zwei neue Routen | zweiter Nachzug von `main` (`690806300`, PR #1477) | **a** | im Nachzug **PR #1481** behoben (NW-5-Liste, mit `main-migrations.txt` 175 und NW-2 nachgemessen) |
| `e2e/boot-flow.spec.ts:272` in allen vier Projekten | `waitForRequest('**/api/v1/portfolio/kpis')` läuft in die 30 s | **PR #1482** (K2: Unternehmensebene erst, wenn ein Standort misst) | **a** | **repariert**: die Attrappe meldet einen messenden Standort |
| **Safari-Fokus**, drei Fälle in `mobile-webkit`: `e2e/fernwartung.spec.ts:51` und `:252`, `e2e/nachweisen-blattwechsel.spec.ts:24` | `expect(ausloeser).toBeFocused()` — `inactive`: nach dem Schließen kehrt der Fokus nicht zum Knopf zurück (beim Blattwechsel verdeckt von `mouse.wheel is not supported in mobile WebKit`) | Fernwartung `:51` seit Nachzug **PR #1468**, `:252` mit **PR #1481**; Blattwechsel seit `5308e09e2` (07.10.) | **b** | **nein, bekannt rot** — Entscheide `gl3-fernwartung-fokus-webkit` = B und `gl3-webkit-werkzeug` = A; das Folgepaket `vp-uems-safari-fokus-rueckkehr` heilt alle drei am Überlagerungs-Stapel |
| `e2e/energiemanagement-mappe.spec.ts:65` bei 1440 px in `mobile-webkit` | `grantPermissions: Unknown permission: clipboard-write`; dahinter erwartet der Spec „Link kopiert“, das Portal zeigt „Teilen“ | seit der Spec besteht (Nachweisen PR6, 07.10.) | **a** Spec-Zuschnitt | **nein, bekannt rot** — im selben Folgepaket `vp-uems-safari-fokus-rueckkehr` |
| `shellcheck -S warning` in `edge-app` (4 Warnungen, 3 Dateien) | SC2115, 3 × SC2034 | Altbestand `main` (byte-gleich, seit August) | — | **nein, nicht angefasst** — Entscheid `gl3-shellcheck-edge` = A |

Nicht rot in diesem Lauf, aber aus einer belegten Ursache repariert: `PortalApiTest` (uhrzeitabhängige
Preis-Kollision; die Reparatur `caf9ea755` lag nur auf `mispel`).

### Kleinere Funde im Einzelnen

**`AhrenbergDemoLoginTest`.** Der Test nagelt die Benutzerliste von
`infra/local/keycloak/voltpilot-realm.json` wortgenau und in Reihenfolge fest. Fernwartung 1/4 hat
dort das Servicekonto `service-account-voltpilot-tunnel-dienst` an zweiter Stelle eingefügt; der
Nachzug vom 08.10. hat den Test nicht mitgezogen. Die erwartete Liste nennt das Konto jetzt an seiner
Stelle, die Zusicherung bleibt `containsExactly`.

**NW-5 im zweiten Nachzug.** `KundenbereichBeendetApiTest` führt eine genaue Liste der
Plattform-Schreibwege ohne Kundenbereich. Die zwei neuen Routen
`PUT`/`DELETE /api/v1/admin/fernwartung/techniker/{id}/ssh-schluessel` tragen keine der Pfadvariablen
`tenantId`/`siteId`/`deviceId` und gehören dorthin — derselbe Befund wie die übrigen
Techniker-Routen. Mit im Folge-Commit des Nachzugs: `main-migrations.txt` per Werkzeug auf 175 und
NW-2 auf `690806300` in einem `git clone --shared` neu aufgenommen, **bytegleich** zur Referenz
(12 035 Bytes, alle 13 Einträge).

**Der Safari-Fokus — eine Ursache, drei Fälle.** `designsystem/components/shell/ueberlagerung.js:80`
merkt sich `document.activeElement` als Rückkehrziel; Safari fokussiert einen angetippten Knopf nicht.
`StandortePage.tsx:54`, `Ortsbaum.tsx:107` und `HelpProvider.tsx:26` merken sich den Auslöser deshalb
ausdrücklich, `FernwartungPage.tsx` und der Blattwechsel im Nachweisen nicht. In Chromium sind alle
Fälle grün. Bei der Fernwartung ist nur die Admin-Seite betroffen; der Blattwechsel (Gruppen-Blatt →
Teil-Blatt → Schließen) liegt in der Kundenfläche „Nachweisen“. **Der dritte Fall war verdeckt:** der
Spec scheitert in mobilem WebKit schon eine Zeile früher am Werkzeug (`mouse.wheel`), und erst eine
Probe ohne diesen Schritt zeigte die Fokus-Zusicherung dahinter. Die Probe-Änderung ist nicht Teil
dieses PR. Kleinste vorgeschlagene Reparatur, als eigenes Paket: der Überlagerungs-Stapel merkt sich
den zuletzt angetippten Bedienknopf und nimmt ihn als Rückkehrziel, wenn `document.activeElement`
beim Öffnen der `body` ist — eine Stelle, heilt alle drei Fälle.

**Die Mappe bei 1440 px in WebKit.** `energiemanagement-mappe.spec.ts` wählt seinen Weg nach der
Breite (unter 720 px „Teilen“, sonst „Link kopieren“); das Portal wählt nach der Fähigkeit
`navigator.share`, die WebKit bei jeder Breite hat. Vordergründig scheitert der Fall an
`grantPermissions(['clipboard-write'])`, das Playwright in WebKit nicht kennt; mit einer
Zwischenablage-Attrappe (geprobt, nicht Teil dieses PR) zeigt sich dahinter „Speichern · Teilen · CSV
· Einsicht geben“ statt „Link kopiert“. Kein Produktfehler — der Spec muss für WebKit nach der
Fähigkeit urteilen.

## Der Fund, der das Deploy aufgehalten hätte: der Einstieg des Portals

`npm run test:bundle` ist ein Schritt des Test-Jobs in `.forgejo/workflows/deploy.yaml`; `build` und
`gitops-tag-bump` hängen per `needs` daran. Auf `uems` ist er rot:

```
== 2/6 · Einstiegs-Chunk unter 230 kB gz ==
   index-D1iGksaj.js: 357.89 kB gz (Grenze 230 kB)
FAIL: der Einstieg ist auf 357.89 kB gz gewachsen (Grenze 230 kB).
```

Nach dem Merge `uems` → `main` wäre das Deploy also am Test-Tor stehen geblieben. Der
Bereitschaftsbericht vom 05.10. kennt den Punkt nicht, und keiner der früheren Gesamtläufe hat den
Rauchtest gefahren — er stand in keiner Suitenliste.

| Stand | Einstieg roh | gz | Quellen im Einstieg |
|---|---:|---:|---:|
| `main` `d59bb91c8` | 671 929 Zeichen | **220,32 kB** | 159 |
| `uems` `b36bb9e71` | 1 122 931 Zeichen | **357,89 kB** | 229 |

Beide im selben Bau gemessen (`npx vite build --sourcemap`, wie der Rauchtest; `main` aus
`git archive` in einem Wegwerf-Ordner, gleiche `package-lock.json`). Die Sourcemap ordnet den
Zuwachs zu: **71 Quellen liegen nur auf `uems` im Einstieg (347 536 Zeichen minifiziert)**, dazu
102 489 Zeichen Zuwachs in gemeinsamen Quellen. Die größten Posten:

| Zeichen | Quelle | Weg in den Einstieg |
|---:|---|---|
| 42 076 | `src/components/UnterstuetzungKarte.tsx` | allein über die statisch importierte `pages/BenutzerPage.tsx` |
| +35 401 | `src/api.ts` | gemeinsam, gewachsen |
| 16 530 | `src/kostenstellenUebersicht.ts` | u. a. `components/PortfolioTabs.tsx` |
| 15 169 | `src/anlageEnergiebilanz.ts` | u. a. `useAnlageSurface.ts`, `components/EbenenCockpit.tsx` |
| 14 185 | `src/uemsEreignis.ts` | u. a. `uemsOberflaechen.ts` |
| 14 130 | `src/uemsBericht.ts` | `messstelleSeite.ts`, `nachweisBerichte.ts` |
| +13 113 | `src/App.tsx` | gemeinsam, gewachsen |

Mit angehobener Grenze (`LIMIT_KB=400`) laufen alle sechs Schritte des Rauchtests durch: kein Motion
im Einstieg, Chart-Bündel 206,89 kB gz (Grenze 210), Wortmarke inline, `index.html` 24 948 B
(Grenze 27 000). **Rot ist allein der Einstieg.**

**Art (b), nicht in diesem PR repariert.** firstmate hat entschieden (`gl3-buendel-einstieg` = A): ein
eigenes Paket nimmt die UEMS-Module aus dem statischen Importgraphen von `App.tsx` in Lazy-Stücke; die
vollständige Auswertung (alle 71 Quellen mit Größen) ging als Datei an dieses Paket. Es ist während
des Laufs gelandet: **PR #1479** (`22ecb0cd5`) — `BenutzerPage` lazy, zehn Hilfs-Module statt ganzer
UEMS-Module, Einstieg 357,89 → 252,37 kB gz, die Grenze in `bundle-smoke.sh` und `deploy.yaml` dabei
von 230 auf 256 kB gehoben. Auf dem Endstand dieses Laufs (mit dem zweiten Nachzug von `main`):

```
PASS · Einstieg 252.38 kB gz, Charts 206.89 kB gz, index.html 24948 B, Wortmarke inline, kein Motion im Einstieg.
```

Der Kopfraum bis zur neuen Grenze beträgt 3,6 kB.

## Der Fund aus `main`: die Realm-Vorlage ließ sich nicht mehr importieren

Zwei api-Klassen waren rot, eine Ursache:

| Klasse | Meldung |
|---|---|
| `ProduktionsRealmAnmeldungTest.keinImportiertesKontoBrichtDieVorgabeUndKeinTextSprengtEineSpalte` | `Expecting empty but was: ["/clients[1]/description (293)"]` |
| `ProduktionsRealmImportTest` (echtes Keycloak 26.0.5, `start --import-realm`) | `Value too long for column "DESCRIPTION CHARACTER VARYING(255)"` · `ERROR: Failed to start server in (production) mode` |

PR #1458 (Fernwartung 1/4, `5641f62b3` auf `main`) hat den Client `voltpilot-tunnel-dienst` mit einer
Beschreibung von 293 Zeichen in `infra/prod/keycloak/voltpilot-realm.json` eingeführt. Die Datei ist
die Vorlage für **neue** Realms (Compose, Projektimage, Wiederaufbau): ein neues Keycloak wäre damit
gar nicht gestartet. Der bestehende Live-Realm wird von `--import-realm` nicht überschrieben und ist
nicht betroffen. Auf `main` steht derselbe Text, dort gibt es die beiden Wächter nicht — sie sind
UEMS-Klassen (AP-20 IP-20) und haben den Fehler erst nach dem Nachzug gesehen.

**Art (b) aus `main`.** Der Fall wurde an diesem Tag zweimal unabhängig gefunden: die
Produktionsprüfung hat ihn parallel behoben — **PR #1473** (`d48e84f76`, Beschreibung jetzt 249
Zeichen) samt eigenem Wächter `RealmImportGrenzenTest` für beide Realm-Dateien. Die eigene Kürzung
dieses Laufs (Entscheid `gl3-realm-beschreibung` = A) kollidierte damit und ist beim Rebase
entfallen; es gilt die `uems`-Fassung. Auf dem Endstand: `ProduktionsRealmAnmeldungTest` 6,
`ProduktionsRealmImportTest` 7, `RealmImportGrenzenTest` 2, `RealmNamenNurAdminTest` grün. `main`
bekommt die Korrektur mit dem Merge.

## Der Datenwettlauf im Box-Test

`go test -race ./internal/agent/...` war rot:

```
WARNING: DATA RACE
Write at … by goroutine 597:
  TestTheHeartbeatWordAndTheReleasePathReadTheSameGate.func1()  battery_control_test.go:125
Previous read at … by goroutine 606:
  (*Agent).ocppControlAllowed()  ocpp.go:876   ← ocppInfo ← publishOcppState ← ocppStep ← ocppLoop
```

Der Test (Steuerstand 1/3, `2c9bb10e4` auf `main`, mit dem Nachzug PR #1462 nach `uems` gekommen)
schrieb `a.Cfg.ControlEnabled` und `a.Cfg.ControlCertifiedFamilies` auf dem laufenden Agenten. Der
Helfer `releaseCoverAgent` hat den OCPP-Lauf dann schon gestartet, und der liest `a.Cfg` ohne Sperre.
Der Helfer nennt die Regel selbst — „Cfg is fixed at start-up - a test that needs a different
configuration sets it here, never on the running agent“ — und bietet dafür den `configure`-Parameter;
die Nachbartests benutzen ihn. **Reiner Testfehler, Art (a):** die drei Zeilen stehen jetzt in
`configure`, vor `startOcpp`. Kein Produktivcode berührt, keine Zusicherung geändert.

Die Datei war byte-gleich mit `main`. Dort besteht der Wettlauf weiter und trifft den Schritt
„Go core (race)“ von `edge-images.yaml` (`go test -race -p 1 -timeout 40m ./...`), bis `uems`
zusammengeführt ist.

## Dreimal in fünf Tagen: die Zeilenangaben der Nachweismatrix

`tools/bewertung` hatte 15 rote Fälle aus zwei Ursachen:

1. **14 Fälle:** der Wortlaut von `UEMS_NORMGRENZE` (Z-018) und `UEMS_VERANTWORTUNG` (Z-075) steht
   unverändert in `frontend/portal/src/glossar.ts`, nur an anderer Stelle (497–498 → 520–521 und
   746–747 → 868–869). Verschoben seit PR #1396 (Wiedervorlage PR1) und PR #1417 (Auswerten PR3);
   insgesamt haben seit dem 04.10. elf Commits und ein Nachzug die Datei bewegt. **Und noch einmal
   während dieses Laufs:** PR #1479 (Einstiegs-Bündel) schob beide Stellen um fünf Zeilen zurück —
   der Wächter wäre auf `uems` gleich wieder rot gewesen. Die Quelle nennt jetzt 515–516 und
   863–864. Nur die Zeilenangaben folgen, das Prüfpaket ist neu gebaut.
   **Das ist dieselbe Reparatur wie `586d8d902` vom 04.10.** — die Quelle als `Datei:Zeile` bricht
   bei jeder Einfügung in `glossar.ts`.
2. **1 Fall, hinter den 14 verborgen:** der Hilfe-Artikel hat seit PR #1453 (Nachweisen PR7, Befund
   A20) bewusst 13 statt 14 Sätze; der Test nagelte die Meldung des Wächters mit „14 Sätze“ fest.

Beide Art (a). Danach `342 passed, 191 subtests passed`.

## Zeitzone: sechs Fälle, die die Berliner Wanduhr voraussetzen

Vitest ist in Ortszeit komplett grün. Die Zusatzprobe unter `TZ=UTC` zeigte sechs rote Fälle in
sechs Dateien:

| Datei | Erwartet | Unter UTC |
|---|---|---|
| `fahrplanJetzt.test.ts:193` (seit #514, byte-gleich mit `main`) | „spätestens 21:30“ | 19:30 |
| `ladenKachel.test.ts:58` (byte-gleich mit `main`) | „seit 14:10“ | 12:10 |
| `uemsReferenzunternehmen.test.ts:2934` (AP-19 IP-1) | Tag aus `2026-09-28T00:00+02:00` | 27.09. statt 28.09. |
| `AnlagenPage`, `LadevorgaengeSection`, `VerlaufChrome` — je ein AP-13-Bestandsschutz-Schnappschuss | gerenderte Uhrzeiten | um zwei Stunden versetzt |

Das Portal zeigt bewusst die Ortszeit des Browsers; die Tests setzen dabei die Berliner Wanduhr
voraus. **Art (c) Zeitzone, nach Entscheid repariert** (`gl3-vitest-utc` = A): `vitest.config.ts`
stellt die Zone der Testprozesse einmal (`test.env.TZ`), so wie `weather.test.ts` es für sich allein
tut. Keine Zusicherung geändert, kein Schnappschuss neu geschrieben. Kein CI-Tor fährt Vitest; der
Befund betrifft nur Rechner außerhalb der Berliner Zone.

## shellcheck: `tools/` sauber, vier Warnungen im Altbestand von `main`

`shellcheck -S warning` über 46 Skripte (`tools/**/*.sh` und `edge-app/**/*.sh`): alle Skripte unter
`tools/` ohne Warnung. Vier Warnungen in drei `edge-app`-Dateien, alle **byte-gleich mit `main`**:

| Datei:Zeile | Meldung |
|---|---|
| `edge-app/nodered/reseed-entrypoint.sh:132` | SC2115 `rm -rf "$DATA_DIR/$d"` — `DATA_DIR` hat die Vorgabe `/data`, `$d` kommt aus einer festen Liste |
| `edge-app/test/e2e-ocpp.sh:71` | SC2034 `S3_STATUS` unbenutzt |
| `edge-app/test/ota-soak/run.sh:283`, `:376` | SC2034 `SIGNAL_ARGS`, `SOAK_RUNNING_VERSION` unbenutzt |

**Altbestand `main`, nicht angefasst** (`gl3-shellcheck-edge` = A): kein CI-Tor prüft das, und die
Prüfstände sowie das Box-Image lassen sich in diesem Lauf nicht fahren.

## Die vorab genannten Basis-Roten — jeder einzeln

Der Bereitschaftsbericht (§7.3) und der mispel-Lauf vom 08.10. nannten neun Fälle, die vor dem Merge
weg oder ausdrücklich belegt sein müssen.

| Fall | Befund in diesem Lauf | Stand |
|---|---|---|
| 16 × `AuthScreen.test.tsx` (Node 25, `localStorage`) | grün: einzeln 16 von 16 und in jeder vollen Vitest-Runde. `vitest.config.ts` schaltet seit dem Lauf vom 04.10. `--no-experimental-webstorage` für die Testprozesse | **erledigt**, kein Rot auf `uems` |
| `AnlagenPage`-Snapshot „Cockpit ohne Messfunktion“ (lastabhängig) | grün in allen fünf vollen Vitest-Runden, auch in der Runde neben der api-Vollsuite. Unter `TZ=UTC` war er rot — nicht aus Last, sondern aus der Zeitzone (unten) | **erledigt** mit der Zeitzonen-Festlegung |
| `PortalApiTest` Marktwert im Klassenstapel | in der Vollsuite grün (93 Tests) — die Kollision trifft nur zwischen 09:00 und 09:30 bzw. 14:00 und 14:15, die Klasse lief außerhalb. Die Ursache war belegt und auf `mispel` behoben (`caf9ea755`), **auf `uems` fehlte die Reparatur**; sie ist jetzt übernommen (`git cherry-pick -x`) | **repariert**, Art (a) |
| `KostenstelleEnergieApiTest.dasSetzenWarntUndLehntNichtAb` | grün (15 Tests), in der Vollsuite und im gezielten Stapel. Die Uhr-Reparatur vom 04.10. steht als `ce737ad04` im Zweig | **bestätigt** |
| Optimierer `consumer_dispatch_p95` und pilsting 192-Slot (Wanduhr) | beide grün in beiden vollen Optimierer-Läufen (1 655 und 1 656 Tests, 0 übersprungen), der erste davon neben der api-Vollsuite unter Last | **nicht aufgetreten**; bleiben Wanduhr-Tests |
| `gesamtwert.spec` (E2E-Wettlauf) | grün in allen vier Projekten des kompletten Laufs | **nicht aufgetreten** |
| `nachweisen-blattwechsel.spec.ts` in `mobile-webkit` (`mouse.wheel`) | rot; hinter der Werkzeuggrenze liegt die Safari-Fokus-Rückkehr (oben) | **bekannt rot**, Art (b), Folgepaket |
| `energiemanagement-mappe.spec.ts` in `mobile-webkit` (`clipboard-write`) | rot; hinter der Werkzeuggrenze urteilt der Spec nach Breite statt nach `navigator.share` (oben) | **bekannt rot**, Spec-Zuschnitt, Folgepaket |
| Datenwettlauf `battery_control_test.go:125` | reproduziert, reiner Testfehler aus `main`, repariert | **repariert**, Art (a) |

## Die Reparaturen — ein Commit je Ursache

| Commit | Betreff | Ursache | Art | Auslöser |
|---|---|---|---|---|
| `056f9f616` | Nachweismatrix: Fundstellen von Z-018 und Z-075 in glossar.ts erneut mitziehen | Wortlaut in `glossar.ts` verschoben (Z-018, Z-075) | a | #1396, #1417 u. a., erneut #1479 |
| `172b27d95` | Bewertung: der Hilfe-Artikel hat seit PR #1453 dreizehn Saetze | Hilfe-Artikel hat bewusst 13 statt 14 Sätze | a | #1453 |
| `12281fd40` | Vitest: Zeitzone der Testprozesse auf Europe/Berlin festlegen | sechs Fälle setzen die Berliner Wanduhr voraus | c | #514 u. a.; Entscheid `gl3-vitest-utc` = A |
| `988564746` | Box-Test: Steuerschalter und Freigabeliste vor dem Start des OCPP-Laufs setzen | Test schreibt die Konfiguration auf dem laufenden Agenten (Datenwettlauf) | a | Steuerstand 1/3 auf `main`, Nachzug #1462 |
| `6d28d3ab5` | PortalApiTest: handgerechnete CH-Preise auf Tages-/Uhrzeit-Slots gehoeren ihrem Fall (DO UPDATE) | handgerechnete Preise kollidieren uhrzeitabhängig in der geteilten Datenbank | a | übernommen von `mispel` (`caf9ea755`) |
| `a2cf54402` | AhrenbergDemoLoginTest: der lokale Realm kennt das Servicekonto des Tunnel-Dienstes | lokaler Realm trägt das Servicekonto des Tunnel-Dienstes | a | #1458, Nachzug vom 08.10. |
| `7d5f9e6be` | E2E boot-flow: die Unternehmens-Landung braucht seit K2 einen messenden Standort | Attrappe kannte die K2-Regel nicht | a | #1482 |

Dazu, außerhalb dieses PR: der zweite Nachzug **PR #1481** mit seinem Folge-Commit (`main-migrations.txt` 175, NW-2 nachgemessen, NW-5-Liste).

**Keine Zusicherung gelockert, kein Test abgeschaltet, kein `@Disabled` gesetzt.** Kein Produktivcode berührt: die sieben Commits ändern Tests, eine Test-Konfiguration und die Zeilenangaben der Nachweismatrix samt neu gebautem Prüfpaket.

## Der Tor-Prüfer gegen den gemessenen Stand

`bash tools/freigabe/pruefe-tor.sh <Tor> --laeufe <surefire-reports>` auf `7d5f9e6be`, mit den frischen Surefire-Berichten dieses Standes und einer `stand.txt` mit dem Commit. Der Bericht selbst kommt als letzter Commit dazu und ändert keinen Quelltext.

| Tor | belegt | offen | Lesart |
|---|---:|---:|---|
| **G0** Zusammenführen | **8** | **1** | offen ist allein **M-2**: `main` ist während des Laufs auf `20b548df2` weitergewandert und damit kein Vorfahre des Endstands mehr. Alle Lauf-Punkte (V0, NW-2) sind mit Berichten dieses Standes belegt. Um 14:39 Uhr, auf `a2cf54402` und mit `main` noch bei `690806300` (dem zweiten Nachzug), zeigte derselbe Prüfer **9 belegt · 0 offen**. M-2 schließt der dritte Nachzug. |
| G1 Rollout | 3 | 13 | belegt NW-4, NW-6k, R1; NW-3 mit hingenommenem Befund; die 13 offenen sind Punkte des Betreibers |
| GA Box-Auslieferung | 2 | 2 | belegt NW-3neu, NW-3u; offen Q08 und CP |
| M6 Dauerläufer | 0 | 1 | IP-18 liegt beim Betreiber |

### G0 — Zusammenführen

```text
Tor G0 - Zusammenfuehren - uems nach main in einem Stueck
Geprueft am 2026-10-09 14:02 UTC gegen 7d5f9e6b (fm/vp-uems-gesamtlauf-1009, 2026-10-09 13:42 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [belegt] V0  Migrations-Waechter: erst der Satz von main, dann der Rest  (§3.4)
      TEST-com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)
  [belegt] NW-2  Steuerung aus einem Stueck  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest.xml: 11 Tests, 0 Fehler, 1 uebersprungen, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)
  [offen] M-2  Probe-Zweig gruen, PR-904-Tabelle  (§3.4)
      main 20b548df ist kein Vorfahre von 7d5f9e6b; die Zusammenfuehrung ist nicht geprobt oder main ist weitergewandert (Crew)
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

### G1 — Rollout

```text
Tor G1 - Ausrollen - der Rollout-Tag; danach haben alle alles (E1 = B)
Geprueft am 2026-10-09 14:02 UTC gegen 7d5f9e6b (fm/vp-uems-gesamtlauf-1009, 2026-10-09 13:42 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [offen] M-1a  Bestandsblatt gegen Produktion gefahren  (§3.4)
      kein --blatt <datei>; der Betreiber faehrt tools/betriebsabfragen/bestand-vor-uems.sql gegen Produktion und gibt Teil A-C heraus (Betreiber)
  [offen] M-1b  Bestandsblatt ausgewertet: Q03 Lage c/f erklaert, Q15 WAL-Archiv laeuft  (§3.4)
      Q03 Lage c/f erklaert - kein --stand <datei> angegeben (Betreiber) · Q15 WAL-Archiv laeuft (AP-20 IP-19) - kein --stand <datei> angegeben (Betreiber)
  [offen] NW-1  Generalprobe an einer wiederhergestellten Kopie  (§3.4 / §4.13)
      kein --generalprobe <verzeichnis>; der Betreiber faehrt tools/generalprobe/ gegen eine wiederhergestellte Kopie und gibt die Ausgabe heraus (Betreiber)
  [offen] NW-8  Rueckweg geuebt, Dauer bekannt  (§3.4 / §4.13)
      kein --generalprobe <verzeichnis>; der Betreiber faehrt tools/generalprobe/ gegen eine wiederhergestellte Kopie und gibt die Ausgabe heraus (Betreiber)
  [hingenommen] NW-3  Jedes ausgelieferte Box-Paar gegen die neue Cloud  (§3.4 / §4.13)
      3 Paar(e) aus paare.json, jedes braucht ein gruenes Protokoll
      docs/rollout/nw3-protokoll-edge-2026.09.4.json vom 2026-09-19T03:20:19Z, Paar edge-2026.09.4: 12 gruen, 0 rot, 1 Befund, 0 nicht gefahren - hingenommen am 27.09.2026 (B5/B10): 6c nach trennung laenger als das ende (X7, B5: Ruhe laeuft nach langer Trennung an der alten Box ab). ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der privaten Registry - der Betreiber muss wissen, was er da vor sich hat
      docs/rollout/nw3-protokoll-edge-2026.09.5.json vom 2026-09-26T12:36:21Z, Paar edge-2026.09.5: 9 gruen, 3 rot, 1 Befund, 0 nicht gefahren - hingenommen am 27.09.2026 (B5/B10): 3 mess-auswahl (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 4a mess-quittung nennt die auswahl angewandt (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 4b samples der box landen als rohzeilen (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 6c nach trennung laenger als das ende (X7, B5: Ruhe laeuft nach langer Trennung an der alten Box ab). ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der privaten Registry - der Betreiber muss wissen, was er da vor sich hat
      docs/rollout/nw3-protokoll-edge-2026.09.6.json vom 2026-10-09T08:38:11Z, Paar edge-2026.09.6: 9 gruen, 3 rot, 1 Befund, 0 nicht gefahren - hingenommen am 27.09.2026 (B5/B10): 3 mess-auswahl (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 4a mess-quittung nennt die auswahl angewandt (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 4b samples der box landen als rohzeilen (Katalogkopplung, B10: api-Deploy vor Box-Release, Drehbuch §2.8); 6c nach trennung laenger als das ende (X7, B5: Ruhe laeuft nach langer Trennung an der alten Box ab). ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der privaten Registry - der Betreiber muss wissen, was er da vor sich hat
  [belegt] NW-4  Durchgehender Messkunden-Lauf  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsMesskundenLaufAbnahmeTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)
  [offen] NW-5  Last "100 Messstellen" als 24-h-Messung  (§3.4 / §3.3)
      24-h-Messung nach Profil L1-L4 auf der Probe-Umgebung; tools/lastprofil-messung/ liegt bereit - kein --stand <datei> angegeben (Crew faehrt, Betreiber stellt die Probe-Umgebung)
  [offen] NW-6  Alarm-Uebung: jeder Alarm einmal, jeder Laeufer-Schalter einmal  (§3.4 / §4.13)
      jeden Alarm einmal ausgeloest, Zustellung an "betreiber" beobachtet, jeden Laeufer-Schalter umgelegt - kein --stand <datei> angegeben (Betreiber)
  [belegt] NW-6k  NW-6 im Kleinen: Dauerlaeufer-Einrichtung ueber die Produktwege traegt bis zur Alarm-Kennzahl  (Drehbuch §14.2 / §14.6)
      TEST-com.voltpilot.api.metrics.DauerlaeuferGanzerWegDbTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)
  [offen] L6  Kapazitaet nach L6 als Zahl  (§3.4)
      Kapazitaet aus der echten Belegung gerechnet, nicht behauptet (W5) - kein --stand <datei> angegeben (Betreiber)
  [offen] P  Pilotkunden gewaehlt und eingewilligt  (§3.4)
      die Handvoll betreuter Kundenbereiche steht und hat eingewilligt - kein --stand <datei> angegeben (Betreiber)
  [offen] M-4  gitops-PR 37 gemergt und ausgerollt - mindestens einen Tag VOR dem Fenster  (§3.4 / Drehbuch §2.2)
      PR 37 gemergt, ein Sync und ein api-Neustart auf dem ALTEN Schema beobachtet - kein --stand <datei> angegeben (Betreiber)
  [offen] M-4b  Die Warnschwelle aus PR 37 gesetzt  (Drehbuch §2.3 / §9.3)
      uems_datenbank_warnschwelle_bytes aus Q14 gesetzt; der Tenant des Dauerlaeufers kommt erst nach Schritt 10 (Tor M6, IP-18) - kein --stand <datei> angegeben (Betreiber)
  [offen] F6  Support-Weg einmal gegangen  (§3.4 / Drehbuch §11)
      der Support-Weg ist einmal von aussen gegangen worden - kein --stand <datei> angegeben (Betreiber)
  [offen] B9  Kundennachricht zum Fenster samt Release-Notiz raus  (§3.4 / Drehbuch §10)
      Nachricht 48 h vorher raus, Release-Notiz mit den sichtbaren Aenderungen dabei; docs/rollout/release-notiz-vorlage.md ist die VORLAGE, keine versendete Nachricht - kein --stand <datei> angegeben (Betreiber)
  [offen] W1  Entscheidung ueber den Start-Waechter auf main  (Drehbuch §9.1)
      die alte api schreibt beim Neustart 18 DELETE-Marker, danach startet die neue nicht; das Drehbuch ist mit und ohne Waechter fahrbar - der Betreiber entscheidet - kein --stand <datei> angegeben (Betreiber)
  [belegt] R1  Standort-Zaun auf geraet/component_definition bleibt, ein fremdes Geraet ist unsichtbar  (Bau-Befund AP-03 IP-5 / Entscheid A vom 21.09.2026)
      TEST-com.voltpilot.api.zugriff.RechtMatrixApiTest.xml: 15 Tests, 0 Fehler, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)

3 belegt · 13 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt · 1 mit hingenommenem Befund
Tor G1: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.
```

### GA — Box-Auslieferung

```text
Tor GA - Edge-Release A - additive Box-Pakete, je Box zugewiesen
Geprueft am 2026-10-09 14:02 UTC gegen 7d5f9e6b (fm/vp-uems-gesamtlauf-1009, 2026-10-09 13:42 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [belegt] NW-3neu  NW-3 gegen das NEUE Image  (§3.4)
      docs/rollout/nw3-protokoll-edge-release-a.json vom 2026-09-27T15:21:23Z, Paar edge-release-a: 13 gruen, 0 rot, 0 Befund, 0 nicht gefahren. ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der privaten Registry - der Betreiber muss wissen, was er da vor sich hat | docs/rollout/nw3-protokoll-edge-uems-7f875011fc46.json vom 2026-10-09T08:45:36Z, Paar edge-uems-7f875011fc46: 13 gruen, 0 rot, 0 Befund, 0 nicht gefahren. ACHTUNG: das Paar ist AUS DEM TAG GEBAUT, nicht das Release-Artefakt der privaten Registry - der Betreiber muss wissen, was er da vor sich hat
  [belegt] NW-3u  Update-Pfad: nach dem Box-Update liefert die Cloud den Messplan im neuen Katalogstand nach  (Generalprobe 23.09.2026 B2)
      TEST-com.voltpilot.api.measurement.MessplanNachBoxUpdateApiTest.xml: 2 Tests, 0 Fehler, Bericht vom 2026-10-09 14:02 UTC (Stand 7d5f9e6b laut stand.txt, derselbe Commit)
  [offen] Q08  Keine Bestandsbox wuerde ihren heutigen Plan ablehnen  (§3.4 / IP-17)
      tools/budgetpruefung/run.sh lesend gegen Produktion gefahren, Teil-D-Liste leer oder erklaert - kein --stand <datei> angegeben (Crew faehrt, Betreiber gibt den Zugang)
  [offen] CP  Core und Palette gemeinsam freigegeben  (§3.4)
      Core und Node-RED-Palette gehen als EIN Release-Stand, nie einzeln - kein --stand <datei> angegeben (Betreiber)

2 belegt · 2 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt
Tor GA: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.
```

### M6 — Dauerläufer

```text
Tor M6 - kein Tor - Rollout-Tag nach Schritt 10 und Nachbeobachtung M-6: was erst mit der neuen api geht (B4)
Geprueft am 2026-10-09 14:02 UTC gegen 7d5f9e6b (fm/vp-uems-gesamtlauf-1009, 2026-10-09 13:42 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [offen] IP-18  Dauerlaeufer-Kundenbereich steht  (Drehbuch §14 / Entscheid B4 vom 27.09.2026)
      Kundenbereich "VoltPilot Dauerlaeufer (intern)" angelegt, zwei Boxen angemeldet, VOLTPILOT_UEMS_DAUERLAEUFER_TENANT und voltpilot:uems_dauerlaeufer gesetzt, Uebung Simulator anhalten -> VoltPilotDauerlaeuferStumm nach 15 min gesehen - kein --stand <datei> angegeben (Betreiber, das Werkzeug liegt bereit)

0 belegt · 1 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt
Tor M6: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.
```

## Was während des Laufs landete — und was danach wiederholt wurde

Der Sammelzweig hat sich an diesem Tag stark bewegt. Die api-Vollsuite maß `b36bb9e71`; bis zum
Endstand kamen acht PRs dazu (der erste Nachzug #1474 ist der Messstand selbst):

| PR | Inhalt | Berührt |
|---|---|---|
| #1475 | Rollout-Drehbuch für den Schritt `uems` → `main` ohne MiSpeL | Doku |
| #1476 | NW-3 für `edge-2026.09.6` und NW-3neu | `Nw3AusgeliefertesBoxImageTest`, `tools/nw3-box-image`, Doku |
| #1479 | Einstiegs-Bündel 357,89 → 252,37 kB gz | 46 Portal-Quellen, `bundle-smoke.sh`, `deploy.yaml` |
| #1473 | Produktionsprüfung B1/B2: Start-Wächter, Rechte-Startlauf, `/me`, Realm-Beschreibung | `SelfHealingFlywayMigrationStrategy`, `RechtPruefung`, `Selbstauskunft`, `ZugriffBestandLaeufer`, Realm-Vorlage |
| #1471 | Avatar-Menü „Funktionen“, „Zuordnung korrigieren“, Berichte/betroffen (die Fälle P1/P2 aus #1407) | Portal, `BerichtController` |
| #1472 | H2: Viertelstunden-Abdeckung nie über 100 % | `VerbrauchRegeln`, Optimierer `verbrauch.py` |
| #1481 | zweiter Nachzug `main` (`690806300`, SSH-Schlüssel des Technikers) — aus diesem Lauf | api mit Migration, Portal mit E2E, `tunnel-dienst` |
| #1482 | Kunden-Übersicht bleibt gewohnt (K2) | 26 Portal-Dateien, darunter `App.tsx` und die geteilte Bühne `e2e/startansicht.tsx` |

**Wiederholt wurde nur das Berührte, und zwar auf dem Endstand:**

- **api:** ein gezielter Stapel von 151 Klassen — alle geänderten und neuen Testklassen, alle Leser
  der sechs geänderten Produktivklassen, die 78 Wächter (`*ArchitekturTest`, `*DisciplineTest`,
  `*WiringTest`, `*SchnittstelleVertragTest`), `MigrationHygieneTest`, `FlywayStartupGuardTest`,
  `DevSeedGuardTest`, die sechs Migrations-Nachbarn, die Viertelstunden- und Fernwartungs-Klassen,
  die sechs Nachweisklassen der Tore und die Klassen der eigenen Reparaturen.
- **Portal:** Typecheck, Build, Bündel-Rauchtest, Vitest komplett (auch unter `TZ=UTC`) und
  **Playwright komplett** — nach #1482 noch einmal von vorn, weil der PR `App.tsx` und die geteilte
  Bühne ändert, an der allein 27 von 116 Specs hängen.
- **Optimierer** (ganze Suite), **`tunnel-dienst`**, `tools/freigabe`, `tools/generalprobe`,
  `tools/nw3-box-image`, `tools/bewertung`, die Doku-Wächter.
- **Nicht wiederholt, weil baumgleich mit dem Messstand** (`git diff --name-only b36bb9e71 HEAD`
  ist für diese Pfade leer): Katalog und Steuerprofile, Node-RED und Palette, `edge/sim`,
  writer, ingest, forecast, market-data, marketing-adapter, `tools/edge-simulator`,
  `tools/uems-verbund-sim`, `tools/lastprofil-messung`, `tools/tests`, die gitops- und
  OTA-Selbstchecks. Im Box-Core ist allein die reparierte Testdatei anders; er lief mit ihr noch
  einmal ganz unter `-race`.

## Hausregeln und wie gemessen wurde

- **`clean` überall**; jede Java-Zahl aus `./mvnw clean test`, die Phasen wörtlich im Aufruf.
- **Die api-Vollsuite als EIN Lauf**, allein im Testcontainers-Fenster (0 fremde Container beim
  Start, 35 % Speicher frei), 3:09 Stunden. Daneben nur container-freie Läufe, streng nacheinander.
  Die Suite war damit langsamer als am 05.10. (22 statt 12 Sekunden je Klasse); der Rechner trug
  drei Bahnen.
- **Solange die Vollsuite lief, wurde keine Datei geändert, die eine noch nicht gelaufene Klasse
  liest.** Die Realm-Vorlage blieb unangetastet, bis `ProduktionsRealmImportTest` durch war — erst
  so wurde der Import-Abbruch am echten Keycloak gemessen statt vermutet.
- **Playwright nie neben einem Testcontainers-Lauf**, projektweise, auf eigenem Port (4391) über
  eine unversionierte Kopie der Konfiguration; die Browser liegen im Worktree unter
  `node_modules/.pw-browsers` (Chromium 1234, WebKit 2336 — nichts außerhalb installiert).
- **Die Plattengrenze** fiel während der Vollsuite von 8,8 auf 6,1 GiB; firstmate hat Docker-Build-Cache
  und unbenutzte Volumes geräumt (`gl3-platte` = A), die Suite lief ungestört weiter.
- writer, ingest und die Forecast-DB-Datei liefen nacheinander neben dem gezielten api-Stapel — nie
  mehr als zwei Testcontainers-Läufe zugleich.
- Die Summenwert-Specs schreiben bei jedem Lauf versionierte Bilder unter `e2e/shots/` neu; diese
  Nebenwirkung wurde jedes Mal verworfen.

## Was dieser Lauf NICHT sagt

- **Er sagt nichts über Produktion.** Alles lief gegen Testcontainers und die E2E-Bühne, nie gegen
  eine Produktionsdatenbank oder eine echte Box.
- **Er sagt nichts über die api-Vollsuite AUF dem Endstand.** Sie lief auf `b36bb9e71`. Danach
  kamen acht PRs; auf dem Endstand liefen 151 gezielt gewählte Klassen, nicht alle 700. Eine
  Wechselwirkung, die keine dieser Klassen berührt, bliebe unentdeckt.
- **Er sagt nichts über den Rest von `main`.** Während des Laufs ist `main` noch einmal
  weitergelaufen: `20b548df2`, fünf Commits aus zwei PRs seit `690806300` (der Tunnel-Dienst gibt im
  offenen Fenster die SSH-Schlüssel aus, die Web-App der Box im Fenster; 42 Dateien in
  `tunnel-dienst`, api und Portal). Dieser dritte Nachzug ist nicht Teil des Laufs; er kommt als
  eigenes Paket kurz vor dem Fenster, mit den davon berührten Suiten (Entscheid
  `gl3-nachzug-main-3` = A).
- **Er erklärt die drei Zeitüberschreitungen des abgebrochenen Playwright-Laufs nicht.**
  `betreiberblatt.spec.ts:70`/`:82` und `bericht-freigeben.spec.ts:226` fielen einmal, in den ersten
  drei Minuten eines Laufs auf dem Stand vor PR #1482. Auf dem Endstand sind sie in allen vier
  Projekten grün, und die Gegenprobe (`--repeat-each=5`, beide Dateien, `desktop-chromium`) ergab
  115 von 115. Ein Kaltstart des Entwicklungsservers ist die naheliegende Lesart, belegt ist sie nicht.
- **Er sagt nichts über die Prüfstände der Box.** `edge-app/test/e2e-ocpp.sh` und
  `e2e-compose.sh` (beide im Edge-CI) starten eigene Compose-Stacks und liefen nicht, ebenso
  wenig `npm run test:csp` und `test:cache` (bauen ein nginx-Image). Sie stehen im Deploy- bzw.
  Edge-Tor und sind in keinem Gesamtlauf bisher gefahren worden.
- **Er sagt nichts über Lücken, die kein Test hat.** Der wichtigste Fund dieses Laufs — der
  Einstieg des Portals — stand in keiner früheren Suitenliste; er fiel nur auf, weil diesmal die
  Schritte des Deploy-Tors selbst mitliefen.
- **Er sagt nichts über Zeitzonen außer Berlin und UTC**, und nichts über Uhrzeiten außerhalb von
  10:30 bis 16:30 an einem 9. des Monats.
- **Er sagt nichts über die Tore G1, GA und M6** außer den maschinellen Punkten; den Rest liefert
  der Betreiber.
- **Er sagt nicht, dass ein Tor offen ist** — das öffnet nur der Betreiber.
