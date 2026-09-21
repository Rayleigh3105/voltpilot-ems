from __future__ import annotations

import collections
import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

import cataloglib  # noqa: E402
from cataloglib import canonical_json_bytes, runtime_projection  # noqa: E402
from generate import build_catalog, generate_builtin_inverter, generate_deye_points, load_deye_document  # noqa: E402
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

    def test_release_artifacts_share_the_canonical_catalog_version(self) -> None:
        canonical = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        pom_root = ET.parse(REPO / "services" / "api" / "pom.xml").getroot()
        namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
        pom_version = pom_root.findtext(
            "m:properties/m:measurement.catalog.version", namespaces=namespace)
        resource_include = pom_root.findtext(
            "m:build/m:resources/m:resource[2]/m:includes/m:include", namespaces=namespace)
        api_artifact = json.loads((ROOT / "dist" /
            f"measurement-point-catalog-{pom_version}.json").read_text(encoding="utf-8"))
        edge_artifact = json.loads((REPO / "edge-app" / "nodered" / "measurements" /
            "catalog.json").read_text(encoding="utf-8"))
        runtime = (ROOT / "RUNTIME_VERSION").read_text(encoding="utf-8").strip()

        self.assertEqual(pom_version, canonical)
        self.assertEqual(resource_include,
                         "measurement-point-catalog-${measurement.catalog.version}.json")
        self.assertEqual(api_artifact["catalog_version"], canonical)
        # Die Box spricht den LAUFZEITSTAND: die Palette lehnt jede Mess-Konfiguration mit
        # fremder catalog_version ab, und die api veröffentlicht genau diesen Stand.
        self.assertEqual(api_artifact["runtime_catalog_version"], runtime)
        self.assertEqual(edge_artifact["catalog_version"], runtime)

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        canonical_link = f"dist/measurement-point-catalog-{canonical}.json"
        self.assertIn(f"[`{canonical_link}`]({canonical_link})", readme)

    def test_schema_and_semantic_validator_accept_artifact(self) -> None:
        for schema in (ROOT / "schema").glob("*.schema.json"):
            document = json.loads(schema.read_text(encoding="utf-8"))
            self.assertEqual(document["$schema"], "https://json-schema.org/draft/2020-12/schema")
        validate_json_schema(self.catalog, json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8")))
        validate_json_schema(self.manifest, json.loads(MANIFEST_SCHEMA.read_text(encoding="utf-8")))
        validated = validate_catalog(ARTIFACT)
        self.assertEqual(len(validated["points"]), EXPECTED["total_points"])

    def test_single_reader_is_cloud_only_and_covers_solarman_and_wago(self) -> None:
        families = {family["family"]: family["single_reader"] for family in self.catalog["families"]}
        self.assertEqual(
            {name for name, single_reader in families.items() if single_reader},
            {"hybrid_1p", "hybrid_3p", "micro", "string", "wago.pm494", "wago.pm495"},
        )
        runtime = runtime_projection(self.catalog, self.catalog["runtime_catalog_version"])
        self.assertTrue(runtime)
        self.assertFalse(any("single_reader" in point for point in runtime))

    def test_rueckfall_ohne_box_is_cloud_only_and_names_only_controllable_families(self) -> None:
        # UEMS AP-15 IP-6: steuerbar = die Familien mit Schreibweg (Deye-Hybrid, SunSpec 123/124, KOSTAL, go-e,
        # Shelly, OCPP); jede heute `unbekannt` — die sichere Seite (zählt mit Nennleistung), bis eine
        # Herstellerquelle mit Titel, Fassung und Stelle anderes belegt und NW-7 es am Prüfstand bestätigt.
        families = {family["family"]: family["rueckfall_ohne_box"] for family in self.catalog["families"]}
        self.assertEqual(
            {name for name, rueckfall in families.items() if rueckfall is not None},
            {"goe.api_v2", "hybrid_1p", "hybrid_3p", "kostal_plenticore", "ocpp.1_6", "shelly.gen1",
             "shelly.gen2plus", "sunspec.model_123", "sunspec.model_124"},
        )
        for name in ("fronius_solar_api", "kaco_http", "kaco_http_hybrid", "micro", "string", "wago.pm494"):
            self.assertIsNone(families[name], name)
        worte = {angabe["rueckfall"] for rueckfall in families.values() if rueckfall for angabe in rueckfall.values()}
        self.assertEqual(worte, {"unbekannt"})
        self.assertEqual(set(families["ocpp.1_6"]), {"bezug"})
        self.assertEqual(set(families["sunspec.model_123"]), {"einspeisung"})
        runtime = runtime_projection(self.catalog, self.catalog["runtime_catalog_version"])
        self.assertFalse(any("rueckfall_ohne_box" in point for point in runtime))
        # das Vokabular ist das geschlossene aus IP-2 (verbund-anteil-vectors.json)
        vektoren = json.loads((REPO / "docs" / "contracts" / "v2" / "verbund-anteil-vectors.json").read_text(encoding="utf-8"))
        self.assertEqual(list(cataloglib.GERAETE_RUECKFALL_WOERTER), vektoren["vokabulare"]["geraete_rueckfall"])

    def test_rueckfall_ohne_box_rejects_invented_vendor_claims(self) -> None:
        catalog_schema = json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8"))
        falsch = []
        for name, angabe in (
            ("ohne Quelle", {"rueckfall": "faellt_auf_wert", "rueckfall_kw": 40, "nach_s": 60, "quelle": None}),
            ("Quelle ohne Stelle", {"rueckfall": "laeuft_frei", "rueckfall_kw": None, "nach_s": None,
                                    "quelle": {"titel": "Handbuch", "fassung": "1.0", "stelle": ""}}),
            ("Zahl bei unbekannt", {"rueckfall": "unbekannt", "rueckfall_kw": 10, "nach_s": None, "quelle": None}),
            ("Zahl bei laeuft_frei", {"rueckfall": "laeuft_frei", "rueckfall_kw": 10, "nach_s": None,
                                      "quelle": {"titel": "Handbuch", "fassung": "1.0", "stelle": "S. 3"}}),
            ("fremdes Wort", {"rueckfall": "schaltet_ab", "rueckfall_kw": None, "nach_s": None, "quelle": None}),
        ):
            document = copy.deepcopy(self.catalog)
            ocpp = next(family for family in document["families"] if family["family"] == "ocpp.1_6")
            ocpp["rueckfall_ohne_box"] = {"bezug": {"grund": "Test", **angabe}}
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / ARTIFACT.name
                path.write_bytes(canonical_json_bytes(document))
                with self.assertRaises(Exception, msg=name):
                    validate_catalog(path)
            if name in ("Zahl bei unbekannt", "fremdes Wort"):  # den Rest prüft validate.py
                with self.assertRaises(SchemaValidationError, msg=name):
                    validate_json_schema(document, catalog_schema)
            falsch.append(name)
        self.assertEqual(len(falsch), 5)

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


class CounterRangeTest(unittest.TestCase):
    """Z6-Deklaration am Katalog (AP-08 IP-7): `wertebereich_modul`/`laeuft_ueber`."""

    COUNTER = "sunspec.model_203.totwhimp"
    OTHER_COUNTER = "sunspec.model_203.totwhexp"
    GAUGE = "sunspec.model_203.phv"

    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cls.schema = json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8"))
        by_key = {point["point_key"]: point for point in cls.catalog["points"]}
        assert by_key[cls.COUNTER]["aggregation_kind"] == "counter"
        assert by_key[cls.OTHER_COUNTER]["aggregation_kind"] == "counter"
        assert by_key[cls.GAUGE]["aggregation_kind"] != "counter"

    def mutated(self, mutate) -> dict:
        document = copy.deepcopy(self.catalog)
        mutate({point["point_key"]: point for point in document["points"]})
        return document

    def validation_error(self, mutate) -> str:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_bytes(canonical_json_bytes(self.mutated(mutate)))
            with self.assertRaises(ValueError) as raised:
                validate_catalog(path)
        return str(raised.exception)

    def test_declarations_are_on_counters_only_and_never_null(self) -> None:
        for point in self.catalog["points"]:
            declared = [field for field in ("wertebereich_modul", "laeuft_ueber") if field in point]
            if declared:
                self.assertEqual(point["aggregation_kind"], "counter", point["point_key"])
                self.assertTrue(all(point[field] is not None for field in declared), point["point_key"])

    def test_declared_counter_validates_and_the_listing_names_the_rest(self) -> None:
        def declare(points):
            points[self.COUNTER]["wertebereich_modul"] = 4294967296
            points[self.COUNTER]["laeuft_ueber"] = True
            points[self.OTHER_COUNTER]["wertebereich_modul"] = 65536
        document = self.mutated(declare)
        validate_json_schema(document, self.schema)
        counters = sum(point["aggregation_kind"] == "counter" for point in document["points"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_bytes(canonical_json_bytes(document))
            validate_catalog(path)
            result = subprocess.run(
                [sys.executable, str(TOOLS / "validate.py"), str(path), "--ohne-wertebereich"],
                check=False, cwd=ROOT, capture_output=True, text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(
            lines[-1],
            f"{counters - 2} of {counters} counter points without wertebereich_modul "
            f"in catalog {document['catalog_version']}",
        )
        rows = [line.split("\t") for line in lines[:-1]]
        self.assertEqual(len(rows), counters - 2)
        self.assertEqual(rows, sorted(rows, key=lambda row: (row[0], row[1])))
        listed = {row[1] for row in rows}
        self.assertNotIn(self.COUNTER, listed)
        self.assertNotIn(self.OTHER_COUNTER, listed)
        self.assertIn(["goe.api_v2", "goe.api_v2.eto", "http_api_key", "-"], rows)

    def test_listing_of_the_committed_catalog_names_every_undeclared_counter(self) -> None:
        result = subprocess.run(
            [sys.executable, str(TOOLS / "validate.py"), "--ohne-wertebereich"],
            check=True, cwd=ROOT, capture_output=True, text=True,
        )
        points = self.catalog["points"]
        counters = sum(point["aggregation_kind"] == "counter" for point in points)
        undeclared = sum(point["aggregation_kind"] == "counter" and "wertebereich_modul" not in point
                         for point in points)
        self.assertEqual(len(result.stdout.splitlines()), undeclared + 1)
        self.assertTrue(result.stdout.splitlines()[-1].startswith(f"{undeclared} of {counters} counter points"))

    def test_validator_and_schema_reject_dishonest_ranges(self) -> None:
        def field(key, **values):
            def mutate(points):
                points[key].update(values)
            return mutate

        cases = [
            (field(self.COUNTER, laeuft_ueber=True),
             f"{self.COUNTER}: laeuft_ueber needs wertebereich_modul", "required property 'wertebereich_modul'"),
            (field(self.GAUGE, wertebereich_modul=65536),
             f"{self.GAUGE}: wertebereich_modul only on a counter point", "expected constant 'counter'"),
            (field(self.GAUGE, wertebereich_modul=65536, laeuft_ueber=False),
             f"{self.GAUGE}: wertebereich_modul/laeuft_ueber only on a counter point", "expected constant 'counter'"),
            (field(self.COUNTER, wertebereich_modul=1),
             f"{self.COUNTER}: wertebereich_modul must be an integer >= 2", "below minimum 2"),
            (field(self.COUNTER, wertebereich_modul=65536.0),
             f"{self.COUNTER}: wertebereich_modul must be an integer >= 2", "expected type"),
            (field(self.COUNTER, wertebereich_modul=True),
             f"{self.COUNTER}: wertebereich_modul must be an integer >= 2", "expected type"),
            (field(self.COUNTER, wertebereich_modul=None),
             f"{self.COUNTER}: wertebereich_modul must be an integer >= 2", "expected type"),
            (field(self.COUNTER, wertebereich_modul=65536, laeuft_ueber="ja"),
             f"{self.COUNTER}: laeuft_ueber must be boolean", "expected type"),
        ]
        for mutate, validator_message, schema_message in cases:
            with self.subTest(validator_message=validator_message, schema_message=schema_message):
                self.assertIn(validator_message, self.validation_error(mutate))
                with self.assertRaisesRegex(SchemaValidationError, re.escape(schema_message)):
                    validate_json_schema(self.mutated(mutate), self.schema)

    def test_builtin_source_passes_a_declaration_through_only_when_present(self) -> None:
        item = {
            "selector": "/status#eto", "group": "Zähler", "label_de": "Gesamterzeugung",
            "label_source": "eto", "unit": "Wh", "value_type": "uint32", "signed": False,
            "scale": {"kind": "none"}, "aggregation_kind": "counter", "cadence_s": 300,
        }
        source_document = {"schema_version": "1.0", "families": [{
            "family": "selbstbau_test", "source_url": "https://example.invalid/", "source_revision": "r1",
            "points": [
                {**item, "key": "declared", "wertebereich_modul": 65536, "laeuft_ueber": True},
                {**item, "key": "undeclared", "selector": "/status#eto2"},
            ],
        }]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(source_document), encoding="utf-8")
            points = {point["point_key"]: point for point in generate_builtin_inverter(
                {"path": str(path), "source_sha256": "0" * 64})}
        declared = points["selbstbau_test.declared"]
        self.assertEqual((declared["wertebereich_modul"], declared["laeuft_ueber"]), (65536, True))
        self.assertNotIn("wertebereich_modul", points["selbstbau_test.undeclared"])
        self.assertNotIn("laeuft_ueber", points["selbstbau_test.undeclared"])



class WagoQuelleTest(unittest.TestCase):
    """UEMS AP-05 IP-4/IP-5: Quelle `wago` am Registerbild v1, `modbus_input` und `range` im Schema.

    Die Hauptauflage: die 750-494 erbt keine Zahl der 750-495 (Befund 4 aus IP-2). Jede Angabe und jede
    Zahl wird hier gegen die Vektor-Datei des Vertrags gehalten, die dieselbe Trennung über `gilt_fuer` macht.
    """

    VEKTOREN = REPO / "docs" / "contracts" / "v2" / "wago-registerbild-vectors.json"
    KARTEN = {"wago.pm494": "750-494", "wago.pm495": "750-495"}
    EINHEIT = {"mWh": ("kWh", 0.000001), "kWh": ("kWh", 1), "W": ("W", 1), "V": ("V", 1), "A": ("A", 1),
               "Hz": ("Hz", 1)}

    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cls.schema = json.loads(CATALOG_SCHEMA.read_text(encoding="utf-8"))
        cls.vektoren = json.loads(cls.VEKTOREN.read_text(encoding="utf-8"))
        cls.by_key = {point["point_key"]: point for point in cls.catalog["points"]}
        cls.wago = [point for point in cls.catalog["points"] if point["family"].startswith("wago.")]

    def punkt(self, family: str, feld: str) -> dict:
        return self.by_key[f"{family}.karte[*].{feld}"]

    def mutated(self, mutate) -> dict:
        document = copy.deepcopy(self.catalog)
        mutate({point["point_key"]: point for point in document["points"]}, document)
        return document

    def validation_error(self, mutate) -> str:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_bytes(canonical_json_bytes(self.mutated(mutate)))
            with self.assertRaises(ValueError) as raised:
                validate_catalog(path)
        return str(raised.exception)

    def regel(self, name: str) -> dict:
        (feld,) = [f for f in self.vektoren["karte"]["felder"] if f["schluessel"] == "messwerte"]
        (angabe,) = [r["angabe"] for r in feld["regeln"] if r["name"] == name]
        return angabe

    def erwartet(self, angabe: dict, artikel: str) -> str:
        """Was eine Vektor-Angabe für EINE Karte ist: eine fremde Handbuch-Angabe ist zu erheben."""
        if angabe["art"] == "handbuch":
            return "handbuch" if artikel in angabe["gilt_fuer"] else "zu erheben"
        return angabe["art"]

    def test_each_card_is_the_registerbild_block_as_templates(self) -> None:
        karte = {f["schluessel"]: f for f in self.vektoren["karte"]["felder"]}
        status = self.vektoren["statuswoerter"]
        for family in self.KARTEN:
            points = [point for point in self.wago if point["family"] == family]
            self.assertEqual(len(points), 27, family)
            for point in points:
                self.assertEqual(point["source_kind"], "wago_registerbild")
                self.assertEqual((point["address"]["kind"], point["address"]["base"]), ("registerbild_relative", "parameter"))
                self.assertTrue(point["address"]["offset_words"].startswith("12+index*42+"), point["point_key"])
                self.assertTrue(point["dynamic"] and point["point_key_template"])
                self.assertIsNone(point["endian"], "Wortfolge ist Parameter der Anlage")
            for m in self.vektoren["messwerte"]:
                point = self.punkt(family, m["schluessel"])
                self.assertEqual(point["address"]["offset_words"], f"12+index*42+{m['offset']}")
                self.assertEqual((point["width_bits"], point["label_de"]), (32, m["kundenwort"]))
                self.assertEqual(point["aggregation_kind"],
                                 "counter" if m["schluessel"].startswith("energy_") else "gauge")
            for gruppe in (1, 2, 3):
                for index, wort in enumerate(status["woerter"]):
                    point = self.punkt(family, f"gruppe_{gruppe}.{wort}")
                    offset = karte["statuswoerter"]["offset"] + (gruppe - 1) * 4 + index
                    self.assertEqual(point["address"]["offset_words"], f"12+index*42+{offset}")
                    self.assertEqual(point["aggregation_kind"], "bitfield")
            for feld in ("gueltigkeit", "kartenregister_32", "kartenregister_35"):
                self.assertEqual(self.punkt(family, feld)["address"]["offset_words"],
                                 f"12+index*42+{karte[feld]['offset']}")

    def test_the_750_494_inherits_no_number_of_the_750_495(self) -> None:
        for point in (p for p in self.wago if p["family"] == "wago.pm494"):
            for feld, angabe in point["angaben"].items():
                if angabe["art"] == "handbuch":
                    self.assertIn("750-494", angabe["gilt_fuer"], f"{point['point_key']} {feld}")
        for m in self.vektoren["messwerte"]:
            point = self.punkt("wago.pm494", m["schluessel"])
            self.assertEqual((point["value_type"], point["signed"], point["scale"], point["unit"], point["readable"]),
                             ("unknown", None, {"kind": "unknown"}, None, False), point["point_key"])
            self.assertNotIn("range", point)
            self.assertEqual({feld: angabe["art"] for feld, angabe in point["angaben"].items()},
                             {"address": "festlegung", "met_id": "zu erheben", "range": "zu erheben",
                              "scale": "zu erheben", "value_type": "zu erheben"}, point["point_key"])
        # Belegt ist für die 494, was der Koppler-Handbuch oder der Vertrag für BEIDE Karten sagt.
        self.assertEqual(self.punkt("wago.pm494", "gruppe_1.statuswort_1")["angaben"]["value_type"]["gilt_fuer"],
                         ["750-494", "750-495"])
        belegt_495 = sorted(m["schluessel"] for m in self.vektoren["messwerte"]
                            if self.punkt("wago.pm495", m["schluessel"])["value_type"] != "unknown")
        self.assertEqual(len(belegt_495), 11, "750-495: nur Lieferung gesamt ohne Datentyp")
        self.assertNotIn("energy_export_total", belegt_495)

    def test_every_origin_and_type_follows_the_contract_vectors(self) -> None:
        for family, artikel in self.KARTEN.items():
            for m in self.vektoren["messwerte"]:
                point = self.punkt(family, m["schluessel"])
                angaben = point["angaben"]
                with self.subTest(point=point["point_key"]):
                    self.assertEqual(angaben["met_id"]["art"], self.erwartet(m["met_id"], artikel))
                    if angaben["met_id"]["art"] == "handbuch":
                        self.assertEqual((angaben["met_id"]["wert"], angaben["met_id"]["fundstelle"]),
                                         (m["met_id"]["wert"], m["met_id"]["fundstelle"]))
                    self.assertEqual(angaben["value_type"]["art"], self.erwartet(m["datentyp"], artikel))
                    if angaben["value_type"]["art"] == "handbuch":
                        self.assertEqual(angaben["value_type"]["fundstelle"], m["datentyp"]["fundstelle"])
                        self.assertEqual((point["value_type"], point["signed"]),
                                         (m["datentyp"]["wert"].lower(), m["datentyp"]["wert"] == "Int32"))
                        regel = self.regel(f"invalid_{point['value_type']}")
                        self.assertEqual(point["range"]["invalid"], regel["wert"])
                        self.assertEqual(angaben["range"]["fundstelle"], regel["fundstelle"])
                        self.assertEqual(point["range"]["max"], regel["wert"] - 1)
                    skalen = {self.erwartet(s["angabe"], artikel) for s in m["skalierung"]}
                    self.assertEqual({angaben["scale"]["art"]}, skalen)
                    if angaben["scale"]["art"] == "handbuch":
                        self.assertEqual(angaben["scale"]["fundstelle"],
                                         "; ".join(sorted({s["angabe"]["fundstelle"] for s in m["skalierung"]})))
            for point in (p for p in self.wago if p["family"] == family and ".gruppe_" in p["point_key"]):
                quelle = next(f for f in self.vektoren["karte"]["felder"] if f["schluessel"] == "statuswoerter")
                self.assertEqual(point["angaben"]["value_type"]["art"], self.erwartet(quelle["wert"], artikel))

    def test_factors_and_units_match_the_quoted_wording(self) -> None:
        zahl = re.compile(r"(?:(\d+): )?([\d,]+) (mWh|kWh|W|V|A|Hz)\b")
        for m in self.vektoren["messwerte"]:
            point = self.punkt("wago.pm495", m["schluessel"])
            erwartet, einheiten = set(), set()
            for s in m["skalierung"]:
                for register, wert, einheit in zahl.findall(s["angabe"]["wert"]):
                    ziel, faktor = self.EINHEIT[einheit]
                    einheiten.add(ziel)
                    erwartet.add((s["messbereich"], int(register) if register else None,
                                  round(float(wert.replace(",", ".")) * faktor, 12)))
            scale = point["scale"]
            if scale["kind"] == "factor":
                katalog = {("alle", None, round(scale["value"], 12))}
            else:
                self.assertEqual(scale["kind"], "conditional_factor")
                katalog = {(f["messbereich"], f.get("kartenregister_35"), round(f["faktor"], 12))
                           for f in scale["value"]["faktoren"]}
            with self.subTest(point=point["point_key"]):
                self.assertTrue(erwartet)
                self.assertEqual(katalog, erwartet)
                self.assertEqual({point["unit"]}, einheiten)

    def test_no_card_reaches_a_box_and_the_runtime_version_stays(self) -> None:
        families = {f["family"]: f["an_der_box"] for f in self.catalog["families"]}
        self.assertEqual({name: families[name] for name in self.KARTEN}, {"wago.pm494": False, "wago.pm495": False})
        self.assertEqual(sum(families.values()), len(families) - 2)
        self.assertEqual(self.catalog["runtime_catalog_version"], "2026.08.26.3")
        self.assertFalse([p for p in runtime_projection(self.catalog, "2026.08.26.3") if p["family"].startswith("wago.")])
        palette = (REPO / "edge-app" / "nodered" / "measurements" / "catalog.json").read_bytes()
        self.assertNotIn(b"wago", palette)
        self.assertNotIn(b"registerbild", palette)

        def an_der_box(points, document):
            next(f for f in document["families"] if f["family"] == "wago.pm495")["an_der_box"] = True
        self.assertIn("wago.pm495: an_der_box mismatch", self.validation_error(an_der_box))
        # Nie eine Familie zurückhalten, die schon an einer Box ist: ihre Punkte verschwänden still.
        with unittest.mock.patch.dict(cataloglib.NOCH_NICHT_AN_DER_BOX, {"sunspec.model_203": "test"}):
            with self.assertRaises(ValueError) as raised:
                validate_catalog(ARTIFACT)
        self.assertIn("families already at the box cannot be withheld from it: ['sunspec.model_203']",
                      str(raised.exception))

    def test_validator_rejects_a_card_that_inherits_or_guesses(self) -> None:
        def erbt(points, document):
            fremd = points["wago.pm495.karte[*].energy_import_total"]
            eigen = points["wago.pm494.karte[*].energy_import_total"]
            for feld in ("value_type", "signed", "scale", "unit", "range", "angaben", "readable"):
                eigen[feld] = copy.deepcopy(fremd[feld])

        def geratener_typ(points, document):
            points["wago.pm494.karte[*].power_l1"]["value_type"] = "int32"

        def einheit_ohne_faktor(points, document):
            points["wago.pm494.karte[*].voltage_l1"]["unit"] = "V"

        def lesbar_ohne_typ(points, document):
            points["wago.pm495.karte[*].energy_export_total"]["readable"] = True

        def ohne_herkunft(points, document):
            del points["wago.pm495.karte[*].frequency"]["angaben"]

        def ungueltig_im_bereich(points, document):
            points["wago.pm495.karte[*].power_l1"]["range"]["invalid"] = 0

        cases = [
            (erbt, "angaben.value_type: quoted for ['750-495'], not for 750-494"),
            (geratener_typ, "wago.pm494.karte[*].power_l1: value_type is unknown exactly when angaben.value_type is zu erheben"),
            (einheit_ohne_faktor, "wago.pm494.karte[*].voltage_l1: without a factor the decoded value has no unit"),
            (lesbar_ohne_typ, "wago.pm495.karte[*].energy_export_total: without a value_type nothing is readable"),
            (ohne_herkunft, "wago.pm495.karte[*].frequency: a WAGO card point names the origin of every number"),
            (ungueltig_im_bereich, "wago.pm495.karte[*].power_l1: range invalid lies inside min … max"),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.assertIn(message, self.validation_error(mutate))

    def test_modbus_input_and_range_are_schema_words_and_box_fields(self) -> None:
        holding = next(p["point_key"] for p in self.catalog["points"]
                       if p["source_kind"] == "modbus_holding" and p["value_type"] == "uint16")

        def input_register(points, document):
            points[holding]["source_kind"] = "modbus_input"
            points[holding]["address"]["kind"] = "modbus_input"

        def bereich(points, document):
            points[holding]["range"] = {"invalid": 65535, "max": 65534, "min": 0}

        for mutate in (input_register, bereich):
            with self.subTest(mutate=mutate.__name__):
                validate_json_schema(self.mutated(mutate), self.schema)
                error = self.validation_error(mutate)
                # Strukturell angenommen — aber ein Box-Feld: an einem ausgelieferten Punkt hebt es den Laufzeitstand.
                self.assertNotIn("wrong Modbus address kind", error)
                self.assertNotIn("invalid source_kind", error)
                self.assertNotIn(": range ", error)
                self.assertIn("content version changes what the box or writer reads", error)

        def falsche_art(points, document):
            points[holding]["source_kind"] = "modbus_input"
        self.assertIn(f"{holding}: wrong Modbus address kind", self.validation_error(falsche_art))

        def bereich_null(points, document):
            points[holding]["range"] = None

        def bereich_ohne_invalid(points, document):
            points[holding]["range"] = {"max": 65534, "min": 0}

        def bereich_zu_gross(points, document):
            points[holding]["range"] = {"invalid": 70000, "max": 65534, "min": 0}

        self.assertIn(f"{holding}: range needs integer min, max and invalid", self.validation_error(bereich_null))
        with self.assertRaisesRegex(SchemaValidationError, "expected type"):
            validate_json_schema(self.mutated(bereich_null), self.schema)
        with self.assertRaisesRegex(SchemaValidationError, re.escape("required property 'invalid'")):
            validate_json_schema(self.mutated(bereich_ohne_invalid), self.schema)
        self.assertIn(f"{holding}: range leaves the uint16 value space", self.validation_error(bereich_zu_gross))


if __name__ == "__main__":
    unittest.main()
