from __future__ import annotations

import collections
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from cataloglib import canonical_json_bytes  # noqa: E402
from generate import build_catalog  # noqa: E402
from validate import validate_catalog  # noqa: E402


ARTIFACT = ROOT / "dist" / f"measurement-point-catalog-{(ROOT / 'VERSION').read_text().strip()}.json"
MANIFEST = ROOT / "sources" / "manifest.json"
EXPECTED = json.loads((Path(__file__).with_name("expected_inventory.json")).read_text(encoding="utf-8"))


def markdown_rows(path: Path) -> list[list[str]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 5 and cells[0].lower() != "key" and not set(cells[0]) <= {"-", ":"}:
            rows.append(cells)
    return rows


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cls.points = cls.catalog["points"]
        cls.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_committed_artifact_is_deterministic(self) -> None:
        expected = canonical_json_bytes(build_catalog())
        self.assertEqual(expected, ARTIFACT.read_bytes())
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.json"
            second = Path(directory) / "second.json"
            for output in (first, second):
                subprocess.run(
                    [sys.executable, str(TOOLS / "generate.py"), "--output", str(output)],
                    check=True,
                    cwd=ROOT,
                )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(first.read_bytes(), ARTIFACT.read_bytes())

    def test_schema_and_semantic_validator_accept_artifact(self) -> None:
        for schema in (ROOT / "schema").glob("*.schema.json"):
            document = json.loads(schema.read_text(encoding="utf-8"))
            self.assertEqual(document["$schema"], "https://json-schema.org/draft/2020-12/schema")
        validated = validate_catalog(ARTIFACT)
        self.assertEqual(len(validated["points"]), EXPECTED["total_points"])

    def test_inventory_counts_are_pinned(self) -> None:
        counts = collections.Counter(point["family"] for point in self.points)
        templates = collections.Counter(point["family"] for point in self.points if point.get("dynamic"))
        self.assertEqual(dict(sorted(counts.items())), EXPECTED["family_counts"])
        self.assertEqual(dict(sorted(templates.items())), EXPECTED["template_counts"])
        self.assertEqual(len(self.points), EXPECTED["total_points"])
        direct = {
            family: sum(point["address"] is not None for point in self.points if point["family"] == family)
            for family in EXPECTED["deye_direct_register_points"]
        }
        self.assertEqual(direct, EXPECTED["deye_direct_register_points"])

    def test_point_keys_and_selectors_are_unambiguous(self) -> None:
        keys = [point["point_key"] for point in self.points]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(keys), len(set(keys)))
        selectors: collections.defaultdict[tuple[str, str], list[str]] = collections.defaultdict(list)
        for point in self.points:
            if point["source_kind"] != "modbus_holding":
                selectors[(point["family"], point["selector"])].append(point["point_key"])
        self.assertFalse({key: value for key, value in selectors.items() if len(value) > 1})

    def test_sources_and_provenance_are_pinned(self) -> None:
        manifest_hash = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
        self.assertEqual(manifest_hash, EXPECTED["manifest_sha256"])
        self.assertEqual(self.catalog["source_manifest_sha256"], manifest_hash)
        versions = {
            source["id"]: source.get("source_commit") or source.get("source_revision")
            for source in self.manifest["sources"]
        }
        self.assertEqual(versions, EXPECTED["source_versions"])
        for point in self.points:
            self.assertEqual(point["catalog_version"], EXPECTED["catalog_version"])
            self.assertTrue(point["source_commit"] or point["source_revision"])
            self.assertRegex(point["source_sha256"], r"^[0-9a-f]{64}$")

    def test_sunspec_is_relative_and_model_160_is_dynamic(self) -> None:
        points = [point for point in self.points if point["source_kind"] == "sunspec_model"]
        self.assertEqual(len(points), 810)
        self.assertTrue(all(point["address"]["base"] == "discovered" for point in points))
        self.assertTrue(all("absolute" not in point["address"] for point in points))
        model_160 = [point for point in points if point["family"] == "sunspec.model_160"]
        modules = [point for point in model_160 if point["dynamic"]]
        self.assertEqual((len(model_160), len(modules)), (19, 10))
        self.assertTrue(all("module[*]" in point["point_key"] for point in modules))
        self.assertTrue(all("index*" in point["address"]["offset_words"] for point in modules))

    def test_goe_inventory_and_labels_stay_source_honest(self) -> None:
        points = [point for point in self.points if point["family"] == "goe.api_v2"]
        german_rows = markdown_rows(ROOT / "sources" / "goe" / "apikeys-de.md")
        self.assertEqual(len(points), 316)
        self.assertEqual(len(german_rows), EXPECTED["goe_german_source_rows"])
        self.assertEqual(sum(point["label_de"] is not None for point in points), EXPECTED["goe_keys_with_german_label"])
        self.assertTrue(all(point["unit"] is None for point in points), "units must not be inferred from prose")
        repaired = {point["source_key_raw"]: point["selector"] for point in points if "source_key_raw" in point}
        self.assertEqual(len(repaired), 3)
        self.assertTrue(all("\t" in raw and "\t" not in selector for raw, selector in repaired.items()))

    def test_shelly_components_and_ocpp_dimensions_are_complete(self) -> None:
        components = {
            family: {point["group"] for point in self.points if point["family"] == family}
            for family in ("shelly.gen1", "shelly.gen2plus")
        }
        self.assertEqual(
            components["shelly.gen1"],
            {
                "device_info", "wifi_sta", "services", "system", "relay[*]", "meter[*]",
                "input[*]", "thermal", "external_sensor[*]", "emeter[*]", "light_cover[*]",
            },
        )
        self.assertEqual(
            components["shelly.gen2plus"],
            {
                "device_info", "sys", "wifi", "cloud", "mqtt", "switch[*]", "pm1[*]",
                "em[*]", "emdata[*]", "em1[*]", "em1data[*]", "input[*]",
                "temperature[*]", "humidity[*]", "devicepower[*]", "cover[*]",
                "light_rgb_rgbw[*]",
            },
        )
        self.assertEqual(
            {point["source_url"] for point in self.points if point["family"] == "shelly.gen1"},
            {"https://shelly-api-docs.shelly.cloud/gen1/#shelly-status"},
        )
        self.assertEqual(
            {point["source_url"] for point in self.points if point["family"] == "shelly.gen2plus"},
            {"https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/"},
        )
        ocpp = [point for point in self.points if point["family"] == "ocpp.1_6"]
        dimensions = ocpp[0]["dimensions"]
        self.assertEqual(
            {name: len(values) for name, values in dimensions.items()},
            {"contexts": 8, "formats": 2, "locations": 5, "phases": 10, "units": 17},
        )
        self.assertEqual(
            dimensions["contexts"],
            [
                "Interruption.Begin", "Interruption.End", "Other", "Sample.Clock",
                "Sample.Periodic", "Transaction.Begin", "Transaction.End", "Trigger",
            ],
        )
        self.assertEqual(dimensions["formats"], ["Raw", "SignedData"])
        self.assertEqual(dimensions["locations"], ["Body", "Cable", "EV", "Inlet", "Outlet"])
        self.assertEqual(
            dimensions["phases"],
            ["L1", "L2", "L3", "N", "L1-N", "L2-N", "L3-N", "L1-L2", "L2-L3", "L3-L1"],
        )
        self.assertEqual(
            dimensions["units"],
            [
                "Wh", "kWh", "varh", "kvarh", "W", "kW", "VA", "kVA", "var",
                "kvar", "A", "V", "Celsius", "Celcius", "Fahrenheit", "K", "Percent",
            ],
        )
        self.assertTrue(all(point["point_key_template"] for point in ocpp))
        self.assertTrue(all(point["unit"] is None for point in ocpp))

    def test_unknowns_are_explicit_and_untranslated(self) -> None:
        unknown = [point for point in self.points if point["semantic_status"] == "unknown"]
        self.assertEqual(len(unknown), 5)
        self.assertTrue(all(point["label_de"] is None for point in unknown))
        self.assertGreater(sum(point["semantic_status"] == "vendor_label_only" for point in self.points), 0)


if __name__ == "__main__":
    unittest.main()
