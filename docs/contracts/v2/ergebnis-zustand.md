# Ergebnis-Zustand: eine Zahl sagt selbst, wie belastbar sie ist (UEMS AP-08 IP-8)

Stand 16.09.2026 · Vertrag 1.12 · Konzept `data/vp-uems-ap08-verbrauch` §4.1 (Ergebnis-Zustand,
Kennzeichen), §4.5 (Zustände), Entscheide **E10** (Sommerzeit) und **E11** (Rundung) vom
11.09.2026 · Beispielwelt [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json)
(Kunststoffwerk Ahrenberg GmbH).

„2.304 kWh“ allein sagt nicht, ob der Tag vollständig gemessen wurde, ob eine Lücke darin steckt
oder ob ein Ersatzwert mitrechnet. **Eine Zahl ohne ihren Zustand ist eine Behauptung.** Dieser
Vertrag macht den Zustand zu einem geschlossenen Vokabular und die Kundensätze zu dessen
Wortlaut — an EINER Stelle, gelesen von Java und TypeScript, statt an jeder Fläche neu formuliert.

**Die Regel steht in der Vektor-Datei, nicht in diesem Text.** Wo beide sich widersprechen, gilt
die Datei.

| Datei | Rolle |
|---|---|
| [`ergebnis-zustand-vectors.json`](./ergebnis-zustand-vectors.json) | **die eine Wahrheit**: Vokabular, Kennzeichen-Liste, frühere Fassungen, Rundung, Sommerzeit, Befunde und die Fälle |
| [`ergebnis-zustand.schema.json`](./ergebnis-zustand.schema.json) | das Schema der Vektor-Datei (JSON-Schema 2020-12) |
| `services/api/.../uems/ErgebnisZustand.java` | der **Java-Zwilling**; `VerbrauchRegeln` ruft ihn für jeden Satz an |
| `frontend/portal/src/uemsErgebnis.ts` | der **TS-Zwilling** für die Flächen (AP-08 IP-10/IP-11) |
| `…/uems/ErgebnisZustandVectorsTest.java` · `…/src/uemsErgebnis.test.ts` | beide fahren DIESELBE Datei per Pfad — und dazu jede Kennzeichen-Erwartung von [`verbrauch-vectors.json`](./verbrauch-vectors.json) |
| `frontend/portal/src/copy.test.ts` | liest jeden Kundensatz dieses Vertrags gegen die Wörterbücher |

**Wer eine Regel oder einen Satz ändert, ändert die Vektor-Datei UND beide Zwillinge.**

## 1. Die vier Zustandswörter (geschlossen)

| Wort | Zahl | Kennzeichen | Bedeutung |
|---|---|---|---|
| vollständig | Pflicht | kein Fehlbestand | jede Kilowattstunde der Periode ist gezählt und zugeordnet |
| unvollständig | erlaubt | **mindestens ein** Fehlbestand | ein Teil ist nachweislich nicht gezählt; die Zahl ist der gemessene Teil und sagt, was fehlt |
| keine Werte | **verboten** | kein Fehlbestand | kein guter Wert: kein Wert, keine Null, keine Linie |
| mit Ersatzwert | Pflicht | frei | mindestens ein Ersatzwert (E7); Methode und Kennung sagt das Kennzeichen `mit_ersatzwert` (Rang 70, seit 1.4) |

Der Zustand wird **berechnet, nie gesetzt**. `pruefe` meldet, wenn Zahl, Zustand und Kennzeichen
nicht zusammenpassen: „keine Werte“ mit `0` ist `zahl_verboten` (unbekannt ist keine Null),
„vollständig“ mit einer Rücksetzung ist `vollstaendig_mit_fehlbestand`, „unvollständig“ ohne
einen Satz, der sagt was fehlt, ist `unvollstaendig_ohne_grund`.

⚠ Nicht verwechseln: `zustand` der Speicherklassen (vorläufig/endgültig, AP-07 E5) ist **nicht**
dieser Zustand (`menge_zustand`). Seit 1.7 wird die Fassung als eigenes Kennzeichen gesprochen
(Rang 90, §5) — neben dem Zustand, nie an seiner Stelle.

## 2. Die Kennzeichen-Liste (geschlossen, nach Wortlaut UND Reihenfolge)

Ein Satz ist genau dann ein Kennzeichen, wenn er auf **genau ein** Muster der Liste passt. Die
Liste ist die Inventur aller Sätze, die die Verbrauchsregel (`VerbrauchRegeln` ⟷ `verbrauch.py`)
heute spricht — beide Zwillinge beweisen es an jeder Erwartung von `verbrauch-vectors.json`.

| Rang | Muster (Schlüssel) | Wort | Fehlbestand |
|---|---|---|---|
| 10 | positiver/negativer Anteil von {quelle} | positiver/negativer Anteil | nein |
| 20 | Anfang nicht gemessen (kein Stand an der Periodengrenze) | — | ja |
| 21 | Ende nicht gemessen (kein Stand an der Periodengrenze) | — | ja |
| 22 | nur ein Stand in der Periode — keine Menge bildbar | — | ja |
| 30 | Gerätegrenze {uhr} mit Ableseständen / ohne Ablesestände | Gerätegrenze | nein |
| 30 | Zuwachs am Wechsel nicht messbar (Ablesestände fehlen) — **unmittelbar nach „ohne“** | Gerätegrenze | ja |
| 30 | Lücke am Wechsel {von}–{bis} (nicht aufgefüllt) — nach „mit“ oder „nicht messbar“ | Gerätegrenze | nein |
| 30 | Überlauf {uhr} (Wertebereich {modul}) | Überlauf | nein |
| 30 | Rücksetzung {uhr} ohne Endstand — bis zu 1 Kadenz nicht gezählt | Rücksetzung | ja |
| 30 | Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar — `{zuwachs}` ist eine `menge` („337,6 kWh“, seit 1.3) | Lücke: Zuwachs gemessen | nein |
| 30 | Lücke {von}–{bis}: Zuwachs gemessen, nicht auf Viertelstunden verteilbar — die Reihe hat keine Anzeige-Einheit (seit 1.3) | Lücke: Zuwachs gemessen | nein |
| 40 | Neustart {uhr}: bis zu {verlust_s} s Zählung möglicherweise verloren | Neustart-Verlust | ja |
| 50 | 1 von {erwartet} Intervallmengen fehlt / {fehlend ≥ 2} von {erwartet} … fehlen — … | — | ja |
| 50 | gemessene Zeit {minuten}:{sekunden} min von {periode_min} min | — | ja |
| 60 | aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit) | aus Leistung integriert | nein |
| 70 | mit Ersatzwert (Methode „{methode}“, {kennung}) — `{methode}` ist der Name in Kundensprache (`vokabular.ersatzwert_methode[].name` der Ereignis-Vektoren), `{kennung}` EW-<Jahr>-<Nr.>; zuletzt, nach allem, was gemessen ist (seit 1.4, AP-08 IP-13) | mit Ersatzwert (Methode …) | nein |
| 80 | korrigiert (Version {version}) — `{version}` ≥ 2 (Version 1 ist das Original); danach nur noch die Fassung, die Version sagt etwas über die ganze Zahl. Gesprochen von der Korrektur-Kaskade an jeder Stufe, deren Version sie schreibt; kein Datum im Satz (die Versions-Historie, IP-18); derselbe Wortlaut wie in `bilanz-vectors.json` F14 (seit 1.5, AP-08 IP-17) | korrigiert (Version n) | nein |
| 90 | vorläufig · endgültig — die Fassung der Periode, ob die ganze Zahl sich noch ändern kann; ganz zuletzt, nach der Version. Aus `fassung` der Route, höchstens EINE je Liste; nie gespeichert, gesprochen von der Tages- und Monatskarte (seit 1.7, AP-08 IP-11, §5) | vorläufig · endgültig | nein |

**Reihenfolge:** der Rang steigt in einer Liste nie (`kennzeichen_reihenfolge`); die Sätze der
Gerätegrenze stehen in fester Folge (`kennzeichen_folge`); ein einmaliges Kennzeichen steht nie
doppelt, und von „vorläufig“ und „endgültig“ steht höchstens eines da. Innerhalb von Rang 30 stehen die Sätze in zeitlicher Folge — die Uhrzeit HH:MM allein
beweist das über Tagesgrenzen nicht (ein Monat kann zwei Rücksetzungen um 09:12 haben) und wird
darum **nicht** verglichen.

**Frühere Fassungen (seit 1.1).** Ein geänderter Wortlaut ist schon gespeichert: `kennzeichen`
der Speicherklassen hält jeden Satz, eine endgültige Viertelstunde wird nie neu geschrieben, und
Tag, Monat und Jahr übernehmen die Sätze ihrer Teile. Die Liste `fruehere_fassungen` hält darum den
alten Wortlaut je Muster: er wird als dieses Muster **erkannt** (gleicher Rang, gleiches Wort,
`fruehere_fassung = true`), `pruefe` lässt ihn zu und `satz` spricht ihn, wie er gespeichert ist —
aber **keine Sprech-Funktion erzeugt ihn mehr**, und keine Erwartung von `verbrauch-vectors.json`
trägt ihn. Eine vorläufige Zeile bekommt den neuen Wortlaut beim nächsten Verdichtungslauf, eine
endgültige behält den alten. Heute: „Gerätegrenze {uhr} mit Ablesestände“ (bis 1.0) und „Lücke
{von}–{bis}: Zuwachs {zuwachs} gemessen, …“ mit `dezimal_punkt` („Zuwachs 337.600“, bis 1.2) — gleicher
Text, anderer Platzhalter: das heutige Muster nimmt „337.600“ nicht an.

**Vorgesehen** sind die übrigen Wörter des Vokabulars — nachgeliefert · Ablesezeitraum
(„korrigiert (Version n)“ bis 1.4, seit 1.5 Kennzeichen; „vorläufig“ und „endgültig“ bis 1.6, seit 1.7 Kennzeichen). Ihren Wortlaut legt das
Paket fest, das sie erzeugt (`kennzeichen_vorgesehen.wortlaut_mit`); bis dahin ist ein solcher
Satz `kennzeichen_vorgesehen`, kein Kennzeichen.

Die Sprech-Funktionen (`geraetegrenze`, `neustart`, …) prüfen die eingesetzten Werte **nicht**:
sie liegen im Rechenweg der Verdichtung, und ein Satz darf dort nie eine Menge kosten.

## 3. Rundung (E11): gerechnet ungerundet, gerundet nur angezeigt

**Wertbezug**, Einheit und **Ebene** bestimmen die Zahlform, nie die Fläche:
`zahl(wert, einheit, ebene, wertbezug = gemessen)`.

Seit 1.12 (Entscheid B vom 15.09.2026) unterscheidet die Anzeige **vereinbart** und
**gemessen**. Vereinbarte ganze Werte stehen ganzzahlig: „vereinbart 550 kW · Anschluss
630 kVA“. Echte Dezimalstellen bleiben vollständig erhalten („27,6 kW“, „550,45 kW“);
nur nachgestellte Nullen entfallen. Es wird kein vereinbarter Betrag auf ganze Zahlen
gerundet. Der bestehende Eingabeweg erlaubt solche Dezimalwerte bereits.

`gemessen` ist die kompatible Vorgabe für die bisherigen Aufrufe und folgt der Tabelle
unten („Momentan 312,4 kW“, auch „550,0 kW“). Der Wertbezug ist eine **Anzeige-Regel**;
er ersetzt keine fachliche Mengenherkunft und bezeichnet abgeleitete Mengen nicht als
Messung. Fehlende Werte, Einheiten-/Ebenenprüfung und ungerundete Speicherung bleiben gleich.

| Einheit | Viertelstunde | Stunde | Tag | Monat | Jahr |
|---|---|---|---|---|---|
| kWh | 1 („36,0 kWh“) | 1 („28,8 kWh“) | 0 („2.304 kWh“) | 0 („55.100 kWh“) | 0 („1.482.300 kWh“) |
| kW | 1 („96,5 kW“) — jede Ebene | | | | |
| % | 0 („85 %“) — jede Ebene | | | | |
| m³ | 1 („1.240,0 m³“) — jede Ebene | | | | |
| kVA | 1 („630,0 kVA“) — jede Ebene; gemessene Scheinleistung (seit 1.2) | | | | |
| kvarh | 1 | 1 | 0 | 0 | 0 — Blindarbeit ist Arbeit und rundet wie kWh (seit 1.3) |
| kVAh | 1 | 1 | 0 | 0 | 0 — Scheinarbeit ist Arbeit und rundet wie kWh, bleibt aber kVAh (seit 1.8) |

**Anzeige-Einheit (seit 1.3, Ableitung aus E11 — kein Captain-Entscheid).** Gespeichert bleibt,
was der Zähler liefert (Wh, kWh, MWh, varh, kvarh, m³); **angezeigt** wird kWh für Wirkarbeit,
kvarh für Blindarbeit, m³ für Volumen, mit den Stellen dieser Tabelle — so wie der Jahreswert
„1.482.300 kWh“ heißt, nicht „1.482,3 MWh“. `menge(wert, gespeicherte Einheit, ebene)` rechnet mit
dem festen Faktor aus `rundung.anzeige_einheiten` um und ruft `zahl` an („337600 Wh“ → „337,6 kWh“);
eine Einheit ohne Eintrag (unbekannt, „0,1 kWh“ …) ist `einheit_unbekannt`.

**Scheinarbeit und Wattminuten (seit 1.8).** Aus dem Messpunkt-Katalog kommen zwei weitere
Zähler-Einheiten:

- **VAh (Scheinarbeit, SunSpec 122/201–203) wird kVAh** — eine EIGENE Anzeige-Einheit mit den
  Stellen von kWh, **nie kWh**. Scheinarbeit ist nicht in Wirkarbeit umrechenbar (dazu fehlt der
  Leistungsfaktor über die Zeit); eine Scheinarbeit, die als Wirkarbeit dasteht, ist eine falsche
  Rechnung beim Kunden, kein Anzeigefehler. kVAh gespeichert bleibt kVAh.
- **Wmin (Wirkarbeit in Wattminuten, Shelly Gen1 `meters[].total`) wird kWh** mit dem optionalen
  Feld `teiler` = 60000: angezeigt wird `wert × faktor ÷ teiler`, und gerundet wird der **exakte
  Quotient** (2 999 Wmin = 0,049983… → „0,0 kWh“; ein abgeschnittener Faktor 0,0000167 ergäbe
  falsch „0,1 kWh“). Fehlt `teiler`, ist er 1.
- **„0,1 kWh“ ist keine Einheit**, sondern eine Einheit mit eingebackenem Faktor (KACO `eto`/`etd`).
  Der Faktor gehört an die Skalierung des Katalogs (`scale`), nie in den Einheiten-Namen — sonst
  rechnet jemand zweimal damit oder gar nicht. Sie bleibt `einheit_unbekannt`; der Satz steht ohne
  Zahl, bis der Katalog die Einheit des dekodierten Werts nennt (siehe
  `docs/agents/root/uems-katalog-einheiten.md`). Eine Menge **in einem
Kennzeichen** spricht die Stellen von `rundung.kennzeichen_ebene` = Viertelstunde: der Satz wandert
unverändert von der Viertelstunde bis ins Jahr und darf nicht je Periode anders runden
(„Zuwachs 337,6 kWh“ auch am Tag).

- Kaufmännisch (halbe Stelle von der Null weg, wie `BigDecimal.HALF_UP`): 96,45 kW → „96,5 kW“.
  Der TS-Zwilling rundet den **Dezimaltext** (`dez.ts`), nie den Binärbruch — `0.15` wird „0,2“.
- Tausenderpunkt, Komma, **geschütztes Leerzeichen U+00A0** vor der Einheit, Minus **U+2212**
  („−34,2 kW“), auf null gerundet ohne Minus („0,0 kW“). Kein Wert ist „—“, nie „0“.
- kWh und kvarh ohne Ebene sind `ebene_fehlt`; eine Einheit außerhalb der Tabelle ist `einheit_unbekannt` —
  eine neue Einheit ist eine Vertragsänderung.
- **Gerechnet wird ungerundet** (Vektoren auf 3 Nachkommastellen). Der CSV-Export bleibt
  ungerundet mit Punkt als Dezimalzeichen und ISO-8601-Zeit mit Offset.
- **Rundungsdifferenzen werden genannt, nie versteckt:** `rundungsdifferenz` sagt „Summe der
  angezeigten Werte 107,4 kWh · Rundungsdifferenz 0,1 kWh“ (F24: vier Viertelstunden gegen ihre
  Stunde) und korrigiert keinen Teil.

## 4. Sommerzeit (E10): Ortszeit des Standorts

- `raster(tag, zone, schritt)` beschriftet die Viertelstunden oder Stunden eines Kalendertages in
  der Zeitzone des **Standorts**: Wanduhr des Beginns plus Schritt („02:00–03:00“).
- Eine Beschriftung, die an diesem Tag **zweimal** vorkommt, trägt den Zusatz: **MESZ/MEZ** in
  einer Zone mit Normalzeit UTC+01:00 („02:00–03:00 MESZ · 02:00–03:00 MEZ“, F13), in jeder
  anderen Zone ihren Offset („01:00–02:00 UTC+01:00“). Die fehlende Stunde am 28.03.2027
  **erscheint nicht** (nach „01:00–02:00“ folgt „03:00–04:00“, F14).
- `von` jedes Feldes ist ISO-8601 **mit Offset** — die Form des Exports.
- `uhr(zeit, zone)` ist dieselbe Regel für die Uhrzeit **in einem Kennzeichen** (seit 1.1): „02:30“
  am 25.10.2026 gibt es zweimal, also heißt es „Rücksetzung 02:30 MESZ …“ bzw. „… 02:30 MEZ …“;
  „03:00“ und jede Uhrzeit eines anderen Tages bleiben ohne Zusatz. Der Platzhalter `uhr` erkennt
  den Zusatz mit. Die Zone kommt seit 1.3 aus dem Träger **`ReihenKontext`** (Einheit der Reihe +
  Zeitzone des Standorts), den `ViertelstundeVerdichter`, `TagVerdichter`, `PeriodeVerdichter` und
  `ZeitraumMenge` bilden (Standort → Unternehmen → Vorgabe, `ReihenKontext.zeitzonen`) und bis
  `VerbrauchRegeln` reichen; Python-Zwilling `verbrauch.ReihenKontext`. Es gibt keine feste Zone mehr.
- `tagesdauer(tag, zone)` sagt „25 Stunden (Zeitumstellung)“ bzw. „23 Stunden (Zeitumstellung)“
  und an einem 24-Stunden-Tag nichts. Die Stundenzahl wird bei `BezugsPeriode.stundenDesTages`
  (→ `VerbrauchRegeln.stunden`) bzw. `bezugsPeriode.ts` bestellt, nie hier gezählt.

## 5. Der Kundensatz eines Ergebnisses

`satz(ergebnis)` spricht **Zahl · Zustand · Verlauf · Kennzeichen**, getrennt durch „ · “:

- „2.304 kWh · vollständig · Verlauf 85 % · Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht
  auf Viertelstunden verteilbar“ (F8)
- „14,3 kWh · unvollständig · Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt“ (F6)
- „— · keine Werte“ (F8) · „2.304 kWh · mit Ersatzwert“ (F11)

Ein Ergebnis mit Verstößen wird nicht gesprochen — die Fläche fragt vorher `pruefe`. Wie eine
Karte die Sätze anordnet (Tageskarte, Stundenliste), gestaltet AP-08 IP-11.

**Die Teile (seit 1.6, nur TS).** `teile(ergebnis)` gibt Zahl, Zustand, Verlauf und Kennzeichen
einzeln zurück — zusammengefügt mit „ · “ Zeichen für Zeichen `satz`. Eine Karte stellt sie
nebeneinander, sie formuliert nichts um (`uemsErgebnis.test.ts` prüft es an jedem Fall der Familie
`ergebnis`).

**Die Herkunft der Menge am Zustandswort (seit 1.6, AP-08 IP-11, E1 = A).** Der Zustand einer
Menge aus Zählerständen folgt aus den Periodenständen, die Abdeckung des Verlaufs steht daneben —
„vollständig“ neben „Verlauf 85 %“ braucht darum seine Herkunft:
`zustandMitHerkunft(zustand, herleitung, wert)` → „vollständig (Menge aus Zählerständen)“ (Block
`mengen_herkunft`, Familie `herkunft`). Wortlaut aus E1 (Empfehlung A, Beispiel F8) und §8 IP-11.

| Herleitung der Quellenbindung | am Zustandswort |
|---|---|
| `zaehlerstand`, `differenzen` | „(Menge aus Zählerständen)“ — beide lesen einen Zählerstand |
| `integration` | nichts — das Kennzeichen „aus Leistung integriert“ sagt es, der Zustand folgt aus der Abdeckung |
| `momentanwert` | nichts — ein Momentanwert hat keine Menge |
| keine (berechnete Messstelle) | nichts |

Nur an **vollständig** und **unvollständig**, nur **mit Zahl** („— · unvollständig“ bleibt ohne
Herkunft; „mit Ersatzwert“ sagt Methode und Kennung im Kennzeichen). Ein fremdes Zustandswort oder
eine fremde Herleitung wird nicht gesprochen. Java `ErgebnisZustand.zustandMitHerkunft` ⟷ TS
`uemsErgebnis.zustandMitHerkunft`.

**Die Fassung: vorläufig oder endgültig (seit 1.7, AP-08 IP-11, Captain 14.09.2026 „Ja, immer
zeigen“).** Wer eine Zahl abrechnet, muss wissen, ob sie sich noch ändern kann. Die Variante „nur
vorläufig zeigen, endgültig ist der Normalfall“ ist verworfen: dann müsste der Kunde die
Abwesenheit eines Wortes deuten. Darum sind „vorläufig“ und „endgültig“ Kennzeichen mit **Rang 90**
— ganz zuletzt, nach „korrigiert (Version n)“: erst welche Version, dann ob sie feststeht. Der
Wortlaut ist das Wort, das `kennzeichen_vorgesehen` seit 1.0 führte, ohne Datum.

| `fassung` der Route (`werte[].fassung`) | gesprochen |
|---|---|
| `vorlaeufig` | „vorläufig“ |
| `endgueltig` | „endgültig“ |
| `null` (die Route kennt keine Fassung) | nichts — nie „endgültig“ als Vorgabe |
| ein anderer Wert | nicht gesprochen (Fehler) |

- **Je Periode, nie abgeleitet.** Gesprochen wird, was die Route für GENAU diese Periode liefert.
  Ein Monat wird erst endgültig, wenn alle seine Tage endgültig sind und seine Frist abgelaufen ist
  — seine ersten Tage sind es oft lange vorher; den umgekehrten Fall gibt es nicht.
- **Nicht der Zustand.** vollständig · unvollständig · keine Werte · mit Ersatzwert sagen, ob die
  Zahl VOLLSTÄNDIG ist; die Fassung, ob sie FESTSTEHT. „— · keine Werte · vorläufig“ ist gültig:
  eine Viertelstunde ohne Rohwert kann innerhalb der Frist noch Werte bekommen.
- **Höchstens eine Fassung je Liste** (`fassung.hoechstens_eine`): „vorläufig · endgültig“ ist
  `kennzeichen_doppelt`.
- Gespeichert wird der Satz nirgends — die Speicherklassen führen die Fassung als Spalte `zustand`.
  Gesprochen wird er von der Tages- und Monatskarte (Block `fassung`, Familie `fassung`): Java
  `ErgebnisZustand.fassung` ⟷ TS `uemsErgebnis.fassung`.

## 6. Befunde der Inventur

Die Vektor-Datei führt sie im Block `befunde` — benannt, **nicht still umformuliert**, weil der
heutige Wortlaut schon Vertrag von `verbrauch-vectors.json` und in den Speicherklassen gespeichert
ist. Die wichtigsten:

- **Erledigt in 1.3: „Zuwachs 337.600“** stand mit Punkt, drei Stellen und ohne Einheit — ein
  de-DE-Leser las 337 600. Seit 1.3 „Zuwachs 337,6 kWh“: die Einheit reist im Träger `ReihenKontext`
  bis zur Rechenregel, angezeigt nach der Anzeige-Einheit (§3); ohne bekannte Einheit steht der Satz
  ohne Zahl. Die alte Form lebt in `fruehere_fassungen`.
- **„Rechteck-Halten ≤ 2 × Kadenz“** ist Rechenmethode, kein Kundenwort.
- Sechs Satzformen haben **kein Wort** im Kennzeichen-Vokabular (Anfang/Ende nicht gemessen, nur
  ein Stand, fehlende Intervallmengen, gemessene Zeit).
- **Erledigt in 1.3:** die Uhrzeiten der Kennzeichen standen in der festen Zone Europe/Berlin.
  Seit 1.3 sprechen sie die Zone des Standorts aus dem Träger `ReihenKontext` (§4). Kein früherer
  Wortlaut: die drei zugelassenen Zonen zeigen dieselbe Wanduhr, und `uhr` erkennt jede Zone.
- **Erledigt in 1.1:** „mit Ablesestände“ (Dativ) → „mit Ableseständen“, alte Form als frühere
  Fassung lesbar.
- **Erledigt in 1.2:** die Bilanz- und Netzanschluss-Sätze schrieben „mindestens 1 055 kWh“ und
  „vereinbart 550 kW“ (Leerzeichen-Tausender, ungerundet, normales Leerzeichen). `BilanzAbleitung.zahlDe`
  ist entfernt; `rest`/`summe`/`periodenwert` nehmen die Ebene der Periode und rufen `zahl` an,
  `NetzanschlussRegeln.kopfzeile` ebenso.
- **Seit 1.6:** der Report schreibt an F8 zusätzlich „— 14 Viertelstunden ohne Werte“ und an
  F13/F14 die Tagesdauer statt des Verlaufs. Die Zählung der leeren Viertelstunden liefert das
  Lese-Modell nicht (sie wäre eine zweite Rechnung in der Fläche) — offen; der Verlauf steht, wo er
  bekannt ist, die Tagesdauer setzt die Karte daneben.
- F17 zeigt „1 240 m³“ am Monat; der Vertrag folgt dem Wortlaut von E11 („1.240,0 m³“). E10
  schreibt „23 Stunden“; der Vertrag liest es wie F14 als „23 Stunden (Zeitumstellung)“.

## 7. Kennzeichen eines Kennzahl-Werts (seit 1.9, AP-11 IP-1)

Eine Kennzahl ([`kennzahl.md`](./kennzahl.md)) teilt Mengen; ihre Zahl trägt dieselben vier
Zustandswörter (§1), aber eine EIGENE Kennzeichen-Liste — Block `kennzahl_kennzeichen` der
Vektor-Datei. Die Verbrauchs-Liste (§2) bleibt Satz für Satz, wie sie ist; `ErgebnisZustand`
spricht keinen der Sätze. Gesprochen und geprüft werden sie von `uems/KennzahlRegeln` ⟷
`uemsKennzahl.ts` gegen `kennzahl-vectors.json`.

| Rang | Muster (Schlüssel) | Herkunft | ohne Zahl | Fall |
|---|---|---|---|---|
| 10 | berechnet (Kennzahl) (`berechnet_kennzahl`) | eigen | nein | K1 |
| 20 | enthält berechnet ({text}) (`enthaelt_berechnet`) | geerbt | nein | K4 |
| 21 | enthält verteilt ({text}) (`enthaelt_verteilt`) | geerbt | nein | K5 |
| 30 | gewichtet (Summe ÷ Summe) (`gewichtet`) | eigen | nein | K3 |
| 40 | Untergrenze — Menge unvollständig ({text}) (`untergrenze`) | eigen | nein | K10 |
| 40 | Obergrenze — Bezugsgröße unvollständig ({text}) (`obergrenze`) | eigen | nein | K11 |
| 40 | Richtung unbestimmt — Menge und Bezugsgröße unvollständig (`richtung_unbestimmt`) | eigen | nein | konstruiert |
| 41 | Nenner 0 ({text}) (`nenner_null`) | eigen | ja | K9 |
| 50 | ab {datum} (`ab`) | geerbt | nein | K2 |
| 51 | mit Ersatzwert ({text}) (`mit_ersatzwert`) | geerbt | nein | konstruiert |
| 52 | {bezeichnung} geändert am {datum} ({wechsel}) (`stammdatum_geaendert`) | geerbt | nein | konstruiert |
| 55 | Berechnung geändert am {datum} (Fassung {von} → {nach}) (`berechnung_geaendert_am`) | eigen | nein | konstruiert |
| 60 | {mit} von {gesamt} {wort} (`x_von_y`) | beides | nein | K3 |
| 60 | {mit} von {gesamt} {wort} ({fehlt}) (`x_von_y_fehlt`) | eigen | nein | konstruiert |
| 70 | {geltung} ab {datum} (`ab_mit_geltung`) | geerbt | nein | K3 |
| 80 | unplausibel (über 100 %) (`unplausibel_ueber_100`) | eigen | nein | K15 |
| 80 | unplausibel (negativ) (`unplausibel_negativ`) | eigen | nein | konstruiert |
| 81 | Eingang {objekt} seit {datum} außerhalb von {name} (`eingang_ausserhalb`) | eigen | nein | K22 |
| 82 | Bezugsgröße archiviert ({objekt}) (`bezugsgroesse_archiviert`) | eigen | nein | konstruiert |
| 82 | Eingang archiviert ({objekt}) (`eingang_archiviert`) | eigen | nein | konstruiert |
| 90 | korrigiert (Version {version}) (`korrigiert`) | eigen | ja | K6 |
| 90 | Berechnung geändert (Fassung {fassung}) (`berechnung_geaendert`) | eigen | ja | konstruiert |
| 91 | Nenner zurückgenommen ({text}) (`nenner_zurueckgenommen`) | eigen | ja | K19 |
| 100 | Stichtag {datum} (`stichtag`) — nur am Eingang der Herkunft | eigen | nein | K12 |

**Erbregeln (`erbend`).** Nur was über die PERIODE spricht, reist von einem Eingang an die Kennzahl:
„berechnet (…)“ eines Gesamtwerts wird „enthält berechnet (…)“, „verteilt (…)“ wird „enthält
verteilt (…)“, „ab TT.MM.JJJJ“ bleibt (aus einer Kennzahl mit ihrem Geltungsobjekt davor: „G-5 ab
15.10.2026“), „mit Ersatzwert (…)“, der Übergang eines Stammdatums („Fläche geändert am …“) und
„x von y Systemen“ bleiben. Alles andere steht nur in der Herkunft.

**Reihenfolge.** Der Rang steigt nie; jeder Satz höchstens einmal; ohne Zahl nur die Sätze mit
„ohne Zahl: ja“ — nie „berechnet (Kennzahl)“, nie etwas Geerbtes. Eine gröbere Periode aus
Teilperioden ersetzt jedes „ab …“ ihrer Teile durch ihr eigenes und behält „x von y …“ nur, wenn es
in jeder Teilperiode gleich lautet. Geschützte Leerzeichen (E11) auch hier: „über 100 %“, „0 Stück“.

## 8. Kennzeichen eines Berichts (seit 1.10, AP-12 IP-1)

Ein Bericht ([`bericht.md`](./bericht.md)) spricht über sich selbst, über einen Berichtsstand und über die Werte, die
er zitiert — mit eigenen Kennzeichen im Block `bericht_kennzeichen`. Sie haben keinen Rang und erben nichts: jedes steht an
genau einer Stelle (`stelle`). Die Verbrauchs-Liste (§2) und die Kennzahl-Liste (§7) bleiben Satz für Satz, wie sie sind.
Gesprochen und geprüft werden sie von `uems/BerichtRegeln` ⟷ `uemsBericht.ts` gegen `bericht-vectors.json`.

| Muster (Schlüssel) | Stelle | Beispiel | Fall |
|---|---|---|---|
| Berichtsstand Nr. {nr} (`berichtsstand`) | bericht | Berichtsstand Nr. 1 | B1 |
| ersetzt durch Nr. {nr} ({datum}) (`ersetzt_durch`) | stand | ersetzt durch Nr. 2 (16.11.2026) | B1 |
| Revision nötig — {anlass} (`revision_noetig`) | bericht | Revision nötig — Korrektur K-2026-0007 | B1 |
| Entwurf · Datenstand {datum} {uhr} (`entwurf`) | bericht | Entwurf · Datenstand 12.11.2026 10:05 | B2 |
| Zeitraum läuft (`zeitraum_laeuft`) | entwurf | Zeitraum läuft | B4 |
| vorläufig — endgültig ab {datum} (`vorlaeufig`) | wert | vorläufig — endgültig ab 08.11.2026 | B4 |
| heute: {name} (`heute`) | quelle | heute: Montage Linie M1 (Halle 2) | B10 |
| Teilansicht: {standorte} (`teilansicht`) | datei | Teilansicht: Werk Ahrenberg, Werk Lindach | B13 |
| vor Beginn (Energiemanagement seit {datum}) (`vor_beginn`) | wert | vor Beginn (Energiemanagement seit 01.10.2026) | B6 |
| Anstoß verworfen ({begruendung}) (`anstoss_verworfen`) | bericht | Anstoß verworfen (Ablesung geprüft, die Zahl bleibt) | B16 |

**Stellen.** `bericht` — in der Liste und im Kopf der Berichtsseite (R5); `stand` — am ersetzten Berichtsstand (R2);
`entwurf` — nur am Entwurf eines laufenden Zeitraums (EW4); `wert` — an einer Zahl des Entwurfs oder am Vergleich (Q5);
`quelle` — an einer Quelle, deren Name sich seit dem Datenstand geändert hat, nur als Hinweis (A5); `datei` — im Kopf einer
Datei für standortbeschränkte Personen (G3). Die Uhrzeit trägt ihren Zusatz nur an der doppelten Stunde (§4); der Kopf eines
Berichts nennt die Zone immer („Datenstand 10.11.2026 08:55 (MEZ)“, `bericht.md` D5). Platzhalter `datum` ist derselbe wie im
Block `kennzahl_kennzeichen`, `uhr` derselbe wie in `platzhalter` (§5).

## 9. Der Grund einer fehlenden Zahl (seit 1.11, AP-13 IP-1)

Zeigt ein Schritt der Route „Werte je Messstelle“ keine Zahl, nennt sie im Feld `grund` einen von acht Codes
(Java `uems/MessstelleWerteRegeln.OhneZahl`). Seit 1.11 hat jeder Code genau EINEN Kundensatz im Block `grund`
(AP-13 E11 = A, D5): die Karte zeigt „—“ UND den Satz. **Das ist Sprache, keine Regel** — wann ein Grund gilt,
entscheidet die Route (AP-08 IP-9); kein Satz nennt eine Ursache, die kein Modul geliefert hat. Gesprochen von
`ErgebnisZustand.grundSatz(code, werte)` ⟷ `uemsErgebnis.grundSatz(code, werte)`: `null` spricht nichts, ein fremder
Code (auch ein Grund der Kennzahl oder ein Zustandswort) und falsch belegte Platzhalter sind Programmfehler. Die
Platzhalter bildet die Fläche aus den Feldern der Antwort (`woher` je Satz); den Anteil beugt der Block `anteil`
(`positiv` → „positiven“), nie die Fläche.

| Code | Satz | Beispiel |
|---|---|---|
| `keine_quelle` | Keine Quelle: {messstelle} hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0. | Keine Quelle: MS-21 Gas Heizung Verwaltung hatte in diesem Zeitraum keine führende Quelle — es gibt keine Zahl, auch keine 0. |
| `quelle_teilweise` | Die Quelle deckt den Zeitraum nur zum Teil: {quelle} gilt seit {ab} — die gespeicherte Zahl gehört nicht ganz dieser Messstelle. | Die Quelle deckt den Zeitraum nur zum Teil: Netzzähler K-11 (GR-10) gilt seit 15.10.2026 — die gespeicherte Zahl gehört nicht ganz dieser Messstelle. |
| `anteil_nicht_gespeichert` | Die Quelle liest nur den {anteil} Anteil von {kanal}; eine Menge je Anteil ist nicht gespeichert. | Die Quelle liest nur den positiven Anteil von Wirkenergie Bezug (K-3); eine Menge je Anteil ist nicht gespeichert. |
| `berechnet` | Für eine berechnete Messstelle gibt es hier keine gespeicherte Zahl: Stunden werden nie gespeichert, eine Formel aus Momentanwerten gar nicht. | — |
| `noch_nicht_gebildet` | Noch nicht gerechnet — der Wert erscheint von selbst, Sie müssen nichts tun. | — |
| `ohne_menge_gespeichert` | Dieser Zeitraum ist ohne Menge gespeichert (Stand vor der Umstellung) — der Verlauf ist bekannt, die Zahl nicht. | — |
| `version_nicht_gespeichert` | Version {n} ist für diesen Zeitraum nicht gespeichert; der neueste Stand ist Version {max}. | Version 3 ist für diesen Zeitraum nicht gespeichert; der neueste Stand ist Version 2. |
| `version_nicht_gebildet` | Eine Stunde hat keine eigenen Versionen — eine ihrer Viertelstunden trägt eine spätere Version. Die Viertelstunden zeigen sie. | — |

**Drei Sätze weichen vom Vorschlag in AP-13 O15 ab** (Block `befunde`, gemeldet an firstmate): `noch_nicht_gebildet`
spricht den gebauten Satz der Tageskarte (PR 809) statt „… noch nicht gebildet — … (Monatslauf am …)“, dessen Datum
kein Feld liefert; `ohne_menge_gespeichert` sagt nicht „Zustand bekannt“ (die Route liefert `zustand = null`, auch
an Zeiträumen); `berechnet` verspricht keine Tag-/Monatswerte (eine Formel aus Momentanwerten hat keine). Die übrigen
Blöcke (§2, §7, §8) bleiben Satz für Satz, wie sie sind.

## Grenzen

Keine Route und kein Lese-Modell (IP-9), keine Fläche und keine Karte (IP-10/IP-11), keine
Ersatzwert-Methoden (IP-13), keine Korrekturen (IP-12 ff.), keine Migration. Die Bilanz-Kennzeichen
(berechnet (…), nicht zugeordnet, saldiert) sind Teil von
[`bilanz.md`](./bilanz.md), nicht dieser Liste; „korrigiert (Version n)“ steht seit 1.5 mit demselben Wortlaut in
beiden.
