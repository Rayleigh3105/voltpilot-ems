// Package otaapply is the PURE half of OTA Stufe 3 „Autonom": the on-disk
// protocol between the core and the `vp-edge-updater` sidecar, plus every rule
// that decides whether an update may be applied at all.
//
// It contains NO docker call, NO network call and NO MQTT. Everything that can
// brick a box is a decision, and a decision is testable without a container -
// the same discipline `Tagesprotokoll`/`FleetPflege`/`SlotEconomics` follow on
// the cloud side. The sidecar and the core both import THIS package, so the two
// halves of a safety rule can never drift apart (the refCheckChar/EdgeRef and
// SocPlausible precedent).
//
// # Warum ein DATEI-Protokoll und nicht ein Socket
//
// Der Sidecar besitzt `/var/run/docker.sock` und hat deshalb bewusst KEIN Netz,
// KEINEN Host-Port, KEINE MQTT-Verbindung und KEINE Identitaet. Er kann den
// Kern also nicht anrufen und der Kern ihn nicht. Beide sehen aber dasselbe
// `/data` - genau das ist der Kanal. Jede Datei hat GENAU EINEN Schreiber:
//
//	<data>/ota/target.json          Kern      (Stufe 2, retained Zuweisung)
//	<data>/ota/current.json         Kern      (Anti-Rollback-Boden, nur je hoeher)
//	<data>/ota/autonomy.json        Betreiber (der Schalter, Vorgabe AUS)
//	<data>/ota/core-signal.json     Kern      -> Sidecar
//	<data>/ota/updater-state.json   Sidecar   -> Kern (und die Oberflaechen)
//	<data>/ota/pending-confirm.json Sidecar   (die Brotkrume ueber einen Neustart)
//	<data>/ota/self-test.json       Kern      (das Urteil des NEUEN Standes)
//	<data>/ota/lkg.json             Sidecar   (das Rueckfallziel)
//
// # Die drei Saetze, auf denen die Sicherheit ruht
//
//  1. **Der Sidecar glaubt dem Kern nichts.** Er liest die Manifest-Bytes
//     selbst und verifiziert sie gegen SEINE eigene eingebackene Wurzel und
//     SEINEN eigenen Boden (`internal/otaverify`). Ein uebernommener Kern kann
//     ihm kein Release unterschieben.
//  2. **Nur der Kern darf bezeugen, was laeuft.** Der Sidecar tauscht Container;
//     ob danach der richtige Stand LAEUFT, sagt ausschliesslich der Kern gegen
//     seine eigene Build-Stempelung - deshalb schreibt nur er `current.json`.
//  3. **Was nicht entschieden werden kann, wird nicht angewandt.** Jede Regel
//     hier faellt im Zweifel auf „nicht anwenden" und traegt einen deutschen
//     Grund; ein „unbekannt" ist nie ein „geht schon".
package otaapply
