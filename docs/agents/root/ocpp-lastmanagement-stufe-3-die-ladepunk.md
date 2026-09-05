# OCPP-Lastmanagement Stufe 3: die Ladepunkte werden CLOUD-sichtbar

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 133).


Die Cloud sieht zu, sie entscheidet nicht (Konzept §5, E1): Budget und
Verteilung bleiben auf der Box, weil die Anschlussgrenze physisch ist. Der
Herzschlag trägt seit Stufe 3 den additiven `chargers`-Block (Edge-Seite +
Einrichtungs-Tor: `edge-app/AGENTS.md`), und diese Seite ist sein Speicher.

- **`ChargerStatusListener` ist das ACHTE Geschwister** auf `ems/+/+/+/status`
  (Flag `VOLTPILOT_CHARGERS_MQTT_LISTENER_ENABLED`, in BEIDEN Composes an) mit
  der Haltung aller anderen: Broker-ACL + mTLS-CN, Topic-==-Payload-Identität
  nachgeprüft, Gerät über die RLS-Repository unter dem Mandanten des Topics.
  **Kein Schreibpfad zum Gerät** — auch der Lesepfad `GET
  /api/v1/sites/{id}/chargers` bietet bewusst keine Route, die eine Ladegrenze
  setzt (dieselbe Regel wie die `:8484`-Karte seit Stufe 0).
- **Drei Tabellen** (Migration `V20260828000000`, RLS + FORCE, je Herzschlag
  GANZ ersetzt — die `device_source_status`-Disziplin): `device_charging_budget`
  (eine Zeile je Gerät — das Budget gehört dem STANDORT), `device_charge_point`,
  `device_charge_connector`. Eine Säule OHNE gemeldete Stecker muss sichtbar
  bleiben („eingetragen, hat sich noch nicht gemeldet"), deshalb sind Stecker
  eine eigene Tabelle statt Spalten der Säulen-Zeile.
- **⚠ Jede Zahl und JEDER deutsche Satz wird durchgereicht, nie neu
  formuliert** (`budget_note`, `reason_text`, `safe_default_note`): sie
  entstehen EINMAL in `internal/lastmgmt`, und nur die Box kennt die Zahlen
  dahinter. Zwei Ehrlichkeits-Regeln beim Ingest: ein Statuswort ausserhalb des
  OCPP-1.6-Vokabulars wird VERWORFEN statt gespeichert, und ein fehlender
  Messwert bleibt NULL — ein Ladepunkt, der nichts meldet, lädt nicht
  nachweislich nichts (`safe_default_holds` ist deshalb DREIWERTIG).
- **Aus der gemeldeten Säule wird eine KOMPONENTE, ohne einen Klick**
  (`ChargerComponentComposer`, telemetrie-getrieben + NIE werfend — das
  `EntityAutoComposer`-Muster): Katalog-Typ `ev-charger`, angelegt über
  `EntityRegistryService.createEntity`, also entscheidet weiterhin EINE Stelle,
  WAS komponiert wird. Die Bindung steht in `device_charge_point.entity_id`
  (ohne Fremdschlüssel, das `rollout_device.device_ref`-Muster) und überlebt das
  Ersetzen des Satzes: **genau EINMAL je Säule**, und eine bewusst gelöschte
  Komponente wird nicht beim nächsten Herzschlag neu erfunden.
- **⚠ Die Komponente trägt KEINE `connection_json`.** Eine Anbindung, die
  `componentapply.ParseDriver` nicht kennt, ließe seine ALLES-ODER-NICHTS-
  Ableitung scheitern und nähme einer Anlage mit ihrer ersten Ladesäule die
  Anwendung ihres Wechselrichters — dieselbe Falle, gegen die der
  Selbstbau-Skip existiert. Die LEBENDEN Zahlen kommen deshalb aus
  `/chargers`, nicht aus der Entität.
- **Bekannte Grenze:** je-Ladepunkt-Messwerte im Messwerte-Explorer
  (`telemetry_v2`) gibt es NICHT — die Säulen melden über den Herzschlag, nicht
  über Entitäts-Telemetrie; das ist Stufe-4-Folgearbeit.
- **Beweise:** `chargers/ChargerStatusListenerTest` (8, rein) ·
  `ChargerApiTest` (echte DB + Keycloak: die Reise durch den ECHTEN Zuhörer,
  Komponente ohne Klick + genau einmal, Ersetzen ohne Geister, ehrlich leere
  Antwort, Mandanten-Zaun).

