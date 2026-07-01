# infra/mqtt/certs - broker TLS material (git-ignored, populated at deploy time)

The secure overlay (`docker-compose.prod.yml`) mounts three files from here into
EMQX. They are produced by `tools/pki/voltpilot-ca.sh` and **must never be
committed** (this directory is git-ignored except for the docs):

| File | Produced by | Mounted at |
|---|---|---|
| `server.crt` | `init-ca` (broker server cert) | `/opt/emqx/etc/certs/server.crt` |
| `server.key` | `init-ca` (broker server key)  | `/opt/emqx/etc/certs/server.key` |
| `device-ca.crt` | `init-ca` (device CA cert)  | `/opt/emqx/etc/certs/device-ca.crt` |
| `crl.pem` | `gen-crl` / `revoke` (optional) | `/opt/emqx/etc/certs/crl.pem` |

Populate them after issuing the CA:

```bash
./tools/pki/voltpilot-ca.sh init-ca --domain mqtt.example.com --ip <public-ip>
cp tools/pki/out/server/server.crt     infra/mqtt/certs/
cp tools/pki/out/server/server.key     infra/mqtt/certs/
cp tools/pki/out/server/device-ca.crt  infra/mqtt/certs/
cp tools/pki/out/ca/crl.pem            infra/mqtt/certs/    # optional
```
