# Edge Desired / Arbitration Contract (v2 local bus)

**Status: BINDING (v2 track). Schema: [`edge-desired.schema.json`](./edge-desired.schema.json). Examples: [`examples/`](./examples/).**

This contract defines how v2 flows influence physical devices: a flow's action node publishes a
**desired value** ("Wunsch") for an entity; the Go core **arbitrates** competing desires, **clamps**
the winner through the per-entity guard chain, and alone forwards a command to the driver layer.
Flows never write registers, never publish actuation topics, and can never bypass a guard.
A faulty customer flow can cost money ("kann nerven"); it can never violate safety, grid, or
contract limits.

The v1 local bus is a versionless, VoltPilot-internal namespace
(`edge-app/core/internal/localbus/localbus.go`). The v2 entity topics defined here are
**contract-grade** — user-authored logic (compiled flows) runs against them — and therefore carry
`schema_version` like every cloud contract.

## 1. The v2 entity topic family

All v2 local-bus traffic is per-entity, under one prefix:

| Topic | Direction | Retained | Payload |
|---|---|---|---|
| `edge/entities/{id}/config` | core → Layer 1 / flows | **yes** | Entity descriptor from the entity registry: identity, domain kind, capabilities (measure channels + actuate commands with bounds), guard limits, failsafe behavior, driver/connection info for self-wiring. Full schema is an E1a deliverable; the shape follows the proven `busEntry()` pattern (`edge-app/core/internal/sources/sources.go`). Publishing an **empty payload clears** the retained config (entity removed — the provisioning `clearRetained` precedent). |
| `edge/entities/{id}/telemetry` | Layer 1 → core | no | Per-entity flat measurement JSON (channels per the entity's declared capabilities + optional `ts`). Successor of `edge/sources/{id}/telemetry`; full schema is an E1a deliverable. |
| `edge/entities/{id}/desired` | flow runtime → core | **no** | A desired value — this contract, `$defs/desired`. |
| `edge/entities/{id}/arbitration` | core → observers | no | Arbitration/guard decision events — this contract, `$defs/arbitration`. |
| `edge/entities/{id}/command` | core → Layer 1 | **yes** | The guard-clamped command the driver layer executes. Published **only by the core**, after arbitration + guards. Successor of the retained `edge/setpoint`; shape is an E1a deliverable (generic command vocabulary + `control_enabled` gate, mirroring today's setpoint fields). |
| `edge/entities/{id}/readback` | Layer 1 → core | no | Register-level commanded-vs-actual proof after a write. Same payload shape as today's `edge/control/readback` (documented in `localbus.go`), addressed per entity. |

**Why per-entity topics (and not one array topic):** the existing `edge/sources/{id}/telemetry`
family already proved that per-entity topics scale to N sources with error isolation (a dead
source is simply absent). For **config**, v1 used a single retained array
(`edge/sources/config`); that coupling means every consumer sees every change and must diff.
Per-entity retained config lets a compiled flow subscribe exactly the entities it uses, lets
removal be a per-entity retained-clear, and — via the MQTT wildcard `edge/entities/+/config` —
still gives any consumer the complete set on subscribe, so no directory topic is needed.

**Entity ids** are MQTT-topic-safe (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, the provisioning ref
pattern); the cloud entity registry's row UUIDs are the recommended form. The id in a payload
MUST equal the `{id}` topic segment; the core ignores mismatches (the v1 topic==payload identity
rule from ingest and the purge listener).

**Coexistence on-device:** a v2 edge build may run the v1 topics (`edge/telemetry`,
`edge/setpoint`, `edge/sources/…`) and the v2 entity family side by side during E1a/E13a; the
telemetry fold consumes both. v1-only edges never see the v2 topics. Nothing in the v1 local
namespace changes.

## 2. The desired payload

See `$defs/desired` in the schema. Essentials:

- **`command`** — one entry from the generic vocabulary, shared with mqtt-schedule 2.0:
  `setpoint_kw` (signed; storage: + = charge, − = discharge — the v1 `battery_setpoint_kw`
  convention; consumers: + = consume), `on_off`, `limit_pct` (0–100 % of nameplate — the Deye
  reg `0x0028` precedent), `limit_kw` (absolute cap ≥ 0 — the v1 `pv_limit_kw` precedent), and
  `mode` (string from the entity's declared mode set). Generators are never commanded to
  produce; they are only ever capped (`limit_*` can only reduce — the v1 safety posture).
- **`source`** — who wants it. `flow` sources carry `flow_id`/`flow_version`/`node_id`, stamped
  by the compiler into the action node; a customer cannot edit them (there are no free code
  nodes, and the palette desire-publisher derives them from node config).
- **`priority`** — see §3.
- **`ttl_s`** — REQUIRED. See §5.
- **NOT retained.** A desired is an input with an expiry, not a state. A retained desired from a
  dead flow would re-command an entity after a core restart. (Contrast: `edge/setpoint` /
  `edge/entities/{id}/command` ARE retained — they are core-owned **outputs**, re-derived
  continuously, and the driver layer has its own staleness handling.)

## 3. Priority classes

Five classes, ranked: **`safety` (100) > `grid` (90) > `contract` (80) > `market` (60) >
`flow` (40)**. Below all of them sits the implicit **failsafe/default** (no active desired).

| Class | Who | Today |
|---|---|---|
| `safety` | device protection (SoC window, rated band, plausibility) | exists as guard clamps, never as desires |
| `grid` | Netzbetreiber signals (§14a; EEBUS LPC per E8) | §14a envelope exists as a guard clamp on observed `grid_limit_kw` |
| `contract` | Direktvermarkter dispatch, HLZF windows (E8/E9) | reserved; no producer yet |
| `market` | the cloud plan (mqtt-schedule 2.0), injected by the core's plan executor | today's schedule execution, generalized |
| `flow` | user flows (compiled action nodes) | new |

**Internal class `deadline-fallback` (rank 50, D-20 / Verbrauchssteuerung Inkrement 6):** the
edge-local deadline fallback of a `required_by_deadline` flexible task injects its wish between
`flow` (40) and `market` (60), below the D-5 flow override (70). It is CORE-INTERNAL only: no
external publisher can claim it — the desired parser rejects its source kind
(`deadline-fallback`) outright and no `classAllowed` entry exists — and it never carries
`override`. The rank placement is the whole mechanism of the "frischer Plan übernimmt nahtlos"
rule: a fresh plan's `market` desire and every reactive Pflichtregel-override PREEMPT the
fallback holder (supersede, no failsafe blip), while a plain opportunistic flow wish does not
outrank the due deadline duty. Deliberate deviation from verbrauchssteuerung.md §7 (fällige
Aufgabe > normaler Fahrplan): at the edge a fresh plan already CONTAINS the flexible task's
dispatch, so the plan wins whenever fresh.

**Effective ranks (what arbitration actually compares).** The class rank is the baseline; two
elevations sit on top of it, both inside class `flow`, both TTL-bounded:

| Effective rank | What | Where |
|---|---|---|
| 100 / 90 / 80 / 60 / 50 / 40 | the class ranks above | `Class.rank` |
| **70** | a **rule** — a flow desired with `override: true` (D-5) | `Desired.effectiveRank` |
| **75** | a **manual intervention** — source `local-ui` with `override: true` (D-6a) | `Desired.effectiveRank` |

A manual intervention is the only wish with a **person** behind it (the owner pressed *Jetzt voll
laden* / *Ladestand halten* / *Jetzt stoppen*), so it outranks a rule that is merely holding —
and it stays strictly below `contract` (80): explicit owner intent may cost money, never
compliance. Everything else about it is an ordinary class-`flow` desired: the 4-h override cap,
the full guard chain and the plant pause (`Automatik pausieren`) bind unchanged — the pause is a
GATE keyed on the CLASS, so it suspends a rank-75 wish exactly like a rank-40 one.

Two load-bearing rules:

1. **Compliance never competes.** On the current edge, `safety`/`grid` (and later `contract`
   windows) are enforced as **guard-chain clamps applied to whatever wins arbitration** —
   restrict-only, unbypassable, exactly the verified v1 chain
   (`edge-app/core/internal/guards/guards.go`): rated band → SoC window → EEG solar-only charge
   → observed §14a envelope (import AND export) → band again; the PS-3 peak guard runs after all
   compliance clamps and only ever lowers the setpoint. The desired classes `safety`/`grid`/
   `contract` are **reserved** in the schema for the E8 command-arbitration masters
   ("Netzbetreiber gewinnt immer" > Direktvermarkter > Standort-Optimierer); when those land,
   they arrive as desires from `cloud-command` sources — never from flows.
2. **Flows are always class `flow`.** The core rejects a flow-sourced desired claiming any other
   class (`arbitration:priority_not_allowed`). This is enforced in the core, not trusted to the
   publisher.

## 4. Ownership and conflicts

**Claim unit = the entity.** At any instant at most one desired **holds** an entity; the holder's
command (post-guards) is what the driver layer executes. Command types are not split across
owners — driving `on_off` and `setpoint_kw` of one entity from two owners is incoherent.

Resolution order:

1. **Higher class preempts immediately.** The previous holder receives `superseded` and
   automatically resumes (if still within TTL) when the higher-class desired expires or is
   released.
2. **Same class: the holder keeps the entity.** A same-class challenger is `rejected` with
   `arbitration:conflict` until the holder's TTL lapses. Deliberately **no last-writer-wins** —
   two flows fighting over one entity must never oscillate a physical device.
3. **Design-time prevention.** Activation-time validation (flow-graph contract, exclusive
   resources) refuses two active flows claiming the same entity in the first place — the runtime
   rule is the backstop, not the normal path.

**Flow vs. plan (the one deliberate exception):** by default `market` outranks `flow` — the
co-optimization is the arbitration for multi-use (captain decision D9: strategy nodes feed ONE
solver; desires don't fight what the solver already reconciled). A flow desired with
**`override: true`** is elevated above `market` — never above `contract`/`grid`/`safety` — for
its TTL, which the arbiter additionally caps at **14 400 s (4 h)**. This is the "boost" escape
hatch (owner presses *charge my car now*): explicit owner intent may cost money, never
compliance, and must not require editing the strategy graph. Arbitration events carry
`arbitration:override` so the elevation is loud, and the plan re-takes the entity on expiry.

**D-6a · The manual intervention is the ONE exemption from the same-class rule.** A desired from
source `local-ui` carrying `override: true` is ranked **75** (above a rule's 70) **and is exempt
from rule 2 above** — a holding rule must not be able to lock the owner out. Before this,
*Jetzt stoppen* against a holding `must_run` rule was `rejected` with `arbitration:conflict` for
as long as the rule kept renewing its wish (every 15 s), which inverted the intended ordering
*Schutz > Handeingriff > Regel*. The exemption is scoped to a pairing in which **one of the two
sides is the manual intervention**, and each direction has its own consequence:

- **manual challenger, rule holder** — the intervention preempts: the rule is `superseded`, stays
  stored, and resumes on the intervention's expiry (rule 1 + the §5 next-highest rule).
- **rule challenger, manual holder** — the rule falls through to the normal priority path, so it
  is **stored** and `rejected` with `arbitration:priority` (naming the holder) instead of
  `arbitration:conflict`. Its 15-s re-emission therefore keeps the stored copy alive and the rule
  resumes **seamlessly** when the intervention lapses, with no failsafe gap.
- **two manual interventions** — never reach the rule at all: source `local-ui` holds ONE slot per
  entity (`Source.Key`), so the later one **replaces** the earlier. That is the human
  expectation; a second press is a correction, not a competitor.

Nothing else changes: two RULES still cannot preempt each other via `override` (the same-class
rule is still checked on the CLASS), a rank-75 wish is still refused by `contract`/`grid`/`safety`
with `arbitration:priority`, the guard chain still clamps it (`clamped`, with the guard stage), and
the plant pause still suspends it.

## 5. TTL and expiry

- `ttl_s` is **required**, 1–86 400 s, anchored at `min(issued_at, receive time)` (a future-dated
  desired gains nothing). Recommended ≤ 900 s with re-emission on a flow trigger; re-emitting
  with the same `request_id` refreshes the TTL without an ownership change.
- On expiry (or release) the entity falls to the **next-highest active desired**, else to its
  **failsafe behavior from the entity registry config** — never to a remembered stale value.
  For a storage entity the registry failsafe is self-consumption (the v1
  `guards.SelfConsumption` fallback, composed with a plan-carried peak reserve exactly as
  today); for a consumer it is a configured safe state (typically off / release-to-native).
- The plan executor's `market` desires follow the plan's own staleness rules
  ([mqtt-schedule-2.0.md](./mqtt-schedule-2.0.md)); a stale plan withdraws them (with the
  PS-3 peak-target exception, which is a guard, not a desire).

## 6. How arbitration results surface

Every decision emits an event on `edge/entities/{id}/arbitration` (`$defs/arbitration`):
outcome (`accepted` / `clamped` / `rejected` / `superseded` / `expired` / `released` /
`fallback`), the `requested` vs. `granted` command, machine-readable `reasons` (stage list —
arbitration stages and guard stages, e.g. `guard:solar_only_charge`), and the entity's `holder`
after the event. `granted` is the post-guard value: **`clamped` means the desired won but the
guards reduced it** — the flow sees exactly what v1 operators see on the Fahrplan card
("Fahrplan sagt X → Wechselrichter bestätigt Y").

Three sinks, mirroring the proven v1 readback pattern (`edge/control/readback` → state snapshot
→ `:8484` card → status-heartbeat `control` block):

1. **The event topic** (above) — consumed by the flow runtime (an action node can expose an
   `accepted/clamped` output port) and by tests/simulators.
2. **The local state snapshot / `:8484` UI** — per-entity holder + last decision.
3. **The cloud status heartbeat** — an additive `entities` summary block (per entity: holder
   source, granted command, `all_match` from the latest readback). The status topic has no
   frozen schema (v1 precedent: the additive `control` and `purge_request` blocks), so this is
   additive; its exact shape is an E1a/E2 deliverable.

The **write proof** stays the readback layer: after the driver executes the granted command,
`edge/entities/{id}/readback` carries the register-level commanded-vs-actual result (same shape
as v1 `edge/control/readback`). Arbitration says *what was decided*; readback proves *what the
device actually did*.

## 7. Security posture (until bus AuthZ lands)

The local bus is a LAN trust zone and runs open in v1. Until per-client bus AuthZ/namespaces
ship (plan §2.8, with E2), the desired/command separation is enforced by construction, not by
broker ACL:

- User flows are **compiled from the typed graph**; the compiler emits only catalog node
  implementations — there are no free code nodes, and the only actuation-capable palette node
  publishes to `edge/entities/{id}/desired` with compiler-stamped source identity.
- The core validates every desired (schema, identity, capability, priority) and is the **only**
  publisher of `edge/entities/{id}/command`; the driver layer's write executor consumes only
  that topic and keeps its own two-gate certification check (kill-switch + certified families),
  unchanged from v1.
- When bus AuthZ lands, the flow runtime's client credentials will be restricted to
  publish-desired / subscribe-telemetry+config+arbitration; this contract already assumes
  nothing weaker.
