# Das Geraet wendet SELBST an - ohne Tor, ohne Schalter, ohne Menschen

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 31).


`internal/otaapply` (rein) + `internal/otaupdater` (Docker) + `cmd/vp-edge-updater`
(der Sidecar) + `agent/ota_autonomy.go` (die Kern-Haelfte). Vollstaendiges Bild
inkl. Betreiber-Ablauf: root `AGENTS.md` „Edge-Updates: EIN Schritt" und
[`docs/ota-autonomie.md`](../docs/ota-autonomie.md). Was HIER gelten muss:

- **⚠ Seit dem 26.08.2026 gibt es KEIN Tor mehr ueber den Zustand der Anlage.**
  Compose-Profil, Geraete-Schalter (`autonomy.json`/`VP_OTA_AUTONOMOUS`),
  Neutral-Zeit T, Interlock, Eil-Pfad und die Einmal-Freigabe sind ERSATZLOS
  entfallen (Code, nicht nur Vorgaben). Was ein Anwenden noch verhindern kann,
  sind ausschliesslich Eigenschaften des SIGNIERTEN Release - Kette,
  Anti-Rollback-Boden, `compat.backends`, `state_schema` - und die physische
  Plattengrenze. Das Sicherheits-Argument: der bis dahin gesegnete Handpfad
  `update.sh --from-target` tauscht **roh**, ohne Selbsttest und ohne Ruecknahme;
  der autonome Pfad ist strikt sicherer als das.
- **Der Sidecar glaubt dem Kern NICHTS.** Er liest die Manifest-Bytes selbst
  und verifiziert gegen SEINE eingebackene Wurzel und SEINEN Boden. Die EINE
  Stelle, die beide aufrufen, ist `otaapply.VerifyManifest` - „unabhaengig
  verifizieren" heisst zwei PROZESSE, nicht zwei Implementierungen derselben
  Regel. **Es gibt keinen env-/Pfad-Schalter fuer die Wurzel** (genau die
  Uebernahme, gegen die die kalt/heiss-Trennung gebaut ist); `Options.Roots` ist
  ausschliesslich die Test-Naht, nil laedt die eingebackene.
- **Nur der KERN darf bezeugen, was laeuft** - deshalb schreibt nur er
  `current.json`, und zwar nur gegen seine eigene Build-Stempelung. Der Sidecar
  hat Container getauscht; ob danach der richtige Stand LAEUFT, kann er nicht
  wissen.
- **Das Protokoll ist ein DATEI-Kanal in `/data/ota`, jede Datei mit GENAU EINEM
  Schreiber** (Kern: `target.json`/`current.json`/`self-test.json`/`core-signal.json`;
  Sidecar: `updater-state.json`/`pending-confirm.json`/`lkg.json`/`failed.json`;
  Betreiber: `prune.json`). Alles tmp+rename. Der Sidecar hat kein Netz und
  keinen Port - er KANN den Kern nicht anrufen.
- **Sequenziert, nie beide Failsafe-Kopien zugleich weg:** getauscht wird nur,
  was sich UNTERSCHEIDET, und immer nur EINE Komponente je Durchlauf (`core`,
  dann `nodered`). Gepinnt wird ueber denselben `.env`-Hebel wie
  `update.sh apply_image_pin`, gestartet mit `--pull never` (die Images sind
  vorher geholt UND gegen ihren Digest geprueft; beim ZURUECKNEHMEN waere ein
  Pull sogar ein Fehler - ein Rueckfall muss ohne Registry gehen).
- **Das Rueckfallziel ist DREIFACH gesichert:** `:lkg`-Tag, ein GESTOPPTER
  Halter-Container (`docker create`, nie gestartet - genau das verschont ein
  `docker system prune -a`, ein blosser Tag NICHT; die Matrix belegt die Regel
  mit einem label-gefilterten echten `prune -a`) und ein `docker save`-Archiv.
  **⚠ Ein Archiv kann keinen Registry-Digest zurueckbringen** (live
  nachgemessen: `docker load` legt das Image ohne RepoDigest ab) - nach einem
  echten Aufraeumen wird deshalb auf den lokalen `:lkg`-TAG gepinnt, und der
  Grund sagt das.
- **⚠ Der Plattenwaechter rechnet mit `f_frsize`, nicht mit `f_bsize`**
  (`otaupdater/disk_linux.go`): `f_bavail` zaehlt in `f_frsize`-Einheiten. Auf
  ext4 sind beide 4096, auf einem virtiofs-Mount meldet `f_bsize` 256 KiB - der
  Waechter sah dort 9,5 TiB statt 38 GiB freien Platz.
- **Der Selbsttest ist nie vakuum:** `agent.otaSyntheticControlDryRun` faehrt
  die ECHTE `guards.Clamp`-Kette dieses NEUEN Binaers gegen ihre tragenden
  Zusagen (Nennband, SoC-Decke/-Boden, EEG-Solar-Klemme, §14a-Huelle) - immer,
  auch nachts und im Leerlauf. **⚠ `guards.Reading`s Nullwert
  `GridLimitKw: 0` heisst „§14a-Grenze 0 kW", nicht „unbekannt"** (unbekannt ist
  `guards.Unknown()`); eine mit `{}` gebaute Messung laesst den Envelope-Guard
  gegen eine Null-Grenze rechnen - im Trockenlauf genau so aufgefallen.
  **Die Selbsttest-Beobachtung ist DAUERHAFT, nicht nur ein Blick beim Boot:**
  der neue Core startet beim sequenziellen Tausch noch in `swap_core`, und bei
  einem reinen Node-RED-Update startet er gar nicht neu. `otaSelfTestLoop`
  wartet deshalb auf `self_test`, bindet sein Urteil an den weiterhin
  laufenden Token und prueft jeden Token hoechstens einmal.
- **Docker-Neustarts zaehlen nur SEIT diesem Vorgang.** `pending-confirm.json`
  traegt je Komponente `container_id` + absoluten Startwert. Solange die ID
  gleich ist, sieht der Wachhund die Differenz; ein neu angelegter Container
  beginnt mit seinem eigenen absoluten Zaehler. Ohne diese Baseline konnte ein
  alter `RestartCount >= 3` einen frischen Tausch vor dem ersten Swap
  zuruecknehmen. Alte Brotkrumen ohne das additive Feld behalten Frist,
  Running- und Healthcheck-Pruefung, loesen aber keinen historischen
  Crashloop-Fehlalarm aus.
- **Ist == Soll gewinnt vor den Apply-Toren.** Ein gueltig signiertes Release,
  das laut Build-Stempel bereits laeuft, bleibt `succeeded`, auch nachdem sein
  eigener `current.json`-Boden auf dieselbe Sequenz angehoben wurde. Backend,
  `min_from_seq` und Rueckschritt sind Tore fuer einen noch ausstehenden
  Tausch, nicht Gruende, einen bereits bewiesenen Stand im naechsten Takt als
  `politik` zu melden.
- **Was einmal zurueckgerollt wurde, laeuft nicht von selbst wieder an**
  (`failed.json`). Ohne das begann der naechste Takt denselben Tausch von vorn -
  die Zuweisung liegt ja noch. In der Fehlerinjektions-Matrix aufgefallen.
  **⚠ Seit dem Ein-Schritt-Umbau gilt die Sperre der ZUWEISUNG, nicht dem
  Release fuer immer:** eine NEUE Zuweisung - auch desselben Release - startet
  einen neuen Versuch (Blocker `zurueckgenommen`). Die Dauersperre war das eine
  Tor, das nur ueber eine Shell zu loesen war.
- **⚠ Eine Sperre wird GENANNT - je AENDERUNG, nie je Takt** (Canary-Soak
  04.08.2026): jedes geschlossene Tor traegt seit dem einen maschinenlesbaren
  Namen (`Decision.Blocker` -> `UpdaterState.Blocker`, Vokabular
  `otaapply.Blocker*`), `Engine.report` protokolliert eine WARN-Zeile bei jeder
  Aenderung von Blocker ODER Grund (und eine INFO beim Aufheben), und
  `agent.otaUpdaterOverlay` laesst eine STEHENDE Sperre im `update`-Block VOR
  jeder anderen Ueberlagerung gewinnen - mit `otaapply.BlockedPrefix`
  („Autonomie blockiert: …"), damit „wartet" und „blockiert" nirgends gleich
  aussehen. Vorher schrieb der Sidecar den Grund brav in die Zustandsdatei,
  protokollierte aber NICHTS, und der Herzschlag trug weiter den freundlichen
  Satz des Verifizierers: der Betreiber sah „wartet" ohne jede Chance zu
  erfahren, worauf. Wer ein neues Tor einbaut, gibt ihm einen Blocker-Namen und
  einen Grund, der den HEBEL nennt (beim Plattenwaechter: aufraeumen bzw.
  `VP_OTA_DISK_GUARD_MB`). Beweise: `otaupdater/blocker_test.go`,
  `otaapply/decide_test.go`, `agent/ota_autonomy_test.go`; Betreiber-Sicht:
  `docs/ota-autonomie.md` §2.
  - **Seit dem Admin-UX-Umbau (05.08.2026) reist der NAME zusaetzlich in die
    Cloud:** `cloud.UpdateSummary.Blocker` (`blocker`, `omitempty`) traegt ihn
    NEBEN dem deutschen `reason` - dieselbe Begruendung, aus der
    `target_verdict` neben `state` steht: die Cloud konnte „blockiert" sonst
    nicht von „unterwegs" trennen, ohne einen deutschen Satz nach Stichworten
    zu durchsuchen, und ein stehender Blocker landete portalseitig im
    Fortschritts-Ton. Er wird NUR gesetzt, solange der Sidecar wirklich
    blockiert (`up.Blocked()`), also bleibt der Herzschlag einer gesunden Box
    byte-gleich. Das frueher hier stehende „Cloud/Portal unveraendert" gilt
    damit nicht mehr - die Cloud-Seite steht in der Root-`AGENTS.md`
    („Edge-Updates: EIN Schritt"), inklusive des Uebergangs fuer Baende ohne das Feld
    (`RolloutStates.BLOCKED_PREFIX` ist der gepinnte Zwilling von
    `otaapply.BlockedPrefix` - **beide zusammen aendern**).
- **Der Sidecar ist ein NORMALER Dienst** (kein Profil mehr), also nimmt
  `up -d --remove-orphans` ihn selbstverstaendlich mit. Genau das ist der Weg
  fuer Bestandsboxen: EIN `./update.sh` je Box holt ihn dauerhaft dazu.
- **Der Sidecar tauscht sich NIE selbst** (`otaapply.TargetRefs` laesst
  `updater` aus, `ReleaseNamesUpdater` protokolliert es laut); seine eigenen
  Updates sind beaufsichtigt und out-of-band.
- **⚠ Er raeumt seine abgeloesten Abbilder NACH einem bestaetigten Tausch weg -
  und die Nie-entfernen-Menge ist der ganze Punkt** (Pilsting 09.08.2026:
  `docker system df` meldete 58 Abbilder, 3 in Benutzung, 5,8 GB
  rueckgewinnbar, und der Plattenwaechter verweigerte deshalb einen legitimen
  Rollout - die Verweigerung war richtig, der Grund war unser Muell). Regel
  rein in `otaapply.PlanPrune`, Wirkung in `otaupdater/prune.go`, aufgerufen
  ausschliesslich am ENDE von `Engine.commit` - nie vorher, nie mitten drin,
  nach einer Ruecknahme GAR NICHT (dort ist jedes Abbild potenziell das
  Rueckfallziel). Was die Sicherheit traegt:
  - **„auf das ein Container zeigt" ist die allgemeine Regel, nicht eine Liste
    von Ausnahmen** (`docker ps -aq` + `docker inspect --format {{.Image}}`):
    sie deckt core/nodered/updater UND die GESTOPPTEN `vp-edge-lkg-*`-Halter
    ab, also genau den Mechanismus, mit dem das Rueckfall-Image ein
    `prune -a` ueberlebt. Das `docker save`-Archiv ist eine DATEI und per
    Konstruktion ausser Reichweite. Dazu: der Rueckfall-Namensraum
    (`otaapply.LKGTagPrefix`, geteilt mit `lkgTag`/`lkgHolder`) ist auch ohne
    Halter tabu - **docker schuetzt hier NICHT**, einen Tag abzuhaengen gelingt
    trotz Container, solange ein anderer Name bleibt.
  - **Entfernt wird je NAME (`docker image rm <ref>`), nie mit `-f`, nie
    pauschal.** `-f` haebelte die dritte Sicherungsebene aus (docker verweigert
    die Loeschung, solange ein Container haelt), und `image prune -a` naehme
    ein vorab geholtes naechstes Ziel sowie jedes von aussen abgelegte Abbild
    mit. Ein Abbild mit Tag UND Digest braucht BEIDE Namen, sonst ueberlebt es
    unter der jeweils anderen Referenz.
  - **Die Kandidatenmenge sind nur die Repositories, die dieses Geraet selbst
    getauscht hat** (`prunableRepos`; `imageRepo` trennt Tag/Digest ab, aber nie
    den Port einer Registry). Der Sidecar steht nicht darin - seine alten
    Abbilder bleiben liegen, die vorsichtige Richtung.
  - **⚠ Nur was AELTER ist als der laufende Stand** (der ANKER je Repository =
    die juengste Bau-Zeit unter den gehaltenen Abbildern). Entfernt werden
    „Abbilder FRUEHERER Releases"; was juenger ist, ist etwas voraus
    Bereitgelegtes. **In der Fehlerinjektions-Matrix aufgefallen, nicht im
    Unit-Test:** ohne diese Regel sammelte ein frueherer Fall die Stellvertreter
    ein, die die Matrix fuer spaetere Faelle vorab angelegt hatte. Unbekannte
    Bau-Zeit = jung = bleibt; unbekannter ANKER = die Regel greift nicht (sonst
    schaltete ein unlesbares Zeitformat das Aufraeumen still ganz ab), dann
    traegt allein die Kulanz.
  - **Kulanz JE REPOSITORY** (`VP_OTA_PRUNE_KEEP`, Vorgabe 1): global gezaehlt
    behielte „eines aufheben" den Vorgaenger von core und entfernte den von
    nodered.
  - **Nicht-fatal, aber nie ratend:** jeder Fehlschlag wird nur protokolliert
    (die Reinigung ist die Kuer, der Tausch die Pflicht); eine unvollstaendige
    Sicht (`docker images`/`docker ps` antwortet nicht) bricht das Aufraeumen AB,
    statt auf einer Luecke zu entscheiden.
  - Schalter: `VP_OTA_PRUNE`/`VP_OTA_PRUNE_KEEP` (in BEIDEN Composes -
    Lockstep!) und `<data>/ota/prune.json` je Geraet. **Die Vorzeichen sind
    ANDERS als bei der Autonomie:** fehlende Datei = Vorgabe AN (das
    Nicht-Aufraeumen war der Defekt), UNLESBARE Datei = nichts entfernen.
  - **Bekannte Grenze:** eine Box, die der Plattenwaechter schon blockiert,
    kommt hierueber nicht frei (ohne Tausch kein Aufraeumen) - dort einmal von
    Hand `docker image prune -a`, was durch den Halter-Container nachweislich
    sicher ist. Betreiber-Handbuch: `docs/ota-autonomie.md` §4.
- Beweise: `internal/otaapply` (die Tore + Wiederaufnahme + Sequenz + Snapshot +
  Schalter + `prune_test.go`: die Regel inkl. Halter, Namensraum, Kulanz je
  Repository, alle Namen einer Kennung, Schalter-Vorzeichen), `internal/otaupdater`
  (die Orchestrierung gegen eine geschriebene docker-Welt; `prune_test.go`:
  Rueckfallebene ueberlebt, Ruecknahme raeumt nicht, vorab geholtes Ziel bleibt,
  ein Reinigungs-Fehlschlag kippt keinen bestaetigten Tausch),
  `agent/ota_autonomy_test.go` und die Matrix `test/ota-soak/run.sh` (10 Faelle gegen
  echten Docker, echte Signaturkette, echte Registry - `image_cleanup` faehrt
  ZWEI bestaetigte Updates und prueft danach Stueck fuer Stueck, was weg ist
  und was steht).

