# Startpasswort und erste Anmeldung (AP-03 IP-14)

`benutzer/BenutzerService`, `StartpasswortKonten` und `web/BenutzerController` sind der Kundenweg:
`POST /api/v1/benutzer` nimmt Person, eine Kundenrolle und die Standorte an. Die Rolle je Standort
braucht mindestens einen sichtbaren Standort. Mandant aus JWT/TenantContext; kein Mandantenfeld im
Vertrag. Konto und Zuweisung entstehen in einer Handlung über `ZugriffAenderung`. Kein
`KundenbenutzerAngelegt`-Ereignis: der Bestandslauf darf neue Benutzer nicht zum Administrator machen.

`POST /api/v1/benutzer/{sub}/startpasswort` prüft den Benutzerspiegel unter RLS und danach die
Keycloak-Mandantenzuordnung. Beide Kundenrouten tragen `@Recht("benutzer.verwalten")`; der Dienst
schließt den Plattform-Umschalter zusätzlich aus. Fremdes Konto: 404; fehlendes Recht: 403 `recht_fehlt`.
Neuvergabe ändert weder Zuweisung noch einen bereits erreichten Kontozustand, erzwingt aber erneut den
Passwortwechsel. Der bisherige Support-Reset antwortet nur noch mit 403/404. Die bestehende Plattformanlage
legt unter Mandantensperre ausschließlich den ersten Kundenadministrator an; Kunden-Selbstregistrierung
bleibt ihr eigener Weg mit selbst gewähltem Passwort.

## Einmalige Ausgabe und Passwortregeln

- `Startpasswort.erzeugen()` verwendet `SecureRandom`, 24 Zeichen und alle vier Zeichengruppen.
  `StartpasswortKonten` verwendet denselben Weg für neue Kunden, den ersten Administrator und neue Partner
  bei Unterstützungen. Keycloak bekommt stets `temporary=true`; neue Konten tragen `UPDATE_PASSWORD`.
- **Die Passwortregeln kommen aus dem Keycloak-Realm, nicht aus dem Portal.** Keycloak prüft seine tatsächliche
  Policy auch bei Anlage und Neuvergabe. Verbietet die Betriebskonfiguration ein erzeugtes Passwort,
  scheitert die Anlage mit festem Kundentext; die Policy wird nicht umgangen oder automatisch geändert.
  `UPDATE_PASSWORD` muss im Realm aktiviert bleiben. SMTP/Passwort-Selbstbedienung ist separat.
- Die Antwort `BenutzerAngelegt` enthält das Passwort einmal und trägt `Cache-Control: no-store`.
  Kein Datenbankfeld, Protokoll, Folgeabruf oder E-Mail enthält es. `Startpasswort.toString()` ist maskiert;
  Keycloak-Fehlerkörper und rohe Exceptions werden nicht geloggt. Das gilt auch für die Unterstützungsantwort.
- Schlägt die lokale Transaktion nach einer Kontoneuanlage fehl, entfernt eine Transaktionskompensation
  das neu angelegte Keycloak-Konto. Ein fehlgeschlagener Rückbau wird nur mit der Konto-ID gemeldet.

## Anmeldung und Protokoll

Der verifizierte Zugriff auf `/api/v1/me` ist der Nachweis einer abgeschlossenen Anmeldung; Keycloak stellt
vor dem Pflichtwechsel kein Token aus. Ein bedingtes UPDATE auf `benutzer.zustand = 'angelegt'` schreibt
`aktiv`, `angenommen_am` und `zuletzt_angemeldet`. Dieselbe Transaktion protokolliert `erste_anmeldung`
genau einmal. Sperren und Entfernen werden dabei nie aufgehoben. Der Zustandswechsel gilt auch für den
Partner-Spiegel im angenommenen Kundenbereich. Neuvergabe protokolliert `startpasswort_neu` ohne Passwort.

`V20260916180000__uems_startpasswort.sql` erweitert nur `zugriff_vokabular()`, ohne Bestandszeilen zu ändern.
Die zwei Wörter stehen gemeinsam in `rechte-vectors.json`, `rechte.schema.json`, `RechteAbleitung` und
`rechte.ts`. Bei Änderungen alle Vertragsleser und die sechs Migrations-Nachbarklassen laufen lassen.

## Portalanschluss für IP-13

`benutzer.ts` enthält die zwei Kundenaufrufe. `BenutzerAnlegenDialog` ist die N3-Hülle; IP-13 reicht Person,
Rolle und ausgewählte Standorte aus N2 hinein und ergänzt seine Rollen-/Folgenvorschau. `onCreated` wird
**erst beim Schließen der einmaligen Passwortanzeige** mit dem passwortfreien Konto aufgerufen, damit ein
Listen-Reload die Ausgabe nicht vorzeitig aushängt. Der N2-Auslöser fokussiert sich vor dem Öffnen
explizit (`event.currentTarget.focus()`), damit die Fokusrückkehr auch auf Safari funktioniert. `StartpasswortNeuVergeben` ist der fertige Hebel für
N1 (`sub`, `name`). Beide lesen ausschließlich `rollen.ts`. Kein zweiter Menüeintrag und keine neue Liste.
`StartpasswortAnzeige` dient auch dem vorhandenen `CreateUserDrawer` der Plattformverwaltung.

Prüfungen: `BenutzerStartpasswortApiTest` (echtes Keycloak + RLS, wiederholte Anmeldung ohne Wechsel,
Realm-Policy, Neuvergabe, erste Anmeldung, DEBUG-Logs/übrige Antworten/DB), `StartpasswortGeheimhaltungTest`
(Keycloak spiegelt das Passwort im Fehler zurück), `BenutzerStartpasswort.test.tsx` und
`e2e/startpasswort.spec.ts` (375/1440, Chromium/WebKit, Fokus, Kopieren, Verwerfen, Plattformfluss).
Die Browserprüfung verwendet `vite build --config e2e/startpasswort.vite.config.ts` und
`playwright test --config e2e/startpasswort.playwright.config.ts`, einen statischen Testwirt ohne Dev-Server.
