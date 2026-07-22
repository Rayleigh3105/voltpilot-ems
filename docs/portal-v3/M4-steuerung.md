# M4 · Steuerung — two capsules, one "＋"

> Realizes report §4 **P4** · concept tab **5 · Steuerung**.
> Read [`BUILD.md`](./BUILD.md) §4 and §5 first.

## Goal

The Steuerung answers exactly one question — **"Was darf VoltPilot, und was habe ich selbst
geregelt?"** — with exactly **two capsules**:

1. **Modus-Profile** — compact rows: status dot, one-sentence state **with real numbers**
   ("+2,41 € heute"), switch; "Profile verwalten →" opens M3's shelf.
2. **Automationen** — rows with a live state ("Läuft · heute 3× geschaltet · zuletzt 14:02") and
   **ONE** button `＋ Neue Automation`, whose dialog offers the three ways in order:
   **Vorlage → geführter Baukasten → Node-RED-Editor**.

Below both, the narrow always-on protection line (§14a · Negativpreis-Abregelung · EEG: nur
Solarladen). Today's four-part structure (Aktive Modi → Ko-Optimierung → Automationen + Vorlagen →
Toolbox) collapses into these two; the active/offer mixing disappears (offers live in M3's shelf).

## Scope

**In**
- Rewrite `pages/SteuerungSection.tsx` to the two capsules + protection line.
- One entry point: a single `＋ Neue Automation` dialog (templates → guided builder → editor).
- **Template filtering by capability:** `customerTemplates.ts` gains a structured requirement, and
  the dialog **hides** non-fitting templates behind an honest one-liner ("2 weitere passen nicht zu
  Ihrer Anlage — trotzdem zeigen") instead of greying them out.

**Out**
- The editor itself (M5) — M4 only opens it.
- The profile shelf page (M3) — M4 links to it.
- Governance/gating semantics: unchanged, re-checked server-side.

## Files to change / create

| File | New? | What changes |
|---|---|---|
| `frontend/portal/src/pages/SteuerungSection.tsx` | edit (major) | Collapse the current four `section.vp-steuerung-part` blocks (Aktive Modi ~L363, Ko-Optimierung ~L395, Automationen ~L401, Modus hinzufügen ~L539, Automatisch aktiv ~L549) into **Kapsel 1 (Profile) + Kapsel 2 (Automationen) + protection line**. The co-optimisation reserve stack moves **into** the profile capsule as its footer line. |
| `frontend/portal/src/steuerungArea.ts` | edit | Keep `contributionRows`, `entityChips`, `modeActions`, `coOptimization`, `socReservationStack`. Replace `toolbox`/`requirementHint` usage here (the toolbox is M3's shelf now) and add **`automationRows(flows, nodeStatus?)`** — the per-rule live line ("Läuft · heute N× geschaltet · zuletzt HH:MM"; without node status: "Läuft" only, never a fabricated count). |
| `frontend/portal/src/flows/customerTemplates.ts` | edit | Add **`requiresRoles: TemplateRole[]`** (`'consumer' \| 'grid' \| 'storage' \| 'pv'`) next to the existing German `requires` prose (keep the prose — it is the honest reason line). `resolve()` stays the ground truth; `requiresRoles` drives the dialog's pre-filter so unfitting templates are hidden **before** a resolve attempt. |
| `frontend/portal/src/flows/templateFilter.ts` | **new** | Pure: `fitsPlant(template, entities/topology)`, `partition(templates, plant)` → `{fitting, notFitting, reason}`. Derives roles from the entity/topology model (`src/rollen.ts` / `src/topology.ts`), never from a hardcoded list. |
| `frontend/portal/src/components/NeueAutomationDialog.tsx` | **new** | The ONE creation dialog: fitting templates → `GuidedRuleBuilder` → "Node-RED-Editor" (opens `FlowEditorPage` via `customerFlowApi`). Hosts the "trotzdem zeigen" disclosure. |
| `frontend/portal/src/components/Steuerung.css` | edit | Two-capsule layout; component-local, `index.css` untouched. |
| `frontend/portal/src/components/OptimierungSection.tsx` | leave | Not rendered here any more (already true since M2/Projektion); the file stays for other consumers. |

## Acceptance criteria

1. The Steuerung page has exactly **two** capsules plus the protection line — no "Für Ihre Anlage"
   mixed active/offer surface, no second door into the builder.
2. There is exactly **one** `＋ Neue Automation` button on the page; its dialog offers template →
   guided builder → editor in that order.
3. Templates that the plant cannot run are **hidden by default** with a counted, honest reason line,
   and revealable on demand. A hidden template's reason names what is missing.
4. Each profile row states its contribution with a real number and its period, or "—" when
   unattributable (automations, E15) — never a fabricated 0.
5. "Profile verwalten →" navigates to M3's shelf. Every profile row is a real on/off switch (there
   is no "Angefragt" state); a profile that is on but cannot fully run yet shows M3's honest
   `blockedReason` sentence instead of a request prompt.
6. The reserve stack renders only from **two** battery-claiming modes, in the canonical order
   technisch → Notstrom → Lastspitze → frei, absolute (highest binds).
7. Gated strategy nodes are still shown-but-locked with `EINRICHTUNG_DURCH_VOLTPILOT`; nothing here
   enables a gate.

## Tests to add / adjust

- `src/flows/templateFilter.test.ts` (**new**): a wallbox-less plant hides the wallbox template with
  the right reason; a plant with wallbox + grid meter shows both; role derivation from entities.
- `src/flows/customerTemplates.test.ts` — extend: every template declares `requiresRoles`, and
  `requiresRoles` is consistent with what `resolve()` actually needs (a template that resolves must
  have been classified as fitting).
- `src/steuerungArea.test.ts` — `automationRows` incl. the no-node-status fallback (no invented count).
- `src/pages/SteuerungSection.test.tsx` — two capsules render; exactly one "＋" button; the dialog
  opens and lists only fitting templates; the protection line is present.

## Dependencies

**M3** (profile state + shelf link) and **M1** (nav). Integrates **M5**'s editor as the dialog's
third way — build M4 against the existing `FlowEditorPage`, then re-point at M5's editor when it lands.

## Gotchas

- `SteuerungSection.tsx` is ~560 lines and hosts the guided builder, the templates and the editor
  entry. Move logic **out** into pure modules while collapsing — do not just delete sections.
- Keep the `.catch`-ed optional fetches: only the flow list is load-bearing; `usageProfile`,
  `earnings`, `entityStrategies` and the admin-only optimizer config must stay fail-soft (a
  customer gets 403 on the optimizer config — that is expected, not an error state).
- Do **not** repurpose the existing German `requires` string as the machine field; add
  `requiresRoles` alongside it. Both `customerTemplates.test.ts` and the dialog copy depend on the prose.
- The templates are built through `buildGuidedFlow` and are golden round-trip cases — changing a
  template's shape changes those tests and possibly a flowc pinned hash. Only change shapes deliberately.
- `Number('') === 0` bit this code before: any numeric input in the dialog must reject empty strings
  (`parseNum`), and `buildGuidedFlow` needs `siteId` or the emitted doc fails client validation.
