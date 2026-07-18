# Flow Artifact Contract (v2)

**Status: BINDING (v2 track). Schema: [`flow-artifact.schema.json`](./flow-artifact.schema.json). Examples: [`examples/`](./examples/).**

The deployable, compiled form of a flow and its rollout to the edge. Compiler input =
[flow-graph](./flow-graph.md); compiler output = an **artifact** (manifest + compiled Node-RED
tab bundle); rollout = a retained **deployment set** per device.

## 1. Manifest

Every artifact carries (schema `$defs/artifact`):

- **Identity**: `artifact_id`, `flow_id`, `flow_version`, `runtime`.
- **Integrity**: `content_hash` = `sha256:` over the RFC 8785 (JCS) canonical serialization of
  the `bundle` object. The edge re-canonicalizes and verifies before applying; a mismatch is
  acked as `error` and never deployed.
- **Version gates**: `min_palette_version` (@voltpilot/node-red-vp-palette) and
  `min_core_version` (vp-edge-core). The edge compares against its installed versions and
  refuses with ack state `unsupported` instead of deploying a bundle its runtime cannot
  execute — the fleet is heterogeneous (no OTA yet), so artifacts must state their floor.
- **Capability requirements**: `required_entities` — entity ids + `measure:<channel>` /
  `actuate:<command>` descriptors. Checked against the edge's entity-registry view at deploy
  time; a miss refuses the WHOLE artifact (`unsupported` + detail). No partial deploys.
- **`signature`**: reserved for activation-time artifact signing (plan §2.2); format and trust
  chain are an E2 deliverable. Edges tolerate absence until then.

## 2. Bundle packaging

v1 bundle format: **`nodered-tabs`** — the Node-RED node array for the flow's tab(s), exactly as
it will appear in the runtime configuration. Properties the compiler guarantees:

- **Only catalog node implementations**: vp-palette nodes plus generated wiring. **No function
  nodes with free code in user flows** — this, not review, is what makes user flows unable to
  reach sockets/registers (the vendor driver tabs do all device I/O).
- **Deterministic ids**: tab and node ids are derived from `(flow_id, flow_version)`
  (`tab_ids` in the manifest), so a redeploy replaces instead of duplicating.
- **Tab ownership marker**: each artifact tab carries
  `info: "@vp-flow flow_id=<uuid> flow_version=<n>"` (see §4).
- **Size budget**: artifact ≤ 256 KiB, deployment ≤ 512 KiB serialized (schema `x-limits`) —
  comfortably inside EMQX's default 1 MiB max packet. Exceeding it fails activation cloud-side
  with a clear error; an out-of-band fetch channel (hash + HTTPS download, enrollment-style) is
  the documented escape hatch if flows ever outgrow inline delivery. Not built in v1.

## 3. Rollout channel

**Retained QoS1 deployment set on `ems/{tenant_id}/{site_id}/{device_id}/v2/flows`** (schema
`$defs/deployment`) — the proven retained-config self-wiring pattern (`edge/inverter/config`,
`edge/sources/config`, provisioning config), lifted to the cloud→edge boundary and living in
the same `v2/#` ACL subtree as the plan ([mqtt-schedule-2.0.md](./mqtt-schedule-2.0.md) §1).

Semantics:

- The payload is the **complete desired state** (all active artifacts for the device), never a
  diff. Retained delivery means a (re)connecting or freshly reinstalled edge converges to the
  current flow set with zero round-trips — the same property the inverter selection has.
- The **core** is the consumer: verify identity (topic == payload), hash, version gates and
  capabilities per artifact; persist artifacts to its data dir; inject/replace the tabs in the
  Node-RED runtime via the Admin API (runtime deploy, no container restart); remove tabs whose
  artifact disappeared from the set. An empty `artifacts` array clears every artifact tab.
- **Apply is per artifact, atomic per flow**: a failing artifact (hash/gate/capability) is
  skipped and acked as `error`/`unsupported`; the rest of the set still applies.
- Withdrawn/replaced flows release their entity claims: their standing desires expire via TTL
  (no cleanup protocol), and the arbitration falls to the plan/failsafe.

## 4. Coexistence with vendor template tabs (reseed)

Today the nodered image's reseed entrypoint replaces `flows.json` **wholesale** on template-hash
change (`edge-app/nodered/reseed-entrypoint.sh`) — correct while all flows are VoltPilot-owned,
fatal for user flows. The v2 rule this contract binds (implementation: E2):

- **Ownership is per tab, marked in the tab node**: vendor template tabs are the unmarked
  image-baked set; artifact tabs carry the `@vp-flow` marker (§2).
- **Reseed replaces the vendor tab group only** (hash per tab group, not per file) and preserves
  `@vp-flow` tabs byte-for-byte. Genuine runtime state (`.config.*.json`, credentials, context)
  stays untouched as today.
- **Self-healing either way**: if a reseed ever drops artifact tabs (old image, crash between
  steps), the retained deployment set restores them on the next core start — the same
  regenerate-from-truth posture as the broker-ACL self-heal.
- Vendor tabs keep doing all device I/O and keep their certification gates; artifact tabs speak
  only local-bus entity topics.

## 5. Activation ack and rollback

The edge acknowledges in the **status heartbeat** (additive block — the status topic has no
frozen schema; v1 precedent: the `control` and `purge_request` blocks):

```jsonc
"flows": {
  "palette_version": "2.0.0",
  "core_version": "2.1.3",
  "applied": [
    { "flow_id": "…", "flow_version": 7, "content_hash": "sha256:…",
      "state": "active" }              // or "error" | "unsupported", + "detail"
  ]
}
```

The cloud compares `applied` against the deployment it published: convergence = every artifact
acked `active` with the matching hash. Divergence surfaces in the portal (flow page shows the
device-reported state, never just the cloud's wish — the honest-status discipline).

**Rollback = previous version re-activation.** The cloud keeps every compiled artifact;
rolling back republishes the deployment set with the previous artifact (deterministic tab ids
make this a clean replace). There is no separate rollback protocol on the edge — rollback IS a
deployment. The same mechanism serves the E13a shadow exit: clearing the set returns every
entity to plan/failsafe control.
