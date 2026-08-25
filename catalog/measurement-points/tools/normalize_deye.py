#!/usr/bin/env python3
"""Normalize the pinned ha-solarman YAML maps for the stdlib-only generator.

This update-only helper deliberately keeps PyYAML out of the normal build and
test path.  The resulting JSON retains the complete YAML data structure and
records the SHA-256 of the exact upstream bytes it came from.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

try:
    import yaml
except ImportError as exc:  # pragma: no cover - update-only dependency
    raise SystemExit(
        "PyYAML 6.0.2 is required only to refresh Deye snapshots: "
        "python -m pip install -r catalog/measurement-points/requirements-update.txt"
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "sources" / "deye"
FILES = (
    "deye_string.yaml",
    "deye_hybrid.yaml",
    "deye_p3.yaml",
    "deye_micro.yaml",
)


def normalized_bytes(path: Path) -> bytes:
    raw = path.read_bytes()
    document = {
        "normalizer_version": "1.0",
        "raw_file": path.name,
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
        "document": yaml.safe_load(raw),
    }
    return (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when a normalized file drifts")
    args = parser.parse_args()

    drift = []
    for name in FILES:
        source = SOURCE_DIR / name
        target = source.with_suffix(".normalized.json")
        expected = normalized_bytes(source)
        if args.check:
            if not target.exists() or target.read_bytes() != expected:
                drift.append(str(target.relative_to(ROOT)))
        else:
            target.write_bytes(expected)

    if drift:
        raise SystemExit("Deye normalization drift: " + ", ".join(drift))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
