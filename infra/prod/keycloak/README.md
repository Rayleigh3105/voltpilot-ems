# Produktions-Realm

[`voltpilot-realm.json`](voltpilot-realm.json) ist die Vorlage für **neue** Keycloak-Realms in Compose und im Projektimage. Ein bestehender Realm wird durch `start --import-realm` nicht überschrieben; Änderungen dort gezielt über die Administration nachziehen.

## Importwerte

Keycloak ersetzt `${VAR}` / `${VAR:default}` aus der Containerumgebung. `${env.VAR}` ist für diesen Import falsch. Das JSON akzeptiert keine zusätzlichen `_comment`-Felder.

| Variable | Zweck |
|---|---|
| `VP_PUBLIC_ORIGIN` | Redirects und Web Origins |
| `VP_API_CLIENT_SECRET` | Vertraulicher API-Client |
| `VP_PORTAL_ADMIN_PASSWORD` | Initialer Portal-Admin; muss die Passwort-Vorgabe erfüllen (mindestens 12 Zeichen, nicht `admin`), sonst bricht der Import ab |
| `VP_RELEASE_PUBLISHER_SECRET` | Optionaler OTA-Publisher |

Die ersten Secret-Platzhalter haben keinen eingebauten Standardwert. Fehlende Werte außerhalb der Compose-Prüfungen können als Literal stehen bleiben; das ist kein gültiges Secret-Setup.

## Authentifizierung

- `sslRequired=external`; TLS und korrekte Proxy-Header am öffentlichen Einstieg konfigurieren.
- `voltpilot-frontend`: PKCE-Login und Direct Grant für die automatische Anmeldung direkt nach Registrierung.
- Temporärer Brute-Force-Schutz: 10 Fehlversuche, zunächst 60 Sekunden Wartezeit bis maximal 15 Minuten. Admin-Passwortreset hebt auch die Sperre auf.
- API-Servicekonto benötigt `realm-management`-Rollen; das deklarative User-Profil muss `tenant_id` als administrativ verwaltetes Attribut zulassen.

| Sitzung | Inaktivität | Maximale Dauer |
|---|---:|---:|
| Normal | 12 Stunden | 24 Stunden |
| „Angemeldet bleiben“ | 90 Tage | 180 Tage |

Zugriffstokens leben 900 Sekunden und werden erneuert. Das Remember-Me-Häkchen ist im Theme vorbelegt; die Sitzungsdauer gehört zum Realm.

## Anmeldung härten (UEMS AP-20 IP-20, E12)

Der Import speichert Anmelde- und Admin-Ereignisse 90 Tage lang. Er setzt die Passwort-Vorgabe `length(12) and notUsername and passwordHistory(3)`, die erst beim nächsten Setzen eines Passworts greift. Für `platform-admin` verlangt er den zweiten Faktor (TOTP) im Browser und sperrt den Passwort-Grant; für alle anderen Konten ist der zweite Faktor wählbar. Der Live-Realm bekommt das **nicht** von selbst. Handgriff, Prüfskript und Bestätigung mit Datum stehen im Blatt [Live-Realm = Import](live-realm-import.md). Keycloak prüft die Vorgabe schon beim Import: Ein importiertes Konto mit kürzerem Klartext-Passwort bricht den Start eines neuen Realms ab. `ProduktionsRealmAnmeldungTest` prüft die Datei, `ProduktionsRealmImportTest` lädt sie in Keycloak im Produktionsmodus.

## Rolle `partner` nachziehen (manueller Betriebsschritt, UEMS AP-03 IP-3)

Die Vorlage enthält die Realm-Rolle `partner`: ein Partner-Konto (Installateur) **ohne** `tenant_id`, das einen Kundenbereich nur über eine gewährte Unterstützung erreicht. Der Live-Realm bekommt sie **nicht** von selbst (`--import-realm` überschreibt keinen bestehenden Realm). Dieses Repo rollt nichts aus; der Schritt ist einmal von Hand zu tun:

```sh
kcadm.sh config credentials --server <Keycloak-URL> --realm master --user <Admin>
kcadm.sh create roles -r voltpilot -s name=partner \
  -s 'description=Partner account (installer, UEMS AP-03 E7): NEVER a tenant_id; reaches a customer area only through a granted Unterstuetzung'
kcadm.sh get roles/partner -r voltpilot
```

Oder in der Administration: Realm `voltpilot` › Realm roles › Create role › Name `partner`.

- **Wann:** spätestens bevor ein Paket ausrollt, das Partner-Konten anlegt (AP-03 IP-8 Unterstützung, IP-14 Startpasswort). Fehlt die Rolle, lehnt das API das Anlegen ab und hinterlässt kein halbes Konto.
- **Nicht nötig:** kein Mapper, kein Client-Scope. `realm_access.roles` trägt die Rolle ohnehin, und einem Partner-Konto fehlt `tenant_id` einfach. Das Token heutiger Konten bleibt unverändert.
- **Nicht tun:** Bestandskonten nicht anfassen. `operator`, `admin` und `site-admin` bleiben (Altbestand; E13: bis zur nächsten Realm-Pflege).
- **Ohne Realm-Änderung gilt sofort:** Kundenkonten, die das API anlegt (Registrierung, Admin-Konsole), bekommen keine Realm-Rolle mehr. Kundenkonto ist, wer ein gültiges `tenant_id` trägt. Die Rechte kommen aus der Zuweisung im API, und die OCPP-Kundenstufe bleibt dieselbe wie mit `operator`.

## OTA und Demodaten

Der Client `voltpilot-release-publisher` wird deaktiviert importiert. Sein Servicekonto besitzt nur `edge-release-publisher` für die dafür freigegebenen Release-/Trust-Set-Routen, keine Geräte-Rollout-Rechte. Vor Aktivierung ein echtes Secret setzen; den Platzhalter `change-me` nicht verwenden. [Signierung](../../../docs/ota-signing.md)

Der Import enthält den initialen Portal-Admin `admin` und keine Demo-Benutzer mehr. `demo`/`demo` und `demo2`/`demo2` hätten die Passwort-Vorgabe gebrochen und den Import abgebrochen; sie stehen nur noch im [lokalen Realm](../../local/keycloak/voltpilot-realm.json). Für den Kundenbetrieb das API-Profil leer lassen; `local` aktiviert zusätzliche Demo-Seeds. [API und Mandanten](../../../docs/api.md)
