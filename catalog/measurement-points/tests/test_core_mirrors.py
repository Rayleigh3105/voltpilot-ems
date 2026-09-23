from __future__ import annotations

import copy
import sys
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import check_core_mirrors  # noqa: E402
from cataloglib import RUNTIME_CATALOG_VERSION, runtime_projection  # noqa: E402
from check_core_mirrors import SOURCE, WRITER, validated  # noqa: E402


class CoreMirrorsTest(unittest.TestCase):
    def test_proven_register_pairs_and_cloud_package_are_current(self):
        metadata = validated()
        self.assertEqual(SOURCE.read_bytes(), WRITER.read_bytes())
        self.assertEqual(7, len(metadata["mappings"]))
        # Hybrid-3p has a register fallback, battery power is derived, SoC can be estimated.
        # None is sufficient evidence for one fixed physical register.
        self.assertNotIn("hybrid_3p", {m["family"] for m in metadata["mappings"]})
        self.assertEqual({"power_kw"}, {m["channel"] for m in metadata["mappings"]})

    def test_a_mirror_holds_across_every_runtime_version_with_the_same_box_view(self):
        # Bestandsauswahlen tragen den Stand, unter dem sie gespeichert wurden (Writer: = ANY).
        self.assertEqual(["2026.08.26.3", RUNTIME_CATALOG_VERSION], validated()["runtime_catalog_versions"])

        def verschoben(catalog, version):
            points = copy.deepcopy(runtime_projection(catalog, version))
            if version == "2026.08.26.3":
                next(p for p in points if p["point_key"] == "sunspec.model_211.w")["address"] = {"offset": 99}
            return points
        with unittest.mock.patch.object(check_core_mirrors, "runtime_projection", verschoben):
            with self.assertRaises(AssertionError) as raised:
                validated()
        self.assertIn("box view of sunspec.model_211.w differs in runtime 2026.08.26.3", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
