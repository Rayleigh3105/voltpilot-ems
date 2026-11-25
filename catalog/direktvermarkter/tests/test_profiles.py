from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from package_edge_runtime import EDGE, output, runtime_view  # noqa: E402
from profilelib import PROFILE_SCHEMA, VOCABULARY, load_json, load_profiles  # noqa: E402
from validate import validate_catalog, validate_profile  # noqa: E402

SCHEMA = load_json(PROFILE_SCHEMA)
VOCAB = load_json(VOCABULARY)
BY_ID = {p["partner"]: p for p in load_profiles()}


def check(profile):
    return validate_profile(profile, f"{profile['partner']}.json", SCHEMA, VOCAB)


class CatalogTest(unittest.TestCase):
    def test_catalog_is_valid(self):
        self.assertEqual(validate_catalog(), [])

    def test_luox_is_the_first_partner(self):
        self.assertIn("luox", BY_ID)

    def test_luox_shape_matches_the_concept(self):
        # vp-direktvermarktung-konzept d2 §5.3: the authored shape, kept as-is.
        p = BY_ID["luox"]
        self.assertEqual(p["zugang"]["modbus"]["port"], 502)
        self.assertEqual(p["zugang"]["modbus"]["unit"], 1)
        self.assertEqual(p["regeln"]["lebenszeichen_frist_s"], 900)
        self.assertEqual(p["regeln"]["ruhewert_pct"], 100)
        self.assertEqual({r["bedeutung"] for r in p["register"]}, set(VOCAB["bedeutungen"]))
        self.assertIn("spid=voltpilot", p["vertrag"]["kennung"])
        self.assertIn("spid=voltpilot", p["vertrag"]["link"])

    def test_open_questions_carry_their_number(self):
        p = BY_ID["luox"]
        self.assertEqual(p["zugang"]["modbus"]["wortfolge"], "offen (F3)")
        self.assertEqual(p["regeln"]["bei_veraltet"], "offen (F8)")

    def test_runtime_derivative_is_byte_identical(self):
        self.assertEqual(EDGE.read_bytes(), output(),
                          "run catalog/direktvermarkter/tools/package_edge_runtime.py")

    def test_runtime_derivative_resolves_open_questions(self):
        # The box cannot run on 'offen (Fxx)' - it gets the vectors' provisional
        # default instead, never a value a schema keyword invented.
        view = runtime_view(list(BY_ID.values()))
        luox = next(p for p in view["partner"] if p["id"] == "luox")
        self.assertEqual(luox["modbus"]["wortfolge"], "little")
        self.assertEqual(luox["regeln"]["bei_veraltet"], "ausnahme_0x0b")

    def test_runtime_derivative_carries_no_vpn_or_portal_fields(self):
        # Stage 1 is the box-side Modbus interface only; OpenVPN, the
        # contract link and the setup steps are the tunnel (Stage 2) and the
        # portal's job, not this package's.
        view = runtime_view(list(BY_ID.values()))
        for entry in view["partner"]:
            self.assertEqual(set(entry), {"id", "modbus", "register", "regeln"})
            self.assertEqual(set(entry["modbus"]), {"unit", "wortfolge", "funktionen", "verbindungen"})
            self.assertEqual(set(entry["regeln"]), {"lebenszeichen_frist_s", "ruhewert_pct", "bei_veraltet"})

    def test_runtime_derivative_keeps_the_band(self):
        view = runtime_view(list(BY_ID.values()))
        luox = next(p for p in view["partner"] if p["id"] == "luox")
        setpoint = next(r for r in luox["register"] if r["bedeutung"] == "vermarkter_vorgabe_pct")
        self.assertEqual(setpoint["band"], [0, 100])

    def test_knowledge_only_edit_leaves_the_derivative_alone(self):
        profiles = copy.deepcopy(list(BY_ID.values()))
        before = runtime_view(profiles)
        for p in profiles:
            p["name"] += " (geändert)"
            p["vertrag"]["ziel"] = "irrelevant"
        self.assertEqual(runtime_view(profiles), before)


class InvariantTest(unittest.TestCase):
    def setUp(self):
        self.p = copy.deepcopy(BY_ID["luox"])

    def assertRejected(self, profile, fragment):
        errors = check(profile)
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_file_name_is_the_partner_id(self):
        errors = validate_profile(self.p, "anders.json", SCHEMA, VOCAB)
        self.assertTrue(any("Dateiname" in e for e in errors), errors)

    def test_unknown_bedeutung(self):
        self.p["register"][0]["bedeutung"] = "erfunden"
        self.assertRejected(self.p, "nicht im Vokabular")

    def test_reserved_bedeutung_not_yet_active(self):
        self.p["register"][0]["bedeutung"] = "speicher_leistung_w"
        self.assertRejected(self.p, "vorgesehen")

    def test_duplicate_bedeutung(self):
        self.p["register"].append(dict(self.p["register"][0], adresse=50))
        self.assertRejected(self.p, "steht mehr als einmal")

    def test_overlapping_registers_in_the_same_table(self):
        self.p["register"].append({"tabelle": "input", "adresse": 1, "typ": "u16", "bedeutung": "referenz_w"})
        self.assertRejected(self.p, "überlappt")

    def test_non_overlapping_across_tables_is_fine(self):
        # holding addr 0 does not exist yet in this profile - same address,
        # different table, must not be flagged.
        clone = copy.deepcopy(self.p)
        clone["register"].append({"tabelle": "holding", "adresse": 0, "typ": "u16", "bedeutung": "lebenszeichen"})
        # 'lebenszeichen' now duplicated on purpose to isolate the overlap check:
        errors = [e for e in check(clone) if "überlappt" in e]
        self.assertEqual(errors, [])

    def test_empty_band(self):
        for r in self.p["register"]:
            if r["bedeutung"] == "vermarkter_vorgabe_pct":
                r["band"] = [100, 0]
        self.assertRejected(self.p, "ist leer")

    def test_rest_value_must_sit_inside_the_band(self):
        for r in self.p["register"]:
            if r["bedeutung"] == "vermarkter_vorgabe_pct":
                r["band"] = [10, 90]
        self.assertRejected(self.p, "liegt außerhalb des Bands")

    def test_unknown_open_question(self):
        self.p["regeln"]["bei_veraltet"] = "offen (F99)"
        self.assertRejected(self.p, "steht nicht im Vokabular")

    def test_unknown_einrichtung_step(self):
        self.p["einrichtung"]["vorher"].append("erfunden")
        self.assertRejected(self.p, "ist nicht im Vokabular")

    def test_schema_rejects_band_on_an_input_register(self):
        self.p["register"][0]["band"] = [0, 100]
        errors = check(self.p)
        self.assertTrue(errors, errors)


if __name__ == "__main__":
    unittest.main()
