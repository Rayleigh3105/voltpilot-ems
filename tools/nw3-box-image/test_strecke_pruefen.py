#!/usr/bin/env python3
"""NW-3 Punkt 4b: welche Vertragsfassung der Pruefstand annimmt.

Nur die zwei bindenden Fassungen 2.0 (ausgelieferte Palette) und 2.1 (neue
Palette) sind gruen; jede andere ist ein Befund. Aufruf:
    python3 -m unittest tools/nw3-box-image/test_strecke_pruefen.py
"""
import json, pathlib, subprocess, sys, tempfile, unittest

SKRIPT = pathlib.Path(__file__).with_name("strecke_pruefen.py")
BASIS = ("ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002/"
         "00000000-0000-0000-0000-000000000003")
ZEIT = "2026-09-27T15:08:32.254Z"


def pruefe(schema_version):
    umschlag = {"schema_version": schema_version,
                "tenant_id": "00000000-0000-0000-0000-000000000001",
                "site_id": "00000000-0000-0000-0000-000000000002",
                "device_id": "00000000-0000-0000-0000-000000000003",
                "observed_at": ZEIT, "sequence": 3,
                "samples": [{"point_key": "custom.sim.soc", "raw": 547, "decoded": 54.7,
                             "quality": "good"}]}
    with tempfile.TemporaryDirectory() as ordner:
        mitschnitt = pathlib.Path(ordner, "mitschnitt.txt")
        zeilen = pathlib.Path(ordner, "zeilen.txt")
        mitschnitt.write_text(f"{BASIS}/v2/measurement-samples {json.dumps(umschlag)}\n",
                              encoding="utf-8")
        zeilen.write_text(f"{ZEIT} 3 547 54.7 good 2026.09.23.3\n", encoding="utf-8")
        aus = subprocess.run([sys.executable, str(SKRIPT), "--mitschnitt", str(mitschnitt),
                              "--zeilen", str(zeilen), "--basis", BASIS,
                              "--punkt", "custom.sim.soc"],
                             capture_output=True, text=True, check=True).stdout
    return json.loads(aus)


class Vertragsfassung(unittest.TestCase):
    def test_ausgelieferte_palette_2_0_bleibt_gruen(self):
        self.assertEqual(pruefe("2.0")["grund"], "")
        self.assertTrue(pruefe("2.0")["ok"])

    def test_neue_palette_2_1_ist_gruen(self):
        self.assertTrue(pruefe("2.1")["ok"])

    def test_unbekannte_fassung_ist_ein_befund(self):
        for fassung in ("2.2", "1.0", None):
            with self.subTest(fassung=fassung):
                urteil = pruefe(fassung)
                self.assertFalse(urteil["ok"])
                self.assertEqual(urteil["grund"], f"Umschlag mit schema_version {fassung!r}")


if __name__ == "__main__":
    unittest.main()
