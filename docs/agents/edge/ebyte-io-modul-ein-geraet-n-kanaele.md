# Ebyte-I/O-Modul: EIN Gerät, N Kanäle, der Core besitzt den Socket

Betreiber-Doku: [`edge-app/nodered/EBYTE.md`](../../../edge-app/nodered/EBYTE.md).
Treiber `edge-app/core/internal/ebyte`, Executor/Poll/Test
`internal/agent/ebyte_control.go`, Simulator `internal/ebyte/ebytesim`.

- **Datenmodell:** das Modul ist EINE Entität `io-module` (Katalog `ebyte`,
  Gerätetyp `io_module`, nie steuerbar); jeder geschaltete Ausgang ist ein
  eigener Verbraucher mit `consumer_profile.io_entity_id/io_channel`
  (Migration `V20260924120000`). Der Registry-Push komponiert den
  Kanal-Treiber `{communication, io_entity_id, channel, rated_power_kw}` OHNE
  `connection` — `componentapply` überspringt connection-lose Treiber, eine
  ältere Box ignoriert ihn also folgenlos. Die Box liest die Adresse aus dem
  Treiber der Modul-Entität. **Nie `edge_source_id` für Kanal-Verbraucher**
  (die Übernahme-Nadel ist 1:1).
- **`roleFor`:** die Modul-Entität ist measure-only und wäre „nicht
  bestimmbar" — ohne den `CommEbyteModbusTCP`-Zweig kippte sie den GANZEN Push.
- **Ein Socket:** `inverter.IsCoreOwned` (Shelly + Ebyte) hält das Modul aus
  `sources.BusConfig`; `register_write.entityWriteTarget`,
  `RegisterWriteTargets.CORE_OWNED_TRANSPORTS` und das Portal
  (`geraetGesicht.OHNE_REGISTER`) sperren den freien Registerzugriff; die
  Familie `ebyte_m31` hat bewusst keine Messpunkte
  (`MeasurementCatalogFamiliesTest`). Alle Treiber-Sitzungen laufen unter
  `ebyte.lockFor(host:port)`.
- **Der Stapel wird bewiesen, nie geglaubt:** Modellcode je Steckplatz
  (`0x0C80`, „NONE" beendet, „A" = 16), dann Grenzprüfung (letzte Adresse
  antwortet, nächste Exception 2). Unbewiesen = weder lesen noch schalten.
  Ausstehende Abstimmung (Fehlercode 2) wird gemeldet, nie selbst ausgeführt.
- **Identität:** MAC + Modul-Layout je Adresse in `ebyte-devices.json`
  gepinnt; Abweichung sperrt das Schalten, *Verbindung testen* pinnt neu.
- **Totmann:** EIN nur mit scharfem Geräte-Watchdog (alle Fehlerzustände AUS).
  Einrichten heißt Neustart → nur bei allen Ausgängen aus, höchstens alle
  5 min. Weil jedes Lesen den Watchdog wach hält, schaltet der Executor bei
  Not-Aus und entfernten Verbrauchern genau SEINE eingeschalteten Ausgänge
  aktiv AUS (`switchedOn`).
- **Telemetrie:** Quelle `{inputs, outputs}` (hält die Frische), Entität
  `di_k`/`do_k` bei Änderung + minütlich; API-Leseweg
  `GET /sites/{id}/io-modules/{entityId}/zustand` (10-min-Fenster).
- **Beweise:** `ebyte_test.go`, `ebyte_control_test.go`,
  `componentapply_test.go`, `catalog_struct_test.go`, API `ConsumerApiTest`
  (Bindung/409/422/400/Push/Zustand), `ComponentApiTest` (Vorlage →
  `io-module`), Portal `ioAusgaenge.test.ts`, `ioZustand.test.ts`,
  `geraetGesicht.test.ts`. Hardware: `cmd/vp-ebyte-bench` am echten
  M31-AXAX8080G-U; Eingänge physisch und Erweiterungsmodule sind offen.
