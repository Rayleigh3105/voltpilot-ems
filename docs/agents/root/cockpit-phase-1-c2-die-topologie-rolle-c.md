# Cockpit Phase 1 / C2: die Topologie-Rolle `charging` (und `charging-own`)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 113).


Konzept `data/vp-verbraucher-cockpit-k1` §6 + §8 Phase 1 (C2), Captain-Entscheid **E3**
(Abzweig vom Haus; eigener Anschluss als Knoten am Hub). Der Laden-Knoten war seit Phase 0
ein reiner Portal-AUFSATZ aus `/chargers`; jetzt ist er eine echte Topologie-Rolle in den
DREI Zwillingen und den geteilten Vektoren. **Alles ist ADDITIV: eine Anlage ohne Ladepunkt
leitet keine der beiden Rollen ab, ihr Read-Model ist byte-identisch** — beidseitig
festgenagelt (Go/TS/Java gegen `topology-vectors.json`, dazu die DOM-Gegenprobe des Portals).

- **⚠ ZWEI Rollen, nicht eine mit zwei Anhängepunkten.** `charging` = die Säulen HINTER dem
  Hausanschluss (ihre Kilowatt stecken schon in der gemessenen Hauslast, ihr Knoten ist ein
  ABZWEIG vom Haus, und die Haus-Summe bleibt „alles hinter dem Anschluss"); `charging-own` =
  die Säulen an einem EIGENEN Netzanschluss (ihre Kilowatt stecken NICHT in dieser Messung,
  ihr Knoten hängt am HUB neben dem Haus). Die zwei Summen werden an ZWEI verschiedenen
  Anschlusspunkten gemessen — sie zu einem Knoten zu addieren wäre EINE Zahl mit ZWEI
  Bedeutungen. Genau darüber löst sich auch „`house-load` zieht `eigen` nicht in den
  Haus-Knoten": eine `eigen`-Säule landet strukturell nie an der Haus-Speiche.
- **⚠ `DefaultRole` nimmt seit C2 VIER Argumente (`entityType, category, channel, connection`),
  und der TYP wird ZUERST geprüft.** Ein Ladepunkt ist im Katalog Kategorie `consumer`, also
  hätte seine `power_kw` ohne den Typ in den Haus-Knoten summiert, IN dem sie schon gemessen
  ist — und sein `soc_pct` wäre über die Speicher-Regel darunter in den Ladestand der
  HAUS-Batterie gelaufen (genau der Grund, aus dem `agent/ocpp_entities.go` ihn nie
  publiziert). Beides sind Falschaussagen über eine Kundenanlage, also werden sie HIER
  beantwortet statt der Zurückhaltung jedes Erzeugers überlassen: der `soc_pct` eines
  Ladepunkts fällt in KEINE Rolle.
- **⚠ `connection` wird AUSSCHLIESSLICH bei einem Ladepunkt konsultiert**, und `""` heisst
  „nicht gesagt" ⇒ gelesen als `haus` — die sichere Richtung (die Hausmessung enthält ihn dann
  annahmegemäss, genau wie das Budget-Gesetz der Box rechnet). Ein Vektor pinnt, dass ein
  `eigen` an einer NICHT-Ladepunkt-Entität den Haus-Knoten nie verschieben kann.
- **Die kanonische Knoten-Reihenfolge ist `pv, storage, consumer, grid, charging,
  charging-own`** — die zwei sind ANGEHÄNGT, damit jeder vor C2 geschriebene Vektor
  byte-identisch bleibt; eine Anlage ohne Ladepunkt emittiert keinen der beiden Knoten.
  Beide Lade-Rollen ziehen (wie `consumer`) aus dem Hub, `isConsuming` ist die eine Stelle
  dafür.
- **Server:** `TopologyService` liest das IST der BOX je Komponente
  (`DeviceChargerStatusRepository.connectionsByEntity`, ein schmaler indizierter Lesevorgang;
  eine Anlage ohne Ladepunkt bekommt eine leere Karte und löst byte-identisch auf wie vorher).
  **⚠ Das ist der IST, nicht das SOLL des Kunden** — die Wahl steht in
  `site_charge_point_allowlist` und erreicht die Anlage erst über das retained Dokument; eine
  Säule, deren Box (noch) nichts meldet, fehlt hier schlicht und liest damit als `haus`.
  `EntityTopologyDto.connection` reist mit, weil das Portal die Rollen-Auflösung des Servers
  nachvollziehen können muss (`rollen.isAutoAssigned`), statt sie zu raten; das
  Rollen-Vokabular der Überschreibungen (`ROLE_VOCAB`) kennt die zwei neuen Wörter.
- **⚠ Zwei Server-Leser mussten den TYP nachziehen, sonst hätte C2 sie still verschlechtert:**
  `EntityRegistryService.measuredRoles` (Registry-Push) und `UsageProfileService.plantSignals`
  — Letzteres, weil der Katalogtyp `ev-charger` `soc_pct` deklariert und eine Anlage MIT
  Wallbox und OHNE Batterie sonst `hasStorage` bekäme, also die Speicher-Flächen. Beide fragen
  mit leerem `connection`: dort ist nur interessant, OB ein Kanal einer Rolle zufällt.
- **Beweise:** Go `internal/topology/topology_test.go` (die Vektoren PER PFAD) · TS
  `src/topology.test.ts` (dieselbe Datei, byte-gleiche Ausgabe) · Java `TopologyDeriverTest`
  (strukturgleich) · `docs/contracts/v2/topology-vectors.json` (4 Topologie-Fälle + 7
  `default_role`-Fälle für die zwei Rollen, den Auto-Ladestand und „`connection` gilt nur am
  Ladepunkt"). Portal-Seite (die zwei Kreise, die Gruppe „Laden (eigener Anschluss)") in
  `frontend/portal/AGENTS.md`.

