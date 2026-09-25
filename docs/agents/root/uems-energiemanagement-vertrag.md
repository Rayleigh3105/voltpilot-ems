# Energiemanagement: reine Regeln (AP-19 IP-2, NW-1)

Verbindlich: [Energiemanagement-Vertrag](../../contracts/v2/energiemanagement.md),
[Vektoren](../../contracts/v2/energiemanagement-vectors.json),
[Schema](../../contracts/v2/energiemanagement.schema.json). Beispielquelle: Referenzdatei 1.10
(`dokumente[]`, `audits[]`, `feststellungen[]`, `managementbewertungen[]`, `energiemanagement.einstellung`).

Java `uems/EnergiemanagementRegeln`, TS `energiemanagement.ts`, Python `voltpilot_optimization/energiemanagement.py`
rechnen jeden Vektor derselben Datei. Noch ruft niemand an: keine Tabelle, keine Route, keine Fläche.

| Was | Wo |
|---|---|
| Fristen (DK5, IA4, MG7, FS1) | `ueberpruefung`: Dokument (gültige Fassung, jüngere von Freigabe und „geprüft, bleibt“ + Monate), Audit und Managementbewertung (letzter Tag + Rhythmus), Feststellung (Frist oder + 90 Tage, nur offen); `tage` und „seit n Tagen fällig“ gegen den Eingang `abruf` |
| Wiedervorlage (WV1–WV3) | `wiedervorlage`: fertige Fristen je Zeile, fällig/Vorschau 30 Tage, sortiert nach Tag und Kennzeichen; Aufrufer seit IP-21 der Leser `GET …/wiedervorlage` ([Wiedervorlage](uems-energiemanagement-wiedervorlage.md)) |
| Vergleich (DK7) | `anwendungsbereich_vergleich`: Standorte und Träger in beiden Richtungen, `deckungsgleich` |
| Verzeichnis-Zeile (VZ2, G1) | `verzeichnis_zeile`: Gruppen-Wort, Ort als Wort mit Ablage |
| Prüfsumme | `pruefsumme`: kanonische Form von `bericht.md` A1 (Java `BerichtRegeln.kanonisch`, TS `uemsBericht.kanonisch`) |
| Wörter für CHECKs (IP-5) | `vokabulare`, `dokument_art_klasse`, `leitungs_pflicht`, `kennzeichen_muster`, `startwerte` |
| Kundensätze (§5.8) | `SAETZE` + `satz`: 40 Schablonen, jeder Satz-Vektor erwartet den Report-Satz wörtlich |
| Tests | `EnergiemanagementVectorsTest` · `uemsEnergiemanagement.test.ts` · `services/optimization/tests/test_energiemanagement.py` |

## Die Fallen

- **Die Zahlform der Prüfsumme ist A1, nicht `json.dumps`.** Der Konzept-Katalog schrieb `-5.0` und bekam für
  BR-2029-0001 `sha256:7db218a7…`; gültig ist `sha256:0a52c97d…` (`-5`). Wer eine AP-19-Kopie hasht, ruft
  `BerichtRegeln.kanonisch` — nie ein eigenes `ObjectMapper.writeValueAsString`, nie `jsonb` (A7).
- **Keine Uhr in der Regel.** Jede Frist rechnet gegen `abruf`; die Quelltext-Probe in allen drei Tests bricht bei
  `.now(`, `Clock`, `date.today`, `Date.now`. Die Route gibt den Tag hinein.
- **Die Wiedervorlage rechnet keine fremde Frist nach (WV2).** Bezugsbasis (AP-17 F5), Bewertung (AP-16 S5) und die
  AP-18-Fristen kommen fertig als Zeile; `ueberpruefung` lehnt eine fremde Art ab.
- **„0 Tage“ ist fällig** („heute fällig“), genau 30 Tage sind Vorschau, 31 nicht.
- **Die §4.2-Wörter stehen wörtlich** in `vokabulare`; Zusätze wie „weiterer (mit Wortlaut)“ sind Pflichten des
  Schreibwegs, nicht Teil des Worts. `energiemanagement.ts` fällt unter das Namensmuster des Sprach-Wächters
  (`copy.test.ts`, Block „Energiemanagement“): keine Norm-Wörter in seinen Zeichenketten.
- **Stände der Referenzdatei = Ausgänge:** `test_energiemanagement.py` vergleicht die Wiedervorlage und die Überprüfungen im
  Stand BR-2029-0001 Nr. 1 mit den Vektoren. Wer 1.10 ändert, fährt alle drei Zwillinge.

```bash
(cd services/api && ./mvnw test -Dtest='EnergiemanagementVectorsTest')
(cd frontend/portal && npx vitest run src/uemsEnergiemanagement.test.ts src/copy.test.ts)
(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_energiemanagement.py)
```
