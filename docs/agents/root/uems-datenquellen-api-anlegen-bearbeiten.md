# UEMS-Datenquellen-API: anlegen, bearbeiten, von genau der Box prüfen, zuweisen, Protokoll

Neu am 11.09.2026 (AP-06 IP-3). `GET/POST /api/v1/sites/{siteId}/data-sources`, `GET/PUT …/{id}`,
`POST …/{id}/reachability-check`, `POST …/{id}/assignments`, `GET …/{id}/history` — Controller
`services/api/.../web/DatenquelleController.java`, Arbeit in `uems/DatenquelleService.java`, Formen
in `web/dto/DatenquelleDto.java`, Adress-Normalisierung in `uems/DatenquelleAdresse.java`,
Protokoll-Tabelle `data_source_aenderung` (Migration `V20260911180000`, dazu
`data_source.vergleichsquelle`), OpenAPI-Tag `datenquellen`. Beweis: `uems/DatenquelleApiTest`
(MockMvc + TimescaleDB, spielt die 21 `antrag`-Fälle von `data-source-vectors.json` über HTTP),
`uems/DatenquelleSchnittstelleVertragTest` (rein: DTO ⟷ OpenAPI ⟷ Vertrag),
`probe/ProbeServiceBoxTest`. Regeln: `uems-datenquelle-und-zustaendigkeit-als.md`, Unterbau:
`uems-datenquellen-tabellen-datenquelle-z.md`.

## ⚠ Die Fallen

- **Keine zweite Regel-Logik.** Ob eine Box ab `t` lesen darf, urteilt allein
  `DatenquelleRegeln.pruefeAntrag`; jeder geänderte Zeitraum geht danach durch
  `pruefeZeitraum`. Die ERSTE Box einer Quelle ist ein Antrag `anlegen` (der gespeicherte
  Entwurf ist der Kandidat), jede weitere ein `wechsel` (Steuerquelle → 409). Der Kandidat des
  Vertrags kennt keine Steuerquelle: der Dienst gibt `mehrere_leser && !steuerquelle` hinein —
  dasselbe Urteil ohne neue Regel. Die Exklusions-Constraints sind nur die Rückwand
  (`gleichzeitig_geaendert` 409 mit `grund`).
- **Das Prüfergebnis kommt NIE aus der Anfrage.** Die Prüfung schreibt „ok“ oder eine
  Fehlerklasse der BOX als `erreichbarkeit_geprueft` (Spalten `device_id`, `ergebnis`) ins
  append-only Protokoll; die Zuweisung liest die JÜNGSTE Prüfung dieser Quelle von GENAU dieser
  Box und nur, wenn deren `neu.adresse`/`neu.protokoll` noch die der Quelle sind. Schweigt die
  Box oder lehnt ihr Prüf-Kanal ab, wird nichts geschrieben.
- **Die Probe an GENAU die Box: `ProbeService.probeBox` (additiv).** Sie löst die Box per id im
  Zaun auf und fragt auf deren EIGENEM Topic (`ems/{t}/{Heimat-Anlage der Box}/{box}/v2/probe`)
  — die Anlage der Quelle darf eine andere sein (E7). `probe`/`testConnection`/`switchOp` fahren
  weiter die Einzel-Gateway-Weiche; deren Ersatz ist IP-5/IP-8. Heute prüfbar: Modbus TCP und
  SunSpec (ein `read`-Schritt, Host/Port von der Quelle); MQTT/HTTP/OCPP → 422
  `pruefung_nicht_moeglich`, also noch keiner Box zuweisbar.
- **snake_case wie die Messstellen-API** — die Wörter des Vertrags (`effective_from`,
  `vergleich_bestaetigt`, `geraete_ids`). Ein neues Feld: DTO + OpenAPI zusammen, sonst ist
  `DatenquelleSchnittstelleVertragTest` rot. Anfrage streng (unbekanntes Feld 400 mit `feld`).
- **Status je Grund** hat EINE Stelle: `DatenquelleAbgelehnt.status` (400 Vokabular, 422 Zeit,
  409 Stand), im Test gegen eine Tabelle gepinnt.
- **Der Weg bleibt nach der ersten Box.** Protokoll, Adresse, Ein-Leser-Eigenschaft und
  Steuerquelle ändern sich per PUT nur ohne Zeitraum (`weg_fest`), Name/Netz/Takt immer.
- **Die Uhr ist injizierbar** (`ObjectProvider<Clock>`, sonst Systemuhr): der API-Test setzt eine
  Test-`Clock`-Bean und spielt so die „jetzt“-Zeitpunkte der Vektoren (2026/2027). Die Anmeldung
  setzt `jwt()` von spring-security-test — kein Keycloak-Container nötig.
- **Offen benannt:** `datenquelle.bearbeiten`/`datenquelle.zustaendigkeit` (AP-06 §4.8) fehlen in
  `rechte-matrix.json` (nächste Zeile `geraet.einrichten`); die Sätze formatieren in
  Europe/Berlin (Zone des Standorts später); eine Steuerquelle darf ihre ERSTE Box an jeder Box
  des Kundenbereichs bekommen (der Vertrag regelt „nur die Heimat-Box“ nicht als Grund).
