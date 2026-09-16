# Unterstützung im Portal (AP-03 IP-15)

`UnterstuetzungKarte` hängt an `BenutzerPage`, die Dialoge verwenden das gemeinsame Modal,
Picker und die einmalige `StartpasswortAnzeige`. Verwaltung allein über
`rollen.darf('unterstuetzung.verwalten', null)`. Die Kundenstandorte stammen aus `/me`, dessen
Standortleser dieselbe RLS-Verbindung und Standortgrenze wie der bestehende Standortweg verwendet.
VoltPilot wird ausschließlich durch eine Anfrage bestätigt; es gibt keine freie VoltPilot-Gewährung.

`UnterstuetzungBanner` steht additiv in `AppShell`: Kunden sehen den Serversatz ihrer betroffenen
Standorte, Unterstützer ihren Kundenbereich, Umfang und Ende. Notfall nennt den Grund; er ist nicht
verlängerbar. Beenden behält Handeingriffe, Regeln, Konto und Protokoll und entzieht nur die Gewährung.
Ein Hinweis behauptet eine E-Mail nur mit `email_versandt_am`. Passwortantworten werden nicht gespeichert.

## Die ergänzten Lesewege

- `/me.kundenbereiche`: nur für Partner-/Plattformkonten, ausschließlich das Subject des verifizierten
  SecurityContext, gültige eigene Unterstützung und passender Kontotyp/Art. Der getrennte,
  rollenbewachte `EigeneKundenbereiche`-Leser verwendet die Admin-Verbindung ausschließlich für
  Kennung, Name, Umfang und exklusiven Endzeitpunkt dieser eigenen Zugänge. Er gewährt nichts;
  die Annahme eines Kundenbereichs bleibt bei `ZugriffKontextLader` und RLS je Anfrage. Kundenkonten
  erhalten eine leere Liste. Keine neue frei adressierbare Cross-Tenant-Route.
- `/admin/fleet.unterstuetzungBis`: spätester exklusiver Endzeitpunkt einer aktuell wirksamen
  Unterstützung je Kundenbereich. Eine fehlende Kennung bedeutet keine aktive Unterstützung;
  ein fehlendes Feld bedeutet im Portal „Nicht verfügbar“. Das Datum ist keine Freigabe des Aufrufers.
- `/admin/fleet.unterstuetzungStandorte`: Kennung, Kundenbereich und Name aktiver Standorte für
  Anfrage/Notfall **vor** einer Gewährung, hinter dem vorhandenen Plattform-Rollencheck. Diese
  Auswahl verwendet keinen Kunden-Vollzugriff und keine Anlagenkennung als Standortkennung.

`api.setKundenbereich` bindet Kundenaufrufe an `X-Kundenbereich`; Admin-Aufrufe behalten den getrennten
`X-Tenant-Id`-Kontext. Beide Kontexte gehören in die Schlüssel laufender/gecachter Anfragen und in
Prüfungen verspäteter Entzugsantworten. Beim Bereichswechsel verwirft `App` Daten und Rechte.

Die Produktionsvorgabe `VOLTPILOT_UEMS_UNTERSTUETZUNG_UMSCHALTER_ENABLED` ist seit IP-15 **false**.
Das Profil `local` hält die alte Vorgabe explizit für die bisherigen Kompatibilitätsnachweise;
`UnterstuetzungApiTest` setzt **false** und prüft den geschlossenen Kundenweg. Ein extern gesetztes
Deployment-Override kann die Vorgabe übersteuern; bei der UEMS-Auslieferung darf es nicht auf true stehen.
Keine Migration, keine Änderung der Rechte-Matrix oder der Rechte-Architekturwächter.

## Nachweise

`UnterstuetzungApiTest` (Gewährung, Ablauf, Entzug, Selbst-Liste, Flotte, Kundenstandorte, Fremdzugriff),
`SelbstauskunftApiTest`, Vertragsleser und Rechte-Wächter. Portal: `Unterstuetzung.test.tsx`,
`apiRechte.test.ts`, `apiCoalesce.test.ts`, `AppShell.test.tsx`, Benutzer-, Copy- und Migrationswächter.
`e2e/unterstuetzung.vite.config.ts` baut ausschließlich den statischen E2E-Wirt nach `/tmp`;
`unterstuetzung.playwright.config.ts` prüft N4–N6/A14 und die bestehenden Benutzer-/Startpasswort-Flüsse.
Alle Ansichten sind echte Komponenten mit Ahrenberg-Fixtures außerhalb des Produktionsimports.
