# Der Downlink: das Geraet EMPFAENGT sein Ziel (und wendet es seit 26.08.2026 selbst an)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 30).


`internal/otatarget` (rein: Umschlag parsen + ablegen) + `agent/ota_target.go`.
Cloud-Seite, Tabellen und Rollout-Logik: root `AGENTS.md` „Edge-Updates: EIN
Schritt"; Betreiber-Ablauf: `docs/ota-autonomie.md`. Was hier gelten muss:

- **Der Downlink ist ein TRANSPORTWEG, keine Autoritaet.** Die
  Vertrauensentscheidung faellt unveraendert auf dem Geraet gegen die
  EINGEBACKENE Wurzel (`internal/otaverify`, Stufe 1); die Cloud prueft die
  Signatur bewusst nicht. Der Umschlag ist UNSIGNIERT - `release`/`release_seq`
  sind Routing und Diagnose, und sobald ein Manifest geprueft ist, gewinnt
  AUSSCHLIESSLICH dieses.
- **Abgelegt werden die ROHEN Umschlag-Bytes in EINER Datei**
  (`<data_dir>/ota/target.json`, atomar tmp+rename). Ein Umschlag, den wir
  zerlegen und neu zusammensetzen, koennte die Manifest-Bytes veraendern - und
  die Signatur geht ueber genau sie. Eine LEERE retained Nachricht nimmt die
  Zuweisung zurueck (Unclaim), dann verschwindet auch die Datei.
- **PRAEZEDENZ:** eine Cloud-Zuweisung gewinnt vor dem beaufsichtigten
  Dateipfad der Stufe 1 (`<data_dir>/ota/release.json`), der als Weg fuer den
  TOFU-Test und fuer eine Box ohne Cloud-Link bleibt. Es darf nur EIN Urteil im
  Herzschlag stehen.
- **Das Trust-Set kommt NICHT ueber den Downlink** (Widerrufs-Anker - derselbe
  Kanal waere eine Kreisabhaengigkeit); ohne abgelegtes Trust-Set lehnt der
  Verifizierer fail-closed ab und nennt das als Grund.
- **Die Zustaende, die diese Stufe meldet:** `deferred` + `target_verdict:"ok"`
  = geprueft, wartet auf den Menschen (der NORMALFALL, kein Fehler);
  `deferred` + `"deferred"` = Politik (Boden, Backend); `failed` +
  `"rejected"` = gebrochene Kette, also ein SICHERHEITS-Ereignis - und genau
  das Signal, auf das der Rollout im Portal automatisch anhaelt; `succeeded` =
  Ist == Soll, BELEGT aus dem laufenden Build-Stempel statt aus einer
  Buchfuehrung geglaubt.
- **`current_seq` wird nur gemeldet, wenn der aufgezeichnete Stand WIRKLICH
  laeuft** (`otaverify.ReleaseIsRunning` gegen `Version`) - eine von Hand
  hingelegte `current.json` eines fremden Standes faerbt die Flottensicht
  nicht ein. `last_known_good` bleibt weiterhin LEER: es gibt keinen
  Rollback-Mechanismus, und die laufende Version als solches auszugeben
  erfaende ein Rueckfallziel.
- **Der beaufsichtigte Anwendungspfad** ist `update.sh --from-target`: er liest
  ueber `GET /api/ota/target` genau die Artefakt-Digests, die DIESES Geraet
  verifiziert hat - bei `verdict != ok` gibt der Core sie GAR NICHT heraus, ein
  Lauf kann also nie etwas Ungeprueftes anwenden. Danach meldet er ueber
  `POST /api/ota/applied` zurueck; dieser Aufruf kann ausschliesslich
  BESTAETIGEN, was nachweislich laeuft (Release muss zur Build-Stempelung
  passen), und hebt den Anti-Rollback-Boden nur je AN - deshalb braucht er
  keine eigene Berechtigung. **Es gibt weiterhin keinen `:8484`-Knopf und
  keinen autonomen Apply** (Stufe 3).
- Beweise: `internal/otatarget/otatarget_test.go`,
  `internal/agent/ota_target_test.go` (u. a. bytegleiches Durchreichen,
  Idempotenz bei retained Wiederzustellung, gebrochene Kette = `failed` OHNE
  Digests, Boden = `deferred`, fremde Identitaet verworfen, Ruecknahme,
  Aufzeichnen nur des nachweislich Laufenden), Kontrakt-Beispiele PER PFAD.

