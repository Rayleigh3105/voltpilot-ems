# Geräte-PKI

Werkzeuge für den mTLS-Broker und Geräte-Zertifikate. [Sicherheitsmodell](../../docs/security-mqtt.md) · [Geräte anbinden](../../docs/connect-a-device.md)

| Datei | Aufgabe |
|---|---|
| `voltpilot-ca.sh` | `init-ca`, `issue`, `revoke`, `gen-crl`, `list` |
| `openssl.cnf` | CA-Regeln und Zertifikatsprofile |
| `provision-device.sh` | Legacy-Claim über Portal-API und Zertifikat ausstellen |
| `verify_mqtt_security.py` | Lokaler Nachweis für mTLS, ACL und Widerruf ohne Docker |
| `out/` | Git-ignorierte Schlüssel und Zertifikate |

Für eine **neue** PKI, aus diesem Verzeichnis:

```bash
./voltpilot-ca.sh init-ca --domain mqtt.example.com --ip 203.0.113.10
./voltpilot-ca.sh issue --tenant <uuid> --site <uuid> --device <uuid>
python3 verify_mqtt_security.py
```

Die Kunden-Box verwendet den [Enrollment-Pfad](../../docs/api.md). Dieses Werkzeug bleibt für Betreiber und Legacy-Geräte. Bestehende CA erhalten; private Schlüssel niemals einchecken. Broker-Dateien: [infra/mqtt/certs](../../infra/mqtt/certs/README.md).
