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

- **Kundenkonten:** vorerst nichts. Bestehende Passwörter bleiben gültig. Keycloak prüft die Vorgabe erst, wenn ein Passwort neu gesetzt wird. Es gibt keine Sperre und keinen Zwangswechsel. Die Liste der letzten drei Passwörter beginnt mit der Umstellung. Das Startpasswort des API (24 Zeichen) erfüllt die Vorgabe; beim Pflichtwechsel gilt sie für das neue Passwort. Den zweiten Faktor kann jedes Konto selbst einschalten: unter `https://<Domain>/auth/realms/voltpilot/account` › Kontosicherheit › Anmeldung › „Authenticator-Anwendung einrichten“. Danach fragt jede Anmeldung danach.
- **Betriebskonten (`platform-admin`):** Bei der nächsten Anmeldung im Browser verlangt Keycloak die Einrichtung einer Authenticator-App (TOTP, 6 Stellen, 30 Sekunden, etwa FreeOTP oder Google/Microsoft Authenticator). Ein Passwort-Grant gibt diesen Konten kein Token mehr. Laufende Sitzungen gelten bis zu ihrem Ende, also bis 24 Stunden, mit „Angemeldet bleiben“ bis 180 Tage. Deshalb beendet Schritt 4 sie.
- **Servicekonten** (`voltpilot-api`, Release-Publisher): unberührt, denn Client Credentials laufen nicht über diese Abläufe.
- **Selbstregistrierung – erst Portal und API, dann Keycloak:** Portal und API verlangen bei der Registrierung seit PR 1268 **12** Zeichen (`RegistrationRequest`: `@Size(min = 12, max = 128)`; Portal: `PASSWORT_MIN_ZEICHEN` in `frontend/portal/src/passwortRegel.ts`). Mit dem UEMS-Rollout ist die Vorbedingung also erfüllt; die Umstellung kommt darum **nach** dem Deploy von Portal und API ([Drehbuch](../../../docs/rollout/uems-erste-freigabe.md), nach Schritt 10). Auf einem ausgelieferten Stand mit 8 Zeichen lehnte Keycloak ein Passwort mit 8 bis 11 Zeichen nach der Umstellung ab, und das Portal meldete nur „Die Registrierung ist zurzeit nicht möglich“. Dort gilt weiter: erst umstellen, wenn der ausgelieferte Stand 12 Zeichen verlangt, oder wenn die Selbstregistrierung in Produktion aus ist (`voltpilot.registration.enabled=false`).

## Handgriff

Das Skript [`live-realm-anmeldung.sh`](live-realm-anmeldung.sh) setzt dieselben Werte und baut dieselben Abläufe wie der Import. Es nutzt nur `kcadm.sh` und Bash, weil das Keycloak-Image kein `jq` hat.

- `pruefen` liest nur. Es vergleicht die Werte des Realms und beide Abläufe Schritt für Schritt mit dem Import: Anbieter, Anforderung, Reihenfolge und die Rollen-Bedingung je Unterablauf. Jede Abweichung bekommt eine Zeile, auch ein leerer Ablauf.
- `angleichen` bindet die Abläufe erst, wenn beide vollständig sind. Ein zweiter Lauf legt nichts doppelt an.
- `ProduktionsRealmImportTest` fährt beides gegen einen Realm ohne Härtung und vergleicht das Ergebnis mit dem Import. Er bricht außerdem einen Lauf mittendrin ab, verstellt die Rollen-Bedingungen und fährt die zwei Befehle unter „Zurück“ so, wie sie hier stehen.

Alle Befehle laufen dort, wo `kubectl` den Cluster erreicht, im Wurzelordner dieses Repositorys. `<namespace>` ist der Namespace des Deployments `keycloak`; er steht im GitOps-Repository (`apps/voltpilot/overlays/prod/kustomization.yaml`). Ob das Deployment dort läuft, zeigt nur der Cluster.

1. **Sichern:** Der tägliche Keycloak-DB-Dump muss aktuell sein ([Backup](../backup/); nachsehen wie im [Backup-Runbook](../../../docs/backup-restore.md) unter „Sehen, dass es läuft“). Er ist das Backup. Die Datei aus Schritt 2 ist nur ein Nachweis.
2. **Anmelden** im Keycloak-Pod und den Realm ablegen. Der Pfad `/auth` ist `KC_HTTP_RELATIVE_PATH`. `<admin>` ist der Administrator des Realms `master`; nach dem Passwort fragt `kcadm`. Die Zeile `Picked up JAVA_TOOL_OPTIONS: …`, die Java im Pod vor jede Ausgabe von `kcadm` setzt, hat nichts zu bedeuten.
   ```sh
   kubectl -n <namespace> exec -it deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth --realm master --user <admin>'
   kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh get realms/voltpilot' > realm-vorher-<datum>.json
   ```
   `kcadm` legt die Anmeldung im Pod unter `/opt/keycloak/.keycloak/kcadm.config` ab. Das ist das Heimatverzeichnis des Benutzers `keycloak` im Image; `export HOME=/tmp` ändert daran nichts und steht nur noch aus Gewohnheit in den Befehlen. Das Skript liest die Anmeldung dort. Sie gilt 30 Minuten ohne Benutzung (Vorgabe von Keycloak) und enthält Token des Administrators; Schritt 8 räumt sie weg. Meldet ein späterer Befehl `No server specified`, `Failed to refresh access token` oder `HTTP 401 Unauthorized`, fehlt die Anmeldung oder sie gilt nicht mehr: den ersten Befehl wiederholen.
   Die abgelegte Datei enthält die Einstellungen des Realms, aber keine Konten, Clients und Abläufe.
3. **Prüfen, angleichen, prüfen:** Das Skript läuft über die Standardeingabe, damit es nicht ins Image muss.
   ```sh
   S=infra/prod/keycloak/live-realm-anmeldung.sh
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s angleichen' < $S
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S   # Exit 0
   ```
   `angleichen` braucht einige Minuten, weil jeder Aufruf von `kcadm` einzeln startet. Umgeschaltet wird erst mit dem letzten Handgriff, dem Binden.
   **Bricht `angleichen` ab** (Verbindung weg, Fehlermeldung, die Schlusszeile `Realm voltpilot angeglichen.` fehlt), ist noch nichts umgeschaltet. Dann `angleichen` einfach noch einmal starten: Es entfernt die halb gebauten, ungebundenen Abläufe und baut sie neu. `pruefen` nennt vorher, was fehlt.
   Meldet `angleichen` **`VERWEIGERT`** (Exit 3), weicht ein Ablauf ab, der schon gebunden ist. Dann ändert es nichts. Erst den ersten Befehl unter „Zurück“ fahren, danach `angleichen` noch einmal.
4. **Sitzungen der Betriebskonten beenden:** Laufende Sitzungen gelten sonst weiter, ohne zweiten Faktor. Betriebskonten sind die Konten mit der Rolle `platform-admin`:
   ```sh
   kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh get roles/platform-admin/users -r voltpilot --fields username,id --format csv --noquotes'
   ```
   In der Administration je Konto: Realm `voltpilot` › Users › Konto › Sessions › „Logout all sessions“ › „Confirm“. Der Text des Fensters klingt nach allen Konten; beendet werden nur die Sitzungen dieses Kontos. („Sign out“ im Menü ⋮ beendet eine einzelne Sitzung.) Alternativ je Konto mit der Kennung aus der Liste:
   ```sh
   kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh create users/<id>/logout -r voltpilot'
   ```
5. **Anmelden und ansehen:** Ein Betriebskonto meldet sich an und richtet die App ein. Ein Kundenkonto meldet sich unverändert an. Beide Anmeldungen stehen unter Realm `voltpilot` › Events › User events, das Beenden der Sitzungen unter Admin events. Ereignisse gibt es erst ab Schritt 3.
6. **Keycloak-Administrator (Realm `master`):** Dieses Konto gehört ebenfalls zum VoltPilot-Betrieb, steht aber nicht im Import. Unter Realm `master` › Users › Konto › Required user actions: „Configure OTP“ › Save. Bei der nächsten Anmeldung an der Administration richtet das Konto die App ein.
   **Dieser Schritt kommt zuletzt, wenn 3 bis 5 stimmen.** Sobald der Administrator die App hat, nimmt `kcadm config credentials` sein Passwort nicht mehr an (`Invalid user credentials`; schon mit der gesetzten Pflicht: `Account is not fully set up`), und die Anmeldung aus Schritt 2 endet. `kcadm` kann beim Anmelden keinen Code abfragen. Danach laufen `pruefen`, `angleichen` und die Befehle unter „Zurück“ nur noch mit einem anderen Zugang; siehe „Wenn `kcadm` oder der Administrator ausgesperrt ist“.
7. **Vor- und Nachname nur durch die Administration** (Review Nachweisen r1, P0-1): Der Import setzt im User-Profil `firstName` und `lastName` auf `edit: ["admin"]`; das Skript gleicht das User-Profil nicht ab.
   In der Administration unter Realm `voltpilot` › Realm settings › User profile › `firstName` bzw. `lastName` › Permission bei „Who can edit?“ nur „Admin“ lassen, dann Save.
   Der Urheber im Protokoll hängt nicht daran (er kommt aus `benutzer.anzeigename` bzw. dem Anmeldenamen), aber Token und Kontoseite zeigen dann keinen selbst gewählten Namen mehr.
8. **Aufräumen:** die Anmeldung von `kcadm` aus dem Pod entfernen.
   ```sh
   kubectl -n <namespace> exec deploy/keycloak -- rm -f /opt/keycloak/.keycloak/kcadm.config
   ```

### Zurück

Falls die Anmeldung klemmt. Der erste Befehl bindet die eingebauten Abläufe wieder; danach geht die Anmeldung wie vor Schritt 3. Der zweite nimmt die Passwort-Vorgabe zurück und ist nur nötig, wenn die Vorgabe selbst stört. Die Ereignisse dürfen an bleiben.

```sh
kubectl -n <namespace> exec deploy/keycloak -- bash -c "export HOME=/tmp; /opt/keycloak/bin/kcadm.sh update realms/voltpilot -s browserFlow=browser -s 'directGrantFlow=direct grant'"
kubectl -n <namespace> exec deploy/keycloak -- bash -c "export HOME=/tmp; /opt/keycloak/bin/kcadm.sh update realms/voltpilot -s 'passwordPolicy=\"\"'"
```

- Beide Befehle brauchen die Anmeldung aus Schritt 2. Sie laufen im Pod und gehen deshalb auch, wenn die Anmeldung im Browser klemmt.
- Die Vorgabe leert nur diese Form: Bei `kcadm` müssen zwei Anführungszeichen ankommen. `-s passwordPolicy=` ohne Wert endet ohne Fehler und ändert nichts.
- Nach Schritt 6 geht derselbe Rückweg in der Administration (sie meldet am Realm `master` an, den die Abläufe des Realms `voltpilot` nicht berühren): Realm `voltpilot` › Authentication › Flows › Zeile `browser` › ⋮ › Bind flow › „Browser flow“ › Save, dann Zeile `direct grant` › ⋮ › Bind flow › „Direct grant flow“ › Save.
- Der Rückweg nimmt eine eingerichtete App nicht zurück: Wer sie hat, wird auch von den eingebauten Abläufen nach dem Code gefragt. Die neuen Abläufe bleiben ungenutzt liegen; `angleichen` bindet sie wieder.

### Wenn `kcadm` oder der Administrator ausgesperrt ist

Nach Schritt 6 nimmt `kcadm` das Passwort des Administrators nicht mehr an. Und hat der einzige Administrator seine App verloren, kommt er auch nicht mehr in die Administration. Für beide Lagen legt Keycloak über `kubectl` ein Notfall-Konto im Realm `master` an. Ausprobiert am 12.10.2026 mit dem Projekt-Image (26.0.5, `start --optimized`), eigener Postgres und 1536 MB Speicher wie im Cluster:

```sh
kubectl -n <namespace> exec -it deploy/keycloak -- env KC_HTTP_MANAGEMENT_PORT=9001 JAVA_OPTS_KC_HEAP='-Xms64m -Xmx256m' /opt/keycloak/bin/kc.sh bootstrap-admin user --optimized --username <notfall>
```

Der Befehl fragt zweimal nach einem neuen Passwort und meldet `KC-SERVICES0077: Created temporary admin user with username <notfall>`. Seine letzte Zeile `Keycloak stopped` meint nur diesen Hilfsprozess (Exit 0). Der Keycloak des Pods läuft dabei weiter und startet nicht neu; das Konto gilt sofort.

- **Was der Befehl im Pod tut:** Er startet neben dem laufenden Keycloak einen zweiten Prozess mit derselben Datenbank. Im Versuch brauchte er gut 20 Sekunden und rund 340 MB zusätzlich. Die zwei Angaben vor `kc.sh` sind dafür nötig: Ohne `KC_HTTP_MANAGEMENT_PORT` legt er das Konto an, endet aber mit `Unable to start the management interface on 0.0.0.0:9000` (Exit 1). Ohne `JAVA_OPTS_KC_HEAP` brauchte er rund 700 MB.
- **Reicht der Speicher des Pods nicht** (Grenze 1536 Mi), beendet der Kernel den Container, und Keycloak startet neu; neue Anmeldungen gehen so lange nicht. Im Versuch war das Konto danach trotzdem angelegt. Wie viel Luft der Pod hat, zeigt nur der Cluster.
- **Mit dem Notfall-Konto** meldet sich `kcadm` an wie in Schritt 2 (`--user <notfall>`). Danach laufen `pruefen`, `angleichen` und die Befehle unter „Zurück“ wieder.
- **Verlorene App entfernen:** die Kennung des Administrators holen, seine Anmeldemittel listen, das mit `otp` löschen und die Einrichtung neu verlangen. Bei der nächsten Anmeldung richtet er die App wieder ein (wie Schritt 6).
  ```sh
  kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh get users -r master -q username=<admin> --fields id,username --format csv --noquotes'
  kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh get users/<id>/credentials -r master --fields id,type,userLabel --format csv --noquotes'
  kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh delete users/<id>/credentials/<otp-id> -r master'
  kubectl -n <namespace> exec deploy/keycloak -- bash -c "export HOME=/tmp; /opt/keycloak/bin/kcadm.sh update users/<id> -r master -s 'requiredActions=[\"CONFIGURE_TOTP\"]'"
  ```
- **Zum Schluss das Notfall-Konto löschen**, mit seiner Kennung aus der ersten Liste (ohne `-q`). Das geht auch, wenn `kcadm` gerade mit diesem Konto angemeldet ist; danach antwortet `kcadm` mit `HTTP 401 Unauthorized`.
  ```sh
  kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh delete users/<notfall-id> -r master'
  ```

## Bestätigung (Z-017, L-005)

Der Betreiber trägt die Zeile ein, sobald `pruefen` mit Exit 0 endet und die Schritte 4 bis 6 erledigt sind. Die Zeile ist die Bestätigung zu Z-017 mit Datum. Mit ihr ist L-005 im Live-Realm behoben: In der [Lückenliste](../../../docs/bewertung/luecken.json) steht L-005 seit dem gehärteten Import auf `in_arbeit`. Der Übergang nach `behoben` braucht diese Zeile als Nachweis ([Regeln](../../../docs/bewertung/README.md)).

| Datum | Person | Import-Stand (Commit) | `pruefen` | Betriebskonten mit App | Sitzungen beendet | `master`-Admin mit App |
|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – |
