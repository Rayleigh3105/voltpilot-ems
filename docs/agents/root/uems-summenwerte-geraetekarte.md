# Summenwerte am Gerät (H-7/H-8/H-10)

Die Karte `frontend/portal/src/components/GeraetSummenwerte.tsx` löst die frühere
PV-Karte ab. Der alte Export `GeraetPvProduktion` ist nur ein kompatibler Verweis.
`summenwertEinstieg` in `geraetSeite.ts` hängt nicht an der PV-Rolle. Die physische
Geräteseite übergibt alle zugehörigen Komponenten-IDs; gleiche Messstellen stehen
einmal auf der Karte. Box, Port und Transport sind dafür keine Identität.

- `GET /api/v1/sites/{siteId}/komponenten/{entityId}/summenwerte` liefert
  `{messstelle, rolle, wert}[]`, auch ohne Rolle. Kandidaten aus den Formel-Termen
  werden gegen die **heute wirksamen** Fassungen geprüft, einschließlich
  verschachtelter Summen. Archivierte Summen fehlen. Fremde Geräte/Anlagen: 404.
- `RolleAendernDialog` nutzt den Anlagen-PUT zum Setzen/Wechseln und den Geräte-DELETE
  zum Entziehen. Der Netzwert-Konflikt verlangt ausdrückliches `ersetzen`. Größe
  und Richtung bestimmen die verfügbaren Rollen; der Server prüft sie erneut.
  Ein Entzug lässt die Messstelle und ihre Werte bestehen.
- Anlegen/Formel brauchen `messstelle.formel`, Rolle `geraet.einrichten`,
  Umbenennen/Archivieren `messstelle.bearbeiten`, Protokoll
  `aenderungsprotokoll.lesen` über `rollen.ts`. Das Zeilenmenü ist ohne Schreibrecht
  verborgen. `Modal` hält den Fokus; vor Öffnen aus dem Menü wird dessen bleibender
  Auslöser ausdrücklich fokussiert (auch für iOS).
- `SummenwertFormelDialog` schreibt über `messstelleFormelFassungEintragen` eine
  neue Tagesfassung, erhält Quellidentitäten/Anteile/Erzeugungsentscheidungen und
  benennt Register über die Messkanal-Route. Änderungen der Hauptgröße bleiben
  serverseitig gesperrt. Vergangene Tage brauchen das rückwirkende Recht.
- `GET /api/v1/sites/{siteId}/aenderungen` liest das vorhandene Anlagenjournal im
  gemeinsamen `ProtokollDialog`. `AenderungSatz` nennt gespeicherte Alt-/Neunamen;
  Kanalkennungen werden nicht als Kundenwörter ausgegeben. Keine zweite Historie.
- `POST /api/v1/messstellen/berechnet` nimmt optional
  `rolle: {entity_id, role, ersetzen?}`. Die Zielanlage kommt aus der Komponente,
  das zusätzliche Recht wird geprüft. Die Komponente muss zu den gelesenen
  Geräten gehören; die Rolle wird allen beteiligten Geräten zugeordnet. Anlage,
  Fassung, Terme und Rolle stehen in **einer Transaktion**; Ablehnung lässt keine
  neue Messstelle zurück. Der `ObjectProvider` für den Rollendienst vermeidet den
  Konstruktorzyklus zum Formel-Leseweg.
- `EntityRegistryService.deleteEntity` entfernt Rollen-Zuordnungen vor jedem
  Löschzweig, auch wenn PV-/Netz-Messpunkte als v1-Stammdaten erhalten bleiben.
  Weitere Nutzer: Admin-, Adoption-, Verbraucher-, Eigenbau- und Batterie-Wege.
  Vollständig gelöschte Messpunkte haben zusätzlich den vorhandenen FK-CASCADE.

Prüfen: `MessstelleFormelApiTest`, `SiteRollenApiTest`,
`AenderungsprotokollApiTest`, `AenderungSatzTest`, `EntityRegistryServiceTest`,
`EntityRegistryRoleAssignmentTest`, Rechte-/Scope-Wächter; Portal
`geraetSeite.test.ts`, `GeraetSeiteSection.test.tsx`, neue Karten-/Dialogtests,
`migration.test.ts`, `copy.test.ts`, `uemsKeineRechnung.test.ts`, Typecheck/Build.
Browser: `e2e/summenwert.spec.ts` und `e2e/summenwert-geraetkarte.spec.ts`;
Screenshots mit abgeschlossenen Animationen bei 375/1440 px. Der AP-13-Geräte-
Snapshot und der IP-12-Bedienelementbestand tragen explizit diese Fortschreibung.
