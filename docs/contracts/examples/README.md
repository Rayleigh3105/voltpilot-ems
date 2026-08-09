# v1 contract fixtures

Executable examples for the FROZEN v1 contracts in the parent directory
(the v2 track keeps its own set in `../v2/examples/`).

Discipline, same as v2: at least **2 valid + 1 invalid** fixture per schema the
fixtures cover, and the fixtures are read by REAL test code - never decoration:

| Fixture prefix | Schema | Read by |
|---|---|---|
| `mqtt-schedule.*` | `../mqtt-schedule.schema.json` | `services/optimization/tests/test_contract.py` (jsonschema, both directions) and `edge-app/core/internal/plan/plan_test.go` (the Go executor parses the same bytes) |
| `ota-release-manifest.*` | `../ota-release-manifest.schema.json` | `edge-app/core/internal/otaverify/verify_test.go` (`TestContractExamplesParseAsSpecified` - the REAL device-side parser reads the same bytes) |
| `mqtt-ota-target.*` | `../mqtt-ota-target.schema.json` | `edge-app/core/internal/agent/ota_target_test.go` (`TestContractExampleEnvelopeIsParsedAsSpecified` - the REAL device-side envelope parser reads the same bytes) |
| `mqtt-ota-apply.*` | `../mqtt-ota-apply.schema.json` | `edge-app/core/internal/agent/ota_apply_downlink_test.go` (`TestContractExampleApprovalIsParsedAsSpecified` - the REAL device-side approval parser reads the same bytes) |

Moving or renaming a fixture breaks those tests deliberately: the file path is
part of the contract check.

Why each `invalid.*` fixture is invalid (the fixtures themselves carry no
comment key - the schemas are `additionalProperties: false`, so a `_why` field
would make a fixture invalid for the wrong reason):

- `mqtt-schedule.invalid.surplus-only-not-boolean.json` -
  `charge_from_surplus_only` is a BOOLEAN duty flag, not a kW value. A number
  there would let a publisher smuggle a limit into a field whose only defined
  semantics is "clamp commanded charge to the measured surplus"; the schema
  rejects it so that ambiguity can never reach an edge.
- `mqtt-schedule.invalid.cover-load-not-boolean.json` - the same reason for the
  discharge-side mirror `cover_load_from_battery`: it is a BOOLEAN duty ("cover
  the MEASURED house load from the battery in this slot"), and the measured
  value it follows comes from the device, never from the payload. A number there
  would read like a cloud-supplied load setpoint - which is exactly the rigid
  forecast watt value this flag exists to stop being executed.
- `mqtt-schedule.invalid.export-limit-negative.json` - `grid_export_limit_kw` is
  a feed-in LIMIT at the grid connection point, so it is `minimum: 0`. A negative
  value has no defined meaning and would be read by a naive consumer as "cap the
  producers below zero", i.e. a command to CONSUME - the one thing a curtailment
  path must never be able to express. The edge parser rejects it independently
  (`plan.Parse` keeps only a finite, non-negative limit), so a bad payload leaves
  the site with NO limit and the honest state that says so, never a nonsensical
  one.
- `mqtt-schedule.invalid.absorb-surplus-not-boolean.json` - and once more for the
  charge-side counterpart `charge_surplus_to_battery`: it is a BOOLEAN duty
  ("raise the commanded charge to the MEASURED surplus in this slot"). A number
  there would read like a cloud-supplied charge setpoint - i.e. exactly the
  forecast-derived watt value whose blindness to the real surplus this flag
  exists to correct - and it would be the one place a payload could RAISE a
  charge past what the plan itself committed.
- `ota-release-manifest.invalid.tag-not-digest.json` - the artifact `ref` is a
  TAG (`:latest`) instead of a full `@sha256:` digest. A tag is not a pin: the
  whole at-rest/in-transit integrity of a release rests on the digest nailing
  down the bytes (a tampered layer then fails the pull itself). A manifest that
  says "run whatever `:latest` points at today" would be a signed statement
  about mutable content - the one thing the signature is supposed to prevent.
- `mqtt-ota-target.invalid.manifest-without-signature.json` - the envelope
  carries `manifest_b64` but no `signature_b64`. Bytes without their detached
  signature are a release that merely CALLS itself signed: the device would
  have nothing to verify them against, and the whole point of the downlink is
  that the box - not the cloud - decides whether to trust what it was handed.
  Both fields are therefore required together (the same all-or-nothing rule the
  register enforces in SQL, `edge_release_signed_pair`).
- `mqtt-ota-apply.invalid.no-token.json` - the one-shot approval carries no
  `token`. The token is what makes it ONE-shot: the sidecar remembers the last
  executed one in its own state, so the same approval can never trigger a second
  swap. Without it the message is an unbounded "apply whenever you see this" -
  and on a link that reconnects, that is the swap loop `failed.json` exists to
  stop. It is therefore required, not optional-with-a-default.
