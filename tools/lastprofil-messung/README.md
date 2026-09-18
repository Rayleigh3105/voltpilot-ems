# Lastprofil messen (AP-14 IP-8)

`lastprofil_messen.py` erzeugt den NW-5-Messbericht aus zwei Ständen. Es liest
nur die vorhandenen `/metrics`-Endpunkte von API und Writer sowie Zählungen in
einer ausdrücklich `READ ONLY` gesetzten Datenbanktransaktion. Der Bericht
enthält keine Kunden-, Anlagen-, Box- oder Messstellenkennung.

Live auf der vom Betreiber bereitgestellten **Probe-Umgebung**, nie in
Produktion:

```bash
python3 lastprofil_messen.py \
  --api-url https://probe-api.example/metrics \
  --writer-url https://probe-writer.example/metrics \
  --db-url "$VP_PROBE_DB_URL" \
  --tenant <interne-uuid> \
  --intervall-s 900 \
  --profil-minuten 1440 \
  --umgebung probe \
  --commit "$(git rev-parse HEAD)" \
  --output nw-5.md
```

Der Datenbankzugang braucht wegen `FORCE ROW LEVEL SECURITY` `BYPASSRLS`; ein
scheinbar leerer Mandantenstand wäre kein Messergebnis. Fehlende Pflichtmetriken
beenden den Lauf laut mit `FEHLER`. Eine Altersmetrik der Arbeitsliste darf nur
fehlen, wenn ihre vorhandene `…_offen`-Metrik genau 0 sagt.

Für die Tests stehen aufgezeichnete Endpunkt-Antworten unter `fixtures/`:

```bash
python3 -m pytest -q
python3 lastprofil_messen.py --fixtures fixtures \
  --tenant a4e0b000-0000-4000-8000-000000000001 \
  --profil-minuten 15 --umgebung Testcontainers --commit deadbeef
```

## Ehrliche Grenze

`device_measurement_sample.dropped_samples` zählt nur Verluste, welche die Box
selbst meldet. Für die Schwelle „kein Sample verworfen“ verwendet das Werkzeug
darum ausschließlich den Zuwachs von
`voltpilot_writer_verworfene_samples_total` zwischen den beiden Messpunkten.
`voltpilot_writer_verworfen_total{strom="measurements",grund="unlesbar"}` hält
dabei fest, ob die Sample-Zahl eines kaputten Umschlags unbekannt blieb. Fehlt
eine der Metriken an einem Messpunkt (alter Writer), oder trat so ein
unlesbarer Umschlag auf, bleibt die Schwelle laut **NICHT MESSBAR**; eine 0 aus
der Box-Spalte wird nie als 0 Writer-Verwerfungen ausgegeben.

`voltpilot_db_table_bytes` wird täglich gesammelt. Vor einer Abnahme muss der
Betreiber den Sammler vor und nach dem Lauf regulär aktualisieren lassen; das
Werkzeug löst keine Sammlung und keinen Läufer aus. Der Stundenlauf wird durch
das Zurückspringen von
`voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer="endgueltigkeit"}`
beobachtet; das Ergebnis ist eine konservative Obergrenze vom ersten Messpunkt
bis zum Abschluss.
