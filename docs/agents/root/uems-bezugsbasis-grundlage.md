# UEMS-Bezugsbasis: Grundlage einfrieren und Verhältnis (AP-17 IP-7, F3/M1/P1–P3)

Neu am 23.09.2026: Routen `POST /api/v1/kennzahlen/{id}/bezugsbasen`, `GET …/{bid}`, `POST …/{bid}/fassungen`,
`GET …/{bid}/fassungen/{n}`. Vertrag: `docs/contracts/v2/bezugsbasis.md` §13. Freigabe/Ablehnung/Beenden folgen mit IP-8,
Faktoren mit IP-16, die Fläche mit IP-9. Modelle (IP-10) bildet dieselbe Route: `regression_eine_variable`,
`regression_zwei_variablen`, `gradtage` — gerechnet nur in `BezugsbasisRegeln.modell`.

| Stelle | Was |
|---|---|
| `BezugsbasisGrundlage` | liest je Monat die AKTUELLE `kennzahl_wert`-Zeile (`KennzahlWerteService.waehle`) und ihre Eingänge, baut den kanonischen Text (Schlüssel sortiert, Zahlen ohne Nullen am Ende) und `sha256:`; Datenlage `monate` · `angeschnitten` („ab TT.MM.JJJJ“ im Kennzeichen) · `vorlaeufige_werte` |
| `BezugsbasisService` | B1 (409 `bezugsbasis_laeuft`), B2 (422 `kennzahl_ohne_bezugsbasis`), P1/P3 über `BezugsbasisRegeln.referenzperiode` mit dem laufenden Monat der Kennzahl-Zeitzone, M1 über `BezugsbasisRegeln.basiswert`; ein offener Entwurf wird neu gebildet (gleiche Nummer) |
| `KennzahlService.fuerBezugsbasis` | Sichtbarkeit (404) und `bezugsbasis.verwalten` an der Geltung der Kennzahl (403) — die DIENST-Stelle für `RechtRoutenArchitekturTest` |
| `BezugsgroesseService.loeschen` | 409 `bezugsgroesse_in_verwendung` mit `bezugsbasen` statt FK-Fehler |

⚠ **Byte-gleich:** die Antwort bettet die gespeicherte Grundlage roh ein (`@JsonRawValue`); wer sie als `JsonNode` parst,
liest Zahlen mit `USE_BIG_DECIMAL_FOR_FLOATS`, sonst verliert der ungerundete Kennzahl-Wert Stellen.
⚠ **`freigabe_status` des Entwurfs ist `entwurf`** (Tabelle IP-6); `beantragt` gibt es nur bei Vier-Augen mit Freigabe-Person (IP-8).
⚠ **Uhr:** die Tests stellen `KennzahlService.uhrStellen` — derselbe Takt gilt für „laufender Monat“ der Referenzperiode.
⚠ **Modell-Monat mit Nenner 0** (`nenner_null`, null Gradtage) hat keine Kennzahl-Version, zählt fürs Modell aber als Paar;
G4 ist beim Bilden **keine 422** — die zweite Variable fällt weg, `variable_abgelehnt` ins Protokoll (Vertrag §3, Vektor R9/G4).
⚠ **NW-1:** `BezugsbasisQuelltextTest` verbietet `.divide(`/Mittel in Dienst, Grundlage, Route und Mittel außer über `xs`/`ys` in den Zwillingen.
Nachweis: `BezugsbasisApiTest` (Docker), `BezugsbasisGrundlageTest` (Referenzdatei-Prüfsummen, OpenAPI).
