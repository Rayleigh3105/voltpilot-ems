# AP-13 IP-14: Bestandsaufnahmen

Bezugsstand: **84f8307ffbd668cf5dcd0cbb1f4ebfedf84062a3**, 15.09.2026, der Konzeptstand aus AP-13 §8.4
vor dem ersten AP-13-Paket (`7d072aaf`). Die Paketbasis `35e5c54e` enthält bereits IP-1–IP-13 und ist deshalb
kein Aufnahme-Stand. `package.json` und Lockdatei sind zwischen Bezugsstand und Paketbasis identisch.

Die elf HTML-Dateien wurden mit denselben Testfällen und Fixtures auf einem frischen `git archive` des
Bezugsstands erzeugt. Keine Wörter, Zahlen, CSS-Klassen oder Attribute werden aus dem HTML entfernt oder
normalisiert. Feste Uhr und feste Telemetrie-Zeitpunkte gehören zu den Testeingaben, nicht zur Ausgabe.
Die Fixtures stammen aus den vorhandenen Bestands-Komponententests; keine neue Beispiel-Fachrechnung.

| Aufnahme | Testdatei in `src/` |
|---|---|
| Cockpit | `pages/AnlagenPage.test.tsx` |
| Verlauf Messwerte | `pages/HistorieWelten.test.tsx` |
| Verlauf Erlöse | `pages/ErloeseSeite.test.tsx` (bis zum Nachzug main 8b8b6a03b: `pages/ErloeseKarten.test.tsx`) |
| Verlauf Ladevorgänge | `pages/LadevorgaengeSection.test.tsx` |
| Verlauf Lastspitzen | `pages/LastspitzenSection.test.tsx` |
| Verlauf Marktpreise | `pages/VerlaufChrome.test.tsx` |
| Verlauf Prognosequalität | `pages/PrognoseSchalter.test.tsx` |
| Portfolio Messwerte/Erlöse | `pages/PortfolioWelten.test.tsx` |
| Portfolio Übersicht | `components/PortfolioCockpit.test.tsx` |
| Geräteseite | `pages/GeraetSeiteSection.test.tsx` |

**Nachgezogener main-Bestand an der Geräteseite:** `geraeteseite.html` enthält seit
dem Merge von [PV-Einstieg ohne PV-Aspekt](https://git.tecmaxx.de/mamotec/voltpilot-ems/pulls/810)
zusätzlich die Karte „PV-Produktion dieses Geräts“. Die Hybrid-Fixture meldet Solarstrom,
hat aber keinen PV-Aspekt. Der ausgelieferte main-Fix zeigt die Karte dann an der Speicher-Entität;
auf dem ursprünglichen UEMS-Bezugsstand fehlte dieser Fix noch. Diese eine Aufnahme wurde auf
`0881ef92` (UEMS) plus `e3f000a2` (main) neu erzeugt. Der Vergleich belegt ausschließlich
die eingefügte PV-Karte; der übrige HTML-Inhalt und die zehn anderen Aufnahmen sind bytegleich
zum ursprünglichen Bezugsstand. Dies ist ein Nachzug ausgelieferten Verhaltens, keine AP-13-Änderung.

**H-7 (E9/E10, entschieden 16.09.2026):** Die Geräteaufnahme ersetzt die bisherige
PV-Karte durch „Summenwerte dieses Geräts“. Der neue API-Leseweg ist in der Fixture
explizit leer; Anlegen und Protokoll sind nach den wirksamen Rechten sichtbar. Das
ist die beschlossene Änderung dieser Fläche, keine Neuaufnahme anderer Zahlen.

**Nachzug main 8b8b6a03b (26.09.2026, echter Merge `main` → `uems`, Paket `vp-uems-nachzug-main-0926`):**
main hat mehrere der aufgenommenen Flächen ausgeliefert neu gebaut. Die betroffenen Aufnahmen folgen der
ausgelieferten Fläche; jede ist **nicht** per `--update` am Merge-Baum entstanden, sondern auf einem frischen
`git archive origin/main` (8b8b6a03b) mit denselben Testfällen (`--root <Archiv>/frontend/portal --no-cache`,
Abhängigkeiten identisch). Der Merge-Baum rendert danach jede davon **bytegleich** zum ausgelieferten main-Stand —
ein Kunde ohne Messfunktion sieht dort genau das, was live ist; die UEMS-Teile (Rechte-Hebel, Vorschlagskarte nur
mit Recht) ändern daran kein Byte.

| Aufnahme | ausgelieferter main-Commit | Unterschied zum bisherigen Bezugsstand |
|---|---|---|
| `cockpit.html` | a29eaae96, feae7a90a, 1512e5e75 | genau drei Stellen: „Stand gerade eben“, `data-count` am Kachelraster, Netz-Zeile mit Worten |
| `geraeteseite.html` | d1b97ac39, 41ed67c26 | Geräteseite „ein Blick, eine Antwort“ (Kern statt Rahmen), Reiter „Aufbau“ |
| `portfolio-uebersicht.html` | d1d67b97e, 00ad1d281 | eine Übersicht in vier Blöcken für jede Betriebsart |
| `portfolio-messwerte.html`, `portfolio-erloese.html` | 3e95cc604 | Welten „Energie“ und „Erlöse“ im Rahmen der Anlagen-Seiten |
| `verlauf-messwerte.html` | 763b87f39 | Verlauf › Energie |
| `verlauf-erloese.html` | a32805fc8 | Erlöse als Abrechnung; der Fall steht jetzt in `pages/ErloeseSeite.test.tsx` (main hat `ErloeseKarten.test.tsx` gelöscht) |
| `verlauf-prognose.html` | 41ed67c26 (E6 = A) | Prognosen als Werkzeug für VoltPilot |

In `uemsBestandsschutz.test.tsx` gilt dasselbe: der Verlauf-Snapshot heißt jetzt „Verlauf-Reiter wie ausgeliefert
(main 8b8b6a03b)“ mit drei Reitern (Energie · Erlöse · Messwerte, 763b87f39; Preise und Wetter beim Fahrplan) und
stammt aus dem main-Archiv. Die drei Portfolio-Reiter-Snapshots tragen ausschließlich das neue Wort „Energie“ statt
„Messwerte“ (`PORTFOLIO_WELT_PAGES`, 3e95cc604) — von Hand fortgeschrieben, weil der UEMS-Reiter „Standorte“ auf
main nicht existiert; jede andere Abweichung bleibt rot. `diagramme.json` trägt für `ScheduleChart.tsx` den Hash der
main-Datei (39f074e04 ff., Tagesbild) und führt `components/Tagesbild.tsx` nicht mehr, weil main sie gelöscht hat
(a32805fc8). Die übrigen Aufnahmen (`verlauf-ladevorgaenge`, `verlauf-lastspitzen`, `verlauf-marktpreise`) und
die O18-/`startEbene`-Snapshots bleiben am Bezugsstand 84f8307f.

**Nachzug main 308a5cc91 (04.10.2026, Steuerung neu, Paket `vp-uems-nachzug-main-1a`):** `cockpit.html` folgt dem
Cockpit-Raster von main (1fec2bc1c, 2e655d20e, bf02b8c20) und dem Leitungsplan (ad5210427). Seit dem Nachzug a68f93d20
lud die Energie-Bühne als eigenes Stück nach, und der Fall fotografierte ihren Platzhalter `vp-eb-warten` — rot auf
`uems`. Der Fall wartet jetzt, bis die Bühne steht. Die Aufnahme ist auf einem frischen `git archive origin/main`
(308a5cc91) mit demselben Testfall entstanden (`--root <Archiv>/frontend/portal --no-cache`, Abhängigkeiten
identisch); der Merge-Baum rendert sie **bytegleich** (21 496 Bytes) — Geld-Regel und `CockpitMessstellenWeg` ändern
für eine Anlage ohne Messfunktion kein Byte.

**Alerting Scheibe 2 (15.10.2026, Konzept `vp-alerting-konzept-m1` §6.3/§6.8, „Überwachen" am Wert):**
`cockpit.html` bekommt an den vier Live-Kreisen von „Dieser Moment" (PV, Verbrauch, Speicher, Netz) je ein Menü ⋯
(`RowMenu`, Eintrag „Überwachen") - dieselbe Fläche, über die diese Scheibe den vollen Weg „Vom Wert zur fertigen
Regel: drei Taps" baut (`UeberwachenBlatt.tsx`, `EnergieBuehne.tsx`). Die Aufnahme ist mit `vitest -u` gegen den
aktuellen Produktstand neu geschrieben (keine Reko aus einem historischen Archiv, anders als die main-Nachzüge
oben) - das ist die bewusste, im Konzept beschriebene Änderung dieser Fläche, keine gefundene Abweichung: `git diff
--stat` zeigt nur `cockpit.html` mit genau den neuen Menü-Knöpfen (die Fixture ist eine Zeile; kein anderes Byte
änderte sich). Die Marke „überwacht" selbst erscheint in dieser Aufnahme nicht (die Fixture-Anlage hat noch keine
aktive Überwachung) - ein Folgefall dafür ist nicht Teil dieser Bestandsschutz-Aufnahme.

**Konzept b1, Teil 1 (20.10.2026, Kopf und Tagesleiste der Bühne):** `cockpit.html` folgt der beschlossenen
Änderung der Bühne: die Marke steht hinter dem Umschalter (Raster mit festen Plätzen, der Platzhalter
`vp-eb-sp` entfällt), „Tag abspielen“ und der Hinweissatz unter der Tagesleiste entfallen, an ihrer Stelle stehen
die Knöpfe ‹ › („Eine Viertelstunde früher/später“). Neu geschrieben mit `vitest -u` am Produktstand wie bei
Alerting Scheibe 2; der Token-Vergleich zeigt genau diese drei Stellen, kein anderes Byte.

**Konzept b1, Teil 2 (20.10.2026, „Überwachen“ nur unter Meldungen, Entscheide E1/E3):** `cockpit.html` verliert
den Werteblock „Dieser Moment“ in der rechten Spalte (`vp-hero-moment` mit den vier Werten und ihren Menüs ⋯
„Werkzeuge: …“, die Alerting Scheibe 2 oben hinzugefügt hatte). Die Leitkachel bleibt. Neu geschrieben mit
`vitest -u` am Produktstand; der Token-Vergleich zeigt genau diesen einen entfernten Block, kein anderes Byte.

**Ereignisse am Diagramm (20.10.2026, Konzept `vp-verlauf-ereignisse-k1`, „Spur + Chronik am Diagramm"):**
`verlauf-messwerte.html` bekommt genau zwei Hüllen und sonst kein Byte: `<div class="vp-vr-col">` um die
Diagramm-Karte (die Ereignis-Karte steht in derselben linken Spalte direkt darunter) und
`<div class="vp-vr-spurrahmen">` um das Diagramm (die Ereignis-Spur unter der Achse). Die Fixture dieses Falls trägt
keine Ereignisse, darum erscheinen weder Spur noch Karte. Die Aufnahme ist mit `vitest -u` gegen den aktuellen
Produktstand neu geschrieben - die beschlossene Änderung dieser Fläche; ein Zeichenvergleich alt/neu zeigt nur die
vier eingefügten Tag-Stücke. `HistoryChart.tsx` bleibt bytegleich (`diagramme.json`); sein Feld `info.farbe` trägt
seither den Bereich der Art.

`uemsBestandsschutz.test.tsx` ergänzt neun Snapshots: vier O18-Fälle, sechs Verlauf-Reiter in einem Snapshot,
drei Portfolio-Reiter und die `startEbene`-Matrix (64 Eingaben). Die fünf in den Bestands-Tests gestubbten
Canvas-/Diagrammkomponenten schützt zusätzlich `diagramme.json` mit SHA-256 des Bezugsstands.
Damit sind HTML und unveränderte Diagrammquellen geprüft; dies ist keine Pixelaufnahme eines Browsers.

Aus `frontend/portal` gezielt ausführen (auch nach einem Rebase):

```bash
npx vitest run src/uemsBestandsschutz.test.tsx src/pages/AnlagenPage.test.tsx src/pages/HistorieWelten.test.tsx src/pages/ErloeseSeite.test.tsx src/pages/LadevorgaengeSection.test.tsx src/pages/LastspitzenSection.test.tsx src/pages/VerlaufChrome.test.tsx src/pages/PrognoseSchalter.test.tsx src/pages/PortfolioWelten.test.tsx src/pages/GeraetSeiteSection.test.tsx src/components/PortfolioCockpit.test.tsx -t 'AP-13 Bestandsschutz' --maxWorkers=1 --minWorkers=1 --no-cache
```

Zum historischen Vergleich einen **neuen** Archivbaum unter einem ignorierten lokalen Testverzeichnis anlegen,
`frontend/portal` und `docs/contracts/v2` aus dem Bezugsstand auspacken, nur die oben genannten Testdateien,
`uemsBestandsschutz.test.tsx`, den Snapshot-Helfer und diese Aufnahmen hineinkopieren und die unveränderten
Abhängigkeiten verwenden. Mit `--root <Archivbaum>/frontend/portal` denselben Befehl ausführen.
Keinen gemeinsamen Vite-Transform-Cache verwenden (`--no-cache`); keine alten Build-Ergebnisse kopieren.

**Kein `--update` am aktuellen Produktstand.** Eine echte Abweichung ist ein Befund, kein neuer Sollwert.
Der gefundene O18-Bruch (neue Standortnavigation ohne Messfunktion) wird in IP-14 aufgrund des ausdrücklichen
firstmate-Entscheids durch E2/Q2 behoben; die alten leeren Snapshots bleiben unverändert.

Für Änderungen am Wächter: `npx vitest run src/uemsKeineRechnung.test.ts`. Die Ausnahmen sind einzeln geprüft
und dürfen nicht automatisch nachgezogen werden. Neue fachliche Summen, Mittel, Anteile oder Δ gehören
zum Vertrags-Zwilling. Release-Note und fachliche Wegweiser: [Oberflächen-Abschluss](../../../../../docs/agents/root/uems-oberflaechen-ebenen.md).
