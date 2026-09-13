# Ergebnis-Zustand: eine Zahl sagt selbst, wie belastbar sie ist (UEMS AP-08 IP-8)

Stand 13.09.2026 · Vertrag 1.2 · Konzept `data/vp-uems-ap08-verbrauch` §4.1 (Ergebnis-Zustand,
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
| mit Ersatzwert | Pflicht | frei | mindestens ein Ersatzwert (E7); Methode und Kennung spricht AP-08 IP-13 |

Der Zustand wird **berechnet, nie gesetzt**. `pruefe` meldet, wenn Zahl, Zustand und Kennzeichen
nicht zusammenpassen: „keine Werte“ mit `0` ist `zahl_verboten` (unbekannt ist keine Null),
„vollständig“ mit einer Rücksetzung ist `vollstaendig_mit_fehlbestand`, „unvollständig“ ohne
einen Satz, der sagt was fehlt, ist `unvollstaendig_ohne_grund`.

⚠ Nicht verwechseln: `zustand` der Speicherklassen (vorläufig/endgültig, AP-07 E5) ist **nicht**
dieser Zustand (`menge_zustand`).

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
| 30 | Lücke {von}–{bis}: Zuwachs {zuwachs} gemessen, nicht auf Viertelstunden verteilbar | Lücke: Zuwachs gemessen | nein |
| 40 | Neustart {uhr}: bis zu {verlust_s} s Zählung möglicherweise verloren | Neustart-Verlust | ja |
| 50 | 1 von {erwartet} Intervallmengen fehlt / {fehlend ≥ 2} von {erwartet} … fehlen — … | — | ja |
| 50 | gemessene Zeit {minuten}:{sekunden} min von {periode_min} min | — | ja |
| 60 | aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit) | aus Leistung integriert | nein |

**Reihenfolge:** der Rang steigt in einer Liste nie (`kennzeichen_reihenfolge`); die Sätze der
Gerätegrenze stehen in fester Folge (`kennzeichen_folge`); ein einmaliges Kennzeichen steht nie
doppelt. Innerhalb von Rang 30 stehen die Sätze in zeitlicher Folge — die Uhrzeit HH:MM allein
beweist das über Tagesgrenzen nicht (ein Monat kann zwei Rücksetzungen um 09:12 haben) und wird
darum **nicht** verglichen.

**Frühere Fassungen (seit 1.1).** Ein geänderter Wortlaut ist schon gespeichert: `kennzeichen`
der Speicherklassen hält jeden Satz, eine endgültige Viertelstunde wird nie neu geschrieben, und
Tag, Monat und Jahr übernehmen die Sätze ihrer Teile. Die Liste `fruehere_fassungen` hält darum den
alten Wortlaut je Muster: er wird als dieses Muster **erkannt** (gleicher Rang, gleiches Wort,
`fruehere_fassung = true`), `pruefe` lässt ihn zu und `satz` spricht ihn, wie er gespeichert ist —
aber **keine Sprech-Funktion erzeugt ihn mehr**, und keine Erwartung von `verbrauch-vectors.json`
trägt ihn. Eine vorläufige Zeile bekommt den neuen Wortlaut beim nächsten Verdichtungslauf, eine
endgültige behält den alten. Heute: „Gerätegrenze {uhr} mit Ablesestände“ (bis 1.0).

**Vorgesehen** sind die übrigen Wörter des Vokabulars — nachgeliefert · korrigiert (Version n) ·
vorläufig · endgültig · Ablesezeitraum · mit Ersatzwert (Methode …). Ihren Wortlaut legt das
Paket fest, das sie erzeugt (`kennzeichen_vorgesehen.wortlaut_mit`); bis dahin ist ein solcher
Satz `kennzeichen_vorgesehen`, kein Kennzeichen.

Die Sprech-Funktionen (`geraetegrenze`, `neustart`, …) prüfen die eingesetzten Werte **nicht**:
sie liegen im Rechenweg der Verdichtung, und ein Satz darf dort nie eine Menge kosten.

## 3. Rundung (E11): gerechnet ungerundet, gerundet nur angezeigt

Die **Ebene** bestimmt die Nachkommastellen, nie die Fläche: `zahl(wert, einheit, ebene)`.

| Einheit | Viertelstunde | Stunde | Tag | Monat | Jahr |
|---|---|---|---|---|---|
| kWh | 1 („36,0 kWh“) | 1 („28,8 kWh“) | 0 („2.304 kWh“) | 0 („55.100 kWh“) | 0 („1.482.300 kWh“) |
| kW | 1 („96,5 kW“) — jede Ebene | | | | |
| % | 0 („85 %“) — jede Ebene | | | | |
| m³ | 1 („1.240,0 m³“) — jede Ebene | | | | |
| kVA | 1 („630,0 kVA“) — jede Ebene; Anschluss-Scheinleistung = „Leistung“ in E11 (seit 1.2) | | | | |

- Kaufmännisch (halbe Stelle von der Null weg, wie `BigDecimal.HALF_UP`): 96,45 kW → „96,5 kW“.
  Der TS-Zwilling rundet den **Dezimaltext** (`dez.ts`), nie den Binärbruch — `0.15` wird „0,2“.
- Tausenderpunkt, Komma, **geschütztes Leerzeichen U+00A0** vor der Einheit, Minus **U+2212**
  („−34,2 kW“), auf null gerundet ohne Minus („0,0 kW“). Kein Wert ist „—“, nie „0“.
- kWh ohne Ebene ist `ebene_fehlt`; eine Einheit außerhalb der Tabelle ist `einheit_unbekannt` —
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
  den Zusatz mit. ⚠ Die Verbrauchsregel übergibt heute die feste Zone Europe/Berlin
  (`VerbrauchRegeln.ANZEIGE_ZEITZONE`), nicht die des Standorts — siehe Befunde.
- `tagesdauer(tag, zone)` sagt „25 Stunden (Zeitumstellung)“ bzw. „23 Stunden (Zeitumstellung)“
  und an einem 24-Stunden-Tag nichts. Die Stundenzahl wird bei `BezugsPeriode.stundenDesTages`
  (→ `VerbrauchRegeln.stunden`) bzw. `bezugsPeriode.ts` bestellt, nie hier gezählt.

## 5. Der Kundensatz eines Ergebnisses

`satz(ergebnis)` spricht **Zahl · Zustand · Verlauf · Kennzeichen**, getrennt durch „ · “:

- „2.304 kWh · vollständig · Verlauf 85 % · Lücke 14:00–17:31: Zuwachs 337.600 gemessen, nicht
  auf Viertelstunden verteilbar“ (F8)
- „14,3 kWh · unvollständig · Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt“ (F6)
- „— · keine Werte“ (F8) · „2.304 kWh · mit Ersatzwert“ (F11)

Ein Ergebnis mit Verstößen wird nicht gesprochen — die Fläche fragt vorher `pruefe`. Wie eine
Karte die Sätze anordnet (Tageskarte, Stundenliste), gestaltet AP-08 IP-11.

## 6. Befunde der Inventur

Die Vektor-Datei führt sie im Block `befunde` — benannt, **nicht still umformuliert**, weil der
heutige Wortlaut schon Vertrag von `verbrauch-vectors.json` und in den Speicherklassen gespeichert
ist. Die wichtigsten:

- **„Zuwachs 337.600“** steht mit Punkt, drei Stellen und ohne Einheit — ein de-DE-Leser liest
  337 600. E11 verlangte „337,6 kWh“. In 1.1 bewusst offen: die Rechenregel kennt die Einheit
  nicht (Durchreichen bis Tag/Monat/Jahr ist ein Folgepaket mit Datenbank-Lauf). Anzeige-Einheit
  als Ableitung aus E11: gespeichert bleibt die Zähler-Einheit, angezeigt kWh/kvarh/m³ mit den
  Stellen von E11 (wie „1.482.300 kWh“ statt „1.482,3 MWh“).
- **„Rechteck-Halten ≤ 2 × Kadenz“** ist Rechenmethode, kein Kundenwort.
- Sechs Satzformen haben **kein Wort** im Kennzeichen-Vokabular (Anfang/Ende nicht gemessen, nur
  ein Stand, fehlende Intervallmengen, gemessene Zeit).
- Die Uhrzeiten der Kennzeichen stehen in der festen Zone Europe/Berlin, nicht in der Zone des
  Standorts. Seit 1.1 tragen sie an der doppelten Stunde MESZ/MEZ und sind damit eindeutig; die
  Standort-Zone müssten `ViertelstundeVerdichter` und `ViertelstundenTeile` (Tag, Monat, Jahr,
  freier Zeitraum) laden und bis `VerbrauchRegeln.uhr` durchreichen.
- **Erledigt in 1.1:** „mit Ablesestände“ (Dativ) → „mit Ableseständen“, alte Form als frühere
  Fassung lesbar.
- **Erledigt in 1.2:** die Bilanz- und Netzanschluss-Sätze schrieben „mindestens 1 055 kWh“ und
  „vereinbart 550 kW“ (Leerzeichen-Tausender, ungerundet, normales Leerzeichen). `BilanzAbleitung.zahlDe`
  ist entfernt; `rest`/`summe`/`periodenwert` nehmen die Ebene der Periode und rufen `zahl` an,
  `NetzanschlussRegeln.kopfzeile` ebenso.
- F17 zeigt „1 240 m³“ am Monat; der Vertrag folgt dem Wortlaut von E11 („1.240,0 m³“). E10
  schreibt „23 Stunden“; der Vertrag liest es wie F14 als „23 Stunden (Zeitumstellung)“.

## Grenzen

Keine Route und kein Lese-Modell (IP-9), keine Fläche und keine Karte (IP-10/IP-11), keine
Ersatzwert-Methoden (IP-13), keine Korrekturen (IP-12 ff.), keine Migration. Die Bilanz-Kennzeichen
(berechnet (…), nicht zugeordnet, saldiert, korrigiert (Version n)) sind Teil von
[`bilanz.md`](./bilanz.md), nicht dieser Liste.
