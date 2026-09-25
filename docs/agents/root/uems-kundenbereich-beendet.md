# Vertragsende I: der Kundenbereich „beendet" (UEMS AP-20 IP-16)

E10 = A, BT4, RF-08: der Betreiber setzt einen Kundenbereich auf „beendet"; danach ist jeder
Schreibweg `409 kundenbereich_beendet`, nur der Kundenadministrator liest noch, die Datenannahme
verwirft mit Zählung. IP-17 (Gesamtabzug) und IP-18 (Löschen nach der Frist, Löschnachweis) stehen unten.

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
  Selbstauskunft trägt `kundenbereich.beendet {beendet_am, loeschung_fruehestens, liest, text}`
  (aktiv: `null`). Plattform-Routen mit `{tenantId}`/`{siteId}`/
  `{deviceId}` im Pfad: jedes Nicht-GET 409, außer `ADMIN_AUSNAHMEN` (beenden,
  wiederaufnehmen, `delete`, `offboarding/cleanup`, Konto sperren). **Falle:** der Filter steht
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

- **Wer:** nur `KundenbereichEndeFilter.kundenadministrator(...)` — sonst 403 `recht_fehlt`
  (`rolle_noetig: kundenadministrator`), auch Unterstützer, Einsicht, Umschalter. Im Zustand „beendet“ lässt der
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

## Löschen nach der Frist (IP-18)

`POST /api/v1/admin/tenants/{id}/delete` (`AdminController` → `kundenbereich/KundenbereichLoeschung`), BT4, BT5, RF-08 Schritt 4–5.
Betreiber-Ablauf und Regel BT5: [Deployment](../../deploy.md#kundenbereich-löschen-vertragsende).

- **Wache:** nur „beendet“ und ab `KundenbereichEnde.loeschungFruehestens` (Kalendertag Berlin) — sonst `409
  kundenbereich_nicht_beendet` bzw. `409 frist_laeuft` (Körper `code`, `message`, `beendet_am`,
  `loeschung_fruehestens`). Zweimal: `pruefen` VOR dem Sperren der Konten, dann `Wache.vorDemAbbau` im Löschzug unter
  `FOR UPDATE` auf der Mandantenzeile (eine gleichzeitige Wiederaufnahme gewinnt ganz oder findet nichts).
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
  einen eigenen Weg (Entfernen-Funktion wie oben). ⚠ Die Rollup-Jobs (`telemetry_v2_rollups_job`: letzte 7 Tage) lesen
  in eigener Transaktion; sendete die Box bis zuletzt, kann ein Lauf, der vor dem Commit las, danach Buckets
  zurückschreiben — der Nachweis sieht sie nicht (gilt ebenso für die v1-Rollups, offen). Nicht in `deleteById`: ein
  eben angelegter Bereich hat nur die Protokollzeile. `LoeschzugKatalogApiTest` ist der Wächter (Bereich mit Zeilen in
  allen 31 + einer Probe-Tabelle, die keine Liste kennt; Nachbar Zeile für Zeile unverändert; Probe ohne Löschrecht
  bzw. mit Trigger erscheint unter `verblieben`).
- **`offboarding/cleanup`** nimmt nicht denselben Löschweg: nur Keycloak-Konten, und nur ohne Mandantenzeile.
- **Nachweis:** `KundenbereichLoeschenApiTest` (NW-5: RF-08 mit Zeitraffer 89/90 Tage, Spalten und Inhalt ohne
  Personendaten, `verblieben` = Katalog danach = leer, Nachweis unveränderlich, die fünf Protokolle vorher
  unveränderlich für jede Rolle), `AdminApiTest` (Löschweg-Fälle mit
  `vertragsendeUndFristAbgelaufen`).
