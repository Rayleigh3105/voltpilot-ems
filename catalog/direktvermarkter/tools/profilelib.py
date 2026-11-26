"""Shared helpers for the direct-marketer catalog (Direktvermarkter).

Standard library only, like the measurement-point catalog: the CI gate runs
without installing anything. The JSON Schema evaluator is the one of
catalog/measurement-points (it rejects any schema keyword it does not
evaluate).
"""

from __future__ import annotations

import importlib.util
import ipaddress
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
PROFILES = ROOT / "profiles"
VECTORS = ROOT / "vectors"
VOCABULARY = ROOT / "vocabulary.json"
PROFILE_SCHEMA = ROOT / "schema" / "profile.schema.json"

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


# Ein DNS-Name wie RFC 1035/1123 ihn formt: Labels aus Kleinbuchstaben, Ziffern und inneren
# Bindestrichen, je 1-63 Zeichen; IPv4-Literale haben dieselbe Form und sind mit abgedeckt.
# Zwilling der Java-Prüfung in ZugangsdateiOeffner (istGueltigerHost), belegt über
# vectors/gegenstellen.json.
_DNS_NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
_IPV6_ZEICHEN = set("0123456789abcdefABCDEF:.")


def gueltiger_host(wert: str) -> bool:
    """Ein gültiger Host: DNS-Name (kleingeschrieben) oder IPv6-Literal ohne Klammern und Zone."""
    if not wert or len(wert) > 253:
        return False
    if ":" in wert:
        if len(wert) > 45 or any(c not in _IPV6_ZEICHEN for c in wert):
            return False
        try:
            ipaddress.IPv6Address(wert)
        except ValueError:
            return False
        return True
    return _DNS_NAME.match(wert) is not None


def gueltiges_gegenstellen_muster(muster: str) -> bool:
    """Ein gültiges Muster für zugang.vpn.gegenstellen: ein Host, optional mit führendem '*.' vor
    einem DNS-Namen (vectors/gegenstellen.json, Abschnitt 'muster')."""
    if not isinstance(muster, str) or not muster:
        return False
    m = muster.lower()
    if m.startswith("*."):
        rest = m[2:]
        return bool(rest) and ":" not in rest and gueltiger_host(rest)
    return gueltiger_host(m)


def split_offen(value: str) -> tuple[str | None, str | None]:
    """Split a value like 'einspeisung_netzpunkt (F5)' or 'offen (F8)' into
    (base, frage) - base is None for a plain 'offen (Fxx)', frage is None for
    a value with no open question attached."""
    if value.startswith("offen ("):
        return None, value[len("offen ("):-1]
    if value.endswith(")") and " (" in value:
        base, _, rest = value.rpartition(" (")
        return base, rest[:-1]
    return value, None
