# edge-app — Project agent memory (Wegweiser)

**Diese Datei wird beim Arbeiten in `edge-app` in den Kontext geladen** (`CLAUDE.md` ist ein
Symlink darauf). Sie ist ein WEGWEISER: hier steht, was fast jede Edge-Sitzung braucht; jedes
Detail wohnt byte-verbatim in `docs/agents/edge/` und ist über den **Themen-Index** unten zu
finden. **Nie eine `docs/agents/`-Datei ganz lesen — greppen.**
Plattform-Wissen (Dienste, Verträge, Migrationen): `../AGENTS.md`.

## Was das ist

Die **installierbare Kunden-Box**, ein Docker-Compose-Paket aus zwei Schichten.
Sie ist NICHT `edge/` (die dünne Dev-Edge des Cloud-Stacks) und NICHT
`tools/edge-simulator` (ein reiner MQTT-Publisher) — die drei nie verwechseln.

- **Layer 2 `core/` (Go, `vp-edge-core`)** — bei jedem Kunden identisch und das EINZIGE, das
  mit der Cloud spricht: Erst-Enrollment über HTTPS, EINE ausgehende mTLS-MQTT-Verbindung,
  Store-and-forward-Puffer, Fahrplan-Zwischenspeicher + Ausführung, die Wächter
  (`internal/guards`), der eingebettete lokale MQTT-Bus, das lokale Web unter `:8484`,
  das OCPP-CSMS (`internal/csms`) und der OTA-Pfad.
- **Layer 1 `nodered/`** — die je Kunde verdrahtete I/O-Schicht: Palette `vp-*`, Treiber
  (Deye/Solarman-V5, Fronius, KACO, KOSTAL, SunSpec, go-e, Shelly, generisches Modbus),
  Mess-/Steuer-Flows. Vom VoltPilot-Team verdrahtet, nie vom Kunden.

## Bauen & testen

```bash
(cd core && go test ./...)                 # + `-race` im Tag-Gate
(cd nodered && npm test)                   # NICHT `node --test` an der Wurzel: sammelt vp-palette mit ein
(cd nodered/vp-palette && npm ci && npm test)
test/e2e-compose.sh        # isoliertes Compose-Rig (Docker, eigener Projektname + hohe Ports)
test/e2e-v2-compose.sh     # v2-Strecke: Registry → Flow → Wunsch → Arbitrierung → Wächter → Schreiben
test/e2e-ocpp.sh           # Lastmanagement-/Ladepark-Rig — DOCKER-FREI, misst an den Zählern
test/install-selfcheck.sh  test/update-selfcheck.sh   # Installer/Updater gegen echten Docker
```

⚠ `core/internal/web/static/*` ist `//go:embed`-t — nach jeder UI-Änderung das Core-Binär neu
bauen (`go test ./internal/web` bettet neu ein), sonst liefert der laufende Prozess das ALTE
Blatt aus. Ein Node-RED-Flow ist selbstenthaltenes JSON und kann keine Repo-Datei `require`n:
die Funktionsknoten tragen SYNCHRONISIERTE Kopien der Module, `flows-sync.test.js` ist der
Drift-Wächter, und `nodered/build-flows.js` erzeugt `flows.json` (nie von Hand editieren).

## Die harten Hausregeln

- **Der Edge rechnet NIE mit Preisen.** Die Wolke entscheidet die Ökonomie und markiert den
  Slot; die Box setzt das gegen ihre GEMESSENEN Werte durch. Eine Preisregel auf der Box wäre
  eine zweite Preiswahrheit.
- **Jeder Sollwert läuft durch `guards.Clamp`** (Nennband, SoC-Fenster, §14a-Hülle,
  EEG-Solarladen) — kein Pfad schreibt daran vorbei. Wer eine Richtung aus der Ruhe STARTET,
  braucht zusätzlich ein frisches Rücklesen und die Schreib-Tore.
- **Blind heißt INAKTIV — außer bei einer Compliance-Grenze.** Ein ökonomischer Wächter, dem
  die Messung fehlt, hält still; eine Einspeise-/Netzgrenze zieht sich stattdessen auf eine
  sichere statische Kappe zusammen und gibt NIE frei.
- **Ein Fehlschlag ist nie ein erfundener Wert.** Kein Sample ohne echte Lesung, keine
  fabrizierte 0, ein unplausibler Wert wird VERWORFEN (Lücke) statt gezeigt. Schweigen ist
  keine Aussage: „nicht bestätigt" ≠ „abweichend".
- **EIN Socket je Wechselrichter, mit Warteschlange.** Lesen, Vorschau, Steuern und
  Einmal-Schreiben teilen sich dieselbe Lane je (Host, Port); wer freigibt, ÜBERGIBT.
  Ein zweiter TCP-Pfad zum selben Gerät ist die dokumentierte Kollisionslektion.
- **Ein Rücklesen ist ein SEMANTIK-Vergleich, kein Zahlenvergleich**, und es wird entprellt.
- **Die Freigabe kommt aus dem KERN, nie aus einem Layer-1-Stempel.** Zertifizierung hat zwei
  Hälften (Flotten-Allowlist + Laufzeit-Freigabe je Gerät); ein Prüfstands-Beleg deckt genau
  das Modell, das auf dem Tisch stand.
- **Ein `.env`-Schalter muss in der Compose auch WEITERGEREICHT werden** — sonst ist er in
  Produktion nachweislich wirkungslos. Not-Aus-Flags haben die Vorgabe AN.
- **Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben**; Umbenennen ist
  label-only.
- **Ein SELBSTBAU-Gerät darf den Registry-Push nie scheitern lassen** — die Ableitung ist
  alles-oder-nichts, ein unbekannter Typ wird ÜBERSPRUNGEN, nicht abgelehnt.
- **Wer etwas ANDERES entwertet, nennt die Folge VORHER** (`static/consequences.js`).
- **Eine Edge-Änderung wirkt erst mit dem nächsten Edge-Release** — eine laufende Box behält
  ihr Image und überliest jedes neue Vertragsfeld. Verträge sind deshalb additiv.

## Rig- und CI-Fallen (gemessen, nicht vermutet)

Der Forgejo-Runner fährt selbst in einem Container am Docker-Socket des HOSTS: ein
veröffentlichter Port und ein Bind-Mount aus dem Workspace gehören dem HOST, nicht dem Job —
Dateien kommen über einen BUILD-KONTEXT herein, Anfragen laufen als Seitenwagen IM
Compose-Netz. Der Runner läuft als ROOT: ein Fehlschlag darf nie über Dateirechte erzwungen
werden, sondern über eine TYP-Kollision. Ein Test, der auf die Zustellreihenfolge zweier
I/O-Ereignisse baut, ist ein Rennen; eine Frist wird gegen eine INJIZIERTE Uhr geprüft, nie
gegen ihren eigenen Timer. Details: der Themen-Index unten und `../AGENTS.md` „Lieferweg".

## Themen-Index (der ausgelagerte Bestand)

Jede Zeile ist ein frueherer Abschnitt DIESER Datei. Der Text ist unveraendert, er
wohnt nur woanders. **Alle Pfade unten sind relativ zu `../docs/agents/edge/`.**
**Nicht ganze Dateien in den Kontext lesen - greppen.** Inhaltsverzeichnis aller
Bereiche: `../docs/agents/README.md`.

- **Cloud host is re-read on reconnect; default portal is `portal.voltpilot.de`** — Two prod-hardening facts baked into the enroll/config layer … · `cloud-host-is-re-read-on-reconnect-defau.md`
- **install.sh / update.sh: shared compose template (lockstep chain)** — update.sh (the one-command edge updater) sources install.sh … · `install-sh-update-sh-shared-compose-temp.md`
- **Node-RED SunSpec polls: never overlap, never silent (real device-down 2026-07-13)** — A full SunSpec model-discovery walk on a REAL Fronius (many … · `node-red-sunspec-polls-never-overlap-nev.md`
- **Node-RED source chain: palette validation is STRUCTURAL only, trace every decision (2nd real device-down 2026-07-13)** — The SAME device stayed pending even after the overlap fix … · `node-red-source-chain-palette-validation.md`
- **`fronius_sunspec` PV source: AC only for a BATTERYLESS inverter (Model 124 gate)** — sunspec/sunspec-live.js decodeInverter publishes … · `fronius-sunspec-pv-source-ac-only-for-a.md`
- **House-consumption STANDARD (captain decree 2026-07-17) + battery-power sourcing** — Haus = Erzeugung − Einspeisung − Batterie is THE rule for … · `house-consumption-standard-captain-decre.md`
- **Multi-source fold: composition changes are EXPLAINED steps (3rd real device bug 2026-07-17)** — The captain's two-Fronius-at-one-Datamanager site … · `multi-source-fold-composition-changes-ar.md`
- **E2 flow platform core: arbitration + flow deployment (fm/vp2-e2-flow-core)** — The v2 runtime slice on top of E1a · `e2-flow-platform-core-arbitration-flow-d.md`
- **Verbrauchssteuerung Inkrement 3 (edge half): cycle guard + consumers heartbeat + simulator** — Full picture in the root AGENTS.md "Steuerbare Verbraucher … · `verbrauchssteuerung-inkrement-3-edge-hal.md`
- **Verbrauchssteuerung Inkrement 6 (edge half): the deadline fallback** — Full picture in the root AGENTS.md "Steuerbare Verbraucher … · `verbrauchssteuerung-inkrement-6-edge-hal.md`
- **Verbrauchssteuerung Inkrement 4 (edge half): the generated reactive rule** — Full picture in the root AGENTS.md "Steuerbare Verbraucher … · `verbrauchssteuerung-inkrement-4-edge-hal.md`
- **E1b entity generalization (edge half): open types, capability guards, v2 buffering** — Extends the E1a entity layer (root AGENTS.md "v2 entity … · `e1b-entity-generalization-edge-half-open.md`
- **Topology-Quellen-Fill über den Registry-Pin (D-17, vp-vier-erzeuger-p9 PR 4a)** — Der Registry-Push-Descriptor trägt seit D-17 optional … · `topology-quellen-fill-ueber-den-registry.md`
- **Anlagen-Topologie-Read-Model (AE1, edge half)** — internal/topology is the CANONICAL copy of the shared … · `anlagen-topologie-read-model-ae1-edge-ha.md`
- **Local entity composition (M-B3-local): the :8484 view of a MIGRATED plant** — A v1→v2 migrated plant gets its entity registry pushed, so … · `local-entity-composition-m-b3-local-the.md`
- **The `:8484` web app: TWO pages + Technikmodus (concept `data/vp-edge-ux-concept/concept.html`)** — The device page is Betrieb (start page, customer-grade … · `the-8484-web-app-two-pages-technikmodus.md`
- **AE6 :8484 adaptive energy picture (edge half of AE2/AE3)** — static/dashboard.js renders the topology block … · `ae6-8484-adaptive-energy-picture-edge-ha.md`
- **go-e Charger read-only driver (consumer source, HTTP API v2)** — A go-e wallbox is a READ-ONLY CONSUMER source … · `go-e-charger-read-only-driver-consumer-s.md`
- **go-e Charger CONTROL adapter (certified, arbiter-driven, single-writer)** — The write/execution counterpart to the read-only go-e … · `go-e-charger-control-adapter-certified-a.md`
- **Shelly relay CONTROL driver (consumer, core-owned socket, dead-man timer)** — Shelly). internal/shelly owns transport + mapping … · `shelly-relay-control-driver-consumer-cor.md`
- **First-Light calibration: the guided, bounded first real write to a live battery** — The safe on-device surface (:8484 „Steuerung kalibrieren") … · `first-light-calibration-the-guided-bound.md`
- **Probe-Kanal: eine Vorschau darf dem Poll nie den Socket wegnehmen (Stufe 0b)** — Vollstaendiges Bild (Vertrag, api-Route, Regeln): root … · `probe-kanal-eine-vorschau-darf-dem-poll.md`
- **vp-mqtt-read (P5 Ebene 1): die selbst angebundene Batterie auf der Box** — Palette 0.10.0, EIN Knoten je Geraet, Aggregat min/max ueber viele Topics; ⚠ `mqtt_local` muss auf der Box sein, BEVOR die Cloud eine solche Batterie anlegt · `vp-mqtt-read-p5-die-selbst-angebundene.md`
- **vp-modbus-read (MB-M1): generic Modbus flow read + the shared connection manager** — Palette 0.3.0 adds nodes/vp-modbus-read.js (catalog type … · `vp-modbus-read-mb-m1-generic-modbus-flow.md`
- **Quellen-Identität ist DETERMINISTISCH; Umbenennen ist label-only (vp-vier-erzeuger-p9)** — sources.DeterministicID leitet die Quellen-ID aus der … · `quellen-identitaet-ist-deterministisch-u.md`
- **Der Katalog hat DREI Dimensionen: Geraetetyp · Marke · Modell (und der WEG gehoert dem Modell)** — Katalog-Neustruktur (Konzept data/vp-anlegen-rework/konzept. … · `der-katalog-hat-drei-dimensionen-geraete.md`
- **⚠ Wer `DefaultCatalog()` ändert, exportiert die Vorlagen neu** — Seit Einheitsmodell Stufe 0a existiert der Geräte-Katalog … · `wer-defaultcatalog-aendert-exportiert-di.md`
- **Eine Batterie OHNE gekoppeltes BMS: das SoC-Gate wird PRÄZISE, nicht weich** — BMS nicht am Wechselrichter hängt. 0x024C liest dauerhaft … · `eine-batterie-ohne-gekoppeltes-bms-das-s.md`
- **Der Build-Stempel reist IMMER mit (OTA Stufe 0 „Sehen")** — Bis dahin ritt core_version NUR im flows-Ack-Block — und … · `der-build-stempel-reist-immer-mit-ota-st.md`
- **Die Signaturkette: das Geraet PRUEFT ein Release gegen seine eingebackene Wurzel** — internal/otaverify (rein, nur Standardbibliothek - der Core … · `die-signaturkette-das-geraet-prueft-ein.md`
- **Der Downlink: das Geraet EMPFAENGT sein Ziel (und wendet es seit 26.08.2026 selbst an)** — internal/otatarget (rein · `der-downlink-das-geraet-empfaengt-sein-z.md`
- **Das Geraet wendet SELBST an - ohne Tor, ohne Schalter, ohne Menschen** — internal/otaapply (rein) + internal/otaupdater (Docker) + … · `das-geraet-wendet-selbst-an-ohne-tor-ohn.md`
- **Das Trust-Set kommt beim EINRICHTEN mit - nie zur Laufzeit** — oder seine Signatur fehlt." abgelehnt) · `das-trust-set-kommt-beim-einrichten-mit.md`
- **Die VERTRAUENS-IDENTITAET im Herzschlag** — Additiv, ohne jeden neuen Wirkpfad zum Wechselrichter · `die-vertrauens-identitaet-im-herzschlag.md`
- **Per-source status in the heartbeat (#524)** — agent.sourcesSummary() (internal/agent/entities.go) folds … · `per-source-status-in-the-heartbeat-524.md`
- **Deye control WRITE: bidirectional single-socket lock + First-Light evidence gate** — The Solarman/LSW3 logger accepts only ONE TCP client, so … · `deye-control-write-bidirectional-single.md`
- **Deye REMOTE MODE (registers 1100-1121) is the PRIMARY Deye control path** — Deye protocol V105.1+ added a "Customized register" block … · `deye-remote-mode-registers-1100-1121-is.md`
- **A register READBACK is not a value comparison: semantics, then debounce** — The hold check ("hat der Wechselrichter den Sollwert … · `a-register-readback-is-not-a-value-compa.md`
- **Deye N1: an UNKNOWN HV/LV power scale now REFUSES the whole ToU plan** — The live 10x bug (report §2.3): power_scale "Automatisch" … · `deye-n1-an-unknown-hv-lv-power-scale-now.md`
- **Die Zertifizierung hat ZWEI Hälften: Flotten-Allowlist + Laufzeit-Freigabe pro Gerät** — Der Schreib-Gate im Executor lautet · `die-zertifizierung-hat-zwei-haelften-flo.md`
- **Gate-Flags im Heartbeat kommen aus dem KERN, nie aus einem Readback-Stempel** — Ein Readback-Stempel ist eine Layer-1-BEOBACHTUNG und … · `gate-flags-im-heartbeat-kommen-aus-dem-k.md`
- **Modbus-Datenspiegel: read-only LAN Modbus slave, NEVER a socket consumer** — core/internal/mirror + agent/mirror.go serve every register … · `modbus-datenspiegel-read-only-lan-modbus.md`
- **`.env`-Schalter müssen in der Compose auch WEITERGEREICHT werden** — edge-app/docker-compose.yml gibt dem core nur eine … · `env-schalter-muessen-in-der-compose-auch.md`
- **PV-Abregelung (Fronius Increment 3): Quellen-Schreibpfad, Freigabe JE EINHEIT, Wirkung > Register** — Die Fahrplan-Phase "Abregeln" wird auf … · `pv-abregelung-fronius-increment-3-quelle.md`
- **First-Light-Härtung der PV-Abregelung: Auffrischung, Klemm-Plateau-Beweis, Ena-Quirk (06.08.2026, live Pilsting)** — Vier belegte Live-Defekte am selben Tag (nodered/FRONIUS.md … · `first-light-haertung-der-pv-abregelung-a.md`
- **⚠ Die PV-Abregelung wird als EIN FC16-Block geschrieben - ein Einzelregister wird gespeichert, aber nicht ÜBERNOMMEN (09.08.2026, live Pilsting)** — Die Begrenzung geht seither als EINE Modbus-Transaktion (fn … · `die-pv-abregelung-wird-als-ein-fc16-bloc.md`
- **⚠ Dynamische Einspeisebegrenzung: der EINE Guard, der blind NICHT stillhält (`guards.ExportLimiter`)** — Der Echtzeit-Wächter am Netzverknüpfungspunkt (06.08.2026 … · `dynamische-einspeisebegrenzung-der-eine.md`
- **Der Edge rechnet NIE mit Preisen — er setzt die Preis-Entscheidung der Wolke durch (`guards.PriceTrimmer`)** — Die preisbewusste Begrenzung innerhalb der Viertelstunde … · `der-edge-rechnet-nie-mit-preisen-er-setz.md`
- **Wer etwas ANDERES entwertet, nennt die Folge VORHER (`static/consequences.js`)** — Die Nebenwirkungs-Regel des Settings-Umbaus (E3 · `wer-etwas-anderes-entwertet-nennt-die-fo.md`
- **Teil C: JEDE Installation bringt den Aktualisierer mit - ohne Flag** — install.shs pull_and_up() zieht und startet den ganzen … · `teil-c-jede-installation-bringt-den-aktu.md`
- **Die Steuerungs-Zertifizierung hat jetzt DREI Quellen - die dritte ist die Plattform** — agent.controlCertified (internal/agent/calibration.go) ist … · `die-steuerungs-zertifizierung-hat-jetzt.md`
- **Einheitsmodell Stufe 1: der Box-Applier — das Portal wird der SCHREIBER der lokalen Dateien** — internal/componentapply (rein, keine I/O — jede … · `einheitsmodell-stufe-1-der-box-applier-d.md`
- **⚠ Eine Kennung, die auf dieser Box schon läuft, wird NIE neu vergeben** — Der Live-Defekt, der die Regel erzwungen hat (Anlage … · `eine-kennung-die-auf-dieser-box-schon-la.md`
- **Einheitsmodell Stufe 2: die Box MELDET ihre Verbindungen — und wird zum Spiegel** — Cloud-Seite, Migration und die Uebernahme-Regeln · `einheitsmodell-stufe-2-die-box-meldet-ih.md`
- **⚠ Ein SELBSTBAU-Gerät darf den Registry-Push nie scheitern lassen (Einheitsmodell Stufe 3)** — componentapply.Derive ist alles-oder-nichts, und roleFor … · `ein-selbstbau-geraet-darf-den-registry-p.md`
- **Der SCHALT-Test und der Schalt-Executor (Einheitsmodell Stufe 4)** — Der Weg, auf dem ein selbst gebautes Modbus-Gerät schaltbar … · `der-schalt-test-und-der-schalt-executor.md`
- **Die Einspeisegrenze IM GERÄT wird GELESEN — höchstens einmal am Tag, auf dem BESTEHENDEN Leseplan** — „Grenzen & Wächter" Stufe 0 / Vierer #4 (Cloud-Seite + … · `die-einspeisegrenze-im-geraet-wird-geles.md`
- **Der EINE Fernschreibpfad auf ein Installateur-Register: `0x00E7`** — Die Einspeisegrenze, die der Wechselrichter SELBST hält … · `der-eine-fernschreibpfad-auf-ein-install.md`
- **Der EINE Wechselrichter-Socket hat seit dem 20.08.2026 eine WARTESCHLANGE** — edge-app/nodered/bus-arbitration.js (rein, unit-getestet) … · `der-eine-wechselrichter-socket-hat-seit.md`
- **⚠ Ein ANGENOMMENER Register-Auftrag endet IMMER mit genau EINEM Ergebnis** — Derselbe Vorfall, zweiter Befund: fuer einen angenommenen … · `ein-angenommener-register-auftrag-endet.md`
- **Der ZWEITE Trigger auf denselben Einmal-Schreib-Kern: der Portal-Downlink** — internal/registerwrite (rein) + agent/register_write.go … · `der-zweite-trigger-auf-denselben-einmal.md`
- **⚠ Ein Auftrag OHNE Abonnent ist spurlos - und eine VORSCHAU hinterlaesst nie eine Spur** — Produktionsvorfall 20.08.2026 („der Downlink kommt auf der … · `ein-auftrag-ohne-abonnent-ist-spurlos-un.md`
- **Stufe 2 „Freie Register": die Allowlist wird durch LANE-Regeln abgeloest** — Die harte 0x00E7-Allowlist des Portal-Kanals ist WEG … · `stufe-2-freie-register-die-allowlist-wir.md`
- **OCPP-Ladepunkte: das CSMS läuft auf der BOX (`internal/csms`)** — Stufe 0 des Lastmanagement-Konzepts (data/vp-ocpp-lastmgmt-k … · `ocpp-ladepunkte-das-csms-laeuft-auf-der.md`
- **Das Compose-Rig `test/e2e-compose.sh`: zwei Regeln, ohne die es in CI nicht laeuft** — Es beweist die ganze Kette (SunSpec-Sim -> … · `das-compose-rig-test-e2e-compose-sh-zwei.md`
- **Das Lastmanagement-Rig `test/e2e-ocpp.sh`: Docker-frei, und es misst** — Die Faelle L1-L12 des Konzepts (§6.2 + Datenfundament + … · `das-lastmanagement-rig-test-e2e-ocpp-sh.md`
- **Die `:8484`-Ladepunkt-Flaeche ist die EINZIGE bedingte Accordion-Gruppe** — ⚠ Die Gruppe „Ladepunkte" wird hidden AUSGELIEFERT und von … · `die-8484-ladepunkt-flaeche-ist-die-einzi.md`
- **OCPP-Executor: ZWEI Tore, und das eine schuetzt ohne das andere (`agent/ocpp.go`)** — Die Verdrahtung zwischen der reinen Verteilung … · `ocpp-executor-zwei-tore-und-das-eine-sch.md`
- **OCPP: der Totmann ist OCPPs eigener, nicht unserer (`csms/profiles.go`)** — Die Smart-Charging-Hälfte des CSMS (Konzept §3.1/§4.3) · `ocpp-der-totmann-ist-ocpps-eigener-nicht.md`
- **OCPP-Lastmanagement: die Verteilung ist REIN (`internal/lastmgmt`)** — Stufe 1 des Konzepts (vp-ocpp-lastmgmt-konzept-w4 … · `ocpp-lastmanagement-die-verteilung-ist-r.md`
- **Stufe 2: das Ladebudget FOLGT dem gemessenen Netzanschluss (`lastmgmt/budget.go`)** — Der Import-ZWILLING von guards/exportlimit.go, mit … · `stufe-2-das-ladebudget-folgt-dem-gemesse.md`
- **Stufe 3: der Herzschlag trägt die Ladepunkte, und das Tor kennt sie** — Die Box-Hälfte des eigenständigen Modus (Konzept … · `stufe-3-der-herzschlag-traegt-die-ladepu.md`
- **Stufe 4: PV-ÜBERSCHUSSLADEN — die zweite Bahn desselben Verteilers** — Mockups §2a/§2b): das Ladepark-Lastmanagement liefert die … · `stufe-4-pv-ueberschussladen-die-zweite-b.md`
- **Stufe 3: die Anschlussgrenze kann aus dem PORTAL kommen (`internal/chargingcfg`)** — Der Konsument des retained Dokuments ems/{t}/{s}/{d}/v2/char … · `stufe-3-die-anschlussgrenze-kann-aus-dem.md`
- **Stufe 4: die FAHRPLAN-Bahn — der Plan reicht eine OBERGRENZE herunter** — Physisch begrenzt der Anschluss (budget.go), wirtschaftlich … · `stufe-4-die-fahrplan-bahn-der-plan-reich.md`
- **Stufe 4: „Jetzt voll laden" kommt als EINMAL-Freigabe aus dem Portal (`internal/chargingboost`)** — Der Konsument von ems/{t}/{s}/{d}/v2/charging-boost … · `stufe-4-jetzt-voll-laden-kommt-als-einma.md`
- **Die Box meldet ihre Adresse im KUNDEN-LAN — getrennt vom Zugriffsweg** — internal/netinfo + agent/network.go (Konzept … · `die-box-meldet-ihre-adresse-im-kunden-la.md`
- **⚠ `Bus.Close()` umgeht mochi-mqtts SHUTDOWN-DEADLOCK (echter CI-Ausfall 2026-08-26)** — mochi-mqtt/server/v2 verklemmt seinen EIGENEN Shutdown … · `bus-close-umgeht-mochi-mqtts-shutdown-de.md`
- **Wechselrichter-Automatik: der Sollwert wird ABGEGEBEN, die Aufsicht NIE** — Der Selbstregel-Modus (Konzept: firstmate … · `wechselrichter-automatik-der-sollwert-wi.md`
- **Defizit-Deckung: gekauft wird nichts, worauf die Anlage steht** — Cloud-Seite, Kontrakt und die Begründung: root AGENTS.md … · `defizit-deckung-gekauft-wird-nichts-wora.md`
- **Überschuss-Einlagerung: verschenkt wird nichts, was die Anlage erzeugt** — Der SPIEGEL der Defizit-Deckung eine Sektion darüber, und … · `ueberschuss-einlagerung-verschenkt-wird.md`
- **Die ABREGELUNG folgt der Messung, nicht dem 15-Minuten-Planwert** — §2 Glied 1b / §8 Fix D) · `die-abregelung-folgt-der-messung-nicht-d.md`
- **Ein Messpunkt wird ueber SEINE Komponente gelesen (Geraeteseite Stufe 3c)** — Cloud-Seite, Kontrakt und die Server-Haelfte: root … · `ein-messpunkt-wird-ueber-seine-komponent.md`
- **Ein Ladepunkt ist eine MESSENDE Komponente (Cockpit Phase 1 / E1+E2)** — Cloud-Seite, Portal und die volle Begruendung: root … · `ein-ladepunkt-ist-eine-messende-komponen.md`
- **Eine Saeule kann auf einem EIGENEN Anschluss haengen (Cockpit Phase 1 / C1)** — Das Budget-Gesetz budget = planbar - (Netzbezug … · `eine-saeule-kann-auf-einem-eigenen-ansch.md`
- **Die ARBITRIERUNGS-BRÜCKE: ein Ladepunkt hört auf denselben Arbiter (P5/K3)** — Cloud-Seite, Kontrakt und die Trennung „wirkt sofort / … · `die-arbitrierungs-bruecke-ein-ladepunkt.md`
- **Die RANGLISTE auf der Box: EIN Rang je Sitzung, EINE Menge zweimal gelesen (P6)** — Cloud-Seite, Migration und die Trennung „wirkt sofort / … · `die-rangliste-auf-der-box-ein-rang-je-si.md`
- **Eine WALLBOX tritt dem Ladepark-Rahmen bei (P6)** — internal/agent/ocpp_wallbox.go (Verdrahtung) + … · `eine-wallbox-tritt-dem-ladepark-rahmen-b.md`
- **FAHRZEUG-PROFILE: die Karte bringt ihre eigene Quellen-Bahn mit (P7)** — Modell und Kontrakt stehen im Root-CLAUDE.md („Paket 7") · `fahrzeug-profile-die-karte-bringt-ihre-e.md`
- **Der NETZ-SOLLWERT-TEST: derselbe Sollwert-Pfad, eine andere Regelseite** — Der begrenzte, armierte Testpfad, der klärt, ob der Deye … · `der-netz-sollwert-test-derselbe-sollwert.md`
- **Maintaining this file** — Keep this file for knowledge useful to almost every future … · `maintaining-this-file.md`

## Maintaining this file

**Größen-Budget (seit 05.09.2026, hart bewacht):** `AGENTS.md` ≤ 60 KB,
`frontend/portal/AGENTS.md` ≤ 45 KB, `edge-app/AGENTS.md` ≤ 45 KB. Wächter:
`bash tools/agents-md-budget.sh` (Matrix-Leg `agents-md` in `.forgejo/workflows/deploy.yaml`),
im Portal zusätzlich `npm run test:agents-md`. **Die Zahl wird nur KLEINER, nie größer** —
wer sie anhebt, hat den Wächter abgeschafft, nicht bestanden.

Der Grund: Claude Code lädt `CLAUDE.md` → diese Datei bei JEDEM Sitzungsstart. Am 05.09.2026
waren die drei Dateien auf 1,17 MB / 765 KB / 356 KB angewachsen und haben Worker binnen
Minuten an der Kontextgrenze sterben lassen.

**Die Regel daraus: hier steht ein POINTER, das Detail wohnt in `docs/agents/`.** Ein neuer
Abschnitt wird `docs/agents/<bereich>/<slug>.md` und bekommt hier EINE Index-Zeile
(`**Thema** — ein Satz Kern · \`<slug>.md\``). In den Wegweiser gehört nur, was FAST JEDE
Sitzung braucht: Aufbau, Befehle, die harten Hausregeln. Was der Code schon zeigt, gehört
gar nicht hierher — dann reicht der Verweis auf Datei, Befehl oder Test.

Der Umbau ist wiederholbar: `python3 tools/agents-md-split.py` erzeugt aus dem Kern
(`tools/agents-md-kern/<bereich>.md`) plus dem Bestand denselben Zustand, `--verify` beweist
die Byte-Gleichheit jedes ausgelagerten Abschnitts.
