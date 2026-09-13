# UEMS-Bezugsgrößen-Routen: anlegen, ändern, archivieren, löschen und das Lesemodell der Werte (AP-09 IP-5)

Neu am 13.09.2026. `POST/GET /api/v1/bezugsgroessen`, `GET/PUT/DELETE …/{id}`,
`POST …/{id}/archivieren`, `GET …/{id}/werte?von&bis&fassungen=` — Controller
`services/api/.../web/BezugsgroesseController.java`, Arbeit `uems/BezugsgroesseService.java`,
Regeln `uems/BezugsgroesseRegeln.java` (rein), Formen `web/dto/BezugsgroesseDto.java`, OpenAPI-Tag
`bezugsgroessen`, Portal-Typen in `api.ts` + Ablehnungen in `frontend/portal/src/bezugsgroesse.ts`.
Migration `V20260913120000__uems_bezugsgroesse_loeschen.sql`. Beweise: `uems/BezugsgroesseApiTest`
(Testcontainers), `uems/UemsBezugsgroesseLoeschenMigrationTest` (Testcontainers, Bestandsschutz),
`uems/BezugsdatenVectorsTest` (Regel `verwalten`), `uems/BezugsgroesseSchnittstelleVertragTest`
(Vertrag ⟷ Java ⟷ OpenAPI ⟷ DTO), `bezugsdaten.test.ts` (Satz der Ablehnungen im Portal).
Unterbau: `uems-bezugsgroessen-tabellen.md`; Vertrag: `docs/contracts/v2/bezugsdaten.md` §7.

## ⚠ Die Fallen

- **M1–M6 und die Ablehnungen stehen im VERTRAG** (`bezugsdaten-vectors.json` → Block `verwalten`),
  nicht im Code: der geschlossene Satz mit Status und Kundensatz, die Prüfreihenfolge je Vorgang,
  die Kennzeichen-Regel, `fest_nach_erstem_wert`, `lesarten`. `BezugsgroesseRegeln.Ablehnung`,
  `BezugsgroesseAbgelehnt.CODES`, der OpenAPI-Enum `BezugsgroesseFehler.code` und `ABLEHNUNGEN` in
  `bezugsgroesse.ts` sind Zeile für Zeile daran gepinnt. Eine neue Ablehnung = Vertrag + beide +
  OpenAPI; der API-Test verlangt JEDEN Code als echte Antwort.
- **Das Vokabular kommt aus `bezugsdaten_vokabular()`** (die EINE Stelle der DB), nicht aus einer
  Java-Liste. **Wählbar** ist ein Eingang: `BezugsgroesseRegeln.GELTUNG_WAEHLBAR` ohne Prozess und
  Kostenstelle — wer ihre Objekte baut, ergänzt sie DORT und in `bezugsgroesse_geltung_objekt_chk`.
- **Die Anfrage wird STRENG gelesen:** unbekanntes Feld (auch camelCase), ein Feld, das kein Text
  ist, eine `geltung_id`, die keine UUID ist → 400 `anfrage_ungueltig` mit `feld`. `PUT` ist die
  GANZE Bezugsgröße mit Kennzeichen; ein unverändertes `PUT` schreibt nichts.
- **Jede Ablehnung schreibt nichts:** geurteilt wird vor der ersten Zeile, im Rennen bildet
  `BezugsgroesseService.schreibe` die DB-Wände (Kennzeichen-Belegung, M1-Fremdschlüssel,
  Lösch-Trigger) auf dieselbe Ablehnung ab. Schreibvorgänge je Kundenbereich nacheinander
  (`pg_advisory_xact_lock`), damit zwei automatische Vergaben nicht dieselbe Nummer sehen.
- **Kennzeichen (M2):** Vergabe = `BZ-` + höchste je belegte Nummer + 1 aus
  `bezugsgroesse_kennzeichen_verlauf` (`BZ-5` zählt wie `BZ-0005`), die eigene darf zurück.
- **Löschen (M6, Befund 3 aus IP-4) ist ENG geöffnet:** DELETE nur auf `bezugsgroesse`, der Trigger
  `bezugsgroesse_nur_ohne_wert_loeschen` lehnt mit einer Wert-Zeile für JEDE Rolle ab (auch eine
  Rücknahme ist eine Fassung); der Verlauf-FK ist `ON DELETE SET NULL (bezugsgroesse_id)` → die
  Belegung bleibt als **Grabstein**. ⚠ SET NULL ist ein UPDATE: der Append-only-Trigger des
  Verlaufs lässt seitdem GENAU diesen Übergang durch (eigene Funktion), sonst weiter „audit rows
  are append-only“. Protokoll-Art `geloescht` (Befund 4: Liste abgeschrieben + ergänzt).
- **Lesemodell:** Stand je Fassung („wirksam bis Fassung 2“) und wirksamer Betrag rechnet
  `BezugsdatenRegeln.fassungen` — AUFGERUFEN. `fassungen=wirksam` (Vorgabe) = je Schlüssel die
  Fassung mit dem wirksamen Betrag samt Herkunft, `alle` = ganze Kette. Nach einer Rücknahme ist
  `wirksamer_betrag` null, nie 0. `von`/`bis` Tage, letzter EINSCHLIESSLICH; ein Stand zählt nach
  seinem Tag in SEINER `zeitzone`. ⚠ **Befund 5 bleibt IP-7:** trägt eine Kette einen Vorschlag,
  eine Ablehnung oder einen Freigeber (oder ersetzt eine Fassung nicht ihre Vorfassung), ist
  `stand_offen` true, `stand`/`wirksamer_betrag` null und alle Fassungen werden gezeigt.
- **Herkunft je Fassung:** `herkunft {art, von_hand, import_kennung, import_zeile, geliefert_text,
  geliefert_einheit}`, `urheber`/`freigeber {name, rolle, art}` (kein Subject), `eingetragen_am`,
  `begruendung`, `ersetzt_fassung`.
- **Rechte:** `bezugsgroesse.verwalten` (Nachtrag AP-09 §4.11 / W8, `U U S - - - -`, darf-Fälle in
  `rechte-vectors.json`) für die Schreibwege, `messwerte.ansehen` fürs Lesen — keine Durchsetzung,
  fremd = 404 `nicht_gefunden`. `ablesung.erfassen` bekommt seine Zeile erst mit IP-8.
- **Nicht gebaut:** Werte schreiben (IP-7 — die Tests schreiben Fassungen direkt in die Tabelle),
  keine Art-Spalte (Vokabular seit 13.09.2026 im Block `arten`, noch ohne Spalte), kein Prozess/keine Kostenstelle, kein Import,
  keine Kanalbindung (M5 = IP-17), keine Portal-Fläche.

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='BezugsdatenVectorsTest,BezugsgroesseSchnittstelleVertragTest,RechteKennungenDerRoutenTest')
(cd services/api && ./mvnw test -Dtest='BezugsgroesseApiTest,UemsBezugsgroesseLoeschenMigrationTest')   # Docker
(cd frontend/portal && npx vitest run src/bezugsdaten.test.ts)
```
