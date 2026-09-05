# Eine WALLBOX tritt dem Ladepark-Rahmen bei (P6)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 87).


`internal/agent/ocpp_wallbox.go` (Verdrahtung) + `lastmgmt.Wallbox`. Sie haengt
NICHT an OCPP, sondern als v2-Verbraucher am Arbiter: der Verteiler zaehlt ihre
GEMESSENE Leistung ins Budget zurueck und deckelt sie ueber den bestehenden
Verbraucher-Sollwert (`capWallboxCommand` in `goeCommandFor`), nie ueber ein
Ladeprofil. **Es gibt weiterhin GENAU EINEN Schreiber je Geraet.**

- **⚠ TEILNAHME HAT ZWEI HAELFTEN, und beide muessen anliegen:** ein FRISCHER
  eigener Messwert (`power_kw`, dasselbe Fenster wie `ocppMeterMaxAge`) UND ein
  vom Arbiter GEWAEHRTES Kommando. Ohne Messung ist sie blosse Gebaeudelast und
  wird NICHT gedeckelt - das sagt die Box auch (`WallboxNote`), statt es zu
  verschweigen; ohne Kommando faehrt sie nach ihrer eigenen Steuerart.
- **⚠ Die Rueckaddition haengt an der KAPPBARKEIT, nicht an der Messung
  allein.** Ihre Leistung steckt in der Netzmessung; sie zurueckzuaddieren
  heisst, sie dem Verteiler zu ueberlassen. Wer sie zurueckaddiert, ohne sie
  deckeln zu koennen, verschenkt Budget an eine Leistung, die niemand steuert.
- **⚠ Kein Regelkreis:** der Anspruch keyt auf das Kommando, das der Arbiter
  VOR unserer Kappung gebildet hat - eine Kappe von 0 loescht also nie den
  Beleg, der sie verursacht hat.
- **Ohne Eintrag in `wallboxes[]` aendert sich NICHTS** (die Liste ist
  ausdruecklich dreiwertig: fehlend = keine Aussage, LEER = „keine nimmt teil",
  sonst die Menge). Eine Wallbox-Sitzung traegt NIE `Priority` - ihr Vorrang
  ist ihr Rang.
- Beweise: `internal/lastmgmt/rangliste_test.go` ·
  `internal/agent/ocpp_rangliste_test.go` · `internal/agent/ocpp_wallbox_test.go`
  (alle an den LADEPROFILEN gemessen) · Rig `test/e2e-ocpp.sh` L15a-c.
