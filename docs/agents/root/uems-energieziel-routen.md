# UEMS-Energieziel: Routen, Ziel-Stand und Bewertung (AP-18 IP-6/IP-7, Z1–Z5, RE1/RE2)

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
| `POST …/{id}/bewerten` · `…/bewertung/beantragen` · `…/bewertung/freigeben` · `…/bewertung/ablehnen` (IP-7, Z4/Z5) | `@Recht verbesserung.abschliessen`, DIENST | nur offen und wenn der letzte Monat der Zielperiode endgültig ist (409 `bewertung_nicht_faellig`); Ergebnis `erreicht · verfehlt · nicht_bewertbar` + Begründung; Kopie = `BerichtRegeln.kanonisch` des Stands in der Form von `energieziele[].bewertung.kopie` der Referenzdatei 1.9 (R10 ergibt deren Prüfsumme byte-gleich), `bewertung.vorschlag` steht daneben; Vier-Augen nach `unternehmen.vieraugen_freigabe` wie die Basis-Fassung (`vieraugen_beantragen`/`vieraugen_aus`, Urheber 422 `vieraugen_urheber`, zweite Person KA/EM); zweite Bewertung 409 `energieziel_nicht_offen` |
| `GET …/{id}/stand` | ansehen | je Monat die Zeile von `BezugsbasisVergleich.fuerZiel` (zitierte Basis, Fassung am Monatsende), über die ENDGÜLTIGEN Monate `VerbesserungRegeln.zielstand`; Sätze über `VerbesserungRegeln.satz` |

⚠ **Frist (F1)** steht in jedem Ziel (`frist`): Operation `frist` mit der Uhr der Kennzahlen; „letzter Monat
endgültig“ liest die Zeile selbst (jüngster `kennzahl_wert` des Monats, `endgueltig_ab` ≤ Abruf) — gespeichert wird nichts.
⚠ **Anstoß Pfad 2 (Z5):** `VorgangAnstoss.anVorgaengen` hängt im Bezugsbasis-Zweig des Struktur-Läufers
(`BezugsbasisAnstoss.lesen`, Zeilen `bezugsbasis_beendet` / `fassung_freigegeben`), gleiche Transaktion und gleiches
Wasserzeichen, seit IP-17 über `VerbesserungNaht` (Schalter `voltpilot.uems.verbesserung.enabled` UND
`…bezugsbasis.enabled`); nur offene Ziele, bei Fassung n nur Ziele mit Fassung < n, deren Zielperiode die
Referenzperiode schneidet. Pfad 1 (`bewertung_korrigiert`) und die Antwort-Route: [Anstoß am Vorgang](uems-vorgang-anstoss.md).
⚠ **Rechnet nichts:** Σ ÷ Σ, x von y, Ausschlüsse und Vorschlag kommen aus `zielstand`; wer hier etwas nachrechnet,
bricht NW-1. ⚠ **Endgültig** heißt `kennzahl_wert.endgueltig_ab` ≤ Abruf — ein Monat ohne Wert oder vor seiner
Endgültigkeit wird nicht übergeben (weder gezählt noch „ausgeschlossen“). ⚠ Die Satzteile der Ausschluss-Gründe außer
`variable_ausserhalb` stehen (noch) nicht im Vertrag, sondern in `EnergiezielService.GRUND`.
Nachweis: `EnergiezielApiTest` (R4 und R10 der Referenzdatei 1.9, Vier-Augen, Läufer-Anstoß),
`EnergiezielSchnittstelleVertragTest`, Zeilen in `RechtMatrixApiTest`, `RechtRoutenArchitekturTest.DIENST`.
