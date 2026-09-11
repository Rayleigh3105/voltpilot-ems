"""Shared helpers for the deterministic measurement-point catalog tooling."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
# Zwei Stände (README „Inhaltsstand und Laufzeitstand“): VERSION ist der Inhaltsstand dieses
# Artefakts, RUNTIME_VERSION der Stand, den die Box spricht — die Palette lehnt jede
# Mess-Konfiguration mit fremder catalog_version ab (measurement-planner.js).
CATALOG_VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
RUNTIME_CATALOG_VERSION = (ROOT / "RUNTIME_VERSION").read_text(encoding="utf-8").strip()
EDGE_MIN_VERSION = "unreleased"
POINT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._*\[\]@-]*$")

# Was die Box je Punkt liest (der Palette-Katalog) ...
EDGE_FIELDS = (
    "address", "aggregation_kind", "catalog_version", "decoder",
    "default_cadence_s", "derived_from", "edge_min_version", "endian",
    "family", "min_cadence_s", "point_key", "poll_group", "readable",
    "scale", "selector", "signed", "source_kind", "unit", "value_type",
    "width_bits", "dimensions",
)
# ... und was der Writer je Punkt nachschlägt (die Metadaten-Migration).
RUNTIME_FIELDS = EDGE_FIELDS + ("long_term_cadence_s",)


def runtime_projection(catalog: dict[str, Any], version: str) -> list[dict[str, Any]]:
    """Die Punkte, wie Box und Writer sie sehen, gestempelt mit dem Laufzeitstand `version`."""
    return [
        {key: (version if key == "catalog_version" else point[key])
         for key in RUNTIME_FIELDS if key in point}
        for point in catalog["points"]
    ]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    result = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    return result or "unnamed"


def width_bits_from_type(value_type: str | None) -> int | None:
    if not value_type:
        return None
    cleaned = value_type.replace("&lt;", "<").replace("&gt;", ">")
    cleaned = re.sub(r"^(optional|get:)<*", "", cleaned).strip(" >")
    if cleaned == "bool":
        return 1
    if "double" in cleaned or "uint64" in cleaned or "int64" in cleaned:
        return 64
    if "float" in cleaned or "uint32" in cleaned or "int32" in cleaned or "milliseconds" in cleaned:
        return 32
    if "uint16" in cleaned or "int16" in cleaned:
        return 16
    if "uint8" in cleaned or "int8" in cleaned:
        return 8
    return None


def signed_from_type(value_type: str | None) -> bool | None:
    if not value_type:
        return None
    cleaned = value_type.lower()
    if "|" in cleaned or any(token in cleaned for token in ("string", "legacy", "json", "array", "object")):
        return None
    if "uint" in cleaned or "bool" in cleaned or "bitfield" in cleaned or "enum" in cleaned or "acc" in cleaned or "count" in cleaned:
        return False
    if "int" in cleaned or "float" in cleaned or "double" in cleaned or "sunssf" in cleaned:
        return True
    return None


def base_point(
    *,
    family: str,
    point_key: str,
    source_kind: str,
    address: dict[str, Any] | None,
    selector: str,
    width_bits: int | None,
    value_type: str,
    signed: bool | None,
    endian: str | None,
    scale: dict[str, Any],
    unit: str | None,
    group: str,
    label_de: str | None,
    label_source: str | None,
    semantic_status: str,
    aggregation_kind: str,
    default_cadence_s: int | None,
    min_cadence_s: int | None,
    long_term_cadence_s: int | None,
    poll_group: str,
    source: dict[str, Any],
    **extra: Any,
) -> dict[str, Any]:
    point_key_aliases = extra.pop("point_key_aliases", [])
    point = {
        "address": address,
        "aggregation_kind": aggregation_kind,
        "catalog_version": CATALOG_VERSION,
        "default_cadence_s": default_cadence_s,
        "edge_min_version": EDGE_MIN_VERSION,
        "endian": endian,
        "family": family,
        "group": group,
        "label_de": label_de,
        "label_source": label_source,
        "long_term_cadence_s": long_term_cadence_s,
        "min_cadence_s": min_cadence_s,
        "point_key": point_key,
        "point_key_aliases": point_key_aliases,
        "poll_group": poll_group,
        "scale": scale,
        "selector": selector,
        "semantic_status": semantic_status,
        "signed": signed,
        "source_commit": source.get("source_commit"),
        "source_kind": source_kind,
        "source_revision": source.get("source_revision"),
        "source_sha256": source["source_sha256"],
        "source_url": source["source_url"],
        "unit": unit,
        "value_type": value_type,
        "width_bits": width_bits,
    }
    point.update(extra)
    return point


def source_file(source: dict[str, Any], relative: str | None = None) -> Path:
    path = relative or source["path"]
    return ROOT / path
