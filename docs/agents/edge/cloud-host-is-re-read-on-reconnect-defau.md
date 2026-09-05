# Cloud host is re-read on reconnect; default portal is `portal.voltpilot.de`

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 1).


Two prod-hardening facts baked into the enroll/config layer (branch
`fm/vp-prod-cert-env-hardening`, 2026-07-03 live-incident hardening):

- **`enroll.Reconcile` adopts a changed broker endpoint, not only a changed
  device_id.** The cloud link caches the broker host at connect time (paho
  `AddBroker`), so a late-provisioned / moved MQTT host is honored only by
  tearing the link down and rebuilding it. Reconcile returns `Changed=true`
  when `MqttHost`/`MqttPort` differ even if `device_id` is unchanged; the
  agent's `adoptIdentity` then rebuilds the link on the new endpoint. Do NOT
  narrow the change check back to device_id only - a paho auto-reconnect would
  keep dialing the stale cached host forever. Pinned by
  `enroll_test.go TestReconcileAdoptsChangedBrokerHost`.
- **`config.Defaults().PortalBaseURL` is `https://portal.voltpilot.de`** (the
  `portal.` subdomain), kept in lockstep with `edge-app/docker-compose.yml`
  `VP_PORTAL_BASE_URL` + `install.sh`. The bare apex `https://voltpilot.de` is
  NOT a working enrollment endpoint.

Prod-deploy cert/env hardening lives outside edge-app: `server.key` must be
emqx-readable (`docs/deploy.md` step 3), the deploy workflows chmod
`infra/mqtt/certs/*` + preflight-require `MQTT_DOMAIN` when enrollment is on
(`.forgejo/workflows/deploy*.yaml`, `.env.prod.example`).

