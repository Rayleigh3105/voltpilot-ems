# UEMS-Rechte-Matrix: die Nachträge aus AP-04, AP-05, AP-06 und AP-07

Neu angelegt am 11.09.2026 (Nacharbeit zu AP-03 IP-1). AP-03 wurde VOR AP-04 … AP-07 konzipiert;
deren Rechte-Abschnitte hat der Captain mit dem jeweiligen Paket abgenommen (AP-04 §6.7, AP-06 §4.8,
AP-07 §4.10; AP-05 hat keinen eigenen Abschnitt, nur die Zeile „Rechte (AP-03)“ in §6). Die Matrix
[`docs/contracts/v2/rechte-matrix.json`](../../contracts/v2/rechte-matrix.json) trägt sie jetzt —
damit jede UEMS-Route eine Kennung hat, gegen die die spätere Durchsetzung (AP-03 IP-5 ff.) prüft.

## Wie die Matrix jetzt aufgebaut ist

- **Zeile OHNE `nachtrag`** = eine der 48 Zeilen der Konzept-Tabelle AP-03 §4.3. Ihre Tabelle unter
  „Matrix“ in `rechte-matrix.md` ist byte-gleich zum Konzept; `konzept_tabelle.sha256` pinnt das
  (Generator `tools/rechte_matrix.py` bricht ab, `RechteAbleitungVectorsTest` fällt). Wortlaut,
  Herkunft, Zellen, Anmerkung ändert nur ein benannter Widerspruch — die KENNUNG gehört nicht zur
  Konzept-Tabelle.
- **Zeile MIT `nachtrag`** (`"AP-06 §4.8"` …) stammt aus einem Rechte-Abschnitt; `herkunft` beginnt
  mit genau diesem Abschnitt (Pflicht), `wie` = „wie Zeile X“ (dann dieselben Zellen wie X, geprüft).
  Sie steht in `rechte-matrix.md` in einer zweiten Tabelle „Nachträge der später konzipierten Pakete“.
- **`nachtraege`** führt JEDE Handlung der Abschnitte wörtlich auf (`handlung`, `wer`, `recht`) mit
  ihrer Kennung: `neu` (die Zeile entsteht hier) oder `zugeordnet` (eine bestehende Zeile regelt
  sie); Sätze ohne Handlung stehen unter `regeln` mit dem Ort, an dem sie gelten. Beide Zwillings-
  Tests prüfen: jede Kennung existiert, jede neue Zeile hat ihre Handlung und mindestens einen
  `darf`-Fall.

Neue Zeilen: `messstelle.ansehen` (AP-04), `ereignisse.ansehen` (AP-07, wie `messwerte.ansehen`),
`datenquelle.bearbeiten`, `datenquelle.zustaendigkeit`, `datenquelle.ansehen` (AP-06, eigene Gruppe
„Datenquellen und Boxen“). Umbenannt: `messstelle.quelle_binden` → `messstelle.quelle` (AP-04 nennt
die Kennung, W-R8). Keine neuen Zellen-Codes, `RechteAbleitung` Java/TS unverändert.

## Die benannten Widersprüche (rechte-vectors.json)

- **W-R8** Kennung `messstelle.quelle` (AP-04 §6.7) statt `messstelle.quelle_binden`.
- **W-R9** ⚠ `datenquelle.zustaendigkeit` OHNE Energiemanager (AP-06 §4.8 + Bedienablauf §5), obwohl
  der Zeitstrahl §5.1 Ines Kaltenbach den Wechsel eintragen lässt; Box ANMELDEN bleibt
  `geraet.einrichten` (EM U). Captain-Frage — die eine Zelle ist die Stelle zum Umstellen.
- **W-R10** AP-05 „Bogen und Assistent“ nennt keinen Energiemanager → `datenquelle.bearbeiten`
  (AP-06, EM U) + `geraet.einrichten`, keine eigene Zeile.
- **W-R11** Unterstützer „Ansehen“ sieht die Herkunft (`messwerte.ansehen`), exportiert sie nicht
  (`export.standort` bleibt `-`, AP-07 nennt dafür AP-03).

## Die Routen-Kommentare sind geprüft

`services/api/.../uems/RechteKennungenDerRoutenTest` liest JEDEN Controller unter `web/`, dessen
Klassen-Javadoc „UEMS“ nennt (heute Messstelle, KomponenteMesskanal, Geraet, Datenquelle, Standort,
Unternehmen — die Liste `MINDESTENS` bewacht den Sucher): jede Route trägt direkt darüber einen
Kommentar mit „Recht“ und nennt eine Kennung (`{@code x.y}` oder `` `x.y` ``) oder sagt
ausdrücklich „keine eigene Kennung“ (Standort-/Unternehmen-Lesemodell: Sichtbarkeit =
`sichtbareStandorte`) — und jede genannte Kennung steht in der Matrix. Ein bloßes „wie oben“ zählt NICHT (eine dazwischen geschobene Route vererbt sonst still
ihr Recht — so war `GET /standorte/{id}` nach dem Kurzzeichen-Vorschlag an `standort.verwalten`
geraten). Eine neue UEMS-Route: Kommentar nach demselben Muster; ein neuer UEMS-Controller ist
über sein Klassen-Javadoc von selbst dabei.

## Prüfen

```bash
python3 docs/contracts/v2/tools/rechte_matrix.py --check
(cd services/api && ./mvnw test -Dtest='RechteAbleitungVectorsTest,RechteKennungenDerRoutenTest')
(cd frontend/portal && npx vitest run src/rechte.test.ts)
```
