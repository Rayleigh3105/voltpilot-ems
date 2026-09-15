# UEMS-Kennzahl-Schreibwege: die Kennzahl wird definierbar (AP-11 IP-5)

Neu am 15.09.2026 — Meilenstein 1 „Kennzahl definierbar“. `KennzahlController` → `KennzahlService` (Schreibwege,
Lesemodell der Definition) und `KennzahlVorschauService`; Rechte `KennzahlRechte` mit der Naht `KennzahlAufrufer`;
Ablehnungen `KennzahlAbgelehnt`; Migration `V20260915020000__uems_kennzahl_loeschen.sql`. Vertrag: `kennzahl.md` §12
„Die Schnittstelle (IP-5)“ + `kennzahl-vectors.json → schnittstelle.ablehnungen`. Tabellen: `uems-kennzahl-tabellen.md`.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/kennzahlen`, `GET …/{id}`, `GET …/{id}/fassungen`, `GET …/{id}/berechnung?am=` | `messwerte.ansehen` (Vertrag) | Lesemodell der Definition; Fassung am Tag über `MessstelleFormelRegeln.fassungAm` |
| `POST /api/v1/kennzahlen` | `kennzahl.*_definieren` nach G1 (durchgesetzt) | Fassung 1 „gilt seit Beginn“, KZ-0001 … nach der höchsten je belegten Nummer |
| `POST …/vorschau` | wie Anlegen | Nur-Lese-Transaktion: Befunde + letzte drei abgeschlossene Perioden |
| `PUT …/{id}` | wie Anlegen | die GANZEN Stammdaten, ohne Fassung (V4) |
| `POST …/{id}/fassungen` | wie Anlegen | Fassung n + 1 ab Tag, Begründung Pflicht, rückwirkend mit Abzeichen (V1) |
| `POST …/{id}/archivieren`, `DELETE …/{id}` | wie Anlegen | V5; Löschen nur ohne Wert und ohne lesende Kennzahl |

```bash
(cd services/api && ./mvnw test -Dtest='KennzahlSchnittstelleVertragTest,RechteKennungenDerRoutenTest,KennzahlVectorsTest')
(cd services/api && ./mvnw test -Dtest='KennzahlApiTest')
(cd services/api && ./mvnw test -Dtest='UemsKennzahlLoeschenMigrationTest,UemsKennzahlMigrationTest')
```

## Die Fallen

- **Regeln aufgerufen, nie nachgebaut.** Rechenform, Einheit, Periode, Kreis, Fassung, G1/G3 kommen aus
  `KennzahlRegeln`; die Prüfreihenfolge steht einmal in `KennzahlService` und gilt auch für die Vorschau: Anfrage
  (400) → Geltungsbereich (422) → Recht (403/404) → Kennzeichen (409) → Berechnung (422).
- **Rechte: nur das Definieren wird durchgesetzt** (`RechteAbleitung.darf`, Muster `KorrekturRechte`). Das
  „403 `rolle_noetig`“ des Reports ist Code `recht_fehlt` mit Fakt `rolle_noetig`, Satz aus `RechteAbleitung.TEXTE`;
  außerhalb des Geltungsbereichs 404 `nicht_gefunden` mit dem Satz der Ableitung. Die Sichtbarkeit R-A1 ∧ R-A6 beim
  LESEN setzt AP-03 IP-11 durch. Bis AP-03 IP-2 ist jeder Kundenbenutzer Kundenadministrator und der Plattform-Admin
  Unterstützer (definiert nie: 403). Tests setzen Personen über `@MockBean KennzahlAufrufer` ein; der
  Standort-Schlüssel der Ableitung ist die Standort-ID.
- **Eingänge über ihr Kennzeichen** (MS-12, BZ-6, KZ-0001), gespeichert als Verweis. `periode_art` ist ein geprüfter
  Wunsch, kein Feld. `faktor` nimmt die Schnittstelle nicht an — die Regel rechnet keinen (400 statt stiller Leerlauf).
  Zweimal dieselbe Kennzahl als Paar ist 400, nicht der eindeutige Index.
- **Protokoll = die drei Wörter des Vertrags**: Anlegen und Fassung n + 1 = `kennzahl_fassung_eingetragen`, Stammdaten
  UND Löschen = `kennzahl_geaendert` (beim Löschen `neu` leer), Archivieren = `kennzahl_archiviert`.
- **Vorschau:** 409/422 und Regel-400 sind Befunde (200), Form-400 und 403/404 HTTP. Werte werden aus den
  Lesemodellen gelesen (`MessstelleWerteService.werte`, `BezugsgroesseService.werte`/`stammdatum`, jüngster
  `kennzahl_wert`); feinere Bezugsgrößen-Perioden zählen nur, wenn JEDE einen wirksamen Betrag hat; eine Woche hat
  noch keine Vorschau-Perioden (IP-12); eine Zusammenfassung sagt „x von y Kennzahlen“.
- **Löschen = `uems_kennzahl_loeschen(uuid)`** (SECURITY DEFINER, Mandant aus `app.tenant_id`); der Verlauf verliert
  nur den Verweis (`ON DELETE SET NULL`, Trigger lässt genau den Grabstein durch) — ein Kennzeichen wird nie
  weitergegeben. ⚠ `UemsKennzahlMigrationTest.BAUEN_DARAUF_AUF`: jede weitere Migration, die auf den
  Kennzahl-Tabellen aufbaut, dort eintragen, sonst bricht dessen späte Ankunft.
- **Ort-Löschvorschau** kennt `hat_kennzahlen` (`OrtRepository.mitKennzahl()`, `ortArchiv.ts`).
- ⚠ **Offen:** eine Bezugsgröße löschen, die eine Kennzahl liest, scheitert am FK `kennzahl_eingang_bezugsgroesse_fk`
  (23503) — `BezugsgroesseService.schreibe` bildet ihn nicht ab (500). Braucht ein Wort in `verwalten.ablehnungen`
  des Bezugsdaten-Vertrags; nicht in IP-5, weil PR 773 denselben Block ändert.
- `groesse_unbekannt` stellt `KennzahlApiTest` nicht nach (der Katalog-CHECK der Messstelle bestimmt die Einheiten);
  jeden anderen Code des geschlossenen Satzes verlangt der Rundgang `jederCodeDesGeschlossenenSatzesKommtVor`.
