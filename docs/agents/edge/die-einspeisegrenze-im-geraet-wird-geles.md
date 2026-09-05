# Die Einspeisegrenze IM GERÄT wird GELESEN — höchstens einmal am Tag, auf dem BESTEHENDEN Leseplan

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 56).


„Grenzen & Wächter" Stufe 0 / Vierer #4 (Cloud-Seite + Feldnamen: Root-`AGENTS.md`;
Anlass: Herzogau Runde 2 §3 K1 — der Deye hielt 33,0 kW in `0x00E7`, während im
Portal 70 kW hinterlegt waren, und das war zwei Untersuchungsrunden lang
unsichtbar, weil niemand das Register las). Was hier gelten muss:

- **⚠ EIN SOCKET-GESETZ, und deshalb hat dieser Pfad KEINE eigene I/O.** Der
  Router (`nodered/inverter-routing.js` `DEYE_EXPORT_LIMIT` /
  `shouldReadExportLimit`, verdrahtet im `auto-router`-Knoten) hängt das Register
  als EINEN zusätzlichen FC3-Umlauf an den vorhandenen Leseplan — dieselbe
  Disziplin wie die gelernten Spiegel-Blöcke (höchstens einer je Zyklus, NACH den
  Primärblöcken, innerhalb derselben sv5-Sperre, die Steuer-Schreibvorgängen
  weicht). Der Wert kommt in der retained `edge/registers/raw` an, die der Poll
  ohnehin veröffentlicht; `agent/exportlimit.go` ist damit nur ein weiterer LESER
  von Bytes, die schon auf dem Bus lagen — kein neuer TCP-Pfad, kein neues
  Bus-Topic, kein neuer Palette-Knoten, kein Extra-Takt.
- **⚠ Die REGISTERKARTE ist ein cross-side Zwilling:** `DEYE_EXPORT_LIMIT` (JS,
  baut den Leseplan) ⟷ `inverter.exportLimitRegisters` (Go, DEKODIERT das Wort).
  Adresse UND Skala müssen übereinstimmen, sonst ist die Kundenzahl 10x falsch;
  `TestExportLimitRegisterMatchesTheNodeRedTable` liest die JS-Datei per PFAD und
  vergleicht. **Beide zusammen ändern.** Der Router bekommt die Tabelle beim
  Generieren aus dem Modul eingesetzt (`build-flows.js` `require`t es), damit die
  inline Kopie nicht driften kann.
- **⚠ `hybrid_1p` wird AUSDRÜCKLICH nicht gelesen — das ist die Ehrlichkeitsregel
  des Features, keine Auslassung.** Dort IST die Einspeisegrenze „Max Sell Power"
  (`0x00F5`), das Register, das unser EIGENER Entlade-Hebel schreibt
  (`inverter-control-routing.js` `DEYE_CONTROL_REG.hybrid_1p`); es zurückzulesen
  hieße, unseren Befehl als „Grenze des Geräts" zu melden. Eine Familie, die wir
  nicht ehrlich lesen können, meldet NICHTS, und jede Fläche sagt dann
  „unbekannt".
- **Der Zeitstempel wird beim VERSUCH gesetzt** (der Router sieht das Ergebnis
  nicht) — ein Fehlschlag wird morgen erneut versucht, die Lastgarantie bleibt
  „ein Umlauf pro Tag". Ein Node-RED-Neustart leert den Flow-Kontext, nach jedem
  Neustart kommt also ein frischer Wert; eine RÜCKWÄRTS gesprungene Uhr (ein Pi
  ohne gepufferte Uhr beim ersten NTP-Abgleich) sperrt die Lesung nicht aus.
- **Was NICHTS liest, behauptet NICHTS** (`agent.noteDeviceExportLimit` → `nil`):
  keine Auswahl, eine Familie ohne belastbares Register, ein Block mit
  Lesefehler, ein Block von einem ANDEREN Slave, oder das Register war in diesem
  Zyklus gar nicht dabei (der Normalfall). `nil` heißt „wir wissen es nicht", nie
  „das Gerät hat keine Grenze" — und der VORHERIGE Wert bleibt stehen. Ein
  gelesenes **0 kW ist ein WERT** („darf gar nicht einspeisen"), keine Lücke.
- **Anzeige:** `Snapshot.DeviceExportLimit` → additiv im `curtailment`-Block des
  Herzschlags (mit EIGENEM `device_export_limit_read_at` — `checked_at` ist der
  Rücklese-Stempel der Abregel-Einheiten und wäre hier eine falsche
  Frischezusage) und als Zeile auf der PV-Abregelungs-Karte
  (`control.js VPControl.deriveDeviceExportLimit`; die AUSSAGE steht immer, das
  REGISTER ist der Beleg und bleibt Technikmodus). `static/*` ist
  `//go:embed`-ed — Kern nach jeder Änderung neu bauen.
- Beweise: `internal/inverter/exportlimit_test.go` · `internal/agent/device_export_limit_test.go`
  (die Herzogau-Lesung durch den ECHTEN Bus-Handler + jede Schweige-Regel) ·
  `nodered/mirror-poll.e2e.test.js` (echter Solarman-Logger: der Umlauf findet
  statt, byte-getreu, und nur täglich) · `inverter-routing.test.js` /
  `flows-sync.test.js` · `internal/web/jstest/ui.test.js` + `web_test.go`.

