# Der SCHALT-Test und der Schalt-Executor (Einheitsmodell Stufe 4)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 55).


Der Weg, auf dem ein selbst gebautes Modbus-Gerät schaltbar wird. Die Regeln, die Verträge und die
Portal-Seite stehen in der Root-`AGENTS.md`; hier nur, was am Gerät gilt.

- **⚠ DIE REIHENFOLGE IST DIE SICHERHEIT: `agent/switchtest.go` armiert das automatische Aus, BEVOR
  es schreibt** (`armSwitchWatchdog` → `switchExchange`), nicht nachdem der Schreibvorgang gelungen
  ist — das Kalibrier-Muster `time.AfterFunc`. Daraus folgt die Regel, die man beim Aufräumen
  zerstören würde: **ein FEHLGESCHLAGENER Test behält seinen armierten Wachhund**, denn der
  Schreibvorgang kann angekommen sein und nur seine Antwort verloren haben. Ein `switch_cancel`
  entwaffnet ihn und schreibt den Sicherheitswert sofort — und **er trägt das Register vollständig
  mit**, statt sich auf einen gemerkten Zustand der Box zu verlassen (ein Neustart darf einen
  Abbruch nicht verschlucken).
- **Der Core öffnet KEINEN Modbus-Socket** — auch hier nicht. Der Test reist über ein EIGENES
  Bus-Topic-Paar `edge/switch/request|result` zum Palette-Knoten `vp-modbus-switch-test`; das
  Lese-Paar der Vorschau (`edge/probe/*`, `vp-modbus-probe`) bleibt damit per KONSTRUKTION
  schreibfrei, statt per Konvention. Gepinnt von `TestProbeNeverDialsTheDeviceFromTheCore`.
- **Ein Socket, eine Warteschlange:** Test-Knoten UND Executor schreiben über `lib/modbus-conn.js`
  (neu `writeValue`/`readCoils` neben `readRegisters`), also durch dieselbe in-flight-Sperre je
  (host, port) wie jeder Lesevorgang. Nie ein zweiter TCP-Pfad zum selben Gerät.
- **Der Anlagen-Not-Aus erreicht Node-RED über `edge/control/gate`** (retained, vom Kern
  veröffentlicht: `VP_CONTROL_ENABLED ∧ VP_CONSUMER_CONTROL_ENABLED`). Er ist ein EIGENES Topic,
  weil das `control_enabled` des Entitäts-Kommandos die WECHSELRICHTER-Zertifizierung trägt und
  hier die falsche Frage beantwortet. Der Executor ist fail-closed: ohne Dokument schreibt er nicht.
- **Der Executor `vp-modbus-switch` ist GENERIERT und schreibt nur Freigegebenes:** Ein/Aus nur die
  zwei Konstanten, Sollwert nur innerhalb der Klemme — und **der Sicherheitswert wird NICHT ins
  Betriebsband geklemmt** (`safeValue` nutzt `rawOf`, nicht `toRaw`), sonst würde aus „aus" ein
  „lauf langsam weiter". Er re-assertiert im 60-s-Takt und schreibt bei Kommando-Rückzug oder
  Staleness (180 s) AKTIV den Aus-/Sicherheitswert; das optionale Watchdog-Register des Geräts
  bedient er im selben Takt. Readback publiziert er selbst auf `edge/entities/{id}/readback` im
  v1-all_match-Format (**nicht mit `vp-control-readback` verwechseln** — das bedient den
  Primär-Wechselrichter).
- **Eine Spule ist das EINE Modbus-Objekt, dessen Drahtform nicht ihr Wert ist** (`0xFF00` = EIN):
  `buildWriteCoilRequest` nimmt deshalb einen BOOLEAN. FC16 ist die Vorauswahl fürs Register, nicht
  FC6 (die Fronius-/Deye-Lektion).
- **Beweise:** `internal/probe` (Zulassung erbt jede Lese-Regel + FC↔Registerart, Spulen-Werte 0/1,
  TTL-Grenzen) · `agent/switchtest.go`-Fälle · Palette `test/switch_spec.js` (die GETEILTE
  Warteschlange gegen ein in-process-Gateway; „ein Gerät, das den Schreibvorgang schluckt, fällt am
  Rücklesen auf, nicht am Echo") · `modbus-tcp` Coil-Frames.

