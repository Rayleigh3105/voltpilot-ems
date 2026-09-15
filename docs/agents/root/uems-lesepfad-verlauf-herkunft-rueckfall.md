# UEMS-Lesepfad: Verlauf mit Herkunft, Rückfall auf die Speicherklassen, Export (AP-07 IP-14)

Der Lesepfad der Messdatenstrecke: das Paket, mit dem alles, was seit PR 691 in die Datenbank
geschrieben wurde — Herkunft je Wert, Viertelstunden, Tageswerte, Endgültigkeit —, zum ersten Mal
GELESEN wird. Keine Migration; reine Lese-Arbeit in `services/api`.

Berührte Dateien: `measurement/MeasurementHistoryService.java`,
`measurement/SpeicherklasseHistorie.java` (neu), `uems/LesepfadQuelle.java` (neu),
`web/DeviceMeasurementSelectionController.java`, `frontend/portal/src/api.ts` (nur Typen).
Tests: `uems/LesepfadQuelleTest` (rein), `uems/UemsLesepfadTest` (Testcontainers, A2 · A7 ·
Export-Spalten · Marken · Zaun · Fingerabdruck).

## 1. Die QUELLENWAHL — und warum sie ein RÜCKFALL ist, kein Ersatz

`LesepfadQuelle` ist die reine Regel; sie steht in EINER Reihenfolge:

1. Der **bestehende Weg antwortet zuerst** — unverändert: `raw` ≤ 2 Tage aus
   `device_measurement_sample`, sonst `device_measurement_rollup_5m` (≤ 31 d) bzw. `_15m`.
2. Der **Rückfall greift nur**, wenn der Zeitraum über die Rohdaten-Frist hinausreicht
   (`von < jetzt − 90 Tage`, `MeasurementRetention.RAW_DAYS`) **UND** der bestehende Weg für ihn
   NICHTS hergibt. Dann: `messreihe_viertelstunde` bei ≤ 90 Tagen, sonst `messreihe_tag`.
3. Die Antwort nennt IMMER ihre Quelle: `meta.quelle` (`roh` · `rollup_5m` · `rollup_15m` ·
   `viertelstunde` · `tag`), `meta.quelleErklaerung` (ein Kundensatz) und `meta.rohGrenze`.

⚠ **Ein Zeitraum, der die Frist ÜBERSCHREITET, wird aus GENAU EINER Quelle beantwortet** — nie
zusammengenäht. Zwei Quellen in einer Linie hätten zwei Bedeutungen von „Wert" und „Lücke"; der
Leser müsste raten, welche Hälfte er gerade sieht. Statt zu nähen nennt die Antwort die Frist.

⚠ **Innerhalb der Frist ändert sich NICHTS** — auch der Fehler nicht. `representation=raw` ohne
Rohwerte wirft dort weiter 400 („Für diesen Zeitraum sind keine echten Rohdaten vorhanden."),
weil das dort WAHR ist: Rohwerte werden noch aufbewahrt, es sind keine da — und ohne Rohwert gibt
es auch keinen Viertelstundenwert. JENSEITS der Frist fällt derselbe 400er weg: dort wäre er eine
Lüge über eine Frage, die wir beantworten können (`rawAvailable=false` + Werte, Abnahme A7).

⚠ Die Reihe ist **Mandant + Komponente + Messkanal** (E2), der Verlauf wird aber über **Gerät +
Messwert** angefragt. Die Komponente kommt aus `entityId` der Anfrage, sonst aus der EINDEUTIGEN
`device_measurement_selection`; mehrdeutig heißt KEIN Rückfall, nie „irgendeine".

⚠ `SELECT DISTINCT` auf diesem Weg ist verboten: TimescaleDBs SkipScan bricht mit
`unsupported subplan type for SkipScan: Result` ab (2.17.2-pg16, im Test reproduziert). Entdoppelt
wird in Java.

## 2. Die neuen Felder — additiv, und nie geraten

`Datum.herkunft` (neu, nullable) trägt §4.4: Wertart, Abdeckung (`abdeckungProzent`, **nie auf 100
gerundet**), `erhalten`/`erwartet`, die fünf Qualitätszähler, `zustand`/`endgueltigAb`/`version`,
`nachgeliefert`/`zustellart`/`letzteEingangszeit`, die Anker (`geraetEinbau`, `box`, `fassung`,
`katalogVersion`, `rolle`) und `standAnfang`/`standEnde`.

Jedes Feld kommt aus einer Spalte, die PR 691/694/698/700/702 gefüllt hat:

| Quelle | was gefüllt ist | was LEER bleibt |
|---|---|---|
| `roh` | Wertart, Gerät-Einbau, Box, Fassung, Katalogstand, Rolle, Zustellart, `erhalten`/`nGood` | Abdeckung, `erwartet`, Zustand, die übrigen Qualitätszähler, Stände |
| `viertelstunde` | alles aus `messreihe_viertelstunde` | was die Spalte selbst nicht hat |
| `tag` | alles aus `messreihe_tag` | — |
| `rollup_5m` / `rollup_15m` | nichts (`herkunft` ist `null`) | die Verdichtung der Box trägt keine Herkunft |

⚠ **Nicht eindeutig heißt leer.** Nennen zwei Intervalle eines Raster-Schritts verschiedene Geräte,
Boxen, Fassungen oder Katalogstände, bleibt der Anker `null` — der WECHSEL steht als Marker da.
Ein Raster-Schritt ist `endgueltig` nur, wenn JEDE seiner Viertelstunden es ist.

⚠ **Der Kurvenwert eines Zählerstands** ist seit der Nacharbeit (§8) die GESPEICHERTE Menge bzw.
im groben Raster die Regel des Vertrags — nie eine Summe von Viertelstunden. `standAnfang`/
`standEnde` reisen weiter in der Herkunft mit.

## 3. Die MARKEN: ein Sprung wird erklärbar

Sieben Arten des Ereignis-Vokabulars (§4.8) treten zu den bestehenden Markern: `data_gap`,
`counter_reset`, `counter_overflow` (seit §8), `device_boundary`, `handover`, `duplicate_conflict`,
`late_arrival`. Gebündelt je
Art und Raster-Schritt, mit `count` und optionalem `until` — sparsam, nie als Flut. Gelesen über
`idx_messreihe_ereignis_reihe` / `…_quelle`, die IP-8 für genau diesen Leser gebaut hat; `zeit` IST
der Beginn (der Vertrag verlangt `zeit = von`), darum kein `COALESCE` in der Bedingung.

⚠ **Die Marken stehen auf JEDEM Weg, nicht nur im Rückfall** — ein Gerätewechsel von gestern ist
genau der Sprung, der eine Erklärung braucht. Das ist die EINE Stelle, an der dieses Paket ein
bestehendes Feld ANREICHERT statt nur zu ergänzen; ohne Ereignis zur Reihe (der Stand jeder
heutigen Anlage) ist die Antwort unverändert.

⚠ **`handover` hängt am Vertrag an der DATENQUELLE und darf gar keine Komponente nennen** — über
`entity_id` käme sie nie an. Der Leser hat darum einen zweiten Zweig: Ereignisse ohne Reihen-Bezug,
die an `measurement_point.data_source_id` DIESER Komponente hängen.

⚠ Eine **Fortschreibung ist kein zweites Ereignis** (append-only, gleiche `ereignis_id`, jüngste
Zeile gewinnt), und der **Bestands-Spiegel** (`aus_bestand`) bleibt draußen — er steht schon im
alten Marker-Weg aus `device_measurement_event`.

## 4. Der EXPORT — additiv, mit der je Wert GESPEICHERTEN Katalogfassung

Die zehn Kopfzeilen und die sieben Spalten `time,value,min,max,text,sample_count,gap` stehen
unverändert an derselben Stelle; ein bestehender Empfänger liest weiter. Neu dahinter: die
Herkunfts-Spalten (`quelle` … `stand_anfang,stand_ende`) und die Kopfzeilen `# quelle=`,
`# quelle_erklaerung=`, `# raw_available=`, `# roh_grenze=`, `# catalog_version_gespeichert=`.

⚠ **`# catalog_version=` bleibt der HEUTIGE Stand des Katalogs** (Bestandsschutz). Die je Wert
gespeicherte Fassung steht in der Spalte `katalog_version` — ein Export, der eine alte Messung mit
heutigen Stammdaten beschreibt, ist falsch. Eine Zahl, die es nicht gibt, bleibt LEER, nie 0.

⚠ **Seit AP-12 IP-10 (E11 DA4) neun Kopfzeilen mehr**, direkt hinter `# catalog_version_gespeichert=`
(Position 16–24): `zeitraum_von`, `zeitraum_bis`, `erzeugt_am`, `erzeugt_von`, `zeitzone="UTC"`,
`dezimal="."`, `trenner=","`, `standort`, `unternehmen` — `csv(History, Erzeugung)`. Wer eine
Kopfzeile ergänzt, hängt sie HINTER die neun; der Vergleich mit dem Stand davor
(`BestandGeraeteCsvVergleich`, `uems-bericht-ausgabe-csv.md`) prüft die Stelle.

## 5. Rechte (AP-03 ist NICHT gebaut)

`DeviceMeasurementSelectionController` nennt seit diesem Paket „UEMS" in seinem Klassen-Javadoc
und steht damit unter `RechteKennungenDerRoutenTest`: jede seiner acht Routen trägt ihren
Rechte-Kommentar (`messwerte.ansehen`, `ereignisse.ansehen`, `export.standort`,
`mess_selektion.bearbeiten`). Durchgesetzt wird heute `authenticated()` plus die
Zeilen-Abschirmung des Kundenbereichs; ein fremdes Gerät ist **404, nie 403**. Eine Durchsetzung
je Standort entsteht erst mit AP-03 — sie wird hier NICHT erfunden. **Die EINE Ausnahme seit
AP-12 IP-10 (E12 G1):** der Export ist `export.standort`, durchgesetzt über `uems/BestandGeraeteCsv`
— die VoltPilot-Unterstützung bekommt 403 statt der Datei (`uems-bericht-ausgabe-csv.md`).

## 6. Bestandsschutz: der Fingerabdruck

`UemsLesepfadTest.innerhalbDerFristIstDieFlaecheZeichengleich` friert eine MD5-Projektion der
BESTEHENDEN Felder (Meta ohne die neuen, `time,value,min,max,text,sampleCount,gap`, Marken) für
einen Zeitraum innerhalb der Frist ein. Die neuen Felder stehen bewusst NICHT darin — sonst
bewiese der Fingerabdruck nichts über den Bestand. `MeasurementSelectionApiTest` (9 Fälle, die
Kundenfläche über HTTP) und `MeasurementHistoryServiceTest` laufen UNVERÄNDERT. Die einzige
gewollte Änderung an einer bestehenden Antwort sind die Marken aus §3 — `data` und `meta` bleiben
Zeichen für Zeichen.

⚠ Die Records `Datum`, `Marker` und `Meta` haben jeweils ihren **Konstruktor von vor IP-14**
behalten (er füllt die neuen Felder mit `null`), damit kein bestehender Aufrufer und kein
bestehender Test angefasst werden muss.

## 7. Was dieses Paket NICHT tut

Keine Lücken-Meldung als Job (IP-9), keine Löschwege (IP-11), keine versionierten Korrekturen und
keine Kaskade (AP-08 IP-12 ff.), keine Rechte-Durchsetzung je Standort (AP-03), keine Portal-Fläche
(IP-15 — `api.ts` bekommt nur die Typen).

## 8. Nacharbeit: Perioden-Mengen, Energie aus Leistung, Überlauf (nach AP-08 IP-3/IP-4/IP-5)

Test: `uems/UemsLesepfadMengenTest` (Testcontainers, gebildet von den ECHTEN Läufen). Keine
Migration, keine Rechenregel — gelesen bzw. AUFGERUFEN.

1. **Menge.** Tagesklasse: `messreihe_tag.menge` mit `menge_zustand`/`kennzeichen` (F8 03.11.2026:
   2 304,0 kWh vollständig — vorher leer; die Summe der Viertelstunden wäre 1 966,4). Viertelstunden-
   Raster: die gespeicherte Zeile wie vorher. ⚠ **Gröber als 15 min ist jeder Schritt ein freier
   Zeitraum** (`ZeitraumMenge.raster` → `ViertelstundenTeile.schritte`, dieselbe Regel wie
   `ZeitraumMenge.zeitraum`, ein Lesezug für alle Schritte; Lockstep im Test): eine Viertelstunde OHNE
   Rohwert hat KEINE Zeile, `count(*)=count(menge)` war darum auch über einer Lücke „vollständig"
   (Stunde mit 35 min Lücke: 40,0 statt 96,0 kWh). ⚠ Die ABDECKUNG daneben kommt ebenso aus dem Schritt:
   `erhalten`/`erwartet` aus Zeitraum und Kadenz zur Messzeit (`ViertelstundenTeile.erwartet`, Kadenz-Kette
   je Viertelstunden-Beginn), für jede Wertart — nie `sum(erwartet)` der vorhandenen Zeilen (F8 17:00: 48 %,
   nicht 96 %). Platzhalter-Kanäle: Summe der Kanal-Mengen nur,
   wenn jeder eine hat; Zustand/Kennzeichen/Energie nur bei genau einem Kanal. Das Mittel im groben
   Raster bleibt das bisherige (Befund: Mittel gerundeter Mittel, nicht Teil dieser Nacharbeit).
2. **Energie aus Leistung** steht nur als `herkunft.energieAusLeistung {wert, kennzeichen}` —
   `EnergieAusLeistung` verweigert einen Wert ohne den Satz „aus Leistung integriert …" (wie die
   Prüfregel `messreihe_energie_gekennzeichnet`). Nie Kurvenwert, nie im Export.
3. **Überlauf.** `counter_overflow` („Zähler übergelaufen") ist Marke; ⚠ der Bestand schreibt für
   denselben Sprung weiter `counter_reset` — eine Rücksetzung an Komponente + Messkanal + Messzeit
   eines Überlaufs wird NICHT gezeigt, im Bestands-Weg (`SpeicherklasseHistorie.RUECKSETZUNG_OHNE_UEBERLAUF`,
   nur mit Reihe; ohne Reihe ist die Abfrage die alte) wie an der Reihe.

⚠ **Bestandsschutz:** die drei neuen Herkunfts-Felder sind `@JsonInclude(NON_NULL)` — die Antwort
des Rohwert-Wegs und der Export bleiben Zeichen für Zeichen (md5-Karte, aufgenommen auf dem Stand
davor, verglichen mit `Bestandsschutz.abweichungen`). Die Export-Spalten sind unverändert; eine
Tagesmenge steht dort in `value`.
