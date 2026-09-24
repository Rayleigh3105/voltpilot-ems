# UEMS: Anstoß am Vorgang (AP-18 IP-17, M5, Z5)

Ein Vermerk an einer Maßnahme oder einem Energieziel, dessen Kopie nicht mehr stimmt — die Kopie bleibt byte-gleich,
eine Person antwortet. Tabelle `vorgang_anstoss` (IP-9: Maßnahme XOR Ziel, eindeutig je Vorgang × Art × Anlass,
Antwort einmalig per Trigger). Keine Migration: die Admin-Rolle hat SELECT und seit `V20260925001000` INSERT auf
`vorgang_anstoss`, `massnahme_aenderung`, `energieziel_aenderung`; kein UPDATE — darum nie `FOR UPDATE` im Läufer oder
in der Kaskade, Idempotenz nur über `ON CONFLICT`.

## Setzen: `uems/VorgangAnstoss`, nur über `VerbesserungNaht`

| Pfad | Wo | Was |
|---|---|---|
| 1 `nachKorrektur` | `KennzahlKaskade` direkt NACH `bezugsbasis.nachKorrektur` (dieselbe Verbindung, Anlass = `BezugsbasisAnstoss.kennung`, z. B. `K-2028-0001`) | je Kennzahl-Monat Version n + 1: Maßnahme, deren `ausgangslage.vergleich[].bereinigt.gemessen.version` älter ist → `ausgangslage_korrigiert`; Maßnahme mit bewertetem/beantragtem Stand, dessen `wirkung.monate[].version` älter ist → `bewertung_korrigiert` (alle Stände in einem Anstoß, `neu.staende`); BEWERTETES Ziel, dessen Zielperiode den Monat enthält → `bewertung_korrigiert` |
| 2 `anVorgaengen` | `BezugsbasisAnstoss.lesen`, Zweig `bezugsbasis_aenderung`, vor dem Wasserzeichen | `bezugsbasis_beendet` → `messgrundlage_beendet` an offenen Zielen und nicht verworfenen Maßnahmen; `fassung_freigegeben` n → `messgrundlage_neu_gefasst` an offenen Zielen (Fassung < n, Zielperiode schneidet die Referenzperiode) und an umgesetzten/bewerteten Maßnahmen (Fassung < n, Referenzperiode endet im Umsetzungsmonat oder danach = Regel `basis_nach_umsetzung`) |

⚠ **Schalter** `voltpilot.uems.verbesserung.enabled` gilt für beide Pfade und seit IP-17 auch für den Ziel-Zweig aus
IP-7 (vorher nur `…bezugsbasis.enabled`). Aus → kein Anstoß, der Läufer setzt das Wasserzeichen trotzdem, nichts wird
nachgeholt. Ohne `VerbesserungNaht` im Kontext (Minimal-Tests: `BezugsbasisAnstoss.mitSchalter(true)`) stößt der Läufer
keinen Vorgang an — `anstoss.verbesserung(naht)` setzen. `UemsVerbesserungFlagArchitekturTest` hält Reihenfolge und
„niemand an der Naht vorbei“ fest.
⚠ **Die Ziel-Kopie hat keine Monatsversionen** (Σ ÷ Σ): jede neue Version eines Monats der Zielperiode nach der
Bewertung trifft sie. ⚠ Beendete Vorgänge (verworfene Maßnahme, beendetes Ziel) werden nicht angestoßen; ein offener
Anstoß an einem später verworfenen Vorgang bleibt beantwortbar (nur `bleibt`, `neu_kopiert` 409 `massnahme_endgueltig`).

## Antworten: `uems/VorgangAntwort`

`POST /api/v1/massnahmen/{id}/anstoesse/{aid}/antwort` und `POST /api/v1/energieziele/{id}/anstoesse/{aid}/antwort`,
`@Recht({verwalten, abschliessen}, DIENST)`; im Dienst `verwalten` für `bleibt`/`neu_kopiert`, `abschliessen` für
`neu_bewertet`. Eine Transaktion: Anstoß `FOR UPDATE` (App-Rolle), Folge, `UPDATE vorgang_anstoss`, Protokoll
`anstoss_beantwortet`.

| Art | Maßnahme | Ziel |
|---|---|---|
| `ausgangslage_korrigiert` | `bleibt`, `neu_kopiert` | — (CHECK) |
| `bewertung_korrigiert` | `bleibt`, `neu_bewertet` | nur `bleibt` (Z5: nie zurückgenommen — sonst 422 `antwort_passt_nicht`) |
| `messgrundlage_beendet`, `…_neu_gefasst` | `bleibt`, `neu_bewertet` | `bleibt`, `neu_bewertet` (offenes Ziel) |

`neu_kopiert` = `MassnahmeService.ausgangslageNeu` (dieselbe Kennzahl, Fassung, Monate wie die alte Kopie; alte Kopie
+ Prüfsumme in `alt` der Protokollzeile). `neu_bewertet` ruft `MassnahmeBewertung.bewerten`/`beantragen` bzw.
`EnergiezielService.bewerten`/`beantragen` nach `vierAugen` — keine zweite Bewertungslogik; deren 409/422 kommen
unverändert durch. Fehler: 400 `anfrage_ungueltig` (Wort), 422 `begruendung_fehlt` (bei `bleibt` Pflicht, sonst
wahlfrei 10–500), 422 `antwort_passt_nicht`, 409 `anstoss_beantwortet`, 404 Anstoß eines anderen Vorgangs.

Nachweis: `VorgangAnstossApiTest` (R12 bleibt/neu_kopiert, Stand + Ziel, Pfad 2 beendet/neu gefasst, Schalter aus),
`MassnahmeSchnittstelleVertragTest` (`MassnahmeAnstoss`), `EnergiezielApiTest` (Ziel-Zweig über die Naht).
⚠ Nicht gebaut: die Antwort-Knöpfe (IP-20); Pfad 1 an Bezugsgrößen-Werten in `bedingung[]` der Kopie (nur der
Kennzahl-Monat zählt, R12 Schritt 1).
