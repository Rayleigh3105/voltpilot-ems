# MiSpeL: OCPP 2.0.1 auf der Box (MP-35)

Zweite OCPP-Spur neben 1.6J im selben `csms.Server`, gleiche Adresse und Freigabeliste. Umfang, Abbildungstabellen und Grenzen: [OCPP 2.0.1 auf der Box](../../edge-ocpp201.md).

- **Weiche** (`internal/csms/subprotocol_mux.go`): eine `ws.Server`-Spur je Subprotokoll über einem gemeinsamen Server; die 1.6-Spur ist primär und besitzt Start/Stop/Fehlerkanal. Die Spurwahl spiegelt gorillas Regel (Box-Reihenfolge 1.6 vor 2.0.1) – eine Säule, die beides anbietet, bleibt bei 1.6. Erst mit Ladeprofilen für 2.0.1 (MP-36) darf diese Vorliebe kippen, dann mit Bestandsschutz-Beleg.
- **Falle Bestand:** `TestOCPP16BestandBleibtByteGleich` hält Draht, `chargers.json` und Schnappschuss eines festen 1.6-Gesprächs gegen `testdata/ocpp16_bestand.golden.json` (aufgenommen VOR MP-35). Neue Felder für 2.0.1 tragen `omitempty` und bleiben für 1.6 leer; bewusste Änderung nur mit `VP_OCPP16_BESTAND_SCHREIBEN=1` und Begründung im PR.
- **Falle Sitzung:** 2.0.1-Transaktionen tragen die Kennung der Säule (`Session.StationTransactionID`, persistiert); die Box-Nummer bleibt der Schlüssel aller Verbraucher. Startstand ohne Importregister ist `MeterStartUnknown`, nie 0 (Agent: keine Sitzungsenergie).
- **Falle Test:** OCPP-Zeitstempel sind sekundengenau, die Box nimmt nur strikt neuere Werte – ein Testclient braucht je Nachricht eine eigene Sekunde innerhalb von `MaxLiveMeterAge`.
- **Nicht steuern:** jeder 1.6-Befehl an eine 2.0.1-Säule endet mit `ErrOCPP201Profiles` (`liveTransport`); der 1.6-Messabgleich (`reconcileMeasurementConfiguration`) überspringt sie, ihre Messwerte richtet `configureMetering` über das Device Model ein und liest sie zurück.
- **Prüfnachweis:** `cd edge-app/core && go test -race ./internal/csms/ -run 'OCPP201|OneEndpoint|OCPP16Bestand'`.
