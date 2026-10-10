# Gesamtlauf `mispel` nach dem Nachzug von `main` — 10.10.2026

Dieser Lauf beantwortet die Frage des Captains vom 10.10.2026: `uems` steht seit #1470 ganz in
`main` — **lässt sich `mispel` auf `main` mergen, und funktioniert danach alles noch im Sinne von
MiSpeL?** Gemessen ist der Zweig `fm/vp-mispel-nachzug-uems-1403` (PR #1406): `mispel` plus `main`
als echter Merge-Commit — erst `1fc3b93be`, am Ende `99944c896`, weil `main` während des Laufs
weitergewandert ist. Das ist der Baum, der nach dem Merge von #1406 auf `mispel`
steht und mit einem weiteren Merge nach `main` ginge. Auf Forgejo läuft kein PR-CI; Form, Befehle
und Regeln folgen dem Lauf vom 05.10. ([gesamtlauf-mispel-2026-10-05.md](gesamtlauf-mispel-2026-10-05.md))
und dem `uems`-Lauf vom 09.10. ([gesamtlauf-2026-10-09.md](gesamtlauf-2026-10-09.md)).

**Gemessener Stand:** erster Merge-Commit `9e2fdca7b` (`origin/main` `1fc3b93be` in `505549943` =
`mispel` `58450740d` + `uems` `9a80c1ec1`), darauf zwei Reparaturen (`33c8527b2`), darauf der zweite
Merge-Commit **`a926bda58`** (`origin/main` `99944c896`) — das ist der **Endstand**. `origin/uems`
`6f5cdcdac` ist Vorfahre von `main`; auf `mispel` und `uems` ist während des Laufs nichts gelandet.
Die vollen Läufe (api-Vollsuite, Playwright in vier Projekten) maßen den Stand vor dem zweiten Merge;
was er berührt, lief auf dem Endstand noch einmal. **Jede Java-Zahl stammt aus einem `clean`-Lauf**,
die Phasen wörtlich im Aufruf.

## Das Ergebnis in fünf Sätzen

**`mispel` ist mit `main` `99944c896` zusammenführbar, und MiSpeL funktioniert danach wie vorher** — mit
zwei Dingen, die ohne diesen Lauf erst nach dem Merge aufgefallen wären, und beide sind repariert: der
Einstieg des Portals lag nach dem Merge mit 259,77 kB gz über der Grenze des Deploy-Tors, das `main`
am 09.10. eingeführt hat (jetzt 254,10), und ein MiSpeL-Migrationstest war gegen die neue Spalte aus
„Sonne + Speicher“ nicht nachgezogen (das einzige Rot der api-Vollsuite, 735 von 735 Klassen). Die
19 MiSpeL-Migrationen kommen in Produktion außer der Reihe an, hinter zwölf jüngeren von `main`; eine
ausgeführte Probe zeigt, dass Schema und Inhalte danach gleich einer frischen Datenbank sind. Der
Steuerstand von `main` verfälscht keine MiSpeL-Rechnung; er öffnet aber zwei Lücken am Fahrzeug, die
heute nicht erreichbar und entschieden sind. Offen bleiben vier Playwright-Fälle und ein
Vitest-Fall, alle von `main` geerbt oder nur unter Last — **kein Rot aus dem Merge, keins aus
MiSpeL.**

## Der Merge: fünf Konflikte

`git merge origin/main` (`1fc3b93be`) in `505549943`: 53 Commits, 219 Dateien, fünf Textkonflikte in
drei Themen. Der zweite Merge (`99944c896`, 58 Dateien) hatte keinen Textkonflikt.

| Datei | Beide Seiten | Auflösung |
|---|---|---|
| `docs/bewertung/nachweismatrix.json` | Quelle der Zusagen Z-018 und Z-075 zeigt auf Zeilen in `glossar.ts`; `mispel` hatte `:509–510` / `:758–759`, `main` `:515–516` / `:863–864` | keine der beiden: im zusammengeführten `glossar.ts` stehen die Sätze an **`:537–538`** und **`:885–886`**. `tools/bewertung/zusagen.py` (MX3) nennt die Zeilen selbst und ist danach grün |
| `docs/bewertung/pruefpaket/pruefpaket.md` · `protokoll-vorlage.json` · `pruefpaket.sha256` | erzeugte Dateien, sie tragen die Prüfsumme der Matrix | nicht von Hand gelöst: mit `tools/bewertung/pruefpaket.py` aus der zusammengeführten Matrix neu gebaut; `--check` und `shasum -a 256 -c` grün |
| `frontend/portal/e2e/standort-ebenen.spec.ts` (O18) | `mispel` hat den Fall je Adresse geteilt (Entscheid `gm-e2e-mehrfachaufruf` = A, #1392/#1405); `main` hat mit K2 (#1482) die Zusicherungen geändert und den Fall wieder als eine Schleife über sieben Adressen mit `test.slow()` geschrieben | Aufbau von `mispel` (je Adresse ein Fall, 14 Fälle), Zusicherungen von `main` (Route `#/portfolio`, Überschrift nur als Sprungziel, Reiter „Übersicht“ und „Energie“) |

**Beidseitig geändert ohne Textkonflikt** (im ersten Merge 15 Dateien, darunter `api.ts`, `glossar.ts`,
`copy.test.ts`, `e2e/startansicht.tsx`, `openapi.yaml`, `PortalApiTest.java`,
`UemsBestandSteuerungAusEinemStueckTest.java`; im zweiten neun, darunter `agent.go`, `cloud.go`,
`state.go`, `api.ts`, `openapi.yaml`, `PortalApiTest.java`): je Datei geprüft, ob eine Zeile, die eine
Seite entfernt hat, im Merge noch steht — 0 Treffer in allen. Keine doppelte Flyway-Version.

## Die Summen je Suite

Spalte „Stand“: **M** = erster Merge-Commit `9e2fdca7b` (`main` `1fc3b93be`), **R** = `33c8527b2` (M plus die
zwei Reparaturen), **E** = Endstand `a926bda58` (R plus der zweite Merge, `main` `99944c896`).
„baumgleich“ heißt: der Pfad ist bis zum Endstand unverändert. Was der zweite Merge berührt hat,
lief auf E noch einmal — siehe „Was während des Laufs landete“.

| Suite | Lauf | Stand | Ergebnis |
|---|---|---|---|
| **`services/api`** Vollsuite | `./mvnw clean test -Dspring.test.context.cache.maxSize=4`, EIN Lauf | M | `Tests run: 11290, Failures: 1, Errors: 0, Skipped: 4` · **735 von 735 Klassen** · `Total time: 05:42 h`, davon rund 2:15 h Schlaf des Rechners (siehe Hausregeln) |
| **`services/api`** sechs Klassen nach der Reparatur | `clean`, `-Dtest=` die reparierte Klasse und die fünf, die über eine Schlafphase liefen | R | **`Tests run: 180, Failures: 0, Errors: 0, Skipped: 0`** · BUILD SUCCESS |
| **`services/api`** gezielter Stapel nach dem zweiten Merge, 131 Klassen | `clean`, `-Dtest=`: die von `main` berührten Klassen und ihre Leser, alle 78 Wächter (`*ArchitekturTest`, `*DisciplineTest`, `*WiringTest`, `*SchnittstelleVertragTest`), `MigrationHygieneTest`, `FlywayStartupGuardTest`, `DevSeedGuardTest`, das ganze Paket `mispel` (27), die MiSpeL-Migrationstests, die sechs Tor-Nachweisklassen | **E** | **`Tests run: 1127, Failures: 0, Errors: 0, Skipped: 2`** · BUILD SUCCESS · `PortalApiTest` 93, NW-2 grün |
| **`services/timescale-writer`** | `./mvnw clean test` | M (baumgleich) | **`Tests run: 249, Failures: 0, Errors: 0, Skipped: 0`** · 20 Klassen |
| **`services/ingest`** | `./mvnw clean test` | M (baumgleich) | **`Tests run: 125, Failures: 0, Errors: 0, Skipped: 0`** · 23 Klassen |
| **`services/optimization`** | `PYTHONPATH=.:../forecast .venv/bin/python -m pytest` (vorher `import highspy`), unter der api-Last | M (baumgleich) | **`2549 passed`** in 719 s, 0 übersprungen — davon 906 Fälle in den 20 MiSpeL-Dateien und 22 zum Steuerstand |
| **`services/forecast`** | `pytest` mit den Extras `ml`, `db`, `weather` (über `uv`; die DB-Datei startet ein Postgres) | M (baumgleich) | **`163 passed`**, 0 übersprungen |
| `services/market-data` · `services/marketing-adapter` | `pytest` | M (baumgleich) | `157 passed` · `1 passed` |
| `services/tunnel-dienst` | `go build ./...` · `go vet ./...` · `go test ./...` | M (baumgleich, gleich `main`) | **auf macOS nicht baubar** (Art d, siehe unten); `GOOS=linux`: build und vet Exit 0; nativ liefen nur `soll` und `system` (ok) |
| **`frontend/portal`** Vitest | `npx vitest run`, vollständig, ohne Fremdlast | R · **E** | `Tests 13347 passed (13347)` · **`Test Files 675 passed (675)` · `Tests 13368 passed (13368)`** · `migration.test.ts` 82 |
| | dasselbe unter `TZ=UTC` | R | `Tests 13347 passed (13347)` |
| | erster Lauf, neben `javac` und zwei Vite-Builds | M | `13346 passed`, **1 rot** (Art c, siehe unten) |
| **`frontend/portal`** typecheck · build | `npm run typecheck` · `npm run build` | M · R · **E** | Exit 0 · Exit 0 |
| **`frontend/portal`** Bündel-Rauchtest (Deploy-Tor) | `npm run test:bundle` | M · R · **E** | **FAIL 259,77 kB gz** (Grenze 256) · PASS 253,81 · **PASS 254,10 kB gz**, Charts 206,89 kB gz, `index.html` 24 948 B |
| **`frontend/portal`** Playwright | `npx playwright test`, vier Projekte einzeln, vier Worker | R | **4 360 Fälle in 124 Dateien gestartet: 4 243 grün, 113 gewollt übersprungen, 4 rot aus zwei Ursachen**, beide von `main` geerbt |
| | nach dem zweiten Merge: `desktop-chromium` komplett, dazu 23 Specs gezielt in den drei anderen Projekten | **E** | **`desktop-chromium` 1 088 grün, 1 übersprungen, 1 rot** (wieder `boot-flow.spec.ts:285`, 3 310 ms, geerbt) · in den drei anderen Projekten je **169 grün, 32 gewollt übersprungen, 0 rot** |
| **`catalog/measurement-points`** | wie CI: `update_deye_key_lock.py --check`, `extract_shelly.py --check`, `generate.py --check`, `validate.py`, `unittest discover`, dazu `pytest tests` (mit `test_core_mirrors.py`), `package_edge_runtime.py --check` | M · **E** | alle Exit 0 · „validated 2395 points in catalog 2026.09.23.3“ · `Ran 50 tests … OK` · `50 passed`, 56 Untertests · „runtime derivatives … match“ |
| `catalog/control-profiles` | `validate.py`, `unittest`, `package_edge_runtime.py --check` | M · **E** | „control profiles valid: 24 profiles“ · `Ran 24 tests … OK` · „up to date“ |
| **`edge-app/core`** | `go build ./...` · `go vet ./...` · `go test -count=1 ./...` | M · **E** | Exit 0 · Exit 0 · **56 Pakete `ok`, 15 ohne Testdateien, 0 FAIL (71 von 71 Paketen) auf beiden Ständen** |
| | `go test -race -count=1 -timeout 45m` für `agent`, `lastmgmt`, `csms`, `ocppsim`, `entladeschutz` | M · **E** | **alle fünf `ok`** auf beiden Ständen (agent 437 s und 431 s), kein `DATA RACE` |
| **Edge Light** (`edge-light/scripts/test.sh`, Schritte einzeln) | JS-Vektoren · `go vet` · `go test -race` der vier Zwillings-Pakete · `GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build ./cmd/vp-edge-light` | M · **E** (vet und MIPS-Build) | 6 von 6 · Exit 0 · 4 Pakete `ok` · MIPS-Build Exit 0 auf beiden Ständen |
| **`edge-app/nodered`** | `npm test` (`node --test`), Abhängigkeiten per `npm install --no-package-lock` | M · **E** | `tests 1165, pass 1165` · **`tests 1186, pass 1186, fail 0, skipped 0`** |
| **`edge-app/nodered/vp-palette`** | `npm test` (Mocha) | M · **E** | **`224 passing`** auf beiden Ständen |
| `edge/sim` | `node --test` | M · **E** | `tests 9, pass 9` auf beiden Ständen |
| **`tools/`** mit eigenen Tests | `pytest` je Ordner (`uv`, mit `jsonschema`, `paho-mqtt`, `pyyaml`) | M · `bewertung` auch E | `bewertung` **342** (191 Untertests) · `edge-simulator` 95 · `freigabe` 48 · `generalprobe` 25 · `lastprofil-messung` 11 · `nw3-box-image` 3 · `tools/tests` 4 · `uems-verbund-sim` 46 — alle grün |
| `tools/deploy` · `tools/ota` · `tools/pki` · `tools/backup` (Selbsttests) | `test-gitops-image-bump.sh`, `test-gitops-bump-workflow.sh`, `test-release-publish.sh`, `test-release-workflow.sh`, `test-manifest-schema.py`, `test-acl-grants.sh`, `test-backup-metrics.sh`, `test-backup-restore.sh` | M (baumgleich) | PASS ×2 · „80 bestanden“ · „66 bestanden“ · „alles gruen“ · 31 passed · 21 PASS · **36 PASS, 0 FAIL** (echter Zyklus in Wegwerf-Containern) |
| **`shellcheck`** | `-S warning` über 59 Skripte (`tools/`, `edge-app/`, `edge-light/`) | M · **E** | `tools/` und `edge-light/` ohne Warnung · 6 Warnungen in drei Dateien von `edge-app` (SC2034 ×4, SC2115 ×2), Altbestand `main` |
| **Doku-Werkzeuge** | `check_auswirkungen.sh` · `check_belege.sh` · `build_fachmodell.py --check` · `agents-md-budget.sh` · `zusagen.py` · `pruefpaket.py --check` | M · R · **E** | „44 Tabellen und 12 Dateien geprüft · 0 Fehler“ · „227 Belege geprüft · 0 fehlende Dateien · 0 veraltete Zeilen“ · „aktuell“ · alle Budgets ok · „Wache hält: 48 Sätze … 76 Zusagen“ · „Prüfpaket hält“ |

**Lückenlosigkeit — nachgewiesen, nicht behauptet.** Je Suite die `*Test.java` des gemessenen Standes
(SOLL) gegen die Klassen mit einer `Tests run: … in <FQCN>`-Zeile (IST):

```
services/api              SOLL 735 · IST 735 · nicht gelaufen: keine · gelaufen aber nicht im SOLL: keine
services/timescale-writer SOLL  21 · IST  20 · nicht gelaufen: EreignisTabelleImTest (Helfer mit privatem Konstruktor)
services/ingest           SOLL  23 · IST  23 · nicht gelaufen: keine
```

Gegenüber `main` (701 Klassen) kommen 34 api-Klassen dazu, 27 davon im Paket
`com.voltpilot.api.mispel` (535 Tests, kein Rot).

### Übersprungen ist nicht grün — die vier Sprünge der api, namentlich

Dieselben vier wie am 05.10. und 09.10., MiSpeL bringt keinen dazu:

| Fall | Grund |
|---|---|
| `UemsQuellenUebergabeTest.a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` | bewusst offen: AP-07 IP-7 schreibt `event.site_id()`, die Herkunft trägt keine Anlage aus der Entität |
| `LoeschzugKatalogApiTest.laufzeitAnEinemGrossenBereich` | Lastmessung, läuft nur mit `-Dloeschzug.zeilen` |
| `MessstellenregisterNachbarbedarfTest.a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen` | Nachbarbedarf A5: eine Wandlerfassung wird noch nicht an die Box zugestellt |
| `UemsBestandSteuerungAusEinemStueckTest.buehneVorherNachherAntwortenAufzeichnen` | nimmt nur unter `tools/buehne-vorher-nachher/run.sh` auf |

### Playwright — alle vier Projekte, 4 360 Fälle in 124 Dateien

Gefahren auf `33c8527b2` (Stand R, vor dem zweiten Merge), projektweise mit vier Workern, ohne Wiederholungen
(`retries` ist nicht gesetzt), nie neben einem Testcontainers-Lauf. `--list` nennt 4 360 Fälle in
124 Dateien (1 090 je Projekt; die 125. Spec, `buehne-vorher-nachher`, ist ohne `BUEHNE_PHASE` gewollt
ausgenommen); alle wurden gestartet, kein Projekt fiel aus, kein Browser fehlte. Gegenüber `main` am
09.10. (3 616 in 115) kommen die neun MiSpeL-Specs und die geteilten Fälle dazu.

| Projekt | grün | rot | übersprungen | Dauer |
|---|---:|---:|---:|---|
| `desktop-chromium` | 1 087 | 2 | 1 | 23,7 min |
| `tablet-chromium` | 1 052 | 1 | 37 | 19,7 min |
| `mobile-chromium` | 1 053 | 0 | 37 | 16,9 min |
| `mobile-webkit` | 1 051 | 1 | 38 | 20,7 min |
| **Summe** | **4 243** | **4** | **113** | 81 min |

Die vier roten Fälle haben zwei Ursachen, **beide von `main` geerbt** (die Dateien sind baumgleich zu
`main`), keine aus dem Merge und keine aus MiSpeL:

| Fall | Projekte | Fehlerbild | Gegenlauf |
|---|---|---|---|
| `boot-flow.spec.ts:285` „UEMS-Übersicht (Unternehmensebene): der Cover hebt mit ihrem ersten Bild ab“ | `desktop-chromium`, `tablet-chromium` | „der Cover hing 7919 ms“ bzw. „5199 ms“ (Grenze 2 500) | der Spec allein, je Aufruf ein kalter Dev-Server, je drei Runden in zwei Projekten: **im Merge-Baum 4 von 6 Aufrufen mit einem roten Fall, auf `main` `1fc3b93be` 3 von 6** (2,6 bis 3,8 s) |
| `boot-flow.spec.ts:307` „Deep-Link auf einen Reiter der Anlage“ | `desktop-chromium` | „der Cover hing 2678 ms“ | derselbe Gegenlauf; im Volllauf fiel der Fall zusätzlich in die Minuten, in denen ein Nachlauf der Doku-Wächter daneben lief |
| `nachweisen-blattwechsel.spec.ts:24` „Gruppen-Blatt → Teil-Blatt → schließen“ | `mobile-webkit` | `mouse.wheel: Mouse wheel is not supported in mobile WebKit` | auf `main` genauso rot; im Bericht vom 09.10. als bekannt geführt |

**Was der Trace zu `boot-flow` zeigt:** die API-Antworten sind nach 2,8 s da; danach lädt die Seite
3,4 s lang nur Module vom Dev-Server (436 Anfragen), erst dann fragt die Übersicht ihre Kennzahlen
an. Es wartet keine Antwort der Attrappe und kein Zeitgeber des Portals — der Fall misst vom
Seitenaufruf an und bezahlt den Kaltstart des Vite-Dev-Servers mit. `boot-flow` ist die zweite Spec
jedes Projekts und trifft den Server kalt; in `mobile-chromium` und `mobile-webkit` war derselbe Fall
grün. Dieselbe Wurzel wie die Last-Roten vom 05.10. (jede Bühne lädt Hunderte Module einzeln vom
Dev-Server).

**Die drei WebKit-Fälle zum Safari-Fokus vom 09.10.** (`fernwartung.spec.ts:51` und `:252`,
`energiemanagement-mappe.spec.ts:65`) sind grün — PR #1486 hat sie auf `main` behoben.

**Alle neun MiSpeL-Specs sind in allen vier Projekten ohne Rot** (`foerderweg`, `haushalt`,
`ladepunkt-ertraege`, `mispel-check`, `mispel-durchstich`, `mispel-mengen`, `mispel-w5`, `msb-abgleich`,
`wallbox-karte`), ebenso die 14 geteilten O18-Fälle aus dem Konflikt und alle Specs der geteilten
Bühne `startansicht`.

**Die 113 Sprünge** sind je Projekt gewollt: desktop 1 wie auf `main`; in den drei anderen Projekten
je 28 mehr als auf `main` (9/9/10 → 37/37/38), weil drei MiSpeL-Specs nur in `desktop-chromium` laufen
und 375 und 1 440 px selbst setzen (`foerderweg` 8, `haushalt` 14, `mispel-check` 6 Fälle).

**Nach dem zweiten Merge** (Endstand `a926bda58`; `main` hatte keine E2E-Datei geändert, aber sieben
Portal-Module der Geräteseite, der Abregelung und der Steuerung): `desktop-chromium` noch einmal
komplett, dazu 23 Specs gezielt in den drei anderen Projekten — die elf, die Geräteseite, Abregelung
oder Flotte öffnen, `steuerung`, `device-edit`, `box-updates`, `cockpit-buehne` und alle neun
MiSpeL-Specs.

| Projekt | Umfang | grün | rot | übersprungen | Dauer |
|---|---|---:|---:|---:|---|
| `desktop-chromium` | komplett, 124 Dateien | 1 088 | 1 | 1 | 19,4 min |
| `tablet-chromium` | 23 Specs | 169 | 0 | 32 | 3,3 min |
| `mobile-chromium` | 23 Specs | 169 | 0 | 32 | 2,6 min |
| `mobile-webkit` | 23 Specs | 169 | 0 | 32 | 3,3 min |

Das eine Rot ist wieder `boot-flow.spec.ts:285` („der Cover hing 3310 ms“) — derselbe geerbte
Kaltstart-Fall; `:307` war diesmal grün. Die 32 Sprünge je Projekt sind die 28 der drei
MiSpeL-Specs, die nur in `desktop-chromium` laufen, dazu `box-updates` 1 und `summenwert-hybrid` 3.

## Die MiSpeL-Abnahmen, ausdrücklich

Je Abnahme die Klassen, Dateien und Specs, die sie tragen — gelaufen auf dem gemessenen Baum, also
mit allem von `main` darin. Die api-Spalte nennt Klassen · Tests · rote Tests im jüngsten Lauf der
Klasse (alle hier genannten liefen auf dem Endstand `a926bda58` noch einmal), die Playwright-Spalte
die Summe über alle vier Projekte auf `33c8527b2`; die neun MiSpeL-Specs liefen auf dem Endstand in
allen vier Projekten erneut ohne Rot.

| Abnahme | api (Klassen · Tests · rot) | Optimierer | Portal Vitest | Playwright (grün · rot · gesprungen, vier Projekte) |
|---|---|---|---|---|
| Förderweg (MP-5, MP-17) | 3 · 61 · 0 | 11 Fälle in 1 Datei | 68 Fälle in 3 Dateien · 0 rot | 8 · 0 · 24 (1 Spec) |
| Mengen der Abgrenzungsoption (MP-8, MP-9, MP-11, MP-21) | 8 · 204 · 0 | 236 Fälle in 3 Dateien | 7 Fälle in 1 Datei · 0 rot | 32 · 0 · 0 (1 Spec) |
| Check-Lauf (MP-13, MP-48) | 1 · 7 · 0 | 49 Fälle in 4 Dateien | 14 Fälle in 2 Dateien · 0 rot | 6 · 0 · 18 (1 Spec) |
| Erträge mit „geschätzt“, Speicher-Erklärung (MP-12, MP-18) | 5 · 22 · 0 | — | 51 Fälle in 3 Dateien · 0 rot | 136 · 0 · 0 (3 Specs) |
| Ladepunkt und Fahrzeug (MP-31 bis MP-39) | 5 · 25 · 0 | 295 Fälle in 5 Dateien | 22 Fälle in 1 Datei · 0 rot | 150 · 0 · 42 (3 Specs) |
| consumer-schedule mit Fahrzeug-Zeilen (MP-41c) | 1 · 24 · 0 | 16 Fälle in 1 Datei | 14 Fälle in 1 Datei · 0 rot | — |
| Netzladen-Sperre an EEG-Anlagen, strenge Ausschließlichkeit (MP-10, MP-45) | 2 · 25 · 0 | 45 Fälle in 2 Dateien | 17 Fälle in 1 Datei · 0 rot | 48 · 0 · 0 (1 Spec) |
| Wallbox „Laden und zurückspeisen“ (MP-41a) | — | — | 60 Fälle in 2 Dateien · 0 rot | — |
| Pauschaloption gesperrt bis zur Genehmigung (MP-5 § 3, MP-26, MP-27) | 5 · 195 · 0 | 221 Fälle in 3 Dateien | 66 Fälle in 2 Dateien · 0 rot | — |
| Nachweis und Abgleich mit dem Messstellenbetreiber (MP-15, MP-16) | 5 · 29 · 0 | — | 3 Fälle in 1 Datei · 0 rot | 16 · 0 · 0 (1 Spec) |
| Durchstich im Simulator (MP-22) | 1 · 1 · 0 | 3 Fälle in 1 Datei | — | 8 · 0 · 0 (1 Spec) |

Dazu, ohne eigene Zeile, weil sie keine Abnahme eines Pakets sind, aber dieselbe Fläche tragen:

- **Box:** die MiSpeL-Pakete der Box (`csms` mit OCPP 2.0.1 und 2.1, `entladeschutz`, `ladepunktsim`,
  `plan`, `plan2`, `agent`) sind Teil der 56 grünen Pakete; `agent`, `csms` und `entladeschutz` liefen
  zusätzlich unter `-race` ohne Befund.
- **Betreiberlisten leer, Pauschaloption gesperrt:** die Vorgaben stehen in der Tabelle „Die
  Betreiberschalter“ unten; ihre Tests sind `test_mispel_strenge.py` (13), die Schalter-Fälle in
  `test_mispel_fahrzeugspeicher.py` und die Ablehnung der Pauschaloption in `FoerderwegApiTest`.
- **„Laden und zurückspeisen“** trägt neben den zwei Vitest-Dateien auch `ladepunkt-ertraege.spec.ts`
  (in der Zeile „Erträge“ gezählt).
- **Der nächtliche Check gegen den Steuerstand** steht im nächsten Abschnitt.

## Jedes Rot, eingeordnet

Art: **a** Test/Bühne nicht nachgezogen · **b** Produktfehler · **c** Flatterer (Uhr, Last, Reihenfolge) · **d** Umgebung.

| Klasse / Fall | Fehlerbild | Seit | Art | Hier |
|---|---|---|---|---|
| `frontend/portal` `npm run test:bundle` (Deploy-Tor) | „der Einstieg ist auf 259.77 kB gz gewachsen (Grenze 256 kB)“ | **#1479** (`22ecb0cd5`, Bündel-Schnitt auf `main`) gegen **#1377** (MP-18c) | **a** | **repariert**: die drei MiSpeL-Wörter in `glossarEinstieg.ts`, 253,81 kB gz (auf dem Endstand 254,10) |
| api `LadepunktBidirektionalMigrationTest.befuellteDatenbankBehaeltIhrVerhaltenBitgenau` | „[auch nach dem ganzen Lauf] … `site_charge_point_allowlist: bestehender Inhalt geändert`“ | **#1443** (`bb2eb070d`, Sonne + Speicher, Migration `V20261006120000`) gegen MP-31 | **a** | **repariert**: die Säule nur um ihre neue Spalte, ihr Wert eigens geprüft |
| Vitest `LastspitzenSection.test.tsx` „AP-13 Bestandsschutz · Verlauf Lastspitzen ohne Messfunktion“ | `Unable to find an element with the text: 8,7 kW` | Fall aus `uems` | **c** Last | **nicht repariert**: einmal rot im ersten Ganzlauf neben `javac` und zwei Vite-Builds; allein 3× 13 von 13, im Ganzlauf auf dem Endstand und unter `TZ=UTC` grün |
| Playwright `boot-flow.spec.ts:285` und `:307` (desktop ×2, tablet ×1) | „der Cover hing 7919 / 5199 / 2678 ms“ (Grenze 2 500) | Fälle aus `main` (`091b97182`, 06.10.) | **c** Kaltstart | **nicht repariert**: auf `main` im Gegenlauf genauso oft rot; der Fall misst den Kaltstart des Dev-Servers mit (siehe Playwright) |
| Playwright `nachweisen-blattwechsel.spec.ts:24` (mobile-webkit) | `mouse.wheel: Mouse wheel is not supported in mobile WebKit` | Fall aus `uems` | **a/d** geerbt | **nicht repariert**: auf `main` genauso rot, dort als bekannt geführt (Bericht 09.10.) |
| `services/tunnel-dienst` `go build`, `go vet`, `go test` auf macOS | `internal/ausgabe/prozess.go:59: undefined: syscall.SOCK_CLOEXEC` | **#1483** (`d438e4d50`, Schlüsselausgabe) | **d** | kein Commit: der Dienst läuft nur auf Linux; `GOOS=linux` baut und prüft sauber. Auf `main` `1fc3b93be` genauso; im `uems`-Lauf vom 09.10. liefen noch 7 Pakete auf macOS |
| `edge-light/scripts/test.sh` | `lib.sh: line 38: envs[@]: unbound variable` | — | **d** | kein Commit: das Skript braucht ein bash ab 4.4, macOS bringt 3.2 mit; die vier Schritte einzeln sind grün |
| `services/forecast` mit der vorhandenen `.venv` | `No module named pytest` | — | **d** | kein Commit: mit `uv` und den Extras 163 von 163 |

**Kein Fund der Art b ist offen.** Zwei Produktlücken wurden gefunden, beide sind heute nicht
erreichbar und von firstmate entschieden (`nm-fahrzeug-beobachtet` = A, `nm-v2x-not-aus` = B); sie
stehen unter „Was `main` an MiSpeL verändert“.

## Was `main` an MiSpeL verändert

`main` trägt seit der letzten gemeinsamen Basis (`b1dca7ce8`, 05.10.) 22 Schritte (19 Merges, drei
Einzel-Commits), die nie in `mispel` gemessen wurden. 73 Dateien haben beide Seiten angefasst; in Quelltext sind das der Optimierer
(`solver.py`, `engine.py`, `inputs.py`, `publisher.py`, `persistence.py`, `domain.py`), die Box
(`plan.go`, `agent/ocpp*.go`, `csms`), die Lade-Seiten des Portals (`steuerung/`) und zwei
Ladepunkt-Stellen der api.

| Was `main` gebracht hat | Wo es MiSpeL trifft | Befund |
|---|---|---|
| **Steuerstand** (#1456): die Box meldet `gesteuert` / `beobachtet` / `not_aus`, der Optimierer plant einen nicht gesteuerten Speicher auf seiner Eigenverbrauchsbahn | Mischbetrieb im Löser (MP-10), Fahrzeug am Ladepunkt (MP-33), nächtlicher Check (MP-13) | **Die MiSpeL-Rechnung bleibt richtig**, siehe unten. Zwei Lücken an den Rändern, beide heute nicht erreichbar und entschieden (`nm-fahrzeug-beobachtet` = A, `nm-v2x-not-aus` = B) |
| **Sonne + Speicher** (#1443, #1449): Ladequelle, die dem Auto Speicherenergie über einer Untergrenze gibt; Migration `V20261006120000` | Tabelle `site_charge_point_allowlist` (MP-31 liest und sät sie), `LadenReiter`, `plan.go`, `ocpp_surplus.go` | ein Test nicht nachgezogen (Art a, repariert): `LadepunktBidirektionalMigrationTest`. Die Spalte `storage_release` ist für jede bestehende Säule `FALSE`; an einer MiSpeL-Anlage ändert sich ohne Wahl des Kunden nichts |
| **Portal: Einstiegs-Bündel** (#1479): Grenze des Deploy-Tors 256 kB gz, das Glossar ist aus dem ersten Bild geschnitten | `speicherAussage.ts` (MP-18c) liegt im Einstieg und holte drei Wörter aus `glossar.ts` | **hätte das Deploy aufgehalten** (259,77 kB gz, Art a, repariert auf 253,81) |
| **Kunden-Übersicht K2** (#1482): Standort- und Unternehmensebene erst, wenn ein Standort misst | die geteilte Bühne `e2e/startansicht.tsx`, O18 in `standort-ebenen.spec.ts` | Konflikt im Merge, gelöst; alle Specs der geteilten Bühne und die 14 O18-Fälle in vier Projekten grün |
| **Fernwartung** (#1458–#1461, #1466, #1467, #1477, #1480, #1483, #1485), Tunnel-Dienst, Fenster-Schlüssel | kein MiSpeL-Code; drei Migrationen mit höheren Versionen als die von MiSpeL | Reihenfolge geprüft, siehe nächster Abschnitt |
| **Edge Light** (#1450), Update-Vertrag (#1452), Box-Art (#1451) | der Go-Code der Box ist derselbe; MiSpeL-Pakete (`csms` 2.0.1/2.1, `entladeschutz`, `plan`) gehen in dasselbe Programm | `vp-edge-light` baut mit dem MiSpeL-Code für MIPS (`GOARCH=mipsle GOMIPS=softfloat`), `go vet` und `-race` der vier Zwillings-Pakete grün |
| **Deye netzseitig** (#1465 Drossel-Slot P3, #1464 Netzregler P4) — gelandet während des Laufs: die Box regelt im Abregel-Slot den Netzpunkt, Portal und :8484 zeigen Ziel und Messung; Migration `V20261010100000` | `agent.go`, `cloud.go`, `state.go`, `api.ts`, `openapi.yaml`, `PortalApiTest.java` (beidseitig, ohne Textkonflikt); der Mischbetrieb plant Abregelung höchstens bis auf die Last | kein Rot: Go mit `-race`, Node-RED, Vitest, 131 api-Klassen und Playwright auf dem Endstand. Der Netzregler greift nur an Deye-Anlagen im Abregel-Slot; **ob er sich mit dem Mischbetrieb verträgt, misst kein Test dieses Laufs** (siehe „Was dieser Lauf NICHT sagt“) |
| **Box-Release-Gate** (#1457), Gesamtlauf-Reparaturen `uems` (#1484), Fokus-Rückkehr (#1486), P1/P2 (#1471), H2, H3, B1, B2 | Tests und Bühnen, die MiSpeL mitbenutzt | alles grün bis auf die geerbten Fälle unter „Jedes Rot“; die drei Safari-Fokus-Fälle vom 09.10. sind grün, der Datenwettlauf im Box-Test ist weg |

### Ein nicht gesteuerter Speicher verfälscht die MiSpeL-Rechnung nicht

Drei Stellen rechnen an einer MiSpeL-Anlage, und jede wurde gegen den Steuerstand geprüft:

1. **Die Abrechnung** — Abgrenzung, Pauschaloption, Monatslauf, Nachweis (api) — rechnet aus
   Zählerwerten, nie aus dem Plan. Der Steuerstand erreicht sie nicht. Belegt durch die
   Rechenwerk- und Vektoren-Klassen (siehe Abnahmen).
2. **Der nächtliche Check** (`simulation/mispel_check*.py`) baut seine Eingaben selbst
   (`simulation/runner.py`), er liest keinen Steuerstand. `battery_observed` ist dort immer die
   Vorgabe `False`; alle Check-Dateien des Optimierers sind grün. **Was das auch heißt:** der Check
   rechnet weiter mit einem steuerbaren Speicher. An einer Anlage, deren Speicher VoltPilot nur
   beobachtet, nennt er Erträge, die diese Anlage heute nicht erreichen kann. Das ist kein
   Rechenfehler, aber eine Aussage ohne Hinweis — als offener Punkt geführt.
3. **Der Fahrplan** im Mischbetrieb (MP-10). Geprobt mit den Fällen aus
   `test_mispel_mischbetrieb.py`, je einmal gesteuert und einmal mit `battery_observed=True`:

   | Fall | gesteuert: Netzladen (1) · Speicher-Einspeisung (2) | beobachtet |
   |---|---|---|
   | gemischter Tag, Prämie schlägt Gutschrift | 5,73 · 3,36 kWh | 0 · 0 |
   | gemischter Tag, Gutschrift schlägt Prämie / weder noch | 0 · 0 | 0 · 0 |
   | billige Nacht mit Saldierung (Netzladen lohnt) | 9,38 · 8,63 kWh, rot 8,63 | 0 · 0 · rot 0 |
   | Netzladen aus (EEG-Klemme) | 0 · 0 | 0 · 0 |
   | negativer Bezugspreis | 5,98 · 8,25 kWh | **9,38** · 0 |

   In jedem Fall liegt die Speicherbahn exakt auf `eigenverbrauch_dispatch` (Abweichung 0,0 kW),
   die Buchung von (1)¼ und (2)¼ stimmt je Viertelstunde mit dem Rechenwerk `mispel_abgrenzung`
   überein, und der Plan trägt `battery_observed`. Der Plan handelt also nicht mehr für einen
   Speicher, den niemand ausführt: kein Netzladen für die Gutschrift, keine Speicher-Einspeisung.

   **Die eine Ausnahme ist kein MiSpeL-Verhalten:** bei negativem Bezugspreis regelt der Plan die PV
   bis auf die Last ab und lädt die festgelegte Bahn aus dem Netz; im Mischbetrieb heißt das
   „Netzladen“. Der Steuerstand legt nur die Speicherbahn fest, nicht die Abregelung. Derselbe Tag
   ohne Mischbetrieb verhält sich gleich (gesteuert wie beobachtet: 9,38 kWh Laden bei gleichzeitigem
   Bezug, 24,0 kWh Abregelung). Es ist eine Plan-Erwartung, keine Abrechnung — und eine Frage an den
   Steuerstand von `main`, nicht an MiSpeL.

### Lücke 1: der Plan des Zurückspeisens entfällt bei beobachtetem Speicher (`nm-fahrzeug-beobachtet` = A)

`engine._shadow_publish_v2` kehrt bei `battery_observed` zurück, bevor `_mit_fahrzeug` den
Fahrzeug-Eintrag anhängt. Das gilt für `not_aus` (dort richtig: die Box schreibt keine Wallbox) und
für `beobachtet` (Wechselrichter ohne Modellfreigabe — die Wallbox wäre steuerbar). Probe mit dem
Aufbau aus `test_mispel_plan_ablage.py`:

| | gesendet | gespeichert | Fahrzeug-Zeilen |
|---|---|---|---|
| gesteuert | 1 Dokument | ja | 4 |
| beobachtet | 0 | nein | 0 |

Der Löser plant das Fahrzeug in beiden Fällen gleich (22,0 kWh zurück, 64,9 kWh laden). Folge an
einer solchen Anlage: `consumer-schedule` ohne Fahrzeug-Zeilen, Wallbox-Karte ohne Plan, kein
Zurückspeisen — ohne dass die Fläche einen Grund nennt. **Heute nicht erreichbar:**
`VOLTPILOT_MISPEL_FAHRZEUG_SITES` ist leer und in `docker-compose.prod.yml` nicht gesetzt.
Entschieden: so lassen bis zum Fahrzeug-Piloten, Folgepaket `vp-mispel-folge-fahrzeug-beobachtet`.

### Lücke 2: das Zurückspeisen kennt den Not-Aus der Box nicht (`nm-v2x-not-aus` = B)

Der Vertrag von `main` ([speicher-steuerstand.md](../contracts/speicher-steuerstand.md)) sagt für
`not_aus`: die Box schreibt weder Speicher noch Wallbox. Die Lastverteilung hält sich daran
(`ocppControlAllowed`). Der V2X-Wächter aus MP-39 (`agent/v2x_entladen.go`,
`entladeschutz.Entscheiden`) liest nur seinen eigenen Schalter. Ausgeführte Wegwerf-Probe mit
`ControlEnabled=false` und `V2XEntladen=true`:

```text
Batterie-Steuerstand=not_aus
ocppControlAllowed=false (Die Steuerung ist an dieser Box abgeschaltet (Not-Aus). Die Ladesäulen halten ihr hinterlegtes Sicherheitsprofil.)
Wächter läuft=true, Ladepunkt-Server lehnt V2X ab=false
Entscheid: EntladenKw=2.80 Grund="nur_haus"; gesendete Sollwerte=[-2.8]; reserviert=true
```

**Heute nicht erreichbar:** `Config.V2XEntladen` ist aus, hat keine Umgebungsvariable und braucht
eine Box-Freigabe (MP-42). Entschieden: nicht in diesem Nachzug, Folgepaket
`vp-mispel-folge-v2x-not-aus` als harte Vorbedingung von MP-42.

### Die Betreiberschalter stehen, wo sie stehen sollen

| Schalter | Stand im Repo | Wirkung |
|---|---|---|
| `VOLTPILOT_MISPEL_STRENGE_SITES` | `docker-compose.prod.yml`: `${VOLTPILOT_MISPEL_STRENGE_SITES:-}` — leer | keine Anlage in der strengen Lesart |
| `VOLTPILOT_MISPEL_FAHRZEUG_SITES` | in `docker-compose.prod.yml` nicht gesetzt — leer | kein Fahrzeug im Modell |
| `voltpilot.mispel.pauschaloption-ab` | `application.yml`: `${VOLTPILOT_MISPEL_PAUSCHALOPTION_AB:}` — leer | jeder Förderweg „marktpraemie_pauschal“ wird abgelehnt |
| `Config.V2XEntladen` (Box) | Vorgabe aus, keine Umgebungsvariable | kein Zurückspeisen |

Geprüft sind die Vorgaben im Repo. Was im GitOps-Repo der Produktion steht, sieht dieser Lauf nicht.

## Die Reihenfolge der Migrationen in Produktion

`main` trägt heute 316 Migrationen, der gemessene Baum 335. Die 19 zusätzlichen sind alle von
MiSpeL und haben Versionen von `V20261002110000` bis `V20261004203700`. **Zwölf Migrationen, die auf
`main` schon liegen, haben höhere Versionen** (`V20261005220000` Wiedervorlage bis `V20261010100000`
Netzregler). Nach einem Merge `mispel` → `main` spielt Flyway die 19 also **außer der Reihe** ein
(`out-of-order: true`) — hinter Migrationen, vor denen sie auf jeder frischen Datenbank und in jedem
Test laufen.

**Statisch:** die zwölf späten `main`-Migrationen und die 19 von MiSpeL fassen keine gemeinsame Tabelle,
keinen gemeinsamen CHECK und keine gemeinsame Funktion an. Keine der beiden Gruppen hat eine
Schleife über den Katalog (`pg_constraint`), die Tabellen der anderen erreichen könnte.

**Ausgeführt:** eine Wegwerf-Klasse nach dem Muster von `UemsProduktionsreihenfolgeMigrationTest`
(Testcontainers, nicht im Repo; zweimal gefahren, gegen `main` `1fc3b93be` mit 315 und gegen
`99944c896` mit 316 Migrationen): erst genau die Migrationen von `main` als Bestand, dann der Rest außer der Reihe, dann der Vergleich mit einer frisch
migrierten Datenbank.

```text
PROBE Bestand=316 Migrationen von main, offen danach=19
PROBE hoechste main-Version V20261010100000__device_curtailment_unit_grid_target.sql, alle offenen liegen davor: true
PROBE Schema und Inhalte nach main-dann-MiSpeL gleich der frischen Datenbank: ja (4300 Spalten, 2343 Constraints)
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 -- BUILD SUCCESS
```

Die 19 offenen sind genau die MiSpeL-Migrationen; danach ist nichts mehr offen, und Spalten,
Vorgaben, Constraints und Tabelleninhalte sind gleich der frischen Datenbank.

**Was der eingecheckte Wächter dazu sagt und was nicht:** `UemsProduktionsreihenfolgeMigrationTest`
ist grün, aber er spielt als Bestand die Liste `main-migrations.txt` — 175 Migrationen vom
`main`-Stand `690806300`, also vor `uems`. Die beiden PRs dieses Tages haben sie nicht fortgeschrieben. Er belegt damit den Schritt `uems` → `main`, nicht den Schritt
`mispel` → `main`. Für diesen gibt es nur die Probe oben, keinen dauerhaften Wächter. Empfehlung: vor
dem Merge nach `main` entweder die Liste auf den Stand von `main` heben (dann fallen die
`uems`-eigenen Zusicherungen der Klasse weg) oder eine eigene Klasse für den MiSpeL-Schritt
einchecken — und beides wiederholen, falls `main` bis dahin eine weitere Migration bekommt.

## Was während des Laufs landete — und was danach wiederholt wurde

`main` ist während des Laufs einmal gewandert, um 12:55 Uhr, eine Stunde nach dem Start der
api-Vollsuite: PR #1465 („Netzseitiger Drossel-Slot (P3)“) und PR #1464 („Deye netzseitig (P4)“), 58
Dateien — der Netzregler der Box (`agent`, `guards`), Node-RED (`deye-grid-target`), das Steuerprofil
`deye_hp3_remote`, Geräteseite und Abregelung im Portal, zwei Listener der api und die Migration
`V20261010100000` (zwei Spalten ohne Vorgabe an `device_curtailment_unit`). Bemerkt hat es der
Tor-Prüfer: M-2 war auf `33c8527b2` offen, weil `main` kein Vorfahre mehr war.

Der neue Stand kam als **zweiter echter Merge-Commit** `a926bda58` dazu, ohne Textkonflikt. Wiederholt
wurde, was er berührt — nicht mehr:

| Wiederholt auf `a926bda58` | Ergebnis |
|---|---|
| `services/api`, 131 Klassen `clean` (berührte Klassen und ihre Leser, alle Wächter, das Paket `mispel`, die MiSpeL-Migrationstests, die Tor-Klassen) | `Tests run: 1127, Failures: 0, Errors: 0, Skipped: 2` |
| Reihenfolge-Probe gegen die 316 Migrationen von `main` | grün, 19 offen, Schema und Inhalte gleich frisch |
| Portal: typecheck, Vitest komplett, `test:bundle` | Exit 0 · 13 368 von 13 368 · PASS 254,10 kB gz |
| Box: `go build`, `go vet`, `go test ./...`, `-race` für die fünf Pakete, Edge-Light-Build für MIPS | 56 Pakete `ok` · alle fünf `ok` · Exit 0 |
| Node-RED, Palette, `edge/sim` | 1 186 von 1 186 · 224 · 9 |
| beide Kataloge, Doku-Werkzeuge, `zusagen.py`, `pruefpaket.py --check`, `shellcheck` | alle grün wie zuvor |
| Playwright: `desktop-chromium` komplett, 23 Specs gezielt in drei Projekten | **`desktop-chromium` 1 088 grün, 1 übersprungen, 1 rot** (wieder `boot-flow.spec.ts:285`, 3 310 ms, geerbt) · in den drei anderen Projekten je **169 grün, 32 gewollt übersprungen, 0 rot** |
| Tor-Prüfer G0, G1, GA, M6 | G0 **9 belegt · 0 offen** |

**Nicht wiederholt**, weil der zweite Merge sie nicht berührt (baumgleich): Optimierer, forecast,
market-data, writer, ingest, die Werkzeug-Tests, der Backup-Zyklus. **Nicht wiederholt, obwohl
berührt:** die übrigen 604 api-Klassen und Playwright komplett in den drei anderen Projekten — siehe
„Was dieser Lauf NICHT sagt“.

## Die acht bekannten Roten der Übersicht (P1/P2 aus #1407)

Die acht bewusst roten Fälle aus PR #1407 belegten zwei Produktfehler der neuen Übersicht: P1, das
Avatar-Menü „Funktionen“ führte auf Unternehmens-Ebene ins Leere, und P2, „Zuordnung korrigieren“
fehlte am Standort. **Beide sind auf `main` behoben** (PR #1471: `87c0bd3d7` und `098ce93a6`), die
Fälle sind dort seit dem 09.10. grün — und **im gemessenen Baum in allen vier Projekten ebenfalls**
(`einstieg`, `uebersicht`, `zuordnung-korrigieren`, `messen-assistent-einstieg`, `leerzustaende`: kein
Rot). Die offene Entscheidung `n1403-p1-p2` dieses Pakets ist damit erledigt.

## Die Reparaturen — ein Commit je Ursache

| Commit | Ursache | Art | Was |
|---|---|---|---|
| `9e2fdca7b` | — | Merge | `origin/main` `1fc3b93be` als echter Merge-Commit, fünf Konflikte (oben) |
| `7e5fcbb58` | #1479 gegen #1377 | a | `MISPEL_NETZLADEN`, `MISPEL_STROMRECHNUNG` und `MISPEL_GUTSCHRIFT` wohnen in `glossarEinstieg.ts`, `glossar.ts` reicht sie unter demselben Namen weiter (Zeilenzahl unverändert), `speicherAussage.ts` importiert von dort; Verlauf im Kopf von `test/bundle-smoke.sh` nachgetragen. Kein Wortlaut, keine Funktion geändert |
| `33c8527b2` | #1443 gegen MP-31 | a | `LadepunktBidirektionalMigrationTest`: nach dem ganzen Lauf weicht genau `site_charge_point_allowlist` ab, ohne `storage_release` ist sie byte-gleich (`Bestandsschutz.inhaltOhne`), und keine bestehende Säule trägt eine Freigabe — das Muster von `UemsEnergiemanagementBestandsschutzTest`. Nur Testcode |

| `a926bda58` | — | Merge | `origin/main` `99944c896` (#1464, #1465) als zweiter echter Merge-Commit, kein Textkonflikt, keine Reparatur nötig |

Keine Zusicherung gelockert, kein Test abgeschaltet, kein `retries`, keine Frist verlängert.

## Der Tor-Prüfer gegen den gemessenen Stand

`bash tools/freigabe/pruefe-tor.sh <Tor> --laeufe <surefire-reports>` auf dem Endstand `a926bda58`, mit
den frischen Surefire-Berichten dieses Standes (die sechs Nachweisklassen aus dem `clean`-Stapel der
131 Klassen) und einer `stand.txt` mit dem Commit. Dieser Bericht kommt als letzter Commit dazu und
ändert keinen Quelltext. Auf `33c8527b2`, vor dem zweiten Merge, zeigte derselbe Prüfer G0 mit 8 belegt
und 1 offen: M-2, weil `main` gewandert war.

```text
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 · metrics.DauerlaeuferGanzerWegDbTest
Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 · measurement.MessplanNachBoxUpdateApiTest
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 · uems.UemsMesskundenLaufAbnahmeTest
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 · uems.UemsProduktionsreihenfolgeMigrationTest
Tests run: 11, Failures: 0, Errors: 0, Skipped: 1 · uems.UemsBestandSteuerungAusEinemStueckTest
Tests run: 15, Failures: 0, Errors: 0, Skipped: 0 · zugriff.RechtMatrixApiTest
```

| Tor | belegt | offen |
|---|---:|---:|
| **G0** Zusammenführen | **9** | **0** |
| G1 Rollout | 3 | 13 |
| GA Box-Auslieferung | 2 | 2 |
| M6 Dauerläufer | 0 | 1 |

Die Tore sind die der UEMS-Freigabe (AP-14); ein eigenes Tor für MiSpeL gibt es nicht. Was sie hier
sagen: der gemessene Baum hält die maschinellen Punkte, die `main` für sich hält — der Nachzug nimmt
keinen zurück. Die vollen Ausgaben stehen im PR-Text.

### G0 — Zusammenführen

```text
Tor G0 - Zusammenfuehren - uems nach main in einem Stueck
Geprueft am 2026-10-10 17:37 UTC gegen a926bda5 (fm/vp-mispel-nachzug-uems-1403, 2026-10-10 17:18 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [belegt] V0  Migrations-Waechter: erst der Satz von main, dann der Rest  (§3.4)
      TEST-com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-10-10 17:37 UTC (Stand a926bda5 laut stand.txt, derselbe Commit)
  [belegt] NW-2  Steuerung aus einem Stueck  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest.xml: 11 Tests, 0 Fehler, 1 uebersprungen, Bericht vom 2026-10-10 17:37 UTC (Stand a926bda5 laut stand.txt, derselbe Commit)
  [belegt] M-2  Probe-Zweig gruen, PR-904-Tabelle  (§3.4)
      5ea736be vom 2026-09-19: Merge pull request 'AP-14 IP-12: Zusammenfuehrung uems + main geprobt - 52 Konflikte belegt, PR-904-Tabelle, Baum bytegleich zu uems' (#981) from fm/vp-uems-b14-ip12-zusammenfuehrung-proben into uems; main 99944c89 ist Vorfahre von a926bda5, Baum f8507218. Die Datei-fuer-Datei-Tabelle zu PR 904 steht im Text von PR 981, nicht im Repo
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

9 belegt · 0 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt
Tor G0: jeder Pruefpunkt hat einen Beleg oder das Wort des Betreibers.
Das Werkzeug oeffnet kein Tor - das tut der Betreiber selbst.
```

## Hausregeln und wie gemessen wurde

- **`clean` überall**; jede Java-Zahl aus `./mvnw clean test`, die Phasen wörtlich im Aufruf.
- **Die api-Vollsuite als EIN Lauf**, allein im Testcontainers-Fenster (0 fremde Container beim
  Start, 49 % Speicher frei). Daneben nur container-freie Läufe, streng nacheinander, und je einzeln
  writer, ingest, die Forecast-DB-Datei, der Backup-Zyklus und die Reihenfolge-Probe — nie mehr als
  zwei Testcontainers-Sitzungen zugleich, jeder Start bei mindestens 35 % freiem Speicher.
- **Der Rechner hat geschlafen — das ist die Abweichung dieses Laufs von der Regel.** Von 13:35 bis
  15:50 Uhr war der Deckel zu und der Rechner am Akku; `pmset -g log` zeigt sieben Schlafphasen von
  13 bis 32 Minuten. `caffeinate -i` hält einen Schlaf bei geschlossenem Deckel nicht auf. Die
  api-Vollsuite wurde dabei angehalten und fortgesetzt, nichts brach ab. **Fünf Klassen liefen über
  eine Schlafphase**: `UemsVerbesserungMigrationTest`, `MessstelleWerteApiTest`,
  `MessstelleZuordnungMigrationTest`, `UemsBezugsbasisBestandsschutzTest` und
  `MessreiheEreignisMigrationTest`. Alle fünf waren grün und liefen danach noch einmal `clean` und
  ohne Unterbrechung: 179 Tests, kein Rot. Jede andere Suite dieses Berichts war vor 13:00 Uhr
  fertig oder lief nach 17:40 Uhr am Netzteil. Ab 15:50 lief der Rechner am Akku (99 % → 41 %),
  ab etwa 17:25 am Netzteil.
- **Solange die Vollsuite lief, wurde keine Datei geändert, die eine noch nicht gelaufene Klasse
  liest** — mit einer benannten Ausnahme: die Bündel-Reparatur (`glossar.ts`, `glossarEinstieg.ts`,
  `speicherAussage.ts`) kam um 12:07 Uhr. `BerichtPdfTest` und `UemsEnergiemanagementAbnahmeTest`
  lesen `glossar.ts`, aber nur auf zwei Sätze, die die Reparatur nicht berührt; beide Klassen sind
  grün. Die Test-Reparatur an `LadepunktBidirektionalMigrationTest` kam erst nach dem Ende der Suite.
- **`main` ist während des Laufs gewandert.** Der zweite Merge kam nach den vollen Läufen; wiederholt
  wurde nur, was er berührt (siehe „Was während des Laufs landete“). Der gezielte api-Stapel lief
  dabei neben den container-freien Nachläufen, Playwright erst danach.
- **Playwright nie neben einem Testcontainers-Lauf**, projektweise mit vier Workern, auf eigenem
  Port (4491) über eine unversionierte Kopie der Konfiguration; die Browser liegen im Worktree
  (`frontend/portal/.pw-browsers`, Chromium 1234, WebKit 2336). In den ersten Minuten des ersten
  Projekts lief noch ein Nachlauf der Doku-Wächter daneben — das war ein Fehler in der Reihenfolge
  dieses Laufs und ist bei den zwei betroffenen Fällen vermerkt.
- Die Node-RED-Suite braucht ihre Abhängigkeiten (`npm install --no-package-lock`), die
  Werkzeug-Ordner `jsonschema`, `paho-mqtt` und `pyyaml`, `services/forecast` seine Extras — ohne sie
  wird übersprungen oder nicht gesammelt. Gezählt ist jeweils der Lauf mit Abhängigkeiten.
- Proben (Steuerstand im Löser, Fahrzeug-Eintrag, Not-Aus an der Box, Reihenfolge der Migrationen)
  waren Wegwerf-Dateien außerhalb des Repos oder wurden vor dem nächsten Commit gelöscht; keine ist
  eingecheckt.
- Die Summenwert-Specs schreiben bei jedem Lauf versionierte Bilder unter `e2e/shots/` neu; diese
  Nebenwirkung wurde verworfen.

## Was dieser Lauf NICHT sagt

- **Er sagt nichts über Produktion.** Alles lief gegen Testcontainers, die E2E-Bühne und simulierte
  Säulen, nie gegen eine Produktionsdatenbank oder eine echte Box. Was im GitOps-Repo an
  Betreiberschaltern gesetzt ist, sieht dieser Lauf nicht.
- **Er sagt nichts über die api-Vollsuite und über Playwright in vier Projekten AUF dem Endstand.**
  Beide liefen vor dem zweiten Merge. Auf dem Endstand liefen 131 von 735 api-Klassen (alles, was
  `main` berührt hat, alle Wächter, alles von MiSpeL, die Tor-Klassen) und Playwright komplett in
  einem Projekt, gezielt in den drei anderen. Eine api-Klasse außerhalb dieses Stapels, die an den
  zwei neuen Spalten von `device_curtailment_unit` hinge, wäre nicht gemessen; gesucht wurde danach
  (kein Test sät die Tabelle und vergleicht den Bestand).
- **Die api-Vollsuite lief nicht ohne Unterbrechung.** Der Rechner schlief dabei gut zwei Stunden;
  fünf Klassen liefen über eine Schlafphase und wurden `clean` wiederholt. Ein Schlaf kann einen
  zeitabhängigen Fall rot machen, aber nicht grün — trotzdem ist es keine Messung wie am 05.10.
- **Er ersetzt keinen dauerhaften Wächter für die Reihenfolge `main` → MiSpeL.** Die Probe war eine
  Wegwerf-Klasse gegen `main` `99944c896`. Bekommt `main` vor dem Merge eine weitere Migration, die
  eine MiSpeL-Tabelle anfasst, sagt die Probe dazu nichts mehr.
- **Er sagt nicht, dass MiSpeL an einer Anlage mit nur beobachtetem Speicher sinnvoll bedient ist.**
  Die Abrechnung stimmt; der Check nennt dort aber Erträge eines steuerbaren Speichers, und der Plan
  des Zurückspeisens entfällt (Lücke 1). Beides ist heute ohne Kunden.
- **Er sagt nichts darüber, wie der neue Netzregler der Box (#1465, #1464) und ein Mischbetriebs-Plan
  zusammen laufen.** Der Regler übernimmt einen Slot, der abregelt und den Speicher nicht entlädt,
  und schreibt dann keinen Speicher-Sollwert mehr; ein Mischbetriebs-Plan kann in genau so einem
  Slot aus dem Netz laden. Beide Seiten kennen einander nicht, und kein Test fährt die Kombination.
  Sie greift nur an Deye-Anlagen mit freigegebenem Hebel und beiden Schreibfreigaben; die
  MiSpeL-Abrechnung misst an den Zählern und hängt nicht daran. Eine Frage für einen eigenen Blick,
  bevor eine MiSpeL-Anlage mit Deye den Netzregler bekommt.
- **Er schließt die Not-Aus-Lücke des Zurückspeisens nicht** (Lücke 2). Sie ist die harte
  Vorbedingung der Box-Freigabe MP-42 und bis dahin nicht erreichbar.
- **Er sagt nichts über `services/tunnel-dienst` unter Test.** Vier seiner Pakete bauen auf macOS
  nicht; gebaut und geprüft ist er für Linux, ausgeführt wurden nur zwei Pakete. Der Baum ist gleich
  `main`.
- **Er sagt nichts über die Rauchtests `test:csp`, `test:cache` und `test:layout` des Deploy-Tors.**
  Die ersten beiden bauen und starten das nginx-Image des Portals; sie liefen hier nicht.
  `test:bundle` lief.
- **Er erklärt `boot-flow` nicht zu Ende.** Belegt ist: die Datei ist gleich `main`, sie ist dort im
  Gegenlauf genauso oft rot, und der Trace zeigt das Laden der Module als die fehlende Zeit. Nicht
  belegt ist, warum der Fall am 09.10. in allen vier Projekten grün war.
- **Er beseitigt nicht die Wurzel der Playwright-Last.** E2E gegen ein gebautes Bündel statt den
  Dev-Server bleibt der Folgeauftrag vom 05.10.
- **Er sagt nichts über die Tore** außer den maschinellen Punkten; den Rest liefert der Betreiber.
  **Er sagt nicht, dass ein Tor offen ist** — das öffnet nur der Betreiber. Und er sagt nicht, dass
  `mispel` nach `main` gehen soll: das entscheidet der Captain.
