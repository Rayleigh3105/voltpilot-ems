from __future__ import annotations

import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from package_edge_runtime import EDGE, output, runtime_view  # noqa: E402
from profilelib import MANIFEST, PROFILE_SCHEMA, load_json, load_profiles  # noqa: E402
from validate import validate_bindings, validate_catalog, validate_manifest, validate_profile  # noqa: E402

SCHEMA = load_json(PROFILE_SCHEMA)
KNOWN = {s["id"] for s in load_json(MANIFEST)["quellen"]}
BY_ID = {p["id"]: p for p in load_profiles()}


def check(profile):
    return validate_profile(profile, f"{profile['id']}.json", SCHEMA, KNOWN)


class CatalogTest(unittest.TestCase):
    def test_catalog_is_valid(self):
        self.assertEqual(validate_catalog(), [])

    def test_start_inventory_is_the_whole_matrix(self):
        # matrix.json of 24.09.2026: 24 rows, 8 cells each (E, E↑, E↓, E~, N, H, A + Einspeisegrenze).
        self.assertEqual(len(BY_ID), 24)
        for p in BY_ID.values():
            self.assertEqual(len(p["absichten"]), 8, p["id"])
            self.assertEqual(p["freigabe"], "keine", p["id"])

    def test_e4b_profiles_are_complete_and_unreleased(self):
        # Captain E4 B: SMA, Fronius GEN24 and Huawei in parallel - complete, but bound to nothing (K9 builds the adapters).
        for pid in ("sma", "fronius_gen24", "huawei"):
            p = BY_ID[pid]
            self.assertIsNone(p["bindung"], pid)
            self.assertTrue(p["quellen"], pid)
            with_sequence = [k for k, c in p["absichten"].items() if c["schreibfolge"]]
            self.assertGreaterEqual(len(with_sequence), 5, pid)
        for pid in ("sma", "huawei"):
            grades = {c["sicherheit"] for c in BY_ID[pid]["absichten"].values()}
            self.assertTrue(grades & {"C", "D"}, pid)

    def test_built_families_are_bound(self):
        bound = {pid for pid, p in BY_ID.items() if p["bindung"]}
        self.assertEqual(bound, {"deye_hp3_remote", "deye_tou", "fronius_pv", "kostal", "kaco_nh3"})
        for pid in bound | {"fronius_gen24"}:
            self.assertIsNotNone(BY_ID[pid]["adapter"], pid)

    def test_runtime_derivative_is_byte_identical(self):
        self.assertEqual(EDGE.read_bytes(), output(),
                         "run catalog/control-profiles/tools/package_edge_runtime.py")

    def test_runtime_derivative_carries_no_lever(self):
        # The box reads binding, damping and day budget - never a lever, a sequence or a certificate word.
        view = runtime_view(list(BY_ID.values()))
        for entry in view["profile"]:
            self.assertEqual(set(entry), {"id", "bindung", "daempfung", "schreibbudget"})
            self.assertEqual(set(entry["daempfung"]), {"box_regelt", "einschwingzeit_s", "messtakt_s"})
            self.assertEqual(set(entry["schreibbudget"]), {"dauerspeicher_je_tag"})

    def test_knowledge_only_edit_leaves_the_derivative_alone(self):
        profiles = copy.deepcopy(list(BY_ID.values()))
        before = runtime_view(profiles)
        for p in profiles:
            p["empfehlung"] += " (geändert)"
            p["absichten"]["E"]["sicherheit"] = "D"
        self.assertEqual(runtime_view(profiles), before)


class InvariantTest(unittest.TestCase):
    def setUp(self):
        self.p = copy.deepcopy(BY_ID["deye_hp3_remote"])

    def assertRejected(self, profile, fragment):
        errors = check(profile)
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_required_field(self):
        del self.p["totmann"]
        self.assertRejected(self.p, "totmann")

    def test_profile_never_releases(self):
        self.p["freigabe"] = "zertifiziert"
        self.assertRejected(self.p, "freigabe")

    def test_firmware_is_read_never_typed(self):
        self.p["firmware_bedingung"]["gelesen"] = False
        self.assertRejected(self.p, "gelesen")

    def test_unknown_source(self):
        self.p["absichten"]["N"]["quellen"].append("erfunden")
        self.assertRejected(self.p, "'erfunden' is not in sources/manifest.json")

    def test_cell_source_listed_on_profile(self):
        self.p["quellen"].remove("t5")
        self.assertRejected(self.p, "missing from the profile's quellen")

    def test_claim_without_source(self):
        self.p["absichten"]["A"]["quellen"] = []
        self.assertRejected(self.p, "needs at least one source")

    def test_damping_values_need_a_measurement(self):
        self.p["daempfung"]["sicherheit"] = "D"
        self.assertRejected(self.p, "measured or documented")

    def test_no_damping_values_where_the_box_must_not_regulate(self):
        self.p["daempfung"]["box_regelt"] = False
        self.assertRejected(self.p, "only where the box regulates")

    def test_budget_bounded_by_the_concept(self):
        self.p["schreibbudget"]["dauerspeicher_je_tag"] = 96
        self.assertRejected(self.p, "maximum")

    def test_persistent_lever_needs_a_budget(self):
        self.p["schreibbudget"]["dauerspeicher_je_tag"] = None
        self.assertRejected(self.p, "needs dauerspeicher_je_tag")

    def test_cell_equals_its_adapter_sequence(self):
        self.p["absichten"]["N"]["schreibfolge"][0]["wert"] = 30
        self.assertRejected(self.p, "differ from adapter.folgen.sollwert")

    def test_unknown_adapter_sequence(self):
        self.p["absichten"]["N"]["adapter_folge"] = "gibt_es_nicht"
        self.assertRejected(self.p, "does not exist")

    def test_register_range(self):
        self.p["uebergabe"]["schreibfolge"][0]["ziel"]["register"] = 70000
        self.assertRejected(self.p, "uebergabe")

    def test_file_name_is_the_id(self):
        errors = validate_profile(self.p, "anders.json", SCHEMA, KNOWN)
        self.assertTrue(any("file name" in e for e in errors), errors)

    def test_overlapping_bindings(self):
        other = copy.deepcopy(BY_ID["deye_tou"])
        other["id"] = "doppelt"
        other["bindung"][0]["steuerpfad"] = None  # would also match the remote path
        errors = validate_bindings([self.p, other])
        self.assertTrue(any("both bind deye/hybrid_3p" in e for e in errors), errors)

    def test_disjoint_models_do_not_overlap(self):
        a = {"marke": "fronius", "registerfamilie": "sunspec_live", "modelle": ["x"], "steuerpfad": None}
        b = dict(a, modelle=["y"])
        self.assertEqual(validate_bindings([{"id": "a", "bindung": [a]}, {"id": "b", "bindung": [b]}]), [])

    def test_repo_source_must_exist(self):
        manifest = load_json(MANIFEST)
        with tempfile.TemporaryDirectory() as tmp:
            errors = validate_manifest(manifest, Path(tmp))
        self.assertTrue(any("does not exist" in e for e in errors), errors)


if __name__ == "__main__":
    unittest.main()
