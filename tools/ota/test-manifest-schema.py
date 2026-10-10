#!/usr/bin/env python3
"""Selbsttest: das Release-Manifest-Schema und die geteilten Vektoren passen
zusammen (docs/contracts/ota-release-manifest.schema.json,
docs/contracts/ota-release-manifest-vectors.json).

Das Schema beschreibt, was die Werkzeuge ERZEUGEN duerfen; die Vektoren sagen
je Fall `erzeugbar` (Go: otaverify.ParseManifestStrict). Beide muessen
uebereinstimmen - mit genau einer benannten Ausnahme: dass (name, arch) eines
binary eindeutig ist, kann JSON Schema nicht ausdruecken.

Geprueft wird ausserdem jedes Beispiel unter docs/contracts/examples/
(`valid` gueltig, `invalid` ungueltig).

    python3 tools/ota/test-manifest-schema.py
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "docs" / "contracts"

# Regeln jenseits des Schemas: diese Faelle sind schema-gueltig, aber nicht
# erzeugbar. Jede Ausnahme steht hier mit Namen, damit keine still dazukommt.
BEYOND_SCHEMA = {"binary-doppelt-fuer-eine-architektur"}


def main() -> int:
    schema = json.loads((CONTRACTS / "ota-release-manifest.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    failed = 0

    def check(ok: bool, what: str) -> None:
        nonlocal failed
        print(("  ok   " if ok else "  FAIL ") + what)
        failed += not ok

    examples = sorted(glob.glob(str(CONTRACTS / "examples" / "ota-release-manifest.*.json")))
    check(len(examples) >= 3, f"{len(examples)} Beispiele gefunden")
    for path in examples:
        valid = not list(validator.iter_errors(json.loads(Path(path).read_text())))
        want = ".valid." in path
        check(valid == want, f"{Path(path).name}: {'gueltig' if valid else 'ungueltig'}")

    vectors = json.loads((CONTRACTS / "ota-release-manifest-vectors.json").read_text())
    names = set()
    for case in vectors["faelle"]:
        name = case["name"]
        names.add(name)
        valid = not list(validator.iter_errors(case["manifest"]))
        if name in BEYOND_SCHEMA:
            check(valid and not case["erzeugbar"],
                  f"{name}: schema-gueltig, aber nicht erzeugbar (Regel jenseits des Schemas)")
        else:
            check(valid == case["erzeugbar"],
                  f"{name}: Schema {'gueltig' if valid else 'ungueltig'} = erzeugbar {case['erzeugbar']}")
    check(BEYOND_SCHEMA <= names, "jede benannte Ausnahme ist ein Fall der Vektoren")

    print(f"{'FEHLER' if failed else 'alles gruen'}: {failed} fehlgeschlagen")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
