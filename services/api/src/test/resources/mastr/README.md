# MaStR-Testdaten

Offline-Fixtures aus öffentlichen Daten zweier Wohnanlagen. CI ruft dafür kein Register ab.

| Dateien | Herkunft |
|---|---|
| `json_pv_SEE966831669444.json`, `json_storage_SEE972142227037.json` | Unveränderte Antworten des öffentlichen JSON-Backends vom 02.07.2026, exakte Einheitennummern |
| `soap_solar_*.xml`, `soap_storage_*.xml` | Von Hand erstellte SOAP-Antworten mit denselben Werten und WSDL-Feldnamen; keine aufgezeichneten Live-Antworten |
| `soap_fault_keine_daten.xml` | Fehlerantwort für unbekannte Einheit |

JSON-Daten: Marktstammdatenregister der Bundesnetzagentur, Datenlizenz Deutschland – Namensnennung – 2.0. SOAP-Requestform und `SOAPAction` wurden am 02.07.2026 geprüft; die Antwort-Fixtures bilden die WCF-/`Modelle`-Struktur nach.
