# Edge Entity Config / Telemetry / Command + Registry Push (v2, E1a)

**Status: BINDING (v2 track). Schema: [`edge-entity.schema.json`](./edge-entity.schema.json).
Examples: [`examples/`](./examples/).**

This contract authors the E1a half of the v2 entity topic family whose skeleton
[edge-desired-arbitration.md §1](./edge-desired-arbitration.md) defined (desired + arbitration
stay there): the retained per-entity **config**, the local per-entity **telemetry**, the
core-owned retained **command**, and the cloud → edge **entity-registry push** that transports
the config set. It is a brand-new contract and starts at `schema_version` **1.0**
(coexistence philosophy #4).

## 1. The registry push: `ems/{t}/{s}/{d}/v2/entities` (retained)

The cloud entity registry (the `measurement_point` rows carrying `entity_type` /
`capabilities` / `guard_config`) is the **owner**; the edge receives it as ONE retained message
per device — the proven `edge/inverter/config` / `edge/sources/config` pattern lifted onto the
cloud link (plan §2.1 "Stammdaten-Sync": Cloud ist Soll, Edge meldet Ist). `$defs/registry_push`:
identity + `revision` + `published_at` + the full `entities` descriptor array.

- **Full-set semantics.** The edge diffs the pushed set against its persisted one
  (`entities.json`, the plan-store pattern): new/changed descriptors are (re)published as
  per-entity retained local configs; entities missing from the push get their retained
  `config` AND `command` cleared (empty retained payload — the provisioning `clearRetained`
  precedent). An empty `entities` array = the device has no v2 entities. An empty PAYLOAD
  clears the retained slot outright (device unclaimed).
- **Soll down, Ist up (bidirectional since E1b).** The push stays the one-way Soll (cloud →
  edge); the edge reports its Ist back through the additive status-heartbeat `entities` block
  (§5): the applied `revision` plus per-entity observed health AND the edge-local
  commissioning view (`:8484` inverter/sources — which keeps working unchanged). The cloud
  RECONCILES and surfaces drift; it never silently overwrites in either direction.
- Publishing is **best-effort** on registry change (the on-claim provisioning-publish posture:
  a broker outage never fails the registry write); retained delivery makes the next
  (re)connect converge.

## 2. Per-entity retained config: `edge/entities/{id}/config`

`$defs/config` — the registry descriptor per entity (D-3: per-entity topics, wildcard
`edge/entities/+/config` gives any consumer the complete set on subscribe). Contents:

- **`entity_type`** — an OPEN kebab-case vocabulary since E1b (D-10: capabilities as the
  foundation, domain types on top). The data-driven platform type CATALOG
  (`services/api` `entitytypes/catalog.json`) is the truth for known types — today
  `battery-hybrid` | `producer` | `grid-meter` (the pilots) plus the E1b consumer types
  `wallbox` | `heating-rod` | `generic-load`; adding a type is catalog data + an optional
  driver, never a schema release. Consumers of this contract key BEHAVIOR on the declared
  capabilities and guards, never on the type string alone (an unknown well-formed type is
  data, not an error).
- **`capabilities`** — `measure` channel descriptors + `actuate` command descriptors from the
  D-14 vocabulary (`setpoint_kw`, `on_off`, `limit_pct`, `limit_kw`, `mode`) with optional
  bounds. A measure-only entity (grid meter) has no `actuate` list. Generators are never
  commanded to produce — `limit_*` reduce-only (the v1 safety posture). Consumers are only
  ever commanded to CONSUME (`setpoint_kw` + = consume, clamped ≥ 0 — V2G out of scope).
- **`guards`** — per D-9 the guard limits AND the failsafe live HERE, in registry config, never
  in plans: `limits` (rated charge/discharge band, SoC window, `charge_from_grid_allowed` with
  the D-8 absent-=-NOT-allowed reading, producer `max_generation_kw`, consumer
  `max_consumption_kw` — E1b, additive) and
  `failsafe.behavior` (`self-consumption` | `off` | `release` | `measure-only`) — what the
  entity falls back to when nothing commands it (no desired, stale plan). The core builds its
  per-entity guard chain instance from this block — the generalization of the v1 env-derived
  `guards.Limits`.
- **`driver`** — OPTIONAL opaque connection block (the v1 sources `busEntry` shape) for later
  Layer-1 self-wiring; E1a carries it through verbatim.
- **`flex_requirements`** — OPTIONAL + ADDITIVE (Verbrauchssteuerung Inkrement 6, D-20): the
  consumer's ACTIVE `required_by_deadline` duties (`$defs/flex_requirement`) for the edge-local
  deadline fallback — recurrence window + timezone (wall-clock, DST-correct, E7), the demand
  (`runtime_minutes` and/or `energy_kwh`, `contiguous`), and the CLOUD-resolved run `power_kw` +
  D-14 `command` (`on_off` | `setpoint_kw`). Composed from the ACTIVE `consumer_policy` +
  `consumer_profile` at push time — resolving targets/power stays a cloud truth, the edge never
  re-derives policy semantics. The fallback starts the task itself at the latest at
  `deadline − remaining need − margin`, ONLY while no fresh v2 plan lies, only from CONFIRMED
  own progress, through the NORMAL desired → arbitration → guard chain (internal class
  `deadline-fallback`, never `override`). Absent/empty = no fallback; price-conditioned,
  opportunistic and reactive requirements are never pushed here.

## 3. Local per-entity telemetry: `edge/entities/{id}/telemetry`

`$defs/telemetry` — Layer 1 → core, QoS1, not retained: `{schema_version, entity_id, ts?,
channels}`. Successor of `edge/sources/{id}/telemetry` with the same error-isolation property
(a dead entity is absent, never a fabricated 0). The topic==payload identity rule applies; the
core ignores mismatches. The core keeps the latest reading per entity (feeding the per-entity
guard chain with SoC/PV context) and forwards accepted readings to the cloud uplink
([mqtt-telemetry-2.0](./mqtt-telemetry-2.0.md)).

## 4. Core-owned retained command: `edge/entities/{id}/command`

`$defs/command` — published ONLY by the core, after arbitration + guards (D-10 ownership; in
E1a the arbitration is stubbed — the plan executor and desired arbitration land with E2/E3, but
whatever commands an entity already flows through the per-entity guard clamp). Shape mirrors
today's `edge/setpoint` fields generalized: `control_enabled` (the v1 two-gate posture per
entity), `source` (`plan` | `desired` | `failsafe`), and `commands` keyed by the D-14
vocabulary. An absent `limit_kw`/`limit_pct` means NO limit and MUST clear a previously applied
one (the 1.0 `pv_limit_kw` clearing rule). Retained; an empty payload clears the slot
(nothing commanded — the entity runs its registry failsafe).

The per-entity **readback** (`edge/entities/{id}/readback`, Layer 1 → core) keeps the v1
`edge/control/readback` payload shape verbatim (documented in
`edge-app/core/internal/localbus/localbus.go`), addressed per entity; it is not re-schematized
here — E2 formalizes it together with arbitration events.

## 5. Status-heartbeat `entities` block (additive)

The edge folds an additive block into its status heartbeat (no frozen schema on `…/status` —
the v1 `control`/`purge_request` precedent, `schema_version` stays "1.0"):

```json
"entities": { "revision": "<applied registry revision>", "applied_at": "<RFC3339>",
              "count": 3, "ids": ["…", "…", "…"] }
```

Since E1b the block additionally carries the per-entity **Ist** (all additive; absent fields
mean "nothing to report", never fabricated):

```json
"entities": {
  "revision": "…", "applied_at": "…", "count": 2, "ids": ["…", "…"],
  "observed": {
    "<entity_id>": { "entity_type": "wallbox", "health": "ok",
                     "last_telemetry_at": "<RFC3339>", "channels": ["power_kw"] }
  },
  "local_setup": [
    { "id": "inverter", "kind": "inverter", "brand": "deye", "model": "SUN-12K-SG04LP3-EU",
      "family": "hybrid_3p", "communication": "solarman_v5",
      "connection": { "ip": "192.168.0.28", "port": 8899, "serial": "2985159064",
                      "mb_slave_id": 1, "power_scale": 10 } },
    { "id": "<source id>", "kind": "source", "role": "pv-generation", "brand": "fronius_sunspec",
      "family": "sunspec_live", "communication": "fronius_sunspec",
      "connection": { "ip": "192.168.0.31", "port": 502, "unit_id": 1 },
      "interval_s": 5, "capacity_kwp": 27 }
  ]
}
```

- **`observed`** — per applied entity: the type as applied, `health` (`ok` = local telemetry
  within the 5-min liveness window | `stale` = had readings, none recently | `never` = none
  since boot) and the channels actually seen. This is the edge's honest Ist per entity.
- **`local_setup`** — the edge-authoritative commissioning view (`:8484` inverter selection +
  sources), reported verbatim so the cloud can SEE edge-side master data that has no registry
  counterpart.

### 5.1 `local_setup` connection fields (Einheitsmodell Stufe 2, ADDITIVE)

Until Stufe 2 an entry named WHAT a device is but never HOW it is reached, so the cloud could
show the box's commissioning Ist but not adopt it: a takeover derived from an incomplete Ist
would have had to GUESS the address of a live plant's read path. The additive fields below are
exactly the ones `sources.Source` / `inverter.Selection` persist:

| Feld | gilt für | Bedeutung |
|---|---|---|
| `family` | beide | Register-Karte, mit der die Box liest (die Entscheidung ihres EIGENEN Katalogs) |
| `communication` | beide | Transport (`solarman_v5`, `modbus_tcp`, `fronius_sunspec`, …) — Teil der Quellen-Identität |
| `connection` | beide | die Transportfelder VERBATIM (ein `inverter.Connection`-Objekt) |
| `interval_s` | Quelle | Lese-Kadenz |
| `capacity_kwp` | Quelle | Nennleistung — weitet die physikalische Plausibilitäts-Hülle |
| `registry_unit_id` | Quelle | die MaStR-Referenz des Betreibers |

**Die Ehrlichkeitsregel, an der die ganze Übernahme hängt: ein Eintrag OHNE `connection` heißt
„diese Box meldet noch keine Verbindungen" — NIE „dieses Gerät hat keine".** Ein älterer
Box-Stand lässt die Felder weg; die Cloud darf daraus nur „Übernahme noch nicht möglich"
folgern und muss die Anlage box-verwaltet lassen. Umgekehrt ignoriert ein älterer Cloud-Stand
die Felder, und die Box verhält sich zeichengleich wie vorher.

**Warum die Felder EXAKT so reisen müssen:** der Applier baut aus dem zurückgeschriebenen Push
wieder eine `sources.Source`/`inverter.Selection` und vergleicht sie mit `SameAs` — einer
STRUKTURGLEICHHEIT über alle Felder. Fehlte eines (die Kadenz, die kWp, die Registernummer),
wäre die Übernahme kein No-op mehr, sondern eine stille Verschlechterung der laufenden Anlage.

The cloud reconciles the block as drift by default; the automatic takeover of a box-managed
plant (Stufe 2) is the ONE path that turns it into a Soll, and only when it is complete.

### 5.2 Geräte, die ihren EIGENEN Leseplan mitbringen (`communication` als Marke)

Zwei `communication`-Werte sind KEIN Transport, den die Box selbst fahren soll — sie sind die
Marke „dieses Gerät wird von seinem eigenen generierten Flow gelesen":

| `communication` | Entitätstyp | Woher der Leseplan kommt |
|---|---|---|
| `modbus_baukasten` | `modbus-generic` / `modbus-load` | ein generierter Flow mit je Kanal einem `vp.modbus.read` (Einheitsmodell Stufe 3/4) |
| `mqtt_local` | `user-defined-battery` | ein generierter Flow mit GENAU EINEM `vp.mqtt.read`, der die ganze Feld-Zuordnung trägt (P5 Ebene 1, `vp-deye-diybms-luecke-l5` §3.2b) — seit P5b zusätzlich EIN `vp.soc.derive` dahinter, wenn die Batterie einen Ladestand hat |
| `http_local` | `user-defined-battery` | dasselbe über eine HTTP/JSON-Auskunft im Heimnetz: EIN `vp.http.read` mit den Wertepfaden (P5-HTTP), dahinter derselbe `vp.soc.derive`. ⚠ EINZIGER Fall, in dem der `driver.connection`-Block der Box wirklich etwas liefert, das sie braucht: `auth_secret`, das Geheimnis des Endpunkts. Es reist NUR hier — nie im Flow-Dokument, das über die Portal-API lesbar ist. |

Der Applier der Box ÜBERSPRINGT beide, bevor er nach einer Marke fragt
(`componentapply.isSelfRead`) — und dieser Sprung ist tragend, nicht kosmetisch: `Derive` ist
alles-oder-nichts, und so ein Gerät trägt konstruktionsbedingt keine Marke. Ohne den Sprung
verlöre eine Anlage mit ihrem ERSTEN eigenen Gerät die Anwendung ihres Wechselrichters und
aller Quellen.

**⚠ Daraus folgt eine ROLLOUT-Reihenfolge**: eine Box, die einen dieser Werte noch nicht kennt,
lehnt den Treiber ab und lässt den GANZEN Push fallen. Ein neuer Wert gehört deshalb auf die
Box, BEVOR die Cloud das erste solche Gerät auf einer Anlage anlegt.

`driver.connection` trägt bei beiden die gespeicherte Definition VERBATIM (bei `mqtt_local`:
`broker` + `mappings` + optional `soc_derivation` + seit P6 `binding`); sie ist Anzeige und
Zusammenhang, nie der Lesepfad. **Der Lesepfad reist im Flow.**

⚠ **`binding` ist für die Box eine ANGABE, keine Anweisung** (P6 Speiser-Bindung,
Captain-Entscheid E6): sie sagt, wozu diese Batterie in der Anlage gehört
(`unbound` | `feeds_inverter` + `inverter_entity_id` | `standalone`). Was die Box daraus
WIRKLICH zeichnet, kommt wie bei jeder anderen Zuordnung aus dem additiven
`role_assignment`-Block desselben Descriptors (Befund L4) — die Cloud materialisiert die
Bindung dorthin, damit `:8484` und das Portal denselben Energiefluss zeigen. Eine Box, die
`binding` nicht kennt, ÜBERLIEST es und bleibt trotzdem richtig; eine zweite Auswertung hier
wäre eine zweite Wahrheit über denselben Speicher-Knoten. Ohne Bindung bekommt eine
`user-defined-battery` GAR KEINE Rolle: ihr Typ ist seit P6 in `topology.IsSelfBuiltType`.

### 5.3 Der ABGELEITETE Ladestand und seine HERKUNFT (P5b Ebene 2, ADDITIV)

Eine selbst angebundene Batterie meldet ihren Ladestand seit P5b als ganz normale Telemetrie
(§3) — aber in EINER Nachricht mit zwei Kanälen:

| Kanal | Bedeutung |
|---|---|
| `soc_pct` | der Ladestand, übernommen (`direct`), aus der Spannungskennlinie gerechnet (`ocv_curve`) oder aus der Ladung gezählt (`coulomb`) |
| `soc_source_code` | die HERKUNFT genau dieses Wertes: `1` = gemessen · `2` = berechnet:kennlinie · `3` = berechnet:ladungszählung |

**Warum ein CODE und kein Wort:** die Kanäle sind per Vertrag ZAHLEN
(`$defs/channels`, `telemetry_v2.value` ist `DOUBLE PRECISION`). Ein Wort hätte einen Umbau der
ganzen Ingest-Kette gebraucht; der Code reist durch die BEWIESENE Kette unverändert und steht
JE MESSZEITPUNKT in der Historie — eine später geänderte Definition fälscht keine alte Zeile.

**Es gibt bewusst keine `0` für „unbekannt".** Ein unbekannter Ladestand ist ein ABWESENDER
Kanal, nie eine gemeldete Null — und ein eingefrorener Wert wird nie mit einem frischen
Zeitstempel erneut gesendet, er altert. Nach der Haltefrist (`hold_s`, Vorgabe 900 s) ist er
abwesend, und eine Ladungszählung braucht einen neuen Anker.

`soc_source_code` ist der EINZIGE Kanal des Typs, den niemand ZUORDNEN darf: kein BMS der Welt
veröffentlicht ihn, und ihn zuzuordnen hieße, eine Rechnung als Messung auszugeben.

⚠ Bei der Methode `direct` trägt `soc_pct` in derselben Sekunde ZWEIMAL denselben Wert: einmal
als rohe Messung aus der Ebene 1 und einmal aus der Ableitung, die ihn ÜBERNIMMT. Der zweite
Wert reist deshalb VERBATIM — weder gerundet noch geklemmt: zwei verschiedene Zahlen für
denselben Ladestand in derselben Sekunde wären eine Wahrheit, die an der Zustellreihenfolge
hinge. Gerundet und geklemmt wird ausschließlich, was die Ableitung SELBST gerechnet hat.

⚠ Ein älterer Cloud-Stand überliest den Kanal (er ist eine Zahl wie jede andere), eine ältere
Box erzeugt ihn nicht — beides ist der additive Normalfall.


The cloud compares `revision` against the latest push and the `observed` map against the
registry Soll (api `EntityStatusListener` → `entity_observed_state`); drift is surfaced in the
portal, never silently resolved.

## 6. Coexistence

A v2 edge build runs the v1 topics (`edge/telemetry`, `edge/setpoint`, `edge/sources/…`) and
this family side by side (E1a/E13a shadow phase); nothing in the v1 local namespace changes.
Entities exist on a device only after a registry push; a device without one behaves
byte-for-byte v1.
