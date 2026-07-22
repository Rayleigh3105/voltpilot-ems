# VoltPilot Portal v3 — agent-executable build spec

**Status:** design DONE and owner-approved. This directory turns it into an engineering plan.
**Base:** `origin/main` @ `c8ec22f`.
**Design sources (read both before touching code):**

| What | Where |
|---|---|
| The approved 8-tab visual concept (the target look/structure) | `data/vp-portal-v3-design/concept.html` (firstmate workspace) |
| Design rationale §1, decisions §3, build outline §4 (P1–P7) | `data/vp-portal-v3-design/report.md` |

Each milestone file below (`M1-shell.md` … `M7-rollen.md`) is **self-contained**: an agent can build
that milestone from the milestone file + the concept tab it names + the code files it lists. Nothing
here depends on chat context.

---

## 1. Vision

Portal v2 is functionally rich but navigationally heavy: six deep views hidden behind a "Mehr ▾",
three parallel navigations, five overlapping words for one device, a home screen that leads with
numbers instead of the plant, and a Steuerung with four sections and two doors into the same
builder. v3 turns that around — after the OpenEMS pattern, but in VoltPilot's brand and on
VoltPilot's existing capabilities: **one navigation** (all areas open in the sidebar, grouped into
"Anlage" plus one coloured group per active mode profile), **home = a live cockpit** with the
existing energy-flow diagram as the hero, **mode profiles as a visible shelf the customer switches
themselves**, a **two-capsule Steuerung**, automations that feel like **real Node-RED** (drag, saved
positions, live values on the wires, code nodes), and a **plant model** (Geräte → Komponenten →
Anlage) instead of a device/entity list.

**Customer-facing goal:** a plant owner opens the portal and sees *their plant working* — what is
flowing right now, what it earned, what VoltPilot is allowed to do — and can extend it themselves
without ever meeting the words "Entität", "Messpunkt" or "Quelle".

Almost everything is presentation over existing endpoints. The only notable new backend piece is the
**persisted per-Anlage profile state** (M3). The biggest frontend piece is the **canvas rebuild** (M5).

---

## 2. Locked decisions — bake these in, do not re-open

### D1 · Code-node safety → edge-only + watchdog
Customer JavaScript runs **exclusively on the customer's own edge device** (the Node-RED function
sandbox). **The cloud never executes customer code.** flowc wraps every code node in a **watchdog**
(abort above ~500 ms CPU, error → node status, never a silent hang). `functionGlobalContext`
network handles (`net`/`http`) stay **out** of the sandbox context for customer flows, and the
command rate is limited at the `vp-desired` chokepoint. The edge guard chain still clamps every
*device command*, including those from code nodes — that chain is the safety argument that lets the
editor be open to everyone. Rejected: a hard `isolated-vm` sandbox (native arm64 dependency,
diverges from Node-RED), and deferring to v3.1. → **M5**.

### D2 · "Real Node-RED" → our own editor at Node-RED quality
We build the **portal's own editor** up to Node-RED quality (drag, persisted positions, live values
on the wires, code nodes) and keep deploying through the **existing flowc artifact pipeline**
(content hash, guards, `@vp-flow` tabs, reseed coexistence — all intact). We do **not** tunnel the
edge's Node-RED into the portal (tunnel + tenant auth, bypasses the flowc discipline, English/
technical, collides with "Layer 1 is wired by VoltPilot, never by the customer"). → **M5**.

### D3 · Vocabulary → "Komponente"
The customer dictionary is **Gerät / Komponente / Messwert**. The middle concept (the role between
a physical device and the plant) is **"Komponente"** — *not* "Anlagenteil", not "Bereich".
Entität / Messpunkt / Quelle / Mess-Einheit disappear from the customer surface entirely (they stay
in the installer/admin panels and unchanged in the backend). → **M6** + a copy sweep in **M7**.

### Refinement (owner, after review) · reuse the current energy flow
The Live-Cockpit **reuses the CURRENT energy-flow component** —
`frontend/portal/src/components/EnergyFlow.tsx` (and its adaptive sibling
`components/AdaptiveEnergyFlow.tsx` for migrated plants) — moved in **larger, as the hero**.
Design, animation, "—" discipline: unchanged; only size and placement change.
**Do NOT design or build a new "Energie-Rad" / `EnergyWheel.tsx`.** → **M2**.

---

## 3. Milestones

| # | File | Concept tab | Realizes | Weight |
|---|---|---|---|---|
| **M1** | [`M1-shell.md`](./M1-shell.md) | 2 · Shell & Navigation | P1 — sidebar groups, Anlage context card, health badge, 5-slot bottom bar, tablet icon rail | medium |
| **M2** | [`M2-cockpit.md`](./M2-cockpit.md) | 3 · Live-Cockpit | P2 — existing EnergyFlow as hero, Autarkie/EV rings, widget grid + widget modal | medium |
| **M3** | [`M3-profile.md`](./M3-profile.md) | 4 · Modus-Profile | P3 — `site_profile_state` + `GET/PUT /sites/{id}/profiles` + surface overlay + customer `autoStart`; **every** profile is a direct customer toggle (no "Angefragt") | medium (the one backend piece) |
| **M4** | [`M4-steuerung.md`](./M4-steuerung.md) | 5 · Steuerung | P4 — two capsules, ONE "＋", template filter `requires:[role]` | small |
| **M5** | [`M5-automationen.md`](./M5-automationen.md) | 6 · Automationen | P5 — drag + persisted positions, live values, deployed-version view, `vp.logic.function`, phone step list, edge node-status; **plus the production go-live of flow activation** 🔴 | **large** |
| **M6** | [`M6-komponenten.md`](./M6-komponenten.md) | 7 · Anlagen-Modell | P6 — three columns, adopt+role in one dialog, "Komponente" dictionary | medium |
| **M7** | [`M7-rollen.md`](./M7-rollen.md) | 8 · Rollen & Umsetzung | P7 — role-gate the technical panels, legacy redirects, responsive proof, copy sweep | small |

### Build order / dependency graph

```
                 ┌─────────────────────────────► M6 Komponenten ──┐
                 │                                                │
M1 Shell ────────┼─────────► M2 Cockpit ────────────────────────┐ │
   (first,       │                                              │ │
    frames all)  ├─────────► M3 Profile ──► M4 Steuerung ──► M5 Automationen ──► M7 Politur
                 │              (backend)      (two capsules)   (editor)         (last)
                 └─────────► (M5 canvas work may start here, in parallel)
```

**Hard edges**

| Edge | Why |
|---|---|
| M1 → everything | M1 owns nav/route shape and deletes `components/AnlageMoreMenu.tsx`; later milestones mount pages into the new sidebar groups. |
| M3 → M4 | The Steuerung profile capsule renders the persisted state (`an` / `aus`); without M3 it can only show derived modes. |
| M4 → M5 (integration) | The single "＋ Neue Automation" dialog is M5's entry point. M5's canvas/compiler work is independent and **may start right after M1** on its own track; only the wiring waits for M4. |
| M3 → M5 (go-live) | M5 turns flow activation on in production; M3 is what lets a **customer** open the gated strategy/price nodes for their own site. Without M3 the go-live is only half real (a customer can build a strategy flow but not enable its node). |
| M1 → M6 | "Anlagen-Modell" is a sidebar area of the trio; M6 fills it. |
| all → M7 | M7 gates, redirects and sweeps what the others built. |

**Safe to parallelize after M1:** M2 ∥ M3 ∥ M6, plus the M5 canvas/flowc track.
**Never parallelize:** two milestones editing `src/index.css` at once — see §4.

---

## 4. Global conventions every milestone obeys

1. **The `surface.ts` composition spine is the law.** `src/surface.ts` (`activeModes(site)`,
   `baseSurface(entities)`, `anlageSurface(site)`, per-mode manifests with `cockpitBlock` /
   `moneyStreams` / `steuerungCard` / `deepViews`) is the ONE derivation of *what a plant shows*.
   Nav, cockpit composition, money streams and deep views are **read from it, never re-derived**.
   Extend it (new manifest fields, a profile-state overlay) — do not bypass it, and do not add a
   competing server endpoint (`GET /sites/{id}/surface` deliberately does not exist).
2. **The "—" discipline.** A value that cannot be computed renders **"—"**, never a fabricated `0`,
   and a tile without a source is **omitted**, not shown empty. This already holds across
   `cockpit.ts`, `live.ts`, `fleet.ts`, `pvSources.ts`, `entities.ts` — new code matches it.
3. **Responsive proof at 375 / 768 / 1440.** Zero horizontal overflow at every breakpoint; touch
   targets ≥ 44 px. Every flex/grid child that hosts a number, chart or badge needs `min-width: 0`.
   Measure phones with a real device emulation (`emulate --viewport "375x812x2,mobile,touch"`) —
   a plain window resize bottoms out at Chrome's ~500 px minimum and silently measures the wrong
   thing.
4. **Result language.** German customer copy states outcomes, never internals: no "Entität",
   "Messpunkt", "Quelle", "Modul", "MILP", "Optimizer", "Broker", "Flow-Dokument", no register or
   Modbus vocabulary. Channel names always go through `src/channels.ts`.
5. **Pure logic module + thin renderer.** Every new surface derives through a pure, unit-tested
   `src/*.ts` module (the `cockpit.ts` / `steuerungArea.ts` / `rollen.ts` precedent); components only
   render. Exhaustive state coverage lives in the pure test.
6. **Icons only via the design-system `Icon`** (`designsystem/components/core/Icon.jsx` + `.d.ts`),
   never emoji or unicode glyphs. A new glyph is added to both files in the same PR.
7. **CSS placement.** New surface CSS goes into a **component-local stylesheet** next to the
   component (the `components/CockpitBlocks.css` / `Steuerung.css` precedent) unless it is genuinely
   shell-wide; only then append a clearly-labelled block to `src/index.css`.
   **Treat esbuild's CSS "unbalanced {" warning as a hard error** — one unclosed brace silently
   swallows every later rule.
8. **Routes are additive, bookmarks never break.** `src/nav.ts` keeps its LEGACY discipline: a
   retired hash redirects, it never 404s. Every `AnlagenSub` must be reachable from the new shell,
   which `anlageNav.test.ts` enforces.
9. **A gate is never faked in the UI — it is opened by an authorized server action or not at all.**
   RLS, role checks, the peak-shaving configuration gate and the flow-activation gate are re-checked
   server-side on every call. v3 does make one gate **customer-openable**: switching a mode profile
   on (M3) makes the server enable exactly that profile's gated node types for that site. That is an
   authorized, audited server-side effect of an explicit customer action — **not** a client-side
   bypass, and it never touches the edge guard chain or the §14a/EEG protections, which stay literal.
10. **Un-migrated (v1) plants stay byte-identical** wherever the projection is not active. The
    consolidated invariant file is `src/migration.test.ts` — new projection surfaces are pinned
    there.

---

## 5. DO NOT TOUCH

| Area | Path | Why |
|---|---|---|
| Optimizer / solver | `services/optimization/**` | Economics + the golden suite; v3 is a view layer. |
| Earnings engine | `services/api/**/repo/EarningsRepository.java` and its DTOs | Money math is settled; v3 re-places numbers, never recomputes them. |
| Flow lifecycle gates | `services/api/**/flows/FlowGovernance.java`, `FlowActivationService`, `FlowGraphValidator` semantics | Governance/activation gates stay literal. (M5 *adds* a catalog type; it does not loosen a rule.) |
| RLS / auth spine | `TenantFilter`, `TenantAwareDataSource`, Flyway `V1`/`V2`/`V4`, Keycloak realm | Multi-tenancy correctness. |
| Edge guard chain | `edge-app/core/internal/guards/**`, `internal/desired/**` | It is the safety argument for an open code node (D1). M5 adds only an **additive, read-only** node-status block on the heartbeat. |
| Admin platform area | `src/pages/admin/**` | Nav mounting only; no redesign of the operator console. |

---

## 6. Delivery strategy

- **Milestone = PR, straight onto `main` (owner decision).** There is **no long-lived feature
  branch**. Each milestone lands on `main` as a normal reviewed direct PR, so `main` evolves toward
  v3 commit by commit. What holds the release together is not a branch but the deploy discipline:
  **the owner does not deploy until v3 is complete and real-data-verified.**
- **Per-milestone gate (before merging to `main`):** the milestone file's acceptance criteria +
  `npm run build` (`tsc && vite build`) + `npm test` (vitest) green, and — for milestones touching
  the api or flowc — `./mvnw test` in `services/api` and `node --test` in `edge-app/nodered/flowc`
  green. A merged-but-not-yet-deployed `main` must stay coherent: never merge a milestone that
  leaves a half-built surface reachable in the UI.
- **Real-data dress rehearsal before the release.** Restore the real production dump
  `data/vp-deploy-readiness/prod.dump` into a **throwaway** `timescale/timescaledb:2.17.2-pg16`
  container (own network, own ports, destroyed afterwards) and run the v3 api + portal against it.
  The step-by-step recipe is `data/vp-prod-dryrun/report.md` ("Reproduce / evidence" plus
  `data/vp-deploy-readiness/report.md` §8). Two facts from that run that the rehearsal must re-check:
  the cluster roles `voltpilot_app` / `voltpilot_admin` are **not** in the dump and must be created
  by hand before the api can connect; and every real plant must still render its money headline and
  its energy flow correctly in v3.
- **One release.** When every milestone is on `main` and the dress rehearsal passed, the owner
  deploys **once** via the `deploy-fast` workflow (`.forgejo/workflows/deploy-fast.yaml`) or the full
  `deploy.yaml` gate. That single release therefore also carries whatever else already merged onto
  `main` in the meantime (today: #212 / #213) — the rehearsal must be run against the **actual `main`
  tip**, not against a v3-only subset.
- **🔴 Automations go LIVE with this release (owner decision).** The v3 release itself
  **switches `VOLTPILOT_FLOWS_ACTIVATION_ENABLED` on in production** and **ungates the price/
  strategy nodes** for customer sites, so customer-built automations really do control devices from
  day one. This is not a later, separate go-live.
  **RISK — real device control from day one.** Until now no production site could activate a flow
  (`activation_disabled`). After this release a customer's own rule can command their wallbox,
  heat rod or battery. The safety net is the **edge guard chain** (§14a envelope both directions,
  EEG solar-only charge, rated power band, SoC window, rate limit) plus arbitration: a flow can only
  ever *wish*, never force. That chain is on the DO-NOT-TOUCH list for exactly this reason.
  **Therefore the automation control path is a HARD release gate** (see §7): author a rule →
  compile via flowc → deploy the artifact → the edge applies it → the resulting device command is
  observed **guard-clamped**, proven end to end on the dress-rehearsal stack before the deploy.
- **Rollback stance.** Portal + api roll back by redeploying the previous image tag (`IMAGE_TAG` is
  the commit SHA). The only forward-only pieces are the additive migrations (M3 `site_profile_state`,
  M5 flow layout + node status): all are **additive tables/columns**, so the previous image ignores
  them and keeps working — never a destructive DDL, never an edit of an applied migration. The M5
  edge heartbeat block is additive and feature-flagged; old edges simply do not send it and the
  editor falls back to channel values.
  **The automation go-live has its own, faster rollback than an image roll-back:** set
  `VOLTPILOT_FLOWS_ACTIVATION_ENABLED=false` and redeploy the api — new activations then refuse with
  `activation_disabled` again. Note what that does *not* undo: artifacts already deployed to a device
  keep running (they are retained on `…/v2/flows`). To stop a specific live rule, use the existing
  per-flow **`POST …/flows/{flowId}/deactivate`**, which retires the active version and republishes
  the smaller deployment set — it is deliberately never gated by the activation flag. Both levers
  must be rehearsed in the dress rehearsal, not discovered during an incident.

---

## 7. Whole-release acceptance

- [ ] `frontend/portal`: `npm run build` (includes `tsc`), `npx tsc --noEmit`, `npm test` (vitest) all green.
- [ ] `frontend/portal`: `npm run test:csp` green (the nginx CSP smoke — no inline scripts).
- [ ] `services/api`: `./mvnw test` green (Testcontainers included; this sandbox's Docker daemon
      may need `-Ddocker.api.version=1.41`).
- [ ] Flow pipeline green: `node --test edge-app/nodered/flowc/` and
      `node --test edge-app/nodered/*.test.js`; `edge-app/nodered/vp-palette` `npm test`;
      `cd edge-app/core && go test ./...`.
- [ ] The three-catalog guards pass (api ⟷ portal ⟷ flowc: type-set, port shape, feed reachability).
- [ ] `src/migration.test.ts` green: an un-migrated plant and a backend without the v2/v3 routes
      produce nothing new anywhere.
- [ ] Responsive proof captured at 375 / 768 / 1440 for cockpit, Steuerung, Automationen,
      Anlagen-Modell, Profile — zero horizontal overflow.
- [ ] Real-data dress rehearsal passes: **every existing customer plant renders correctly in v3**
      (money headline, energy flow, nav groups) and **every existing automation still runs safely**
      (deployed artifacts unchanged, content hashes stable unless deliberately regenerated).
- [ ] **HARD GATE — the automation control path is proven end to end on the dress-rehearsal stack**
      (this is the safeguard the automation go-live rests on, so it is not optional and not a unit
      test): with `VOLTPILOT_FLOWS_ACTIVATION_ENABLED=true` and the profile's gated nodes enabled,
      **author a rule in the portal → validate → simulate → activate → flowc compiles the artifact →
      it is published retained on `ems/{t}/{s}/{d}/v2/flows` → the edge acks it in its heartbeat →
      the rule's desire reaches `vp-desired` → arbitration picks it → the guard chain CLAMPS it →
      the clamped command is observed on the entity's `…/command` topic.** Record the observed
      clamp (a desire beyond the rated band / §14a envelope / SoC window must come out reduced, not
      executed as wished). Also rehearse both stop levers: the flag flip and
      `POST …/flows/{flowId}/deactivate` on a live rule.
- [ ] Toggling a mode profile as a **customer** (M3) really opens that profile's gated nodes for
      that site and its starter flow activates — and toggling it off deactivates its flows again.
- [ ] `docs/contracts/v2/` amended where M5 requires it (decision-log entry + `flow-graph.md` §6),
      and the root `AGENTS.md` / `frontend/portal/AGENTS.md` carry the durable v3 notes.

---

## 8. OPEN questions for the owner (do not block on these)

| # | Question | Interim behaviour built |
|---|---|---|
| **O1 — safety, needs an owner answer** | Every profile is now a **direct customer toggle** (owner decision, M3). For **Marktoptimierung** that means a customer switch lets the optimizer trade on their behalf. **What real prerequisite must hold before trading actually starts, so a bare toggle cannot start UNCONTRACTED market participation?** | M3 builds the recommended reconciliation: the **toggle is intent**, and trading only runs when the technical prerequisite is present on the site (a `dynamisch` tariff and/or `plant_kind = direktvermarktung` / market access). Without it the profile switches on, states honestly what is still missing, and the market strategy does not dispatch. See the `OPEN — owner` callout in `M3-profile.md`. |
| O2 | Should the Fahrplan be a **base** nav item for a pure self-consumption plant with a battery (today it hangs under the market mode)? | M1 keeps it in the market mode group and reachable via the cockpit drill-in; the one-line change is noted in `M1-shell.md`. |
| O3 | Customer-side adoption ("Neues Gerät gefunden … jetzt zuordnen") currently needs the **admin** endpoint. Build the RLS-fenced customer twin, or keep adoption admin-first? | M6 builds the narrow customer twin (catalog-guarded, mirrors `SiteTopologyController`) and keeps the honest admin-only fallback message if it is not enabled. |
