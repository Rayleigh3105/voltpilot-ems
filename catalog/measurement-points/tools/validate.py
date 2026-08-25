#!/usr/bin/env python3
"""Offline semantic validation for a generated measurement-point catalog."""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path
from typing import Any

from cataloglib import CATALOG_VERSION, EDGE_MIN_VERSION, POINT_KEY_RE, ROOT, read_json, sha256
from generate import DEFAULT_OUTPUT, MANIFEST_PATH, verify_source_hashes


REQUIRED_POINT_FIELDS = {
    "address", "aggregation_kind", "catalog_version", "default_cadence_s", "edge_min_version",
    "endian", "family", "group", "label_de", "label_source", "long_term_cadence_s",
    "min_cadence_s", "point_key", "poll_group", "readable", "scale", "selector",
    "semantic_status", "signed", "source_commit", "source_kind", "source_revision",
    "source_sha256", "source_url", "unit", "value_type", "width_bits",
}
SOURCE_KINDS = {
    "modbus_holding", "sunspec_model", "http_api_key", "rest_json", "rpc_json",
    "ocpp_sampled_value",
}
AGGREGATIONS = {"gauge", "counter", "state", "event", "bitfield", "text", "none"}
SEMANTIC_STATUSES = {"known", "vendor_label_only", "unknown"}
SCALE_KINDS = {"none", "factor", "divisor", "conditional_factor", "sunssf", "protocol_value"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DYNAMIC_OFFSET_RE = re.compile(r"^[0-9]+\+index\*[1-9][0-9]*\+[0-9]+$")


class ValidationErrors:
    def __init__(self) -> None:
        self.messages: list[str] = []

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.messages.append(message)

    def finish(self) -> None:
        if self.messages:
            rendered = "\n".join(f"- {message}" for message in self.messages[:100])
            extra = len(self.messages) - 100
            if extra > 0:
                rendered += f"\n- ... and {extra} more"
            raise ValueError(f"catalog validation failed:\n{rendered}")


def is_optional_non_negative_int(value: Any) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


def validate_manifest(errors: ValidationErrors) -> dict[str, Any]:
    manifest = read_json(MANIFEST_PATH)
    errors.check(manifest.get("schema_version") == "1.0", "source manifest schema_version must be 1.0")
    sources = manifest.get("sources")
    errors.check(isinstance(sources, list) and bool(sources), "source manifest needs a non-empty sources list")
    ids: list[str] = []
    for index, source in enumerate(sources if isinstance(sources, list) else []):
        prefix = f"source[{index}]"
        source_id = source.get("id")
        ids.append(source_id)
        errors.check(isinstance(source_id, str) and bool(source_id), f"{prefix} has no id")
        errors.check(source.get("adapter") in {"deye", "sunspec", "goe", "shelly", "ocpp"}, f"{prefix} has an unsupported adapter")
        errors.check(bool(source.get("source_commit") or source.get("source_revision")), f"{prefix} has neither commit nor revision")
        if source.get("adapter") == "sunspec":
            errors.check(len(source.get("models", [])) == 19, "SunSpec manifest must pin 19 models")
            for model in source.get("models", []):
                errors.check(
                    isinstance(model, list) and len(model) == 2 and isinstance(model[0], int)
                    and isinstance(model[1], str) and bool(SHA256_RE.fullmatch(model[1])),
                    f"{prefix} contains an invalid model pin",
                )
        else:
            source_hash = source.get("source_sha256")
            errors.check(isinstance(source_hash, str) and bool(SHA256_RE.fullmatch(source_hash)), f"{prefix} has an invalid source hash")
    errors.check(len(ids) == len(set(ids)), "source manifest contains duplicate ids")
    try:
        verify_source_hashes(manifest)
    except (OSError, ValueError) as exc:
        errors.check(False, str(exc))
    return manifest


def validate_address(errors: ValidationErrors, point: dict[str, Any], prefix: str) -> None:
    address = point.get("address")
    source_kind = point.get("source_kind")
    if address is None:
        errors.check(source_kind not in {"sunspec_model"}, f"{prefix}: SunSpec address may not be null")
        return
    errors.check(isinstance(address, dict), f"{prefix}: address must be an object or null")
    if not isinstance(address, dict):
        return
    if source_kind == "modbus_holding":
        registers = address.get("registers")
        errors.check(address.get("kind") == "modbus_holding", f"{prefix}: wrong Modbus address kind")
        errors.check(isinstance(registers, list) and bool(registers), f"{prefix}: Modbus registers must not be empty")
        if isinstance(registers, list):
            errors.check(all(isinstance(register, int) and 0 <= register <= 65535 for register in registers), f"{prefix}: invalid Modbus register")
            errors.check(len(registers) == len(set(registers)), f"{prefix}: duplicate register within address")
            errors.check(address.get("width_words") == len(registers), f"{prefix}: Modbus width_words mismatch")
            errors.check(point.get("width_bits") == len(registers) * 16, f"{prefix}: Modbus width_bits mismatch")
        errors.check(point.get("endian") == "word_little_byte_big", f"{prefix}: Deye endian must reflect the pinned decoder")
    elif source_kind == "sunspec_model":
        model_id = address.get("model_id")
        offset = address.get("offset_words")
        errors.check(address.get("kind") == "sunspec_relative", f"{prefix}: wrong SunSpec address kind")
        errors.check(address.get("base") == "discovered", f"{prefix}: SunSpec bases must remain discovered")
        errors.check(point.get("family") == f"sunspec.model_{model_id}", f"{prefix}: SunSpec model/family mismatch")
        errors.check(
            (isinstance(offset, int) and offset >= 0)
            or (isinstance(offset, str) and bool(DYNAMIC_OFFSET_RE.fullmatch(offset))),
            f"{prefix}: invalid SunSpec relative offset",
        )
        width_words = address.get("width_words")
        errors.check(isinstance(width_words, int) and width_words > 0, f"{prefix}: invalid SunSpec width")
        if isinstance(width_words, int):
            errors.check(point.get("width_bits") == width_words * 16, f"{prefix}: SunSpec width_bits mismatch")
        errors.check(point.get("endian") == "big", f"{prefix}: SunSpec endian must be big")
    else:
        errors.check(False, f"{prefix}: {source_kind} may not have a register address")


def validate_point(errors: ValidationErrors, point: Any, index: int) -> None:
    prefix = f"point[{index}]"
    errors.check(isinstance(point, dict), f"{prefix} must be an object")
    if not isinstance(point, dict):
        return
    point_key = point.get("point_key")
    prefix = point_key if isinstance(point_key, str) else prefix
    missing = REQUIRED_POINT_FIELDS - point.keys()
    errors.check(not missing, f"{prefix}: missing fields {sorted(missing)}")
    errors.check(isinstance(point_key, str) and bool(POINT_KEY_RE.fullmatch(point_key)), f"{prefix}: invalid point_key")
    errors.check(point.get("catalog_version") == CATALOG_VERSION, f"{prefix}: catalog_version mismatch")
    errors.check(point.get("edge_min_version") == EDGE_MIN_VERSION, f"{prefix}: edge_min_version mismatch")
    errors.check(point.get("source_kind") in SOURCE_KINDS, f"{prefix}: invalid source_kind")
    errors.check(point.get("semantic_status") in SEMANTIC_STATUSES, f"{prefix}: invalid semantic_status")
    errors.check(point.get("aggregation_kind") in AGGREGATIONS, f"{prefix}: invalid aggregation_kind")
    errors.check(isinstance(point.get("family"), str) and bool(point.get("family")), f"{prefix}: missing family")
    errors.check(isinstance(point.get("selector"), str) and bool(point.get("selector")), f"{prefix}: missing selector")
    errors.check(isinstance(point.get("poll_group"), str) and bool(point.get("poll_group")), f"{prefix}: missing poll_group")
    errors.check(isinstance(point.get("value_type"), str) and bool(point.get("value_type")), f"{prefix}: missing value_type")
    errors.check(isinstance(point.get("readable"), bool), f"{prefix}: readable must be boolean")
    errors.check(point.get("signed") is None or isinstance(point.get("signed"), bool), f"{prefix}: signed must be boolean or null")
    errors.check(is_optional_non_negative_int(point.get("width_bits")), f"{prefix}: invalid width_bits")
    for field in ("default_cadence_s", "min_cadence_s", "long_term_cadence_s"):
        errors.check(is_optional_non_negative_int(point.get(field)), f"{prefix}: invalid {field}")
    default = point.get("default_cadence_s")
    minimum = point.get("min_cadence_s")
    errors.check(default is None or minimum is not None, f"{prefix}: default cadence needs a minimum")
    errors.check(default is None or minimum <= default, f"{prefix}: minimum cadence exceeds default")
    scale = point.get("scale")
    errors.check(isinstance(scale, dict) and scale.get("kind") in SCALE_KINDS, f"{prefix}: invalid scale")
    errors.check(isinstance(point.get("source_sha256"), str) and bool(SHA256_RE.fullmatch(point.get("source_sha256", ""))), f"{prefix}: invalid source hash")
    errors.check(isinstance(point.get("source_url"), str) and point.get("source_url", "").startswith("https://"), f"{prefix}: invalid source URL")
    errors.check(bool(point.get("source_commit") or point.get("source_revision")), f"{prefix}: missing source version")
    if point.get("semantic_status") == "unknown":
        errors.check(point.get("label_de") is None, f"{prefix}: unknown semantic may not invent a German label")
    if point.get("source_kind") == "http_api_key":
        errors.check(point.get("unit") is None, f"{prefix}: go-e unit must stay unknown instead of inferred")
    validate_address(errors, point, prefix)


def validate_catalog(path: Path) -> dict[str, Any]:
    errors = ValidationErrors()
    validate_manifest(errors)
    document = read_json(path)
    errors.check(document.get("schema_version") == "1.0", "catalog schema_version must be 1.0")
    errors.check(document.get("catalog_version") == CATALOG_VERSION, "root catalog_version mismatch")
    errors.check(document.get("edge_min_version") == EDGE_MIN_VERSION, "root edge_min_version mismatch")
    errors.check(document.get("source_manifest_sha256") == sha256(MANIFEST_PATH), "source manifest hash mismatch")
    points = document.get("points")
    errors.check(isinstance(points, list) and bool(points), "catalog needs a non-empty points list")
    points = points if isinstance(points, list) else []
    for index, point in enumerate(points):
        validate_point(errors, point, index)

    keys = [point.get("point_key") for point in points if isinstance(point, dict)]
    errors.check(keys == sorted(keys), "points must be sorted by point_key")
    errors.check(len(keys) == len(set(keys)), "duplicate point_key")

    selectors: collections.defaultdict[tuple[str, str], list[str]] = collections.defaultdict(list)
    modbus_decoders: collections.defaultdict[tuple[str, tuple[int, ...], str], list[str]] = collections.defaultdict(list)
    for point in points:
        if not isinstance(point, dict):
            continue
        if point.get("source_kind") != "modbus_holding":
            selectors[(point.get("family"), point.get("selector"))].append(point.get("point_key"))
        address = point.get("address")
        if point.get("source_kind") == "modbus_holding" and isinstance(address, dict):
            key = (
                point.get("family"), tuple(address.get("registers", [])),
                json.dumps(point.get("decoder"), ensure_ascii=False, sort_keys=True),
            )
            modbus_decoders[key].append(point.get("point_key"))
    errors.check(not any(len(values) > 1 for values in selectors.values()), "duplicate selector within a non-Deye family")
    errors.check(not any(len(values) > 1 for values in modbus_decoders.values()), "duplicate Deye address and decoder")

    expected_counts = collections.Counter(point.get("family") for point in points if isinstance(point, dict))
    expected_templates = collections.Counter(
        point.get("family") for point in points if isinstance(point, dict) and point.get("dynamic")
    )
    families = document.get("families")
    errors.check(isinstance(families, list), "families must be a list")
    if isinstance(families, list):
        names = [family.get("family") for family in families]
        errors.check(names == sorted(names) and len(names) == len(set(names)), "families must be sorted and unique")
        for family in families:
            name = family.get("family")
            errors.check(family.get("point_count") == expected_counts[name], f"{name}: point_count mismatch")
            errors.check(family.get("template_count") == expected_templates[name], f"{name}: template_count mismatch")

    model_160 = [point for point in points if point.get("family") == "sunspec.model_160"]
    dynamic_160 = [point for point in model_160 if point.get("dynamic")]
    errors.check(len(model_160) == 19 and len(dynamic_160) == 10, "SunSpec model 160 must retain 9 root and 10 per-module points")
    errors.check(all("module[*]" in point["point_key"] for point in dynamic_160), "SunSpec model 160 dynamic keys must be per-module")
    errors.check(all(isinstance(point["address"]["offset_words"], str) for point in dynamic_160), "SunSpec model 160 module offsets must stay dynamic")

    ocpp = [point for point in points if point.get("family") == "ocpp.1_6"]
    errors.check(len(ocpp) == 22, "OCPP 1.6 must contain 22 measurands")
    if ocpp:
        dimensions = ocpp[0].get("dimensions", {})
        errors.check(len(dimensions.get("contexts", [])) == 8, "OCPP context count mismatch")
        errors.check(len(dimensions.get("formats", [])) == 2, "OCPP format count mismatch")
        errors.check(len(dimensions.get("phases", [])) == 10, "OCPP phase count mismatch")
        errors.check(len(dimensions.get("locations", [])) == 5, "OCPP location count mismatch")
        errors.check(all(point.get("dimensions") == dimensions for point in ocpp), "OCPP dimensions differ between measurands")

    errors.finish()
    return document


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    document = validate_catalog(args.catalog)
    print(f"validated {len(document['points'])} points in catalog {document['catalog_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
