# Edge-Stand: installierter Core + Palette werden endlich gelesen

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 9).


Die Edge sendet ihren installierten Core-Stand in JEDEM Status-Herzschlag als
Top-Level-`version`; der `flows`-Block traegt zusaetzlich die Palette, existiert
aber erst nach einem Flow-Deployment. Beide Speicher werden im Kunden-Lesepfad
zusammengefuehrt:

- **Tabelle `device_edge_version`** (api-Migration `V20260803000000`): eine Zeile je Gerät, bei jedem Herzschlag ersetzt, RLS + FORCE wie `device_control_status`/`flow_device_ack`. `EdgeVersionRepository` schreibt (`tenant_id` aus der RLS-Sitzung, nie aus dem Aufruf) und liest ohne Mandanten-Prädikat.
- **Der Ingest hängt am `FlowNodeStatusListener`, NICHT an einem fünften Geschwister.** Die Curtailment-Regel („zwei unabhängige Blöcke, zwei Listener") greift hier gerade nicht: die Versionen sind FELDER des `flows`-Blocks, den dieser Listener ohnehin parst — ein eigener Listener wäre eine zweite Broker-Verbindung und eine zweite Identitätsprüfung für dieselben Bytes. Folge: der Ingest hängt am Flag `voltpilot.flows.mqtt-listener-enabled` (in beiden Composes an).
- **Zwei Grenzen, die JEDE Oberfläche kennen muss:** (1) die Edge baut den `flows`-Block erst, nachdem sie einen Deployment-Satz gesehen hat (`Deployer.Summary()` liefert vorher nil), deshalb darf der installierte CORE-STAND nie von diesem optionalen Block abhaengen; (2) traegt der Block keines seiner Versionsfelder, wird keine leere `device_edge_version`-Zeile geschrieben.
- **Lesepfad `GET /api/v1/edge-versions`** (`EdgeVersionController`, in `openapi.yaml`): bewusst eine KUNDEN-förmige, RLS-gefencte Route wie `/overview`. `EdgeVersionRepository.findAll` beginnt bei `device`, nimmt fuer `coreVersion` zuerst `device_update_status.version` (danach dessen Legacy-`current_version`, zuletzt den alten `device_edge_version.core_version`) und ergaenzt die Palette aus `device_edge_version`. So zeigt auch eine Box OHNE Flow-Deployment ihren tatsaechlich installierten Stand. Ein Kunde sieht nur die eigenen Geräte; der Plattform-Puls liest weiterhin den Fleet-Endpunkt.
- **Der Maßstab für „veraltet" ist SEIT OTA STUFE 0 das Release-Register** (`edge_release`, siehe den nächsten Abschnitt) — der frühere Flotten-Maximum-Proxy `adminFleet.newestCoreVersion` und der Zahlenblock-Vergleich sind ENTFALLEN.
- Beweise: `FlowNodeStatusListenerTest` (Palette/Legacy-Core aus dem `flows`-Block) + `PortalApiTest.edgeVersionIsIngestedFromTheFlowsHeartbeatAndTenantScoped` (echte DB: RLS, Ersetzen und vor allem Top-Level-`version` OHNE `flows`).

