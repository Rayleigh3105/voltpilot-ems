# Nutzungsprofil / EMS-Modus (AE7) — the second adaptation axis

Binding read-model contract for the usage profile. Authoritative spec:
[`data/vp-ems-replatform/adaptive-ems-ui-v1-spec.md`](../../../data/vp-ems-replatform/adaptive-ems-ui-v1-spec.md)
§2 (profiles), §3 (strategy nodes + governance), §4 (module cards reflect the flow).

Two adaptation axes drive the adaptive EMS UI: **Axis 1 = topology** (which entities/roles
exist → the energy flow + tiles, see [`topology-read-model.md`](topology-read-model.md)) and
**Axis 2 = usage profile** (the use case → the *emphasis* of the portal/edge). This file is
Axis 2.

## One truth — the profile is DERIVED, explicitly overridable

**Captain, R3-Q1: there is no second, competing "profile" concept.** The usage profile is
derived from the strategy nodes lying on the site's storage entities + the entity mix +
the money master data, and can be explicitly overridden. It generalises `site.plant_kind`,
the module surface and the onboarding "Nutzung" step — it does not add a parallel picker.

### Profiles (v1)

| Profil | Fokus | Geld-Ansicht |
| --- | --- | --- |
| `arbitrage` | Batterie-Arbitrage / DV — Erlös/Markt (heutiges Produkt) | prominent |
| `peak` | Gewerbe / Peak-Shaving — Lastspitzen, Leistungspreis, atyp. NN | sekundär (Nachweis) |
| `private` | Privat-Haushalt-EMS — Hausenergie-Flüsse + Gerätesteuerung | minimal/aus |

Graustromspeicher is a post-v1 profile.

### Derivation (pure, byte-identical twins)

Signals gathered server-side per site:

- `has_storage` / `has_pv` / `has_controllable_consumer` — from the entity registry
  (`measurement_point.entity_type` + the type catalog `category`, controllable via the catalog).
- `active_strategy_node_types` — the `vp.strategy.*` node types present in the site's **active**
  flows (`flow_definition` lifecycle = `active`).
- `plant_kind` (`direktvermarktung` | `eigenverbrauch` | null) and `has_leistungspreis`
  (`site.leistungspreis_eur_kw` non-null) — the money master data.
- `override` — `site.usage_profile_override` (customer/admin set; wins when valid).

`deriveDefault(signals)` (override ignored), then `effective = override ?? deriveDefault`:

1. a peak strategy node (`vp.strategy.peakshaving` / `vp.strategy.atypical-grid`) **or** a
   configured Leistungspreis → `peak`
2. a market strategy node (`vp.strategy.market`) **or** `plant_kind == direktvermarktung`
   → `arbitrage`
3. otherwise → `private` (household mix / eigenverbrauch, no market/peak).

Peak beats arbitrage beats private (a co-optimised peak+arbitrage site emphasises the peak
defence, spec §2/mockup peak view). An unknown site defaults to `private`.

### Emphasis map (the contract AE2/AE3/AE4/AE6 consult)

Given the effective profile, which surfaces are prominent | secondary | minimal | hidden.
Consumers **render** this; they never re-decide the emphasis.

| Profil | money | peak | flow | devices |
| --- | --- | --- | --- | --- |
| `arbitrage` | prominent | hidden | secondary | secondary |
| `peak` | secondary | prominent | secondary | secondary |
| `private` | minimal | hidden | prominent | prominent |

- `money` — the Erlös/Geld-Ansicht (existing Batterie-Arbitrage money view, reused as the
  arbitrage window — no new per-entity attribution engine in v1, spec §5).
- `peak` — the Lastspitzen / Leistungspreis card.
- `flow` — the adaptive energy-flow diagram (Axis 1 topology).
- `devices` — the Gerätesteuerung / Verbraucher surface.

## Node governance (spec §3)

Strategy nodes are classified in the flow catalog by a static `gated` flag:

- **free** (a private customer may place + activate on their own): device control
  (`vp.entity.control`) and every non-strategy data/logic/action node. (Self-consumption
  is the platform's BASE behaviour, not a strategy node — the former
  `vp.strategy.selfconsumption` was removed, report vp-nacht-bezug-e7 §3.3.)
- **gated** (needs VoltPilot enablement/contract — Erlösbeteiligung/Messkonzept/Vertrag):
  Arbitrage (`vp.strategy.market`), Peak-Shaving (`vp.strategy.peakshaving`), atypische
  Netznutzung (`vp.strategy.atypical-grid`).

Gated nodes are **placeable in a draft** but a flow carrying a gated node stays **inactive until
a Portal-Admin enables that node type for the site** (`flow_gated_node_enablement`). Activation
of a flow with a gated-but-not-enabled node is refused (`gated_node_not_enabled`) before the
compiler is ever contacted.

`vp.strategy.peakshaving` / `vp.strategy.atypical-grid` are added to the catalog here as gated
strategy nodes (their names are reserved in [`flow-graph.md`](flow-graph.md) §1). Their edge
compilation (flowc) + co-optimizer modules are E4/E6 follow-up — this ticket only classifies
and gates them, and seeds them into draft auto-start templates.

## Auto-Start-Flow (spec §3, R3-Q4)

A new/converted site gets a starter flow **draft** from a template matching the derived profile
(reusing the E3a/E2 flow machinery — not a new engine):

| Profil | Start-Flow strategy node |
| --- | --- |
| `arbitrage` | `vp.strategy.market` |
| `peak` | `vp.strategy.peakshaving` |
| `private` | *(none — self-consumption is base behaviour)* |

Each starter is the pilot chain shape (price/PV/SoC read → strategy → battery control) on the
battery, with the inputs the chosen strategy declares. Seeding is idempotent (skipped when the
site already has any flow) and requires a battery-hybrid entity. The arbitrage/peak starters carry
gated nodes (placeable drafts that need enablement to activate). The `private` profile seeds NO
starter flow (`no_template`): self-consumption is already the platform's base dispatch, so there is
no strategy node to place. Enriching a household with consumer device-control (`vp.entity.control`
on a wallbox/heating-rod) is AE5/E3b follow-up.

## Surfaces

- `GET /api/v1/sites/{siteId}/profile` — the effective profile, the derived default, the override,
  the emphasis map, and the raw signals. RLS-scoped (foreign site 404; admins via the
  `X-Tenant-Id` switcher).
- `PUT /api/v1/sites/{siteId}/profile` — set/clear `site.usage_profile_override` (body
  `{ "override": "arbitrage"|"peak"|null }`; null reverts to auto-derive). `private` is NOT a
  settable override — it is the derived household default (report vp-nacht-bezug-e7 §3.3), so
  `override: "private"` is a 400. Customer or admin, RLS-scoped; returns the recomputed profile.
  The override is also echoed on `SiteDto.usageProfileOverride`.
- `GET`/`PUT /api/v1/admin/sites/{siteId}/flow-node-governance` — the gated node types and their
  per-site enablement (platform-admin).
- `POST /api/v1/admin/sites/{siteId}/flows/auto-start` — seed the profile's starter flow draft.

## Cross-language discipline

`UsageProfileDeriver` (Java) and `usageProfile.ts` (TS) implement `deriveDefault` /
`effectiveProfile` / `emphasisFor` identically; both load
[`usage-profile-vectors.json`](usage-profile-vectors.json). Change the rules on both sides + the
vectors together. The edge (Go, AE6) is not built here — it consults this emphasis map via the
cloud once AE6 lands.
