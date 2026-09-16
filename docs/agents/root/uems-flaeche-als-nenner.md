# UEMS-Fläche als Kennzahl-Nenner: „Netzbezug je m²“ (AP-11 §5.1, Befund aus IP-9)

Neu am 16.09.2026. Schließt die Lücke zwischen dem Kennzahlen-Konzept — „Flächen und Mitarbeitende sind sofort
Bezugsgrößen; **‚Netzbezug je m²' ist die erste anlegbare Kennzahl**" — und dem Bestand, in dem eine Fläche kein
Nenner sein konnte. Baut auf `uems-bezugsflaechen-stammdaten.md` (AP-09 IP-6, E17), `uems-kennzahl-vertrag.md`
(K12) und `uems-kennzahl-ausloeser.md` (AP-11 IP-9) auf.

**Die Sperre bleibt und ist richtig:** die Bezugsfläche steht in der Ortsstruktur (`flaeche_gueltigkeit`, AP-02) und
wird von dort GELESEN; eine zweite Flächen-Tabelle wäre die zweite Wahrheit. Gefehlt hat allein der **Leseweg von
dort in den Kennzahl-Nenner**.

| Teil | Stelle |
|---|---|
| Anfrage | `{"rolle":"nenner","art":"bezugsflaeche","kennzeichen":"G-2"}` — das **Kurzzeichen des Orts**, nicht einer Bezugsgröße; Wort nur in `eingang_art_anfrage` (`KennzahlRegeln.EINGANG_ARTEN_ANFRAGE` ⟷ `uemsKennzahl.ts` `EINGANG_ARTEN_ANFRAGE`), `eingang_art` bleibt bei drei Wörtern |
| Auflösen | `KennzahlService.bezugsflaeche` → `BezugsflaecheLesemodell.ziel(kurzzeichen)` (nur Objekte, die eine Fläche HABEN) → `BezugsgroesseService.bezugsflaecheBinden` |
| Der Zeiger | eine `bezugsgroesse`-Zeile: Name „Bezugsfläche", `wertart=stammdatum`, Einheit m², Geltung = der Ort — **ohne eine einzige Wert-Zeile**. Gespeichert wird der Eingang als `art=bezugsgroesse` → keine neue Spalte in `kennzahl_eingang`/`kennzahl_wert_eingang`, kein neues Wort in der DB |
| Lesen | `BezugsgroesseService.stammdatum` erkennt den Zeiger (`istBezugsflaeche`) und liest `BezugsflaecheLesemodell.stammdatum` — damit sehen Kennzahl-Nenner, Vorschau, Bericht-Abzug und `GET …/{id}/stammdatum` DIESELBE Stelle |
| Auslöser | `KorrekturKaskade` Quelle `FLAECHE`: `ort_aenderung` / `flaeche_geaendert` / `rueckwirkend`, Kennung `ort_flaeche:<Ort-ID>`, Fassung = der wievielte Eintrag; `Betroffen.bezugsgroessen` trägt den Zeiger, von da an der IP-9-Weg |
| Beleg / Meldung | `KennzahlKaskade.flaeche` → „Bezugsfläche G-2 ab 01.01.2027 (eingetragen 15.01.2027)"; `kennzahl_neu_gebildet` mit `ausloeser` `G-2/ab-2027-01-01` |
| Migration | `V20260916130000`: Kennungs-CHECK von `messreihe_kaskade_wirkung` um `ort_flaeche:<UUID>` erweitert, Teilindex auf `ort_aenderung`. Keine neue Tabelle, keine neue Spalte, kein Backfill |
| Kundensatz | `flaeche_aus_struktur` heißt jetzt „Flächen pflegen Sie am Gebäude. Als Nenner einer Kennzahl nehmen Sie die Bezugsfläche des Standorts, Gebäudes oder Bereichs." — Java `BezugsgroesseRegeln`, TS `bezugsgroesse.ts`, `bezugsdaten-vectors.json` |
| Test | `UemsKennzahlFlaecheNennerTest` (Testcontainers): anlegen und rechnen, Stichtag, rückwirkender Auslöser, die Sperre |

## ⚠ Fallen

- **Die Vorschau bindet NIE.** `POST /api/v1/kennzahlen/vorschau` läuft in einer Nur-Lese-Transaktion; `rechnung(…, binden)`
  ist dort `false`, der Eingang hat dann `id == null` und `flaecheObjekt != null` — `KennzahlEingangLeser.stammdatum` liest die
  Ortsstruktur unmittelbar. Ein Test, der nach der Vorschau eine Bezugsgröße erwartet, ist falsch.
- **`OrtsbaumAbleitung.flaecheZeitraum` geht TAG FÜR TAG.** Jedes Lesefenster muss begrenzt sein
  (`BezugsflaecheLesemodell.fenster`: die gefragten Perioden, sonst erste Fläche bis heute). Ein offenes Fenster ist eine
  Endlosschleife, kein Lesemodell.
- **Der Ort muss HEUTE bestehen** (G1, `geltung_unbekannt`), auch wenn die Fläche erst später beginnt: in Tests die
  `ort_zuordnung` früh ansetzen, nicht am Tag der ersten Fläche.
- **Die Fläche-Route ist camelCase** (`PUT /api/v1/orte/{id}/flaeche`: `{"m2":3400,"gueltigAb":"…"}`), die Kennzahl- und
  Bezugsgrößen-Routen sind snake_case. `gueltig_ab` dort ist 400 `anfrage_ungueltig`.
- **Die Berichte bekommen diesen Anlass NICHT von der Kaskade** (`Quelle.anBerichte()`): AP-12 IP-9 liest dieselbe
  `ort_aenderung`-Zeile über den Strukturänderungs-Läufer mit eigenem Wasserzeichen — zweimal anstoßen wäre zwei Revisionen
  für eine Tatsache.
- **Der Anlass entsteht nur, wenn der Ort einen Zeiger hat.** Die Kandidaten-Abfrage prüft das per `EXISTS`; sonst hinge in
  jedem Kundenbereich mit rückwirkender Flächenänderung ein Anlass ohne Wirkung im globalen Takt.
- **Ein neues Wort „Kennzahl" in einem Kundensatz weckt `copy.test.ts`** (`KENNZAHL_BESTAND`) — die Datei mit Grund eintragen.

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='KennzahlVectorsTest,BezugsdatenVectorsTest')
(cd services/api && ./mvnw test -Dtest='UemsKennzahlFlaecheNennerTest')   # Testcontainers
(cd services/api && ./mvnw test -Dtest='BezugsflaecheStammdatumApiTest,BezugsgroesseApiTest,KennzahlApiTest')   # Testcontainers
(cd frontend/portal && npx vitest run src/uemsKennzahl.test.ts src/bezugsdaten.test.ts src/copy.test.ts)
```
