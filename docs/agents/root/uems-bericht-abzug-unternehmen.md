# UEMS-Berichts-Abzug des Unternehmens, Kostenstellen und Kennzahlen (AP-12 IP-6)

Neu angelegt am 15.09.2026. Baut auf `uems-bericht-abzug.md` (IP-5) auf. Vertrag `docs/contracts/v2/bericht.md` **1.1**
(additiv: `$defs/abzug` um `standorte` und `kostenstellen`), eine Migration (`V20260915113000`), keine neue Route, keine
Fläche. Die Wegmarke der Routen (IP-7) ist eingelöst (firstmate 003): Anlegen und D4-Neubildung bilden den Abzug des
Unternehmens, die 501 `unternehmensbericht_folgt` ist aus Vokabular, OpenAPI und `api.ts` genommen
(`BerichtApiTest.unternehmensberichtUeberDieRoute_…`).

| Was | Wo |
|---|---|
| Messstellen, Standort-Abschnitte und Kostenstellen des Unternehmens | `uems/BerichtUnternehmen` (aus `BerichtAbzugBildung.zusammentragen`) |
| Kennzahlen-Abschnitt (Standort und Unternehmen) | `uems/BerichtKennzahlen` |
| Kostenstellen-Sicht mit ausdrücklichem Mandanten | `KostenstelleEnergieService.energie(tenant, k, periode, am, zone, jetzt)` (package-private) |
| Abwahl einer Kennzahl (Q4, V3) | Tabelle `bericht_kennzahl_abwahl` — **keine Zeile = gewählt** |
| Tests | `BerichtAbzugUnternehmenTest` (B3, B11, B15) · `BerichtAbzugBildungTest` (B1 mit Kennzahlen, Abwahl, Verfügbarkeit) · `UemsBerichtKennzahlAbwahlMigrationTest` |

```bash
(cd services/api && ./mvnw test -Dtest='BerichtAbzugUnternehmenTest,BerichtAbzugBildungTest,UemsBerichtKennzahlAbwahlMigrationTest')
```

## Was der Abzug des Unternehmens enthält

- **Messstellen (Q3):** je Standort die Hauptzähler Richtung Bezug (die Standort-Summe „Netzbezug“), die Messstellen mit
  dem Unternehmen als Ort (MS-19, `ort_zum_datenstand` = `U`) und die Prozess-Messstellen ohne Ort (MS-20, `null`) — genau
  die unmittelbaren Messstellen der Vektoren B3 (BR-2026-0002).
- **`zusammenfassung`:** nur `netzbezug_kwh` (Vorlage „Netzbezug gesamt“) und die Zählungen.
- **`standorte[]`:** `summen.netzbezug_kwh` (fehlt, sobald ein Zähler keine Zahl hat) und die Kennzeichen der Zähler; ihre
  Werte mit Nachweis stehen in `werte`.
- **`kostenstellen[]`:** je Kostenstelle, die einen Tag des Zeitraums besteht (9000 im Jahr 2026, 9010/9020 erst 2027 —
  B11), die Blöcke der Kostenstellen-Sicht ohne Kennungen und ohne Doppelzählungs-Warnung; je Posten `saetze` (Verteilungs-
  Sätze zum Tag) statt der Tage.
- **Kennzahlen (Q4):** Standort = Standort-, Gebäude-, Bereich- und Messstellen-Kennzahlen des Standorts; Unternehmen =
  Unternehmen, Prozess, Kostenstelle und Messstellen ohne Standort. ⚠ Der Report sagt „Unternehmen: alle“ — gebaut ist, was
  die gemergten Vektoren B3/B4 zitieren (firstmate 001): Standort-Kennzahlen erreichen den Unternehmensbericht nur mittelbar.

## Die Fallen

- **Aufrufen, nicht nachbauen — mit Mandant.** Die Bildung baut `KostenstelleEnergieService` auf DER Verbindung (wie das
  Lesemodell) mit `berechnete = null`: die Warnung vor doppelter Zählung liest nur die Route. Der Weg mit Mandant ruft die
  Repository-Überladungen mit `tenant`; die Route ruft weiter die alten Methoden — Mocks der Vertragstests bleiben gültig.
- **Verfügbarkeit:** `BerichtKennzahlen.da` fragt `to_regclass`; fehlt eine Kennzahl-Tabelle, ist der Abschnitt leer und der
  Abzug entsteht trotzdem; fehlt nur `bericht_kennzahl_abwahl`, sind alle gewählt. Bewiesen durch Umbenennen der Tabellen in
  einer zurückgerollten Transaktion — nicht behauptet.
- **Die gespeicherte Zahl, 10 Stellen.** Der Abschnitt schreibt `kennzahl_wert.wert` ungerundet (`WERT_NACHKOMMASTELLEN`);
  der B1-Vektor hat 4 Stellen — benannte Abweichung im Test, Vergleiche auf 4 Stellen.
- **K14 — Zeit-Perioden** (Jahr aus den eigenen Monaten) haben keine gespeicherten Eingänge: der Nachweis nennt Zähler und
  Nenner der Zeile an den Eingängen der Definitions-Fassung, ohne Version. Eine Kennzahl ohne Zahl fehlt im Abschnitt.
- **Quellen (Q6):** Bezugsgrößen einer Kennzahl des Berichts unmittelbar (so B1 und BR-2026-0003), Kennzahl-Paare und
  Messstellen, die nicht selbst im Bericht stehen, mittelbar — rekursiv bis zur Messreihe; Kostenstellen-Posten mittelbar
  über die Tage mit Anteil. ⚠ B3 gruppiert BZ-1 am Unternehmen mittelbar — benannte Abweichung.
- **R1 für IP-7:** `BerichtRegeln.abweichungen` liest nur `werte` und `kennzahlen` — B4s „2 Abweichungen (4200, KZ-0003)“
  stimmt erst, wenn R1 auch `kostenstellen` vergleicht.
- **Abwahl-Tabelle:** Anwendung SELECT/INSERT/UPDATE(`aufgehoben_am`, genau einmal per Trigger), kein DELETE; Verwaltung
  SELECT/DELETE (Offboarding mit den Berichten); Bericht und Kennzahl OHNE Fremdschlüssel, nur der Mandant mit RESTRICT.
  ⚠ `UemsBerichtMigrationTest.keinBestehenderWegWirdEnger` verbietet jeden Fremdschlüssel von außen auf die acht
  Berichts-Tabellen UND jede Trigger-Funktion `bericht%`/`uems_bericht%` an einer anderen Tabelle — darum heißt die
  Funktion `uems_abwahl_einmal_aufheben`. Eine weitere Migration auf den Berichts-Tabellen gehört in
  `UemsBerichtMigrationTest.BAUEN_DARAUF_AUF`.
- **Bleibt offen:** die Lücken 3–5 aus IP-5 (Speicher-Paar, `speicher_*`, MS-03-Kennzeichen) und Tagesverlauf/Monatswerte —
  Folgepaket `vp-uems-b12-tagesverlauf-speicher`, Vertrag 1.2. Neu benannt: MS-22 (Rest ohne Ort) fehlt im Standort-Bericht
  Lindach, weil Q3 über die Anlage nicht gebaut ist.
