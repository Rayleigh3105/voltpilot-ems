"""Größe und Richtung je Punkt, die Abbildung auf den Messstellen-Vertrag und die zwei Stände."""

from __future__ import annotations

import collections
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from cataloglib import canonical_json_bytes, runtime_projection  # noqa: E402
import package_edge_runtime  # noqa: E402
from semantics import (  # noqa: E402
    DIRECTIONLESS,
    DIRECTIONS,
    ENERGY_QUANTITIES,
    ENERGY_WITHOUT_DIRECTION,
    QUANTITIES,
    RULES,
    ZAEHLER_OHNE_ANZEIGE_EINHEIT,
    rule_for,
)
from validate import validate_catalog  # noqa: E402


VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
RUNTIME = (ROOT / "RUNTIME_VERSION").read_text(encoding="utf-8").strip()
ARTIFACT = ROOT / "dist" / f"measurement-point-catalog-{VERSION}.json"
SCHEMA = ROOT / "schema" / "catalog.schema.json"
EXPECTED = json.loads((Path(__file__).with_name("expected_inventory.json")).read_text(encoding="utf-8"))
V2 = REPO / "docs" / "contracts" / "v2"


def mapping_rows() -> list[tuple[str, str, str | None]]:
    """Die Abbildungstabelle des README: (Feld, Katalogwort, Vertragswort oder None für —)."""
    rows = []
    for line in (ROOT / "README.md").read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 4 and cells[0] in ("`quantity`", "`direction`"):
            contract = None if cells[2] == "—" else cells[2]
            rows.append((cells[0].strip("`"), cells[1].strip("`"), contract))
    return rows


class SemanticsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(ARTIFACT.read_text(encoding="utf-8"))
        cls.points = cls.catalog["points"]
        cls.by_key = {point["point_key"]: point for point in cls.points}

    def validation_error(self, mutate) -> str:
        document = copy.deepcopy(self.catalog)
        mutate({point["point_key"]: point for point in document["points"]})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_bytes(canonical_json_bytes(document))
            with self.assertRaises(ValueError) as raised:
                validate_catalog(path)
        return str(raised.exception)

    def test_every_energy_point_carries_a_direction(self) -> None:
        energy = [point for point in self.points if point["quantity"] in ENERGY_QUANTITIES]
        without = sorted(point["point_key"] for point in energy if point["direction"] is None)
        self.assertEqual(len(energy), EXPECTED["energy_points"])
        self.assertEqual(without, sorted(ENERGY_WITHOUT_DIRECTION))
        self.assertEqual(len(without), EXPECTED["energy_points_without_direction"])
        for key, reason in ENERGY_WITHOUT_DIRECTION.items():
            self.assertTrue(reason.strip(), key)
        # Jeder Punkt mit „energy“ im Schlüssel ist eine Energie-Größe mit Richtung — oder hat,
        # wie ein Betriebsmodus oder ein Minutenzeitstempel, gar keine Größe.
        for point in self.points:
            if "energy" in point["point_key"] and point["point_key"] not in ENERGY_WITHOUT_DIRECTION:
                if point["quantity"] is None:
                    self.assertIsNone(point["direction"], point["point_key"])
                else:
                    self.assertIn(point["quantity"], ENERGY_QUANTITIES, point["point_key"])
                    self.assertIsNotNone(point["direction"], point["point_key"])

    def test_every_counter_has_a_display_unit_or_is_named(self) -> None:
        """Jeder Zähler spricht eine Anzeige-Einheit des Ergebnis-Zustands — oder steht benannt da.

        Ohne Anzeige-Einheit nennt die Cloud keine Zahl in einem Mengen-Satz (`einheit_unbekannt`).
        Dieselbe Datei per Pfad, die Java `ErgebnisZustand` und TS `uemsErgebnis.ts` fahren.
        """
        vertrag = json.loads((V2 / "ergebnis-zustand-vectors.json").read_text(encoding="utf-8"))
        anzeige = {a["gespeichert"]: a["angezeigt"] for a in vertrag["rundung"]["anzeige_einheiten"]}
        counters = [point for point in self.points if point["aggregation_kind"] == "counter"]
        ohne = sorted(point["point_key"] for point in counters if point.get("unit") not in anzeige)
        self.assertEqual(ohne, sorted(ZAEHLER_OHNE_ANZEIGE_EINHEIT))
        arten = collections.Counter(art for art, _ in ZAEHLER_OHNE_ANZEIGE_EINHEIT.values())
        self.assertEqual(dict(arten), {"keine_energie": 29, "einheit_im_schluessel": 4,
                                       "einheit_nur_im_text": 8, "faktor_im_einheitennamen": 4,
                                       "faktor_zu_erheben": 2})
        einheiten = collections.Counter(point.get("unit") for point in counters)
        # Befund PR 726: 41 ohne Einheit, 25 in VAh, 4 in „0,1 kWh“, 1 in Wmin — dazu seit UEMS AP-05 IP-4
        # die zwei Zählerstände der 750-494, deren Faktor zu erheben ist (noch an keiner Box).
        self.assertEqual((einheiten[None], einheiten["VAh"], einheiten["0,1 kWh"], einheiten["Wmin"]),
                         (43, 25, 4, 1))
        # Scheinarbeit ist nie als Wirkarbeit getarnt; Wmin ist Wirkarbeit.
        self.assertEqual(anzeige["VAh"], "kVAh")
        self.assertEqual(anzeige["Wmin"], "kWh")
        for point in counters:
            if point.get("unit") == "VAh":
                self.assertEqual(point["quantity"], "apparent_energy", point["point_key"])

    def test_validator_rejects_an_unnamed_counter_without_unit(self) -> None:
        def drop(points):
            points["sunspec.model_203.totwhimp"]["unit"] = None
        self.assertIn("sunspec.model_203.totwhimp: counter without unit is not named", self.validation_error(drop))

        def wrong(points):
            points["goe.api_v2.eto"]["unit"] = "Wh"
            points["goe.api_v2.eto"]["quantity"] = "active_energy"
            points["goe.api_v2.eto"]["direction"] = "import"
        self.assertIn("goe.api_v2.eto: named without unit, has one", self.validation_error(wrong))

    def test_validator_rejects_an_energy_point_without_direction(self) -> None:
        def drop(points):
            points["sunspec.model_203.totwhimp"]["direction"] = None
        self.assertIn("sunspec.model_203.totwhimp: energy point without direction",
                      self.validation_error(drop))

        def unclassified(points):
            points["sunspec.model_203.totwhexp"]["quantity"] = None
            points["sunspec.model_203.totwhexp"]["direction"] = None
        self.assertIn("sunspec.model_203.totwhexp: energy unit without energy quantity",
                      self.validation_error(unclassified))

        def missing_field(points):
            del points["sunspec.model_203.totwhimp"]["direction"]
        self.assertIn("missing fields ['direction']", self.validation_error(missing_field))

    def test_validator_rejects_invented_or_dishonest_semantics(self) -> None:
        def guessed(points):
            points["deye.hybrid_1p.meter.total-energy"]["direction"] = "generation"
        self.assertIn("listed as energy without direction", self.validation_error(guessed))

        def directionless(points):
            points["sunspec.model_203.phv"]["direction"] = "import"
        self.assertIn("voltage has no flow direction", self.validation_error(directionless))

        def orphan(points):
            points["goe.api_v2.eto"]["direction"] = "import"
        self.assertIn("goe.api_v2.eto: a direction needs a quantity", self.validation_error(orphan))

    def test_vocabulary_is_closed_and_matches_the_schema(self) -> None:
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        point = schema["$defs"]["point"]["properties"]
        self.assertEqual(point["quantity"]["enum"], [*QUANTITIES, None])
        self.assertEqual(point["direction"]["enum"], [*DIRECTIONS, None])
        self.assertLessEqual(DIRECTIONLESS, set(QUANTITIES))
        self.assertEqual(ENERGY_QUANTITIES, {q for q in QUANTITIES if "energy" in q})

    def test_classification_counts_are_pinned(self) -> None:
        quantities = collections.Counter(point["quantity"] or "null" for point in self.points)
        directions = collections.Counter(point["direction"] or "null" for point in self.points)
        self.assertEqual(dict(sorted(quantities.items())), EXPECTED["quantity_counts"])
        self.assertEqual(dict(sorted(directions.items())), EXPECTED["direction_counts"])

    def test_every_rule_is_used_and_names_its_evidence(self) -> None:
        used = collections.Counter(rule_for(point) for point in self.points)
        for index, (_, key, _, _, beleg) in enumerate(RULES):
            self.assertGreater(used[index], 0, f"rule {key} matches no point")
            self.assertTrue(beleg.strip(), key)

    def test_the_reference_meter_and_storage_channels_classify_as_the_contract_expects(self) -> None:
        # K-3 (Netzzähler) liest einen Zweirichtungszähler, K-1 meldet Speicherleistung und
        # Ladestand (docs/contracts/v2/uems-referenzunternehmen.json).
        expected = {
            "sunspec.model_203.totwhimp": ("active_energy", "import"),
            "sunspec.model_203.totwhexp": ("active_energy", "export"),
            "sunspec.model_203.w": ("active_power", "import_export"),
            "ocpp.1_6.metervalues.energy.active.import.register.context[*].format[*].phase[*].location[*].unit[*]":
                ("active_energy", "import"),
            "deye.hybrid_3p.battery.battery-power": ("active_power", "charge_discharge"),
            "deye.hybrid_3p.battery.battery": ("soc", "none"),
            "deye.hybrid_3p.meter.total-battery-charge": ("active_energy", "charge"),
            "deye.hybrid_3p.meter.total-production": ("active_energy", "generation"),
            "goe.api_v2.eto": (None, None),
        }
        for key, (quantity, direction) in expected.items():
            point = self.by_key[key]
            self.assertEqual((point["quantity"], point["direction"]), (quantity, direction), key)

    def test_mapping_table_is_unique_complete_and_reaches_every_contract_word(self) -> None:
        rows = mapping_rows()
        vocabulary = {"quantity": QUANTITIES, "direction": DIRECTIONS}
        schema = json.loads((V2 / "messstelle.schema.json").read_text(encoding="utf-8"))
        vectors = json.loads((V2 / "messstelle-vectors.json").read_text(encoding="utf-8"))
        contract = {
            "quantity": schema["$defs"]["groesseName"]["enum"],
            "direction": schema["$defs"]["richtung"]["enum"],
        }
        for field in ("quantity", "direction"):
            words = [word for f, word, _ in rows if f == field]
            images = [image for f, _, image in rows if f == field and image is not None]
            # Jedes Katalogwort genau einmal. Nur none/import_export teilen ein Vertragswort.
            self.assertEqual(sorted(words), sorted(vocabulary[field]), field)
            duplicates = {image: [word for f, word, target in rows if f == field and target == image]
                          for image, count in collections.Counter(images).items() if count > 1}
            self.assertEqual(duplicates, {"richtungslos": ["none", "import_export"]}
                             if field == "direction" else {}, field)
            # … und nur Wörter, die der Vertrag kennt.
            self.assertLessEqual(set(images), set(contract[field]), field)
            # Jedes Vertragswort ist erreichbar — über ein Wort, das im Katalog vorkommt —,
            # wo der Katalog es hat: er führt nur Strom, also fehlt „Volumen“ (Gas).
            present = collections.Counter(point[field] for point in self.points)
            reached = {image for f, word, image in rows if f == field and image and present[word]}
            electric = [g["groesse"] for g in vectors["groessen_katalog"] if "Strom" in g["medien"]]
            wanted = electric if field == "quantity" else contract[field]
            self.assertEqual(sorted(reached), sorted(wanted), field)
        self.assertEqual(
            [g["groesse"] for g in vectors["groessen_katalog"] if "Strom" not in g["medien"]], ["Volumen"])

    def test_runtime_version_is_a_shipped_artifact_with_the_same_box_view(self) -> None:
        self.assertEqual(self.catalog["catalog_version"], VERSION)
        self.assertEqual(self.catalog["runtime_catalog_version"], RUNTIME)
        shipped = json.loads((ROOT / "dist" / f"measurement-point-catalog-{RUNTIME}.json")
                             .read_text(encoding="utf-8"))
        self.assertEqual(runtime_projection(self.catalog, RUNTIME), runtime_projection(shipped, RUNTIME))

        def box_relevant(points):
            points["sunspec.model_203.w"]["min_cadence_s"] = 7
        self.assertIn("content version changes what the box or writer reads",
                      self.validation_error(box_relevant))

    def test_runtime_derivatives_are_byte_identical(self) -> None:
        edge, sql = package_edge_runtime.outputs()
        self.assertEqual(edge, package_edge_runtime.EDGE.read_bytes())
        self.assertEqual(sql, package_edge_runtime.sql_path().read_bytes())
        self.assertEqual(json.loads(edge)["catalog_version"], RUNTIME)
        self.assertNotIn(b"quantity", edge)
        self.assertNotIn(b"direction", edge)


if __name__ == "__main__":
    unittest.main()
