# Zusätzliche Messwerte: Auswahl- und Auditfundament (Slice 5)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 155).


- **Die Cloud speichert Soll, nicht behauptete Wirkung.**
  `device_measurement_selection` hält den gewünschten revisionierten Zustand;
  `device_measurement_selection_event` ist für App- und Admin-Rolle append-only;
  spätere `edge_ack`/`first_sample`-Übergänge werden als neue Zeilen derselben
  `desired_revision` angehängt, nie in eine alte Anforderung hineingepatcht. Beide
  tragen Tenant/Site/Device, Katalogversion, Kadenz, Akteur, D6-Retention und
  RLS + FORCE. Bis der spätere Edge-Ack-Pfad existiert, bleibt jeder neue
  Vorgang ehrlich `pending_edge` mit `applied_at = NULL`.
- **Aktivierung beginnt serverseitig jetzt.** `enabled_at` kommt ausschließlich
  aus DB-`now()` und ist die spätere Writer-No-Backfill-Grenze. Abwahl ist ein
  UPDATE mit `disabled_at`; weder Auswahlzeile noch Events werden gelöscht.
- **Der Standort eines Geräts ist nach dem Claim stabil.** Der frühere
  Kunden-Standortwechsel samt Preview/Apply/Status und Retry-Job ist entfernt;
  das Portal und die API bieten keinen Umzug mehr an. Ein reiner
  Kompatibilitäts-Worker verarbeitet nur noch vor dem Entfernen bereits
  angenommene `pending`-Vorgänge bis zu einem Endzustand; ein neuer Vorgang kann
  nirgends mehr erzeugt werden. Die bereits angewendeten
  Flyway-Strukturen (`device_site_assignment`, `move_provisioning_operation`)
  bleiben für Schema-, Audit- und Rollout-Kompatibilität bestehen - eine
  angewendete Migration wird niemals nachträglich geändert oder gelöscht.
- **API:** `/api/v1/devices/{deviceId}/measurement-selection/**` liefert
  Katalogsuche/Facetten, Status/Audit, Budget-Preview, optimistic/idempotente
  Auswahl und „Eigenen Messwert hinzufügen“. Freie Register sind ausschließlich
  `modbus_holding|modbus_input`, `readOnly=true`, vollständig typ-/adress-/
  skalen-/einheiten-/kadenzvalidiert; dieser Pfad hat keine Schreibfunktion und
  setzt Request-Kosten ausschließlich serverseitig konservativ (2000 ms) an.
  **⚠ Die ruhige Beobachtungsliste fragt den Katalog mit `selectedOnly=true`:**
  der Gesamtkatalog ist auf 250 Punkte je Seite gedeckelt, Deye `hybrid_3p`
  trägt aber mehr als 600 lesbare Punkte (PV2 Spannung liegt hinter Position
  500). Eine erste Katalogseite ist deshalb niemals ein Statusabruf. Der Filter
  materialisiert zusätzlich konkrete dynamische `[*]`-Auswahlen.
- **Kein zweiter Katalog im API-Service.** Maven paketiert die in
  `measurement.catalog.version` festgelegte kanonische Datei aus
  `catalog/measurement-points/dist/` bytegleich
  ins JAR. Deshalb baut das API-Image mit Repo-Root als Docker-Kontext und
  `services/api/Dockerfile`; Compose und beide Deploy-Workflows müssen diese
  Kontextform beibehalten.
- **D5/D6 sind ausführbare Policy.** Kein Punktzahl-Limit; Warnung ab 120
  Samples/min, hart 600 oder engeres per-Familien-Treiberbudget sowie 30
  Requests/min/20 % Duty. Volumen rechnet konservativ mit 96 B (Korridor
  64–128), 90 Tagen roh und danach 5 min für Leistung/Phasen/MPPT bzw. 15 min
  für Thermik/BMS/Zähler; Zustände/Ereignisse und Identitätsänderungen behalten
  ihre eigene Historienstrategie. MQTT, Edge-Pollplan und Sample-Hypertable
  gehören ausdrücklich in die folgenden Slices.

