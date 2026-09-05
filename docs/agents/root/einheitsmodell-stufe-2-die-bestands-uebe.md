# Einheitsmodell Stufe 2: die Bestands-Übernahme — die LAUFENDEN Anlagen kommen ins Portal

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 25).


Erst diese Stufe holt Pilsting, Auernheim und Mienbach ins Portal (Scout `data/vp-komponenten-einheit-h2`
§4.2/§4.3/§7.2, Stufenplan Stufe 2; **Captain-Entscheid E2: die Übernahme läuft AUTOMATISCH, kein Klick**).
Alles ist ADDITIV — eine Anlage, die den neuen Weg nicht geht, verhält sich zeichengleich wie vorher.

- **⚠ DER KERN-TRICK: die Übernahme ist auf der Box ein NO-OP.** Zurückgeschrieben wird, was die Box ohnehin
  fährt; der Applier leitet aus dem daraus erzeugten Push **exakt dieselbe** `sources.json` und
  Wechselrichter-Auswahl ab und antwortet „keine Änderung" (`Plan.SameAs`) — keine Datei
  geschrieben, nichts neu veröffentlicht. **⚠ Das galt bis zum 20.08.2026 NUR für Anlagen ab PR 270:**
  die Begründung lautete „weil die Quellen-Kennung deterministisch entsteht", und `sources.DeterministicID`
  kam bewusst OHNE Migration — jede vorher eingerichtete Anlage trägt bis heute ZUFÄLLIGE Kennungen, die die
  Ableitung neu vergab (Anlage Pilsting/Herzogau: beide Fronius verloren ihre Portal-Bindung). Seither behält
  der Applier die Kennung jedes Geräts, das diese Box SCHON FÄHRT (`edge-app/AGENTS.md` „Eine Kennung, die
  auf dieser Box schon läuft, wird NIE neu vergeben"), und die Zusage gilt für jede Anlage. Physisch passiert NICHTS; nur der Bearbeitungs-Ort wandert.
  Bewiesen von `agent/component_adopt_test.go` an einem Pilsting-artigen Aufbau (Deye SUN-30K-SG01HP3, ZWEI
  Fronius Eco hinter EINER IP, Netzmessung über den Deye-CT) — und **mutationsgeprüft**: lässt man ein Feld im
  Treiberblock weg, fällt der Beweis um.
- **⚠ `SameAs` ist eine STRUKTURGLEICHHEIT über ALLE Felder** (`a == b` auf `sources.Source`/`inverter.Selection`).
  Deshalb musste diese Stufe eine seit Stufe 1 offene Feld-Lücke schließen: **`capacity_kwp`, `interval_s` und
  `registry_unit_id` erreichten die Box GAR NICHT** (`driverBlock` emittierte sie nicht, der Applier fiel auf
  seine Vorgaben zurück — 5-s-Takt statt gepflegter Kadenz, keine kWp-Hülle). Das war schon vorher eine stille
  Verschlechterung; bei einer Übernahme wäre es eine REGRESSION einer laufenden Anlage. **Wer den Treiberblock
  anfasst, prüft den Go-No-op-Test.** Die Lese-Kadenz wohnt dabei IM `connection_json` (dort legt der Anlege-Weg
  sie ab) und wird von `driverBlock` auf die Treiber-Ebene GEHOBEN — Assistent und Übernahme schreiben sie an
  dieselbe Stelle, sonst hätte dieselbe Anlage je nach Entstehungsweg eine andere Kadenz.
- **Die ROLLE wird bewusst NICHT gepusht:** der Applier leitet sie aus dem Entitätstyp ab (die getestete Pfad),
  und das v1-Rollen-Vokabular der Cloud (`battery-hybrid`) kennt sein `roleFor` gar nicht — es würde den ganzen
  Plan verweigern.
- **`local_setup` meldet jetzt die VERBINDUNG** (Vertrag `docs/contracts/v2/edge-entity-config.md` §5.1, additiv):
  `family`, `communication`, `connection` (verbatim), `interval_s`, `capacity_kwp`, `registry_unit_id` — genau die
  Felder, die `sources.Source`/`inverter.Selection` speichern. **Ein Eintrag OHNE `connection` heißt „diese Box
  meldet noch keine Verbindungen", NIE „dieses Gerät hat keine"** — daran hängt, dass eine Bestandsanlage mit
  alter Software box-verwaltet BLEIBT statt aus einem halben Ist übernommen zu werden. Gespeichert in
  `entity_observed_state` (Migration `V20260819000000`, additive Spalten `edge_communication`/`edge_family`/
  `edge_connection`/`edge_interval_s`/`edge_capacity_kwp`/`edge_registry_unit_id`; kein Backfill — die Tabelle
  wird je Herzschlag ersetzt und heilt sich selbst).
- **Die Regeln sind REIN** (`components/ComponentAdoption`, Docker-frei geprüft — das
  `Tagesprotokoll`/`FleetPflege`/`RolloutStates`-Muster). Fünf, jede gegen eine belegte Fehlerklasse:
  **ALLES ODER NICHTS** (der Applier leitet die Quellenliste VOLLSTÄNDIG aus dem Push ab — ein fehlender Eintrag
  würde ein laufendes Messgerät nicht auslassen, sondern ENTFERNEN) · **ohne Verbindung keine Übernahme** ·
  **nur Geräte aus dem Vorlagen-Register** (sonst gäbe es kein `template_ref`, und die Komponente wäre im Portal
  nicht bearbeitbar; die Vorlage wird über Marke+Modell GESUCHT, nie zusammengebaut — `template_ref` ist opak) ·
  **keine erfundene Geräteart** (ein Verbraucher kann Wallbox, Heizstab oder allgemeine Last sein — das ist eine
  Mensch-Entscheidung; eine solche Anlage bleibt box-verwaltet, bis eine spätere Stufe sie abbildet) · **ein
  Wechselrichter**.
- **Atomar, oder gar nicht** (`ComponentAdoptionService`): alle Schreibvorgänge in EINER Transaktion auf dem
  `@Primary`-Datenpfad, und **der Push muss ANKOMMEN** — ein versuchter, gescheiterter Push rollt die Übernahme
  zurück (nächster Takt versucht erneut). Ein Deployment ganz OHNE Broker (`mqtt_not_configured`) ist kein
  Zustellfehler und übernimmt. **Die Box kann nie zwischen zwei Welten hängen:** sie wird erst portal-verwaltet,
  wenn sie einen Push wirklich ANGEWANDT hat — eine Übernahme ohne zugestellten Push lässt sie vollständig
  bedienbar, sichtbar als `unreported`.
- **Ausgelöst wird sie GETAKTET** (`ComponentAdoptionRunner`, `voltpilot.components.adoption.*`, Vorgabe AN,
  5 min; das `V2SiteBackfillRunner`-Muster). **Bewusst KEIN Herzschlag-Haken:** der Status-Zuhörer ist der heiße
  Pfad, und ein eigener Zuhörer bräuchte ein neues, per Vorgabe ausgeschaltetes Flag, das im gitops-Repo
  nachgezogen werden müsste — die dokumentierte OTA-Listener-Falle. Der Takt braucht weder Broker noch neues
  Pflicht-Flag. Wie jeder `@Scheduled` ist er im Testlauf abgeschaltet (surefire) und in Produktion AN
  (`ComponentAdoptionWiringTest` nagelt beides an der echten `application.yml` fest).
- **Der RÜCKWEG** ist `POST /api/v1/admin/sites/{id}/v2-entities/revert-to-device` (platform-admin, in
  `openapi.yaml`); die Schwester `…/adopt-from-device` stößt sie sofort an und NENNT den Grund, wenn nicht.
  Der Rückweg nimmt AUSSCHLIESSLICH die Autorität zurück — die Definitionen bleiben stehen (Beleg + Weg zurück
  nach vorn), der folgende Push trägt das Autoritäts-Feld nicht mehr, und der Beleg-Stempel wird gelöscht, damit
  der Takt die Anlage wieder betrachtet.
- **`site.components_adopted_at`/`_by`** (dieselbe Migration) ist der BELEG, nicht der Zustand: `null` heißt „nie
  automatisch übernommen" und ist NICHT dasselbe wie box-verwaltet (eine seit Stufe 1 neu angelegte Anlage ist
  portal-verwaltet, ohne je übernommen worden zu sein). Der VERLAUF je Komponente liegt vollständig in
  `component_definition` (Fassungen mit dem Vermerk „Vom Gerät übernommen").
- **`:8484` wird read-only-Spiegel** (§4.3): `/api/inverter` + `/api/sources` tragen additiv `portal_managed`,
  und die Anlage-Karte blendet JEDE Bearbeitung aus (`data-vp-edit`) und zeigt EINEN ruhigen Satz mit dem
  Verweis ins Portal. Gesperrt wird ausschließlich das ÄNDERN — Sehen, Verbindung testen, Koppeln, Netzwerk,
  Steuerungs-Freigabe, Not-Aus und Messwert-Aufbereitung bleiben lokal. Details: `edge-app/AGENTS.md`.
- **Beweise:** Go `agent/component_adopt_test.go` (6: der No-op, Feld für Feld inkl. `invert_batt_sign`/
  `power_scale`/`control_write_fc`, zwei Wechselrichter hinter EINER IP, kein erfundener Netz-Zähler, der
  ältere Bericht, die Drahtform) · `internal/web` (`portal_managed` + die Spiegel-Struktur) ·
  `jstest/ui.test.js` (4) · api `ComponentAdoptionTest` (10, rein) + `ComponentAdoptionWiringTest` (4) +
  `ComponentAdoptionApiTest` (5, echte DB + Keycloak, Herzschlag durch den ECHTEN Zuhörer) · Portal
  `komponentenAssistent.test.ts` (+4).
- **Warum Stufe 2 und Stufe 3 sich nicht berühren** (beide wurden parallel gebaut): ein SELBSTBAU-Gerät
  wird von `componentapply.ParseDriver` übersprungen (`communication == CommunicationSelfBuild` — sein
  Leseplan reist als generierter Flow über `v2/flows`), taucht also nie in `sources.json` und damit nie
  im `local_setup` auf — **die Übernahme sieht es gar nicht**. Und private Vorlagen wohnen in
  `site_component_template`; die Vorlagen-Auflösung der Übernahme sucht ausschließlich die öffentlichen
  Herkunftsarten in `component_template`, kann also nie eine fremde private Vorlage ziehen.
- **NICHT in dieser Stufe:** Verbraucher-Quellen automatisch übernehmen (ihre Geräteart ist eine
  Mensch-Entscheidung) · Schreiben/Schalten (Stufe 4) · Vorlagen-Verwaltung (Stufe 6).

