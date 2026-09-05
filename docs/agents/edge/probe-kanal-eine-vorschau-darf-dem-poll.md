# Probe-Kanal: eine Vorschau darf dem Poll nie den Socket wegnehmen (Stufe 0b)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 22).


Vollstaendiges Bild (Vertrag, api-Route, Regeln): root `AGENTS.md` „Probe-Kanal".
Was HIER gelten muss:

- **`internal/probe` ist die REINE Haelfte** (kein Socket, kein Bus, keine Uhr -
  jede zeitabhaengige Funktion nimmt `now`, das
  otaapply/calibration/curtailcal-Muster); `agent/probe.go` ist ausschliesslich
  die Verdrahtung. Wer eine Regel ergaenzt, ergaenzt sie dort - dann ist sie
  ohne einen einzigen Container pruefbar.
- **⚠ Der CORE oeffnet KEINEN eigenen Modbus-Socket.** Die Lesung geht ueber den
  lokalen Bus (`edge/probe/request|result`) an den Palette-Knoten
  `vp-modbus-probe`, weil dort `lib/modbus-conn.js` wohnt: EIN in-flight-Vorgang
  je (host, port) ueber ALLE vp-modbus-Knoten hinweg. Viele Kundengeraete
  (Solarman-Logger, billige Gateways) bedienen genau einen TCP-Client und
  verdraengen den laufenden - eine Vorschau mit eigener Verbindung waere also
  nicht „eine Lesung mehr", sondern der Abbruch des Polls genau des Geraets, auf
  das der Kunde gerade schaut. `TestProbeNeverDialsTheDeviceFromTheCore` haelt
  das an einem echten Listener fest, der NIE verbunden werden darf.
- **Der Knoten ist selbststaendig** (0 Ein-/Ausgaenge, keine Verdrahtung im Tab
  „Verbindung testen") und traegt KEINE eingebettete Kopie - anders als der
  test-read-Funktionsknoten gibt es hier also nichts, was driften koennte. Seine
  Ops laufen NACHEINANDER (sie zielen meist auf dasselbe Geraet; parallel liesse
  der Fehlschlag eines Schritts den seiner Nachbarn aussehen).
- **Die Fehler-Klassifikation keyt auf die GESCHLOSSENE Fehlermenge der zwei
  Module, die uns gehoeren** (`modbus-conn` + `parseReadResponse`) - nicht auf
  unscharfe Regex ueber errno-Texte. Wird eine dieser Meldungen umformuliert,
  faellt das in `probe_spec.js` auf, nicht beim Kunden.
- **Nur Lesen.** Der im Vertrag vorgesehene `switch_test` wird vom CORE mit
  `not_supported` abgelehnt und erreicht den Bus gar nicht - es gibt auf diesem
  Pfad keinen Schreibbefehl.
- Palette **0.6.0**. Die Version hebt nur an, was das Geraet MELDET, also
  erfuellt sie jede bestehende `min_palette_version` weiterhin; der Knoten ist
  kein flowc-Katalogtyp, es aendert sich also kein gepinnter Hash.

