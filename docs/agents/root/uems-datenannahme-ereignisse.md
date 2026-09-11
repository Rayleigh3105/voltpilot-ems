# UEMS: Datenannahme — Messzeit-Plausibilität, je Wert verwerfen, Sequenz, Ereignisse auf `events.raw`

Neu angelegt am 11.09.2026 (AP-07 IP-5; Entscheid E13 = A, Abnahmefall A13). Vertrag:
[`events-vocabulary.md`](../../contracts/v2/events-vocabulary.md) §7 „Was die Datenannahme
schreibt“; Betrieb und Topic-Tabelle: [`services/ingest/README.md`](../../../services/ingest/README.md).

- **Die Einheit.** Fassung, Form und Kennung des Umschlags verwerfen ihn ganz
  (`UmschlagAbgewiesen` mit `Grund`); auf `telemetry`/`measurement-samples` ist der WERT die
  Einheit für Inhalt und Messzeit (Sample bzw. EIN Kanal einer Kern-Komponente) — der Rest geht
  weiter. Auf `events` bleibt der Umschlag die Einheit (Vertrag §2). Die Validatoren liefern eine
  `Annahme` (weitergereicht + gebündelte `Ablehnungen`), die Handler schreiben beides.
- **E13 in `Messzeitregel`** (`voltpilot.datenannahme` in `application.yml`, bewusst ohne
  Env-Platzhalter: Vertragswerte, kein Stellrad): > 300 s nach Eingang `clock_ahead`, > 90 Tage
  davor `too_old`, genau auf der Grenze angenommen, ganze Sekunden wie `MesswertHerkunft`. Ist die
  Messzeit des UMSCHLAGS unplausibel, geht die Uhr der Box falsch → kein Wert angenommen.
  `MesszeitregelTest` hält E13 = yml = beide Vektor-Dateien und rechnet die Herkunfts-Fälle nach.
- **Bündelung:** ein Ereignis je Umschlag, Art und Grund, `anzahl` = nicht weitergereichte Werte,
  Sekunden = größte Abweichung. Urheber `datenannahme` trägt KEINE Umschlag-Felder; `box` ist die
  `device_id` aus dem TOPIC (UUID, kein Kennzeichen — die Datenannahme kennt keins), `strom` das
  Blatt, `sequenz` nur wenn lesbar. `ereignis_id` = Namens-UUID aus Topic + Umschlag-Bytes + Art +
  Grund → eine QoS-1-Wiederholung trägt dieselbe (IP-8 erkennt sie).
- **Sequenz:** Kern `seq` reist unverändert in `telemetry-v2.raw` (fehlt, wenn die Box keins
  sendet; ungültig → Umschlag `schema_verletzt`); `sequence` stand schon in `measurements.raw`.
  Der Writer überliest `seq` (Spring-ObjectMapper, `TelemetryV2RawSeqTest`), ausgewertet wird es
  erst mit IP-7/IP-9.
- **Readiness:** `/health/readiness` = `readinessState` + `eventsTopic` (der Ingest bedient keinen
  fachlichen HTTP-Verkehr); `K8sReadinessConfigTest` bewacht die Gruppe, `ProbeEndpointsTest` zeigt
  503 ohne / 200 mit Topic, `IngestPipeTest` fragt das echte Redpanda, `DatenannahmeTest` und
  `BoxEreignisTorTest` den Rückfall.
- **Box-Weg:** `MqttEventsIngestConfig` (Fabrik der Messwerte: persistente Sitzung, manuelle
  Quittung) → `BoxEventsValidator` = Zwilling von `EreignisVokabular.pruefeUmschlag` für die sechs
  Box-Arten; `BoxEventsValidatorTest` fährt jeden Umschlag-Fall der Vektor-Datei und hält
  `ARTEN`/`BOX_ARTEN`/`FELDER`/`ERKANNT_AUS`/`Grund` an deren `vokabular`.

- **Beweis gegen den Verbraucher (IP-8):** `docs/contracts/v2/datenannahme-events-vectors.json` —
  Ingest `DatenannahmeVektorenTest` erzeugt genau diese Nachrichten (neu mit
  `-Dvektoren.schreiben=true`, dann den Diff prüfen), Writer `DatenannahmeNachrichtenTest` nimmt
  jede an (Rahmen `EventsRawConsumer` + `EreignisVokabular.pruefe`, Box-Umschläge per
  `pruefeUmschlag` gleich beurteilt). Wer die Datenannahme ändert, fährt beide.

## ⚠ Fallen

1. **`events.raw` VOR dem nächsten Deploy im gitops-Repo `mamotec/gitops` anlegen** (Produktion
   = k3s seit dem Cutover 03.08.2026, Argo CD; `redpanda-init` der Compose-Dateien gilt lokal).
   Fehlt es, fällt die Datenannahme auf das Verhalten VOR IP-5 zurück (Entscheid b07-recreate D):
   Messwert- und Kern-Weg senden KEIN Ereignis, die Ablehnung steht nur im Log und im Zähler
   `voltpilot.ingest.events.undelivered`, quittiert wird nach den Messwerten — der Messwert-Weg
   wartet nie auf `events.raw`. Der Box-Adapter verbindet sich erst mit dem Topic
   (`BoxEreignisTor`, ohne Autostart), die Readiness bleibt DOWN. `EventsTopicPruefung` fragt
   höchstens alle 10 s und merkt sich den ersten Treffer. Kein Topic-Anlegen aus dem Code.
2. **Nie `Instant.now()` als Eingangszeit gegen Beispiele mit festen Messzeiten** — nach 90 Tagen
   werden sie still `too_old`. Die Unit-Tests nehmen feste Eingangszeiten, `IngestPipeTest` eine
   `@Primary`-`Clock` (`FesteEingangsuhr`).
3. **`clock_jump` ist OFFEN.** Er vergleicht aufeinanderfolgende Umschläge derselben Box; die
   zustandslose Datenannahme sieht nur einen. Gehört zum Writer neben `sequence_gap`/`_reset`
   (IP-7/IP-9) — dann braucht die Art den Urheber `writer` im Vokabular.
4. **Eine Wiederholung derselben Zustellung** trägt dieselbe `ereignis_id`, aber einen anderen
   `zeitpunkt` (Eingangszeit): der Writer (IP-8) verwirft sie als `fortschreibung_unzulaessig`
   und zählt sie in `voltpilot_writer_events_raw_total{ergebnis="verworfen"}` — gespeichert bleibt
   die erste, der Zähler ist hier also kein Fehler der Box.
5. **`entity_id`/`applied_revision` reist weiter NICHT in `measurements.raw`** — der Writer prüft
   Sample-Felder streng (`MeasurementRawConsumer`); das Durchreichen kommt mit IP-6/IP-7.

Prüfen: `(cd services/ingest && ./mvnw test -Dtest='DatenannahmeTest,BoxEventsValidatorTest,MesszeitregelTest,MeasurementSamplesValidatorTest,TelemetryV2ValidatorTest')` (rein); `IngestPipeTest` mit Docker.
