# Ziele, Maßnahmen, Abweichungen: reine Regeln (AP-18 IP-2, NW-1)

Verbindlich: [Verbesserungs-Vertrag](../../contracts/v2/verbesserung.md),
[Vektoren](../../contracts/v2/verbesserung-vectors.json),
[Schema](../../contracts/v2/verbesserung.schema.json). Beispielquelle: Referenzdatei 1.9
(`massnahmen[]`, `energieziele[]`, `kennzahlen_1_9_monate`).

Java `uems/VerbesserungRegeln`, TS `verbesserung.ts`, Python `voltpilot_optimization/verbesserung.py` rechnen jeden
Vektor derselben Datei. Noch ruft niemand an: keine Tabelle, keine Route, keine Fläche.

| Was | Wo |
|---|---|
| Wirkung (WK1–WK4) | `wirkung`: Nachher-Monate ab dem Monat nach `umgesetzt_am` (12 … 36), Umsetzungsmonat „nicht gezählt“, `basis_nach_umsetzung`, „x von N“, `vorlaeufig` |
| Ziel-Stand (Z3/Z4) | `zielstand`: Σ ÷ Σ über die Zielperiode, Vorschlag `erreicht · nicht_erreicht` nur bei vollständiger Periode, exakt gegen den Zielwert |
| Frist (F1) | `frist`: „überfällig seit n Tagen“ / „Bewertung fällig seit n Tagen“, 0 am Termintag, Uhr als Eingang `abruf` |
| Kundensätze (§5.9) | `SAETZE` + `satz`: 25 Schablonen, jeder Satz-Vektor erwartet den Report-Satz wörtlich |
| Tests | `VerbesserungVectorsTest` · `uemsVerbesserung.test.ts` · `services/optimization/tests/test_verbesserung.py` |

## Die Fallen

- **Δ, Band, Urteil und Σ ÷ Σ nie nachbauen.** Jeder Zwilling ruft `vergleich` und `zeitraum` der Bezugsbasis
  (`BezugsbasisRegeln`, `bezugsbasis.ts`, `bezugsbasis.py`); die Quelltext-Probe in allen drei Tests bricht bei einem
  Mittelwert-Muster (`/ len(`, `/ x.length`, `.divide(`, `mittel(`) und verlangt beide Aufrufe. Wer eine Bezugsbasis-
  Regel ändert, fährt auch diese Vektoren.
- **Monate vor dem Umsetzungsmonat sind keine Ausschlüsse**, sie werden übergangen; nur der Umsetzungsmonat selbst steht
  mit Grund in `nicht_gezaehlt` (R6: Januar 2028 −3,5 % „besser“ ist keine Wirkung).
- **`ohne_urteil` zählt nicht** (Grund `unvollstaendig`, neu gegenüber der Konzept-Liste) — anders als `zeitraum` der
  Bezugsbasis, der unvollständige Monate mitrechnet und das Urteil wegnimmt.
- **Die Kundensätze sind eigene Schablonen** in `verbesserung.ts`, nicht die Kundenwort-Konstanten des Glossars (IP-4).
- **Stände der Referenzdatei = Ausgänge:** `test_verbesserung.py` vergleicht M-2028-0001 Stand Nr. 1 und EZ-2028-0001
  Bewertung mit den Vektoren. Wer 1.9 ändert, fährt alle drei Zwillinge.

```bash
(cd services/api && ./mvnw test -Dtest='VerbesserungVectorsTest,BezugsbasisVectorsTest')
(cd frontend/portal && npx vitest run src/uemsVerbesserung.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_verbesserung.py tests/test_bezugsbasis.py)
```
