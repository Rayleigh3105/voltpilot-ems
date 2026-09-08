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
| `mqtt-probe.*` | `../mqtt-probe.schema.json` | `edge-app/core/internal/probe/probe_test.go` (`TestContractExamplesAreParsedAsSpecified` - the REAL device-side probe parser reads the same bytes, incl. the `switch_test`/`switch_cancel` ops of the release assistant and the `switched` result block) |
| `mqtt-register-write.*` | `../mqtt-register-write.schema.json` | `services/api/src/test/java/com/voltpilot/api/registerwrite/RegisterWritePublisherTest.java` (the REAL cloud-side envelope builder is compared BYTE-FOR-FIELD against the request fixtures) and `.../RegisterWriteResultListenerTest.java` (the REAL cloud-side result parser reads the result fixtures); the device-side parser reads the same bytes in `edge-app/core/internal/registerwrite` |

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
- `mqtt-schedule.invalid.limit-discharge-not-boolean.json` - and once more for the
  REDUCE-only right `limit_discharge_to_load`: it is a BOOLEAN permission ("you may
  limit the commanded discharge to the MEASURED deficit in this slot"), never a kW
  bound. A number there would read like a cloud-supplied discharge cap - i.e. a
  SECOND setpoint next to `battery_setpoint_kw`, which the plan already carries -
  and it would let a payload dictate a value the flag exists to take from the
  MEASUREMENT instead of from the forecast.
- `ota-release-manifest.invalid.tag-not-digest.json` - the artifact `ref` is a
  TAG (`:latest`) instead of a full `@sha256:` digest. A tag is not a pin: the
  whole at-rest/in-transit integrity of a release rests on the digest nailing
  down the bytes (a tampered layer then fails the pull itself). A manifest that
  says "run whatever `:latest` points at today" would be a signed statement
  about mutable content - the one thing the signature is supposed to prevent.
- `mqtt-register-write.valid.entity-coil.json` - die Komponenten-Lane mit einer
  Spule (Stufe 2): die Cloud nennt NUR die `entity_id`, den Endpunkt loest die
  Box aus ihrer eigenen angewandten Definition auf.
- `mqtt-register-write.valid.lan-preview.json` - die freie LAN-Lane als
  VORSCHAU (Stufe 2): der Endpunkt reist, weil es keinen anderen Weg gibt ihn zu
  nennen - und genau deshalb prueft die Box ihn selbst.
- `mqtt-register-write.invalid.write-without-confirm.json` - `mode: "schreiben"`
  without the `confirm` token. The two-stage rule is the whole protocol of this
  channel: a preview reads, and only an envelope that names REGISTER AND VALUE
  again may write. Without it a request that merely LOOKS like a preview (a
  replayed body, a client that forgot which stage it was in) would burn an EEPROM
  write cycle on a customer's inverter - so the schema refuses it before any box
  ever sees it, and the box's own `Admit` refuses it a second time.
- `mqtt-ota-target.invalid.manifest-without-signature.json` - the envelope
  carries `manifest_b64` but no `signature_b64`. Bytes without their detached
  signature are a release that merely CALLS itself signed: the device would
  have nothing to verify them against, and the whole point of the downlink is
  that the box - not the cloud - decides whether to trust what it was handed.
  Both fields are therefore required together (the same all-or-nothing rule the
  register enforces in SQL, `edge_release_signed_pair`).
- `mqtt-control-certification.invalid.model-missing.json` - a register entry
  without `model`. The register key is deliberately the MODEL, not the register
  family: a family covers several product lines (`hybrid_3p` means the LV
  SG04LP3 *and* the HV SG01HP3), while a bench run covers exactly one. An entry
  that names only brand + family would silently extend one device's proof to
  untested siblings - the very over-reach the per-model key exists to avoid, and
  the one the fleet-wide env allowlist still has. Both `valid` fixtures show the
  two halves that must BOTH hold before anything is granted: a covered model and
  an explicitly activated plant (`activated`).
- `mqtt-probe.invalid.read-without-data-type.json` - a `read` op with no
  `data_type`. The register COUNT of a generic read is derived from the data
  type (1 word for u16/s16, 2 for u32/s32/float32) - there is deliberately no
  free quantity field, so without the type the box would have to guess how many
  words to fetch. Guessing wrong on a 32-bit register does not fail loudly: it
  returns half a number that looks perfectly plausible, which is exactly the
  class of error the live preview exists to make visible. The two valid request
  fixtures show the op types the contract knows - `read`, plus the
  `switch_test`/`switch_cancel` pair of the release assistant (Stufe 4), which
  a box EXECUTES bounded: it arms its automatic off BEFORE it writes, and the
  cancel restates the register in full instead of relying on a remembered state.
  `mqtt-probe.invalid.switch-test-without-ttl.json` is a test without `ttl_s` -
  an unbounded write to a customer device, which is exactly what the op may
  never be. `mqtt-probe.valid.result.json` shows the answer's honesty rule in
  one document: a successful line carries raw AND decoded value side by side, a
  failed one carries a named class and NO value; a switch answer carries its own
  `switched` block instead, because a switch result is not a measurement.
  `mqtt-probe.valid.test-connection-implausible.json` is the one deliberate
  exception, and it is the live Muehlfeldweg-2 case (21.08.2026): the box really
  READ the device, three channels decoded fine, and only the SoC violated the
  plausibility rule - so the refusal carries the `reading` it got plus a
  `finding` naming the channel, the rule (`missing` = a live register block whose
  SoC is an exact 0, i.e. a battery whose BMS is not coupled) and the raw/decoded
  value. `raw`/`value` at the LINE level stay absent, because those belong to a
  register read; what is added is evidence that was measured, never invented -
  a bare "unplausibel" with not a single number is a riddle, and a real new
  plant got stuck on it.

## `mqtt-charging-config` (Lastmanagement Stufe 3)

Die Lastmanagement-Konfiguration, die das Portal an die Box schickt. Die zwei
gültigen Fixtures zeigen die PATCH-Semantik, die den Vertrag trägt: das erste
setzt Anschlussgrenze UND Vorrang, das zweite nennt NUR eine leere Vorrang-Liste
— eine leere Liste ist eine AUSSAGE („keine Säule hat Vorrang") und wird
angewandt, während die abwesende Anschlussgrenze bedeutet, dass die Box ihre
eigene Zahl behält. `mqtt-charging-config.invalid.grenze-null.json` ist eine
Grenze von 0: ohne Grenze ist das Budget der Box 0 und es lädt nichts, also wäre
das eine Aussage, die niemand treffen wollte — abwesend heißt „dazu sagt das
Portal nichts", nie „keine Grenze".

Seit Stufe 4 trägt dasselbe Dokument additiv die zwei QUELLEN-Wahlen des Kunden
(`mqtt-charging-config.valid.ueberschuss-prioritaet.json`): sie sagen, WOHER der
Ladestrom kommen soll, und ändern keine einzige Grenze — die niedrigere der
beiden Bahnen gewinnt, und keine kann die andere aufweichen. Auch hier ist
abwesend ≠ `schnell`: das eine heißt „das Portal äußert sich nicht", das andere
ist die eigene Aussage „keine Quellen-Politik".

Seit dem Anbinde-Assistenten trägt es zusätzlich die ALLOWLIST
(`mqtt-charging-config.valid.saeulen-eintragen.json`): die Kennungen, unter denen
die Box eine Säule überhaupt annimmt. Ihre PATCH-Regel ist SCHÄRFER als die der
Vorrang-Liste — abwesend UND leer heißen hier dasselbe, denn diese Liste fügt nur
hinzu: die Box übernimmt jeden Eintrag, den sie noch nicht kennt, überschreibt
keinen bestehenden und ENTFERNT nie einen. Die zweite Zeile der Fixture nennt nur
ihre `id` — alles Weitere ist das, was der Betreiber zufällig schon weiß.

Seit dem 24.08.2026 kann das Portal eine Kennung auch wieder LÖSCHEN
(`mqtt-charging-config.valid.saeule-entfernen.json`), und weil `charge_points`
nur hinzufügt, braucht das ein EIGENES Feld: `removed_charge_point_ids`. Eine
Kennung dort wegzulassen ist kein Löschen — nur diese Liste ist eines. Sie ist
eine GRABSTEIN-Liste und reist in JEDEM folgenden Dokument mit: das retained
Dokument wird als Ganzes ersetzt, also hätte eine nur einmal genannte Löschung
eine gerade offline gewesene Box nie erreicht. Eine ältere Box überliest das Feld
und behält die Kennung — der Vorzustand, nie eine falsche Handlung. Die Fixture
zeigt beides nebeneinander: `saeule-hof-nord` bleibt zugelassen, `saeule-halle`
wird entfernt, und keine Kennung steht je in beiden Listen.

Seit Verbrauchsmanagement v1 (P5) traegt dasselbe Dokument die STEUERART je
Saeule und den Ladepark-RAHMEN (`mqtt-charging-config.valid.steuerart-je-saeule.json`):
`charge_points[].source` sagt, WOHER der Ladestrom DIESER Saeule kommen soll —
der site-weite `surplus_policy` bleibt daneben der Anlagen-Standard, und
abwesend heisst weiterhin „fuer diese Saeule gilt die Wahl der Anlage", nie
`schnell`. Der `frame`-Block ist der Rahmen, den bis dahin nur `:8484` pflegen
konnte (Hausreserve, Sicherheitsabstand, Mindestleistung, Rotation, hoechste
Gebaeudelast, statisch/gemessen); auch hier gilt die PATCH-Regel — ein
abwesendes Feld behaelt den Wert der Box, und die Plausibilitaet prueft
weiterhin die Box (`lastmgmt.Settings.Apply`), nie das Dokument.

Seit Verbrauchsmanagement v1 (P7) traegt dasselbe Dokument die FAHRZEUG-PROFILE
(`mqtt-charging-config.valid.fahrzeug-profile.json`): je Ladekarte eine eigene
Quellen-Bahn, damit am selben Ladepunkt der Dienstwagen sofort laedt und der
Privatwagen auf die Sonne wartet. Der Schluessel `tag_ref` ist der Pseudonym,
den die BOX selbst aus dem IdTag rechnet und im Herzschlag meldet — der
Klartext-IdTag verlaesst die Box nie, und der Bezug aus dem OCPP-Journal
(`ocpp_transaction.start_id_tag_ref`) ist ausdruecklich ein ANDERER Wert, weil
die Cloud ihn ein zweites Mal peppert. `mqtt-charging-config.invalid.fahrzeug-profil-journal-bezug.json`
ist genau dieser Fehlgriff in Reinform: eine Kennung, die kein `tagref_`-Pseudonym
ist, faellt schon am Muster durch. Anders als `charge_points` ist die Liste die
GANZE Aussage — `mqtt-charging-config.valid.fahrzeug-profile-zurueckgenommen.json`
nimmt mit einer leeren Liste alle Profile zurueck, ohne dass es dafuer eine
Grabstein-Liste braucht.

## `mqtt-charging-boost` (Lastmanagement Stufe 4)

Die Einmal-Übersteuerung „Jetzt voll laden" für GENAU EINEN laufenden
Ladevorgang — dieselbe Freigabe, die die `:8484`-Taste erteilt, mit anderem
Transport. Sie ist NICHT-retained (eine Einmal-Freigabe, die bei jedem Reconnect
wieder erschiene, wäre keine) und trägt deshalb `requested_at`: das Gerät nimmt
diesen Stempel als Beginn seines Fensters, also ist eine nachgelieferte
QoS1-Nachricht bei der Ankunft schon abgelaufen — die Regel der
OTA-Einmal-Freigabe, wörtlich. `…valid.jetzt-voll-laden.json` ist die Erteilung,
`…valid.zuruecknehmen.json` die sofortige Rücknahme (`cancel`, idempotent), und
`…invalid.stecker-null.json` ist der Stecker 0: ein Stecker ist ein Fahrzeug und
wird ab 1 gezählt — eine Übersteuerung ohne Ladevorgang wäre eine Zusage über
ein Auto, das nicht da ist.

`…valid.laden-pausieren.json` ist die ZWEITE Richtung desselben Mechanismus
(`action: "pause"`, Verbrauchsmanagement v1 / P3b, Entscheid E5): sie deckelt
GENAU DIESEN Ladevorgang auf 0 kW und lässt jeden anderen unberührt. ⚠ Das Feld
ist OPTIONAL und ABWESEND heißt `voll` — genau deshalb tragen die zwei älteren
Fixtures es nicht: eine Cloud ohne das Feld erteilt weiterhin den Boost von
vorher, und eine Box, die es nicht kennt, überliest es und tut dasselbe.
