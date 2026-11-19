"""Der Pruefer als Test (python3 -m unittest discover -s sps/codesys/pruefer) - und der Interpreter
gegen die Rechenregeln, auf die sich der Pruefer verlaesst."""

import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pruefe  # noqa: E402
import st  # noqa: E402


def rechne(rumpf: str, deklaration: str = "") -> dict:
    p = st.Projekt()
    quelle = Path(__file__).resolve().parent / "_probe.st"
    quelle.write_text(f"PROGRAM P\nVAR\n{deklaration}\nEND_VAR\n{rumpf}\nEND_PROGRAM\n", encoding="utf-8")
    try:
        p.lade(quelle)
    finally:
        quelle.unlink()
    p.zyklus("P")
    return p.programm("P").werte


class Interpreter(unittest.TestCase):
    def test_schneidet_wie_codesys_beim_speichern(self):
        w = rechne("u := 65535; u := u + 1; i := 32767; i := i + 1; w := DINT_TO_WORD(-950); "
                   "d := DINT_TO_UDINT(-1200);",
                   "u : UINT; i : INT; w : WORD; d : UDINT;")
        self.assertEqual((w["u"], w["i"], w["w"], w["d"]), (0, -32768, 0xFC4A, 0xFFFFFB50))

    def test_zeichen_einer_zeichenkette_als_byte(self):
        w = rechne("s := 'Grün'; b := s[2]; n := LEN(s);", "s : STRING(32); b : BYTE; n : INT;")
        self.assertEqual((w["b"], w["n"]), (0xFC, 4))

    def test_min_max_limit_wie_iec(self):
        w = rechne("a := MIN(5, -3, 7); b := MAX(udi, 2); c := LIMIT(0, 300000, 265000); d := LIMIT(0, -5, 10);",
                   "a : DINT; b : UDINT; c : DINT; d : DINT; udi : UDINT := 9;")
        self.assertEqual((w["a"], w["b"], w["c"], w["d"]), (-3, 9, 265000, 0))

    def test_xor_und_shr_auf_woertern(self):
        w = rechne("c := 16#FFFF; c := c XOR 16#0031; c := SHR(c, 1) XOR 16#A001;", "c : WORD;")
        self.assertEqual(w["c"], ((0xFFFF ^ 0x31) >> 1) ^ 0xA001)

    def test_feldgrenze_ist_ein_fehler(self):
        with self.assertRaises(st.StFehler):
            rechne("a[3] := 1;", "a : ARRAY[0..2] OF WORD;")


class Pruefer(unittest.TestCase):
    def test_bibliothek_gegen_die_vektoren(self):
        ausgabe = io.StringIO()
        with redirect_stdout(ausgabe):
            rc = pruefe.main([])
        self.assertEqual(rc, 0, ausgabe.getvalue())


if __name__ == "__main__":
    unittest.main()
