# Art einer Bezugsgröße

`art` ist ein eigenes Datum: AP-09-Konzept §4.2 M1, §5 Änderung und §6.1;
Vertrag [bezugsdaten.md §8](../../contracts/v2/bezugsdaten.md#8-die-arten-einer-bezugsgröße-42-des-konzepts-nachgetragen-am-13092026).
Produktionsmenge, Gutteile und Sonstige Menge passen alle auf Stück/Periodenwert/Monat/Prozess.
Auch eine Namensauswertung wäre keine belastbare Rekonstruktion.

## Bestand und Schutz

`V20260918110000` ergänzt `art` nullable ohne Default. `bezugsarten()` wird aus dem Vertrag
(Block `arten.je_art`, ohne `konzept`) erzeugt. `UemsBezugsArtMigrationTest` vergleicht den
kompletten Katalog. Der idempotente UPDATE setzt nur genau einen Kandidaten; mehrere/keine
bleiben null. Im Referenzunternehmen bleiben sechs Reihen offen (BZ-1/2/3/5/6/7),
BZ-4 ist die gelesene Strukturfläche. Das ist eine Prüfung der Referenzdatei, keine Zählung
in einer produktiven Kundendatenbank. Interne Flächenzeiger der Kennzahl-API tragen
`bezugsflaeche`; die Struktur bleibt die einzige Quelle ihrer Werte.

Die bestehenden RLS-/FORCE-Regeln gelten für die neue Spalte, die App erhält UPDATE(art).
M1 schützt Art auch nach Stammdatum oder Kanalbindung; unbekannte Alt-Art darf nach dem
ersten Wert ebenfalls nicht nachträglich geraten werden. Die Migration ändert keine Werte,
Fassungen oder freigegebenen Abzüge.

## Wege und Leser

- `BezugsgroesseController` POST/PUT → Service/Repository: Art prüfen, speichern, protokollieren.
  Fehlende/null Art beim PUT erhält den Bestand für alte Clients.
- GET/Liste → `BezugsgroesseDto` → `api.ts` → `bezugsgroesseListe.ts`: gespeicherter Name der Art,
  sonst „Art nicht angegeben“. Keine Änderung von Werten oder Einheiten.
- Zusätzlich zum Dialog bindet `BezugsgroesseService.bezugsflaecheBinden` einen internen
  Flächenzeiger für Kennzahl-Nenner. Dieser Weg setzt die bekannte Art ausdrücklich.
- Kennzahlen (`KennzahlRepository`), Import (`ImportVorschauService`) und Berichtsabzüge
  lesen Identität, Wertart, Einheit, Periode, Geltung bzw. gespeicherte Fassungen. Die eigene
  Art ist kein Rechenparameter und kein neues Feld eines freigegebenen Abzugs.
- Der Repository-Leser nutzt `to_jsonb(b)->>'art'`, damit Migrationstests auf früheren
  Schemaständen die neue optionale Spalte als null lesen können. Schreibwege brauchen den
  aktuellen Stand. Änderungen an `bezugsdaten-vectors.json` verlangen alle Vertragsleser.

Die Pflichtnachweise umfassen die sechs Migrationsnachbarn,
`UemsProduktionsreihenfolgeMigrationTest`, Bezugsgrößen-/Import-Migrationstests,
`BezugsgroesseApiTest`, beide Rechte-Wächter sowie Kennzahl-/Berichtsabnahme.
