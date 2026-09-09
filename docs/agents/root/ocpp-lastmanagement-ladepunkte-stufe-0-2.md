# OCPP-Lastmanagement (Ladepunkte): Stufe 0-2

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 132).


Die Box ist das **Central System**, das die Ladesäulen anwählen — die
Anschlussgrenze ist eine PHYSISCHE Grenze, ihr Wächter darf nicht am WAN
hängen (Konzept `data/vp-ocpp-lastmgmt-konzept-w4`, Captain-Entscheide E1–E5;
Flächen `data/vp-ocpp-mockups-r5`). Alles liegt in `edge-app/core`, die Cloud
ist unbeteiligt (Portal/Herzschlag sind Stufe 3). **Alle Details und die
Fallstricke stehen in [`edge-app/AGENTS.md`](edge-app/AGENTS.md)**; hier nur,
was jede Session wissen muss:

- **Vier Pakete:** `internal/csms` (OCPP 1.6J CSMS, `lorenzodonini/ocpp-go`
  **MIT** in GENAU zwei Dateien gekapselt), `internal/lastmgmt` (die reine
  Verteilung + die Ausfall-Profil-Ableitung), `agent/ocpp.go` (der Executor),
  `internal/ocppsim` + `cmd/vp-ocpp-sim` (der Ladesäulen-Simulator).
- **⚠ HERSTELLERNEUTRAL ist Konstruktion** (Konzept §0, VERBINDLICH): Identität
  ist die OCPP-ChargePointId; `vendor`/`model`/`firmware` werden nur ANGEZEIGT,
  kein Code verzweigt auf sie, und `DataTransfer` antwortet `UnknownVendorId`.
- **⚠ Der Totmann ist OCPPs eigener:** permanente `ChargePointMaxProfile` +
  `TxDefaultProfile`, die lebende Zuteilung nur als `TxProfile` mit kurzer
  `duration`. Stirbt die Box, fällt jede Säule VON SELBST auf ihr
  Sicherheitsprofil zurück — dafür muss nichts von uns funktionieren.
- **⚠ Drei Schalter, zwei Tore — und `VP_OCPP_ENABLED` ist seit dem 24.08.2026
  ein OPT-OUT (Vorgabe AN, Captain-Order „ohne .env brauch ich nicht"):** es
  startet den Server und hinterlegt die SCHÜTZENDEN Profile; die LEBENDE
  Zuteilung braucht `VP_CONTROL_ENABLED` und die explizite OCPP-Freigabe;
  abwesend gilt weiter `VP_CONSUMER_CONTROL_ENABLED`. Ohne sie läuft die Anlage sicher auf
  `n × Sicherheitsprofil`, und die `:8484`-Fläche sagt welcher Schalter fehlt.
  **Das Tor bleibt die ALLOWLIST, nicht dieses Flag:** eine unbekannte Kennung
  wird beim Websocket-Aufbau abgewiesen und protokolliert, die LAN-Grenze ist
  wie bei `:8484` das Port-Mapping plus die Host-Firewall. Ein laufender Server
  ohne einen einzigen Eintrag ist damit wirkungsgleich zum abgeschalteten — er
  erspart nur den `.env`-Schritt (das `VP_OTA_PRUNE`-Muster: Vorgabe an, ein
  ausdrückliches `false` gewinnt).
- **Scope-Zaun (E4): Lastmanagement pur** — keine Abrechnung, kein Eichrecht,
  kein OCPI; freies Laden bleibt Vorgabe, eine explizite lokale Kartenfreigabe
  ist additiv verfügbar. Sitzungen bleiben BETRIEBSdaten (siehe `docs/ocpp-control.md`).
- **Katalog-Typ `ev-charger` („Ladepunkt")**, additiv, Kommando
  ausschließlich `limit_kw`, Status ehrlich `simulator_only` — der Flip auf
  zertifiziert braucht EINE beaufsichtigte Bench-Session je Säulen-TYP
  (CONTROL-BENCH.md, die Deye-/go-e-Disziplin).
- **Stufe 2 — das Budget FOLGT dem gemessenen Netzanschluss**
  (`internal/lastmgmt/budget.go`, der Import-Zwilling von
  `guards/exportlimit.go`): `budget = planbar − (gemessener Netzbezug −
  gemessene Ladeleistung)`, §14a most-restrictive-wins. **Die gemessene
  Ladeleistung MUSS zurückaddiert werden, sonst schwingt die Schleife**, und
  eine unvollständige Messung ist keine Messung. Die Fail-Safe-Kette ist die
  UMKEHRUNG jedes ökonomischen Guards (halten → zusammenziehen → sicheres
  Budget, nie freigeben); **ohne Messung ist alles byte-gleich Stufe 1**.
- **Beweis:** `edge-app/test/e2e-ocpp.sh` (L1–L9, **Docker-frei**) misst an den
  simulierten Zählerwerten, nie an Quittungen — L6 fährt den dynamischen Fall
  gegen einen simulierten Netz-Zähler (`cmd/vp-netz-sim`), inklusive Messausfall.
  Der MVP ist damit simulator-bewiesen — eine echte Säule braucht die
  Bench-Session.
- **NICHT gebaut:** PV-Überschuss + Optimierer-Kopplung (Stufe 4). Die
  Cloud-Sichtbarkeit ist Stufe 3, siehe den nächsten Abschnitt.

