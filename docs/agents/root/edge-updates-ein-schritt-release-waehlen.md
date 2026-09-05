# Edge-Updates: EIN Schritt — Release wählen, Geräte wählen, fertig

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 12).


Die Zusammenfassung der OTA-Stufen 2–4 und der Admin-UX-Umbauten P1–P3 nach der
**Vereinfachung vom 26.08.2026** (Captain-Auftrag „alle Blocker/Tore, die ein
Release verhindern können, entfernen"). Vorher entschied das Portal, verteilte
retained — und danach musste ein Mensch an das Gerät. Jetzt gilt:

> **Im Portal Release wählen, Geräte ankreuzen, „Aktualisieren". Das Gerät holt
> und tauscht selbst. Es gibt keinen zweiten Schritt.**

Betreiber-Handbuch: [`docs/ota-autonomie.md`](docs/ota-autonomie.md);
Signatur-Zeremonie: [`docs/ota-signing.md`](docs/ota-signing.md); Edge-Details:
`edge-app/AGENTS.md`.

### ⚠ DIE LEITENTSCHEIDUNG, an der alles hängt

> **Jedes Tor über den ZUSTAND DES GERÄTS ist gefallen. Jede Eigenschaft des
> SIGNIERTEN RELEASE bleibt.**

Eine Release-Eigenschaft bewertet der Takt automatisch und braucht NIE einen
Menschen am Gerät; ein Geräte-Zustands-Tor braucht genau das. **Ersatzlos
entfallen** (Code, nicht nur Vorgaben): Compose-Profil `ota` · Geräte-Schalter
`autonomy.json` + `VP_OTA_AUTONOMOUS` · die Einmal-Freigabe (`:8484`-Taste UND
Portal-Apply, samt `mqtt-ota-apply.schema.json`, `device_apply_request`,
`ApplyApproval`) · die Neutral-Zeit **T** samt `internal/neutralcal` und dem
`:8484`-Messtest · der Interlock + Eil-Pfad (`ModeOtaNeutral`, Manifest-Feld
`urgent`) · `kern_still` · Wellen + `BakeGate` + `auto_advance` + `promote` ·
Auto-Halt · Pause/Resume/Not-Aus · „höchstens EIN lebender Rollout" · `pinned` ·
Kanal `canary`/`stable` · Zustand `wartet_auf_anwendung`. **Das
Sicherheits-Argument:** der bis dahin gesegnete Handpfad `update.sh
--from-target` tauscht **roh** — ohne Neutral-Zeit, ohne Interlock, ohne
Selbsttest, ohne Rücknahme. Der autonome Pfad ist nach dem Umbau **strikt
sicherer als das, was von Hand ohnehin getan wurde**.

**Was BLEIBT** (alles automatisch bewertet): Signaturkette gegen die
eingebackene Wurzel · Trust-Set · `alg`-Pinning + Domain-Trennung ·
Anti-Rollback-Boden `min_from_seq`/`allow_downgrade` · `compat.backends` ·
`state_schema` · der Plattenwächter als **physische** Grenze (er misst erst,
NACHDEM aufgeräumt wurde) · die Sperre gegen eine schon zurückgenommene
Zuweisung (`zurueckgenommen`, per ZUWEISUNG, nicht mehr für immer — eine neue
Zuweisung desselben Release versucht wieder).

### Der Verteilweg (unverändert seit Stufe 2)

- **RETAINED, und das ist der ganze Mechanismus.** `OtaTargetPublisher` legt das
  signierte Manifest retained (QoS1) auf `ems/{t}/{s}/{d}/v2/update` (Kontrakt
  `docs/contracts/mqtt-ota-target.schema.json` + Beispiele, vom Go-Parser PER
  PFAD gelesen). Hinter NAT gibt es keinen Push: eine Box, die beim Start
  offline war, holt ihre Zuweisung beim nächsten Verbindungsaufbau selbst ab.
  Das Topic liegt im `v2/#`-Teilbaum der per-Gerät-ACL — **keine
  Broker-Änderung**. `published_at` heißt deshalb NICHT „zugestellt".
- **⚠ Die Manifest-Bytes reisen BYTE FÜR BYTE.** Sie stehen base64-kodiert im
  Umschlag (`manifest_b64`/`signature_b64`), nie als eingebettetes JSON-Objekt:
  ein Objekt müsste zum Prüfen neu serialisiert werden, und genau diese
  Mehrdeutigkeit (Schlüsselreihenfolge, Leerraum, Zahlenformat) macht die
  Signatur lautlos unprüfbar. Der Umschlag wird aus demselben Grund von HAND
  zusammengesetzt (`OtaTargetPublisher.envelope`). Kette:
  `edge_release.manifest` (`text`, nie `jsonb`) → base64 → Datei auf dem Gerät →
  Verifizierer. **Der Umschlag ist UNSIGNIERT und deshalb keine Autorität** —
  `release`/`release_seq` sind Routing und Diagnose.
- **Nur ein SIGNIERTES Release ist verteilbar** (409 sonst, auf beiden
  Schreibwegen): ohne Manifest-Bytes hat ein Gerät nichts, was es gegen seine
  eingebackene Wurzel prüfen könnte. Das **Trust-Set reist bewusst NICHT mit**
  (es ist der Widerrufs-Anker) und kommt beim Einrichten über
  `install.sh` — siehe den Trust-Set-Abschnitt.

### Cloud-Seite

- **Vier additive Tabellen** (`V20260805000000`): `device_update_target` (eine
  Zeile je Gerät = der Soll-Stand), `rollout`, `rollout_device` (mit dem
  Namens-SCHNAPPSCHUSS `device_ref`/`site_name` aus `V20260807000000` — ein FK
  wäre falsch, die Frage lautet „wie hieß dieses Gerät, ALS es in die
  Aktualisierung kam"), `rollout_event` (append-only Journal). **GLOBAL, ohne
  `tenant_id` und ohne RLS** wie `edge_release`/`provisioned_device` — es gibt
  per Konstruktion KEINE Kunden-Fläche; gefenced ist der Endpunkt
  (`/admin/**` + `@PreAuthorize` + BYPASSRLS-`RolloutRepository`). **⚠ Footgun:**
  das `BIGSERIAL` braucht ein EIGENES `GRANT USAGE ON SEQUENCE` — V4s
  `ALTER DEFAULT PRIVILEGES` deckt Tabellen ab, Sequenzen sind eine andere
  Objektklasse. Migration **`V20260854000000`** räumt danach die toten Spalten
  (`rollout.channel/auto_advance/waves/current_wave/halted_reason`,
  `rollout_device.wave`, `device_update_target.channel/pinned`,
  `device_update_status.can_apply/channel`), den partiellen Unique-Index
  `uq_rollout_one_live` und die Tabelle `device_apply_request` ab; das
  Zustands-CHECK von `rollout` kennt nur noch `active`/`done` und überführt
  Bestandszeilen (`paused`/`halted`) dorthin. **⚠ Wer eine Migration UMBENENNT,
  räumt `target/` weg** — die dokumentierte `Found more than one migration with
  version …`-Falle traf beim Bau erneut zu.
- **⚠ In `RolloutService` steht bewusst KEIN `@Transactional`.** Springs
  Transaktionsmanager hängt am `@Primary` (Mandanten-Datenpfad), alle
  Schreibvorgänge laufen aber über `adminJdbcTemplate` — die Annotation öffnete
  eine Transaktion auf der FALSCHEN Verbindung und BEHAUPTETE Atomarität, die es
  nicht gibt. Getragen wird es von der Reihenfolge: vollständig prüfen, bevor
  das Erste geschrieben wird, und jeder Schritt für sich idempotent.
- **Endpunkte** (`AdminEdgeUpdateController`, platform-admin):
  `GET /api/v1/admin/edge-updates` (der EINE Lese-Aggregat der Seite — seit dem
  Umbau mit **`rollouts` als LISTE**, weil mehrere Aktualisierungen nebeneinander
  laufen dürfen), `POST /api/v1/admin/rollouts` **`{releaseSeq, devices[]}`**,
  `POST /api/v1/admin/devices/{id}/update-target` **`{releaseSeq}`** +
  `…/revert`, `GET /api/v1/admin/rollout-journal.md`. In `openapi.yaml`.
- **`ota/RolloutStates` ist die reine, Docker-frei getestete Regel** (das
  `Tagesprotokoll`/`FleetPflege`-Muster) mit den Ehrlichkeitsregeln: **unbekannt
  ≠ veraltet**, **offline ≠ fehlgeschlagen**, jede rote Zeile trägt ihren Grund;
  `im_update_verstummt` existiert nur, weil `applying` durabel VOR dem Stoppen
  gemeldet wird; `zurueckgestellt` ist ein Politik-Halt und weder ausstehend noch
  fehlgeschlagen. **`wartet_auf_anwendung` ist ERSATZLOS entfallen** — niemand
  ist mehr dran; ein Server, der das Wort noch sendet, wird im Portal zu
  „unbekannt", nie zu „aktuell".
- **Der Wächter** (`RolloutWatcher`, 60 s, am Flag
  `voltpilot.ota.mqtt-listener-enabled`) schreibt die Zustände fort und
  **re-publiziert driftende Zuweisungen** (Gerät kennt sein Ziel nicht + zuletzt
  vor > `voltpilot.ota.republish-after`, Vorgabe 30 min). Er hält **NICHTS mehr
  an** — ein Fehlschlag ist Information, die anderen Geräte laufen weiter. Wie
  die MQTT-Listener ein Replica-Singleton (jeder Schritt idempotent).
- **Der `update`-Block trägt `target_verdict`** (`ok|deferred|rejected`, Spalte
  in `device_update_status`): er steht NEBEN `state`, weil beide verschiedene
  Fragen beantworten — `state` ist der Zustand der ANWENDUNG, `target_verdict`
  der der PRÜFUNG. Ein unbekanntes Wort wird beim Ingest VERWORFEN.
  Ebenso additiv: `blocker` (der maschinenlesbare Name einer stehenden Sperre,
  `otaapply.Blocker*`) → `FleetRowDto.blocker` → der HEBEL im Portal
  (`adminEdgeUpdates.blockerLever`) — die Haus-Regel „keine Oberfläche
  durchsucht deutsche Sätze".
  **⚠ `RolloutStates.BLOCKED_PREFIX`** erkennt zusätzlich den gepinnten
  Satzanfang `otaapply.BlockedPrefix` („Autonomie blockiert: ") für Boxen, die
  den Namen noch nicht melden — **die beiden Konstanten zusammen ändern.**
- **Unclaim räumt ab:** `RolloutService.onDeviceUnclaimed` löscht die Zuweisung
  und leert den retained Slot (best-effort, nie werfend).

### Portal

EINE Fläche (`pages/admin/EdgeUpdatesPage.tsx` über der reinen
`src/adminEdgeUpdates.ts`): Releases-Tabelle → je signiertem Release
„Aktualisieren ▸" → Drawer mit „Alle Geräte" + Checkbox je Gerät (jedes trägt
seinen ZUSTAND und ggf. einen **Einwand als HINWEIS, nie als Sperre**) →
Zusammenfassung „Das passiert jetzt" → **Aktualisieren**. Darunter je AKTUELLER
Zuweisung eine Karte mit Fortschritts-Rückgrat (über die ERREICHBARE Menge;
offline/unbekannt stehen DANEBEN, nie im Nenner) und einer Zeile je Gerät
(Ist · Zustand · Grund · Hebel). `currentRolloutViews` verbindet dafür
`FleetRow.rolloutId` + `sollSeq` mit der Karte: der Live-Zustand einer neueren
Zuweisung erscheint NIE unter dem Release-Kopf eines älteren Rollouts; dessen
Mitgliedschaft bleibt ausschließlich im Journal. Der geteilte `GeraeteDrawer` weist ein
Einzelgerät zu (`onAssign(releaseSeq)` — kein Kanal, kein Pin). Es gibt
**nirgends** einen zweiten Knopf; die Vier-Klassen-Grammatik ist auf `busy`
(läuft von selbst, pulsiert) · `blocked` · `incident` · `calm` geschrumpft, die
frühere fünfte Klasse `action` („SIE sind dran") ist entfallen.

### Edge-Seite (Kurzform; Details in `edge-app/AGENTS.md`)

- **Der Schnitt:** `internal/otaapply` (rein) ⟷ `internal/otaupdater` (Docker)
  ⟷ `cmd/vp-edge-updater` (Prozess). JEDE Regel, die ein Anwenden verhindern
  kann, liegt im reinen Paket und ist ohne einen einzigen Container prüfbar.
- **Kern und Sidecar sprechen über DATEIEN in `/data/ota`, jede mit GENAU EINEM
  Schreiber** (`target.json`/`current.json`/`self-test.json` Kern,
  `updater-state.json`/`pending-confirm.json`/`lkg.json`/`failed.json` Sidecar).
  Der Sidecar hat kein Netz, keinen Host-Port, keine MQTT-Verbindung und keine
  Identität. Alle Dateien tmp+rename.
- **Die drei Sätze, auf denen die Sicherheit ruht:** (1) der Sidecar glaubt dem
  Kern NICHTS — er liest die Manifest-Bytes selbst und verifiziert gegen SEINE
  eigene eingebackene Wurzel und SEINEN eigenen Boden (`otaapply.VerifyManifest`
  ist die EINE Stelle, die beide aufrufen); (2) nur der KERN darf bezeugen, was
  läuft, deshalb schreibt nur er `current.json`; (3) was nicht entschieden werden
  kann, wird nicht angewandt — jede Regel fällt im Zweifel auf „nicht anwenden"
  und trägt einen deutschen Grund.
- **Ehrlich zur Privilegien-Lage:** `docker.sock` ist Host-root, ein übernommener
  Sidecar KANN einen privilegierten Container starten. Der Schutz ist
  ausdrücklich NICHT die Netz-Grenze, sondern die selbst geprüfte Signatur der
  Eingaben plus eine minimale Angriffsfläche.
- **Der Ablauf, sequenziert:** holen (beide Images, VOR jedem Stopp) →
  Digest-Gegenprüfung → Rückfallziel DREIFACH sichern (`:lkg`-Tag + GESTOPPTER
  Halter-Container + `docker save`-Archiv; der Halter ist der Mechanismus, mit
  dem das Image ein `docker system prune -a` überlebt) → Gruppen-Sicherung des
  `/data`-Bestands → **Brotkrume VOR dem ersten Tausch** → der Kern meldet
  `applying` DURABEL → **EINE Komponente nach der anderen** (`core`, dann
  `nodered` — nie beide zugleich, damit immer eine Ausfallsicherung lebt) →
  Selbsttest des NEUEN Kerns → bestätigen oder zurücknehmen. Getauscht wird nur,
  was sich UNTERSCHEIDET.
- **Der Selbsttest ist nie vakuum:** entscheidend ist der SYNTHETISCHE
  Steuer-Trockenlauf (`agent.otaSyntheticControlDryRun`), der IMMER läuft und die
  echte Guard-Kette dieses NEUEN Binärs gegen ihre tragenden Zusagen prüft
  (Nennband, SoC-Decke/-Boden, EEG-Solar-Klemme, §14a-Hülle).
- **Der Core beobachtet die Selbsttest-Phase dauerhaft.** Beim sequenziellen
  Tausch startet er noch in `swap_core`; bei einem unveränderten Core startet
  er gar nicht neu. `otaSelfTestLoop` wartet deshalb auf `self_test`, prüft den
  weiterhin laufenden Token und zeichnet den Stand erst gegen den eigenen
  Build-Stempel auf. Ein danach exakt laufendes Release bleibt trotz des auf
  dieselbe Sequenz angehobenen Anti-Rollback-Bodens `succeeded`: die
  Apply-Politik darf einen bereits bewiesenen Ist==Soll-Stand nicht sperren.
- **Der Crashloop-Wächter zählt nur Neustarts dieses Vorgangs.** Die Brotkrume
  friert je Komponente Container-ID und absoluten Docker-Zähler ein; beim alten
  Container gilt die Differenz, beim neu angelegten dessen frischer Zähler.
  Historische Neustarts des abgelösten Stands lösen damit keine Rücknahme des
  neuen Releases aus.
- **⚠ Der Plattenwächter rechnet mit `f_frsize`, NICHT mit `f_bsize`**
  (`otaupdater/disk_linux.go`). POSIX: `f_bsize` ist die BEVORZUGTE
  E/A-Blockgröße, `f_frsize` die fundamentale — und `f_bavail` zählt in
  `f_frsize`-Einheiten. Auf ext4 sind beide 4096; auf einem virtiofs-Mount meldet
  `f_bsize` 256 KiB, und der Wächter sah 9,5 TiB statt 38 GiB.
- **⚠ `guards.Reading`s Nullwert `GridLimitKw: 0` heißt „§14a-Grenze 0 kW", NICHT
  „unbekannt"** — unbekannt ist ausschließlich `guards.Unknown()` (NaN).
- **Was hier einmal zurückgerollt wurde, läuft nicht von selbst wieder an**
  (`failed.json`) — sonst drehte die Anlage sich im Kreis. **Die Sperre gilt
  seit dem Umbau der ZUWEISUNG, nicht dem Release für immer:** eine neue
  Zuweisung (auch desselben Release) startet einen neuen Versuch.
- **Wer den Aktualisierer aktualisiert: nicht er selbst.** `otaapply.TargetRefs`
  lässt `updater` aus der Artefakt-Liste heraus und protokolliert das LAUT — ein
  Prozess, der sich mitten in einer Orchestrierung ersetzt, verliert den Zustand,
  mit dem er den Vorgang zu Ende fahren müsste.
- **`/data`: gesichert ≠ zurückgespielt.** Die Identität (`device.key`/`.crt`/
  `identity.json`) wird GESICHERT, aber NIE automatisch zurückgespielt:
  `enroll.Reconcile` übernimmt im Betrieb legitim eine neue device_id.
- **⚠ Der Sidecar RÄUMT SEINE ABGELÖSTEN ABBILDER WEG — nach einem BESTÄTIGTEN
  Tausch, nie vorher** (Pilsting 09.08.2026). Regel rein in
  `otaapply.PlanPrune`, Wirkung in `otaupdater/prune.go`, aufgerufen
  ausschließlich am ENDE von `Engine.commit` — nach einer **Rücknahme gar
  nicht**. **Die Nie-entfernen-Menge ist der ganze Punkt:** ein Abbild, auf das
  IRGENDEIN Container zeigt (laufend ODER gestoppt — das deckt die
  `vp-edge-lkg-*`-HALTER ohne Sonderregel ab); alles im Rückfall-Namensraum
  (`otaapply.LKGTagPrefix`) auch OHNE Halter; das laufende Ziel und eine bereits
  vorab geholte NÄCHSTE Zuweisung; **alles, was nicht ÄLTER ist als der laufende
  Stand**; und je Repository die `VP_OTA_PRUNE_KEEP` (Vorgabe 1) jüngsten
  Verwaisten. Entfernt wird **je NAME**, **nie mit `-f`** und **nie pauschal**.
  Schalter `VP_OTA_PRUNE`/`VP_OTA_PRUNE_KEEP` + `<data>/ota/prune.json` mit
  **umgekehrten Vorzeichen**: fehlende Datei = AN, UNLESBARE Datei = nichts
  entfernen. **Bekannte Grenze:** eine schon blockierte Bestandsbox kommt hierüber
  nicht frei — dort einmal von Hand `docker image prune -a`.
- **⚠ Eine Verweigerung muss SICHTBAR sein** (Canary-Soak 04.08.2026): jedes
  geschlossene Tor trägt einen maschinenlesbaren Namen (`Decision.Blocker` →
  `UpdaterState.Blocker`), Sidecar UND Kern protokollieren die Sperre bei jeder
  ÄNDERUNG (nie je Takt), und eine stehende Sperre gewinnt im `update`-Block VOR
  jeder anderen Überlagerung (`otaapply.BlockedPrefix` + Grund). Der Zustand
  bleibt `deferred` — keine Störung, sondern eine bewusst nicht getroffene
  Entscheidung.
- **Registry-Zugang: AUTOMATISCH abgeleitet.** `install.sh`/`update.sh` lesen den
  `auths`-Eintrag der Registry aus der `docker login`-Konfiguration des Hosts und
  legen ihn als `/data/ota/registry-auth.json` ab (0600, per `docker compose cp`
  als EINZELNE Datei in ein BESTEHENDES Verzeichnis — siehe die
  `docker cp`-Besitzer-Falle im Trust-Set-Abschnitt). Kein neues Geheimnis, kein
  CI-Secret. *Grenze:* mit einem Credential-Helper (`credsStore`) steht dort kein
  Klartext — dann warnt der Installer laut und nennt den Handpfad.
- **Compose/Installer:** `updater` ist ein **normaler Dienst** in BEIDEN Composes
  (Repo + `install.sh generate_compose()`), `network_mode: none`, Docker-Socket +
  Deploy-Verzeichnis eingehängt — **kein Profil mehr**. `install-selfcheck.sh`
  nagelt fest, dass ein Geräte-Compose GAR KEIN Profil trägt und dass
  `pull`/`up -d` den Sidecar ohne jedes Flag mitnehmen.
- **Bestandsboxen:** EIN Befehl je Box, danach nie wieder —
  `cd <deploy-dir> && ./update.sh`. Er zieht die neue `docker-compose.yml`, holt
  die Images und startet den `updater` dauerhaft mit.

### Vertrauens-Identität je Gerät (aus Stufe 4, unverändert)

Die Edge meldet im `update`-Block additiv `trust` (`cloud.TrustSummary`:
`root_key_ids` der EINGEBACKENEN Wurzel + die key_ids/`generated_at` des
GEPRÜFTEN Trust-Sets), gebildet von `otaverify.InspectTrust` — der EINEN
Funktion, die Werkzeug (`vp-ota trust`) und Gerät teilen: **ein Trust-Set, das
die Wurzel nicht unterschrieben hat, wird NICHT berichtet**. Persistiert in
`device_update_status` als komma-getrennte SORTIERTE Liste; der Ingest verwirft,
was nicht `^[a-z0-9][a-z0-9._-]{0,63}$` ist.
**⚠ DREI Zustände:** `NULL` = ein älterer Edge-Stand meldet nichts →
**„unbekannt", nie „nicht gekreuzt"**; `''` = ein Image OHNE Wurzel →
**Crossover offen** (der dokumentierte Vor-TOFU-Zustand, eine offene Aufgabe,
KEIN Fehler); sonst gekreuzt. Laut ist nur der VIERTE Fall: Wurzel da, Trust-Set
abgelehnt. Gerendert von `adminEdgeUpdates` (`crossoverState`/`crossoverHint`/
`trustSetSpread`).

### Audit-Spiegel ins gitops: EXPORT, kein Deploy

`GET /api/v1/admin/rollout-journal.md` (platform-admin) rendert das append-only
Journal als Markdown (rein: `ota/RolloutJournal`). **Die api hält KEIN
gitops-Schreib-Token** — committet wird außerhalb durch
`tools/deploy/mirror-rollout-journal.sh`. Die Ausgabe ist DETERMINISTISCH (kein
„erzeugt am"-Kopf), derselbe Zustand erzeugt also keinen Commit; es fließt nichts
zurück.

### Beweise

rein: `otaverify/verify_test.go` · `otaapply` (die verbliebenen Tore, gebrochene
Kette = `failed`, Sequenz, Snapshot-Regel, Prune-Regeln, jeder Nicht-idle-Ausgang
trägt einen deutschen Grund) · `otaupdater` gegen eine geschriebene docker-Welt
(Reihenfolge holen→sichern→Brotkrume→EINE Komponente, falscher Digest stoppt vor
jedem Tausch, Selbsttest-Fehlschlag ⇒ Rücknahme, `prune`-Fall lädt das Archiv,
Wachhund, Neustart setzt FORT) · `RolloutStatesTest` · `OtaTargetPublisherTest`
(„unaufgeräumte" Manifest-Bytes kommen bytegleich zurück) · `RolloutJournalTest`
· portal `adminEdgeUpdates.test.ts` + `EdgeUpdatesPage.test.tsx`.
Testcontainers: `OtaRolloutApiTest` (echtes TimescaleDB + Keycloak + EMQX:
unsigniertes Release verweigert, retained Zuweisung bytegenau beim Gerät, KEINE
zweite Welle — beide Geräte sind sofort dran —, `failed` hält NICHTS an, Unclaim
leert den Slot, Journal-Urheber, Rollen-Grenze) · `AdminApiTest`.
Fehlerinjektions-Matrix: `edge-app/test/ota-soak/run.sh` (10 Fälle gegen echten
Docker, echte Signaturkette, echte Registry).

### Ops

Keine neuen Pflicht-Variablen. Der Verteilweg reitet auf
`voltpilot.provisioning.*`, der Wächter am schon gesetzten
`VOLTPILOT_OTA_MQTT_LISTENER_ENABLED` — im gitops-Repo
(`apps/voltpilot/base/api/api.env`) muss dieses Flag stehen, sonst laufen weder
Ingest noch Wächter in prod.

