# UEMS: Produktionsreihenfolge der Migrationen

## Produktionssatz fortschreiben

Bei **jedem Nachzieh-Merge `main` → `uems`** die Liste
`services/api/src/test/resources/migration/main-migrations.txt` fortschreiben und mitcommitten:

```sh
git fetch origin
python3 services/api/tools/update-main-migrations.py
python3 services/api/tools/update-main-migrations.py --check
cd services/api
./mvnw clean test -Dtest=UemsProduktionsreihenfolgeMigrationTest,MigrationHygieneTest
```

JDK 21 und Docker sind nötig. Das Skript liest nur den lokalen Git-Ref `origin/main`; es ruft
weder das Netzwerk noch eine Datenbank auf. `--ref <commit>` erlaubt die reproduzierbare Erzeugung
gegen einen bestimmten Stand. Der Kommentar der Liste enthält dessen Commit. Das Skript prüft,
dass alle Dateien dieses Satzes im Arbeitsbaum vorhanden und bytegleich sind. Eine Liste enthält
Dateinamen und damit Versionen, keinen Versionshöchstwert: `main` hat Lücken, die erst UEMS füllt.

Der Test selbst benötigt weder Git noch Netzwerkzugriff auf das Repository. Er kopiert die
aufgelisteten Klassenpfad-Ressourcen in eine temporäre Flyway-Location, prüft den exakt angewandten
Satz und migriert dann aus der vollständigen Location mit `outOfOrder(true)` bis zum Ende.
Zwei Datenbanken im selben Testcontainer vergleichen den Nachzug mit der frischen Installation.
Es gibt keinen Zugriff auf bestehende Datenbanken. Timescale-Hintergrundarbeiter sind abgeschaltet.

## Was jeder Nachzug außer der Liste wiederholt

Erprobt beim Nachzug von main `8b8b6a03b` (26.09.2026); Einzelheiten stehen im jeweiligen Wächter.

- **Fingerabdruck-Wächter** (`frontend/portal/src/migration.test.ts`, `test/kundenBestand-vor-ip12.json`): ein von main
  ausgeliefert entferntes Bedienelement fällt nur über den Block `mainNachzug` (je Element main-Commit und Nachfolger,
  `main` = alle Fingerabdrücke der main-Fassung). Vorher nachmessen, dass es auf der main-Basis stand — nie `--update`,
  nie eine neue Basis.
- **Bestandsschutz-Aufnahmen** (`frontend/portal/src/test/bestandsschutz/README.md`): eine von main umgebaute Fläche
  wird auf einem `git archive origin/main` mit demselben Testfall aufgenommen; der Merge-Baum muss sie bytegleich rendern.
- **NW-2** (`services/api/src/test/resources/uems/nw2/README.md`): die Referenz auf dem neuen main-Commit nachmessen
  (Aufnahme im Klon, Hinweis zu den uems-only Sendern dort), nicht aus dem uems-Lauf neu schreiben.
- **Auto-Merge ohne Konflikt** prüfen: doppelte Objektschlüssel (`api.ts`, E2E-Bühnen wie `help-fixtures.ts`),
  doppelte Exporte, und `playwright test --project=desktop-chromium` komplett — main-Neubauten brechen UEMS-Specs, die
  auf alte Flächen klicken.

## Was der Wächter schützt

- Vor dem Nachzug stehen `rolle_gesetzt` und `rolle_entzogen` im Ortsprotokoll. Die Migration muss
  damit durchlaufen und beide Zeilen erhalten.
- `V20260912210000` und `V20260913143000` treffen auf `messstelle_formel_term` mit der bereits
  vorhandenen Spalte `gilt_als_erzeugung` aus `V20260914100000`.
- Am Ende sind alle Migrationen angewandt. Tabelleninhalte werden ohne Tabellen-Ausnahmen mit
  `Bestandsschutz.fingerabdruck` verglichen, Spalten und Constraints separat einschließlich
  CHECK-Ausdrücken, Fremdschlüsseln, Eindeutigkeit und Primärschlüsseln. Physische Spaltenpositionen
  sind nicht fachlich relevant und werden nicht verglichen.
- Vier Seed-Zeitstempel entstehen durch `DEFAULT now()` und werden auf das Test-Laufzeitfenster
  geprüft: `inverter_control_certification.created_at` sowie `geaendert_am` in
  `messreihe_viertelstunde_lauf`, `messreihe_tag_lauf` und `messreihe_luecke_lauf`.
  Alle übrigen Felder und Zeilen dieser Tabellen bleiben im Inhaltsvergleich.

## Start eines älteren Builds

`FlywayStartupGuardTest` nutzt denselben `main-migrations.txt`-Satz: main → vollständiger Nachzug
→ alter Start mit `SelfHealingFlywayMigrationStrategy` verweigert → neuer Start erfolgreich.
Der SHA-256-Fingerabdruck aller Historienzeilen aus
`installed_rank, version, type, checksum, success, description, script` bleibt beim alten
Start unverändert, `migrate()` und `repair()` werden nicht aufgerufen. Niedrige unbekannte
`MISSING_*` sind ebenso gesperrt wie `FUTURE_*` und physische Kern-`DELETE`-Marker.
Die benannten Dev-Seed-Ausnahmen und Rollout-Folgen stehen in [API](../../api.md#schema-und-migrationen).

## Einmalige Korrektur vor der ersten Produktionsfreigabe

`V20260916150000__uems_zugriff_entzug_protokoll.sql` wurde laut Freigabeschnitt vom 18.09.2026
**nie in Produktion angewandt**. Sie darf bei späterer Ankunft den bereits produktiven CHECK aus
`V20260916203000__rollen_zuordnung_protokoll.sql` nicht verengen. Ihre Liste wird deshalb vor der
ersten Produktionsfreigabe auf dieselben zwölf Werte berichtigt. Eine spätere Reparaturmigration
allein käme zu spät: vorhandene Rollenereignisse lassen schon das frühere `ADD CONSTRAINT` scheitern.

**Jede Nicht-Prod-Datenbank, die `V20260916150000` in der alten Fassung angewandt hat, braucht
`flyway repair` beziehungsweise ein Neuaufsetzen.** Repair richtet nur die Prüfsumme aus und spielt
SQL nicht erneut ein. Der bereits nachfolgende Zwölfer-CHECK aus `V20260916203000` muss dort angewandt
sein oder anschließend regulär migriert werden. Angewandte Produktionsmigrationen bleiben unveränderlich.
