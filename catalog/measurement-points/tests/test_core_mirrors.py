from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
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


if __name__ == "__main__":
    unittest.main()
