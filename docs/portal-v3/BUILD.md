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
| **M3** | [`M3-profile.md`](./M3-profile.md) | 4 · Modus-Profile | P3 — `site_profile_state` + `GET/PUT /sites/{id}/profiles` + surface overlay + customer `autoStart` | medium (the one backend piece) |
| **M4** | [`M4-steuerung.md`](./M4-steuerung.md) | 5 · Steuerung | P4 — two capsules, ONE "＋", template filter `requires:[role]` | small |
| **M5** | [`M5-automationen.md`](./M5-automationen.md) | 6 · Automationen | P5 — drag + persisted positions, live values, deployed-version view, `vp.logic.function`, phone step list, edge node-status | **large** |
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
| M3 → M4 | The Steuerung profile capsule renders the persisted state (`an` / `aus` / `angefragt`); without M3 it can only show derived modes. |
| M4 → M5 (integration) | The single "＋ Neue Automation" dialog is M5's entry point. M5's canvas/compiler work is independent and **may start right after M1** on its own track; only the wiring waits for M4. |
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
9. **Never widen a server gate in the UI.** Flow governance, peak-shaving gates, RLS and role
   checks are re-checked server-side. A UI state like "Angefragt" is *UX over* the gate, never a
   bypass.
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

- **One long-lived feature branch: `feat/portal-v3`.** Every milestone lands as its own PR **into
  that branch**, never into `main`. `main` and prod stay deployable throughout.
- **Per-milestone gate (before merging into `feat/portal-v3`):** the milestone file's acceptance
  criteria + `npm run build` (`tsc && vite build`) + `npm test` (vitest) green, and — for milestones
  touching the api or flowc — `./mvnw test` in `services/api` and `node --test` in
  `edge-app/nodered/flowc` green.
- **Real-data dress rehearsal before the release.** Restore the real production dump
  `data/vp-deploy-readiness/prod.dump` into a **throwaway** `timescale/timescaledb:2.17.2-pg16`
  container (own network, own ports, destroyed afterwards) and run the v3 api + portal against it.
  The step-by-step recipe is `data/vp-prod-dryrun/report.md` ("Reproduce / evidence" plus
  `data/vp-deploy-readiness/report.md` §8). Two facts from that run that the rehearsal must re-check:
  the cluster roles `voltpilot_app` / `voltpilot_admin` are **not** in the dump and must be created
  by hand before the api can connect; and every real plant must still render its money headline and
  its energy flow correctly in v3.
- **One release.** `feat/portal-v3` → `main` as a single reviewed PR; the owner deploys via the
  `deploy-fast` workflow (`.forgejo/workflows/deploy-fast.yaml`) or the full `deploy.yaml` gate.
- **Rollback stance.** Portal + api roll back by redeploying the previous image tag (`IMAGE_TAG` is
  the commit SHA). The only forward-only pieces are the additive migrations (M3 `site_profile_state`,
  M5 flow layout + node status): all are **additive tables/columns**, so the previous image ignores
  them and keeps working — never a destructive DDL, never an edit of an applied migration. The M5
  edge heartbeat block is additive and feature-flagged; old edges simply do not send it and the
  editor falls back to channel values.

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
- [ ] `docs/contracts/v2/` amended where M5 requires it (decision-log entry + `flow-graph.md` §6),
      and the root `AGENTS.md` / `frontend/portal/AGENTS.md` carry the durable v3 notes.

---

## 8. OPEN questions for the owner (do not block on these)

| # | Question | Interim behaviour built |
|---|---|---|
| O1 | Where does an "Angefragt" profile request go — e-mail to VoltPilot, or an admin task list? | M3 persists the state and logs it; the customer sees "Angefragt — VoltPilot richtet ein". No outbound channel is wired. |
| O2 | Should the Fahrplan be a **base** nav item for a pure self-consumption plant with a battery (today it hangs under the market mode)? | M1 keeps it in the market mode group and reachable via the cockpit drill-in; the one-line change is noted in `M1-shell.md`. |
| O3 | Customer-side adoption ("Neues Gerät gefunden … jetzt zuordnen") currently needs the **admin** endpoint. Build the RLS-fenced customer twin, or keep adoption admin-first? | M6 builds the narrow customer twin (catalog-guarded, mirrors `SiteTopologyController`) and keeps the honest admin-only fallback message if it is not enabled. |
