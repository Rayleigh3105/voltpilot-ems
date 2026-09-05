# Einheitsmodell Stufe 1: EIN Anlege-Weg — das Portal wird die Wahrheit über die Geräte

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 21).


Der Kern des Programms (Scout `data/vp-komponenten-einheit-h2` Teil 4 + Teil 7, Stufenplan Stufe 1):
Wechselrichter, Erzeuger, Zähler und Verbraucher werden IM PORTAL angelegt, und die Box leitet ihre
lokalen Dateien daraus ab, statt sie auf `:8484` selbst zu führen. Alles ist ADDITIV — **eine laufende
Anlage ändert dadurch ihr Verhalten NICHT** (siehe die Autoritäts-Regel; der Beweis ist ein Test).

- **⚠ DIE TRAGENDE REGEL: die AUTORITÄT hängt an der ANLAGE, und „abwesend" heißt BOX.** `site.component_authority`
  (Migration `V20260817000000`, Vorgabe `portal` + eine EINMALIGE Daten-Migration, die JEDE bestehende Anlage
  auf `box` setzt) entscheidet, wer die Geräte-Konfiguration besitzt. Neue Anlagen sind portal-verwaltet,
  Bestandsanlagen bleiben **unangetastet box-verwaltet** (ihre Übernahme ist Stufe 2). Die Vorgabe steht auf
  `portal`, weil eine neue Anlage sonst als box-verwaltet entstünde; die Daten-Migration ist der Grund, warum
  das trotzdem keine Bestandsanlage trifft — **wer die Spalte anfasst, fasst BEIDE Hälften an.** Dieselbe
  Regel spiegelt der Vertrag (`registry_push.component_authority` ist OPTIONAL, absent = box) und der Edge
  (`componentapply.Authority`: alles, was nicht wörtlich `portal` ist, ist box) — ein ÄLTERER Cloud-Stand
  kann damit nie als Übernahme gelesen werden.
- **Der Assistent ist EINE Route, nicht vier.** `POST /api/v1/sites/{id}/components` (+ `PUT …/{entityId}`,
  `GET …/{entityId}/versions`, `POST …/versions/{n}/rollback`, `POST …/component-test`) auf
  `SiteComponentController` — RLS-gefenced wie jede `/sites/**`-Route (kein `@PreAuthorize`, fremde Anlage
  404, Admins über den `X-Tenant-Id`-Umschalter). **`templateRef` ist OPAK**: Marke, Modell, Familie und die
  Kommunikationsart holt der Server AUS der Vorlage (Stufe 0a), nie aus dem Rumpf — ein Client kann keine
  widersprüchliche Anbindung speichern.
- **⚠ VERBINDUNGSTEST-PFLICHT: ohne bestandenen Test wird nicht gespeichert (422).** Seit dieser Stufe IST das
  gespeicherte Soll der Lesepfad der Anlage — ein Tippfehler in der IP macht sie blind. `ComponentConnectionReceipts`
  hält den Beleg 30 min im Speicher, geschlüsselt über einen SHA-256-Fingerabdruck aus (Anlage, templateRef,
  sortierte Verbindungspaare): **eine geänderte Adresse ist ein anderes Gerät und entwertet den Beleg**. Der
  Beleg entsteht NUR bei einem strikt bestandenen Test (`ok` + gemeldeter Messwert), nie bei Timeout. Der
  Test selbst läuft über den Probe-Kanal (Stufe 0b) an dieselbe `testconn`-Maschinerie, die die
  `:8484`-Taste seit je benutzt — es gibt bewusst keinen zweiten Test, der etwas anderes sagen könnte.
  **Der Rollback verlangt KEINEN neuen Test**: diese Verbindung war schon einmal gespeichert und hat ihren
  Test damals bestanden; einen neuen zu fordern versperrte den Rückweg aus einem Fehler genau dann, wenn das
  Gerät nicht antwortet.
- **⚠ Die 0-1-Regel keyt auf die VERBINDUNG, nicht auf die Zeile** (`ComponentService.resolveOrCreatePoint`;
  im Testcontainers-Lauf als echter Defekt gefunden): seit der Auto-Komposition trägt JEDE verbundene Anlage
  eine synthetisierte `grid-meter`-Zeile, ein „Zeile existiert ⇒ 409" hätte also jeden echten Zähler abgewiesen —
  und ein „Zeile existiert ⇒ nimm sie" ließ den ZWEITEN Zähler die Verbindung des ersten überschreiben. Also:
  komponierte Zeile ohne `connection_json` ⇒ ÜBERNEHMEN, Zeile MIT Verbindung ⇒ 409 mit einem eigenen deutschen
  Satz je Rolle. Wechselrichter und Netz-Zähler bleiben damit serverseitig bei je einem.
- **Versionen sind APPEND-ONLY** (`component_definition`, PK `(entity_id, version)`, RLS + FORCE): jedes
  Speichern schreibt eine neue Fassung und hebt `measurement_point.definition_version`; ein Rollback schreibt
  die ALTE Fassung als NEUE (nie ein Löschen) — „was lief letzte Woche" bleibt beantwortbar.
  Vollständige Snapshots werden ausschließlich aus dem gerade angewandten `measurement_point` kopiert
  (`recordStoredVersion`), nie aus der Assistentenrolle: ein über `inverter` bearbeiteter komponierter
  `battery-hybrid` bleibt deshalb auch nach Rollback `battery-hybrid`, samt Typ, Capabilities und Guards.
- **Secrets werden gegen die REFERENZIERTE Vorlagenfassung maskiert.** Listen und Historie lösen immer
  exakt `(template_ref, template_version)` auf. Fehlt diese Fassung oder wurde sie zurückgezogen, gilt
  fail-closed und jeder gespeicherte Verbindungswert wird maskiert; ein Rückfall auf eine ältere auswählbare
  Fassung ist nur für den Vorlagen-Picker erlaubt, nie für die Ausgabe bestehender Definitionen.
- **Der Registry-Push wird für den LESEPFAD autoritativ, OHNE neues Topic:** `EntityRegistryService.composePush`
  füllt `driver.connection` aus der gespeicherten Fassung und stempelt `component_authority` **NUR bei
  `portal`** — die Bytes einer box-verwalteten Anlage sind damit unverändert.
- **Der Box-Applier ist die Geräteseite** (`edge-app/core/internal/componentapply`, rein + `agent/component_apply.go`
  als reine Verdrahtung): er leitet Wechselrichter-Auswahl und `sources.json` aus dem Push ab, **wendet NIE
  partiell an** (erst der ganze Plan, dann beide Speicher, dann die retained Veröffentlichung), protokolliert die
  angewandte Revision (`components-applied.json`, überlebt Neustart und Cloud-Ausfall) und lehnt bei einer
  box-verwalteten Anlage GAR NICHTS ab — er läuft dort nicht. Der lokale Bus (`edge/inverter/config`,
  `edge/sources/config`, Self-Wiring, Telemetrie) ist BYTE-IDENTISCH; nur der SCHREIBER der lokalen Dateien
  wechselt. Deterministische Quellen-IDs (`sources.DeterministicID`) bleiben, damit die Übernahme in Stufe 2
  ein No-op ist. Details: `edge-app/AGENTS.md`.
- **Soll/Ist wird nie geraten:** `in_sync` · `pending` · `held` · `box_managed` · `unreported` ·
  `no_gateway_device`.
  **`unreported` heißt „die Box hat sich noch nicht geäußert" — NIE „die Änderung ist verloren"**; eine
  Ablehnung reist NEBEN der angewandten Revision (`refusedRevision`/`refusedReason`), nie an ihrer Stelle —
  was läuft, ist weiterhin die zuletzt wirklich angewandte Fassung.
  - **⚠ `held` ist die DRITTE Antwort der Box auf „was ist mit der neuesten Revision passiert?"** (Scout
    `vp-portal-box-spiegel-s2` L1): sie hat die Fassung GESEHEN und bewusst nichts angewandt — heute, weil das
    Portal kein verbundenes Gerät mehr nennt (`componentapply.ErrNoConfiguration`), und ein leeres Soll ist
    ausdrücklich KEINE Anweisung, eine laufende Anlage leerzuräumen. Sie reist als EIGENES Feldpaar
    `held_revision`/`held_reason` durch die ganze Kette (`componentapply.Record` → `cloud.ComponentApplySummary`
    im Herzschlag → `device_component_apply` → `SiteComponentsDto`), NIE in `revision` (das wäre ein Stand, den
    niemand fährt) und nie in `refused_*` (das wäre ein Fehler, den es nicht gibt). Bis dahin wurde der Halt nur
    GELOGGT, also rechnete das Portal Soll != Ist und sagte dauerhaft „Änderung unterwegs zur Box".
    **Die drei schließen einander aus** — `WithHold` räumt eine veraltete Ablehnung, `WithRefusal` einen
    veralteten Halt, ein angewandter Push beide; und **`held` gilt nur für GENAU die anliegende Fassung** (ein
    Halt einer älteren beruhigt die neuere nicht). Ein GEMELDETER Halt schlägt dabei das abgeleitete
    `no_gateway_device`: die Box hat den Push nachweislich bekommen. Portal-Satz + Grund (wörtlich von der Box
    durchgereicht): `komponentenAssistent.sollIstText`/`haltGrund`.
  - **⚠ `no_gateway_device` ist der EINE Fall, in dem der Grund BEKANNT ist** (Scout `vp-portal-box-spiegel-s2` L10):
    mehrere beanspruchte Geräte und keins als steuerndes Gerät des Speichers hinterlegt ⇒ `gatewayDevice` ist
    `null`, es wird GAR NICHT gepusht (die Outbox notiert `refused`). Er ersetzt genau die zwei Urteile, die
    dadurch unehrlich würden — `unreported` („unbekannt", obwohl bekannt) und `pending` („unterwegs", obwohl nichts
    unterwegs sein kann —, **nie `in_sync`**. Der Flotten-Blick der Stufe 6 (`AdminComponentFleetController`)
    fährt die schmalere `syncStatus`-Form OHNE dieses Wissen (den `held` der Zeile kennt er, den fehlenden
    Empfänger nicht) und behauptet ihn deshalb bewusst nicht; der Kundensatz wohnt EINMAL im Portal
    (`komponentenAssistent.KEIN_EMPFAENGER_SATZ`).
  - **⚠ `box_managed` ist die gemeldete RÜCKGABE der Autorität** (Scout `vp-portal-box-spiegel-s2` L8): die Box
    sagt, dass sie ihre Geräte wieder selbst pflegt — dann gibt es GAR KEIN Soll/Ist mehr, sie leitet ihre
    lokalen Dateien aus keinem Push ab. **Der behobene Befund war, dass sie dazu SCHWIEG:** `componentApplySummary`
    war `nil`, sobald die Anlage box-verwaltet war, der Listener rührt eine fehlende Block-Zeile nicht an, und
    die alte `device_component_apply`-Zeile (`authority=portal, revision=N`) blieb stehen — während JEDER
    folgende Push die Soll-Revision hochzählt (`revision` ist `now.toString()`). Das Portal behauptete deshalb
    nach `revert-to-device` dauerhaft „Änderung unterwegs zur Box" über eine Anlage, die es gar nicht mehr
    steuert. Der Weg ist derselbe wie beim Halt: Box → Herzschlag (`authority: "box"`, **ohne Revision und ohne
    Grund** — beides gehörte einer Ära, die vorbei ist) → `EntityStatusListener` → der Upsert RÄUMT die Zeile aus
    `EXCLUDED` → `syncStatus`. **Die Zeile wird NICHT gelöscht** (`authority=box` ist eine Aussage; ein Löschen
    machte sie wieder von „hat sich nie geäußert" ununterscheidbar — genau die Zweideutigkeit, aus der der Befund
    entstand), und **verglichen wird WÖRTLICH gegen `"box"`, nie über `ComponentAuthority.of`**: dessen sichere
    Richtung („alles, was nicht portal ist, ist box") ist hier genau falsch, denn `null` heißt „eine ältere Box
    meldet den Block gar nicht". Es steht als ERSTES in `syncStatus` und schlägt auch `no_gateway_device` — was
    das GERÄT sagt gewinnt gegen das, was wir aus Stammdaten ableiten. **Der Flotten-Blick kennt es** (`ApplyRow`
    trägt seit dieser Runde `authority`), damit Puls und Anlagen-Fläche über dieselbe Anlage nicht Verschiedenes
    behaupten. Portal-Satz: `komponentenAssistent.sollIstText` („Die Geräte werden auf der Box gepflegt") ·
    Flotten-Etikett `adminKomponentenFlotte.SOLL_IST.box_managed` („An der Box gepflegt", bewusst NICHT „Nicht
    gemeldet"). **`nil` bleibt der Block nur auf einer Anlage, die NIE portal-verwaltet war** — dort hat die Box
    wirklich nichts zu berichten, und ihr Herzschlag behält exakt die Bytes von vor dem Einheitsmodell (die
    Captain-Auflage, gepinnt in `TestABoxManagedPlantIsByteIdenticalUnderEveryPush`). **Edge-Release nötig**;
    bis dahin bleibt eine zurückgegebene Anlage bei ihrem alten Urteil. Beweise: Go
    `component_apply_test.go` (`TestHandingAuthorityBackNeverUndoesWhatRuns` + der Neustart-Fall) · rein
    `ComponentSyncStatusTest` (mutationsgeprüft) + `EntityStatusListenerTest` · Portal
    `komponentenAssistent.test.ts` + `adminKomponentenFlotte.test.ts`.
- **⚠ ALLE DREI Schreibwege gehen über die Aktivierungs-Outbox** (`component_activation_outbox`, Operationen
  `component_create` · `component_edit` · `component_rollback`): Push NACH dem Commit, mit Wiederholung bis
  `applied`. `create` pushte bis zum 31.08.2026 INNERHALB seiner `@Transactional`-Methode — beide Fehlerformen
  davon sind still (ein Broker-Ausfall genau dort wird nie wiederholt, und ein Rollback nach erfolgreichem
  Publish ließe die Box mit einem Soll zurück, das die Datenbank nicht hat). **Wer ein viertes Wort einführt,
  weitet den CHECK, indem er den AKTUELLEN Stand abschreibt** (die `consumer_audit_event`-Regel); Wächter dafür
  ist das reine `ComponentActivationOperationsTest`.
- **Beweise:** Go `internal/componentapply` (19, inkl. der Kontrakt-Fixture per PFAD) + `agent/component_apply_test.go`
  (8, u. a. `TestABoxManagedPlantIsByteIdenticalUnderEveryPush` — die Captain-Auflage —, Ablehnung behält alles,
  leeres Soll löscht nichts, Neustart, lokale Bearbeitung auf einer portal-verwalteten Anlage abgelehnt) ·
  api `ComponentApiTest` (6, echte DB + Keycloak: die Reise Vorlage→Test→Anlegen mit Fassung 1, ohne Beleg 422,
  zweiter Netz-Zähler 409, Rollback schreibt eine neue Fassung, RLS 404) · Portal `komponentenAssistent.test.ts` (26)
  + `AnlegenFlow.test.tsx` (9). Portal-Seite in `frontend/portal/AGENTS.md`.
- **NICHT in dieser Stufe:** Selbstbau-Kanäle (Stufe 3) · Schreiben/Schalten und Freigabe (Stufe 4) ·
  Vorlagen-Verwaltung (Stufe 6). Bestands-Übernahme + `:8484`-Ablösung sind Stufe 2 (nächster Abschnitt).

