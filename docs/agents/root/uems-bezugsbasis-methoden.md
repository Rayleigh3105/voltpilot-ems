# UEMS-Bezugsbasis-Methoden: der Katalog der vier Bereinigungen (AP-17 IP-5)

Neu am 23.09.2026, E4 = A: vier Methoden — `verhaeltnis` („Verhältnis“), `regression_eine_variable` („Modell mit einer
Einflussgröße“), `regression_zwei_variablen` („Modell mit zwei Einflussgrößen“), `gradtage` („Wetterbereinigung über
Gradtage“) — mit Formel, Anzahl und Rolle der Variablen, Datenbedarf, Mindestumfang, Grenze und Kennzeichen, dazu die
Startwerte aus G6 (12 Monate, ± 10 %, |r| 0,9, 2 %, Wiedervorlage 12). Kein Kundenobjekt, keine Fassung, kein Mandant,
kein Recht; gerechnet wird hier nichts (IP-10, IP-13). Leser des Katalogs ist der Assistent „Bezugsbasis“ (IP-9).

| Stelle | Was |
|---|---|
| `docs/contracts/v2/bezugsbasis-methoden.json` | Vertrag; die Texte sind `methoden.json` des Konzepts wörtlich, ohne die Ahrenberg-Spalte (die steht in der Referenzdatei 1.8) |
| `services/api/src/main/resources/bezugsbasis/…` · `frontend/portal/src/bezugsbasis/…` | byte-gleiche Kopien |
| `bezugsbasis-methoden.schema.json` | Form; `kennung` ist eine geschlossene Aufzählung, `variablen_anzahl` 1–2 (V5) |
| `GET /api/v1/bezugsbasis-methoden` (`BezugsbasisMethodenController`) | die Ressource Byte für Byte (Muster Berichtsvorlagen), keine eigene Kennung; OpenAPI `BezugsbasisMethoden` |

```bash
(cd services/api && ./mvnw test -Dtest='BezugsbasisMethodenControllerTest,RechteKennungenDerRoutenTest,RechtRoutenArchitekturTest')
(cd frontend/portal && npx vitest run src/bezugsbasisMethoden.sync.test.ts src/copy.test.ts)
```

## Die Fallen

- **Alle drei Kopien zusammen ändern** — `BezugsbasisMethodenControllerTest` und `bezugsbasisMethoden.sync.test.ts`
  vergleichen Bytes, nicht JSON; die Route liefert die Datei samt `_comment`.
- **Kennungen und Wörter gehören dem Vertrag `bezugsbasis.md` (IP-2).** Ändert IP-2 eine Kennung, ziehen Schema,
  OpenAPI-`enum`, `VIER` im Java-Test und `copy.test.ts` mit.
- **Kundentext im JSON**: `copy.test.ts` (Block AP-17 IP-4) verlangt jedes Kundenwort in einem §5.8-Satz, „bereinigt um“
  in jedem Kennzeichen und kein Norm-Wort (SP2) in keinem Text — der Datei-Walker sieht keine JSON-Dateien.
- **Startwerte sind keine Norm**: Toleranz und Wiedervorlage ändert der Kunde je Bezugsbasis als Fassung; Mindestlänge,
  Spannweite und Abhängigkeits-Schwelle bleiben Vertrag. Wer einen Startwert ändert, ändert die Rechen-Zwillinge mit.
