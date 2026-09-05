# Topology-Quellen-Fill über den Registry-Pin (D-17, vp-vier-erzeuger-p9 PR 4a)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 13).


Der Registry-Push-Descriptor trägt seit D-17 optional **`edge_source_id`** (den
Cloud-Adoptions-Pin). `Agent.Topology()` füllt damit Entitäten OHNE eigenes
Reading DISPLAY-ONLY aus den EIGENEN Quellen-Readings (`SourceLastReadings`,
Frische über `SourceStatuses`): Producer `pv_power_kw` ← Quelle-pv, `power_kw`
← signed grid bzw. Verbraucher-load (`sourceChannelValue`). Sobald mindestens
ein Producer so gefüllt wurde, zeigt der Hybrid sein **PRE-FOLD-Primär-pv**
(`Snapshot.LastReading`) statt des gefalteten Komposits — die PV-Rollen-Summe
bleibt exakt das Komposit, nie doppelt gezählt. Grenze wie `ComposeLocal`:
Topology speist NUR `:8484`/`/api/state` — nie Buffer, v2-Uplink oder das
Heartbeat-observed-Ist. Ohne Pins ist alles byte-for-byte wie vorher (alter
Cloud-Stand lässt das Feld weg, alte Edges ignorieren es). Beweise:
`agent/entities_sourcefill_test.go`, `entities_test.go` (Fixture-Pin),
api `ProvisioningClaimTest` (Re-Push trägt den Pin retained).

