# Vertragsende I: der Kundenbereich „beendet" (UEMS AP-20 IP-16)

E10 = A, BT4, RF-08: der Betreiber setzt einen Kundenbereich auf „beendet"; danach ist jeder
Schreibweg `409 kundenbereich_beendet`, nur der Kundenadministrator liest noch, die Datenannahme
verwirft mit Zählung. IP-17 (Gesamtabzug) und IP-18 (sofortiges Löschen, Löschnachweis) stehen unten.

- **Zustand:** `tenant.beendet_am` / `beendet_frist_tage` / `beendet_von` (`V20260925170000`).
  NULL = aktiv — bewusst keine Zustandsspalte mit Default (sie änderte jede Bestandszeile, der
  Bestandsschutz der Migrationsnachbarn schlüge an). Trigger `tenant_beendet_einmalig`: ein
  beendeter Bereich wird nie umgeschrieben, die App-Rolle ändert die Spalten nie.
- **Übergänge:** `POST /api/v1/admin/tenants/{id}/beenden` (Auftrag, Begründung, Name
  eintippen, `fristTage` Startwert 90) und `…/wiederaufnehmen` (Auftrag, Begründung) —
  `AdminKundenbereichEndeController`, je EINE Anweisung mit Vorzustand im `WHERE` und
  Protokollzeile `kundenbereich_uebergang` (Admin-Rolle nur SELECT/INSERT, FK CASCADE, damit der
  Löschweg unverändert bleibt). Zweiter Aufruf = 409.
- **Sperre:** `KundenbereichEndeFilter` in der `secured`-Kette nach dem `ZugriffFilter` — vor
  Handler, Körper-Leser und `RechtInterceptor`. Kundenrouten: jedes Nicht-GET 409; Lesen nur
  Kundenkonto mit Zuweisung „Kundenadministrator" oder Bestandskonto; `/me` für alle — die
  Selbstauskunft trägt `kundenbereich.beendet {beendet_am, liest, text}` (aktiv: `null`); der Satz
  verspricht seit vp-kunde-sofort-loeschen-mit-daten kein Löschdatum mehr (kein `loeschung_fruehestens`
  irgendwo im Körper). Plattform-Routen mit `{tenantId}`/`{siteId}`/
  `{deviceId}` im Pfad: jedes Nicht-GET 409 — der Satz spricht den Admin an
  (`KundenbereichEnde.textAdmin`), nie der Kundensatz „Ihr Vertrag …" —, außer `ADMIN_AUSNAHMEN`
  (beenden, wiederaufnehmen, `delete` - seit vp-kunde-sofort-loeschen-mit-daten IMMER, mit oder ohne
  Daten -, `offboarding/cleanup`, Konto sperren) und den Betreiber-Aktionen am
  Box-Lebenszyklus über die externe Referenz (`ADMIN_BOX_BETREIBER_AKTIONEN`: Vom Kunden lösen,
  Box ausbauen, endgültig löschen — EINE Stelle, vp-kunde-sofort-loeschen/vp-admin-box-ausbauen;
  eine neue Betreiber-Handlung am beendeten Kunden trägt sich dort bzw. in `ADMIN_AUSNAHMEN` ein,
  nirgendwo sonst). **Falle:** der Filter steht
  vor der Autorisierung — auf Plattform-Pfaden antwortet er nur einer Plattform-Rolle, sonst
  verriete er Zustand und Daten eines fremden Bereichs.
- **Neue Route unter `/api/v1/admin/` mit Kundenbereich unter anderem Variablennamen** (z. B.
  `{kundenbereich}`): der Filter erkennt sie nicht. `KundenbereichBeendetApiTest` fällt dann auf
  (`OHNE_KUNDENBEREICH` ist genau) — Muster in `KundenbereichEndeFilter` ergänzen, nicht die Liste.
- **Datenannahme:** `BeendeteKundenbereiche` (ingest) liest `tenant.beendet_am` höchstens einmal
  je Minute mit den Zugangsdaten der Box-Auskunft; Treffer = `voltpilot_ingest_verworfen_total
  {grund="kundenbereich_beendet"}`, quittiert, KEIN `rejected`-Ereignis (das wäre selbst ein
  Schreibweg in den Bereich). Lesefehler behält den letzten Stand; die API sperrt sofort, der
  ingest spätestens nach einer Minute.
- **Portal:** `KundenbereichEndeHinweis` in `AppShell` über dem Unterstützungs-Hinweis, gespeist aus
  `selbst.kundenbereich.beendet` — **keine eigene Anfrage**: eine erste Fassung holte eine eigene
  Route und machte 76 E2E-Fälle rot (`ERR_CONNECTION_REFUSED` auf der Bühne, die Specs zählen
  Konsolenfehler). Der Satz kommt aus der API (`KundenbereichEnde.text()`), er nennt den
  Gesamtabzug nur für den Kundenadministrator (`KundenbereichEnde.textKundenadministrator()`, §5.8).
- **Wege ohne Route (Folgepaket zu IP-16):** EINE Stelle `BeendeteKundenbereiche` (api, liest
  `tenant.beendet_am` höchstens einmal je Minute über die Admin-Verbindung; Lesefehler = letzter
  Stand; `beenden`/`wiederaufnehmen` dieser Instanz wirken sofort über `vergessen()`).
  - **MQTT-Rückmeldewege:** jede Klasse, die bei einem Paho-Client abonniert, erbt von
    `Rueckmeldeweg`; erste Anweisung ihres `handle(topic, …)` ist `kundenbereichBeendet(topic)` —
    verworfen, gezählt (`voltpilot_rueckmeldung_verworfen_total{weg, grund}`), keine
    Ablehnungszeile. OCPP quittiert das Verworfene (sonst stellte der Broker endlos neu zu).
    Der Stand kommt per Setter (`@Autowired(required = false)`), damit die ~45 `new …Listener(…)`
    der Tests bleiben; ohne Spring gilt `BeendeteKundenbereiche.KEINE`.
  - **Läufer:** Schleife je Kundenbereich → `if (beendete.beendet(t)) continue;`. Warteschlange mit
    `ORDER BY … LIMIT` → Filter IM SQL `NOT (tenant_id = ANY (?::uuid[]))` mit `beendete.sqlFeld()`
    — **Falle:** in Java auslassen hielte die Zeilen vorn und blockierte jeden anderen Bereich; die
    Zeilen bleiben liegen und laufen nach einer Wiederaufnahme. Kein neuer Spaltenbezug im SQL der
    Läufer (Migrationsfalle 2 der Vorrede). Ausnahmen mit Grund (Kennzahlen des Betriebs,
    Aufbewahrung, OCPP-Zeitablauf, Freigaberegister als Schutz, Plattform-Kataloge) stehen in
    `LaeuferBeendetArchitekturTest.OHNE_SPERRE` — ein neuer Läufer muss sich dort oder an der
    Sperre entscheiden.
  - **Flotten-Rollout:** `POST /admin/rollouts` lässt Boxen beendeter Bereiche aus und nennt sie
    additiv in `ausgelassen[]`; nur solche → 409, kein Auftrag. Einzelzuweisung 409, der
    Drift-Wächter veröffentlicht für sie nichts nach. Das Portal zeigt `ausgelassen` noch nicht.
- **Nachweis:** `KundenbereichBeendetApiTest` (NW-5, Routen aus `RequestMappingHandlerMapping`,
  Fingerabdruck der ganzen DB unverändert), `KundenbereichBeendetWegeTest` (jeder Rückmeldeweg aus
  dem Code, Läufer, Rollout — mit aktivem Bereich als Gegenprobe), `RueckmeldewegArchitekturTest`,
  `LaeuferBeendetArchitekturTest`, `KundenbereichEndeTest`, ingest `BeendeteKundenbereicheTest`,
  Portal `KundenbereichEndeHinweis.test.tsx`.

## Gesamtabzug (IP-17)

`GET /api/v1/unternehmen/abzug` (`UnternehmenAbzugController` → `kundenbereich/Gesamtabzug`), BT4, RF-08 Schritt 3.

- **Wer:** nur `KundenbereichEndeFilter.kundenadministrator(...)` (= `Zugriff#kundenadministrator`, seit 29.10.2026
  auch die Plattform im Mandantensprung) — sonst 403 `recht_fehlt` (`rolle_noetig: kundenadministrator`), auch
  Unterstützer und Einsicht. Im Zustand „beendet“ lässt der
  Filter ihn als GET durch; alle anderen bekommen dort die 409 des Filters. Recht-Kommentar: „keine eigene Kennung“
  (keine Matrix-Zeile). Portal-Zwilling `rollen.ts#gesamtabzugLaden`.
- **Inhalt:** `staende/` (Berichtsstand = gespeicherter Text, SHA-256 = gespeicherte Prüfsumme ohne `sha256:`),
  `verzeichnis/` (AP-19 IP-8, JSON + CSV), dann je Tabelle eine CSV unter `berichte|nachweise|messreihen|protokolle|
  bestand` (`Gesamtabzug.objektart`). **Die Tabellen kommen aus dem Katalog** (`Gesamtabzug.TABELLEN`): lesbar für
  die App-Rolle UND (`tenant_id` → ausdrücklicher Filter | erzwungene RLS). Eine neue Tabelle ist ohne Pflege dabei;
  eine Kunden-Tabelle ohne beides fällt heraus — das wäre ohnehin ein Mandanten-Loch. Spalten mit Zugangsdaten
  (Name + Text/bytea, `Gesamtabzug.zugangsdaten`) bleiben draußen und stehen im Manifest (`ausgelassen`); heute trägt
  keine Kunden-Tabelle eine. Danach `LIESMICH.txt`, `manifest.json`, `pruefsummen.sha256` (`sha256sum -c`).
- **Strom:** EINE Transaktion `REPEATABLE READ`, nur lesend, `SET LOCAL TimeZone 'UTC'`; Cursor mit 1 000 Zeilen je
  Abruf (`fetchSize` wirkt nur in der Transaktion); direkt in `response.getOutputStream()` auf dem Anfrage-Faden —
  **kein `StreamingResponseBody`**: der liefe auf einem anderen Faden ohne `TenantContext`/`ZugriffContext`, RLS sähe
  nichts. Kompression `application/zip` ist nicht in `server.compression.mime-types`.
- **Protokoll `kundenbereich_abzug`** (`V20260925201700`): INSERT „begonnen“ vor dem ersten Byte, EIN UPDATE der fünf
  Abschluss-Spalten (Spalten-GRANT + Trigger `kundenbereich_abzug_einmalig`) nach dem Manifest; abgebrochen bleibt
  „begonnen“. FK CASCADE — der Löschweg bleibt unverändert; IP-18 liest `manifest_sha256` des letzten Abschlusses.
- **Portal:** `GesamtabzugKnopf` (Satz §5.8 + Knopf) im Hinweis „beendet“ (nur `liest`) und unter
  „Unternehmen › Einstellungen“ (`BenutzerPage`, nur Kundenadministrator); Download als Blob.
- **Nachweis:** `GesamtabzugApiTest` (NW-5: Manifest-Prüfsummen, 403, „beendet“, 1 Mio. Messzeilen mit offenem
  Cursor beim Empfang und +1 MB lebendem Speicher), `GesamtabzugTest`, `ZugriffZaunApiTest` (`NACH_IP4`).

## Sofort löschen (IP-18)

`POST /api/v1/admin/tenants/{id}/delete` (`AdminController` → `kundenbereich/KundenbereichLoeschung`), BT4, RF-08 Schritt 4–5.
Betreiber-Ablauf: [Deployment](../../deploy.md#kundenbereich-löschen-vertragsende).

- **Keine Wache mehr, die ablehnt (vp-kunde-sofort-loeschen-mit-daten, Captain 12.11.2026):** der Plattform-Admin
  löscht JEDEN Kundenbereich sofort endgültig - mit oder ohne Datenbestand, aktiv oder beendet, ohne Vertragsende
  und ohne Frist. `KundenbereichEnde.loeschungFruehestens`/`fristAbgelaufen` gibt es nicht mehr (die Methoden sind
  mit der Gate-Logik entfernt); `fristTage` bleibt nur ein dokumentierter Vertragswert am Übergang „beenden" (siehe
  oben), ohne dass daraus je ein Löschdatum folgt. `KundenbereichLoeschung.Wache.vorDemAbbau` liest den Datenbestand
  nur noch EINMAL, unter `FOR UPDATE` auf der Mandantenzeile im Löschzug selbst (auf der Verbindung des Löschzugs -
  eine Messung, die zwischendurch ankam, zählt noch mit), um zu entscheiden, welcher `Anlass` in den Nachweis
  geht: leer → `sofort_keine_daten`, sonst → `sofort_mit_daten`. Was „keine Daten" heißt, steht weiter EINMAL in
  `kundenbereich/KundeDatenBestand` (Muster `BoxDatenBestand`: jede Tabelle mit `tenant_id` genau einer Klasse
  zugeordnet, `KundeDatenBestandMigrationTest` hält das vollständig, im Zweifel „hat Daten") - das entscheidet aber
  nur noch den Anlass, nie mehr, OB gelöscht wird. Der Sofort-Weg gibt nie gemeldete Boxen VOR dem Abbau über
  `BoxLoesenService.beimKundenLoeschen` frei (ohne Protokollzeile - sie stürbe im selben Zug), für JEDE Box
  einzeln; eine Box, die doch gemeldet hat, lehnt dort individuell mit `BoxLoesenAbgelehnt` ab (gefangen, kein Grund
  mehr, die Löschung selbst abzulehnen) und geht stattdessen über die Kaskade. Der Löschzug schreibt
  `mandant_loeschnachweis.anlass` (`sofort_keine_daten` | `sofort_mit_daten`; Fristen-Spalten für BEIDE leer,
  `V20261111210000`/`V20261112090000`; der historische Anlass `frist_abgelaufen` steht nur noch in
  Bestandszeilen) sowie das bleibende Plattform-Protokoll `kundenbereich_geloescht_protokoll` MIT Namen (wer, wann,
  Anlass; append-only, nur Admin-Rolle). Die Datenauskunft für den Bestätigungs-Dialog liest das Portal über
  `GET /api/v1/admin/tenants/{id}/loeschbarkeit` (Datenarten, Vertragsende, Folgen; keine Gate-Felder mehr),
  `AdminKundeLoeschbarkeitController`.
- **`TenantRepository.offboard(id, runnable, wache)`:** die Wache läuft in DERSELBEN Transaktion vor dem ersten und
  nach dem letzten DELETE. `offboard(id)`/`offboard(id, runnable)` bleiben ohne Wache — **nur für die
  Migrations-Fixtures**, die den Löschweg von heute gegen ältere Schemata fahren (dort gibt es `beendet_am` nicht).
  Stubs in Tests auf die Drei-Argument-Form (`AdminApiTest`).
- **Löschnachweis `mandant_loeschnachweis`** (`V20260925223000`): Spalte `kundenbereich` statt `tenant_id` (kein
  RLS-Mandant, kein FK, fällt aus Gesamtabzug und Katalog-Zählung), Kennzeichen `LN-JJJJ-nnnn`, `zaehlungen` und
  `verblieben` aus dem **Katalog** (jede Tabelle mit `tenant_id`, nicht die Liste des Löschwegs), `abzug_sha256` =
  `manifest_sha256` des letzten abgeschlossenen Abzugs. Kein Name, keine Konten, kein Auftrag/Begründung (Freitext).
  Trigger `mandant_loeschnachweis_bleibt`, Admin-Rolle nur SELECT/INSERT, App-Rolle nichts.
- **Protokolle ohne FK gehen mit (Folge zu IP-18, `V20260925234500`):** `ort_aenderung` (jede Anlage eines
  Mandanten schreibt dort den Firmennamen), `messstelle_aenderung`, `data_source_aenderung`, `component_change_event`,
  `device_site_assignment` tragen `tenant_id` ohne FK. `reject_audit_mutation()` lässt für GENAU diese fünf (Liste
  im Funktionskörper) NUR ein DELETE durch, wenn `public.tenant` die Kennung nicht mehr hat — die Regel sitzt in der
  Funktion, damit ein erneuter Lauf der Ursprungsmigration (`UemsStandortMigrationTest`, `MessstelleMigrationTest`)
  sie nicht aufhebt. Den Weg geht `uems_protokolle_ohne_mandant_entfernen(uuid)` (SECURITY DEFINER, nur Admin-Rolle,
  verweigert bei bestehender Mandantenzeile); `TenantRepository.protokolleOhneMandantLoeschen` ruft sie nach
  `DELETE FROM tenant` (Löschzug und `deleteById`) und VOR `nachDemAbbau` — sonst zählte der Nachweis sie als
  `verblieben`. Während der Laufzeit bleibt alles append-only (jede Rolle), Standort- und Box-Löschen lassen die
  Einträge stehen.
- **Append-only MIT FK auf den Mandanten braucht seine EIGENE Entfernen-Funktion (vp-kunde-loeschen-500, `V20261112080000`):**
  `alarm_verlauf` hält Mandant und Alarm per RESTRICT und muss darum VOR der Mandantenzeile gehen — die Fünf-Tabellen-Ausnahme oben greift dort nie.
  Das direkte DELETE des Löschzugs starb am eigenen Trigger, sobald je ein Alarm ausgelöst worden war (Produktion 12.11.2026: die ab-Werk-Überwachung einer nie gemeldeten Box; Tests säten nur die Überwachung, nie einen Alarm mit Verlauf).
  Jetzt lässt `alarm_verlauf_nie_veraendert()` (Muster `kennzahl_wert`) NUR das DELETE aus `uems_alarmverlauf_des_kundenbereichs_entfernen(uuid)` (SECURITY DEFINER, nur Admin-Rolle) durch; `TenantRepository.offboard` ruft sie vor `DELETE FROM alarm`.
  Scheitert der Löschzug, antwortet die Route 500 mit `code loeschen_fehlgeschlagen` und dem ehrlichen Satz (nichts gelöscht, Konten bleiben gesperrt, wiederholbar) statt des Spring-Standardkörpers, und der Fehler steht MIT Stack im Log.
  Wächter: `KundenbereichLoeschenApiTest.derAlarmVerlaufBleibtAppendOnlyUndGehtNurImLoeschzug`; die Saat jedes Tests dort trägt einen ausgelösten Alarm mit Verlauf.
- **Der Rest geht über den Katalog (Folge „Löschzug vollständig“):** der letzte Schritt des Löschzugs
  (`TenantRepository.katalogRestLoeschen`, nach den Protokollen, vor `nachDemAbbau`) liest
  `TenantRepository.KATALOG_MIT_MANDANT` — denselben Katalog, über den der Nachweis zählt — und löscht in jeder Tabelle,
  die die Admin-Rolle löschen darf, nach `tenant_id`: heute die 31 Tabellen ohne FK aus PR 1279 (`telemetry_v2` + drei
  Rollups, `device_measurement_rollup_5m/15m`, Status-/Befehls-/Plan-/Fluss-Tabellen, Ausgangslisten; vier davon mit
  `actor_name`). Hypertables: EIN DELETE je Tabelle, TimescaleDB läuft es Chunk für Chunk; `drop_chunks` scheidet aus
  (Chunks sind nach Zeit geschnitten und tragen alle Mandanten), Continuous Aggregates gibt es nicht (RLS verbietet sie;
  die Rollups sind Hypertables, die Jobs füllen). Ein DELETE, das scheitert (FK zwischen zwei Resten, append-only-
  Trigger), geht auf seinen Savepoint zurück und wird wiederholt, solange eine andere Tabelle noch Zeilen verliert;
  was bleibt, nennt `verblieben` (ein scheiternder Trigger steht zusätzlich im Log „Löschzug …: nicht löschbar“; eine Tabelle ohne Löschrecht wird gar nicht versucht). ⚠ Eine NEUE Tabelle mit `tenant_id` geht also
  ohne Pflege mit — AUSSER sie nimmt der Admin-Rolle das DELETE oder hat einen append-only-Trigger: dann braucht sie
  einen eigenen Weg (Entfernen-Funktion wie oben). Nachläufer: nächster Punkt. Nicht in `deleteById`: ein
  eben angelegter Bereich hat nur die Protokollzeile. `LoeschzugKatalogApiTest` ist der Wächter (Bereich mit Zeilen in
  allen 31 + einer Probe-Tabelle, die keine Liste kennt; Nachbar Zeile für Zeile unverändert; Probe ohne Löschrecht
  bzw. mit Trigger erscheint unter `verblieben`).
- **Nachläufer schreiben nur für lebende Mandanten (Folge „Rollup-Race“, `V20260926004700`):** die drei Timescale-Jobs
  (`telemetry_rollups_job` v1 und `telemetry_v2_rollups_job` je 7 Tage, `device_measurement_rollup_job` 90 Tage)
  verdichten in eigener Transaktion mit `ON CONFLICT`. Jede Stufe ihrer `refresh_*`-Prozeduren liest nur Zeilen mit
  `tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)` — die Sperre eines Fremdschlüssels. Ein EXISTS ohne
  Sperre reicht NICHT (READ COMMITTED: das Statement sieht den Mandanten noch, wenn der Löschzug währenddessen
  committet). Läuft der Job zuerst, wartet der Löschzug an der FOR-UPDATE-Sperre der Wache (vor jedem DELETE) und nimmt
  die frischen Buckets mit; hält der Löschzug die Sperre, lässt der Job den Bereich ohne Warten aus. ⚠ Wer einen
  weiteren Job anlegt, der aus einem Fenster in eine Tabelle OHNE FK auf den Mandanten schreibt, braucht denselben
  Filter; und die Wache muss die Mandantenzeile weiter VOR dem ersten DELETE sperren, sonst verklemmen sich Job und
  Löschzug. Wächter: `LoeschzugRollupNachlaeuferApiTest` (beide Reihenfolgen, Nachbar weiter verdichtet).
- **Python-Dienste (Prognose, Wetter, Bewertung, Optimierer):** EINE Stelle `voltpilot_forecast.kundenbereich`, der
  Optimierer importiert sie. (1) Jede Anlagenliste, aus der ein Zyklus schreibt (`forecast_collect.load_sites`,
  `weather_collect.load_sites_with_coordinates`, `evaluate._sites`, `inputs.load_battery_sites` samt Einzel-Neuplan),
  verbindet `tenant t` und filtert `NICHT_BEENDET`. (2) Jede Schreibtransaktion ruft vor ihren INSERTs
  `lebenden_bereich_sperren` (`FOR KEY SHARE OF t SKIP LOCKED` auf die nicht beendete Mandantenzeile) und schreibt bei
  `False` nichts; die INSERTs selbst sind unverändert. Das betrifft `forecast`, `forecast_model_state`,
  `forecast_accuracy`, `plan_accuracy`, `weather_forecast`, `schedule`, `site_plan_run` + `entity_plan_slot` (EINE
  Entscheidung für Lauf und Slots) sowie `plan_zustellung` und die Laufnummer. Eine Sperre je Transaktion statt einer
  Unterabfrage je INSERT: ein Plan sind mehrere Anweisungen, nie ein halber. `beendet_am` liest sie über `to_jsonb`,
  denn vor der api-Migration heißt die fehlende Spalte „nichts beendet“ und bricht keinen Zyklus. ⚠ Ein neuer
  Python-Schreiber in eine Tabelle mit `tenant_id` braucht beides. Wächter: `tests/test_kundenbereich.py` (Form, läuft
  in CI) und `tests/test_kundenbereich_db.py` (echter Postgres im Wegwerf-Container, beide Reihenfolgen, beendet
  mitten im Zyklus, Nachbar; überspringt sich ohne psycopg/Docker) in beiden Diensten. `optimizer_cycle_stat` ist
  global (kein `tenant_id`).
- **`offboarding/cleanup`** nimmt nicht denselben Löschweg: nur Keycloak-Konten, und nur ohne Mandantenzeile.
- **Nachweis:** `KundenbereichLoeschenApiTest` (NW-5: ein aktiver Kunde MIT Daten wird sofort gelöscht, ein
  beendeter Kunde MIT Daten innerhalb der früheren 90-Tage-Frist ebenso, Spalten und Inhalt ohne Personendaten,
  `verblieben` = Katalog danach = leer, Nachweis unveränderlich, die fünf Protokolle vorher unveränderlich für
  jede Rolle), `AdminApiTest` (Löschweg-Fälle löschen eine aktive Mandantenzeile direkt, ohne Vertragsende).
