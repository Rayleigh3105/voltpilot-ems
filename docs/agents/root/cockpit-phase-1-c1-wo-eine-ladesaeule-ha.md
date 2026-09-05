# Cockpit Phase 1 / C1: WO eine Ladesäule hängt (`haus` | `eigen`)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 112).


Konzept `data/vp-verbraucher-cockpit-k1` §8 Phase 1 (C1) + §8.4 Punkt 5,
Captain-Entscheid **E5** (Flag je Ladepunkt in der Allowlist, reist zur Box).
Bis hierher gab es die Unterscheidung NIRGENDS (Grep `own_connection|eigener
Anschluss|separate_meter`: 0 Treffer in Edge, api, Portal, Verträgen) — das
Budget-Gesetz der Box addierte deshalb JEDE gemessene Ladeleistung zurück, auch
die einer Säule auf einem fremden Zähler. **Alles ist ADDITIV: eine Anlage ohne
Ladepunkt, eine Allowlist-Zeile ohne das Feld und eine Box ohne den Begriff
verhalten sich zeichengleich wie vorher**, und beide Richtungen sind als Test
festgenagelt.

- **⚠ DIE SICHERHEITS-RICHTUNG IST ASYMMETRISCH, und daraus folgt jede andere
  Regel dieser Stufe.** `haus` heißt „ihre Leistung steckt in unserer
  Netzmessung und wird zurückaddiert"; ist die Wahrheit `eigen`, fällt der Rest
  nur zu KLEIN und das Budget zu klein aus — der Hausanschluss bleibt geschützt.
  Umgekehrt wäre er es NICHT: ein fälschlich als `eigen` geführter Ladepunkt
  ließe das Budget um genau seine Leistung zu GROSS ausfallen. Deshalb ist
  `haus` die Vorgabe, deshalb löst **kein einziger Leser** ein Schweigen zu
  `eigen` auf, und deshalb ist ein unbekanntes Wort überall eine ABLEHNUNG statt
  eines Rückfalls (api 400, `csms.NormalizeAdd` Fehler, `chargingcfg.Parse`
  überspringt den EINTRAG, `ChargerStatusListener` verwirft ihn).
- **⚠ SOLL und IST sind ZWEI Aussagen in ZWEI Tabellen** (Migration
  `V20260858000000`, beide Spalten NULLABLE OHNE DEFAULT):
  `site_charge_point_allowlist.connection` ist die WAHL des Kunden (sie entsteht
  im Anbinde-Dialog und reist im retained Dokument zur Box),
  `device_charge_point.connection` ist das, was die BOX MELDET. Erst das IST
  belegt, dass die Unterscheidung dort angekommen ist — eine Portal-Angabe
  allein sagt nichts darüber, wonach die Box rechnet. `NULL` heißt am SOLL
  „nichts gesagt" und am IST „eine ältere Box meldet es nicht" — **nie `eigen`,
  und auch nicht `haus`**.
- **⚠ Der Anschluss ist die EINE Angabe, die auf der Box auch eine SCHON
  BEKANNTE Säule überschreibt** (`agent.applyChargePoints`) — eine bewusste
  Ausnahme von der Nie-überschreiben-Regel, die `label`/`priority` schützt.
  Deren Grund ist, was ein Betreiber AN DER BOX gepflegt haben kann, und für den
  Anschluss gibt es dort gar keine Oberfläche, also nichts zu schützen. Behielte
  sie ihn ein, erreichte ein Kunde, der den Haken später setzt, die Box NIE. Die
  api spiegelt das im `ON CONFLICT DO UPDATE` (`COALESCE`: nicht gesagt =
  behalten).
- **Der Verteilweg ist das BESTEHENDE retained Dokument** (`charge_points[].connection`
  im `mqtt-charging-config`-Kontrakt, `schema_version` bleibt 1.0; Fixture
  `examples/mqtt-charging-config.valid.eigener-anschluss.json`, vom Go-Parser
  PER PFAD gelesen) — kein zweites Topic, keine Broker-Änderung, dieselbe
  PATCH-Semantik: **ein Feld, das der Kunde nicht gesagt hat, wird gar nicht
  erst gesendet** (`ChargingConfigPublisher`), damit ein eingesetztes `haus`
  nie eine Aussage über eine Bilanz erfindet, die niemand getroffen hat.
- **Das Budget-Gesetz liest es** (`csms.Snapshot.ChargingTotal`, der EINE
  Rückaddier-Ort, den `agent/ocpp.go` und `ocpp_surplus.go` teilen): eine Säule
  auf eigenem Anschluss wird ÜBERSPRUNGEN — ihre Leistung war nie in der
  Netzmessung, sie kann die Summe also auch nicht unvollständig machen. Ein
  negativer Messwert bleibt wie bisher auf 0 geklemmt.
- **Der Rückkanal ist die STATION, nicht der Stecker** (`cloud.ChargerEntry.connection`)
  — eine bewusste Abweichung vom Konzept-Wortlaut („Felder je Stecker"): ein
  Ladepunkt hat EINEN Netzanschluss, je Stecker wäre dieselbe Tatsache N-mal
  gespeichert, und zwei Stecker einer Säule könnten sich widersprechen.
- **Portal:** die reine `ladesaeuleAnbinden.ts` trägt die Ortsfrage
  (`ANSCHLUSS_FRAGE`/`ANSCHLUSS_OPTIONEN`/`ANSCHLUSS_VORGABE`) und die vier
  Ableitungen `anschlussSoll`/`anschlussWahl`/`anschlussZumSenden`/`anschlussSicht`;
  `LadesaeuleAnbinden.tsx` rendert sie in Schritt 1. **⚠ Eine UNVERÄNDERTE Wahl
  sendet NICHTS** (das Dokument bliebe byte-gleich, eine Zustellung ohne
  Änderung wird gar nicht ausgelöst); beim ERSTEN Eintragen reist sie dagegen
  immer mit — der Kunde hat sie gesehen und stehen lassen, und genau das ist
  eine Aussage. Der Abweichungs-Satz erscheint NUR, wenn die Box wirklich etwas
  ANDERES meldet — Schweigen ist keine Abweichung.
- **Beweise:** Go `internal/chargingcfg` (die Kontrakt-Fixture PER PFAD, ein
  unbekanntes Wort überspringt den Eintrag) + `internal/csms` (der Skip im
  Budget, und „ohne Angabe zählt es exakt wie vorher") +
  `agent/charging_config_test.go` (eingetragen UND auf einer bekannten Säule
  nachgezogen, ein Dokument ohne das Feld lässt sie in Ruhe, der Herzschlag
  nennt sie) · api `ChargingConfigPublisherTest` (+2: reist nur auf Ansage, die
  Fixture bytegenau) + `ChargerStatusListenerTest` (+1: aufgenommen, unbekanntes
  Wort verworfen) + Testcontainers `ChargerApiTest.theOwnConnectionIsChosenInThePortalAndTheBoxReportsItsOwnTruth`
  · Portal `ladesaeuleAnbinden.test.ts` (+11) + `LadesaeuleAnbinden.test.tsx`
  (+6), die zwei Ehrlichkeitsregeln mutationsgeprüft.
- **Ops:** keine neue Pflicht-Variable, kein Flag. Die EDGE-Hälfte reist mit dem
  nächsten Edge-Release (eine laufende Box behält ihr Image und überliest das
  Feld — sie rechnet dann weiter wie bisher, also hinter dem Haus); Cloud und
  Portal sind sofort lieferbar.
- **Seit C2 ist das Flag SICHTBAR** — siehe den nächsten Abschnitt.

