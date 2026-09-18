# Gemeinsamer Messbudget-Vertrag (AP-07 IP-4)

`docs/contracts/v2/measurement-budget-vectors.json` führt Kosten je Protokoll-/Treiberfamilie,
Blockgröße, Grenzen und A16-Vektoren (DQ-1…DQ-7, beide Ahrenberg-Boxen, 25 Karten und Grenzfälle).
`MeasurementBudgetContract` lädt dieselbe Datei aus dem API-Jar; `measurement-planner.js` lädt
die bytegleiche Ableitung neben dem Box-Katalog. `package_edge_runtime.py` erzeugt und prüft
diese Kopie mit `--check`; Maven und der API-Docker-Bau nehmen die Vertragsdatei direkt auf.

Modbus/SunSpec: 400 ms je Block bis 120 Wörter. WAGO-Registerbild: 400 ms je Planungseinheit
von höchstens fünf Karten (25 Karten = fünf Anfragen, 325 Samples/min, 3,333 %).
HTTP/MQTT/Solarman: bisherige 250 ms; OCPP: keine Pollanfrage, keine Buskosten.
Freie Register ohne belegte Familie bleiben 2.000 ms je Definition/Adresse. Die Kosten kommen
nie aus einem Kundenfeld. Benchkosten sind Planannahmen, keine gemessene Laufzeit oder
Hardwarefreigabe; WAGO wird dadurch nicht als neuer Box-Treiber freigeschaltet.

Zielauflösung und Pollgruppen bleiben bei den bestehenden Planern. Verschiedene Geräteziele
werden nicht aufgrund gleicher Register oder derselben Verbindung zusammengelegt. Der
Node-RED-Plan fasst freie Adressen nicht mehr zu einem billigeren Katalogblock zusammen:
Ein freies Register mit 5 s kostete dort 8 %, in Java bereits 40 %; nun lehnen beide ab.
Die Warnung beginnt in beiden Zwillingen bei 120 Samples/min. Die Grenzen 600/30/20 % und
AP-06 IP-10 (Kanäle, Box-Zuordnung, Auswege) bleiben erhalten.

Keine Änderung an `RUNTIME_VERSION`, Katalog, MQTT-Payloads oder Freigaben. Mischbetrieb:
`MeasurementContractsTest.publisherPayloadIsTheCommittedValidFixture` hält die Cloud-Ausgabe
am bestehenden 2.0-Payload; `measurement-budget.test.js` prüft heutige Cloud → neue Box samt
unverändertem Status. Beide prüfen weiterhin Laufzeitkatalog `2026.08.26.3`.

Pflichtleser: `MeasurementBudgetVectorsTest`, `measurement-budget.test.js` und
`package_edge_runtime.py --check`. Nachbarn: `MeasurementBudgetTest`, `DatenquelleBudgetTest`,
`DatenquelleApiTest`, `MeasurementContractsTest`, Messpunkt-Auswahltests und
`node --test edge-app/nodered/measurements/*.test.js` (einschließlich Palette/Transport).
