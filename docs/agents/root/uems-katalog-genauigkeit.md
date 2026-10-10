# Katalog-Genauigkeit laut Hersteller (AP-16 IP-16)

Verbindlich: `catalog/measurement-points/README.md` („Genauigkeit laut Hersteller"),
`MeasurementCatalog.herstellerGenauigkeit`, `MessmittelAngabenApiTest`.

- `models[].accuracy` und optional `points[].accuracy` sind Cloud-only. Sie fehlen absichtlich in
  `EDGE_FIELDS`/`RUNTIME_FIELDS`; `RUNTIME_VERSION`, Palette-Katalog und SQL-Metadaten bleiben bytegleich.
- Zustand `belegt` braucht Klasse, Wert, Bezug, Fundstelle, öffentliche `source_url` und die SHA-256
  der gelesenen Herstellerquelle. Hinter Anmeldung oder ohne nachprüfbare Quelle: `nicht_belegt`,
  ohne erfundene Zahl und ohne Quellen-Attrappe.
- `GET /api/v1/geraete/{id}/messmittel` liefert `laut_hersteller` getrennt von
  `genauigkeitsklasse`, Prüfung, Kundenbeleg und Wandler-Klasse. Keine Seite rechnet daraus eine
  Genauigkeit der Messkette oder ersetzt die Angabe am Einbau.
- Modellabgleich ist herstellergebunden. Varianten nach `/` passen zum Grundmodell; `x` steht in
  einer Katalog-Modellreihe für genau eine Ziffer (`879-30xx`). Karten lesen den Hersteller ihres
  Trägergeräts, nicht eine aus dem Typtext geratene Marke.
