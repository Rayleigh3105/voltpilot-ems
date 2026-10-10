# UEMS-Ereignis-Vertrag Box → Cloud und das geschlossene Ereignis-Vokabular

Neu angelegt am 11.09.2026 (AP-07 IP-3, Entscheid E11 = A — der Vertrag, an dem Datenannahme
(IP-5), Writer (IP-7), die Ereignis-Tabelle (IP-8) und die Box-Meldungen (IP-18/IP-19) hängen).

- **[`docs/contracts/v2/events-vocabulary.md`](../../contracts/v2/events-vocabulary.md)** — der
  Vertrag in Prosa: zwei Wege, der Umschlag, das Ereignis (Zeitform, Achse, Bezug,
  Fortschreibung), die 23 Arten, die Prüfreihenfolge und Gründe, „Ereignis oder Zustand?“, die
  Widersprüche.
- **[`mqtt-events-2.1.schema.json`](../../contracts/v2/mqtt-events-2.1.schema.json)** (Box → Cloud)
  + **[`events-raw.event.schema.json`](../../contracts/v2/events-raw.event.schema.json)** (Redpanda
  `events.raw`) + **[`events-vocabulary-vectors.json`](../../contracts/v2/events-vocabulary-vectors.json)**
  (Vokabular + 97 Ahrenberg-Fälle) + `events-vocabulary.schema.json`; Beispiele unter
  `examples/mqtt-events-2.1.*` und `examples/events-raw.*`.
- **Java:** `services/api/.../uems/EreignisVokabular` (reine PRÜFUNG) +
  `EreignisVokabularVectorsTest`. **TS:** `frontend/portal/src/uemsEreignis.ts` (der
  KUNDENSATZ). **Ingest:** `services/ingest/.../EventsContractSchemaTest` +
  `ContractSchemaRunner` (Test-Zwilling des `UemsSchemaLaeufer`, plus `maxItems`).

## ⚠ Wer schon anruft (Stand IP-5 + IP-8)

Keine Box sendet Ereignisse (Edge-Release). Die Datenannahme verarbeitet `…/v2/events` und schreibt
ihre eigenen Ablehnungen auf `events.raw` (IP-5, `uems-datenannahme-ereignisse.md`). Die Ereignis-Tabelle `messreihe_ereignis` steht (IP-8, `uems-messreihe-ereignis-tabelle.md`):
der Writer schreibt `device_measurement_event` unverändert weiter und spiegelt jedes Ereignis
davon hinein, sein `EventsRawConsumer` hängt `events.raw` an (geprüft mit dem Writer-Zwilling der
Klasse); die MQTT-Verträge 2.0 sind unverändert.

## Die Fakten, die man ohne Nachlesen braucht

1. **Zwei Wege, ein Datensatz je Ereignis:** Box-Arten (`box_restart`, `device_restart`,
   `frozen_source`, `range_limit`, `layout_changed`, `data_gap` aus Verdrängung) reisen über
   `ems/{t}/{s}/{d}/v2/events` (`schema_version` 2.1, 1…64 je Umschlag, OHNE `box` — die Box ist
   das Topic); alle anderen erzeugt die Cloud selbst. Beide landen als `events.raw` 1.0
   (Schlüssel `{tenant_id}:{site_id}`).
2. **Der Umschlag ist die Einheit:** Fassung → Form → Kennung → jedes Ereignis; das erste
   verworfene verwirft den ganzen Umschlag und hinterlässt ein `rejected` mit Grund.
3. **Fünf Urheber:** `box` · `datenannahme` (Uhr, Fassung, Kennung) · `writer` · `cloud`
   (Herzschlag, Zuständigkeit) · `kunde` (Gerätegrenze). Der Urheber gehört zur Art.
4. **Zeit je Art:** Zeitpunkt oder Zeitraum; halboffen `[von, bis)` (Lücke, Übergabe,
   Viertelstunde) oder geschlossen (erster/letzter Wert); offen (`bis: null`) nur bei `data_gap`
   und `handover` und NIE von einer Box; Achse Messzeit oder Eingangszeit (Sequenz, Zeitfehler,
   Ablehnung).
5. **Append-only:** ein offenes Ereignis wird FORTGESCHRIEBEN (dieselbe `ereignis_id`, nur ein
   leeres fortschreibbares Feld wird gesetzt), nie geändert, nie gelöscht.
6. **Ursache nur mit Fakt:** `box_meldet_sich_nicht` nur an einer Herzschlag-Lücke; eine
   Rücksetzung bleibt „Ursache unbekannt“, bis der Kunde sie als Gerätegrenze bestätigt
   (`bestaetigt_ereignis`). Fehlerklassen je Quelle sind ZUSTAND (IP-13), `layout_changed` ist
   zusätzlich Ereignis.
7. **Konsistenz ist getestet:** jede Art und jeder Grund des Herkunftsvertrags steht im
   Vokabular (mit denselben Feldnamen), die Fehlerklassen sind die von `data-source-vectors.json`,
   die sechs Bestandsarten des Writers heißen gleich, kein Wort in anderer Schreibweise, und
   beide Draht-Schemas sind aus genau dem Vokabular gebaut.
8. **Ein Messwert hat genau eine Schreibweise:** `raw`, `decoded`, `qualitaet` — `decoded: null`,
   wenn der Kanal keinen decodierten Wert liefert (`measurement-samples` 2.1 lässt ihn weg, z. B.
   OCPP). Weggelassen ist `schema_verletzt`, sonst sähe `gleich` zwei gleiche Werte als
   verschieden. Geändert wird so etwas in beiden Java-Zwillingen (api + Writer), dem
   `events-raw`-Schema und den Vektoren zugleich; TS spricht dann den Rohwert.

## Prüfen

```bash
(cd services/api && ./mvnw test -Dtest='EreignisVokabularVectorsTest')
(cd services/timescale-writer && ./mvnw test -Dtest='EreignisVokabularZwillingTest')
(cd services/ingest && ./mvnw test -Dtest='EventsContractSchemaTest')
(cd frontend/portal && npx vitest run src/uemsEreignis.test.ts)
python3 docs/fachmodell/tools/build_fachmodell.py --check
```

Maven braucht JDK 21 (`JAVA_HOME` auf ein 21er setzen, sonst „release version 21 not
supported“).
