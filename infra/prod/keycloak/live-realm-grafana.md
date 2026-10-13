# Live-Realm = Import: Client für Grafana

Paket RL-P2a, Entscheid RL-3 = B vom 13.10.2026: Grafana ist über einen öffentlichen Namen erreichbar, und man meldet sich dort über Keycloak an. Dieses Blatt ist der Handgriff des Betreibers für den Client `grafana` im laufenden Realm.

`start --import-realm` legt den Client nur in einem **neuen** Realm an. Im laufenden Realm `voltpilot` gibt es ihn erst nach Schritt 3 unten. Die Gegenstelle steht im GitOps-Repository unter `infra/monitoring/grafana-zugang/README.md`; dieses Blatt ist dort Schritt 4, das Geheimnis Schritt 5.

## Was der Client festlegt

Der Eintrag steht zweimal und ist beide Male derselbe: unter `clients` in [`voltpilot-realm.json`](voltpilot-realm.json) und als Rumpf in [`live-realm-grafana.sh`](live-realm-grafana.sh).

| Punkt | Wert |
|---|---|
| Client-Id | `grafana`, vertraulich (Anmeldung des Clients mit Geheimnis) |
| Abläufe | nur Standard Flow (Authorization Code) mit PKCE `S256`. Aus: Direct Access Grants, Implicit, Service Accounts, Device, CIBA |
| Rückruf-Adresse | genau eine: `https://grafana.voltpilot.de/login/generic_oauth`, ohne Platzhalter |
| Adresse nach dem Abmelden | dieselbe |
| Web Origins | keine |
| Full Scope | aus. Scope-Zuordnung: nur die Realm-Rolle `platform-admin` |
| Default Client Scopes | `basic`, `profile`, `email`. **Nicht** `roles`. Zur Wahl: keiner |
| Mapper am Client | einer: Realm-Rollen als Claim `grafana_roles`, mehrwertig, **nur im ID-Token** |
| Anmelde-Ablauf | der des Realms. Der Client hat keinen eigenen; damit gilt der zweite Faktor für `platform-admin` auch hier |
| Geheimnis | steht in keiner Datei. Keycloak erzeugt es beim Anlegen |

## Warum das Zugriffstoken keine Rolle trägt

Das API macht aus **jedem** gültig signierten Token des Realms, das `platform-admin` unter `realm_access.roles` trägt, das Plattform-Konto (`KeycloakRealmRoleConverter`). Es prüft Aussteller und Unterschrift, aber nicht, für welchen Client das Token ausgestellt wurde (`aud`, `azp`). Grafana bewahrt Zugriffs- und Erneuerungstoken seiner Benutzer in der eigenen Datenbank auf.

Ein Client nach Werksvorgabe (Scope `roles`, Full Scope an) legte deshalb in Grafanas Datenbank ein Token, mit dem man am API Plattform-Admin über alle Kunden ist. Mit diesem Client nicht: Das Zugriffstoken trägt weder eine Rolle noch `tenant_id`, und das ID-Token trägt die Rolle unter einem Namen, den das API nicht liest.

**Nicht „reparieren“:** Wer in der Administration den Scope `roles` an den Client hängt, Full Scope einschaltet oder einen Mapper für `realm_access` ergänzt, stellt genau dieses Token aus. Grafana lässt ohnehin nur `grafana_roles` gelten. `pruefen` nennt jede dieser Änderungen, `angleichen` nimmt sie zurück.

## Die vier Sollwerte

1. ID-Token eines Kontos mit `platform-admin`: `grafana_roles` enthält `platform-admin`.
2. ID-Token eines Kundenkontos: `grafana_roles` fehlt.
3. Zugriffstoken beider: kein `realm_access`.
4. Beide Token tragen `sub`.

`ProduktionsRealmGrafanaClientTest` prüft alle vier an echten Anmeldungen (Authorization Code mit PKCE, das Betriebskonto mit zweitem Faktor) in Keycloak 26.0.5 im Produktionsmodus: am importierten Realm und an einem Realm, in dem das Skript den Client angelegt hat. Er reicht die Token durch den Konverter des API und vergleicht beide Clients Feld für Feld. `ProduktionsRealmGrafanaDateiTest` hält die zwei Einträge ohne Docker gleich.

## Handgriff

Das Skript [`live-realm-grafana.sh`](live-realm-grafana.sh) nutzt wie [`live-realm-anmeldung.sh`](live-realm-anmeldung.sh) nur `kcadm.sh` und Bash.

| Modus | Was er tut |
|---|---|
| `pruefen` | Liest nur. Vergleicht Felder, Mapper, Client-Scopes und Scope-Zuordnung mit dem Import und prüft die vier Sollwerte an Beispiel-Token. Das Geheimnis steht nie in der Ausgabe. |
| `angleichen` | Legt den Client an oder setzt ihn auf den Import zurück. Die Rolle `platform-admin` kommt erst in den Scope des Clients, wenn alles andere stimmt. Ein zweiter Lauf legt nichts doppelt an. Ein vorhandenes Geheimnis bleibt stehen. |
| `geheimnis` | Schreibt das Client-Geheimnis auf die Standardausgabe und sonst nichts. |

Die Beispiel-Token stellt Keycloak für ein Konto aus, ohne es anzumelden (in der Administration: Clients › `grafana` › Client scopes › Evaluate). `pruefen` nimmt dafür das erste Konto mit `platform-admin` und das erste ohne. Dabei entsteht keine Sitzung und kein Anmelde-Ereignis. Die Ausgabe nennt das Betriebskonto beim Namen und das andere Konto nur mit seiner Kennung.

| Exit | Bedeutung |
|---|---|
| 0 | `pruefen`: der Client steht wie im Import. `angleichen`: fertig. |
| 1 | `pruefen`: mindestens eine Zeile `ABWEICHUNG`. `geheimnis`: kein Client oder kein brauchbares Geheimnis. |
| 2 | Unbekannter Modus. |
| 3 | `angleichen` `VERWEIGERT`: dem Realm fehlt die Rolle `platform-admin` oder einer der drei Client-Scopes. Nichts wurde geändert. |
| 4 | `angleichen` `FEHLER`: nach dem Angleichen weicht noch etwas ab. Die Ausgabe nennt es. |
| 5 | `kcadm` liest den Realm nicht, meist weil die Anmeldung fehlt oder abgelaufen ist. Nichts wurde geprüft oder geändert. |

**Vorbedingung:** Die Anmelde-Härtung aus dem Blatt [Live-Realm = Import: Anmeldung härten](live-realm-import.md) ist gebunden (dort Schritt 3). Ohne sie fragt Keycloak ein Konto mit `platform-admin` nicht nach dem zweiten Faktor, und den öffentlichen Zugang zu Grafana schützt nur ein Passwort. `angleichen` legt den Client trotzdem an und meldet `ACHTUNG`; `pruefen` endet dann mit einer Abweichung am Realm.

Alle Befehle laufen dort, wo `kubectl` den Cluster erreicht, im Wurzelordner dieses Repositorys. `<namespace>` ist der Namespace des Deployments `keycloak`.

1. **Anmelden** im Keycloak-Pod wie in Schritt 2 des Blatts zur Härtung. Am einfachsten geschieht das in derselben Anmeldung wie die Härtung, vor deren Schritt 6: Sobald der Administrator des Realms `master` den zweiten Faktor hat, nimmt `kcadm` sein Passwort nicht mehr an. Dann bleibt der Weg unter „Wenn `kcadm` oder der Administrator ausgesperrt ist“ im selben Blatt.
   ```sh
   kubectl -n <namespace> exec -it deploy/keycloak -- bash -c 'export HOME=/tmp; /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth --realm master --user <admin>'
   ```
2. **Prüfen, angleichen, prüfen.** Das Skript läuft über die Standardeingabe, damit es nicht ins Image muss.
   ```sh
   S=infra/prod/keycloak/live-realm-grafana.sh
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S   # Exit 1: Client grafana fehlt
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s angleichen' < $S
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s pruefen'    < $S   # Exit 0
   ```
   Jeder Modus startet `kcadm` rund fünfzehnmal einzeln; im Test sind das etwa zehn Sekunden je Lauf, im Pod mehr. **Bricht `angleichen` ab**, steht der Client entweder noch nicht oder ohne die Rolle in seinem Scope. Dann trägt kein ID-Token `grafana_roles`, und niemand käme in Grafana hinein. `angleichen` noch einmal starten; `pruefen` nennt vorher, was fehlt.
3. **Geheimnis in das GitOps-Repository.** Der Wert entsteht in Keycloak. Die Pipe legt ihn in die Zwischenablage, ohne dass er im Terminal steht (macOS; unter Linux `wl-copy` oder `xclip -selection clipboard`):
   ```sh
   kubectl -n <namespace> exec -i deploy/keycloak -- bash -c 'export HOME=/tmp; bash -s geheimnis' < $S | tr -d '\n' | pbcopy
   ```
   Danach im GitOps-Repository `sops infra/monitoring/secrets/prod/grafana-oidc.sops.yaml` öffnen und den Wert bei `client-secret` einfügen. Gegenprobe, Sync und Neustart von Grafana stehen dort in `infra/monitoring/secrets/prod/README.md` unter „Client-Geheimnis für die Anmeldung über Keycloak“. Derselbe Wert steht auch in der Administration unter Clients › `grafana` › Credentials.
4. **Aufräumen:** die Anmeldung von `kcadm` aus dem Pod entfernen.
   ```sh
   kubectl -n <namespace> exec deploy/keycloak -- rm -f /opt/keycloak/.keycloak/kcadm.config
   ```
5. **Anmelden und ansehen**, sobald Grafana den Wert hat (GitOps, Schritte 6 und 7): Ein Betriebskonto kommt mit zweitem Faktor hinein. Ein Kundenkonto nimmt Keycloak an, und Grafana weist es ab („IdP did not return a role attribute“).

### Zurück

Der Befehl schaltet den Client ab. Keycloak lehnt dann jede Anmeldung über ihn ab und erneuert seine Token nicht mehr; laufende Sitzungen in Grafana enden mit dem nächsten Erneuern, nach höchstens 15 Minuten. Der Notfallweg zu Grafana über Port-Forward hängt nicht an Keycloak und bleibt.

```sh
kubectl -n <namespace> exec deploy/keycloak -- bash -c 'export HOME=/tmp; K=/opt/keycloak/bin/kcadm.sh; $K update clients/$($K get clients -r voltpilot -q clientId=grafana --fields id --format csv --noquotes) -r voltpilot -s enabled=false'
```

- Der Befehl braucht die Anmeldung aus Schritt 1.
- Das Geheimnis bleibt dabei stehen. `angleichen` schaltet den Client wieder ein; Grafana braucht dann keinen neuen Wert.
- Wer den Client in der Administration löscht, verliert das Geheimnis. Nach dem nächsten `angleichen` gilt ein neues, und Schritt 3 ist zu wiederholen.

### Den Namen ändern

`grafana.voltpilot.de` ist ein Vorschlag. Ein anderer Name steht in diesem Repository an zwei Stellen, die `ProduktionsRealmGrafanaDateiTest` zusammenhält: im Eintrag in `voltpilot-realm.json` (Rückruf-Adresse und Adresse nach dem Abmelden) und in `live-realm-grafana.sh` (derselbe Eintrag und `ADRESSE`). Die drei Stellen im GitOps-Repository nennt dort „Den Namen ändern“. Danach `angleichen` und `pruefen`.

### Neuer Realm

Bei einer Neuinstallation legt der Import den Client an, und Keycloak erzeugt das Geheimnis. Es gibt dafür keine Variable. Danach gilt Schritt 3: `geheimnis` lesen und ins GitOps-Repository eintragen. Bis dahin scheitert die Anmeldung an Grafana über Keycloak („Failed to get token from provider“), und niemand kommt hinein.

Ein Platzhalter als Geheimnis wäre keines. Beides ist an Keycloak 26.0.5 nachgestellt: Fehlt die Variable eines Platzhalters `${VP_…}`, bleibt er wörtlich als Geheimnis stehen. Ein leeres Geheimnis nimmt der Token-Endpunkt an. `pruefen` meldet deshalb ein Geheimnis, das ein Platzhalter oder kürzer als 24 Zeichen ist, und `geheimnis` gibt es nicht aus.

## Bestätigung

Der Betreiber trägt die Zeile ein, sobald `pruefen` mit Exit 0 endet und Schritt 5 gesehen ist.

| Datum | Person | Stand (Commit) | `pruefen` | Geheimnis im GitOps-Repository | Betriebskonto mit zweitem Faktor in Grafana | Kundenkonto abgewiesen |
|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – |
