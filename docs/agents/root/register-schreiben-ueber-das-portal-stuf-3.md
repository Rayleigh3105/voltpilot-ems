# Register schreiben über das Portal, Stufe 2 (Cloud): Register-Wissen, Picker, Zähler

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 99).


Die Cloud-Hälfte der Stufe 2 (Konzept `data/vp-reg-schreib-konzept-p8` §2.3,
§2.5; Box-Hälfte im Abschnitt davor). Sie fügt **keinen Schreibpfad** hinzu -
nur das, was ein Mensch VOR dem Klick wissen muss, und die Lane-Felder, mit
denen er sein Ziel wählt.

- **Das Register-Wissen ist eine DATEN-Ressource** (`registerknowledge/catalog.json`,
  das `entitytypes/catalog.json`-Muster) mit dem Deye-Erstbestand, und
  `RegisterKnowledge` ist seither eine `@Component` statt einer statischen
  Klasse. **⚠ Die Register-FAKTEN gehören dem Repo, nicht der Ressource:** sie
  stammen aus `edge-app/nodered/inverter-control-routing.js` (`DEYE_CONTROL_REG`)
  und `DEYE.md` - wer sie dort ändert, ändert sie hier mit, sonst behauptet das
  Portal einen Namen, den das Gerät nicht trägt.
- **⚠ DIE FAMILIE IST TEIL DES SCHLÜSSELS.** Auf `hybrid_1p` ist die
  Einspeisegrenze ein ANDERES Register mit ANDERER Skala (`0x00F5`, Skala 1) als
  auf `hybrid_3p` (`0x00E7`, Skala 10) - eine adress-pauschale Aussage wäre auf
  der halben Flotte falsch. Die Familie kommt aus dem, was die Box meldet
  (`entity_observed_state`, `local_setup` - also hängt die Beschriftung am
  Flag `VOLTPILOT_ENTITIES_MQTT_LISTENER_ENABLED`, in BEIDEN Composes an), mit
  der gespeicherten Komponenten-Definition als zweiter Quelle.
- **⚠ DIE WARNUNG VERALLGEMEINERT, DER NAME NICHT** - die eine Asymmetrie von
  `RegisterKnowledge.of`: eine Adresse, die auf IRGENDEINER bekannten Baureihe
  zur Netz-Anmeldung gehört, behält ihre Klasse (und damit die D5-Notizpflicht)
  auch ohne gemeldete Familie; NAME und SKALA reisen dabei NICHT mit. Sonst
  schaltete sich die Pflicht genau auf den Anlagen still ab, deren Box ihre
  Einrichtung nicht meldet - und ein Deye-Name auf einem fremden Modbus-Gerät
  wäre die gefährlichste Auskunft dieses Pfades.
- **Der Geräte-Picker erzeugt KEINE neue Wahrheit** (`RegisterWriteTargets`,
  `GET /sites/{id}/register-write/targets`): je Gerät die primäre Lane, jede
  portal-verwaltete Komponente als `entity`, und jede von der Box gemeldete
  QUELLE als vorbefüllte `lan`-Adresse (sie ist keine Entität, hat also keine
  Kennung, über die die Box sie auflösen könnte). Ein Gerät, das schon als
  Komponente angeboten wird, erscheint nicht ein zweites Mal als freie Adresse.
  **Ein Gerät OHNE Schreibweg wird GENANNT** (`writable:false` + `reason`) -
  `writable` ist eine ANZEIGE-Hilfe, kein Tor.
- **Der Schreibzähler zählt ANFORDERUNGEN, nicht Quittungen**
  (`RegisterWriteEventRepository.countWritesToday`, Berliner Tag): ein
  Schreibvorgang, dessen Antwort verloren ging, kann angekommen sein - ihn nicht
  mitzuzählen machte die Zahl kleiner, als das EEPROM sie erlebt hat. Er steht
  in der VORSCHAU, also vor dem Klick.
- **Die Lane ist eine WAHL, nie ein Default im Verborgenen:** absent = `primary`
  (ein älterer Client arbeitet zeichengleich weiter), ein unbekanntes Wort ist
  **400** und nie ein stiller Rückfall auf die primäre Lane - der würde einen
  Schreibvorgang auf ein ANDERES Gerät umlenken als gewählt. Bei `entity` reist
  NUR die Kennung; das Journal speichert die Lane seither im Kontrakt-Vokabular
  (`primary|entity|lan`), auch auf dem D6-Uplink.
- **Jede POLITIK gehört weiterhin der BOX.** Die api löst auf, WER gefragt wird,
  und reicht weiter, WAS gefragt wurde; ob die Adresse freigegeben ist, ob das
  Ziel im Kunden-LAN steht und ob die Steuerung das Register besitzt, entscheidet
  das Gerät. Die EINE Regel, die hier lebt, ist die Notiz-Pflicht (D5).
- **Beweise:** rein `RegisterKnowledgeTest` (11, u. a. dieselbe Adresse auf zwei
  Baureihen und die Warnungs-Asymmetrie) · `RegisterWriteTargetsTest` (7) ·
  `RegisterWriteUplinkListenerTest` (8) ; Testcontainers `RegisterWriteApiTest`
  (8, davon 2 neu: der Picker samt Register-Wissen über einen ECHTEN Herzschlag,
  und die zwei Lanes bis auf den Draht inkl. Schreibzähler und der drei
  Lane-Ablehnungen). Portal-Seite in `frontend/portal/AGENTS.md`.

