# Live-Realm = Import: Anmeldung härten

UEMS AP-20 IP-20, Entscheid E12 = A vom 25.09.2026 (Regel BT6). Dieses Blatt ist der Handgriff des Betreibers; ohne ihn gilt die Härtung nur für eine Neuinstallation.

`start --import-realm` legt nur einen **neuen** Realm an. Der laufende Realm `voltpilot` bleibt, wie er ist. Bis unten eine Bestätigung mit Datum steht, ist die Lücke L-005 im Live-Realm offen, und die Zusage Z-017 hat keine Bestätigung des Betreibers.

## Was der Import festlegt

| Punkt | Wert in [`voltpilot-realm.json`](voltpilot-realm.json) |
|---|---|
| Anmelde-Ereignisse | `eventsEnabled`, Aufbewahrung `eventsExpiration` = 7 776 000 s (90 Tage) |
| Admin-Ereignisse | `adminEventsEnabled`, Aufbewahrung `attributes.adminEventsExpiration` = 90 Tage; ohne Inhalt der Änderung (`adminEventsDetailsEnabled` = false) |
| Passwort-Vorgabe | `length(12) and notUsername and passwordHistory(3)`: mindestens 12 Zeichen, nicht der Benutzername, keines der letzten drei |
| Browser-Anmeldung | Ablauf `voltpilot-browser`: für `platform-admin` ist der zweite Faktor (TOTP) Pflicht, für alle anderen Konten wählbar |
| Passwort-Grant | Ablauf `voltpilot-direct-grant`: kein Token für `platform-admin`; wer den zweiten Faktor eingerichtet hat, braucht ihn auch hier |

`platform-admin` ist das Konto des VoltPilot-Betriebs. Das API macht aus genau dieser Rolle das Plattform-Konto (`KeycloakRealmRoleConverter`).

## Was die Konten merken

- **Kundenkonten:** vorerst nichts. Bestehende Passwörter bleiben gültig. Keycloak prüft die Vorgabe erst, wenn ein Passwort neu gesetzt wird. Es gibt keine Sperre und keinen Zwangswechsel. Die Liste der letzten drei Passwörter beginnt mit der Umstellung. Das Startpasswort des API (24 Zeichen) erfüllt die Vorgabe; beim Pflichtwechsel gilt sie für das neue Passwort. Den zweiten Faktor kann jedes Konto selbst einschalten: unter `https://<Domain>/auth/realms/voltpilot/account` › Anmeldung › Authenticator-App. Danach fragt jede Anmeldung danach.
- **Betriebskonten (`platform-admin`):** Bei der nächsten Anmeldung im Browser verlangt Keycloak die Einrichtung einer Authenticator-App (TOTP, 6 Stellen, 30 Sekunden, etwa FreeOTP oder Google/Microsoft Authenticator). Ein Passwort-Grant gibt diesen Konten kein Token mehr. Laufende Sitzungen gelten bis zu ihrem Ende, also bis 24 Stunden, mit „Angemeldet bleiben“ bis 180 Tage. Deshalb beendet Schritt 4 sie.
- **Servicekonten** (`voltpilot-api`, Release-Publisher): unberührt, denn Client Credentials laufen nicht über diese Abläufe.
- **Selbstregistrierung – vor dem Einschalten klären:** Portal und API verlangen bei der Registrierung heute **8** Zeichen (`frontend/portal/src/App.tsx`, `RegistrationRequest`). Ein Passwort mit 8 bis 11 Zeichen lehnt Keycloak nach der Umstellung ab. Das Portal meldet dann nur „Die Registrierung ist zurzeit nicht möglich“. Deshalb die Umstellung erst vornehmen, wenn der ausgelieferte Stand 12 Zeichen verlangt, oder wenn die Selbstregistrierung in Produktion aus ist (`voltpilot.registration.enabled=false`).

## Handgriff

Das Skript [`live-realm-anmeldung.sh`](live-realm-anmeldung.sh) setzt dieselben Werte und baut dieselben Abläufe wie der Import. `ProduktionsRealmImportTest` fährt es gegen einen Realm ohne Härtung und vergleicht das Ergebnis Schritt für Schritt mit dem Import. Das Skript nutzt nur `kcadm.sh` und Bash, weil das Keycloak-Image kein `jq` hat.

1. **Sichern:** Der tägliche Keycloak-DB-Dump muss aktuell sein ([Backup](../backup/)). Zusätzlich den Realm ablegen:
   `kcadm.sh get realms/voltpilot > realm-vorher-<datum>.json`
2. **Anmelden** im Keycloak-Pod. Der Pfad `/auth` ist `KC_HTTP_RELATIVE_PATH`. `HOME=/tmp` legt die Anmeldung von kcadm an eine beschreibbare Stelle; das Skript liest sie dort:
   ```sh
   kubectl -n <namespace> exec -it deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth --realm master --user <admin>'
   ```
3. **Prüfen, angleichen, prüfen:** Das Skript läuft über die Standardeingabe, damit es nicht ins Image muss. `pruefen` liest nur und nennt jede Abweichung; ein zweites `angleichen` legt nichts doppelt an.
   ```sh
   S=infra/prod/keycloak/live-realm-anmeldung.sh
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s angleichen' < $S
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S   # Exit 0
   ```
4. **Sitzungen der Betriebskonten beenden:** In der Administration unter Realm `voltpilot` › Users › Konto › Sessions › Sign out. Alternativ: `kcadm.sh create users/<id>/logout -r voltpilot`.
5. **Anmelden und ansehen:** Ein Betriebskonto meldet sich an und richtet die App ein. Ein Kundenkonto meldet sich unverändert an. Beide Anmeldungen stehen unter Realm `voltpilot` › Events › User events, das Beenden der Sitzungen unter Admin events.
6. **Keycloak-Administrator (Realm `master`):** Dieses Konto gehört ebenfalls zum VoltPilot-Betrieb, steht aber nicht im Import. Unter Realm `master` › Users › Konto › Required user actions: „Configure OTP“.

**Zurück**, falls die Anmeldung klemmt: `kcadm.sh update realms/voltpilot -s browserFlow=browser -s 'directGrantFlow=direct grant'` bindet die eingebauten Abläufe wieder, und `-s passwordPolicy=` nimmt die Vorgabe zurück. Die Ereignisse dürfen an bleiben.

## Bestätigung (Z-017, L-005)

Der Betreiber trägt die Zeile ein, sobald `pruefen` mit Exit 0 endet und die Schritte 4 bis 6 erledigt sind. Die Zeile ist die Bestätigung zu Z-017 mit Datum. Mit ihr ist L-005 im Live-Realm behoben: In der [Lückenliste](../../../docs/bewertung/luecken.json) steht L-005 seit dem gehärteten Import auf `in_arbeit`. Der Übergang nach `behoben` braucht diese Zeile als Nachweis ([Regeln](../../../docs/bewertung/README.md)).

| Datum | Person | Import-Stand (Commit) | `pruefen` | Betriebskonten mit App | Sitzungen beendet | `master`-Admin mit App |
|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – |
