# Summenwerte mit Rolle auf main

Ein Summenwert bleibt eine berechnete Messstelle. Die optionale Rolle wirkt ab
jetzt auf PV-Produktion, Verbrauch oder Netz im Cockpit; ohne Rolle bleibt der
Wert am Gerät und unter Verlauf › Messwerte sichtbar.

## Zuständige Kapitel

- [Formel-Fundament](gesamtwert-berechnete-messstelle-formel-ap10.md): Einheiten,
  Vorzeichen, Faktoren und keine Teilsumme bei fehlenden Eingängen.
- [Rollen und Cockpit](uems-rollen-zuordnung.md): Zählregel, Netz-Eindeutigkeit,
  Frische, Protokoll und Rückfall auf die bisherige Telemetrie.
- [Assistent](uems-summenwert-assistent.md): Register → Rechnen → Name → Rolle → Fertig.
- [Gerätekarte](uems-summenwerte-geraetekarte.md): Rollenwechsel, Umbenennen,
  Archivieren und atomar Anlegen + Rolle.
- [Portal-Einstiege](../portal/summenwert-assistent-und-karte.md).

## Grenzen des Ports

Die sechs Helfer-Commits werden auf die vorhandenen main-Schnittstellen angepasst.
Es kommen keine weiteren UEMS-Pakete hinzu:

- Zugriff wie bisher über Anmeldung und Mandanten-RLS. Individuelle AP-03-Rechte,
  Leserrollen und standortbezogene Unterstützung sind nicht Teil dieses Ports.
- Kein zeitgültiges Ändern einer Formel; die erforderlichen Fassungs-Tabellen
  fehlen auf main. Bestehende Formeln, PV-Zuordnungen und Historien bleiben erhalten.
- Quellen verwenden die bestehende führende Box (`LeadDeviceService`) wie der
  Registry-Push auf main. Keine UEMS-Verteilung nach `PushJeBox` oder Zuständigkeiten.
- Listen verwenden das bestehende main-Format; keine AP-13-Werterouten und keine
  neuen Kennzahl- oder Standortflächen.

Die einzige neue Migration ist `V20260916203000__rollen_zuordnung_protokoll.sql`,
inhaltlich und in der Version gleich dem Helfer-Stand auf uems. Sie erweitert nur
den vorhandenen Protokoll-CHECK und ändert keine Bestandswerte.

## Gemeinsame Summe entziehen

`RollenZuordnungService.entziehen` entfernt unter der Anlagensperre alle primären
Zuordnungen derselben Messstelle, Anlage und Rolle. Andere Quellen und Rollen
bleiben bestehen. Der Vorgang ist idempotent und löscht den Summenwert nicht.

## Prüfen

API: `RollenZuordnungRegelnVectorsTest`, `SiteRollenApiTest`,
`MessstelleFormelApiTest`, `EntityRegistryServiceTest`, `TopologyRolePushTest`,
`AenderungSatzTest`, `DeviceMeasurementSelectionApiTest`,
`SummenwertQuellenServiceTest`, `UemsSummenwertAbnahmeTest`,
`MigrationHygieneTest`, `DevSeedGuardTest`.

Portal: `uemsRollen`, `pvRolle`, `summenwertQuellen`, `gesamtwert`, `geraetSeite`,
`copy` und betroffene Komponenten; Typecheck und Build. Playwright prüft
`summenwert`, `gesamtwert`, `summenwert-geraetkarte`, `cockpit-rollen` und
`summenwert-abnahme` bei 375/1440 px. `SUMMENWERT_BILDER=<externer Ordner>`
schreibt echte Aufnahmen für eine lokale HTML-Ansicht. Fixtures ersetzen keine
Hardware-Abnahme. Rechte- und Formel-Fassungstests entfallen mit ihren Funktionen.
