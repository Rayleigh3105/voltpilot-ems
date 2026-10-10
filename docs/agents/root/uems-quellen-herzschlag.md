# Quellen-Herzschlag auf der Box (AP-06 IP-13)

Vertrag, Zeitformen und Mischbetrieb: [Quellenstatus](../../contracts/v2/data-source-status.md).

- `driver.data_source_id` ist das gespeicherte DQ-Kennzeichen, kein Transport und keine
  lokale Quellenkennung. Die offene Treiberstruktur erhält die alte Schema-Kompatibilität.
- Core `internal/datasourcestatus` besitzt Zustände und gleitende Zähler. Der Status-Zusatz
  `cloud.StatusExtension` hält Platz für unabhängige Nachbarblöcke (IP-18).
- Node-RED `measurements/data-source-status.js` ist auch im Quellen-Poll eingebettet;
  nach Änderungen `node edge-app/nodered/build-flows.js` ausführen.
- Geteilte Vektoren: `data-source-status-vectors.json`; Leser in Go
  `datasourcestatus/status_test.go`, Java `DataSourceStatusListenerTest` und TS
  `dataSourceStatusVectors.test.ts` gemeinsam ausführen. Der alte Push-Pfad wird in
  `componentapply/data_source_compatibility_test.go` geschützt.
- Keine Release-/Fähigkeitsregistrierung in diesem Paket. Der Cloud-Lückenmelder nutzt
  weiterhin seinen alten Telemetrie-Anker; siehe Vertrag.
