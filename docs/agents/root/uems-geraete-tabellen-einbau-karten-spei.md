# UEMS-Geräte-Tabellen: Einbau, Karten, Speisung der Komponenten — und die Lese-API

Neu angelegt am 11.09.2026 (AP-04 IP-10). Migration
`services/api/src/main/resources/db/migration/V20260911200000__uems_geraet.sql`, lesend
`uems/GeraetRepository` + `uems/GeraetService`, Routen `web/GeraetController`
(`GET /api/v1/sites/{siteId}/geraete`, `GET /api/v1/geraete/{id}`), Formen `web/dto/GeraetDto`.
Beweise: `UemsGeraetMigrationTest` (Testcontainers: Ableitung, Zaun, Constraints, Rechte,
Offboarding, Bestand zeichengleich), `GeraetApiTest` (Keycloak: Vorgänger am MS-06-Fall, WAGO
C-1 mit vier Karten, fremd 404, Messkanal zeigt das laufende Gerät), `GeraetSchnittstelleVertragTest`
(rein: OpenAPI ⟷ DTO ⟷ CHECK), `GeraetAnlegewegTest` (Keycloak: je Anlege-Route ein Gerät,
Nachlauf der Ableitung = 0, Hybrid in beiden Reihenfolgen, Zaun, Löschen, Messkanal).

## Das Modell in drei Sätzen

- ⚠ `device` ist die BOX. Das Gerät (das Kästchen dahinter) heißt `geraet`; an `device` ändert
  sich nichts.
- EINE Zeile `geraet` = EIN EINBAU. Ein Zählerwechsel ist ein NEUES Gerät: Z-5a und Z-5b sind
  zwei Zeilen mit demselben `kennzeichen` GR-4 und je eigenem `einbau_kennzeichen` — genau das
  Paar `geraet`/`einbau` der Referenzdatei, des Herkunftsvertrags (Angabe 10, die Einbau-Kennung
  je Wert zeigt auf eine Zeile hier) und der Quellenbindung. Vorgänger = frühere Einbauten mit
  demselben `kennzeichen`; je `kennzeichen` und Zeitpunkt steckt EINER (Exklusion).
- `geraet_komponente` sagt, welche Komponente wann von welchem Einbau (und über welche Karte)
  gespeist wird — halboffen `[ab, bis)` auf die Minute, je Komponente und Zeitpunkt EIN Gerät,
  je Karte und Zeitpunkt EINE Komponente. KEINE Spalte `measurement_point.geraet_id`: die trüge
  nur den heutigen Einbau, und ein Kartenwechsel (AP-05 E6) wechselt die Speisung OHNE neues
  Gerät. `geraet_teil` = Energiekarten mit Steckplatz, nur an einem `controller` (FK über die
  Geräteart), je Steckplatz und Zeitpunkt EINE Karte (`steckplatz` NULL = nicht erhoben,
  kollidiert nie).

## Die Ableitung für den Bestand (`uems_geraete_ableiten()`)

Die Migration ruft sie einmal; wiederholbar (nur Komponenten OHNE jede Speisung), gibt die Zahl
NEUER Geräte zurück, `EXECUTE` nicht für PUBLIC (die App ruft sie nicht). Regeln — alle aus dem
Code, nichts geraten:

- Hybrid + Speicher sind heute EINE Zeile (`battery-hybrid`) → ein Gerät. Mitgespeist werden die
  komponierten Geschwister derselben Box (producer/pv-generation/grid-meter/house-load) OHNE Pin,
  Marke, Modell und Verbindung (`NULL`/`{}`) — `komponenten.ts` Schritt 2 +
  `ComponentAdoptionService.reusableComposedRow`; Träger ist der ERSTE battery-hybrid der Box
  (created_at, id). Gleiche Adresse heißt NICHT gleiches Gerät (Box trennt nach Rolle + Weg).
- `eingebaut_am` = das Frühere aus `created_at` und dem ersten Tag in `telemetry_v2_rollup_1d`
  (unbefristet; `telemetry_v2` hält nur 90 Tage), abgerundet auf die Minute; `aus_bestand = true`
  sagt: das ist der Verlaufsbeginn, nicht der Einbautag.
- ⚠ Seriennummer NUR bei `communication = 'kaco_http'` aus `connection_json.serial`. Bei
  `solarman_v5` (Deye) ist `serial` die des DATENLOGGERS — nie übernehmen. Geräte-ID =
  `unit_id` (bei solarman_v5 `mb_slave_id`). Datenquelle und Bezeichnung bleiben NULL.
- Kennzeichen GR-n je Kundenbereich über `geraet_kennzeichen_seq` + `uems_geraet_kennzeichen`
  (überspringt belegte Nummern), Reihenfolge: Anlage nach Anlagezeit, darin früheste Komponente.
- Seit `V20260911240000` wohnt die Regel in `uems_geraet_ableiten_fuer(komponente)`; die
  Bestands-Ableitung ist nur noch die Schleife darüber (siehe „Der Anlege-Weg“).

## Der Anlege-Weg (`V20260911240000`, IP-10-Nacharbeit)

- **Neue Komponenten bekommen ihr Gerät im Anlege-Weg** — nach DERSELBEN Regel, auch
  `aus_bestand = true` (eingebaut_am ist der Verlaufsbeginn = Anlagezeit, kein erhobener
  Einbautag). Ein `CONSTRAINT TRIGGER … AFTER INSERT ON measurement_point DEFERRABLE INITIALLY
  DEFERRED` ruft die Regel je Zeile: deckt alle fünf `INSERT INTO measurement_point` in
  `EntityRegistryRepository`/`MeasurementPointRepository` und jede künftige Stelle ab.
- ⚠ **Zur Commit-Zeit**, nicht beim INSERT: die Anlege-Wege setzen Typ, Verbindung, Pin erst
  NACH der Zeile (setEntityConfig, `ComponentDefinitionRepository`); der Commit sieht den
  Endstand — und die Geschwister eines Hybrids in jeder Reihenfolge einer Transaktion. Wer eine
  Komponente samt Speisung in EINER Transaktion anlegt (Controller-Karte, AP-05), behält genau
  diese: die Regel legt nur für Komponenten OHNE jede Speisung an. Ohne Transaktion (Tests mit
  autocommit) ist das Ende der Anweisung der Commit. Umgruppiert wird nie: kommt der
  Wechselrichter in einer SPÄTEREN Transaktion, behalten schon versorgte Geschwister ihr Gerät.
- Rechte: `uems_geraet_ableiten_fuer` ist SECURITY INVOKER (RLS der App-Rolle, fremde Komponente
  = tut nichts), EXECUTE nur App- und Admin-Rolle (der Trigger ruft sie unter der anlegenden
  Rolle); `uems_geraete_ableiten()` (alle Mandanten) bleibt PUBLIC-entzogen.
- ⚠ Tests, die eine Bestands-Komponente OHNE Gerät brauchen, legen sie bei
  `ALTER TABLE measurement_point DISABLE TRIGGER uems_geraet_anlegen` an (in EINER Transaktion,
  `GeraetAnlegewegTest.bestandsKomponente`).

## Löschen, Rechte, Offboarding

- `→ site` `ON DELETE CASCADE` (anders als `data_source`): sonst legte die Ableitung jede
  Bestandsanlage fest. `→ measurement_point` CASCADE (nur die Speisung geht, das Gerät bleibt),
  `→ tenant`/`data_source` RESTRICT. `TenantRepository.offboard` räumt `geraet_komponente`,
  `geraet_teil`, `geraet`, `geraet_kennzeichen_seq` VOR `data_source` ab.
- App-Rolle: nie DELETE. UPDATE nur `einbau_kennzeichen, hersteller, typ, seriennummer,
  bezeichnung, data_source_id, geraete_id, ausgebaut_am` (Gerät), `bezeichnung, typ,
  seriennummer, ausgebaut_am` (Karte), `gueltig_bis` (Speisung) — Gerät, Anlage, Geräteart und
  Einbaubeginn sind die Identität.

## Die Lese-API

snake_case wie die übrigen UEMS-Schnittstellen, Zeitpunkte mit Versatz Europe/Berlin, Recht
`messwerte.ansehen` als Kommentar (Schreiben kommt mit `geraet.einrichten`, IP-17/IP-19).
Anlagen-Liste = jeder Einbau (ausgebaute eingeschlossen), GR-2 vor GR-10; jeder Eintrag trägt
`komponenten`, `teile`, `vorgaenger` (jüngster zuerst). Fremde Anlage/fremdes Gerät = 404.

## Nicht dieses Paket

Zähler-/Controllerwechsel (IP-17/IP-19), Einstellungs-Fassungen (IP-11), Geräteseite im Portal
(IP-12), Ablesestände (IP-13/IP-17), `geraet_aenderung` (IP-21), Datenquelle am Gerät (AP-06 IP-4).
