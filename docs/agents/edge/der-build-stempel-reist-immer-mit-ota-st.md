# Der Build-Stempel reist IMMER mit (OTA Stufe 0 „Sehen")

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 28).


Bis dahin ritt `core_version` NUR im `flows`-Ack-Block — und den baut der Deployer
erst, nachdem er je einen Deployment-Satz gesehen hat (`Deployer.Summary()`
liefert vorher nil). Eine Box, auf der nie eine Automation ausgerollt wurde,
meldete der Cloud also GAR KEINE Version. Zwei additive Dinge beheben das; es
gibt in dieser Stufe KEINEN Apply-Pfad und keinen Downlink.

- **`version` ist ein LINK-Feld, kein Aufruf-Argument** (`cloud.Options.Version`
  → `Link.version`, gesetzt aus `agent.Version` beim Bau des Links). Es steht
  damit in JEDEM `PublishStatus` — strukturell unvergesslich und an nichts
  gekoppelt. Eine leere Version wird WEGGELASSEN, nie als `""` gesendet (die
  Cloud muss „unbekannt" von „eine Version namens ''" unterscheiden können).
  `/health` trägt sie ebenfalls (aus `Snapshot.Version`) — das ist der
  maschinenlesbare Endpunkt, den `install.sh`/`update.sh` ohnehin abfragen.
- **`agent/ota.go updateSummary()`** baut den additiven `update`-Block:
  `backend: "compose"`, `current` = der Stempel VERBATIM (ein Bestands-Build
  trägt eine nackte 12-stellige SHA — sie umzuformatieren erfände ein
  Release-Tag), `state: "idle"`. **Alles, was die Box nicht ehrlich wissen kann,
  BLEIBT WEG:** `current_seq`/`target*`/`channel` gibt es erst mit dem
  Cloud-Register bzw. einer Soll-Zuweisung (Stufe 2), und ein
  `last_known_good` hat nur, wer je ein Update angewandt hat — die aktuelle
  Version als solches auszugeben, erfände ein Rollback-Ziel. Eine erfundene
  Sequenznummer wäre besonders teuer: die Cloud ordnet Releases genau danach.
- **`Link.PublishUpdateState` ist VORARBEIT und wird in Stufe 0 von nichts
  aufgerufen.** Sie meldet EINE Zustandsänderung durabel (QoS1, wartet auf den
  Ack) und existiert jetzt, weil der Zweck sich nicht nachrüsten lässt: ein
  Updater muss `applying` als LETZTE Handlung melden, BEVOR er den Stack
  stoppt — nur dann ist „im Update verstummt" ein eigener Zustand statt
  ununterscheidbar von „die Box ist einfach weg". Der 15-s-Herzschlag kann das
  nicht tragen (der Prozess verschwindet gerade).
- Beweise: `internal/cloud/status_test.go` (echter In-Process-Broker: `version`
  MIT und OHNE `flows`-Block, die weggelassenen Felder, der durable Bericht),
  `agent/ota_test.go`, `web` `TestHealthCarriesBuildVersion`. Cloud-Seite +
  Release-Register: root `AGENTS.md` „OTA Stufe 0".

