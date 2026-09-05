# OCPP-Datenfundament (Slice 10): vollständig lesen, noch NICHT fernsteuern

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 136).


Der Edge bleibt das lokale CSMS. Slice 10 transportiert sein vollständiges,
bereits privacy-redigiertes OCPP-1.6-Journal per QoS1 auf
  `ems/{tenant}/{site}/{device}/v2/ocpp-events` zur API. Slice 10 selbst war
  GET-only; der darauf aufbauende Command-Gateway aus Slice 11/12 steht im
  direkt folgenden Abschnitt.

- **Migration `V20260840000000`** besitzt die normalisierten Stations-/Stecker-,
  Autorisierungs-, Transaktions-, MeterValue-, Diagnose-/Firmware-,
  Konfigurations-/unknownKey-/Capability-Readmodels plus das vollständige
  Call/CallResult/CallError-Journal. Alle elf Tabellen tragen `tenant_id`, RLS
  UND FORCE RLS; Roh-/Diagnose-/personenbezogene Daten laufen nach 90 Tagen aus,
  der Retention-Job leert dann auch `transactionData` und `tagref_*` im
  langlebigen, nicht-personenbezogenen Transaktionskopf. Das additive Review-
  Hardening `V20260840010000` bindet jede OCPP-Zeile per Composite-FK an exakt
  ihr `(device,site,tenant)` und kaskadiert beim Device-Delete; Geräte-Purge,
  Unclaim, Site-Delete und Tenant-Offboarding löschen dieselben elf Tabellen
  zusätzlich explizit in ihrer bestehenden DB-Transaktion. Der Retention-Job
  bereinigt nun auch seit >90 Tagen unveränderte offene Transaktionen.
- **Ein SampledValue ist eine Zeile.** Der kanonische `point_key` enthält immer
  `measurand/context/format/phase/location/unit`; fehlende OCPP-Felder bekommen
  ausschließlich ihre Spec-Defaults bzw. den ehrlichen Sentinel `None`.
  Phasen/Orte/Formate werden nie aggregiert oder zusammengeführt.
- **Privacy ist zweistufig:** der Edge redigiert vor Disk; `OcppPrivacy` macht
  dasselbe vor Postgres noch einmal (alte/kompromittierte Edge). Klare idTags
  werden nur als stabile `tagref_*` gespeichert. `AuthorizationKey` und
  secret-/password-/token-artige Vendor-Keys haben im DB- und API-Modell immer
  `value=null`; Diagnose-/Firmware-URLs und untypisierte DataTransfer-Daten
  landen nie roh im Journal. Achtung: `MeterValues.location=Outlet/EV/...` ist
  eine Messdimension, keine URL. `CallError.error_description` ist untypisierter
  Vendor-Freitext und wird deshalb an BEIDEN Grenzen vollständig auf
  `[redacted-call-error-description]` reduziert; Error-Code und redigierte
  Details bleiben erhalten. Auch der `ocpp-go`-Callback-/Status-/Log-Pfad wird
  am Edge auf Code + Marker normiert. Eine DB-CHECK-Constraint verhindert
  Umgehungen.
- **Zustellung ist über Neustarts belastbar:** der API-Listener verwendet die
  stabile, konfigurierbare MQTT-Client-ID `VOLTPILOT_OCPP_MQTT_CLIENT_ID`, eine
  persistente Broker-Session (`cleanSession=false`) und manuelle QoS1-ACKs erst
  nach abgeschlossener DB-Verarbeitung. Pro horizontaler API-Replika ist eine
  eigene stabile ID Pflicht; dieselbe ID auf zwei laufenden Pods würde sie
  gegenseitig vom Broker trennen.
- **Lücken werden nicht verschwiegen:** Überlauf (10.000 Dateien) sowie Event-
  Write-/Commit-/Encode-Fehler erhöhen einen persistenten monotonen Zähler im
  Edge-Ledger `ocpp-journal-gaps.json`. Der Upload priorisiert daraus ein
  idempotentes internes `JournalGap` mit Anzahl, Gründen und betroffenem Zeit-/
  Eventbereich; die Cloud persistiert es im normalen Journal und liefert es
  explizit über `GET .../ocpp/gaps`. Ledger und Gap überleben Neustarts bis zum
  QoS1-ACK. Purge entfernt auch beschädigte/undekodierbare OCPP-Spool-Dateien
  sowie nach einem Crash vor dem Rename verwaiste, streng auf das eigene Muster
  `.<UTC-Zeit>_<v4-Event-ID>.json.tmp` begrenzte Temp-Artefakte; ein Remove-
  Fehler bleibt mit dem davor restart-fest persistierten Cloud-Auftrag retrybar.
  Cloud-Purge und Ingest
  teilen einen DB-weiten Device-Lock; alte Replays scheitern innerhalb der
  Ingest-Transaktion an `device.data_purged_before`, post-Watermark-Ereignisse
  überleben vollständig auch dann, wenn Edge und API-Replikate konkurrieren.
- **Die Slice-10-Leseseite ist strikt GET-only:**
  `/api/v1/sites/{siteId}/ocpp/{stations,events,gaps,transactions,meter-values,configuration,action-permissions}`.
  Kunden lesen über normalen JWT-Tenant + RLS, Plattform-Admins wie bei allen
  Site-Pfaden über `X-Tenant-Id`. `OcppActionPolicy` materialisiert D4 für den
  Command-Gateway: operator < site-admin < platform-admin; die Map ist zugleich
  Auskunft und serverseitig erzwungene Vollmacht. Beide Realm-Importe kennen
  `site-admin`; bestehende Realms brauchen wie jede Realm-Änderung ein manuelles
  Nachziehen. Das bestehende Realm-Role `admin` bleibt als rückwärtskompatibler
  Alias derselben Anlagenadministrator-Stufe autorisiert.
- **Bestehende Verträge bleiben stehen:** `device_charging_*`, Charging-Boost
  und der Smart-Charging-Executor werden nicht ersetzt. Das bestehende
  Commissioning liest die vier bekannten Safe-Keys GEZIELT vor jedem Profil.
  Erst nach installierter Höchstgrenze + TxDefault folgt eine getrennte,
  best-effort GetConfiguration-Abfrage mit leerer Key-Liste (= alle Schlüssel);
  ihre Ablehnung kann die Schutzprofile nie verhindern. Das Journal bewahrt bei
  Erfolg readonly, unknownKey, SupportedFeatureProfiles und Vendor-Keys.
  Bestehende SetChargingProfile-
  Calls werden nur als Profilbezug an die Transaktion DERIVIERT, nie ausgelöst.
- Verträge: `docs/contracts/mqtt-ocpp-events.schema.json` + die sieben GET-Pfade
  in `openapi.yaml`. Beweise: `OcppPrivacyTest`, `OcppEventListenerTest`,
  `OcppActionPolicyTest`, der OCPP-Fall in `PortalApiTest`, der FORCE-RLS-
  Angriff in `RlsIsolationTest`, Edge `csms/journal_test.go` und Rig L10.

