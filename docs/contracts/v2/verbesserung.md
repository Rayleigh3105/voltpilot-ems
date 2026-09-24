# Ziele, Maßnahmen, Abweichungen: Wirkung, Ziel-Stand, Frist (UEMS AP-18)

Stand 24.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap18-fundament` §4.1–4.8, §5.9, §7 R4, R5, R6, R9, R10, R12,
§8 IP-2; Entscheide E1–E7 = A, W1–W15 übernommen (24.09.2026).

Die Abnahme des Captains: **„Eine Maßnahme ist mit Ziel, Verantwortlichem, Messgrundlage und Ergebnis verbunden. Die
Software behauptet keine Ursache, die die Daten nicht tragen.“** — M-2028-0001 (umgesetzt am 22.01.2028) zeigt am
15.11.2028: Februar bis Oktober 2028 **2,4 % weniger** als die Bezugsbasis erwarten lässt, **8 von 12** Monaten, März
nicht bewertbar; der Januar (−3,5 %, besser) liegt vor der Umsetzung und zählt nicht. Ob die Maßnahme das bewirkt hat,
sagt eine Person.

| Datei | Rolle |
|---|---|
| [`verbesserung.schema.json`](./verbesserung.schema.json) | die Form der Vektor-Datei (geschlossen, Dezimaltexte statt Gleitkomma; die Eingänge der Bezugsbasis mit ihren `$defs`) |
| [`verbesserung-vectors.json`](./verbesserung-vectors.json) | 63 Fälle mit Handrechnung (`rechnung`), Startwerte, Vokabulare, die Kundensätze als Schablonen |
| [`bezugsbasis.md`](./bezugsbasis.md) · [`bezugsbasis-vectors.json`](./bezugsbasis-vectors.json) | Δ, Band, Urteil je Monat (`vergleich`) und Σ ÷ Σ (`zeitraum`) — hier aufgerufen, nie nachgebaut |
| [`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) 1.9 | `massnahmen[]`, `energieziele[]`, `kennzahlen_1_9_monate` — die Stände der Datei sind genau das, was die Operationen rechnen |
| `services/api/.../uems/VerbesserungRegeln.java` | der Java-Zwilling (rein) |
| `frontend/portal/src/verbesserung.ts` | der TS-Zwilling (rein; eigene Satz-Schablonen, nicht das Glossar) |
| `services/optimization/voltpilot_optimization/verbesserung.py` | die Python-Referenz — `zeitraum` und `ueberfaellig_seit` aus `k_faelle.py` |

> **Wer anruft:** `zielstand` der Leser `GET /api/v1/energieziele/{id}/stand` (IP-6, `EnergiezielService` über
> `BezugsbasisVergleich.fuerZiel`, nur endgültige Monate), `satz` dessen Kundensätze `energieziel_stand` und
> `energieziel_vorschlag`. Der Leser `GET …/massnahmen/{id}/wirkung` (IP-11) und die Übersicht (Frist, F2) folgen; sie
> rechnen nicht selbst, sondern rufen diese Operationen.

## 1. Vokabulare (geschlossen, in `verbesserung-vectors.json`)

| Gruppe | Schlüssel | Werte |
|---|---|---|
| Z | `energieziel_zustand` · `energieziel_ergebnis` · `zielstand_vorschlag` | `offen · bewertet · beendet` · `erreicht · verfehlt · nicht_bewertbar` · `erreicht · nicht_erreicht` |
| M | `massnahme_zustand` · `massnahme_herkunft` | `geplant · umgesetzt · bewertet · verworfen` · `abweichung · energieziel · einsatz · von_hand` |
| A | `abweichung_zustand` · `abweichung_ergebnis` · `abweichung_eintrag_art` · `auffaelligkeit_zustand` · `auffaelligkeit_antwort` · `anstoss_art` · `anstoss_zustand` · `anstoss_antwort` | `offen · abgeschlossen` · `massnahme · erklaert · keine_abweichung · nicht_bewertbar` · `kommentar · ursache_aussage` · `offen · beantwortet` · `abweichung · zur_kenntnis` · `ausgangslage_korrigiert · bewertung_korrigiert · messgrundlage_beendet · messgrundlage_neu_gefasst` · `offen · beantwortet` · `bleibt · neu_kopiert · neu_bewertet` |
| U | `ursache_beleg` | `keine_messung · mit_beleg` — eine Ursache ist immer die Aussage einer Person (U1–U3); es gibt **kein** Ursachen-Vokabular |
| WK | `wirkung_ergebnis` · `wirkung_grund` | `belegt · nicht_belegt · nicht_messbar` (ohne Stand: „beobachtet — nicht belegt“) · `umsetzungsmonat · basis_nach_umsetzung · unvollstaendig` und die Gründe der Bezugsbasis `basis_fehlt · basis_beendet · zu_wenig_perioden · variable_fehlt · variable_ausserhalb · periode_nicht_zu_ende · keine_werte` |
| F | `frist_art` · `frist_faellig` | `massnahme · abweichung · energieziel` · `ueberfaellig · bewertung_faellig` |

Pflicht-Beiwerte der Konzept-Liste (`massnahme` mit Verweis, `zur_kenntnis`/`bleibt` mit Begründung, `ursache_aussage`
mit Wortlaut, Person, Datum) sind Regeln der Schreibwege (IP-5 ff.), nicht Teil der Wörter.

**Startwerte** (ohne Norm-Herleitung): Nachher-Zeitraum `nachher_monate` 12, höchstens 36 (WK2); Vorgabe der
Abweichungs-Frist 30 Tage (A3). Band und Toleranz sind die der Bezugsbasis (AP-17 U3).

## 2. Welche Monate zählen

Jeder Monat kommt als `{monat, referenzperiode, vergleich}`; `vergleich` ist wörtlich der Eingang der Operation
`vergleich` der Bezugsbasis (die Fassung, die am **letzten Tag des Monats** gilt, P4), `referenzperiode` die dieser
Fassung (`JJJJ-MM/JJJJ-MM`, nur für WK4). Der Aufrufer gibt die **endgültigen** Monate; die Uhr kommt nie aus dem Zwilling.
Ein Monat zählt, wenn `vergleich` ein Urteil trägt (`besser · schlechter · im_rahmen`); sonst steht er in
`nicht_gezaehlt` mit Grund: `nicht_anwendbar` → der Grund der Bezugsbasis, `ohne_urteil` → `unvollstaendig`.

**Summe durch Summe (U5).** Über die zählenden Monate ruft jeder Zwilling die Operation `zeitraum` der Bezugsbasis
(`soll_monate` = Zahl der zählenden) gegen die Fassung des **letzten** zählenden Monats — Σ gemessen ÷ Σ erwartet, Band,
Urteil, Richtung und die Kennzeichen-Liste (G5) kommen von dort. Fehlen Monate, hängt die Operation „x von N Monaten“
an die Kennzeichen (G5 Nr. 8). **Nie ein Mittel der Monats-Δ** — am 15.11.2028 wäre das Mittel −2,3 %, richtig sind
−2,4 %; die Quelltext-Probe in allen drei Tests sucht Mittelwert-Muster (`mittel(`, `average`, `.mean(`, `/ len(`,
`/ x.length`, `.divide(`) und verlangt die Aufrufe `vergleich(` und `zeitraum(`.

Ohne zählenden Monat: `urteil` `nicht_anwendbar`, keine Zahl (`gemessen`, `erwartet`, `delta_prozent` … `null`),
`kennzeichen` leer — ein Satz statt einer Zahl (Invariante 5).

## 3. Operation `wirkung` (WK1–WK4)

Eingang `umgesetzt_am` (Tag), `nachher_monate` (12 … 36, sonst `{"fehler": "nachher_monate"}`), `monate[]`.

- **Nachher-Zeitraum:** `nachher_von` = Monat nach dem Umsetzungsmonat, `nachher_bis` = `nachher_von` + N − 1. Monate
  davor und danach werden übergangen (sie sind keine Nachher-Monate — auch nicht „ausgeschlossen“).
- **Umsetzungsmonat:** wird er übergeben, steht er in `nicht_gezaehlt` mit `umsetzungsmonat` — „Januar 2028:
  Umsetzungsmonat — nicht gezählt“, auch wenn er `besser` war (R6).
- **`basis_nach_umsetzung` (WK4):** endet die Referenzperiode der Fassung eines Nachher-Monats im Umsetzungsmonat oder
  danach, zählt er nicht — die Basis enthielte die Maßnahme. Monatsgenau: das Ende eines Monats liegt genau dann am oder
  nach `umgesetzt_am`, wenn der Monat ≥ Umsetzungsmonat ist.
- **Ausgang:** `nachher_von`, `nachher_bis`, `umsetzungsmonat`, `zeitraum_von`/`zeitraum_bis` (erster/letzter
  übergebene Nachher-Monat), `monate_bewertbar`, `monate_endgueltig`, `monate_soll` (= N), `monate` („x von N“),
  `vorlaeufig` (weniger als N endgültige Nachher-Monate, WK2), `nicht_gezaehlt[]` und die Summe aus §2.

## 4. Operation `zielstand` (Z3, Z4)

Eingang `zielwert_prozent` (Dezimaltext, weniger Energie negativ), `zielperiode` (`JJJJ-MM/JJJJ-MM`; sonst
`zielperiode_format`, rückwärts `zielperiode_reihenfolge`), `monate[]` (außerhalb der Zielperiode übergangen).

- `monate_soll` = Monate der Zielperiode; Summe wie §2; `vollstaendig` = jeder Monat der Periode ist übergeben und zählt.
- **Vorschlag nur bei vollständiger Periode:** `erreicht`, wenn (Σ gemessen − Σ erwartet) · 100 ≤ Zielwert · Σ erwartet
  (exakt, **nie auf den Zielwert gerundet**: −4,96 % zeigt „−5,0“ und ist `nicht_erreicht`), sonst `nicht_erreicht`.
  Bei 11 von 12 ist `vorschlag` `null` — das Ergebnis `erreicht · verfehlt · nicht_bewertbar` setzt eine Person (Z4).

## 5. Operation `frist` (F1)

Eingang `art`, `zustand`, `abruf` (Tag — die Uhr von außen, nie `now()` im Zwilling) und `termin` (Maßnahme, Abweichung)
bzw. `zielperiode` + `letzter_monat_endgueltig` (Energieziel; der Termin ist der letzte Tag der Zielperiode, die
Endgültigkeit — Monatsende + 7 Tage — kennt der Aufrufer).

| Art | offen, solange | `faellig` |
|---|---|---|
| `massnahme` | `geplant` | `ueberfaellig` — „überfällig seit n Tagen“ |
| `abweichung` | `offen` | `ueberfaellig` |
| `energieziel` | `offen` **und** der letzte Monat ist endgültig | `bewertung_faellig` — „Bewertung fällig seit n Tagen“ |

`seit_tagen` = Abruf − Termin in Kalendertagen, **0 am Termintag**; davor, oder nicht offen: `faellig`/`seit_tagen` `null`.
Kein Läufer, kein Zustand „überfällig“, keine Nachricht (F2).

## 6. Kundensätze (§5.9) — Operation `satz`

`saetze` in der Vektor-Datei trägt die 25 Schablonen (`{name}` = Platzhalter); `SAETZE` in allen drei Zwillingen ist
gleich (Test). `satz(schluessel, werte)` füllt jeden Platzhalter genau aus `werte` — fehlt einer:
`wert_fehlt:<name>`, bleibt einer übrig: `wert_uebrig:<name>`, unbekannter Satz: `satz_unbekannt`. Jeder Satz-Vektor
füllt die Schablone mit den Werten des Konzepts und erwartet den Satz aus §5.9 **wörtlich** (vom Report abgelesen).
Die Zahlen stellt der Aufrufer (SP4: Tausender mit Leerzeichen, Prozent eine Stelle, Personen-Zahlen wie Zielwert und
erwartete Wirkung ohne „,0“, Band ohne Null am Ende, Daten `TT.MM.JJJJ`).

## 7. Die Vektoren

Jeder Fall trägt `name`, `regel`, `operation`, `quelle`, `rechnung`, `eingang` und `erwartet`. Je Operation:
`wirkung` 15 · `zielstand` 10 · `frist` 10 · `satz` 28. Pflichtfälle aus §8 IP-2 als eigene Vektoren: „R5 Februar bis
Oktober 2028: 2,4 % weniger, 8 von 12, März ausgeschlossen“, „R6 Januar 2028 Umsetzungsmonat nicht gezählt“, „R10 11 von
12 → kein Vorschlag“. Ränder: alle ausgeschlossen, 0 endgültige Monate, genau 12 von 12, 24 Monate, 11 und 37
abgelehnt, Frist am Termintag = 0, Schaltjahr, ,5-Rundung (−2,45 → −2,5) und „nie auf Band oder Zielwert gerundet“.
Die Fassung BB-0001/2 ist wörtlich die der Bezugsbasis-Vektoren; `BB-9002` (Verhältnis 0,25 kWh/kg), eine Fassung 3
mit den Koeffizienten der Fassung 2 und ein März 2028 innerhalb der Spannweite (300 000 kg / 78 600 kWh) sind
**konstruiert**. `test_verbesserung.py` prüft die Stände der Referenzdatei 1.9 (M-2028-0001 Stand Nr. 1, EZ-2028-0001
Bewertung) gegen die Ausgänge.

## 8. Abweichungen und Grenzen

- **`unvollstaendig` ist ein neuer Grund** in `wirkung_grund`: WK3/Z3 verlangen, dass ein Monat `ohne_urteil` mit
  Grund genannt wird; die Konzept-Liste nannte keinen. Das Wort ist das Kennzeichen „unvollständig“ der Bezugsbasis (G2).
- **Summe gegen die Fassung des letzten zählenden Monats** (P4 wie `zeitraum` der Bezugsbasis): haben die zählenden
  Monate verschiedene Fassungen, rechnet der Zeitraum alle gegen die letzte; die Monatszeilen behalten ihre eigene.
- **Bewertung fällig** zählt ab dem letzten Tag der Zielperiode, erscheint aber erst, wenn der letzte Monat endgültig
  ist (15.01.2029 → 15 Tage). Das Konzept nennt beides (F1, §4.2), nicht die Zählweise.
- Nicht in diesem Vertrag: Prüfsummen der Kopien (Ausgangslage, Stände), Auffälligkeit an der Naht, Anstoß-Pfade,
  Rechte und Zaun — sie gehören zu den Paketen mit Tabelle und Route (IP-5 ff.).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='VerbesserungVectorsTest,BezugsbasisVectorsTest')
(cd frontend/portal && npx vitest run src/uemsVerbesserung.test.ts src/uemsBezugsbasis.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_verbesserung.py tests/test_bezugsbasis.py)
```
