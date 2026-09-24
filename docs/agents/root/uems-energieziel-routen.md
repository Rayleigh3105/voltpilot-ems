# UEMS-Energieziel: Routen und Ziel-Stand (AP-18 IP-6, Z1–Z4, RE1/RE2)

Neu am 24.09.2026: `EnergiezielController` → `uems/EnergiezielService`, DTO `web/dto/EnergiezielDto`, Ablehnungen
`uems/VerbesserungAbgelehnt` (`{code, message, …Fakten}`, auch für Maßnahme/Abweichung gedacht). Keine Migration
(Tabellen: [Datenhaltung](uems-verbesserung-datenhaltung.md)), keine Fläche (IP-8). Vertrag:
[`verbesserung.md`](../../contracts/v2/verbesserung.md) §4, OpenAPI `/api/v1/energieziele…`.

| Route | Recht | Was |
|---|---|---|
| `GET /api/v1/energieziele?kennzahl=&zustand=` | `verbesserung.ansehen` (Kommentar) | Register im Zaun (RLS `site_scope`) |
| `POST /api/v1/energieziele` | `@Recht verbesserung.verwalten`, DIENST | Kennzahl mit freigegebener, heute geltender Fassung (sonst 422 `kennzahl_ohne_bezugsbasis`); Zielperiode `JJJJ-MM/JJJJ-MM` ≤ 120 Monate (400 `zielperiode_ungueltig`), Beginn ≥ Monat nach dem Anlegen (400 `zielperiode_rueckwirkend`); überschneidendes offenes Ziel 409 `energieziel_laeuft`; `angelegt_am` = Uhr der Kennzahlen |
| `GET …/{id}` | ansehen | mit `verlauf` (Protokoll) |
| `PUT …/{id}` · `PUT …/{id}/verantwortlicher` · `POST …/{id}/beenden` | verwalten | nur offen (409 `energieziel_nicht_offen`), Begründung 10–500 (422 `begruendung_fehlt`), Zielperiode nur nach hinten; je eine Protokollzeile |
| `GET …/{id}/stand` | ansehen | je Monat die Zeile von `BezugsbasisVergleich.fuerZiel` (zitierte Basis, Fassung am Monatsende), über die ENDGÜLTIGEN Monate `VerbesserungRegeln.zielstand`; Sätze über `VerbesserungRegeln.satz` |

⚠ **Rechnet nichts:** Σ ÷ Σ, x von y, Ausschlüsse und Vorschlag kommen aus `zielstand`; wer hier etwas nachrechnet,
bricht NW-1. ⚠ **Endgültig** heißt `kennzahl_wert.endgueltig_ab` ≤ Abruf — ein Monat ohne Wert oder vor seiner
Endgültigkeit wird nicht übergeben (weder gezählt noch „ausgeschlossen“). ⚠ Die Satzteile der Ausschluss-Gründe außer
`variable_ausserhalb` stehen (noch) nicht im Vertrag, sondern in `EnergiezielService.GRUND`.
Nachweis: `EnergiezielApiTest` (R4 der Referenzdatei 1.9, echte 2028-Daten mit gesetztem `created_at`),
`EnergiezielSchnittstelleVertragTest`, Zeilen in `RechtMatrixApiTest`, `RechtRoutenArchitekturTest.DIENST`.
