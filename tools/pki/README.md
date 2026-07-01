# tools/pki - device PKI + secure-broker tooling

Everything needed to run the VoltPilot mTLS broker and onboard real remote
devices. Full model: [`docs/security-mqtt.md`](../../docs/security-mqtt.md);
device guide: [`docs/connect-a-device.md`](../../docs/connect-a-device.md).

| File | Purpose |
|---|---|
| `voltpilot-ca.sh` | CA + cert tool: `init-ca`, `issue`, `revoke`, `gen-crl`, `list` |
| `openssl.cnf` | CA policy + server/device (serverAuth/clientAuth) extension profiles |
| `provision-device.sh` | claim (portal API) → issue cert, one command |
| `verify_mqtt_security.py` | Docker-free proof: mTLS handshake + ACL policy + revocation |
| `out/` | **git-ignored** CA + device keys/certs (never committed) |

Quick start:

```bash
./voltpilot-ca.sh init-ca --domain mqtt.example.com --ip 203.0.113.10
./voltpilot-ca.sh issue --tenant <uuid> --site <uuid> --device <uuid>
python3 verify_mqtt_security.py          # all checks should pass
```

Output keys live under `out/` (git-ignored). Broker material for the compose
overlay goes in `../../infra/mqtt/certs/` (also git-ignored) - see that dir's README.
