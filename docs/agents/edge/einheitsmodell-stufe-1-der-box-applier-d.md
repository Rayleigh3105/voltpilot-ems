# Einheitsmodell Stufe 1: der Box-Applier — das Portal wird der SCHREIBER der lokalen Dateien

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 51).


`internal/componentapply` (rein, keine I/O — jede zeitabhaengige Funktion nimmt `now`, das
otaapply/calibration/probe-Muster) + `agent/component_apply.go` (ausschliesslich Verdrahtung).
Cloud-Seite, Migration und die Autoritaets-Regel: Root-`AGENTS.md` „Einheitsmodell Stufe 1".
Was HIER gelten muss:

- **⚠ DER APPLIER GREIFT NUR AUF EINER PORTAL-VERWALTETEN ANLAGE.** `componentapply.IsPortalManaged`
  liest `registry.component_authority`, und **ABSENT heisst BOX** (`Authority`: alles, was nicht
  woertlich `portal` ist). Ein aelterer Cloud-Stand, ein Push ohne das Feld und jede Bestandsanlage
  laufen damit ZEICHENGLEICH wie vorher — festgenagelt von
  `TestABoxManagedPlantIsByteIdenticalUnderEveryPush` (keine Datei geschrieben, keine Auswahl
  geaendert, keine retained Veroeffentlichung).
- **NIE partiell anwenden.** `Derive` baut den GANZEN Plan (Wechselrichter + Quellen) und verweigert
  ihn als Ganzes bei zwei Wechselrichtern, doppelten deterministischen IDs oder einer unentscheidbaren
  Rolle; erst danach schreibt `writeComponentPlan` BEIDE Speicher, und erst danach wird retained
  veroeffentlicht. Ein halb angewandtes Soll waere ein Geraet, das gegen eine Konfiguration liest, die
  nirgends steht.
- **Ein leeres Soll ist KEIN Soll — bis zur Uebernahme** (`ErrNoConfiguration`): ein Push ohne eine
  einzige `driver.connection` loescht VOR dem ersten angewandten Portal-Plan nichts (Halt, `held_*`) —
  sonst naehme ein noch leeres Portal einer laufenden Anlage ihren Lesepfad. NACH der Uebernahme stammt
  jede Quelle aus dem Portal (lokale Bearbeitung ist gesperrt): dann heisst das leere Soll „letztes Geraet
  geloescht", und die Box wendet `componentapply.EmptiedPlan` an (keine Quelle mehr, Wechselrichter
  unberuehrt). Vorher las sie ein im Portal geloeschtes Geraet weiter und meldete es dauerhaft auf der
  Box-Seite, ohne dass es irgendwo zu entfernen war.
- **Die angewandte Revision wird PROTOKOLLIERT** (`componentapply.Store` → `<data>/components-applied.json`,
  atomar tmp+rename, Schema-versioniert wie `calibration-certified.json`; ein Satz aus einer ZUKUENFTIGEN
  `StateVersion` wird ganz ignoriert). Sie ueberlebt Neustart und Cloud-Ausfall und reist im Herzschlag
  (`cloud.ComponentApplySummary`) — **eine Ablehnung steht NEBEN der angewandten Revision, nie an ihrer
  Stelle**: was laeuft, ist weiterhin die zuletzt wirklich angewandte Fassung.
- **⚠ DIE RUECKGABE DER AUTORITAET WIRD GEMELDET, NICHT VERSCHWIEGEN** (Befund L8, Scout
  `vp-portal-box-spiegel-s2`). `componentApplySummary` war `nil`, sobald die Anlage wieder box-verwaltet war —
  und Schweigen ist in der Cloud von „eine aeltere Box sagt dazu nichts" nicht zu unterscheiden: die Zeile in
  `device_component_apply` behielt ihr `authority=portal` samt der zuletzt angewandten Revision, waehrend jeder
  folgende Push die Soll-Revision hochzaehlt, und das Portal behauptete ueber eine Anlage, die es gar nicht
  mehr steuert, dauerhaft „Aenderung unterwegs zur Box". Gesendet wird jetzt `{"authority":"box"}` — **NUR die
  Autoritaet**, ohne Revision und ohne Grund (eine Revision waere eine Behauptung ueber ein Soll, dem diese Box
  nicht mehr folgt; ein stehen gebliebener Ablehnungs-/Halt-Grund gehoerte einer Aera, die vorbei ist).
  Deshalb wird der Block dort von HAND gebaut statt aus dem Record gefuellt: so kann kein kuenftiges Feld
  versehentlich mitreisen.
  **⚠ `nil` bleibt er AUSSCHLIESSLICH auf einer Anlage, die NIE portal-verwaltet war** (`rec.Authority == ""`
  — `releaseComponentAuthority` kehrt dort frueh zurueck): dort hat die Box wirklich nichts zu berichten, und
  ihr Herzschlag behaelt exakt die Bytes von vor dem Einheitsmodell — die Captain-Auflage, gepinnt in
  `TestABoxManagedPlantIsByteIdenticalUnderEveryPush`. Cloud-Seite (Listener raeumt die Zeile, `box_managed`):
  root `AGENTS.md` „Einheitsmodell Stufe 1". Beweise: `TestHandingAuthorityBackNeverUndoesWhatRuns` (Drahtform
  `{"authority":"box"}`) + `TestTheReturnedAuthorityIsReportedAgainAfterARestart`.
- **Der lokale Bus ist UNVERAENDERT.** Geschrieben wird durch die BESTEHENDEN `invStore`/`srcStore` und
  `publishInverterConfig`/`publishSourcesConfig`; `edge/inverter/config`, `edge/sources/config`, das
  Self-Wiring und die Telemetrie sind byte-identisch — nur der SCHREIBER wechselt. `sources.DeterministicID`
  bleibt die Identitaet, damit die Uebernahme einer Bestandsbox (Stufe 2) ein No-op ist.
- **Auf einer portal-verwalteten Anlage lehnt `:8484` die lokale Bearbeitung ab** (`refuseIfPortalManaged`
  auf `SetInverter`/`AddSource`/`DeleteSource`/`RenameSource`, mit `portalManagedHint`) — **aber erst,
  nachdem wirklich ein Portal-Push angewandt wurde** (`PortalManagedComponents`), sonst haette eine
  frisch eingerichtete Box weder das eine noch das andere und stuende in einer Sackgasse.
- **`probe.OpTestConnection`** ist die Stufe-1-Erweiterung des Probe-Kanals: der Assistent testet eine
  NOCH NICHT gespeicherte Verbindung ueber dieselbe `Agent.TestConnection`-Maschinerie, die die
  `:8484`-Taste seit je benutzt — kein zweiter Test, der etwas anderes sagen koennte als das Geraet.
  Die vier Zulassungsregeln des Kanals (Identitaet, Verfall, privates Ziel, Ratenbegrenzung) gelten
  woertlich weiter.
- Beweise: `internal/componentapply` (19, inkl. der Kontrakt-Fixture per PFAD) ·
  `agent/component_apply_test.go` (8) · `agent/probe_test.go`.

