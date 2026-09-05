# Zusätzliche Messwerte: Desired State bis Timescale (Slices 6–8)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 162).


- **Drei additive v2-Verträge, keine Änderung am Frozen-Pfad.** Die strikten
  Schemas liegen in `docs/contracts/v2/mqtt-measurement-*.schema.json`:
  `measurement-config` und `measurement-config-status` sind retained/QoS1,
  `measurement-samples` QoS1/nicht-retained. Topic-Tenant/Site/Device müssen
  bytegleich zum Payload sein. Die existierenden `edge/telemetry`- und übrigen
  Frozen-Contracts bleiben unberührt; ältere Edges abonnieren das neue Topic
  nicht und ignorieren es damit sicher.
- **Der Edge aktiviert immer einen vollständigen Plan atomar.** Der Core prüft
  Identität + monotone Revision, persistiert die gewünschte Konfiguration per
  Rename und bridgt sie auf `edge/measurements/config`. Der Layer-1-Planer unter
  `edge-app/nodered/measurements` ist im ausgelieferten Flow durch
  `vp-measurements` instanziiert und tauscht Active-Plan+Due-Map nur bei komplett
  erfolgreicher Prüfung. Wildcards werden vor dem Planen zu konkreten Punkten
  expandiert (SunSpec 160 anhand Live-Discovery, JSON/OCPP anhand Payload bzw.
  Capability); Custom-Definitionen bleiben im Desired State erhalten. Der
  Core persistiert gewünschte OCPP-Schlüssel selbst, wendet sie per CSMS an und
  bestätigt erst nach `GetConfiguration`-Readback; nach Core- oder Ladepunkt-
  Reconnect wird derselbe Desired State ohne erneutes Cloud-Publish abgeglichen.
  Planer und bestehende Lese-/Steuerknoten teilen sich den **prozessweiten**
  `shared-bus-arbiter`: Steuerung gewinnt die nächste Lease, neue Polls warten,
  und die Lease bleibt bis nach dem Readback und Socket-Abbau belegt. Objekt-Pläne
  aus Palette-Polls und bereits gerenderte `host:port`-Schlüssel der Controls
  werden dabei zwingend auf DIESELBE Lane normalisiert. Der Planer
  gruppiert Registerblöcke (max. 120 Wörter) und erzwingt D5 bei Apply **und**
  zur Laufzeit: Warnung >120, hart 600 Samples/min, 30 Requests/min, 20% Duty;
  Duty misst monotone echte Bus-Belegungszeit mit konservativer Vorreservierung;
  solange ein Request läuft, zählt `max(Reservierung, monotone Laufzeit)`,
  parallele Ticks werden zu genau einem physischen Poll zusammengeführt. Das
  Produktionsimage MUSS `settings.js`, `measurements/`, `vp-palette/` und
  `deye/` gemeinsam paketieren/reseeden; der Image-Layout-Test darf nie aus dem
  Source-Checkout auf fehlende relative Module ausweichen.
- **Rohdaten-Ehrlichkeit ist eine Invariante.** Ohne erfolgreiche physische/
  Protokoll-Lesung kein Sample; `raw` ist verpflichtend und kommt direkt vom
  Wire/API/OCPP, `decoded` ist optional. Nie zurückrechnen, Einheit raten oder
  bei Fehler eine Nullprobe erfinden. Deye-Ableitungen behalten einen exakten
  Address=Word-Rohvektor; unbekannte Firmware-/Skalenregeln bleiben raw-only.
  SunSpec Model 160 löst `module[i]` aus live entdeckter Base und `N` auf. JSON-
  Integer außerhalb des sicheren JavaScript-Bereichs werden bereits beim HTTP-
  Parsen als exakte Dezimalstrings erhalten (nie zuerst durch `Number` gerundet)
  und bleiben auf Edge, im Ingest-Event und als Writer-`raw_text` bytegenau.
  Dasselbe gilt für OCPP `SampledValue.value`: der Wire-String bleibt `raw`;
  bei Integern außerhalb `Number.isSafeInteger` entfällt `decoded`, damit
  Writer/Rollup nie eine gerundete Ableitung dem exakten Rohwert vorziehen.
  `word_little_byte_big` vertauscht bei allen mehrwortigen Zahlen einschließlich
  float32/float64 die 16-Bit-Wörter (auch für freie Register). Die direkten
  Deye-Maps dekodieren außerdem bitfield64/datetime/time/version/ascii_string.
  Für die 339 direkten Deye-Rule-1/2-Punkte ist die Semantik des gepinnten
  `ha-solarman`-Parsers ausführbar: Register 0 ist das niederwertige Wort;
  Range läuft vor Mask/Bit/Bitmask, Lookup überspringt Offset/Scale/Divide,
  und Validation/Default/Dev/Invalidate-all sowie P3-Modellvarianten bleiben
  quelltreu. Validation-Lookups lesen ihren Referenzpunkt intern mit, ohne ihn
  als ausgewählten Messwert zu veröffentlichen. KOSTAL-Mehrwortwerte nehmen
  entweder `connection.byte_order` oder erkennen über Register 5 (0=little,
  1=big); Auto-Erkennung ist Teil des Pollplans und damit der Lastrechnung.
  KACO-HTTP interpoliert die URL-escaped Seriennummer, hält jeden physischen
  Endpoint in einer eigenen Pollgruppe, dimensioniert dynamische MPPT-Keys und
  wendet die katalogisierte JSON-Skala an; Register/Endpoints werden dabei nie
  erfunden.
- **Replay und Lücken sind explizit.** Der Core-Outbox unter
  `data_dir/measurement-outbox` vergibt monotone Sequenzen, sendet älteste
  zuerst und löscht erst nach QoS1-Bestätigung. Begrenzte Eviction schützt die
  gerade gesendete Envelope; ein vor dem Löschen fsync-persistierter Pending-
  Drop-Zustand macht die Zählung crash-sicher und zählt **Samples**, nicht
  Dateien. Der nächste bestätigte Batch trägt genau die bis dahin bekannten
  `gap`/`dropped_samples`; spätere Drops werden nicht vom älteren ACK gelöscht.
- **Cloud-Datenpfad:** EMQX → Ingest → eigenes `measurements.raw` →
  Timescale-Writer. Der Measurement-Ingest nutzt eine persistente MQTT-Session,
  quittiert QoS1 erst nach bestätigtem Redpanda-Produce und lässt Fehler zur
  Broker-Wiederholung unquittiert. Desired State und letzter Edge-Status werden
  nach Start/Broker-Reconnect erneut abgeglichen. Der Writer setzt RLS-Tenant pro Transaktion, sperrt das
  Device gegen Purge, respektiert No-Backfill/Auswahl-Cutover und speichert
  idempotent in `device_measurement_sample`; konkrete OCPP-/JSON-Wildcard-Keys
  werden gegen ihren ausgewählten Template-Key aufgelöst. Sichere numerische
  JSON-Rohwerte werden als `NUMERIC`, als Dezimalstring transportierte Wide-
  Integer als exakter `raw_text` gespeichert; Retention ist 90 Tage. History-
  API und CSV lesen SQL-`NUMERIC` als `BigDecimal` (nie `getDouble`), damit
  z. B. `9007199254740993` bis zur JSON-/CSV-Ausgabe exakt bleibt. Die
  RLS-Hypertables `device_measurement_rollup_5m/_15m` werden per Timescale-Job
  über die vollen 90 Replay-Tage nur aus `quality='good'` semantikabhängig
  gepflegt (Gauge min/max/avg, Counter positive Deltas + Reset,
  State/Error/Bitfield/Text als On-Change-Ereignisse einschließlich Recovery).
  V20260850000000 trennt historische Sample/Event-FKs vom veränderlichen
  `device.site_id`; bei einem Geräteumzug bleiben Raw/Event/Rollup am damaligen
  Standort, und Counter-`lag` beginnt je `(tenant,site,device,point)` neu, damit
  die erste Zielmessung kein Delta vom Quellstandort erbt. V48/V49 bleiben als
  bereits preview-fähige Migrationen checksum-immutabel.
  Der Katalog fürs
  Edge und die Metadatenmigration sind generiert; prüfen mit
  `catalog/measurement-points/tools/package_edge_runtime.py --check`.
- **mTLS/ACL ist trotz v2-Wildcard richtungsgebunden.** Vor den breiten,
  device-eigenen `v2/#`-Grants stehen First-Match-Denies: Ein Device darf
  `measurement-config` nur lesen und `measurement-config-status`/
  `measurement-samples` nur schreiben. CN/Username bindet alles an genau dieses
  Device. Jede Änderung muss weiter durch `tools/pki/test-acl-grants.sh`.

