# Stufe 2 „Freie Register": die Allowlist wird durch LANE-Regeln abgeloest

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 62).


Die harte `0x00E7`-Allowlist des Portal-Kanals ist WEG - angekuendigt, nicht
unterlaufen: der Vorgaenger-PR schrieb selbst, ein weiteres Register sei „eine
Code-Aenderung hier, mit eigenem Review". Cloud-Seite (Register-Wissen,
Geraete-Picker, Warnklassen): root `AGENTS.md`. Was HIER gelten muss:

- **⚠ ZWEI UMFAENGE, EINE POLITIK-SCHICHT.** `installerwrite.Admit` bleibt der
  ENGE Umfang der `:8484`-Taste (genau das Export-Limit-Register, Deckel 7000,
  kW-Kopie - ihre Oberflaeche ist ein Werkzeug fuer EINE Zahl); `AdmitExpert`
  (`installerwrite/expert.go`) ist der Umfang des PORTAL-Kanals (freies
  Holding-Register bzw. Spule, Wert 0..65535, Spule 0/1, Funktionscode passend
  zur Registerart). Beide bauen DIESELBE `AdmittedWrite` mit unexportierten
  Feldern und teilen Bestaetigungs-Token, `expected_before`-Schranke und
  Einmaligkeit WOERTLICH - es gibt weiterhin genau zwei Konstruktoren und keinen
  Weg an ihnen vorbei.
- **⚠ Ein Probelauf hat KEINEN Schreibwert** (Produktionsbefund 28.08.2026,
  Palette **0.9.1**): der Cloud-Vertrag verbietet `value` bei `mode=lesen`, der
  Core serialisiert die Abwesenheit auf dem lokalen Bus als harmlose `0`. Der
  alte Palette-Eingang prüfte dort noch die enge `:8484`-Regel `1..7000` und
  verwarf deshalb JEDE Portal-Lesung still; der Core lief nach 30 s in den
  Timeout, während Beobachtungen über den Poll normal funktionierten.
  `vp-installer-write-request.parse` akzeptiert jetzt Dry-Runs ohne Wert bzw.
  mit `0` und den freien Holding-Umfang 0..65535. Gepinnt in `nodes_spec.js`
  plus `TestThePortalTriggerPreviewsThenWritesOnceThroughTheSharedCore` (der
  Bus-Auftrag trägt bei der Vorschau ausdrücklich `Value=0`).
- **DREI LANES, UND DIE ASYMMETRIE IST DIE SICHERHEIT** (`agent.resolveRegisterTarget`):
  `primary` - die Cloud nennt NICHTS, die Box nimmt ihren eigenen konfigurierten
  Wechselrichter; `entity` - die Cloud nennt nur eine Kennung, den Endpunkt loest
  die Box aus IHRER angewandten Registry auf; `lan` - nur hier reist der
  Endpunkt, und nur hier muss die Box ihn deshalb selbst beurteilen
  (`probe.IsPrivateHost`, der FUENFTE Konsument von
  `docs/contracts/lan-host-vectors.json` - kein fuenfter Zwilling, und der
  Palette-Knoten prueft es vor dem Waehlen ein ZWEITES Mal).
- **⚠ Die Entitaets-Aufloesung geht bewusst NICHT ueber
  `componentapply.ParseDriver`:** der SKIPPT ein Selbstbau-Geraet (sein Leseplan
  reist als generierter Flow), und genau so ein Geraet will ein Kunde
  beschreiben. Eine Komponente am SOLARMAN-Logger wird BENANNT auf die primaere
  Lane verwiesen - dieser Socket gehoert dem Wechselrichter-Tab, ein zweiter
  Anspruch darauf ist genau das, was das Ein-Socket-Gesetz verbietet.
- **⚠ Die SELBSTKONFLIKT-SPERRE gilt dem GERAET, nicht der Zahl**
  (`agent.targetIsPrimary`): das Steuer-Rueckelesen nennt die Register, die
  unser Executor auf dem PRIMAER-Wechselrichter schreibt; dieselbe Nummer auf
  einem eigenen Modbus-Geraet des Kunden ist ein voellig anderes Register, und
  sie zu verweigern waere ein erfundener Konflikt.
- **Die Spulen-Regel ist eine Eigenschaft der LANE**: die Solarman-V5-Rahmen
  kennen nur die Holding-Funktionen (`not_supported`, ehrlich benannt), auf
  schlichtem Modbus-TCP gibt es FC1/FC5 und eine Spule ist ein Objekt wie jedes
  andere.
- **Der MECHANISMUS bekam einen zweiten Transport, keinen zweiten Pfad**:
  `Agent.WriteOnce` verzweigt auf `edge/installer-write/*` (Solarman, der
  Flow-Kontext-Lock des Wechselrichter-Tabs) bzw. das NEUE Paar
  `edge/register-write/*` (Palette-Knoten `vp-register-write`, Palette 0.9.0).
  Die Nachrichten-FORM ist byte-gleich, `onInstallerWriteResult` bedient beide -
  eine spaeter ergaenzte Lane kann keine zweite Korrelations-Mechanik bekommen.
- **⚠ `vp-register-write` ist die Stufe-4-Schreibmechanik OHNE Auto-Aus**, und
  deshalb ein EIGENER Knoten neben `vp-modbus-switch-test`: dort ist das
  Zuruecklaufen der Zweck, hier das Stehenbleiben. Ein Auto-Aus-Flag auf EINER
  Funktion waere einen Tastendruck davon entfernt, eine Installateurs-
  Einstellung still zurueckzudrehen. Beide gehen durch `lib/modbus-conn.js`
  (EIN Socket je Ziel) und teilen `switch-write.classify`.
- **Ein Register ohne bekannte Skala bekommt KEINE erfundene Einheit** - weder
  im Plan (`installerWriteRoute` setzt `scale`/`kw` nur fuer das Register, dessen
  Skala die READ-Tabelle der Familie nennt) noch im Audit-Protokoll
  (`Entry.Kw` ist ein ZEIGER und fehlt dann).
- Beweise: `internal/installerwrite/expert_test.go` (5) ·
  `internal/registerwrite` (die drei Lanes, die LAN-Whitelist, die Spulen-Regel,
  die Kontrakt-Vorgaben, zwei neue Fixtures per PFAD) ·
  `agent/register_write_test.go` (+6: freies Register, jedes Registerwort, die
  Entitaets-Aufloesung, die benannte Solarman-Komponente, die freie LAN-Lane,
  die geraete-bezogene Sperre) · `vp-palette/test/register_write_spec.js` (10) ·
  `nodered/inverter-control-routing.test.js` + `flows-sync.test.js`.

