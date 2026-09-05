# Anlagen-Topologie-Read-Model (AE1, edge half)

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 14).


`internal/topology` is the CANONICAL copy of the shared derivation (Go↔TS↔Java,
pinned to `docs/contracts/v2/topology-vectors.json`; contract
`docs/contracts/v2/topology-read-model.md`; full rules in the root AGENTS.md
"Anlagen-Topologie-Read-Model (AE1)" section). `Agent.Topology()`
(`internal/agent/entities.go`) builds it from the applied entity registry +
latest per-entity readings via `topology.Resolve` (default roles, first-of-role
= maßgeblich) → `topology.Derive`, and `web.Handler`'s `TopologyController`
carries it as an ADDITIVE `topology` block on `/api/state` + `/api/stream`. The
scalar `pv_kw`/`load_kw`/`grid_limit_kw`/`soc_pct` fields stay; a registry-less
device yields an empty topology (byte-for-byte v1).
`entities.Entity.Category()` is the exported category for default role
resolution. Tests: `internal/topology/topology_test.go`, `internal/web`
`TestStateEnvelopeCarriesTopology`.

**⚠ Seit Befund L4 gewinnt die im PORTAL gespeicherte Zuordnung gegen den
Default.** Sie reist als additiver `role_assignment`-Block je Descriptor
(`entities.Entity.RoleAssignment`, JE KANAL ein Eintrag) und wird von
`Agent.Topology()` an `topology.RawChannel.Assigned` durchgereicht; `Resolve`
zieht sie dem `DefaultRole` vor. Drei Regeln, alle mutationsgeprüft:

- **Die Vorgabe-Regel für „maßgeblich" ist WÖRTLICH die der Cloud**
  (`TopologyService.topology`): der Default-Primary geht nur an Rollen, für die
  NIEMAND ausdrücklich maßgeblich gesetzt wurde — deshalb sammelt `Resolve` die
  ausdrücklichen Wahlen in einem ERSTEN Durchlauf über die ganze Anlage. Ohne
  diese Zwei-Pass-Form nimmt die erste Kapazität die Marke im Vorbeigehen mit
  und die Box behauptet einen anderen maßgeblichen Zähler als das Portal.
  **Beide Schleifen zusammen ändern.**
- **Ein unbekanntes Rollenwort fällt STILL auf den Default zurück**
  (`topology.IsKnownRole`, die EINE Stelle) — nie eine Ablehnung des Pushes: eine
  Rolle ist Anzeige, kein Steuerweg, und eine neuere Cloud darf den Energiefluss
  einer älteren Box nicht zerreißen.
- **`componentapply.Derive` liest den Block NIE.** `inverter.json`/`sources.json`
  leiten ihre Rolle weiterhin aus dem Entitätstyp ab, also ergibt ein reiner
  Rollen-Push `SameAs` = unverändert: keine Datei geschrieben, nichts neu
  veröffentlicht (`TestARoleAssignmentNeverTouchesTheDerivedPlan`).

Tests dazu: `internal/topology/topology_test.go`,
`internal/entities/entities_test.go` (die Kontrakt-Fixture
`edge-entity.valid.registry-push-roles.json` PER PFAD),
`internal/agent/entities_roles_test.go` (Push-Bytes → `Topology()`).

