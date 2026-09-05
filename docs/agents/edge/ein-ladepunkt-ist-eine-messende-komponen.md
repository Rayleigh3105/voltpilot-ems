# Ein Ladepunkt ist eine MESSENDE Komponente (Cockpit Phase 1 / E1+E2)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 83).


Cloud-Seite, Portal und die volle Begruendung: root `CLAUDE.md`
„Cockpit Phase 1 / E1+E2". Was HIER gelten muss:

- **⚠ Die Zuordnung Ladesaeule -> Komponente kommt AUSSCHLIESSLICH aus dem
  Registry-Push** (`entities.Entity.ChargePointID`, additiv). Ohne sie
  veroeffentlicht `publishOcppEntityTelemetry` GAR NICHTS - es gibt keinen
  Rueckfall, der Messwerte auf die falsche Komponente pinnen koennte, und eine
  Box an einer aelteren Cloud ist byte-identisch zum Vor-Phase-1-Stand.
- **`ocppEntityReadings` ist die REINE Regel** (kein Bus, keine Uhr - das
  `probe`/`otaapply`-Muster); `publishOcppEntityTelemetry` haengt am Ende von
  `ocppStep` neben `publishOcppState`, also formen Karte, Herzschlag und
  Entitaets-Reihe sich aus DERSELBEN Momentaufnahme.
- **Es entsteht KEIN zweiter Uplink**: von `edge/entities/{id}/telemetry` an
  traegt die bestehende E1b-Kette alles weiter (Identitaetspruefung ->
  store-and-forward -> v2-Uplink), byte-gleich wie bei einem messenden Shelly.
- **⚠ Eine TEIL-Summe ist keine Messung:** ein Stecker, der NIE gemessen hat,
  gehoert nicht zur Summe; einer, der gemessen HAT und verstummt ist, macht die
  Saeulen-Summe unvollstaendig - dann veroeffentlicht die GANZE Saeule nichts
  (die `ChargingTotal`-„complete"-Disziplin, eine Ebene hoeher).
- **⚠ `soc_pct` wird NIE publiziert** (der Ladestand des AUTOS;
  `topology.DefaultRole` bildet ihn kategorie-unabhaengig auf den SPEICHER-Knoten
  ab). Wer den Kanal ergaenzt, faellt in genau diese Falle.
- **E2:** `state.OcppConnector` traegt `SessionKwh` (Register minus
  `Session.MeterStartWh`; ein RUECKWAERTS gesprungenes Register liefert KEINE
  Bilanz statt einer negativen) und `MeteredAtMs`; beides reist additiv im
  `chargers`-Block. Eine Box ohne MeterValues sendet BEIDES nicht.
- Beweise: `agent/ocpp_entities_test.go`, `agent/ocpp_heartbeat_test.go`.

