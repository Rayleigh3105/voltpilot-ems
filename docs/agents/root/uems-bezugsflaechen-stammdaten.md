# UEMS-Bezugsflächen aus der Ortsstruktur und Bezugs-Stammdaten mit Gültigkeit (AP-09 IP-6)

Neu am 14.09.2026. Der Satz, der dieses Paket definiert: **eine Fläche, die schon in der
Ortsstruktur steht, wird nicht ein zweites Mal als Bezugsgröße gepflegt — sie wird GELESEN.**

- Lesemodell `uems/BezugsflaecheLesemodell` + `web/BezugsflaecheController`:
  `GET /api/v1/bezugsflaechen?periode_art&von&bis` (nur GET, jede Schreibmethode 405) und additiv
  `bezugsflaechen` an `GET /api/v1/bezugsgroessen`.
- Stammdaten, die AP-09 selbst hält (Mitarbeitende, E15): Tabelle `bezugsgroesse_stammdatum`
  (`V20260914151500__uems_bezugsgroesse_stammdatum.sql`), Routen
  `GET/PUT /api/v1/bezugsgroessen/{id}/stammdatum` in `BezugsgroesseController`/`BezugsgroesseService`.
- Regeln (rein): `BezugsdatenRegeln.stammdatum` (Stichtag + S3-Übergänge und -Sätze),
  `.stammdatumEintrag` (S4), `BezugsgroesseRegeln.stammdatum` (Prüfreihenfolge, zwei neue
  Ablehnungen `wert_ungueltig` 400 · `kein_stammdatum` 422). Vertrag: `bezugsdaten-vectors.json`
  (B6 + `stammdatum_saetze` + `verwalten.pruefreihenfolge.stammdatum`), Prosa `bezugsdaten.md`.
- Beweise: `BezugsdatenVectorsTest`, `StammdatumEintragWieFlaecheTest` (S4 ≡ AP-02
  `flaecheEintrag`), `BezugsgroesseSchnittstelleVertragTest`, `BezugsflaecheStammdatumApiTest`,
  `UemsBezugsgroesseStammdatumMigrationTest`, `BezugsgroesseApiTest` (jeder Code als Antwort),
  `bezugsdaten.test.ts`.

## ⚠ Die Fallen

- **Keine Kopie, nirgends.** Die Bezugsfläche hat keine Zeile in einer Bezugsgrößen-Tabelle, keine
  ID und kein BZ-Kennzeichen; `schreibbar` ist `false`, `pflegen` = Satz von `flaeche_aus_struktur`.
  `bezugsgroesse_stammdatum_keine_flaeche_chk` lehnt jede Einheit der Größe `flaeche` ab (über die
  neue Funktion `bezugsdaten_groesse()`, kein zweites Vokabular) — auch an einer m²-Bezugsgröße,
  die es nur an der Anwendung vorbei gibt. Wer eine Fläche ändern will: `PUT /api/v1/orte/{id}/flaeche`.
- **Stichtag = LETZTER Tag der Periode (E17), nie ein Mittel.** Welche Fläche an einem Tag gilt
  (eigene · aus Gebäuden summiert · Ort besteht), sagt AP-02 `OrtsbaumAbleitung.flaecheZeitraum`
  am Baum des Standort-Lesemodells; daraus werden Intervalle für `BezugsdatenRegeln.stammdatum`.
  Das Abzeichen „rückwirkend (n Tage)“ kommt aus `OrtsbaumAbleitung.rueckwirkung` mit dem
  `created_at` der Flächen-Zeile (dafür trägt `FlaecheRepository.Flaeche` seit IP-6 `createdAt`,
  der alte 7-stellige Konstruktor bleibt).
- **S3: ein Übergang GENAU am ersten Tag liegt NICHT in der Periode** (Januar 2027 liest 3 400 m²
  ohne Kennzeichen). Drei Sätze: „geändert am“ · „erst ab … erhoben“ · „nur bis … erhoben“ (dann ist
  der Stichtag `null`). Zahl mit Tausenderpunkt und Komma, ungerundet (`ErgebnisZustand.TAUSENDER`).
- **`null` heißt nicht erhoben, nie 0** — am Stichtag ohne Intervall, und `wert > 0` in der Tabelle.
- **S4 ist byte-genau die Flächen-Mechanik:** laufendes Intervall endet am Vortag, ein Wert am
  Beginntag ist eine Korrektur (aufgehoben, lesbar), derselbe Wert schreibt NICHTS (die Fläche
  antwortet dort `gleiche_flaeche`; die Bezugsgröße folgt ihrem Hausmuster „unverändertes PUT
  schreibt nichts“). Erst beenden/aufheben, dann eintragen.
- **Ein Stammdatum-Wert ist ein Wert (M1/M6):** `werteZahl`/`hat_werte` zählen beide Tabellen;
  `bezugsgroesse_stammdatum_bedeutung_fk` hält Wertart+Einheit fest, die Funktionen
  `bezugsgroesse_nur_ohne_wert_loeschen()` und `bezugsgroesse_identitaet_bleibt()` sind als neue
  Fassung abgeschrieben und ergänzt. Protokoll-Art `stammdatum_eingetragen` mit `gilt_ab` (Tag 00:00)
  und `rueckwirkend`.
- **Zeitzone** einer Bezugsgröße: die ihres Standorts, sonst die des Unternehmens
  (`BezugsgroesseRepository.zeitzone`); einer Bezugsfläche: die des Standorts, an dem der Ort hängt.
- **Rechte:** `messwerte.ansehen` fürs Lesen, `bezugsgroesse.eingeben` für `PUT …/stammdatum` — keine
  Durchsetzung. App-Rolle: SELECT, INSERT spaltenweise (ohne `created_at`), UPDATE nur
  `gueltig_bis, aufgehoben_am`, kein DELETE; Offboarding räumt die Tabelle VOR `bezugsgroesse`.
- **Nicht gebaut:** Wert-Eingabe/Vier-Augen (IP-7), Import (IP-11 ff., eine Fläche in einer Datei
  bleibt `bezug_unbekannt`), Portal-Fläche (IP-9 — `api.ts` hat nur die Typen), Rechte-Durchsetzung.

## Prüfen

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd services/api && ./mvnw test -Dtest='BezugsdatenVectorsTest,StammdatumEintragWieFlaecheTest,BezugsgroesseSchnittstelleVertragTest')
(cd services/api && ./mvnw test -Dtest='BezugsflaecheStammdatumApiTest,UemsBezugsgroesseStammdatumMigrationTest,BezugsgroesseApiTest')  # Docker
(cd frontend/portal && npx vitest run src/bezugsdaten.test.ts)
```
