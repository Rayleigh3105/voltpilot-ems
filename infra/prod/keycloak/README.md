# Produktions-Realm

[`voltpilot-realm.json`](voltpilot-realm.json) ist die Vorlage für **neue** Keycloak-Realms in Compose und im Projektimage. Ein bestehender Realm wird durch `start --import-realm` nicht überschrieben; Änderungen dort gezielt über die Administration nachziehen.

## Importwerte

Keycloak ersetzt `${VAR}` / `${VAR:default}` aus der Containerumgebung. `${env.VAR}` ist für diesen Import falsch. Das JSON akzeptiert keine zusätzlichen `_comment`-Felder.

| Variable | Zweck |
|---|---|
| `VP_PUBLIC_ORIGIN` | Redirects und Web Origins |
| `VP_API_CLIENT_SECRET` | Vertraulicher API-Client |
| `VP_PORTAL_ADMIN_PASSWORD` | Initialer Portal-Admin |
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

## OTA und Demodaten

Der Client `voltpilot-release-publisher` wird deaktiviert importiert. Sein Servicekonto besitzt nur `edge-release-publisher` für die dafür freigegebenen Release-/Trust-Set-Routen, keine Geräte-Rollout-Rechte. Vor Aktivierung ein echtes Secret setzen; den Platzhalter `change-me` nicht verwenden. [Signierung](../../../docs/ota-signing.md)

Der Import enthält initiale Admin- und Demo-Benutzer. Für Kundenbetrieb Demozugänge entfernen und das API-Profil leer lassen; `local` aktiviert zusätzliche Demo-Seeds. [API und Mandanten](../../../docs/api.md)
