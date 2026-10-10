# Messprotokoll: Kompression der Viertelstundenklasse

Datum: 17.09.2026. Zweck: Messgrundlage für die spätere Entscheidung E7-B;
keine Änderung der entschiedenen RLS-Ablage E7-A.

## Abgrenzung

Der Lauf verwendete ausschließlich synthetische Daten in einer wegwerfbaren,
lokalen Testcontainers-Datenbank. Er lief **nicht** gegen Produktion, einen
geteilten Dev-Stack oder Kundendaten. Das Prüfskript nimmt weder Datenbank-URL
noch Zugangsdaten entgegen. Seine Tabelle `vm_compression_probe` ist eine Kopie
von `messreihe_viertelstunde`, bewusst ohne RLS, weil TimescaleDB 2.17.2 die
Kompression einer FORCE-RLS-Hypertable verweigert.

## Aufbau und Ergebnis

- Image: `timescale/timescaledb:2.17.2-pg16`
- Daten: 12 synthetische Reihen × 90 Tage × 96 Viertelstunden = 103 680 Zeilen
- Chunk: 30 Tage
- Layout: `segmentby = tenant_id, entity_id, messkanal`,
  `orderby = intervall_beginn DESC` — genau
  `messreihe_viertelstunde_kompression_layout()`
- Befehl: `docs/performance/measure-vm-compression.sh`

Zitierte Ausgabe des lokalen Laufs:

```text
VM_COMPRESSION rows=103680 before_bytes=45293568 after_bytes=6643712 factor=6,82
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

Die gemessene Rate beträgt damit 6,82×. Sie liegt unter der Planannahme 8× aus
`k_speicher.py`; E7-B darf daher nicht mit 8× als bereits belegter Rate
gerechnet werden. Das Ergebnis ist eine lokale synthetische Vergleichsmessung,
kein Produktions-Benchmark. Datenverteilung, Textlängen, Chunk-Füllstand und
Indizes können die Rate im echten Bestand verändern.
