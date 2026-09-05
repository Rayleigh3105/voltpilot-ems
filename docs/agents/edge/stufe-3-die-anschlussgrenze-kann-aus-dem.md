# Stufe 3: die Anschlussgrenze kann aus dem PORTAL kommen (`internal/chargingcfg`)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 73).


Der Konsument des retained Dokuments `ems/{t}/{s}/{d}/v2/charging-config`
(Kontrakt `docs/contracts/mqtt-charging-config.schema.json`). Additiv: eine Box,
der niemand ein Dokument schickt, verhält sich zeichengleich wie vorher.

- **Es kommt eine EINSTELLUNG an, nie eine Grenze.** Der Verteiler rechnet
  danach wie immer in `internal/lastmgmt` — die Anschlussgrenze ist eine
  physische Grenze, ihr Wächter darf nicht am WAN hängen (E1). `agent/
  charging_config.go` ist reine Verdrahtung: jede Regel liegt im reinen
  `internal/chargingcfg` (Parsen + Plausibilität) bzw. in `lastmgmt`.
- **⚠ PATCH-Semantik: ein ABWESENDES Feld behält den Wert der Box.** Das Portal
  besitzt heute nur die Anschlussgrenze und die Vorrang-Wahl; Sicherheitsabstand,
  Mindestleistung und die höchste bekannte Gebäudelast bleiben `:8484`-
  Einstellungen. Eine LEERE Vorrang-Liste ist dagegen eine AUSSAGE („keine Säule
  hat Vorrang") und wird angewandt — sonst wäre „niemand mehr" unaussprechbar.
- **Eine Grenze ≤ 0 wird ABGELEHNT, nicht angewandt:** ohne Grenze ist das
  Budget 0 und es lädt nichts, und das käme dann aus einem Tippfehler. Ebenso
  fail-closed: eine fremde Vertragsversion, unlesbare Bytes, eine fremde
  Identität (Topic == Payload, die Regel jedes Downlinks; stumm zum Broker,
  laut im Protokoll).
- **Die RÜCKNAHME (leere retained Nachricht) lässt die übernommenen Werte
  STEHEN.** Sie zurückzusetzen wäre eine Änderung an einer laufenden Anlage, die
  niemand angeordnet hat — und die Box wüsste auch nicht, worauf. Von da an gilt
  wieder allein, was auf `:8484` gepflegt wird.
- **Bekannte Grenze:** `:8484` bleibt editierbar, es gilt also last-writer-wins,
  und ein retained Dokument setzt sich beim nächsten Verbindungsaufbau wieder
  durch. Ein Nur-Lese-Spiegel wie bei der Komponenten-Autorität ist Folgearbeit.
- Beweise: `internal/chargingcfg` (7, inkl. der Kontrakt-Fixtures per PFAD) ·
  `agent/charging_config_test.go` (3: die PATCH-Wirkung samt Vorrang-Rücknahme,
  fremdes/kaputtes Dokument ändert NICHTS, eine Box ohne OCPP überlebt es).
- **Seit Stufe 4 trägt dasselbe Dokument die QUELLEN-Wahl** (`surplus_policy`
  / `storage_priority`, beide additiv und OPTIONAL). **⚠ `nil` heißt „das Portal
  sagt dazu nichts" und ist NIE `schnell`** — sonst nähme das erste gespeicherte
  Dokument einer Box still ihre auf `:8484` gepflegte Politik weg; ein
  unbekanntes Wort lehnt dagegen das GANZE Dokument ab (fail-closed wie jede
  andere Form-Verletzung). Angewandt wird beides über EINEN
  `OcppSaveSettings`-Aufruf zusammen mit der Grenze — zwei Aufrufe wären zwei
  Zwischenzustände.
- **Seit Geräteseiten Stufe 3 (E1) trägt dasselbe Dokument die ALLOWLIST**
  (`charge_points[]`, additiv und OPTIONAL): das Portal ist damit ein zweiter
  PFLEGE-Ort für die Kennungen, unter denen `internal/csms` eine Säule überhaupt
  annimmt. **Es ist KEIN Anlern-Fenster** — eine unbekannte Kennung wird
  weiterhin abgewiesen und protokolliert.
  - **⚠ `applyChargePoints` FÜGT NUR HINZU** (`agent/charging_config.go`): keine
    bekannte Kennung wird überschrieben, und ein WEGGELASSENER Eintrag entfernt
    nie etwas. Das ist der Grund, warum eine Rücknahme AUSDRÜCKLICH sein muss
    (nächster Punkt): eine Box, die beim Speichern offline war, darf ihre
    Kennungen nicht verlieren, weil ein späteres Dokument sie nicht aufzählt.
    Ein abgewiesener Eintrag (Rate, Form) wird protokolliert und übersprungen,
    nie stillschweigend verschluckt.
  - **⚠ Die RÜCKNAHME ist eine eigene Liste — `removed_charge_point_ids`, seit
    dem 24.08.2026** (Captain-Order; additiv, `schema_version` bleibt 1.0).
    `applyChargePointRemovals` läuft NACH `applyChargePoints` und VOR dem
    Vorrang, entfernt nur, was diese Box wirklich KENNT (`csms.Remove` trennt
    die Verbindung, ein Wiederverbinden wird abgewiesen), protokolliert jede
    Rücknahme und ist idempotent — der Grabstein reist in JEDEM folgenden
    Dokument mit und darf nicht bei jedem Takt etwas tun.
  - **⚠ Bei einem WIDERSPRUCH gewinnt die Rücknahme:** steht eine Kennung in
    beiden Listen, streicht `chargingcfg.Parse` sie aus `ChargePoints`, BEVOR
    irgendetwas zugelassen wird — ein Dokument, das eine gerade gelöschte
    Kennung wieder einträgt, darf sie nicht durch die Hintertür zurückbringen.
  - **Ein ÄLTERER Box-Stand tut nichts Falsches:** Gos `encoding/json` überliest
    das unbekannte Feld, die Säule bleibt zugelassen — der vorige Zustand, nie
    eine falsche Handlung. Die Rücknahme wirkt damit erst mit dem NÄCHSTEN
    Edge-Release, und das Portal sagt das auch.
  - **⚠ Die Allowlist wird VOR dem Vorrang angewandt**, sonst bekäme eine gerade
    eingetragene Säule den Vorrang DESSELBEN Dokuments erst beim nächsten
    Speichern. Deshalb trägt der Umschlag auch kein `priority` je Zeile: die
    Vorrang-MENGE ist die ganze Aussage, zwei Wahrheiten über denselben Rang
    wären eine zu viel.
  - **Eine LEERE Liste ist hier KEINE Aussage** (anders als beim Vorrang, der
    eine Menge ERSETZT) — sie wird deshalb gar nicht erst gesendet.
- **Der Herzschlag nennt seit E1 den EIGENEN Anschluss** (`ocpp_port`/`url_path`
  im `chargers`-Block, aus `csms.Snapshot`): daraus baut das Portal die
  `ws://`-Adresse zum Kopieren. **⚠ Beide werden WEGGELASSEN, solange der Server
  nicht lauscht** — ein Anschluss, unter dem niemand antwortet, wäre schlimmer
  als gar keiner.

