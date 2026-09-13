# UEMS: Zuwachs über eine Lücke — gemessen, benannt, nicht verteilt (AP-08 IP-6)

Neu angelegt am 13.09.2026. Entscheid AP-08 **E2 = A** (11.09.2026). Migration
`V20260913170000__uems_luecken_zuwachs.sql` (nur die Vokabular-Funktion, keine Tabelle, keine Spalte).

## ⚠ Der Satz, der das Paket trägt

Der Zähler hat weitergezählt, während die Werte fehlten. Die Differenz der Stände um die Lücke ist
darum **GEMESSEN** — eine echte, belegte Energiemenge, kein Schätzwert. Was fehlt, ist nur **WANN**
in der Lücke sie anfiel: sie ist **NICHT VERTEILBAR**. Beides gleichzeitig sagen, sonst nichts.

## Drei Regeln (die Rechenregel entscheidet, nie ein Lauf)

1. **Die Viertelstunden der Lücke bekommen nichts** — keine Zeile bzw. „keine Werte“, nie 0 kWh, nie
   ein Anteil.
2. **Genau einmal je Stufe:** der Zuwachs zählt in der Periode, die die Lücke GANZ enthält —
   `VerbrauchRegeln.zaehltZu` ⟷ `verbrauch.zaehlt_zu`: Messzeit davor `> von − Kadenz` (Stand am
   Anfang aus dem Z1-Fenster) UND Messzeit danach `≤ bis`. Eine Periode, die sie nur anschneidet, hat
   „Anfang/Ende nicht gemessen“ und bekommt ihn NICHT (F20: beide Tage 2 208 kWh unvollständig, der
   Zwei-Tage-Zeitraum 4 608 kWh vollständig). Gröbere Perioden, die sie auch enthalten, tragen dieselbe
   Energie über ihre Periodenstände — nie doppelt (Monat Okt + Monat Nov + Zuwachs = Jahr).
3. **Mit Kennzeichen** „Lücke 14:00–17:31: Zuwachs 337.600 gemessen, nicht auf Viertelstunden
   verteilbar“ (`lueckenKennzeichen`, Vertrag nach Text UND Reihenfolge).

`kleinsterZeitraum` nennt den kleinsten Zeitraum der Kette `regeln.luecke_zeitraeume` (Viertelstunde
→ Stunde UTC-Raster, Tag → Monat → Jahr in der Standort-Zeitzone); über den Jahreswechsel **keinen**
(dann nur ein freier Zeitraum). ⚠ Die Viertelstunde steht in der Kette: vier Minuten Loch bei 60 s
Kadenz liegen ganz in einer Viertelstunde, die dann beide Stände hat.

Abnahme: `verbrauch-vectors.json` — `luecken_zuwachs` an JEDER Erwartung von F8, F11, F20, F23
(gezählte Lücke mit Ständen, Zuwachs, Einheit und Kennzeichen; jede andere Lücke der Reihe steht
nicht da) und der Block `luecken_zuordnung` (10 Fälle). Beide Zwillinge per Pfad.

## Die Nutzlast an `data_gap` (Ereignis-Vertrag, additiv)

`zuwachs`, `einheit`, `stand_vor`, `stand_nach` — **nur zusammen**, **nur geschlossen**, **nur an
einer Reihe** (`komponente` + `messkanal`), **nie von der Box** (Drahtschema unverändert);
`zuwachs = stand_nach − stand_vor ≥ 0`; `einheit` ∈ `vokabular.einheit_zuwachs` = Zählerstand-
Einheiten des Größen-Katalogs der Messstellen + `kanal_einheiten` (Wh, kWh, MWh, varh, kvarh, m³) —
kein freier Text. api `EreignisVokabular.EINHEITEN_ZUWACHS` RUFT `MessstelleRegeln` an, der Writer-
Zwilling hält die Liste (gegen die Datei geprüft), TS spricht den Zusatz „· der Zähler hat
weitergezählt: Zuwachs 337,6 kWh — nicht auf Viertelstunden verteilbar“.

**Wer schreibt:** der Lücken-Melder (`LueckenMelder#zuwachs`) beim Schließen einer Reihen-Lücke
und in der Lochsuche. Er rechnet nichts: `VerbrauchRegeln.lueckenZuwachs` entscheidet (Loch über
2 × Kadenz, nicht fallend, keine Gerätegrenze dazwischen), Faktor = `FAKTOR_DER_FASSUNG`. Die Felder
bleiben WEG, wenn die Reihe kein Zählerstand ist, der Katalog-Messkanal keine Einheit aus dem
Vokabular hat, oder der direkte Nachbar des Stands davor nicht der schließende Wert ist (schon ein
nachgelieferter Wert in der Lücke, Abwählen). ⚠ Testkanäle ohne Katalogeintrag (`energy_kwh_*`)
bekommen darum nie einen Zuwachs — `UemsLueckenZuwachsTest` liest einen echten kWh-Zähler.

**Box-Ausfall** war seit AP-07 IP-9 schon erledigt: fällt die Box aus, öffnet der Melder aus der
Kadenz die Lücke der REIHE (und die der Box aus dem Herzschlag). Nur die Reihen-Lücke trägt den
Zuwachs; eine Box hat keinen Zählerstand. Kein neuer Takt, kein zweiter Lücken-Begriff.

⚠ **Append-only:** eine Nachlieferung NACH dem Schließen entfernt die Felder nicht, die Meldung
trägt dann zusätzlich `nachgeliefert_am`. Der Verlaufs-Marker (`SpeicherklasseHistorie.ereignisse`
→ `MeasurementHistoryService.zuwachsSatz`) zeigt den Zuwachs darum nur an einer EINZELNEN Lücke
ohne `nachgeliefert_am`; was danach noch Lücke ist, sagt das Kennzeichen der Periode. Die Meldung ist
die Rechnung zum Nachlesen, nie die Quelle der Menge.

## Abgrenzung

- **Kein Ersatzwert, keine Verteilung** (E7 a–g, IP-13): eine Verteilung auf Viertelstunden gibt es
  nur als manuellen, gekennzeichneten Ersatzwert — nie hier, nie automatisch.
- Keine Korrektur/Versionierung/Kaskade (IP-12 ff.), kein Ergebnis-Zustand als Vertrag (IP-8), kein
  Lese-Modell je Messstelle (IP-9), keine Portal-Fläche (IP-11), keine Rechte-Durchsetzung (AP-03).
- ⚠ Out-of-order: die Migration schreibt `messreihe_ereignis_vokabular()` GANZ neu. Eine spätere
  Migration mit KLEINERER Version, die die Funktion ebenfalls neu schreibt, muss die vier Felder
  mitnehmen — sonst verwirft die Datenbank die Nutzlast (`messreihe_ereignis_nutzlast_chk`).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerbrauchVectorsTest,VerbrauchTeilperiodenTest,EreignisVokabularVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsLueckenZuwachsTest')   # Testcontainers, ~3 min
(cd services/timescale-writer && ./mvnw test -Dtest='EreignisVokabularZwillingTest')
(cd services/optimization && pytest tests/test_verbrauch.py)
(cd frontend/portal && npx vitest run src/uemsEreignis.test.ts)
```

`UemsLueckenZuwachsTest` fährt EINE Zeitachse: Box-Ausfall F8 (Melder öffnet, Schließen scheitert
ohne INSERT-Recht und hinterlässt nichts, der nächste fällige Lauf schließt mit 337,6 kWh, zwei
weitere Läufe schreiben nichts), Verdichtung bis zum Jahr, F20 über die DB, Monatsgrenze (erst das
Jahr), 25-Stunden-Tag, Marker-Zusatz gegen die Vektor-Datei, endgültige Zeilen unberührt,
Mandantenzaun, Fingerabdruck. Maven braucht JDK 21.
