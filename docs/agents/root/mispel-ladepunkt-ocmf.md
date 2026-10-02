# MiSpeL: signierte Ladepunkt-Messwerte (OCMF, MP-38)

Box prüft OCMF-Datensätze der Säulen (`edge-app/core/internal/ocmf`, Anbindung `internal/csms/signed_meter.go`), die Cloud legt sie je Ablesung ab (`ladepunkt_signierter_messwert`) und zeigt die letzte am Ladepunkt mit Eichstatus. Vertrag: [signierte Ladepunkt-Messwerte](../../contracts/v2/mispel-ladepunkt-ocmf.md).

- **Nie umformatieren:** geprüft wird auf den Bytes zwischen den `|`; ein eingefügtes Leerzeichen macht die Signatur ungültig. Den Datensatz überall als Text weitergeben und ablegen, nie als `jsonb` und nie über ein JSON-Objekt „normalisiert“. `RV` bleibt wörtlich (`wert_text`).
- **Kurven:** P-256/P-384 über `crypto/ecdsa`, brainpool/192-bit/Koblitz über die affine Arithmetik in `verify.go`. `TestCurveParameters` hält jede Konstante fest (Erzeuger auf der Kurve, Ordnung), `TestGenericArithmeticMatchesStandardLibrary` die Arithmetik gegen die Standardbibliothek. `secp384r1` hasht laut OCMF-Tabelle 22 mit SHA-256.
- **`gueltig` ≠ geeichter Zähler:** geprüft wird gegen den Schlüssel, den die Säule nennt (2.0.1 `publicKey`); 1.6 liefert keinen (`schluessel_fehlt`). Der Abgleich mit dem Typschild-Schlüssel ist offen; `schluessel_sha256` ist dafür der Anker.
- **Ereignis statt Rahmen:** das Journal zeichnet nur 1.6-Rahmen auf; die Prüfung geht für beide Spuren als internes Ereignis `SignedMeterValue` hinaus. Kennung stabil je Säule, Stecker und Datensatz – die Cloud entdoppelt über `(event_id, ablesung)`.
- **Löschwege:** neue OCPP-abgeleitete Tabellen gehören in `TenantRepository` (Mandant), `SeriesRepository.OCPP_TABLES` (Gerät) und `Gesamtabzug.objektart`.
- **Prüfnachweis:** `cd edge-app/core && go test -race ./internal/ocmf/ ./internal/csms/ -run 'Signed|OCPP16Bestand|OCPP201'` und `LadepunktBidirektionalApiTest#signierterMesswertDerSaeuleIstQuelleMitEichstatus` (Testcontainers). Öffentliche Datensätze aus der S.A.F.E.-Transparenzsoftware in `internal/ocmf/testdata/` – keine Herstellermessung.
