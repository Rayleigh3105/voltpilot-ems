# Die Signaturkette: das Geraet PRUEFT ein Release gegen seine eingebackene Wurzel

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 29).


`internal/otaverify` (rein, nur Standardbibliothek - der Core bekommt dafuer
KEINE neue Abhaengigkeit) + `agent/ota.go`. Vollstaendiges Bild inkl. Zeremonie:
root `AGENTS.md` „OTA Stufe 1" und [`docs/ota-signing.md`](../docs/ota-signing.md).
Was hier gelten muss:

- **Die Reihenfolge in `Verify` ist bindend:** gebackene Wurzel -> Trust-Set
  gegen die Wurzel -> Manifest gegen den Release-Schluessel -> ERST DANN parsen
  -> ERST DANN Politik. Die zu pruefenden Bytes gehen NIE durch einen Parser,
  bevor die Signatur stimmt, und ein `rejected` reicht das Manifest nicht weiter.
- **`otaverify.SigningInput` ist die EINZIGE Stelle**, an der die zu
  signierenden Bytes entstehen (`kontext || dateibytes`). Signierwerkzeug
  (`cmd/vp-ota`) und Geraet rufen dieselbe Funktion - wer hier etwas
  normalisiert, bricht beide Seiten gleichzeitig und lautlos.
- **`rootkeys.json` wird per `go:embed` eingebacken** und ist bis zur Zeremonie
  LEER = fail-closed. Kein env-Schalter, kein Pfad, keine Laufzeit-Injektion im
  Produktionspfad: der Agent hat NUR `a.otaRoots` als TEST-Naht (nil = die
  gebackene Wurzel). Ein env-gesetzter Vertrauensanker waere genau die
  Vertrauensuebernahme, gegen die die kalt/heiss-Trennung gebaut ist.
- **`agent/ota.go` liest Dateien und bildet eine Meinung - mehr nicht.**
  `<data_dir>/ota/{release,trust-set}.json(.sig)`, 30-s-Takt, mtime+Groesse als
  Stempel (eine unveraenderte Datei wird nicht neu geprueft). Ergebnis: der
  bestehende `update`-Block (`state` zurueck auf `idle` + deutscher `reason`)
  plus `ota_state`/`ota_reason` in `/health` - der Endpunkt, den ein
  beaufsichtigter Test OHNE Cloud-Verbindung abfragt.
- **`current.json` wird nur GELESEN.** Nichts auf dem Geraet schreibt den
  eigenen Release-Stand, bevor ein Update wirklich angewandt und bestaetigt
  wurde (Stufe 3) - fehlt er, meldet der Verifizierer ehrlich „Boden nicht
  bewertbar" statt eine Sequenznummer zu erfinden. Stufe 3 darf ihn nur je
  ERHOEHEN.
- **`updateSummary()` erfindet weiterhin nichts**: kein `current_seq` (auch
  nicht aus `current.json` - das ist ein lokaler Boden-Eingang, nicht die
  Ordnung des Cloud-Registers), kein Ziel, kein `last_known_good`. Und der
  Zustand bleibt nach der Pruefung `idle`: `verifying` ist TRANSIENT, ihn
  danach zu melden behauptete eine laufende Taetigkeit.
- Beweise: `internal/otaverify/verify_test.go`, `cmd/vp-ota/main_test.go`,
  `internal/agent/ota_verify_test.go`.


