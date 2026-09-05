# `.env`-Schalter müssen in der Compose auch WEITERGEREICHT werden

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 42).


`edge-app/docker-compose.yml` gibt dem `core` nur eine explizite Env-Liste mit —
ein vom Core gelesener `VP_*`-Schalter, der dort fehlt, ist über die `.env`
UNERREICHBAR (live bestätigt: `docker compose exec core env | grep VP_CONTROL`
war leer, obwohl CONTROL-BENCH.md das Setzen von `VP_CONTROL_ENABLED`
beschreibt). Prüfen mit `docker compose config` bzw. gegen die Liste aus
`grep -oE '"VP_[A-Z0-9_]+"' core/internal/config/config.go`. Lockstep: derselbe
Block steht in `install.sh generate_compose()` (Guard:
`test/install-selfcheck.sh`); `update.sh` sourced install.sh und folgt
automatisch. Default-Werte in der Compose IMMER auf `config.Defaults()` setzen,
damit das Weiterreichen nichts verändert. Weiterhin NICHT weitergereicht (bewusst
oder noch offen, siehe PR fm/vp-control-enabled-y3):
`VP_CONTROL_CERTIFIED_FAMILIES` (Zertifizierungs-Allowlist bleibt von der
`.env`-Oberfläche fern), `VP_CALIBRATION_*`, `VP_GRID_CHARGE_ALLOWED`,
`VP_NODERED_ADMIN_URL/USER/PASSWORD` auf dem CORE (E2-Flow-Deployment),
`VP_FLOW_NODE_STATUS_ENABLED`, `VP_SETPOINT_INTERVAL_SECONDS`,
`VP_RECONCILE_INTERVAL_SECONDS`, `VP_DEV_INSECURE`.

