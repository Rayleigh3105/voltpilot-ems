# Recorded MaStR fixtures

Public-data records of two real small residential units, used by the offline unit tests (no live registry call ever happens in CI).

- `json_pv_SEE966831669444.json` / `json_storage_SEE972142227037.json`: recorded VERBATIM from the keyless public JSON backend (`GetErweiterteOeffentlicheEinheitStromerzeugung`, exact-match unit-number filter) on 2026-07-02.
  Data license: Datenlizenz Deutschland - Namensnennung - 2.0 (Marktstammdatenregister der Bundesnetzagentur).
- `soap_solar_*.xml` / `soap_storage_*.xml`: hand-crafted to the SOAP webservice response shape (WCF envelope, `Get...Antwort` payload in the `Modelle` namespace, catalog-id fields per `mastrservicetypes_anlage.xsd`), carrying the same units' real values.
  The request-side envelope + `SOAPAction` shape was live-verified against the real API on 2026-07-02; the response XML here mirrors the WSDL field names because recording a real response requires the captain's API key.
- `soap_fault_keine_daten.xml`: the WCF fault shape for an unknown unit number.
