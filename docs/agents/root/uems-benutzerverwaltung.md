# Benutzerverwaltung im Portal (AP-03 IP-13)

`#/unternehmen/einstellungen/benutzer` wird über den Avatar geöffnet. `rollen.benutzerLesen()`
verwendet `/me`: Kundenadministrator schreibend, Energiemanager lesend; andere Konten sehen weder
Menü noch Inhalt. Die alte Adresse `#/benutzer` bleibt ein Plattform-Lesezeichen.

`BenutzerPage` zeigt Kontozustand, jede Rolle mit Geltungsbereich und künftige Zuweisungen.
„Zugriff beenden“ entzieht eine einzelne Zuweisung über den vorhandenen `DELETE /api/v1/zugriff/{id}`.
Ein Bearbeitungsvorgang ersetzt nur die ausgewählte Zuweisung; andere Rollen und Standorte bleiben.
Änderungen gelten sofort, auch beim Bearbeiten einer künftigen Zuweisung. Die eigene Zeile hat keine
Änderungsaktionen. `BenutzerEinladen` hängt N2 vor die vorhandene N3-Hülle `BenutzerAnlegenDialog`;
Neuvergabe bleibt `StartpasswortNeuVergeben`. Passwortantworten bleiben allein im IP-14-Dialog.
Die Folgenvorschau ruft `rechte.darf` mit `rechte-matrix.json` auf. Sie gibt keine Rechte frei.

## Kundenrouten und Prüfpunkt

- `GET /api/v1/benutzer`: keine eigene Aktionskennung; nur die beiden Kundenrollen, RLS-Verbindung.
  Liefert Kundenkonten ohne entfernte Konten, mit noch nicht beendeten aktuellen/künftigen Zuweisungen.
- `PUT /api/v1/benutzer/{sub}/zugriff`: `{bisher: UUID[], rolle, standorte: UUID[]}` ersetzt atomar
  die angegebenen Zuweisungen über `ZugriffAenderung`; leeres `bisher` ergänzt eine Rolle.
  Fremdes Konto oder fremde Zuweisung: 404, fehlender Standort: 422, vorhandene Rolle im gleichen
  Geltungsbereich: 409 `zuweisung_vorhanden`. Keine Änderung bei einer Ablehnung.
- `POST /api/v1/benutzer/{sub}/sperren` hält Zuweisungen über den Spiegelzustand an;
  `DELETE /api/v1/benutzer/{sub}` beendet alle Zuweisungen einschließlich der künftigen. Identität und Protokoll
  bleiben erhalten. Beide verlangen `benutzer.verwalten`, eigene Rolle und letzter Administrator
  bleiben über den Vertrags-Prüfpunkt geschützt. Eine gemeinsame Transaktionssperre serialisiert
  auch die bisherigen Zuweisungsrouten. Keine Keycloak-Löschung auf diesem Kundenweg.
- `ZugriffKontextLader` weist gesperrte/entfernte Kundenkonten bei jeder Anfrage ab, auch mit
  bestehendem Token. Die bisherigen Entzugs- und Handeingriffsregeln bleiben bestehen.
- `GET /api/v1/benutzer/protokoll?von=…&bis=…`: `zugriffsprotokoll.lesen`, Kundenadministrator,
  Zeitpunkte halboffen, höchstens 366 Tage, absteigend höchstens 1001 Einträge. Das Portal zeigt
  1000 und fordert bei weiteren einen kürzeren Zeitraum; Datumsauswahl und Anzeige folgen Europe/Berlin, mit der Zone einmal im Kopf.
  Kalendergrenzen werden über `bezugsPeriode.mitternacht/tagPlus` in API-Zeitpunkte umgerechnet;
  auch Tage mit 23 oder 25 Stunden schließen den gewählten letzten Tag vollständig ein.

Die Routen verwenden bestehende Tabellen und Grants; keine Migration. `BenutzerService` unterscheidet
bei einer Keycloak-Kollision eine E-Mail in einem fremden Kundenbereich (409 mit Weg zur Unterstützung).

## Nachweise und angrenzender Bestand

`BenutzerVerwaltungApiTest`: RLS, lesende Energiemanager, Sofortwirkung, atomarer Wechsel, A8 auch bei
parallelem Sperren. `BenutzerStartpasswortApiTest`: A9, fremde E-Mail, einmaliges Passwort, Pflichtwechsel.
Dazu `ZugriffEntzugApiTest`, `ZugriffStichtagTest` und Rechte-/Routen-Architekturwächter.
Portal: `BenutzerPage.test.tsx`, `AppShell.test.tsx`, additiver Routennachweis in `migration.test.ts`.
`e2e/benutzer.vite.config.ts` baut einen statischen Wirt; `benutzer.playwright.config.ts` prüft N1–N3/N8
und den vorhandenen Startpasswort-Fluss. Keine Test-Fixture im Produktionsbundle.

Plattformwege `AdminController.disableUser/deleteUser` verwenden denselben Konten-Prüfpunkt
`ZugriffAenderung.kontoBeenden`; [Kontenwege und Grenzen](uems-admin-kontoentzug.md) beschreibt
auch den Gegenweg `enable`. Tenant-Offboarding und Kompensation fehlgeschlagener Kontoanlage
bleiben getrennte Wege.
