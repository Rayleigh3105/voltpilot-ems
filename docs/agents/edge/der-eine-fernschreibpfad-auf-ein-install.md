# Der EINE Fernschreibpfad auf ein Installateur-Register: `0x00E7`

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 57).


Die Einspeisegrenze, die der Wechselrichter SELBST hält („Grid Max Export
power", dez. 231, Skala ×10 → W), ist aus der Ferne anhebbar - und sonst
nichts. Anlass ist Herzogau: 33,0 kW im Gerät gegen 70 kW im Portal, und das
Anheben kostete einen Vor-Ort-Termin. Betreiber-Ablauf + curl-Beispiele:
[`nodered/DEYE.md`](nodered/DEYE.md) „Einspeisegrenze aus der Ferne anheben".

- **⚠ DREI SCHICHTEN, und die Trennung IST das Design** (Portal-Konzept
  `vp-reg-schreib-konzept-p8` §1.1): **POLITIK** = `installerwrite.Admit`
  (Allowlist, Wertgrenze, Zwei-Stufen-Bestätigung) → **MECHANISMUS** =
  `Agent.WriteOnce(Target, AdmittedWrite)`, trigger-agnostisch: lesen,
  höchstens EINMAL schreiben, zurücklesen, `{before, after, adopted}` melden →
  **TRIGGER** = heute der `:8484`-Adapter `Agent.InstallerWrite`. Ein späterer
  Portal-Downlink ist ein ZWEITER ADAPTER neben `InstallerWrite`, kein Umbau:
  er ruft dieselbe Politik und denselben Mechanismus. `WriteOnce` kennt weder
  Allowlist noch HTTP noch das Protokoll.
- **Der enge Umfang bleibt am LOKALEN Trigger.** `installerwrite.AdmittedWrite`
  hat ausschließlich unexportierte Felder; `Admit` baut für die `:8484`-Taste
  weiterhin nur `0x00E7` mit dem 7000er-Deckel. Der gemeinsame
  Node-RED-Transport `vp-installer-write-request` darf diese enge Regel aber
  NICHT noch einmal anwenden: seit Stufe 2 fährt auch der bereits über
  `AdmitExpert` geprüfte freie PORTAL-Umfang über denselben Solarman-Socket.
  Dort wird deshalb nur die gemeinsame 16-Bit-Holding-FORM nachgeprüft.
- **⚠ Die Familien-Allowlist ist die READ-seitige Ehrlichkeitstabelle**
  (`inverter.ExportLimitRegisterFor`), bewusst KEINE neue: dort ist schon
  kodiert, dass `0x00E7` nur auf `hybrid_3p` eine EIGENSTÄNDIGE Grenze ist,
  während auf `hybrid_1p` die Einspeisegrenze `0x00F5` IST - das Register, das
  unser EIGENER Entlade-Hebel schreibt. Eine Familie, die wir nicht ehrlich
  LESEN dürfen, dürfen wir erst recht nicht SCHREIBEN.
- **Ein Socket, wie überall.** Der Kern öffnet nichts: die Anfrage reist über
  `edge/installer-write/request` (nicht retained) in den **`tab-auto`**-Tab und
  teilt sich dort die Flow-Kontext-Sperre `sv5_busy:`/`sv5_write_want:` mit Poll
  und Steuer-Executor. **Der Knoten MUSS in diesem Tab liegen** - Node-REDs
  `flow`-Kontext ist PRO TAB, ein Knoten anderswo hätte seine EIGENE Sperre und
  damit einen ZWEITEN TCP-Client auf einem Logger, der genau einen bedient.
  Belegter Logger ⇒ `busy`, nichts geschrieben - verschieben, nicht drängeln.
- **Genau EIN Versuch je Bestätigung.** Kein Retry, kein Auffrischen: `0x00E7`
  liegt im EEPROM. Eine verlorene Antwort ist `write_unconfirmed` („kann
  angekommen sein"), nie ein zweiter Schreibvorgang hinter dem Rücken des
  Betreibers. Der Einmal-Wächter (`installerBusy`) sitzt im MECHANISMUS, weil er
  das GERÄT schützt und nicht den Trigger.
- **FC16, nicht FC6** - dieselbe gemessene Deye-Lektion wie im Steuerpfad
  (`resolveDeyeWriteFc`); `control_write_fc: 6` schaltet zurück.
- **Die optionale Vorbedingung `expected_before` wird AUF DEM GERÄT geprüft**,
  innerhalb derselben Socket-Sitzung, die auch liest und schreibt - im Kern
  geprüft wäre es ein Lesen, ein Zurückgeben und ein zweites Beanspruchen, also
  genau das Fenster, in das ein anderer Schreiber schlüpft.
  **⚠ Das Sentinel heißt `vpCode`/`vpMsg`, NICHT `code`:** ein Node-Socket-Fehler
  trägt bereits `err.code` (`ECONNREFUSED`), und der wäre sonst als
  `error_code` an den Kunden durchgereicht worden (im e2e aufgefallen).
- **`before`/`after` sind ZEIGER, durch alle Schichten** (Bus, Ergebnis,
  Protokoll, HTTP): „nicht gelesen" und „als 0 gelesen" sind verschiedene
  Tatsachen, und 0 ist ein WERT dieses Registers („darf gar nicht einspeisen").
- **Das Audit-Protokoll überlebt den Neustart** (`<data>/installer-write.json`,
  tmp+rename, gedeckelt, neueste zuerst) und zeichnet **jeden bestätigten
  Versuch** auf - auch Fehlschlag und Nicht-Übernahme, denn genau das ist der
  Eintrag, den eine spätere Untersuchung braucht. Ein Probelauf wird NICHT
  protokolliert (es gibt kein „nachher", und ein Log der Lesevorgänge begrübe
  die Schreibvorgänge).
- **⚠ ES GIBT KEIN FEATURE-FLAG MEHR (Captain-Korrektur 20.08.2026, D2
  KORRIGIERT).** `VP_INSTALLER_WRITE_ENABLED` ist ERSATZLOS entfallen - im
  Go-Core, in BEIDEN Composes und in `install.sh`: der Einmal-Schreibpfad ist
  auf **jeder** Box verfügbar, für BEIDE Türen, ohne Armierung und ohne
  `404`-Zustand. Das Flag gehörte zur Canary-Phase (der Portal-Konsument
  existiert ohnehin erst ab dem Kunden-Release) und war nie das, was den Pfad
  sicher macht. **Unverändert tragen ihn die INHALTLICHEN Tore:** die
  Zwei-Schritt-Strecke (Probelauf → wörtliche Bestätigung), `expected_before`,
  die Einmaligkeit, die Register-Allowlist + Wertgrenze bzw. die Lane-Politik
  des Portal-Wegs (Wertgrenzen, Selbstkonflikt-Sperre, LAN-only), das
  **Betreiber-Kennwort** am lokalen Schreib-Aufruf (`calGuard`,
  `X-VP-Calibration-Token`; die Nur-Lese-Sicht bleibt offen wie
  `GET /api/calibration`), Identität + `requested_at`-Fenster + RLS/JWT auf dem
  Portal-Weg, das Box-Audit + der D6-Uplink - und der **Cloud-Not-Aus der
  Plattform** (`voltpilot.register-write.enabled` am api) als Betriebs-Notbremse,
  die mit deutschem Grund refüsiert statt zu schweigen.
- **⚠ `gate_disabled` bleibt trotzdem im KONTRAKT** (`error_code`-Enum,
  `registerwrite.ErrGateDisabled`) und in der Cloud-Whitelist: eine Box mit
  ÄLTEREM Image kann das Wort noch senden, und die Cloud muss es weiter
  verstehen. Kein aktueller Build erzeugt es.
- **Eine bestätigte Rücklesung frischt `Snapshot.DeviceExportLimit` auf** -
  dasselbe Feld, das sonst der tägliche Lesevorgang füllt (EINE Wahrheit über
  die Grenze des Geräts, aufgefrischt von dem, der zuletzt gelesen hat).
- **Der Datenspiegel auf `:502` ist unberührt** und bleibt strukturell nur
  lesend (`MODBUS-SPIEGEL.md`): dieser Pfad läuft NICHT über ihn.
- Beweise: `internal/installerwrite` (Politik + Protokoll, u. a. „nur `Admit`
  baut einen `AdmittedWrite`") · `agent/installerwrite_test.go` (Probelauf vs.
  Bestätigung, GENAU ein Versuch, Nicht-Übernahme, stilles Gerät, gesperrte
  Familie erreicht den Bus nie, Einmal-Wächter, `WriteOnce` ist
  trigger-agnostisch und protokolliert NICHTS, veraltete Vorbedingung) ·
  `internal/web` (die Routen existieren OHNE Armierung, Kennwort-Tor,
  Fehler-Abbildung) · `internal/config` (es gibt keinen Umgebungs-Schalter mehr:
  jeder Wert lässt die Konfiguration byte-gleich) ·
  `nodered/inverter-control-routing.test.js` +
  `flows-sync.test.js` (die eingebettete Kopie == das Modul, Adresse/Obergrenze
  gepinnt, gleicher Tab wie der Poll) · `nodered/deye-control.e2e.test.js`
  (echter In-Process-Solarman-Logger: Probelauf schreibt nichts, die Bestätigung
  landet EINMAL als FC16 und liest 70,0 kW zurück, verschluckter Schreibvorgang,
  Ablehnungen ohne Geräte-Kontakt, belegter Socket, unerreichbar, veraltete
  Vorbedingung) · `vp-palette/test/nodes_spec.js`.

