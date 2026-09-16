# Rollen-Zuordnung (H-1/H-2/H-3)

Autorität: [Vertrag](../../contracts/v2/rollen-zuordnung.md),
[Vektoren](../../contracts/v2/rollen-zuordnung-vectors.json),
[Schema](../../contracts/v2/rollen-zuordnung.schema.json).
Zwillinge `services/api/.../uems/RollenZuordnungRegeln.java` und
`frontend/portal/src/uemsRollen.ts`. Die API-Laufzeit ruft den Java-Zwilling über `topology/RollenZuordnungService`
und `RollenQuellen` auf. H-3 liest die drei Rollen im Cockpit; H-5/H-7 ergänzen
Assistent und Karten.

- Kanalidentität vor der Regel aus Capability/Formel-Term auf dieselbe
  Komponente + denselben Punkt auflösen; `enthaelt` rekursiv vollständig,
  auch bei stummen Eingängen. Nicht aus Box, Name oder Transport ableiten.
- Eine mehrfach zugeordnete Summe und ihre zusätzlich zugeordneten inneren
  Summen/Blätter zählen nur einmal. Bei stummer Summe kein Blatt-Rückfall.
  Teilweise überlappende unabhängige Summen sind kein auswertbarer Eingang.
- Netz höchstens ein Wert je Anlage; dieselbe Summe über mehrere Geräte ist
  einer. PV/Verbrauch benannte Teilsumme, innerhalb einer Summe `null`.
- 300 s einschließlich Grenze für alle Beiträge der Anlagen-Übersicht;
  Formel-Route bleibt bei 15 min. Stand je Quelle prüfen, niemals null als 0.
- Rolle ab jetzt, `rolle_gesetzt`/`rolle_entzogen`; keine Rollen-Zeitreise.
  Formel-Fassungen, Größen, Rechte und Steuerpfade bleiben eigene Verträge.
- Neues Kundenwort ausschließlich `SUMMENWERT`. `GESAMTWERT` ist bis H-5/H-7
  eingefrorener Bestandsexport. Text-Ausnahmen stehen einzeln in
  `copy.test.ts` und dürfen nur schrumpfen; bestehende Kundennamen bleiben.

Prüfen: `RollenZuordnungRegelnVectorsTest`, `uemsRollen.test.ts`,
`copy.test.ts`, Portal-Typecheck/-Build, `bash tools/agents-md-budget.sh`.
Bei Vertragsänderung immer alle Leser über `rg -l` finden und laufen lassen.
Keine Testcontainers für diese reine Schicht.

## API-Laufzeit (H-2)

- Geräteweg: `GET/PUT/DELETE /api/v1/sites/{siteId}/komponenten/{entityId}/rollen/{role}`.
  Anlagenweg: `GET/PUT …/rollen/{role}`. PUT an der Anlage nimmt
  `{art: "gesamtwert", quell_messstelle_id, ersetzen?: boolean}` und ordnet
  dieselbe Quelle allen Geräten der **heute wirksamen** rekursiven Herkunft zu.
  `ersetzen: true` bestätigt beim Netz das atomare Ablösen aller bisherigen Halter.
- Vor jedem Schreiben Sperre auf `site`, auch im vorhandenen Kunden-/Admin-Weg
  `topology-roles`; danach dieselbe Netz-Regel. `netz_mehrfach` liefert 409 mit
  `halter` (Komponenten-IDs) und Namen. Der Index `uq_entity_role_primary` bleibt.
- Herkünfte/Zustände je Quelle nur einmal auflösen. Mehrere unabhängige Summen
  mit überlappenden Eingängen: 409 `ueberlappende_summenwerte`, keine Speicherung.
  Eine nicht belegbare Gleichheit zwischen nativem Capability-Namen und
  Katalogpunkt desselben Geräts wird nicht geraten: bei gemischten Zuordnungen
  409 `kanalidentitaet_nicht_aufloesbar`. Box/Port/Transport belegen keine Identität.
- Die Rolle benötigt Wirkleistung/Momentanwert in kW: PV Erzeugung, Verbrauch
  Bezug, Netz richtungslos. Eine kWh-Messstelle ist keine zuordenbare Leistung.
  Archivierung liefert weiter `archiviert`; Frische/Null/Zählung urteilt H-1.
- `RollenProtokoll` schreibt je geänderter Geräte-Rolle `rolle_gesetzt` bzw.
  `rolle_entzogen` in `ort_aenderung` an der Anlage. Alt/neu tragen `entity_id`,
  `rolle`, `wert`; Akteur kommt aus `ProtokollAkteur`. Erneut derselbe Wert bzw.
  erneut entziehen erzeugt keinen Eintrag. Rollenwechsel schreibt Entzug + Setzen.
  Eigener NESTED-Savepoint, Fang/Log/Zähler `voltpilot_rollen_protokoll`: ein
  Zusatzfehler bricht den bestehenden Rollen-Schreibweg nicht ab.
- Migration `V20260916203000` weitet nur den Protokoll-CHECK. Kein Rollen-CHECK
  nötig (TEXT ohne CHECK), keine neue Tabelle/Spalte. Protokoll-Lesemodell
  behandelt Rollen wie Zugriffsereignisse als Punkte, nicht rückwirkende Fassungen.
- GET bleibt ohne `@Recht` (RLS/Geltungsbereich, „keine eigene Kennung“);
  PUT/DELETE tragen `geraet.einrichten`. Die Cockpit-Umlenkung steht unten (H-3).

Prüfen: `SiteRollenApiTest`, `RollenZuordnungRegelnVectorsTest`,
`TopologyRolePushTest`, `RechtRoutenArchitekturTest`, `RechteKennungenDerRoutenTest`,
`AenderungSatzTest`, `AenderungsprotokollApiTest`, `AnlageUmzugApiTest`; bei der
Migration außerdem die sechs UEMS-Nachbarklassen, `EntityRoleAssignmentQuellMigrationTest`,
`MigrationHygieneTest`, `DevSeedGuardTest`. Zweite Falle: nach Änderungen an
Repository-Abfragen alle `*MigrationTest`-Leser mit `rg -l` suchen.


## Cockpit und Flotte (H-3)

- `OverviewController.liveDto` liest `rollenJeAnlage` je `pv`/`consumer`/`grid`:
  genau eine flottenweite Zuordnungs-Abfrage je Rolle. Ohne Zuordnung bleibt
  die Rohzahl, mit stummer/veralteter Zuordnung bleibt `null` (kein Rohwert/0).
  Ohne Roh-Schnappschuss bleibt `live = null`; Ladestand/Zeitstempel unverändert.
  `fleet.ts` übernimmt weiter den Snapshot ohne zweite Rollenrechnung.
- `AnlagenPage` lädt die drei Rollen gemeinsam mit dem Live-Takt. Antworten
  sind an die Anlagen-ID gebunden; fehlgeschlagene Rollenleser verbergen nur
  ihre Aufschlüsselung. `RollenBreakdown` nutzt das bisherige PV-Markup und
  zeigt je Rolle Stand, Geräte und benannte Ausfälle. Mehrfach zugeordnete
  Summenwerte werden im Portal nie erneut addiert; Hinweis an der Aufschlüsselung.
- Zweiter Anzeigeweg: `CockpitHero` zeichnet bei v2 aus der Topologie, nicht
  aus `/overview`. `cockpitRollenTopologie` kopiert deshalb ausschließlich für
  diesen Aufrufer die Server-Rollenwerte in die Flussknoten (Netzvorzeichen
  bestimmt die Richtung). Ohne Zuordnung bleibt dieselbe Topologie-Referenz.
  `AdaptiveEnergyFlow.kanonischePv` unterdrückt dabei die alte PV-Quellenrechnung
  und ihr zweites Detailpanel. Keine Änderung an Optimierer-Nowcast, Box,
  Steuerpfad oder dem gemeinsamen Topologie-Zwilling.
- Prüfen: `SiteRollenApiTest` (je Rolle Umlenkung, null, Alter, Entzug und
  vollständige `/overview`-Antwort zeichengleich), `pvRolle.test.ts`,
  `RollenBreakdown.test.tsx`, `CockpitHero`/`AdaptiveEnergyFlow`/`AnlagenPage`,
  `fleet.test.ts`, `copy.test.ts`, `migration.test.ts`, `uemsKeineRechnung.test.ts`.
  Browser: `e2e/cockpit-rollen.spec.ts` (375/1440, `ROLLEN_BILDER=<Ordner>`)
  plus `e2e/gesamtwert.spec.ts`; Bühne mit Werten des Referenzunternehmens.
