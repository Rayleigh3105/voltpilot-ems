# Broker-Zertifikate

Das eigenständige Produktions-Compose mountet diese lokal bereitgestellten Dateien nach `/opt/emqx/etc/certs/`. Schlüssel und ausgestellte Zertifikate bleiben außerhalb von Git.

| Datei | Herkunft |
|---|---|
| `server.crt`, `server.key` | Broker-Zertifikat und privater Schlüssel aus `init-ca` |
| `device-ca.crt` | Geräte-CA aus `init-ca` |
| `crl.pem` | Sperrliste aus `gen-crl` / `revoke`; wirksame Broker-Konfiguration prüfen |

Vom Repository-Stamm aus:

```bash
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com --ip <public-ip>
cp tools/pki/out/server/server.crt infra/mqtt/certs/
cp tools/pki/out/server/server.key infra/mqtt/certs/
cp tools/pki/out/server/device-ca.crt infra/mqtt/certs/
cp tools/pki/out/ca/crl.pem infra/mqtt/certs/
```

Nur bei einer neuen PKI initialisieren. Bestehende CA/Schlüssel erhalten. [Sicherheitsmodell](../../../docs/security-mqtt.md) · [Deployment](../../../docs/deploy.md)
