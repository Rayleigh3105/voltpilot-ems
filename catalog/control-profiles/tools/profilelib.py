"""Shared helpers for the control-profile catalog (Steuerprofile).

Standard library only, like the measurement-point catalog: the CI gate runs
without installing anything. The JSON Schema evaluator is the one of
catalog/measurement-points (it rejects any schema keyword it does not evaluate).
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
PROFILES = ROOT / "profiles"
MANIFEST = ROOT / "sources" / "manifest.json"
VOCABULARY = ROOT / "vocabulary.json"
PROFILE_SCHEMA = ROOT / "schema" / "profile.schema.json"
MANIFEST_SCHEMA = ROOT / "schema" / "source-manifest.schema.json"

# Loaded by path, not via sys.path: that tools directory has its own validate.py.
_SPEC = importlib.util.spec_from_file_location(
    "measurement_points_jsonschema_validator",
    ROOT.parent / "measurement-points" / "tools" / "jsonschema_validator.py")
_VALIDATOR = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_VALIDATOR)
SchemaValidationError = _VALIDATOR.SchemaValidationError
validate_json_schema = _VALIDATOR.validate_json_schema


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def profile_paths() -> list[Path]:
    return sorted(PROFILES.glob("*.json"))


def load_profiles() -> list[dict[str, Any]]:
    return [load_json(path) for path in profile_paths()]
