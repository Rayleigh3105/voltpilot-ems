# Mess-Selektion JE KOMPONENTE (Geräteseite Stufe 3b, Server)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 157).


Bis hierher war die Auswahl je `(device_id, point_key)` gespeichert, also je BOX: zwei baugleiche
Wechselrichter hinter EINER Box (die zwei Fronius Eco von Herzogau) teilten sich zwangsläufig eine
Liste, und die Wallbox-Seite konnte gar keine eigene führen. Migration
`V20260855000000` ergänzt `device_measurement_selection` + `_event` um ein nullables `entity_id`.
**Additiv im Wortsinn: ohne `entityId` antwortet jede Route Zeichen für Zeichen wie vorher.**

- **⚠ `entity_id = NULL` IST DIE BISHERIGE BOX-SEMANTIK, nicht „unbekannt".** Der Schlüssel wird
  `(device_id, entity_id, point_key)` als **`UNIQUE NULLS NOT DISTINCT`** (PG15+) — so bleibt die
  Box-Zeile genau EINE je point_key, ohne einen Sentinel-UUID-Ausdruck zu erfinden, und
  `ON CONFLICT (device_id, entity_id, point_key)` kann darauf schliessen. Es ist bewusst eine
  UNIQUE-Bedingung statt einer PK: eine PK-Spalte müsste NOT NULL sein, und NULL ist hier eine
  Aussage.
- **⚠ Der Fremdschlüssel bindet `(entity_id, tenant_id)`, BEWUSST OHNE `site_id`** — obwohl der
  Geräte-FK daneben das volle Tripel bindet. Das ist historische Schema-Rationale: als die
  unveränderliche Migration angewendet wurde, konnten Geräte noch den Standort wechseln, während
  eine Komponente ohne `device_id` am alten Standort blieb. Der Umzugs-Endpunkt ist heute entfernt
  und der Standort nach dem Claim stabil; die FK-Form bleibt ausschließlich erhalten, weil bereits
  angewendete Flyway-Migrationen und ihre Datenstruktur nicht nachträglich umgeschrieben werden.
  Der Mandant bleibt der RLS-Zaun, die Standort-Gleichheit die Anlege-Regel des Dienstes.
- **⚠ Die Papier-Spur bekommt AUSDRÜCKLICH KEINEN Fremdschlüssel** (das `rule_event`-/
  `rollout_device`-Muster): sie ist append-only und muss die Komponente überleben, über die sie
  berichtet. `entity_id` ist dort eine Zuordnungsnotiz.
- **`requireEntity` ist die EINE Auflösungsregel** (`MeasurementSelectionService`): RLS-sichtbar UND
  an der Anlage DIESES Geräts, sonst 404. Sie verlangt ausdrücklich **kein** `measurement_point.device_id`
  — jede vom Assistenten oder per Übernahme angelegte Komponente hat keins, und genau die sollen
  beobachtbar sein. `MeasurementHistoryService` prüft `entityId` seither nach derselben Regel (das
  frühere `AND device_id=?` hat genau diese Komponenten mit 404 abgewiesen).
- **Geräteweit bleiben drei Dinge, und das ist die Aussage:** die **Revision** (das
  Optimistic-Concurrency-Token des EINEN veröffentlichten Plan-Dokuments), das **Budget** (der Bus
  ist physisch einer) und `recordedPointKeys`/`latestObservations` (Samples tragen bis Stufe 3c
  keine Komponenten-Dimension — eine „schon gemessen"-Aussage je Komponente wäre erfunden).
  Zugeschnitten werden nur Auswahl und Papier-Spur.
- **⚠ Der Publisher schreibt EINE Zeile je POINT KEY.** Der Edge-Parser lehnt einen doppelten
  point_key ab und kennt bis Stufe 3c keine Komponenten-Bindung; zwei Komponenten auf demselben
  Register kommen deshalb als EIN Eintrag mit der SCHNELLSTEN gewünschten Kadenz an (die Box liest
  ohnehin einmal), und `entity_id` reist nur mit, wo die Bindung EINDEUTIG ist.
- **⚠ Ohne die Edge-Toleranz hätte das jede Box gebrickt:** `measurements.ParseConfig` nutzt
  `DisallowUnknownFields()`, ein unbekanntes `entity_id` hätte also den GANZEN Plan verworfen. Das
  Feld ist deshalb in `measurements.Selection` ergänzt und wird IGNORIERT — „die Box ignoriert es
  bis Stufe 3c" ist damit eine Eigenschaft des Codes, nicht eine Absicht
  (`TestPerComponentSelectionIsAcceptedAndIgnoredUntilStufe3c`). **Wirksam wird das erst mit dem
  nächsten Edge-Release**; bis dahin ist eine komponentengebundene Auswahl für eine laufende Box
  ein unbekanntes Feld.
- **⚠ Die Quittung der Box kennt nur POINT KEYS** (`applyAcknowledgement`), erreicht also jede Zeile
  dieses Geräts mit diesem Schlüssel. Das ist die ehrliche Abbildung dessen, was die Box tat (EIN
  Lesevorgang über die Verbindung des primären Wechselrichters); die Präzision je Komponente kommt
  mit Stufe 3c.
- **⚠ EIN NACKTES `?` IN EINEM `CASE`, DESSEN ANDERER ZWEIG EIN UNTYPISIERTES `NULL` IST, WIRD ZU
  `text` — und die Zuweisung an eine `timestamptz`-Spalte scheitert** („column … is of type timestamp
  with time zone but expression is of type text"). Genau daran ist `applyAcknowledgement` seit Slice 5
  gescheitert: die Anweisung hatte NUR eine Mock-Abdeckung (`verify(repository).applyAcknowledgement(…)`),
  gegen eine echte Datenbank lief sie nie. Der `MeasurementConfigStatusListener` fängt jede Ausnahme,
  protokolliert sie auf DEBUG und gibt `false` zurück — die Quittung verschwand also lautlos und jede
  Auswahl blieb für immer `pending_edge`. Nichts hat dabei GELOGEN (`pending_edge` ist per
  Konstruktion keine Apply-Zusage), aber angekommen ist sie nie. Behoben durch explizite
  `CAST(? AS timestamptz)` an allen drei Zeitstempel-Parametern beider Anweisungen; der Beweis ist
  seither `MeasurementSelectionApiTest` (Schritt 8), das die Quittung über die echte Repository-Bohne
  fährt. **Regel: eine Anweisung, die nur ein Mock je gesehen hat, ist ungeprüft** — und jeder
  Zeitstempel-Parameter in einem `CASE` oder einer `INSERT … SELECT`-Liste braucht seinen Cast.
- **Routen:** `GET /measurement-selection[?entityId=]`, `/catalog?entityId=`, `/estimate?entityId=`,
  `PUT /{pointKey}?entityId=`, `POST /custom[?entityId=]`, `POST /custom/estimate[?entityId=]`;
  History/Export trugen `entityId` schon. Alle acht stehen seit dieser Runde in `openapi.yaml`
  (Tag `measurements`) — vorher war die ganze Familie dort nicht dokumentiert.
- **Beweise:** `MeasurementSelectionApiTest.selectionsAreScopedPerComponentWhileTheDeviceKeepsOnePlanAndOneBudget`
  (echte DB + Keycloak: derselbe Punkt auf zwei Komponenten, getrennte Listen, geräteweite Revision
  und geräteweites Budget, Katalog-Familie je Komponente, fremde Anlage 404 auf jeder Route) ·
  `MeasurementContractsTest.publisherBindsAnUnambiguousComponentAndCollapsesTheSameRegisterOfTwo` ·
  Go `internal/measurements`.
- **NICHT in dieser Stufe:** die Portal-Fläche (Stufe 3a). Die Bindung auf der BOX ist seither
  gebaut — siehe den nächsten Abschnitt.

