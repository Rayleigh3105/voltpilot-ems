# UEMS: Ein Vorzeichen-Kanal speist Bezug UND Abgabe — je Rohwert, nie je Mittelwert (AP-08 IP-7)

Neu angelegt am 13.09.2026. Entscheide AP-08 **E15 = A** und **E12 = A** (11.09.2026), Widerspruch W8.
Migration `V20260913180000__uems_quelle_anteil.sql`.

## ⚠ Der Satz, der das Paket trägt

**Aufgeteilt wird JE ROHWERT, niemals je Mittelwert.** Ein Wirkleistungs-Kanal mit Vorzeichen
(Katalog `import_export`, etwa K-3 · Wirkleistung) speist die Bezug-Messstelle mit `max(0, P)` und die
Abgabe-Messstelle mit `max(0, −P)` — für JEDEN Rohwert, vor jeder Verdichtung. Erst daraus entstehen
Mittel, Min, Max (die Nullen des anderen Anteils zählen mit) und die Energie je Anteil.

Die verworfene Rechnung (E15 Option C): erst mitteln, dann nach Vorzeichen zuordnen. An F19
(12:00–12:04 +38,4 kW, 12:05–12:15 −34,2 kW) ergäbe sie −10,0 kW und damit nur „Abgabe 10,0“. Richtig:
**MS-01 Mittel 12,8 kW · 3,2 kWh, MS-02 Mittel 22,8 kW · 5,7 kWh** — vereinbar mit den Zählerständen.

## Wo was steht

| Frage | Stelle |
|---|---|
| Darf die Bindung? (Regel 7, Ausnahme „Anteil“) | `MessstelleRegeln.passung`/`ANTEIL_RICHTUNGEN` ⟷ `uemsMessstelle.ts`, Vektoren `messstelle-vectors.json` (`anteile`, `anteil_richtungen`, Passung + Bindung) |
| Wie wird geteilt? | `VerbrauchRegeln.anteilJeRohwert`/`momentanwerteAnteil` ⟷ `verbrauch.py`, `verbrauch-vectors.json` `regeln.anteil` + F19 (`anteil`, `quelle`, `gegenprobe`) |
| Welche Periode liest die Bindung? | `uems/QuelleAnteilWerte#periode` (Rohwerte aus `device_measurement_sample`, W → kW mit festem Faktor) — noch ruft niemand an (IP-9 entscheidet) |
| Letzter Wert im Register | `MessstelleBeobachtung.wert`: der Anteil DIESES Rohwerts |
| Gespeichert | `messstelle_quelle.anteil` (NULL = ganzer Wert), Antwort `anteil` an Quelle und Quellenbindung, Protokoll `quelle_gebunden` |

Regel 7 im Einzelnen: ohne Anteil bleibt ein Vorzeichen-Wert 422 `quelle_passt_nicht` Grund `richtung`
(W8, der Satz sagt jetzt, wie er passt); mit Anteil muss das Katalogwort in `anteil_richtungen` stehen
und der Messwert ein Momentanwert sein (sonst Grund `anteil` — neues Wort, additiv), und die Richtung des
Anteils ist die Richtung der Größe (sonst `richtung`). Nur `import_export` ist entschieden;
`charge_discharge` hat keinen Anteil. Ein anderes Anteil-Wort in der Anfrage ist 400.

## Drei Fallen

1. **Das Box-Vorzeichen ist schon im Rohwert** (AP-04 E5). Nirgends wird ein zweites Mal gedreht; kein
   Leseweg liest dafür eine Einstellungs-Fassung. Falsch gesetzt → neue Fassung ab Zeitpunkt, die
   Vergangenheit über eine Korrektur (IP-12 ff.) — nie hier. Beweis: `UemsQuelleAnteilTest`
   (`dasBoxVorzeichenWirktGenauEinmal`).
2. **Kein stiller Saldo** (E12). Bezug und Abgabe bleiben zwei Mengen; „saldiert“ gibt es nur als
   berechnete Messstelle (AP-10). ⚠ Darum zählt eine Bindung MIT Anteil im Viertelstunden-Lauf NICHT
   als `integration` (`ViertelstundeVerdichter.integrationJeAuftrag`, `anteil IS NULL`): die Reihe ist
   der ganze Vorzeichen-Wert, ihre Energie wäre −2,5 kWh.
3. **Die Kennzeichnung reist mit**, Wortlaut UND Stelle: „positiver Anteil von K-3 · Wirkleistung“
   steht vor „aus Leistung integriert …“ (zuerst festgestellt).

## Datenbank

- `kanal_fuehrt_eine_messstelle` gilt JE ANTEIL: Bereich positiv `[1,2)`, negativ `[2,3)`, ganz
  `[1,3)` — MS-01 positiv und MS-02 negativ zugleich, derselbe Anteil nie zweimal, der ganze Wert
  schließt beide aus. Name und 23P01-Neu-Urteil bleiben.
- `anteil` gehört zu „nie überschrieben“ (Trigger abgeschrieben und geweitet).
- Spalten, die ältere Migrationstests über das Repository lesen, kommen über die ZEILE:
  `messstelle.anschlussleistung_kw` via `to_jsonb(messstelle) ->> …` (`MessstelleRepository.anschlussleistung`)
  und nie im INSERT — sonst „column does not exist“ auf Fassungen vor V20260913180000.
  `messstelle_quelle.anteil` steht direkt in den Abfragen: kein Migrationstest liest dieses Repository.

## Bewusst offen (benannt, nicht gebaut)

- **Formel-Term mit `anteil`** (`AnteilLeseweg`, 422 `anteil_wartet_auf_ap08`): bleibt. Der Formel-Verlauf
  liest `device_measurement_rollup_15m.avg_numeric` — ein Anteil daraus wäre je Mittelwert. Einlösen erst,
  wenn der Verlauf je Term aus Rohwerten rechnet (`QuelleAnteilWerte`/`momentanwerteAnteil` aufrufen).
- **Speicherklasse je Anteil**: keine. `messreihe_viertelstunde` bleibt der ganze Wert; der Leseweg reicht
  so weit wie die Rohdaten. IP-9 entscheidet, ob und wie er gespeichert wird.
- **`messreihe_zaehler_deklaration()`** bleibt leer (`uems-zaehlerbrueche.md`); die Referenzdatei nennt den
  Anteil (noch) nicht, MS-02 hat dort keine Nebengröße (Vektor-`annahme`).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='UemsQuelleAnteilTest,MessstelleQuelleApiTest,MessstelleRegelnVectorsTest,VerbrauchVectorsTest')
(cd frontend/portal && npx vitest run src/uemsMessstelle.test.ts)
(cd services/optimization && python -m pytest tests/test_verbrauch.py)
python3 catalog/measurement-points/tools/validate.py --ohne-wertebereich
```
