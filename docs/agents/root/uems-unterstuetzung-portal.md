# Unterstützung im Portal (AP-03 IP-15)

`UnterstuetzungKarte` hängt an `BenutzerPage`, die Dialoge verwenden das gemeinsame Modal,
Picker und die einmalige `StartpasswortAnzeige`. Verwaltung allein über
`rollen.darf('unterstuetzung.verwalten', null)`. Die Kundenstandorte liest der Dialog über den bestehenden `/api/v1/standorte`-Weg mit
RLS-Verbindung und Standortgrenze.
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

Die Vorgabe `VOLTPILOT_UEMS_UNTERSTUETZUNG_UMSCHALTER_ENABLED` ist seit dem 26.10.2026 wieder **true**
(von IP-15 bis dahin false). Entscheidung des Betreibers: die Plattform-Administration springt wieder in
jeden Kundenbereich; alle Kunden haben eingewilligt. Das Portal schickt auf Kundenrouten weiter
`X-Kundenbereich`; offen nimmt die API das für die Plattform auch ohne Unterstützung an (Zugang
`umschalter`, ganzer Kundenbereich, auch ohne Standort: `/me` unternehmensweit, dann Anlage oder Portfolio
wie beim Kunden). Für Partner ändert der Schalter nichts. Der Wert der Produktion steht ausdrücklich in
GitOps (`apps/voltpilot/base/api/api.env`) und übersteuert die Vorgabe; dort muss er auf `true` stehen,
sonst bleibt der Sprung zu. `UnterstuetzungApiTest` läuft mit **false** (Not-Aus) und prüft daneben mit
einem offenen Lader den Sprung der Plattform und den geschlossenen Weg des Partners.
Keine Migration, keine Änderung der Rechte-Matrix oder der Rechte-Architekturwächter.

## Plattform ohne wirksame Unterstützung

Seit dem 26.10.2026 landet der Sprung (Dialog, Umschalter in der Kopfzeile, Flotte, Geräte, Updates, gemerkter
Mandant) in der Ansicht des Mandanten; Kopftext der Mandanten-Seite, Hinweis im Dialog und Karte „Mandanten
wählen“ versprechen ihn wieder ohne Bedingung. Nimmt die API den Mandanten trotzdem nicht an (`/me.kundenbereich`
ist `null`, obwohl ein Mandant gewählt ist: Not-Aus `umschalter-enabled=false` und keine Unterstützung), zeigt
`App` die Karte „Kein Zugriff auf diesen Kundenbereich“ mit Grund und dem Weg über Unterstützung oder
Notfall-Zugriff - nicht den Kundenzweig „Kein Standort zugewiesen“. `UnterstuetzungAdmin` lädt die Standorte der
Flotte schon mit dem Mandanten-Dialog und sagt bei einem Mandanten ohne Standort, dass Anfrage und Notfall dort
nicht gehen (`standort_fehlt`), der Sprung aber schon. Fehlt das Feld oder scheitert der Abruf, ist das unbekannt
und kein „kein Standort“. Die Portaltexte setzen den offenen Schalter voraus. Nachweise:
`mandantenSprungOhneUnterstuetzung.test.tsx` (offen, ohne Standort, Not-Aus), `MandantenPage.test.tsx`,
`UnterstuetzungAdmin.test.tsx` und `e2e/mandantensprung.spec.ts` (ganzer `App`, gefälschter `fetch` im Wirt
`e2e/mandantensprung.tsx`, `?schalter=aus` = Not-Aus).

## Nachweise

`UnterstuetzungApiTest` (Gewährung, Ablauf, Entzug, Selbst-Liste, Flotte, Kundenstandorte, Fremdzugriff),
`SelbstauskunftApiTest`, Vertragsleser und Rechte-Wächter. Portal: `Unterstuetzung.test.tsx`,
`apiRechte.test.ts`, `apiCoalesce.test.ts`, `AppShell.test.tsx`, Benutzer-, Copy- und Migrationswächter.
`e2e/unterstuetzung.vite.config.ts` baut ausschließlich den statischen E2E-Wirt nach `/tmp`;
`unterstuetzung.playwright.config.ts` prüft N4–N6/A14 und die bestehenden Benutzer-/Startpasswort-Flüsse.
Alle Ansichten sind echte Komponenten mit Ahrenberg-Fixtures außerhalb des Produktionsimports.
