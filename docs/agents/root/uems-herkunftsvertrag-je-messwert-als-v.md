# UEMS-Herkunftsvertrag je Messwert als Vertrag mit Vektoren

Neu angelegt am 11.09.2026 (AP-07 IP-1, das erste Bau-Paket der Messdatenstrecke — der Vertrag,
an dem Datenannahme und Writer später hängen).

- **[`docs/contracts/v2/messwert-herkunft.md`](../../contracts/v2/messwert-herkunft.md)** — der
  Vertrag in Prosa: die 15 Angaben je Wert mit ihrer Herkunft (Box · Datenannahme ·
  Nachschlag der Cloud zur Messzeit · Ableitung), die sechs Prüfungen, die Ereignisse, die
  Widersprüche.
- **[`messwert-herkunft-vectors.json`](../../contracts/v2/messwert-herkunft-vectors.json)** +
  **[`messwert-herkunft.schema.json`](../../contracts/v2/messwert-herkunft.schema.json)** — 20
  Fälle im Referenzunternehmen Ahrenberg, dazu Vokabular und Regel-Zahlen.
- **Java:** `services/api/.../uems/MesswertHerkunft` (reine Ableitung) +
  `MesswertHerkunftVectorsTest` (Schema, Fälle, Regel-Zahlen, Vokabular, und JEDER Fall gegen
  `uems-referenzunternehmen.json`). Der kleine Schema-Läufer ist geteilt:
  `uems/UemsSchemaLaeufer` (auch vom Referenzunternehmen-Test benutzt). Der TS-Zwilling folgt
  mit IP-6.

## ⚠ Noch ruft niemand an

Datenannahme (`services/ingest`) und Writer (`services/timescale-writer`) sind unverändert:
`ON CONFLICT DO NOTHING` auf `(device_id, point_key, time, edge_sequence)`, kein Wert trägt
Komponente, Gerät oder Fassung. IP-5 (Datenannahme), IP-6 (Rohtabelle) und IP-7 (Writer) bauen
gegen diesen Vertrag.

## Die Fakten, die man ohne Nachlesen braucht

1. **Reihe = Kundenbereich + Komponente + Messkanal** (E2). Gerät + Einbau, lesende Box,
   Einstellungs-Fassung, Katalogstand und Sequenz sind Herkunft JE WERT, nie Schlüssel.
2. **Die Reihenfolge der Prüfungen ist die Regel:** Zeit (E13: mehr als 300 s Zukunft
   `clock_ahead`, älter als 90 × 24 h `too_old`, Kanten angenommen) → Sequenz der Box (`sequence_gap` /
   `sequence_reset` / `clock_jump`, Wert bleibt) → Herkunft vollständig (sonst `rejected`) →
   Rolle zur MESSZEIT (E4) → Idempotenz (E3) → Zustellart (nachgeliefert, wenn später als
   `max(300 s, 3 × Kadenz)`; die Verzögerung reist ungeschönt, auch negativ).
3. **Zuständigkeit ZUR MESSZEIT, nicht zur Eingangszeit** (W8): ein Nachzügler nach einer
   Übergabe ist führend, wenn seine Box zur Messzeit zuständig war; ein Wert einer zur Messzeit
   nicht zuständigen Box wird als `spiegel` GESPEICHERT (nie verworfen, nie führend) plus
   `unassigned_reader` höchstens einmal je Stunde je Box und Datenquelle.
4. ⚠ **Der Idempotenz-Schlüssel Reihe + Messzeit gilt JE SPUR** (zuständige Spur bzw.
   Spiegel-Spur der lesenden Box). Nur so halten E3 und E4/A9 zugleich: ein Spiegel mit
   identischer Messzeit ist weder Wiederholung noch Konflikt und verdrängt den führenden Wert
   nie. Für IP-6 heißt das: der Spiegel liegt außerhalb des Unique-Index der zuständigen Spur.
5. **„Gleich“ heißt `raw`, `decoded` und Qualität gleich** (Zahlen nach Betrag); gleicher Wert
   = Wiederholung (nur gezählt, kein Ereignis), abweichender = `duplicate_conflict`, der erste
   bleibt.
6. **Zwei Widersprüche Konzept ⟷ Referenzdatei** stehen im Vertrag §7: der Ausfall Box Halle 2
   am 03.11.2026 (Rückkehr um 17:30 in AP-00/06/07 vs. Box-Tausch in der Zeitachse der Datei)
   und das Übergabeziel von DQ-3 am 10.04.2027 (E-2 im Konzept, E-2′ in der Datei — die Datei
   gewinnt).

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='MesswertHerkunftVectorsTest,UemsReferenzunternehmenVectorsTest')
python3 docs/fachmodell/tools/build_fachmodell.py --check
```

Maven braucht JDK 21 (`JAVA_HOME` auf ein 21er setzen, sonst „release version 21 not
supported“).
