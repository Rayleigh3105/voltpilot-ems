# UEMS-Lesebudget je Box beim Anlegen und Wechseln

Neu am 16.09.2026 (AP-06 IP-10), ohne Migration und ohne Edge-Release. Der Schreibweg
`POST /api/v1/sites/{siteId}/data-sources/{id}/assignments` rechnet unmittelbar vor dem ersten
Zeitraumsschreibzugriff die neue Box-Belegung. `MeasurementBudget.estimateSources` trennt dabei
Kanäle × Takt von Blockanfragen × Takt und verwendet die heutige Java-Kostentabelle
(Modbus/SunSpec 400 ms, HTTP/MQTT/Solarman 250 ms, OCPP 0 ms, freie Register 2.000 ms).
AP-07 IP-4 führt diese Werte nun im [gemeinsamen Kostenvertrag](uems-messbudget-vertrag.md).
Die AP-06-Quellen-/Box-Rechnung und ihre Auswege bleiben dabei unverändert.

Die Last einer Quelle kommt aus ihren Komponenten (`measurement_point.data_source_id`) und deren
aktivierten Messpunkten. Katalog-Pollgruppen werden je Komponente nur einmal angefragt; freie
Register zählen einzeln. Eine Quelle ohne erhobenen Takt oder noch ohne Messkanäle wird nicht als
Null erfunden: der bisherige Entwurfsweg bleibt offen, bis sie vorrechenbar ist.

Bei Überschreitung antwortet die Route mit 422 `budget_ueberschritten`. `rechnung` enthält die
Quellenrechnung (Protokoll, Kanäle, Takt, Anfragen je Takt, Kosten), die Box-Summe danach, Grenzen,
freie Kapazität jeder Box am Standort und zwei konkrete Auswege: `Takt … s wählen` sowie passende
`Box … wählen (… Anfragen/min frei)`. Die Prüfung läuft vor `beenden`/`eintragen`; deshalb bleiben
alle bestehenden Quellen und Zuständigkeitszeiträume bei einer Ablehnung unverändert.

Vertragsfixture: `docs/contracts/v2/data-source-budget-vectors.json` mit A6 S1–S7 und A10.
Serverbeweis: `DatenquelleBudgetTest`, HTTP-/Bestandsschutz: `DatenquelleApiTest`. Im Portal trägt
`api.ts` die 422-Form; `uemsDatenquelle.budgetAblehnungAnzeige` übersetzt sie für die noch folgenden
Anlege-/Wechsel-Dialoge (AP-06 IP-11/IP-12). Es gibt in diesem Paket bewusst noch keine sichtbare
Portal-Fläche.
