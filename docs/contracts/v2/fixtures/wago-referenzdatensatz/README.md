# Beispiele: WAGO-Referenzdatensatz

Beispiele für [`../../wago-referenzdatensatz.schema.json`](../../wago-referenzdatensatz.schema.json)
(Wurzel = EIN Referenzdatensatz einer Kombination). Die gültigen zeigen die zwei Stände, die es
geben wird: vor dem Pilot (nur Simulator, nichts belegt) und nach Pilotschritt 2 (ein belegter Fall mit
Nachweis). Das ungültige bricht GENAU eine Regel und hält, sobald dieses eine Feld repariert ist.

Alle drei spielen im Referenzunternehmen Ahrenberg (Steuerung C-1); die Lesungen sind erfunden. **Sie
sind Schema-Beispiele, kein Hardwarebeleg und keine Vektor-Datei für Zwillinge** — den echten
Referenzdatensatz legt der Pilot an (AP-05 IP-14).

Geprüft von `frontend/portal/src/wagoReferenzdatensatz.test.ts` mit dem kleinen Schema-Läufer der
UEMS-Verträge; das Schema nutzt nur dessen Schlüsselwörter (der Test hält das fest), darum kommt jeder
Draft-2020-12-Validator (ajv, `jsonschema`) zum selben Urteil.

| Beispiel | Erwartung |
|---|---|
| `wago-referenzdatensatz.valid.vorstufe-simulator.json` | gültig — vor dem Pilot: Zählerrücksetzung an EK-3 und stehender Herzschlag, beide `herkunft: simulator`, `belegt: false`; Basisadresse und Wortfolge `zu erheben` |
| `wago-referenzdatensatz.valid.ahrenberg-pilot.json` | gültig — nach Pilotschritt 2: EK-1 Normallast `herkunft: pilot`, `belegt: true` mit Nachweis (Datum, Ort, Prüfer, Vergleich); EK-4 aus Pilotschritt 1 `belegt: false`, weil der Vergleich fehlt |
| `wago-referenzdatensatz.invalid.simulator-belegt.json` | **ungültig** — ein Simulator-Fall behauptet `belegt: true` (`$.faelle[0]`, Beweisregel: belegt ist nur ein Pilot-Fall mit Nachweis). Der Simulator dient dem Bauen, nie dem Beleg. Mit `belegt: false` hält die Datei |
