# Eigenständiger Cloud-Betrieb mit Compose

Diese Anleitung gilt für eine eigene VM mit vollständigem Cloud-Stack. Bei Clusterbetrieb nur die tatsächlich dort vorgesehenen Datendienste verwalten; den vollständigen Stack nicht daneben starten. Der reguläre CI-Weg steht unter [Deployment](deploy.md).

## Voraussetzungen

Docker/Compose v2, passende DNS-Namen, Registry-Zugang und ein vorgeschalteter TLS-Reverse-Proxy. Geräte erreichen den MQTT-Broker direkt über mTLS `8883`; Portalverkehr läuft über den Proxy.

## Konfiguration

Im Repository-Checkout auf der VM:

```bash
cp .env.prod.example .env  # nur bei Ersteinrichtung
```

Alle erforderlichen Werte aus der Vorlage setzen: öffentliche Domain, MQTT-Domain, Datenbank-/Keycloak-Passwörter, Enrollment-CA und Image-Tags. Keine Dev-Secrets übernehmen. Das Spring-Profil bleibt für Produktion leer.

## MQTT-Zertifikate

Auf dem für die Geräte-CA vorgesehenen System:

```bash
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com
```

`mqtt.example.com` durch den tatsächlichen Broker-Namen ersetzen. CA-Schlüssel schützen; für Enrollment gehört die API in dessen Vertrauensbereich.

Brokerdateien unter `infra/mqtt/certs/` bereitstellen: `server.crt`, `server.key`, `device-ca.crt`; optional CRL. Der EMQX-Prozess muss den privaten Serverschlüssel lesen können. Eigentümer/Gruppe gezielt passend zum Container setzen; ihn nicht weltweit lesbar machen.

ACL-Verzeichnis gemeinsam für API und EMQX mounten, nicht die einzelne `acl.conf`. Details und Werkzeugbefehle: [MQTT-Sicherheit](security-mqtt.md).

## Start

Erst die aufgelöste Konfiguration prüfen; sie enthält Geheimnisse und gehört nicht in öffentliche Logs.

```bash
docker login git.tecmaxx.de
docker compose -f docker-compose.prod.yml config --quiet
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Alternativ unterstützt die Datei lokale Builds. Build-Kontexte und benötigte Build-Argumente stehen in der Compose-Datei.

## Reverse-Proxy

Der Proxy leitet HTTPS an den konfigurierten `APP_PORT` des Frontends weiter. Nginx reicht `/api/` an die API und `/auth/` an Keycloak weiter. WebSocket- und Forwarded-Header müssen zur gewählten Proxykonfiguration passen.

- HTML nicht dauerhaft zwischenspeichern; alte SPA-Einstiege können sonst veraltete Bundles laden.
- Den Frontend-Port nur für den Proxy freigeben. Datenbanken, Brokerverwaltung und Klartext-MQTT nicht öffentlich bereitstellen.
- Öffentlichen Keycloak-Issuer, Redirect-URIs und interne JWKS-Adresse aufeinander abstimmen.
- Keycloak-Import aktualisiert keinen bestehenden Realm. Änderungen auf Bestandsinstanzen gezielt nachziehen.

## Nach dem Start

Anmeldung und Mandantentrennung, Enrollment, frische Telemetrie, Preise und Fahrpläne prüfen. Eine grüne Containeranzeige allein belegt keine funktionierende Datenkette.

Die unterstützten Datenebenen-Ports und ihre LAN-Bindung stehen im [Deployment-Handbuch](deploy.md#datenebene-und-cluster).
