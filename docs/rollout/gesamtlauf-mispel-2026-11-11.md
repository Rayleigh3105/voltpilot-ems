# Gesamtlauf `mispel` → `main` — 11.11.2026

Dieser Lauf gehört zum Merge von `mispel` nach `main` (Empfehlung F5 des Berichts „mehrere Erzeugungsanlagen an
einem Netzverknüpfungspunkt“, vom Captain angenommen): erst `mispel` nach `main`, danach erst Zählerrolle und
Förderweg weiterbauen. Gemessen ist der Zweig `fm/voltpilot-mispel-nach-main`: `origin/mispel` `e87d33ae9` plus
`origin/main` `015fdc7be` als **echter Merge-Commit** `6bfdf6ad6` (Basis `99944c896`, 10.10.2026), darauf die
Nacharbeit je Ursache. Auf Forgejo läuft kein PR-CI; Form, Befehle und Regeln folgen den Läufen vom 05.10.
([gesamtlauf-mispel-2026-10-05.md](gesamtlauf-mispel-2026-10-05.md)) und 10.10.
([gesamtlauf-mispel-2026-10-10.md](gesamtlauf-mispel-2026-10-10.md)). Gemessen auf der Arbeitsmaschine (Linux,
4 Kerne, Maven, Go und Playwright im Container), nicht auf dem Mac der früheren Läufe.

## Das Ergebnis in fünf Sätzen

`mispel` ist mit `main` zusammengeführt – zwei echte Merge-Commits (58 Konfliktdateien im ersten, keine im zweiten),
die Nacharbeit je Ursache in einem eigenen Commit, die 20 MiSpeL-Migrationen hinter die jüngste von `main` gehoben.
Der Merge erzeugte drei echte Fehler, alle behoben: die Upsert-Wache der Ladepunkte kannte die MiSpeL-Spalten nicht,
„Laden und zurückspeisen“ war nur noch für Plattform-Admins erreichbar, und die neuen Löschregeln von `main` kannten
die 15 MiSpeL-Tabellen nicht. Jedes andere Rot ist auf `main` mit denselben Tests genauso rot, flattert dort genauso
oder ist eine Frage der Umgebung (Platte, Speicher, HiGHS). Die volle api-Suite lief wegen voller Platte nur bis 562
von 858 Klassen; nachgeholt sind gezielt 44 Klassen nach dem zweiten Merge. Offen ist eine Entscheidung des
Captains: die Zahl „Steuerung“ an MiSpeL-Netzladen-Tagen (gebaut ist A).

## Der Merge

`git merge origin/main` in `origin/mispel`: 366 Commits von `main`, 93 von `mispel`, **58 Dateien mit
Textkonflikt**. Der Merge-Commit `6bfdf6ad6` enthält nur die Auflösung; was der Merge darüber hinaus braucht,
folgt als eigener Commit je Ursache (unten). Keine Zusicherung gelockert, kein Test abgeschaltet.

### Wo `main` dasselbe gebaut hat wie `mispel` — eine Fassung bleibt

| Thema | `mispel` | `main` | Es bleibt | Warum |
|---|---|---|---|---|
| MP-2 Ausschließlichkeits-Prüfer (Monatsbericht je Anlage, Admin-Route) | #1320, alle Anlagen mit Speicher | #1646 (02.11.), dieselbe Rechnung, nur Anlagen mit Netzladen „Verboten“, ein Tag im Muster des Live-Falls im API-Test | **`main`** | gleicher Kern, `main` ist die jüngere und auf EN-2 abgestimmte Fassung; `mispel` ist keine Obermenge. Der Vektor-Test von `mispel` (jeder MP-4-Vektorfall mit Z2) läuft zusätzlich gegen die Fassung von `main` |
| MP-45 strenge Ausschließlichkeit („kein Laden bei gleichzeitigem Netzbezug“) | #1322, Betreiber-Schalter je Anlage (`VOLTPILOT_MISPEL_STRENGE_SITES`), Toleranz je Viertelstunde, Plan-Felder `strict_exclusivity*`, Box-Stufe 4b | EN-2 A (#1640, Plan, v1 und v2) und EN-1 A (#1645, Box-Netzladen-Sperre), **ohne Schalter für jede Anlage mit Netzladen „Verboten“**, ohne Toleranz, Reserve 1 kW | **`main`** | `main` hat die Regel aus MP-45 übernommen und verschärft; der Schalter von `mispel` wäre daneben wirkungslos (er wirkte nur im EEG-Modus, wo `main` ohnehin streng ist). Entfernt: Schalter, Toleranz, Plan-Felder, Box-Stufe 4b, die gelbe Zeile der Box-Seite, `heute_streng` im MiSpeL-Check |
| BMS-Hülle P5c an der Box | noch im Code (Stand der Basis) | entfernt (#1680) | **`main`** | die Entfernung von `main`; `mispel` hat daran nichts gebaut |

### Konflikte, in denen beide Seiten ihr Verhalten behalten

| Bereich | Dateien | Auflösung |
|---|---|---|
| Box: Ladesäulen-Server | `csms/apply.go`, `csms.go`, `ocppmap.go` | die Uhr der Ladesäule (W-09, `main`) und die OCPP-2.0.1/2.1-Spuren (MP-35/37, `mispel`) über eine gemeinsame `openSession`; die 1.6-Spur meldet signierte Messwerte (MP-38) und rechnet auf der Uhr der Box |
| Box: Agent | `agent.go`, `arbitration.go`, `ocpp.go`, `ocpp_surplus.go` | Netzladen-Sperre von `main`; V2X-Wächter (MP-39) und Status-Wache (`main`) laufen nebeneinander; der V2X-Wunsch wird vor `consumerCommands` aus dem Plan genommen |
| Box: Wächter | `guards.go`, `intent.go`, `entities.go` | `main` (Netzladen-Sperre statt MP-45-Toleranz, keine BMS-Hülle) |
| API | `DeviceChargerStatusRepository`, `EarningsController`, `EarningsDto`, `SiteController`, `openapi.yaml`, `PortalApiTest` | Upsert der Ladepunkte von `main` mit den MiSpeL-Spalten `soc_measured_at`, `bidirectional`; Erträge tragen die MiSpeL-Tagesmengen (MP-18c) und „mit Bestand“ (P3) nebeneinander; Export-SQL mit Marktwertbasis (MP-12) und Einspeisevergütung (`main`) |
| Optimierer | `solver.py`, `inputs.py`, `modules.py`, `entities.py`, `explain.py` | Mischbetrieb, Messlatte, Fahrzeug (`mispel`) neben Vorsprung-Budget, Morgenüberschuss, Wechselrichter-Untergrenze (`main`); `dv_konform` bleibt entfernt (MiSpeL W8) |
| Portal: Anlage › Einstellungen | `AnlageTechnik.tsx` (+ Test, zwei Aufnahmen) | die Zeile **„Förderweg“ ersetzt „Veräußerungsform“** (BK-17 A); das aufgeteilte Stammdaten-Blatt von `main` (je Zeile ihr Feld) bleibt, ohne das Feld „Veräußerungsform“ |
| Portal: Anlage anlegen | `AnlageFlow.tsx` → `AnlageSchritt.tsx` | `main` hat den Schritt verlegt; der MiSpeL-Hinweis zum Netzladen zieht mit |
| Portal: Steuerung › Laden | `LadenReiter.tsx`, `SteuerungSeite.tsx`, `bild.ts`, `laden.ts`, `seite.ts` | die neue Ladekarte von `main` („Womit laden?“, Ladungen, Technik-Zeile) mit den Teilen der Wallbox-Karte (MP-41a–c): Zurückspeisen, Ladestand mit Reserve, „Abfahrt und Reserve“, Ertrag; das Band des Zurückspeise-Plans nur an einem Ladepunkt mit MiSpeL-Plan |
| Portal: Speicher-Aussage | `speicherAussage.ts` (+ Vektoren) | an einem MiSpeL-Netzladen-Tag bzw. -Monat die Zahl „Auf der Stromrechnung“ mit Gutschrift (BK-W5 A), sonst „mit Bestand“ (P3-2 A) — **offene Entscheidung des Captains**, siehe unten |
| übrige | `api.ts`, `copy.test.ts`, `erloesEbenen.ts`, `bundle-smoke.sh`, Box-UI-Tests, Doku | beide Seiten nebeneinander |

### Offene Entscheidung des Captains: die Zahl „Steuerung“ an MiSpeL-Netzladen-Tagen

BK-W5 A (MiSpeL, 05.10.) nennt die Zahl an einem MiSpeL-Tag mit Netzladen die Kassenrechnung „Auf der
Stromrechnung“, die MiSpeL-Gutschrift steht daneben, kein Rot. P3-2 A (`main`, 14.10.) verlangt **eine**
Zählweise für jeden Zeitraum: mit Bestand bewertet. An einem MiSpeL-Netzladen-Tag widersprechen sich beide.

- **A (gebaut, empfohlen für diesen Merge):** an MiSpeL-Netzladen-Tagen und -Monaten gilt BK-W5 A, überall sonst
  „mit Bestand“. Erreichbar erst, wenn eine Anlage den Förderweg Abgrenzungs- oder Pauschaloption bekommt — heute
  keine.
- **B:** überall „mit Bestand“; die MiSpeL-Zeile (Mengen, „Gutschrift offen“) steht nur noch als erster Grund, ohne
  „Stromrechnung“.

## Nacharbeit — ein Commit je Ursache

| Commit | Ursache | Art | Was |
|---|---|---|---|
| `6bfdf6ad6` | — | Merge | `origin/main` `015fdc7be` als echter Merge-Commit, 58 Konfliktdateien (oben) |
| `f4038b727` | MP-45 gegen EN-1 A/EN-2 A | doppelt | der Rest des MP-45-Schalters außerhalb der Konfliktdateien: Optimierer (`config`, `domain`, `publisher`, `solver`, MiSpeL-Check `heute_streng`), Vertrag `mqtt-schedule.schema.json`, Box-Plan und lokale Seite, Compose, Doku |
| `ad99b3a22` | Spring Boot 4 (#1816) gegen die Testklassen von MiSpeL | a | dieselben Ersetzungen wie in #1816 (MockMvc, TestRestTemplate, `@MockitoBean`); Records mit den Feldern beider Seiten in den Testaufrufen. Nur Testcode |
| `0610352c0` | W-07/W-09 (#1578), EN-1 A (#1645) gegen MP-14/MP-35 | b, a | 2.0.1/2.1-Messwerte auf die Uhr der Box (ohne das fielen sie als „älter als der eigene Beginn“ heraus); `configureSampledData` je Spur; Reconnect-Test nach W-07; 1.6-Fingerabdruck neu (auf `main` und Merge byte-gleich); Förderweg in Plänen der neuen `main`-Tests; MP-14-Test mit der Netzladen-Sperre |
| `a3cafd5cb` | Umzug des Anlege-Schritts (`main`) gegen MP-17 | a | der Netzladen-Hinweis von MiSpeL in `AnlageSchritt.tsx`; Imports der Ladekarte |
| `695cfae7b` | Versionen der MiSpeL-Migrationen | Flyway | Neu-Nummerierung (Abschnitt Flyway) |
| `3d5c26913` | Glossar beider Seiten | a | `glossar.md` neu erzeugt, Zusagen Z-018/Z-075 auf die verschobenen Zeilen, Prüfpaket neu gebaut |
| `8c274459f` | — | Beleg | Messpunkt im Bündel-Wächter (257,39 kB gz, `main` allein 255,78) |
| `ebbd092f9` | MP-45 entfernt; Einspeisevergütung (#1589) | a | Optimierer-Tests: MP-45-Parameter weg, Schema des Check-Laufs mit den zwei neuen `site`-Spalten |
| `773df2840` | Reihenfolge nach der Neu-Nummerierung | a | `LadepunktBidirektionalMigrationTest`: die MiSpeL-Migration läuft jetzt nach allen von `main`, die Zusicherung über den ganzen Lauf ist „leer“ |
| `828c8e0e4` | Upsert der Ladepunkte (`main`) gegen MP-41/MP-41c | b | die Wache `DeviceChargerStatusRepositoryRaceTest` kennt `soc_measured_at` und `bidirectional`; ohne das hätte der Upsert von `main` beide MiSpeL-Spalten bei jedem Statuswechsel überschrieben |
| `dd9d45152` | eigene Geräteseite der Wallbox (`main`) gegen MP-41a | b | „Laden und zurückspeisen“ im Zeilenmenü der Wallbox im Aufbau: seit `main` die Wallbox auf eine eigene Geräteseite führt, war der Dialog „Was kann dieser Ladepunkt?“ nur noch über „Technisch …“ (Plattform-Admins) erreichbar; Regel des Captains vom 27.10. (ein Ort zum Anlegen und Einrichten) |
| `d3213849d` | BK-17 A gegen das Stammdaten-Blatt (`main`) | a | Einstellungs-Tests: die Hilfe wartet gezielt auf die Zeile „Förderweg“; zwei Aufnahmen ohne die Zeile „Veräußerungsform“ (sonst byte-gleich `main`) |
| `ab2b84cf9` | drei neue Migrationen von `main` (`d06da7e38`) | Flyway | MiSpeL-Migrationen auf `V20261112030100`–`031900` gehoben |
| `1cfe797ee` | — | Merge | zweiter Merge-Commit: `origin/main` `d06da7e38`, konfliktfrei |
| `d70ec4c1c` | „Ein Ort fürs Laden“ (#1599), „Fahrplan in fünf Sekunden“ (`f032d14f3`) | a | Playwright: die Wallbox-Karte wartet nicht mehr auf die entfallene Karte „Netzanschluss“; die Fahrplan-Bühne von BK-W5 zeigt die Antwort als Kachel wie das Tagesbild, der Satz mit der Netzladen-Zeile steht nach dem Tipp; fünf Specs (`help`, `shell-layout`, `standort-ebenen`, `steuerquelle-gemeinsame-steuerung`, `unterstuetzung`) in der Fassung von `main` |
| `b3d2182f9` | Löschwege #1812/#1827/#1830 gegen die MiSpeL-Tabellen | b | 15 Tabellen in `KundeDatenBestand`, `ladepunkt_signierter_messwert` in `BoxDatenBestand` und „Box lösen“ (Abschnitt „Der zweite Merge“) |

Art: **a** Test/Bühne nicht nachgezogen · **b** Produktfehler, den erst der Merge erzeugt · **c** Flatterer ·
**d** Umgebung · **doppelt** dieselbe Sache auf beiden Seiten gebaut.

## Flyway: die 20 MiSpeL-Migrationen hinter `main`

`mispel` brachte 19 Migrationen der api und eine von market-data mit Versionen vom 02. bis 04.10.2026. `main` hat
seit der Basis 70 Migrationen dazubekommen (bis `V20261111220000`, Stand `d06da7e38`), 83 Migrationen von `main`
tragen höhere Versionen als die erste von MiSpeL. Mit den alten Nummern wären die MiSpeL-Migrationen in Produktion „außer der
Reihe“ angekommen (`out-of-order: true`), auf jeder frischen Datenbank und in jedem Test aber **vor** den jüngeren
von `main` gelaufen — zwei Reihenfolgen für dasselbe Schema. Neu nummeriert laufen sie überall **nach** `main`, in
ihrer alten Reihenfolge (AGENTS.md: neue Migrationen nach dem höchsten ausgelieferten Stand). Commit `695cfae7b`,
nach dem zweiten Merge noch einmal über die drei neuen von `main` gehoben (`ab2b84cf9`).

- **Das SQL ist byte-gleich** (reine Umbenennung, git zeigt `R100`); die Kommentare in den Dateien nennen deshalb
  die alten Nummern. Verweise in Code, Tests, Verträgen, Doku und den Bootstrap-Spiegeln unter `infra/` tragen die
  neuen.
- **Keine Kollision mit `main`:** keine der 20 fasst eine Tabelle, einen CHECK, eine Funktion oder eine Policy von
  `main` an. Sie legen eigene Tabellen an (RLS + `FORCE ROW LEVEL SECURITY`, Rechte wie zuvor) und ergänzen nur
  `device_charge_connector` um `soc_measured_at` und `bidirectional` (die `main` nicht kennt und deren Upsert jetzt
  beide Spalten schreibt). Fremdschlüssel gehen auf `tenant`, `site`, `messstelle`, `measurement_point`.
- **Nie in Produktion gelaufen:** `mispel` wurde nie ausgerollt (der GitOps-Bump läuft nur auf `main`). Eine
  lokale Datenbank, auf der `mispel` lief, kennt die alten Versionen; der Startwächter lehnt sie als `MISSING_*` ab
  — lokal neu aufsetzen (`infra/local/demo/demo.sh start`).
- `main-migrations.txt` bleibt unverändert: die Liste beschreibt die Produktion und wird erst nach dem Rollout
  fortgeschrieben (`docs/agents/root/uems-migration-produktionsreihenfolge.md`). Geprobt ist der Schritt
  trotzdem, siehe unten.

| alt | neu | Migration |
|---|---|---|
| `V20261002110000` | `V20261112030100` | `mispel_marktdaten` |
| `V20261002121500` | `V20261112030200` | `mispel_messstelle_zaehlerrolle` |
| `V20261002141500` | `V20261112030300` | `mispel_site_foerderweg` |
| `V20261002153700` | `V20261112030400` | `mispel_abgrenzung_monat` |
| `V20261002173500` | `V20261112030500` | `mispel_foerderweg_aw_regel` |
| `V20261002191500` | `V20261112030600` | `mispel_pauschal_jahr` |
| `V20261002214500` | `V20261112030700` | `mispel_ladepunkt_bidirektional` |
| `V20261002224700` | `V20261112030800` | `mispel_formelsatz_a2_a4` |
| `V20261002231500` | `V20261112030900` | `mispel_foerderweg_partner` |
| `V20261002234100` | `V20261112031000` | `mispel_check_ergebnis` |
| `V20261003015500` | `V20261112031100` | `mispel_msb_werte` |
| `V20261003051500` | `V20261112031200` | `mispel_msb_import_mscons` |
| `V20261003054500` | `V20261112031300` | `mispel_check_pauschal` |
| `V20261003063800` | `V20261112031400` | `mispel_ladepunkt_signierter_messwert` |
| `V20261004114700` | `V20261112031500` | `mispel_ladepunkt_fahrer_einstellungen` |
| `V20261004131500` | `V20261112031600` | `mispel_pauschal_vormerkung` |
| `V20261004171500` | `V20261112031700` | `mispel_pauschal_vormerkung_umgesetzt` |
| `V20261004173000` | `V20261112031800` | `mispel_ladepunkt_messlatte` |
| `V20261004203700` | `V20261112031900` | `mispel_ladepunkt_fahrzeug_telemetrie` |
| `V20261002110000` (market-data) | `V20261112030100` | `mispel_marktdaten` (Spiegel, `services/market-data/db/migration`) |

**Probe der Produktionsreihenfolge:** `UemsProduktionsreihenfolgeMigrationTest` (spielt erst die Liste der
Produktion, dann den Rest in Versionsreihenfolge) lief mit der Liste von `main` `015fdc7be` als Produktionsstand:
2 von 2 grün. Die 20 neu nummerierten Migrationen kommen also auf einer Datenbank im Stand von `main` in einem
Zug dazu. Auf frischer Datenbank laufen sie in jedem api-Test mit (Flyway, Testcontainers).

## Der zweite Merge: `main` nachgezogen

Während der Prüfung kam `main` um sechs Commits weiter (`015fdc7be` → `d06da7e38`, #1828–#1833). Der zweite
Merge-Commit `1cfe797ee` (Vorgabe firstmate: wieder Merge, kein Rebase) war konfliktfrei. Zwei Folgen:

- **Drei neue Migrationen von `main`** (`V20261111200000`, `…210000`, `…220000`) lagen zwischen den ersten neuen
  Nummern der MiSpeL-Migrationen. Commit `ab2b84cf9` hebt die 20 MiSpeL-Migrationen darüber (Tabelle oben zeigt
  den Stand danach).
- **„Kunde ohne Datenbestand sofort löschen“ (#1830)** verlangt für jede Tabelle mit `tenant_id` eine Einordnung in
  `KundeDatenBestand`; dasselbe gilt seit #1827/#1812 für `device_id` beim endgültigen Löschen und Lösen einer Box.
  Die Wächter kannten die 15 MiSpeL-Tabellen nicht (der abgebrochene Gesamtlauf erreichte sie nie). Commit
  `b3d2182f9` ordnet ein, im Zweifel als Aufzeichnung:

| Tabelle | Klasse | Datenart | Grund |
|---|---|---|---|
| `ladepunkt_signierter_messwert` | Aufzeichnung | `ocpp` | signierte Zählerstände (OCMF), wie `ocpp_meter_sample` |
| `mispel_msb_import`, `mispel_msb_wert` | Aufzeichnung | `messwerte` | Werte des Messstellenbetreibers und ihr Einlesen |
| `messstelle_zaehlerrolle` | Aufzeichnung | `messstellen` | gehört zur Messstelle; Fassungen, gelöscht wird nie |
| `ladepunkt_messlatte` | Aufzeichnung | `erloese` | trägt die Ertragszeile der Wallbox; vergangene Viertelstunden bleiben |
| `site_foerderweg`, `site_pauschal_vormerkung`, `mispel_abgrenzung_monat`, `mispel_pauschal_jahr`, `site_mispel_check`, `ladepunkt_faehigkeit` | Aufzeichnung | `mispel` (neu) | Nachweis gegenüber dem Netzbetreiber oder seine Grundlage; Fassungen, gelöscht wird nie; der Check entsteht nur auf Aufruf |
| `ladepunkt_fahrer_einstellung`, `ladepunkt_abfahrt`, `ladepunkt_anwesenheit`, `ladepunkt_fahrzeugfenster` | unbedenklich | – | Einstellung des Fahrers: laufender Stand ohne Fassungen |

## Die Summen je Suite

| Suite | Umfang | Ergebnis |
|---|---|---|
| Box `edge-app/core` | `go test ./...`, `-race` für `agent`, `lastmgmt`, `csms`, `ocppsim`, `entladeschutz`, `go vet`, MIPS-Bau, `jstest` | alles grün; `jstest` 199/199 |
| Edge Light Größe | Leitplanke `edge-light` | grün: Programm 17 301 719 B (`main` 16 515 287), Update-Bedarf 36 896 kB von 39 000, gepackt 5 466 113 B |
| Optimierer | `pytest`, alle Tests | 2 643 Fälle: erst 12 rot, nach `ebbd092f9` 3 rot, alle drei auf den reinen Ständen genauso (unten) |
| market-data | `pytest` | 157/157 |
| Kataloge | Messpunkte, Steuerprofile | 2 437 Messpunkte, 56 Tests, 24 Profile – grün |
| Doku-Wächter | Fachmodell, Zusagen, Prüfpaket, AGENTS-Budget | grün nach `3d5c26913` |
| Portal Typen, Bündel | `npm run typecheck`, `test:bundle` | grün; 257,39 kB gz |
| Portal Vitest | ganze Suite, ein Worker, `TZ=Europe/Berlin` | 14 864 grün, 48 rot – alle durch den Merge, repariert (`dd9d45152`, `d3213849d`); die 132 Fälle der drei Dateien danach grün; nach dem zweiten Merge die 18 von ihm berührten Dateien: 895/895 grün |
| api, gezielter Stapel 1 | 153 Klassen, 1 360 Tests (MiSpeL, Konfliktdateien, Migrationen) | merge-bedingt nur die Upsert-Wache (repariert, `828c8e0e4`); 5 Fälle auf `main` genauso rot |
| api, Gesamtlauf | 858 Klassen geplant | **abgebrochen bei 562 Klassen** (Platte voll, Anweisung firstmate): 9 913 Tests, 2 Fehlschläge und 180 Fehler in 23 Klassen – 20 Umgebung, 3 geerbt |
| api, gezielter Stapel 2 | 44 Klassen nach dem zweiten Merge: Löschwege, Box-Löschwege, Gesamtabzug, Architektur-Wächter, MiSpeL-Migrationen, die nie gelaufenen Pakete `chargers` und `optimizer` | 299 Tests, 2 Fehlschläge – beide auf `main` `d06da7e38` genauso (unten). Der erste Anlauf wurde nach 35 Klassen wegen Speichernot der Maschine beendet, die 9 übrigen liefen danach allein |
| Playwright desktop | 37 Specs (MiSpeL und vom Merge berührt), 485 Fälle | erster Lauf 435 grün, 47 rot, 3 nicht gelaufen; nach der Nacharbeit (`d70ec4c1c`) die MiSpeL-Specs grün, jedes übrige Rot auf `main` genauso |
| Playwright tablet | 13 Kern-Specs | 114 grün, 28 rot, 28 gewollt übersprungen – die Roten: wallbox-karte/mispel-w5 (repariert), steuerung/anlage-anlegen (geerbt) |
| Playwright Telefon | 13 Kern-Specs je `mobile-chromium` und `mobile-webkit` | chromium 136 grün, 9 rot; webkit 135 grün, 10 rot; je 28 gewollt übersprungen. Die MiSpeL-Specs sind grün, rot sind nur `steuerung` und `anlage-anlegen` (unten) |

## Jedes Rot, eingeordnet

**Durch den Merge, repariert:** Upsert-Wache der Ladepunkte (`828c8e0e4`); Vitest (48, `dd9d45152`, `d3213849d`);
Optimierer-Tests (9, `ebbd092f9`); `LadepunktBidirektionalMigrationTest` (`773df2840`); Löschregel-Wächter für die
MiSpeL-Tabellen (`b3d2182f9`, beim Lesen gefunden); Playwright `wallbox-karte` (17) und `mispel-w5` (2)
(`d70ec4c1c`). Eine echte Lücke im Produkt war darunter: „Laden und zurückspeisen“ (MP-41a) war hinter der eigenen
Geräteseite der Wallbox nur noch für Plattform-Admins erreichbar (`dd9d45152`).

**Geerbt von `main`, dort genauso rot:**

- api (geprüft auf `015fdc7be`): `KundenbereichBeendetApiTest` (Route `endgueltig-loeschen`, #1827; nach dem
  zweiten Merge grün, `main` hat ihn nachgezogen), `UnterstuetzungSchnittstelleVertragTest` (`konto_geaendert`), `PortalApiTest.theForecastModelSwitch…`,
  `AdminApiTest.topologyReadModel…` und `….theForecastPromotionSwitch…` (Lastprofil),
  `EnergieeinsatzApiTest` (`zugriff_ende_chk`, feste Testdaten 2099, nicht zeitabhängig).
- api nach dem zweiten Merge: `BoxEndgueltigLoeschenMigrationTest.jedeTabelleMitDeviceIdIstEingeordnet` – die
  Tabelle `box_ausbauen_protokoll` aus #1828 fehlt in `BoxDatenBestand`, auf `main` `d06da7e38` genauso; nicht
  MiSpeL, hier nicht repariert (Vorgabe firstmate). Die MiSpeL-Tabelle `ladepunkt_signierter_messwert` steht in
  der Meldung nicht mehr.
- api nach dem zweiten Merge: `SiteScopeArchitekturTest.keineAbfrageAufMessdatenOhneSiteOderBegruendetenEintrag` –
  die neue Abfrage `KundeDatenBestand` aus #1830 liest Messdaten-Tabellen ohne Eintrag im Standort-Zaun; auf `main`
  `d06da7e38` mit genau denselben elf Meldungen rot, keine MiSpeL-Tabelle darunter.
- Playwright Telefon: `steuerung.spec.ts` und `anlage-anlegen.spec.ts` dieselben Fälle wie am Rechner;
  gegengeprüft auf `main` `d06da7e38` (mobile-webkit, dieselben Specs: dieselben acht Fälle rot).

**Flatterer:** auf mobile-webkit zusätzlich `steuerung.spec.ts` › „Cockpit W-01“ und „Cockpit: keine Zeile, wo
„Schnell“ nichts ändert“ – die Kacheln sind nach 5 s noch nicht gezeichnet. Je dreimal wiederholt: auf dem Merge und
auf `main` `d06da7e38` ist „Cockpit W-01“ je einmal von drei rot, der andere Fall grün; der Code der Kacheln ist
gleich `main`.
- Optimierer: `test_mispel_mischbetrieb::test_negativer_bezugspreis…` und
  `test_mispel_monatszustand::test_gegenprobe…` (HiGHS endet mit `TerminationCondition.error`) auf `mispel`
  `e87d33ae9` genauso; `test_cover_now::test_covering_earlier…` (Rundung 26,675829 gegen 26,67583) auf `main`
  genauso. Gemessen mit highspy 1.16.0 und Python 3.13 – eine Frage der Umgebung, nicht des Merges.
- Playwright desktop (Gegenprobe auf `main` `015fdc7be`, dieselben Specs): `steuerung.spec.ts` (6: die Ladekarte
  von `main` spricht „Womit laden“ inzwischen anders als die Spec), `anlage-anlegen.spec.ts` (3), `help.spec.ts`
  (3), `shell-layout.spec.ts` (1), `standort-ebenen.spec.ts` (6), `steuerquelle-gemeinsame-steuerung.spec.ts` (1),
  `unterstuetzung.spec.ts` (2, bricht je Lauf an anderer Stelle ab – auf `main` in beiden Läufen rot).

**Umgebung:** im abgebrochenen Gesamtlauf 20 Klassen (`No space left on device`, Container startet nicht,
Web-Server startet nicht, Datenbank im Recovery). Die Platte füllte unter anderem ein Core-Dump von Chromium aus dem
Playwright-Container (772 MB im Worktree); spätere Läufe mit `--ulimit core=0`.

## Was dieser Lauf NICHT sagt

- **Die volle api-Suite lief nicht durch:** 562 von 858 Klassen, dann war die Platte voll; neu gestartet wurde sie
  nicht (der Platz gehörte einem anderen Auftrag). Gezielt nachgeholt sind die Löschwege, Box-Löschwege,
  Gesamtabzug, Architektur-Wächter, die MiSpeL-Migrationen und die nie gelaufenen Pakete `chargers` und
  `optimizer` (Stapel 2). 270 von 860 Klassen, vor allem der Pakete (`zugriff`, `metrics`, `measurement`, `entities`,
  `consumers`, `web`, `erzeuger`, `registerwrite`, …) sind auf diesem Stand nicht gelaufen.
- **Der zweite Merge (`d06da7e38`) ist schmaler geprüft:** Typen, die Löschwege samt neuer Wächter, die 18 von ihm
  berührten Vitest-Dateien, die Playwright-Nachläufe; Optimierer, Box und die übrige Vitest-Suite liefen auf dem
  Stand vor ihm (die sechs Commits fassen weder Optimierer noch Box an).
- **Kein Hardware-Prüfstand:** Box-Verhalten ist an Simulatoren und Golden-Dateien belegt; OCPP 2.0.1/2.1 und das
  Zurückspeisen sind an keiner echten Säule und keinem echten Auto geprüft.
- **Keine Produktion:** nichts ist ausgerollt; die Migrationen liefen nur auf frischen Test-Datenbanken und in der
  Probe der Produktionsreihenfolge.

## Nachtrag 12.11.2026: `mispel` und `main` noch einmal nachgezogen

Nach dem Öffnen des PR führte der Kapitän in `mispel` MP-58 (#1529), MP-55 (#1533) und MP-59 (#1534) zusammen
(`44036c5f0`), in `main` #1836, #1837 und #1820 (`16c7f96de`). Beide kamen mit je einem echten Merge-Commit dazu.

| Commit | Ursache | Art | Was |
|---|---|---|---|
| `d5e4830da` | — | Merge | `origin/mispel` `44036c5f0`; Konflikte: Vertragsübersicht `docs/contracts/v2/README.md` (MiSpeL-Zeilen mit den neuen Migrationsnummern plus die neue Zeile `mispel-weg`), `runner.py`/`mispel_check.py` (Marge MP-59 ja, der entfernte MP-45-Schalter `strenge` nein) |
| `4f3ddc535` | — | Merge | `origin/main` `16c7f96de`; Konflikte: `AnlageTechnik.tsx` (Himmelsrichtung aus #1820 mit `compassLabel`; `plantKindLabel` entfällt, weil die Zeile „Veräußerungsform“ dem „Förderweg“ gewichen ist) und sein Test (Helfer nimmt `weg` und `pvOver`) |
| `d963fe853` | Spring Boot 4 gegen MP-55 | a | `MispelWegApiTest` mit denselben Ersetzungen wie `ad99b3a22` |
| `ee5f970c2` | EN-2 A gegen MP-59 | a | der Posten „Netzladen-Handel mit Saldierung“ bei festem Preis trägt jetzt den Unterschied „heute nie Laden bei gleichzeitigem Netzbezug, mit MiSpeL schon“ (≈ 4,85 € im Test-Fenster statt ≈ 0); gegengeprüft auf reinem `mispel` und auf dem Merge ohne EN-2 A |

**Migrationen:** keine neue von `mispel`; von `main` nur `V20261112080000` (#1837, Funktion und Trigger, keine
Tabelle). Keine Nummer doppelt; die MiSpeL-Migrationen liegen vor #1834 (`V20261112043000`) und #1837. Keine neue
Tabelle mit `tenant_id` oder `device_id`, `KundeDatenBestand`/`BoxDatenBestand` bleiben, wie sie sind; der Löschzug
von #1837 (Alarm-Verlauf) steht neben den MiSpeL-Einträgen.

**Geprüft** (nacheinander, Platte und Speicher vor jedem Schritt): Optimierer – die fünf berührten Testdateien
(`test_mispel_check`, `test_mispel_check_lauf`, `test_mispel_check_lauf_db`, `test_pricing`, `test_simulation`) 125
Fälle, nach `ee5f970c2` grün; Typen grün; Vitest der sechs berührten Dateien 270/270; api 28 Klassen (MP-55, Check,
Förderweg, Vormerkung, Löschwege, `KundeDatenBestand`, Box-Löschwege, Gesamtabzug, Migrations-Wächter, die
geänderten Klassen von #1820/#1836/#1837) 222 Tests, 1 Fehlschlag – `BoxEndgueltigLoeschenMigrationTest`
(`box_ausbauen_protokoll`, auf `main` `16c7f96de` genauso, geerbt); `SiteScopeArchitekturTest` ist jetzt grün (#1820).
Playwright Anlage › Technik und MiSpeL-Kern (12 Specs): desktop-chromium 126/126, mobile-chromium 98 grün und 28
gewollt übersprungen.

## Nachtrag 12./13.11.2026: `main` `b3ed4c5ff` nachgezogen

Sieben PRs von `main` (#1838–#1844: mehrere MaStR-Einheiten S1–S5, Kunde löschen ohne Wartefrist und als
serverseitiger Auftrag, UEMS-Tageslauf) kamen mit dem Merge-Commit `44b2185d5` dazu.

| Commit | Ursache | Art | Was |
|---|---|---|---|
| `44b2185d5` | — | Merge | Konflikte: `SlotEconomics`/`OptimizerDiagnosticsService` (Marktwertbasis MP-12 und `UnitPv`/Einheiten-Blend S4 nebeneinander), `PortalApiTest` (Vektor-Bindung 7–14: Site-Id von S4 vorn, MiSpeL-Aliase danach), `inputs.py`/`test_freshness.py` (beide Importe, beide Attrappen), `AnlageTechnik.tsx` und Test (Förderweg und Register-Einheiten im selben Effekt, `PlantKind` entfällt) |
| `55ba1c8d9` | Löschzug-Indexdeckung #1843 gegen die MiSpeL-Tabellen | b | neue Migration `V20261112032000`: tenant_id-Index für sechs `ladepunkt_*`-Tabellen, Index auf `site_pauschal_vormerkung.umgesetzt_in`; das SQL der umbenannten MiSpeL-Migrationen bleibt unverändert |
| `1a0d4ce5a` | S4-Test gegen MP-12 | a | `evalExportValueSqlForRealSite` mit `marktwertbasisJoinSql` wie `EarningsRepository` |
| `65c0bf7d6` | S3/S5-Tests gegen den Helfer-Parameter `weg` | a | sechs neue Aufrufe von `renderEinstellungen` mit `undefined` für den Förderweg |

**Flyway:** keine Version doppelt; die neuen von `main` (`V20261112090000` bis `V20261112153000`) liegen über den
MiSpeL-Migrationen, die neue `V20261112032000` gehört zum MiSpeL-Block vor #1834. **Zählerrolle und
`register_einheit`/`einheit_geraet`:** keine gemeinsame Tabelle, kein gemeinsamer Index, keine Policy, kein
Fremdschlüssel; die Einheiten sind MaStR-Einheiten mit einer Anzeige-Zuordnung zu Geräten, die Zählerrolle gehört
zur Messstelle.

**Geprüft** (nacheinander, Platte vor jedem Lauf über 3 GB): api 25 Klassen – `LoeschzugIndexdeckungTest`,
`KundeDatenBestandMigrationTest`, `RegisterEinheitMigrationTest`, Gesamtabzug, Box lösen, Migrations-Wächter,
`SlotEconomicsTest`, Marktwertbasis, Zählerrolle, Förderweg, Vormerkung grün; die drei Export-Vektorfälle des
`PortalApiTest` nach `1a0d4ce5a` grün. Rot und auf `main` `b3ed4c5ff` genauso: `BoxEndgueltigLoeschenMigrationTest`
(`box_ausbauen_protokoll`), `SiteScopeArchitekturTest` (`EinheitGeraetRepository` aus #1844). Flatterer aus #1843:
`KundenbereichLoeschenApiTest` (auf `main` in zwei anderen Fällen rot) und einmal `LoeschzugKatalogApiTest` – der
Lauf steht schon auf `fertig`, bevor sein Bericht nachgetragen ist. Optimierer (4 Dateien) 113/113, Typen grün,
Vitest der acht berührten Dateien nach `65c0bf7d6` grün (`AnlageTechnik.test.tsx` 66/66), Playwright Anlage ›
Technik (3 Specs, desktop) 31/31.
