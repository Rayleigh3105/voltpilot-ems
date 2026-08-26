from __future__ import annotations

import collections
import copy
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
from generate import build_catalog, generate_deye_points, load_deye_document  # noqa: E402
from jsonschema_validator import SchemaValidationError, validate_json_schema  # noqa: E402
from update_deye_key_lock import reconcile_deye_key_lock  # noqa: E402
from validate import validate_catalog  # noqa: E402
from verify_remote_sources import download_url  # noqa: E402


ARTIFACT = ROOT / "dist" / f"measurement-point-catalog-{(ROOT / 'VERSION').read_text().strip()}.json"
MANIFEST = ROOT / "sources" / "manifest.json"
CATALOG_SCHEMA = ROOT / "schema" / "catalog.schema.json"
MANIFEST_SCHEMA = ROOT / "schema" / "source-manifest.schema.json"
DEYE_LOCK = ROOT / "sources" / "deye" / "point-key-lock.json"
SHELLY_RAW_MANIFEST = ROOT / "sources" / "shelly" / "raw-manifest.json"
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
        validate_json_schema(self.catalog, json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8")))
        validate_json_schema(self.manifest, json.loads(MANIFEST_SCHEMA.read_text(encoding="utf-8")))
        validated = validate_catalog(ARTIFACT)
        self.assertEqual(len(validated["points"]), EXPECTED["total_points"])

    def test_json_schemas_reject_extras_and_nested_type_errors(self) -> None:
        catalog_schema = json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8"))
        manifest_schema = json.loads(MANIFEST_SCHEMA.read_text(encoding="utf-8"))
        invalid_documents = []

        root_extra = copy.deepcopy(self.catalog)
        root_extra["invented"] = True
        invalid_documents.append((root_extra, catalog_schema, "additional property"))

        point_extra = copy.deepcopy(self.catalog)
        point_extra["points"][0]["invented"] = True
        invalid_documents.append((point_extra, catalog_schema, "additional property"))

        nested_type = copy.deepcopy(self.catalog)
        modbus_point = next(point for point in nested_type["points"] if point["address"] and point["address"]["kind"] == "modbus_holding")
        modbus_point["address"]["width_words"] = "two"
        invalid_documents.append((nested_type, catalog_schema, "expected type"))

        manifest_extra = copy.deepcopy(self.manifest)
        manifest_extra["sources"][0]["invented"] = "field"
        invalid_documents.append((manifest_extra, manifest_schema, "additional property"))

        for document, schema, message in invalid_documents:
            with self.subTest(message=message), self.assertRaisesRegex(SchemaValidationError, message):
                validate_json_schema(document, schema)

        unsupported = copy.deepcopy(catalog_schema)
        unsupported["not"] = {}
        with self.assertRaisesRegex(ValueError, "unsupported JSON Schema keyword"):
            validate_json_schema(self.catalog, unsupported)

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

    def test_every_deye_map_exposes_all_authored_pv_string_measurements(self) -> None:
        """No UI shortlist may collapse the vendor maps to total PV only."""
        manifest = {source["family"]: source for source in self.manifest["sources"]
                    if source["adapter"] == "deye"}
        for family in ("string", "hybrid_1p", "hybrid_3p", "micro"):
            document = json.loads((ROOT / manifest[family]["input_path"]).read_text())["document"]
            authored = {
                item["name"] for group in document["parameters"] for item in group["items"]
                if isinstance(item.get("name"), str)
                and __import__("re").fullmatch(r"PV\d+ (Power|Current|Voltage)", item["name"])
            }
            packaged = {point["label_source"] for point in self.points
                        if point["family"] == family}
            self.assertTrue(authored, family)
            self.assertEqual(authored, authored & packaged, family)

    def test_every_named_deye_map_measurement_is_in_the_catalog(self) -> None:
        """Pin full per-map coverage: phases, battery, grid, temperature, faults and meters too."""
        manifest = {source["family"]: source for source in self.manifest["sources"]
                    if source["adapter"] == "deye"}
        for family in ("string", "hybrid_1p", "hybrid_3p", "micro"):
            document = json.loads((ROOT / manifest[family]["input_path"]).read_text())["document"]
            authored = {
                item["name"] for group in document["parameters"] for item in group["items"]
                if isinstance(item.get("name"), str) and item["name"].strip()
            }
            packaged = {point["label_source"] for point in self.points
                        if point["family"] == family}
            self.assertTrue(authored, family)
            self.assertEqual(set(), authored - packaged, family)

    def test_inverter_runtime_families_are_source_honest_and_complete(self) -> None:
        expected = {
            "fronius_solar_api": 5,
            "kaco_http": 7,
            "kaco_http_hybrid": 16,
            "kostal_plenticore": 12,
        }
        counts = collections.Counter(point["family"] for point in self.points)
        for family, count in expected.items():
            self.assertEqual(counts[family], count)
        kostal = [point for point in self.points if point["family"] == "kostal_plenticore"]
        self.assertEqual(
            {register for point in kostal for register in point["address"]["registers"]},
            {5, 56, 57, 252, 253, 514, 531, 582, 588, 1068, 1069,
             1076, 1077, 1078, 1079, 1080, 1082},
        )
        byte_order = [point["decoder"].get("byte_order") for point in kostal
                      if point["address"]["width_words"] > 1]
        self.assertTrue(byte_order)
        self.assertTrue(all(value == byte_order[0] for value in byte_order))
        self.assertEqual(byte_order[0], {
            "connection_key": "byte_order", "register": 5,
            "little_value": 0, "big_value": 1, "default": "little",
        })

    def test_all_pinned_deye_rule_1_and_2_runtime_semantics_are_packaged(self) -> None:
        semantic_fields = {"range", "mask", "bit", "bitmask", "offset", "divide",
                           "validation", "lookup"}
        affected = [point for point in self.points
                    if point.get("address")
                    and (point.get("decoder") or {}).get("rule") in (1, 2)
                    and semantic_fields & point["decoder"].keys()]
        self.assertEqual(len(affected), 339)
        self.assertEqual(collections.Counter(point["family"] for point in affected), {
            "hybrid_1p": 93, "hybrid_3p": 213, "micro": 22, "string": 11,
        })
        self.assertTrue(all(point["decoder"].get("source_key") for point in affected))
        self.assertTrue(all("digits" in point["decoder"] for point in affected))

    def test_state_like_points_are_eligible_for_durable_long_term_rollups(self) -> None:
        state_like = [point for point in self.points
                      if point["aggregation_kind"] in {"state", "event", "bitfield", "text"}]
        self.assertTrue(state_like)
        self.assertTrue(all(point["long_term_cadence_s"] == 900 for point in state_like))

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
        self.assertEqual(self.catalog["deye_point_key_lock_sha256"], EXPECTED["deye_lock_sha256"])
        versions = {
            source["id"]: source.get("source_commit") or source.get("source_revision")
            for source in self.manifest["sources"]
        }
        self.assertEqual(versions, EXPECTED["source_versions"])
        for point in self.points:
            self.assertEqual(point["catalog_version"], EXPECTED["catalog_version"])
            self.assertTrue(point["source_commit"] or point["source_revision"])
            self.assertRegex(point["source_sha256"], r"^[0-9a-f]{64}$")

    def test_deye_lock_keeps_keys_stable_across_duplicate_and_rename(self) -> None:
        lock = json.loads(DEYE_LOCK.read_text(encoding="utf-8"))
        deye_sources = [source for source in self.manifest["sources"] if source["adapter"] == "deye"]
        documents = {source["id"]: load_deye_document(source) for source in deye_sources}
        string_source = next(source for source in deye_sources if source["id"] == "deye.string")
        original_key = next(
            point["point_key"]
            for point in generate_deye_points(string_source, documents["deye.string"], lock)
            if point["selector"] == "holding:0x0000"
        )

        duplicate_document = copy.deepcopy(documents["deye.string"])
        info_group = next(group for group in duplicate_document["parameters"] if group["group"] == "Info")
        duplicate = copy.deepcopy(next(item for item in info_group["items"] if item.get("name") == "Device"))
        duplicate["registers"] = [65500]
        info_group["items"].append(duplicate)
        duplicate_sources = [
            (source, duplicate_document if source["id"] == "deye.string" else documents[source["id"]])
            for source in deye_sources
        ]
        duplicate_lock = reconcile_deye_key_lock(lock, duplicate_sources)
        duplicate_points = list(generate_deye_points(string_source, duplicate_document, duplicate_lock))
        self.assertEqual(
            next(point["point_key"] for point in duplicate_points if point["selector"] == "holding:0x0000"),
            original_key,
        )
        duplicate_key = next(point["point_key"] for point in duplicate_points if point["selector"] == "holding:0xffdc")
        self.assertNotEqual(duplicate_key, original_key)

        renamed_document = copy.deepcopy(duplicate_document)
        next(group for group in renamed_document["parameters"] if group["group"] == "Info")["group"] = "Renamed Info"
        renamed_sources = [
            (source, renamed_document if source["id"] == "deye.string" else documents[source["id"]])
            for source in deye_sources
        ]
        renamed_lock = reconcile_deye_key_lock(duplicate_lock, renamed_sources)
        original_entry = next(entry for entry in renamed_lock["entries"] if entry["point_key"] == original_key)
        original_entry["aliases"].append("deye.string.legacy-device")
        renamed_points = list(generate_deye_points(string_source, renamed_document, renamed_lock))
        renamed_original = next(point for point in renamed_points if point["selector"] == "holding:0x0000")
        self.assertEqual(renamed_original["point_key"], original_key)
        self.assertEqual(renamed_original["point_key_aliases"], ["deye.string.legacy-device"])

    def test_offline_source_derivations_are_committed_and_deterministic(self) -> None:
        for tool in ("update_deye_key_lock.py", "extract_shelly.py"):
            subprocess.run([sys.executable, str(TOOLS / tool), "--check"], check=True, cwd=ROOT)
        workflow = (ROOT.parents[1] / ".forgejo" / "workflows" / "deploy.yaml").read_text(encoding="utf-8")
        catalog_gate = workflow.split("- name: Measurement-point catalog checks", 1)[1].split("# ---- Frontend", 1)[0]
        self.assertNotIn("pip install", catalog_gate)
        self.assertNotIn("normalize_deye.py", catalog_gate)
        setup_python = workflow.split("- name: Set up Python", 1)[1].split("- name: Pytest", 1)[0]
        self.assertNotIn("catalog", setup_python)

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
        source = next(source for source in self.manifest["sources"] if source["id"] == "goe.api_v2")
        self.assertEqual(
            source["german_labels_url"],
            "https://github.com/goecharger/go-eCharger-API-v2/blob/"
            "b4d7f85325f5fd7243d007f7fd639ac2db16c5da/API_KEYS_FIRMWARE/apikeys-de.md",
        )
        self.assertEqual(
            download_url(source["german_labels_url"]),
            "https://raw.githubusercontent.com/goecharger/go-eCharger-API-v2/"
            "b4d7f85325f5fd7243d007f7fd639ac2db16c5da/API_KEYS_FIRMWARE/apikeys-de.md",
        )

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
        raw_manifest_bytes = SHELLY_RAW_MANIFEST.read_bytes()
        self.assertEqual(hashlib.sha256(raw_manifest_bytes).hexdigest(), EXPECTED["shelly_raw_manifest_sha256"])
        raw_manifest = json.loads(raw_manifest_bytes)
        self.assertEqual(len(raw_manifest["sources"]), 21)
        pinned_sources = {source["id"]: source for source in raw_manifest["sources"]}
        for source in pinned_sources.values():
            self.assertEqual(hashlib.sha256((ROOT / source["path"]).read_bytes()).hexdigest(), source["sha256"])
        for point in self.points:
            if not point["family"].startswith("shelly."):
                continue
            self.assertTrue(point["source_evidence"])
            self.assertTrue(all(evidence == pinned_sources[evidence["id"]] for evidence in point["source_evidence"]))
            self.assertEqual(point["source_sha256"], point["source_evidence"][0]["sha256"])
        ocpp = [point for point in self.points if point["family"] == "ocpp.1_6"]
        dimensions = ocpp[0]["dimensions"]
        self.assertEqual(
            {name: len(values) for name, values in dimensions.items()},
            {"contexts": 8, "formats": 2, "locations": 5, "phases": 10, "units": 16},
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
                "kvar", "A", "V", "Celsius", "Fahrenheit", "K", "Percent",
            ],
        )
        self.assertNotIn("Celcius", dimensions["units"])
        self.assertTrue(all(point["point_key_template"] for point in ocpp))
        self.assertTrue(all(point["unit"] is None for point in ocpp))

    def test_shelly_documented_frequency_and_minute_energy_units_are_pinned(self) -> None:
        points = {point["point_key"]: point for point in self.points}
        expected_units = {
            "shelly.gen2plus.switch[*].freq": "Hz",
            "shelly.gen2plus.cover[*].freq": "Hz",
            "shelly.gen2plus.cover[*].aenergy.by_minute[*]": "mWh",
        }
        self.assertEqual(
            {point_key: points[point_key]["unit"] for point_key in expected_units},
            expected_units,
        )

    def test_unknowns_are_explicit_and_untranslated(self) -> None:
        unknown = [point for point in self.points if point["semantic_status"] == "unknown"]
        self.assertEqual(len(unknown), 5)
        self.assertTrue(all(point["label_de"] is None for point in unknown))
        self.assertGreater(sum(point["semantic_status"] == "vendor_label_only" for point in self.points), 0)


if __name__ == "__main__":
    unittest.main()
