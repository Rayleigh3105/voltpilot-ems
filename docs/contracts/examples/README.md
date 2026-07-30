# v1 contract fixtures

Executable examples for the FROZEN v1 contracts in the parent directory
(the v2 track keeps its own set in `../v2/examples/`).

Discipline, same as v2: at least **2 valid + 1 invalid** fixture per schema the
fixtures cover, and the fixtures are read by REAL test code - never decoration:

| Fixture prefix | Schema | Read by |
|---|---|---|
| `mqtt-schedule.*` | `../mqtt-schedule.schema.json` | `services/optimization/tests/test_contract.py` (jsonschema, both directions) and `edge-app/core/internal/plan/plan_test.go` (the Go executor parses the same bytes) |

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
