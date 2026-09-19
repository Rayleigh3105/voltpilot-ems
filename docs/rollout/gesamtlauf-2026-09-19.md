# Gesamtlauf `uems` am Ende der AP-14-Bauphase — 19.09.2026

Dieser Lauf misst den Sammelzweig `uems` **in einem Stück**, damit das Tor **G0** des
entschiedenen Konzepts „Erste Produktfreigabe“ einen Beleg **dieses** Standes hat. Auf Forgejo
läuft kein PR-CI; jede Bau-Bahn fährt nur ihre eigenen Klassen. Der erste Gesamtlauf
(PR 970, 18.09.2026) fand so sieben unbekannt rote Klassen aus vier PRs, die
Zusammenführungs-Probe (PR 981) weitere zwölf rote Browser-Fälle aus einer geteilten
E2E-Bühne. Seither sind die PRs 981–990 gelandet.

**Gemessener Stand:** `957217b6` (`origin/uems`, PR 989).
**Ergebnis:** grün — mit **zwei** roten Fällen, die beide beim Wiederholen grün wurden und
unten als Befund (c) eingeordnet sind, nicht repariert.
**Jede Zahl unten stammt aus einem `clean`-Lauf**, die Phasen wörtlich im Aufruf
(zsh zerlegt eine Variable nicht in Wörter).

## Die Summen je Suite

| Suite | Lauf | Ergebnis |
|---|---|---|
| **`services/api`** (Vollsuite) | `./mvnw clean test -Dspring.test.context.cache.maxSize=4`, EIN Lauf | **`Tests run: 8612, Failures: 0, Errors: 0, Skipped: 3`** · BUILD SUCCESS · `Total time: 01:01 h` |
| **`services/timescale-writer`** | `./mvnw clean test` | **`Tests run: 238, Failures: 0, Errors: 0, Skipped: 0`** · BUILD SUCCESS |
| **`services/ingest`** | `./mvnw clean test` | **`Tests run: 119, Failures: 0, Errors: 0, Skipped: 0`** · BUILD SUCCESS |
| **`frontend/portal`** vitest | `npx vitest run`, vollständig | **`Test Files 511 passed (511)` · `Tests 10712 passed (10712)`** |
| **`frontend/portal`** typecheck | `npm run typecheck` | `tsc --noEmit`, Exit 0, keine Ausgabe |
| **`frontend/portal`** build | `npm run build` | `✓ built in 6.68s`, Exit 0 |
| **`frontend/portal`** Playwright | `npx playwright test`, drei Chromium-Projekte | **`1482 passed (15.5m)` · `15 skipped` · 0 rot**, Exit 0 — 1497 Fälle; die **499** Fälle des vierten Projekts `mobile-webkit` sind NICHT gestartet |
| **`catalog/measurement-points`** | `pytest` (inkl. `test_core_mirrors.py`) | **`45 passed, 56 subtests passed`** |
| | `generate.py --check` · `package_edge_runtime.py --check` | beide Exit 0; „runtime derivatives of catalog 2026.09.17.1 match its runtime version“ |
| | `RUNTIME_VERSION` | **2026.08.26.3** — gleich in `core-channel-mirrors.json`, `expected_inventory.json` und `SQL_BY_RUNTIME_VERSION` |
| **`edge-app/core`** | `go test ./...` | 43 Pakete `ok`, 9 ohne Testdateien, **1 Paket FAIL** (`internal/agent`, ein Fall — Befund unten) |
| **`edge-app/nodered`** | `npm test` (`node --test`) | **`tests 1078, pass 1077, fail 0, skipped 1`** |
| **`edge-app/nodered/vp-palette`** | `npm ci && npm test` (Mocha) | **`222 passing (22s)`** |
| **`tools/edge-simulator`** | `pytest` | **`55 passed`** |
| **`tools/generalprobe`** | `pytest` | **`24 passed, 7 subtests passed`** |
| **`tools/freigabe`** | `pytest` | **`27 passed, 4 subtests passed`** |
| **`tools/lastprofil-messung`** | `pytest` | **`11 passed`** |
| **`tools/budgetpruefung`** | `BestandsboxBudgetPruefungTest` (läuft in der api-Vollsuite) | in der Summe oben enthalten |
| **`shellcheck`** | die 8 Skripte, die `uems` gegenüber `main` neu unter `tools/` hat | **keine Warnung, kein Fehler** (`-S warning` Exit 0); nur zwei SC2016-**Infos** in `nw3-box-image/nw3.sh`, wo die einfachen Anführungszeichen Absicht sind: `${appDbUser}` ist ein Flyway-Platzhalter, den `sed` wörtlich ersetzt |

**Lückenlosigkeit — nachgewiesen, nicht behauptet.** Je Suite `find … -name "*Test.java"` (SOLL) gegen
die Klassen mit einer `Tests run: … in <FQCN>`-Zeile (IST):

```
services/api             SOLL 501 · IST 501 · nicht gelaufen: keine · gelaufen aber nicht im SOLL: keine
services/timescale-writer SOLL  18 · IST  17 · nicht gelaufen: EreignisTabelleImTest
services/ingest          SOLL  21 · IST  21 · nicht gelaufen: keine
```

Die **eine** Differenz ist erklärt und kein Loch: `com.voltpilot.writer.EreignisTabelleImTest`
ist trotz seines Namens **keine Testklasse**, sondern ein Helfer mit privatem Konstruktor und
ausschließlich statischen Methoden (`EreignisTabelleImTest.java:24,33`) — er fährt die echte
api-Migration für die Nachbarklassen hoch. Surefire führt ihn zu Recht nicht aus. Die Gegenprobe
„gelaufen, aber nicht im SOLL" ist in allen drei Suiten leer.

### Übersprungen ist nicht grün — die drei Sprünge der api, namentlich

| Klasse | Fall | Warum übersprungen |
|---|---|---|
| `MessstellenregisterNachbarbedarfTest` | `a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen` | „A5 · Nachbar AP-06/Edge: Eine angewendete Wandlerfassung wird noch nicht an die Box zugestellt" — ein ausdrücklich dokumentierter offener Nachbarbedarf |
| `UemsBestandSteuerungAusEinemStueckTest` | `buehneVorherNachherAntwortenAufzeichnen` | `Assumptions.assumeTrue(output != null, "nur der IP-20-Werkzeuglauf zeichnet Portalantworten auf")` — ruht ohne `-Dbuehne.antworten`, ist also Werkzeug, keine Zusicherung |
| `UemsQuellenUebergabeTest` | `a3QuelleAusAnlageHalle1AnBoxMitHeimatHalle2` | AP-07 IP-7 schreibt im `MeasurementWriteRepository`-INSERT weiterhin `event.site_id()`; fremde Heimat erst danach — dokumentierter offener Punkt |

Alle drei sind gewollt und tragen ihre Begründung im Quelltext. **Keiner ist ein abgeschalteter
Test**, keiner verdeckt einen Fehlschlag: die Klasse um ihn herum läuft (`11`, `3` bzw. `20` Tests
mit `Failures: 0`). Für das Tor **NW-2** ist das wichtig: `UemsBestandSteuerungAusEinemStueckTest`
ist dort der Nachweis, und der Sprung liegt in der Aufzeichnungs-Methode des IP-20-Werkzeugs,
nicht in einer Steuerungs-Zusicherung.

### Und die 15 Sprünge von Playwright, namentlich

Alle 15 kommen aus **vier** bewussten Projekt-Weichen im Quelltext, keine aus einem abgeschalteten Test:

| Spec | Fälle | Weiche |
|---|---|---|
| `summenwert-hybrid.spec.ts:27` / `:56` | 2 + 4 | `test.skip(project !== 'desktop-chromium')` — „Ankerlauf einmal (Logik ist engine-unabhängig)" bzw. „Layout-Abnahme läuft einmal" |
| `summenwert-geraetkarte.spec.ts:198` / `:303` | 4 + 2 | dieselbe Weiche, Begründung „einmal" |
| `box-updates.spec.ts:39` | 2 | nur `desktop-chromium` **oder** WebKit — „Gezielte zusätzliche Viewport-Prüfung" |
| `messstelle-seite.spec.ts:906` | 1 | `test.skip(breite !== 1440)` — „Die Quelle-Spalte steht in der Tabelle des Rechners; am Telefon trägt die Karte sie nicht." |

Ermittelt mit einem gezielten zweiten Lauf derselben sieben Specs über die drei Projekte (`--reporter=json`): **genau 15**, Summe und Namen deckungsgleich mit dem Gesamtlauf.

## Jedes Rot, eingeordnet

Art: **(a)** Test nicht nachgezogen, Produkt richtig · **(b)** Produktfehler · **(c)** wackelig
oder reihenfolgeabhängig · **(d)** Umgebung.

| Klasse / Fall | Fehlerbild | Seit wann | Art | In diesem PR |
|---|---|---|---|---|
| **der komplette Playwright-Lauf selbst** | `npx playwright test` bricht beim Sammeln ab: `Error: BUEHNE_PHASE muss vorher oder nachher sein`, `Total: 0 tests in 0 files`, Exit 1 | **PR 983** (`9c218084`) | **(a)** Bühne nicht nachgezogen | **repariert** (1 Commit) |
| `edge-app/core` `internal/agent` `TestTheSelfTestObservesTheWholeSwapAndThenRecordsTheRunningRelease` | `ota_autonomy_test.go:346: der bewiesene Stand muss aufgezeichnet sein: <nil>` | **PR 543** (`dbf5f051`) — älter als UEMS | **(c)** lastabhängig, 5 × allein grün | **nein — Befund** |
| `buehne-vorher-nachher.spec.ts` `U2 nachher 1440` (Werkzeuglauf IP-20) | `expect(dialog).toHaveCount(0)` bleibt bei 1; das Portal meldet `Bitte ergänzen Sie Straße und Ort für jeden Standort.`, die Felder sind leer | **PR 983** (`9c218084`), verschärft durch den größeren Dialog aus **PR 985** | **(c)** 1. Lauf rot, 2. Lauf `4 passed` | **nein — Befund** |
| `tools/edge-simulator` `pytest` (Sammelfehler) | `ModuleNotFoundError: No module named 'paho'` — `requirements.txt` ist auf dieser Maschine nicht installiert | kein Commit | **(d)** Umgebung | **nein** — mit `--with paho-mqtt` gefahren: `55 passed` |

**Sonst kein Rot.** Nicht in 8612 api-Tests, nicht in 238 Writer-Tests, nicht in 119
ingest-Tests, nicht in 10 712 vitest-Tests, nicht in 1077 Node-RED-Tests, nicht in 222
Palette-Tests, nicht in den 117 Werkzeug-Tests und nicht im Katalog.

### Die eine Reparatur: PR 983 hat den Gesamtlauf selbst unbrauchbar gemacht

PR 983 hat `frontend/portal/e2e/buehne-vorher-nachher.spec.ts` angelegt. Die Spec liest ihre
Aufnahme aus `BUEHNE_ANTWORTEN` und **wirft beim Laden des Moduls**, wenn
`tools/buehne-vorher-nachher/run.sh` ihre drei Umgebungsvariablen nicht gesetzt hat
(`buehne-vorher-nachher.spec.ts:18-19`). Sie stand aber im Standard-Testsatz — und ein Sammelfehler
in **einer** Datei beendet den ganzen Lauf:

```
Error: BUEHNE_PHASE muss vorher oder nachher sein
   at buehne-vorher-nachher.spec.ts:18
Listing tests:
Total: 0 tests in 0 files        Exit 1
```

**Warum das mehr wiegt als ein roter Test:** der komplette Playwright-Lauf ist genau der Lauf, der
in PR 981 die **zwölf** fremden Fälle gefunden hat, die drei AP-14-Pakete über die geteilte
E2E-Bühne gebrochen hatten (`netzanschluesse` 10, `standort-ebenen` 1, `help` 1). Ohne PR-CI ist er
die einzige Stelle, an der so etwas auffällt. Seit PR 983 **fand er gar nichts mehr** — und weil
Exit 1 auch nach einem echten Fehlschlag kommt, sieht „kaputt" hier aus wie „rot".

**Die Reparatur ist eine Zeile und lockert nichts.** `testIgnore` nimmt die Spec aus dem
Standard-Satz und gibt sie **zurück**, sobald `BUEHNE_PHASE` gesetzt ist — also genau dann, wenn
`run.sh` sie fährt. Die Wache in der Spec bleibt unberührt: ein halb gesetzter Aufruf wirft
weiterhin. Beide Wege sind gemessen:

```
ohne BUEHNE_PHASE:  Total: 1996 tests in 68 files     (499 je Projekt)
mit  BUEHNE_PHASE:  Total: 4 tests in 1 file          (der run.sh-Weg, U1/U2 × 375/1440)
```

`npm run typecheck` nach der Änderung: Exit 0.

### Befund (c) — `TestTheSelfTestObservesTheWholeSwapAndThenRecordsTheRunningRelease`

```
--- FAIL: TestTheSelfTestObservesTheWholeSwapAndThenRecordsTheRunningRelease (0.02s)
    ota_autonomy_test.go:346: der bewiesene Stand muss aufgezeichnet sein: <nil>
```

**Beleg, dass es Tagesform ist:** rot im Verbundlauf `go test ./...` (parallel zur
api-Vollsuite), **fünf Einzelläufe hintereinander grün** (`go test ./internal/agent -run … -count=1`,
5 × `ok … 0,40–0,66 s`). Das ist genau die vierte Falle der Vorrede: ein einzelner Durchlauf je
Stand misst den Rechner, nicht den Code.

**Und der Mechanismus ist belegt, nicht geraten.** Der Produktivcode schreibt bewusst in dieser
Reihenfolge (`internal/agent/ota_autonomy.go`):

```
202:  WriteJSON(… FileSelfTest, res)        ← das Urteil erscheint
213:  a.OtaRecordApplied(current.Release, current.ReleaseSeq)   ← erst danach der Stand
```

Der Kommentar darüber sagt, warum: „Der Boden wird NUR hier angehoben … aufgezeichnet wird
ausschliesslich, was nachweislich laeuft." Die Reihenfolge ist also richtig. Der **Test** aber
wartet in seiner Schleife nur auf die **erste** Datei und prüft die **zweite** unmittelbar danach
einmalig (`ota_autonomy_test.go:331-347`) — zwischen beiden Schreibvorgängen liegt ein Fenster,
das unter Last aufgeht.

**Kein Produktfehler.** Fällt der Kern in diesem Fenster aus, ist `pending-confirm.json` noch da
und `lastToken` nur im Arbeitsspeicher: der nächste Start beurteilt denselben Token erneut und
zeichnet den Stand nach.

**Seit wann:** der Fall stammt aus **PR 543** (`dbf5f051`, „fix(edge): make OTA completion
durable") — er ist älter als das ganze UEMS-Programm und hat nichts mit den PRs 981–990 zu tun.

> **Kleinste vorgeschlagene Reparatur** (nicht in diesem PR, weil (c)): in
> `edge-app/core/internal/agent/ota_autonomy_test.go` den Stand **in dieselbe Warteschleife**
> ziehen, statt ihn danach einmal zu lesen — die Schleife bricht erst ab, wenn Urteil **und**
> `ReadCurrent().ReleaseSeq == 12` da sind; die Frist von einer Sekunde bleibt, die Zusicherung
> bleibt wörtlich dieselbe. **Nicht** die Frist verlängern, **nicht** den Stand ungeprüft lassen.


## Der Tor-Prüfer gegen den gemessenen Stand

`bash tools/freigabe/pruefe-tor.sh G0 --laeufe <berichte>` mit einer `stand.txt`, die den
gemessenen Commit nennt — das Werkzeug hält sie gegen `HEAD` und lehnt einen Bericht eines
anderen Standes ausdrücklich ab. **G0: 9 von 9 belegt, Exit 0.**

```
Tor G0 - Zusammenfuehren - uems nach main in einem Stueck
Geprueft am 2026-09-19 05:08 UTC gegen 957217b6 (HEAD, 2026-09-19 03:45 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [belegt] V0  Migrations-Waechter: erst der Satz von main, dann der Rest  (§3.4)
      TEST-com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-09-19 04:49 UTC (Stand 957217b6 laut stand.txt)
  [belegt] NW-2  Steuerung aus einem Stueck  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest.xml: 11 Tests, 0 Fehler, 1 uebersprungen, Bericht vom 2026-09-19 04:49 UTC (Stand 957217b6 laut stand.txt)
  [belegt] M-2  Probe-Zweig gruen, PR-904-Tabelle  (§3.4)
      5ea736be vom 2026-09-19: Merge pull request 'AP-14 IP-12: Zusammenfuehrung uems + main geprobt - 52 Konflikte belegt, PR-904-Tabelle, Baum bytegleich zu uems' (#981) from fm/vp-uems-b14-ip12-zusammenfuehrung-proben into uems; main 4aa1e7fb ist Vorfahre von 957217b6, Baum fe205ad4. Die Datei-fuer-Datei-Tabelle zu PR 904 steht im Text von PR 981, nicht im Repo
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

**G1: 1 belegt, 16 offen, Exit 1.** Kein Punkt davon ist Bau-Arbeit dieses Pakets: 14 warten auf
das Stand-Blatt bzw. auf Läufe des Betreibers (Bestandsblatt, Generalprobe, Rückweg, Lastmessung,
Alarm-Übung, Pilotkunden, gitops), einer ist der Befund 6c aus dem NW-3-Protokoll, einer die
offene Rechte-Frage R1 zum Standort-Zaun — genau der Befund, den der erste Gesamtlauf (PR 970)
nach oben gegeben hat.

```
Tor G1 - Ausrollen - der Rollout-Tag; danach haben alle alles (E1 = B)
Geprueft am 2026-09-19 05:08 UTC gegen 957217b6 (HEAD, 2026-09-19 03:45 UTC)
Stand-Blatt des Betreibers: keines angegeben (--stand)

  [offen] M-1a  Bestandsblatt gegen Produktion gefahren  (§3.4)
      kein --blatt <datei>; der Betreiber faehrt tools/betriebsabfragen/bestand-vor-uems.sql gegen Produktion und gibt Teil A-C heraus (Betreiber)
  [offen] M-1b  Bestandsblatt ausgewertet: Q03 Lage c/f erklaert, Q15 WAL-Archiv laeuft  (§3.4)
      Q03 Lage c/f erklaert und Q15 WAL-Archiv laeuft - kein --stand <datei> angegeben (Betreiber)
  [offen] NW-1  Generalprobe an einer wiederhergestellten Kopie  (§3.4 / §4.13)
      kein --generalprobe <verzeichnis>; der Betreiber faehrt tools/generalprobe/ gegen eine wiederhergestellte Kopie und gibt die Ausgabe heraus (Betreiber)
  [offen] NW-8  Rueckweg geuebt, Dauer bekannt  (§3.4 / §4.13)
      kein --generalprobe <verzeichnis>; der Betreiber faehrt tools/generalprobe/ gegen eine wiederhergestellte Kopie und gibt die Ausgabe heraus (Betreiber)
  [offen] NW-3  Das ausgelieferte Box-Image gegen die neue Cloud  (§3.4 / §4.13)
      docs/rollout/nw3-protokoll-edge-2026.09.4.json vom 2026-09-19T03:20:19Z, Paar edge-2026.09.4: 12 gruen, 0 rot, 1 Befund, 0 nicht gefahren - offen bzw. mit Befund: 6c nach trennung laenger als das ende (Crew)
  [belegt] NW-4  Durchgehender Messkunden-Lauf  (§3.4 / §4.13)
      TEST-com.voltpilot.api.uems.UemsMesskundenLaufAbnahmeTest.xml: 1 Tests, 0 Fehler, Bericht vom 2026-09-19 04:49 UTC (Stand 957217b6 laut stand.txt)
  [offen] NW-5  Last "100 Messstellen" als 24-h-Messung  (§3.4 / §3.3)
      24-h-Messung nach Profil L1-L4 auf der Probe-Umgebung; tools/lastprofil-messung/ liegt bereit - kein --stand <datei> angegeben (Crew faehrt, Betreiber stellt die Probe-Umgebung)
  [offen] NW-6  Alarm-Uebung: jeder Alarm einmal, jeder Laeufer-Schalter einmal  (§3.4 / §4.13)
      jeden Alarm einmal ausgeloest, Zustellung an "betreiber" beobachtet, jeden Laeufer-Schalter umgelegt - kein --stand <datei> angegeben (Betreiber)
  [offen] L6  Kapazitaet nach L6 als Zahl  (§3.4)
      Kapazitaet aus der echten Belegung gerechnet, nicht behauptet (W5) - kein --stand <datei> angegeben (Betreiber)
  [offen] P  Pilotkunden gewaehlt und eingewilligt  (§3.4)
      die Handvoll betreuter Kundenbereiche steht und hat eingewilligt - kein --stand <datei> angegeben (Betreiber)
  [offen] M-4  gitops-PR 37 gemergt und ausgerollt - mindestens einen Tag VOR dem Fenster  (§3.4 / Drehbuch §2.2)
      PR 37 gemergt, ein Sync und ein api-Neustart auf dem ALTEN Schema beobachtet - kein --stand <datei> angegeben (Betreiber)
  [offen] M-4b  Die zwei Platzhalter aus PR 37 gesetzt  (Drehbuch §2.3 / §9.3)
      uems_datenbank_warnschwelle_bytes aus Q14 und der Tenant des Dauerlaeufers (IP-18) gesetzt - kein --stand <datei> angegeben (Betreiber)
  [offen] F6  Support-Weg einmal gegangen  (§3.4 / Drehbuch §11)
      der Support-Weg ist einmal von aussen gegangen worden - kein --stand <datei> angegeben (Betreiber)
  [offen] B9  Kundennachricht zum Fenster samt Release-Notiz raus  (§3.4 / Drehbuch §10)
      Nachricht 48 h vorher raus, Release-Notiz mit den sichtbaren Aenderungen dabei; docs/rollout/release-notiz-vorlage.md ist die VORLAGE, keine versendete Nachricht - kein --stand <datei> angegeben (Betreiber)
  [offen] IP-18  Dauerlaeufer-Kundenbereich steht  (Drehbuch §9.3 / §8)
      interner Kundenbereich mit zwei simulierten Boxen und Regel VoltPilotDauerlaeuferStumm - kein --stand <datei> angegeben (Crew baut, Betreiber synct)
  [offen] W1  Entscheidung ueber den Start-Waechter auf main  (Drehbuch §9.1)
      die alte api schreibt beim Neustart 18 DELETE-Marker, danach startet die neue nicht; das Drehbuch ist mit und ohne Waechter fahrbar - der Betreiber entscheidet - kein --stand <datei> angegeben (Betreiber)
  [offen] R1  Offene Rechte-Frage zum Standort-Zaun auf geraet/component_definition  (Bau-Befund AP-03 IP-5)
      ob der Standort-Zaun auf geraet und component_definition greifen soll, ist nicht entschieden - kein --stand <datei> angegeben (Crew legt vor, Betreiber entscheidet)

1 belegt · 16 offen · 0 nicht maschinell pruefbar, vom Betreiber bestaetigt
Tor G1: NICHT vollstaendig belegt. Die offenen Punkte stehen oben.
```

## Die Bühne vorher/nachher — einmal ganz gefahren

`bash tools/buehne-vorher-nachher/run.sh` lief vollständig durch: zwei `clean`-Aufzeichnungen der
echten API-Antworten (main `4aa1e7fb` in einem Wegwerf-Worktree, dann UEMS), danach zweimal das
**echte** Portal unter Playwright. Die U1-Bilder sind bei 375 und 1440 px bytegleich vorher wie
nachher — das prüft das Werkzeug selbst und bricht sonst ab.

**Vier der zwölf PNG sind neu** (`u2-nachher-vorschau-*`, `u2-nachher-bestaetigt-*`); die anderen
acht sind bytegleich zum Bestand. Neu sichtbar ist die **Steuerung aus PR 985**: je Anlage steht
jetzt ein „Gehört zu: …"-Wähler in der Vorschau, mit dem sich Anlagen zu einem Standort
zusammenlegen lassen.

> **Offen geblieben, ausdrücklich:** die U2-Bilder zeigen weiterhin **drei** Standorte, nicht den
> Weg **2 + 1**. Der Grund ist nicht das Werkzeug, sondern die Spec: `buehne-vorher-nachher.spec.ts`
> füllt drei Adressen und bestätigt — sie **benutzt den neuen Wähler nie**. „2 + 1" zu zeigen
> heißt, die Spec einen Schritt weiter zu führen (Halle 2 über den Wähler zu Halle 1 legen, dann
> bestätigen); das ist eine Änderung an der Bühne, nicht ein weiterer Lauf. **Kleinste
> vorgeschlagene Änderung:** nach dem Adressblock
> `dialog.getByRole('combobox', { name: /^Gehört zu: Werk Ahrenberg – Halle 2$/ })` auf Halle 1
> stellen, die Adressfelder erneut zählen (es sind dann zwei) und erst danach bestätigen.

### Und dabei ein zweiter Flatterer, gleicher Bauart wie der erste

Der **erste** Lauf des Werkzeugs scheiterte an `U2 nachher 1440`:
`expect(dialog).toHaveCount(0)` blieb bei 1, weil das Portal
`Bitte ergänzen Sie Straße und Ort für jeden Standort.` meldete — die drei Adressfelder waren
**leer**, wie das Bild belegt, das die Spec unmittelbar davor selbst aufnimmt. Der **zweite** Lauf
war grün (`4 passed (6.6s)`), derselbe Stand, dieselben Aufzeichnungen.

**Mechanismus:** die Spec wartet auf die Überschrift „Was sich ändert" und liest dann sofort
`await strassen.count()` (`buehne-vorher-nachher.spec.ts:87-91`). Ist der Dialogkörper in diesem
Moment noch nicht fertig aufgebaut, ist die Zahl **0**, die Schleife läuft **null**mal, es wird
nichts gefüllt — und der Fehler fällt erst zwölf Zeilen später beim Bestätigen auf. Bei 375 px
reichte die Zeit, bei 1440 px nicht.

> **Kleinste vorgeschlagene Reparatur** (nicht in diesem PR, weil (c)): vor die Schleife ein
> `await expect(strassen.first()).toBeVisible();` — dann zählt die Spec erst, wenn es etwas zu
> zählen gibt. **Keine Frist verlängern, keine Zusicherung entfernen.** Dieselbe Falle wie beim
> Go-Befund oben: gewartet wird auf A, geprüft wird B.

## Der Rebase am Ende — und was danach wiederholt wurde

Während des Laufs ist **PR 991** („Edge meldet Fähigkeit für unbefristete Ruhe", `a5728c54`) auf
`uems` gelandet — das erwartete ruhende Box-Paket der parallelen Bahn. `git diff --name-only`
gegen den gemessenen Stand nennt neun Dateien: vier Wegweiser unter `docs/agents/root/`, zwei
Vertragsdateien unter `docs/contracts/v2/` (darunter **`edge-supports-vectors.json`**),
`edge-app/core/internal/cloud/data_source_status.go` samt Test und
`services/api/src/test/java/…/uems/FunktionApiTest.java`.

**Wiederholt wurden genau die davon berührten Läufe** — und, weil eine geänderte Vektordatei
keinen Lauf ihrer Leser nach sich zieht, **alle Leser von `edge-supports-vectors.json`**
(`rg -l` nennt sie):

| Wiederholt | Warum | Ergebnis |
|---|---|---|
| `edge-app/core` `go test ./...` | PR 991 ändert `internal/cloud` | **alle Pakete `ok`, Exit 0** — auch `internal/agent` (siehe Befund (c)) |
| `services/api`: `FunktionApiTest`, `EdgeSupportsListenerTest`, `EdgeSupportsLegacyListenerTest` + die drei Tor-Nachweisklassen, `clean` | geänderte Testklasse · Leser der Vektordatei · G0/G1-Belege | **`Tests run: 32, Failures: 0, Errors: 0, Skipped: 1`** · BUILD SUCCESS |
| `frontend/portal` `src/edgeSupportsVectors.test.ts` | Leser der Vektordatei | **`Test Files 1 passed` · `Tests 8 passed`** |
| Katalog-Wächter (`pytest`, `generate.py --check`, `package_edge_runtime.py --check`) | Hausregel: wer `edge-app/core/` anfasst, fährt sie | **`45 passed, 56 subtests passed`**, beide Checks Exit 0 |

**Nicht wiederholt, mit Begründung:** die api-**Vollsuite** (PR 991 ändert im Produktivcode der
api keine Zeile — nur eine Testklasse, die einzeln grün gefahren wurde), `timescale-writer` und
`ingest` (von PR 991 nicht berührt), **vitest vollständig, typecheck, build und Playwright**
(PR 991 fasst `frontend/portal` nicht an; der einzige Portal-Leser der geänderten Vektordatei
lief einzeln). Die zitierten Summen dieser Suiten stammen also vom gemessenen Stand `957217b6`,
der Vorfahre des PR-Standes ist — **das steht hier, damit niemand sie für Zahlen des PR-Standes
hält.**

## Hausregeln und wie gemessen wurde

- **`clean` überall.** Jede zitierte Java-Zahl kommt aus `./mvnw clean test`, die Phasen
  **wörtlich** im Aufruf — nicht über eine Variable (zsh zerlegt sie nicht in Wörter, und genau
  das hat schon zweimal einen Lauf ohne Testergebnis wie Erfolg aussehen lassen).
- **Die api-Vollsuite als EIN Lauf**, nicht in Stapeln: `Total time: 01:01 h`, ein
  `Tests run:`-Block am Ende, 501 von 501 Klassen mit eigener Ergebniszeile.
- **Höchstens zwei Container-Läufe zugleich**, vor jedem Start geprüft
  (`docker ps -q | wc -l` ≤ 2 **und** `memory_pressure` ≥ 35 % frei; die Lastzahl aus `uptime`
  bleibt unbeachtet, sie steht auf dieser Maschine immer hoch). Gefahren wurde: api-Vollsuite,
  dazu zeitweise `timescale-writer`, danach `ingest` — nie drei. **Nie der lokale Docker-Stack**,
  nur Testcontainers.
- **Playwright lief NICHT gleichzeitig mit der api-Vollsuite** — erst nach deren `BUILD SUCCESS`,
  bei 0 fremden Containern und 61 % freiem Speicher. Das ist die Lehre der Nacht vom 18./19.09.
- Die container-freien Läufe (vitest, typecheck, build, Go, Node-RED, Python) liefen parallel zur
  api-Suite; sie brauchen keine Datenbank. Dass vitest **unter** dieser Fremdlast vollständig grün
  war, ist eine Zusatzaussage: `SteuernAssistent.test.tsx`, der Befund (c) aus PR 970, hält seit
  PR 990 auch unter Last.

## Was dieser Lauf NICHT sagt

- **Er sagt nichts über Produktion.** Alles lief gegen Testcontainers und die E2E-Bühne des
  Portals, nie gegen eine Produktionsdatenbank und nie gegen eine echte Box. Grün heißt: die
  Zusicherungen, die im Repo stehen, halten auf diesem Stand — nicht, dass der Rollout gelingt.
- **Er sagt nichts über die 499 WebKit-Fälle.** Das Binary `webkit-2336` fehlt auf dieser
  Maschine, und der Auftrag verbietet eine Installation außerhalb des Worktrees. Ein vierter
  Satz derselben Specs ist also ungemessen; iOS-Safari-eigene Abweichungen (Datumsfelder,
  Scroll-Verhalten, `position: sticky`) würde dieser Lauf nicht sehen.
- **Er sagt nichts über die Lücken, die kein Test hat.** Ein grüner Gesamtlauf beweist die
  Abdeckung nicht. Der erste Gesamtlauf hat genau so einen Standort-Zaun auf zwei
  Bestandstabellen gefunden, den 8547 Tests nicht prüften; solche Stellen findet dieser Lauf
  weiterhin nicht.
- **Er sagt nichts über Zeitverhalten unter echter Last.** Die Maschine trug hier höchstens
  zwei Container-Läufe. Wo eine Zusicherung nur knapp innerhalb ihres Zeitrahmens liegt, bleibt
  sie knapp — ein Grüner Lauf ist kein Beweis von Robustheit, wie der Go-Befund unten zeigt.
- **Er sagt nichts über die Tore G1, GA und GB.** Der Tor-Prüfer nennt deren offene Punkte;
  liefern muss sie der Betreiber (Bestandsblatt, Generalprobe, Rückweg, Lastmessung).
- **Und er sagt nichts über den Stand NACH diesem PR**, außer für die Suiten, die nach dem
  Rebase wiederholt wurden — welche das sind, steht oben ausdrücklich.
