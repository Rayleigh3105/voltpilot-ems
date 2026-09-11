# Beispiele: Messstelle

Beispiele für [`../../messstelle.schema.json`](../../messstelle.schema.json) (Wurzel = EINE
Messstelle). Die gültigen sind Feld für Feld die Messstellen des Referenzunternehmens
[`../../uems-referenzunternehmen.json`](../../uems-referenzunternehmen.json); ein ungültiges
bricht GENAU eine Regel. Beide Zwillinge prüfen das (`MessstelleRegelnVectorsTest`,
`src/uemsMessstelle.test.ts`) mit dem kleinen Schema-Läufer der UEMS-Verträge; jeder
Draft-2020-12-Validator (ajv, `jsonschema`) kommt zum selben Urteil.

| Beispiel | Erwartung |
|---|---|
| `messstelle.valid.ms-06.json` | gültig — MS-06 Spritzguss SG01–SG06 nach dem Zählerwechsel: Z-5a bis 18.11.2026 10:40 mit Endstand 1 083 415,2 kWh, Z-5b ab 10:40 mit Anfangsstand 0,0 kWh; Nebengröße Wirkleistung mit eigener Quelle; Unterzähler von MS-01 in AN-1 |
| `messstelle.valid.ms-21.json` | gültig — MS-21 Gas Heizung Verwaltung: Medium Gas, Volumen m³, keine Quelle, keine elektrische Stellung — eingerichtet und aktiv, Beobachtung „Keine Datenquelle“ (E8) |
| `messstelle.invalid.kennzeichen-kleinbuchstaben.json` | **ungültig** — Kennzeichen `ms-06`: nur Großbuchstaben (E7), nichts wird umgewandelt (`$.kennzeichen`, Muster) |
| `messstelle.invalid.medium-ausserhalb.json` | **ungültig** — Medium `Erdgas` steht nicht im geschlossenen Vokabular; ein Wort außerhalb wird abgelehnt, nie geraten (`$.medium`, Vokabular) |
