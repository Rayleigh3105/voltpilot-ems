#!/usr/bin/env python3
"""Validate and list proven core/catalog register pairs; package CLOUD metadata only."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from cataloglib import runtime_projection

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / "core-channel-mirrors.json"
WRITER = REPO / "services/timescale-writer/src/main/resources/core-channel-mirrors.json"


def validated() -> dict:
    data = json.loads(SOURCE.read_text())
    version = (ROOT / "VERSION").read_text().strip()
    catalog = json.loads((ROOT / "dist" / f"measurement-point-catalog-{version}.json").read_text())
    points = {p["point_key"]: p for p in catalog["points"]}
    templates = json.loads((REPO / "services/api/src/main/resources/componenttemplates/builtin.json").read_text())
    families = {t["family"] for t in templates["templates"]}
    types = json.loads((REPO / "services/api/src/main/resources/entitytypes/catalog.json").read_text())
    channels = {t["type"]: {c["channel"] for c in t.get("default_measure", [])} for t in types["types"]}
    assert data["schema_version"] == "1.1"
    # Eine Auswahl trägt den Laufzeitstand, unter dem sie gespeichert wurde; der Writer erkennt den
    # Spiegel an JEDEM hier genannten Stand. Genannt wird nur, wessen Box-Sicht aller Registerpaare
    # gleich der heutigen ist — sonst verlöre eine Bestandsauswahl nach einer Hebung still `spiegel`.
    versions = data["runtime_catalog_versions"]
    runtime = catalog["runtime_catalog_version"]
    assert versions == sorted(set(versions), key=lambda v: tuple(int(x) for x in v.split("."))), versions
    assert versions[-1] == runtime, f"newest mirror version {versions[-1]} is not the runtime {runtime}"
    mapped = {m["point_key"] for m in data["mappings"]}
    heute = {p["point_key"]: p for p in runtime_projection(catalog, runtime) if p["point_key"] in mapped}
    for version in versions:
        frueher = json.loads((ROOT / "dist" / f"measurement-point-catalog-{version}.json").read_text())
        damals = {p["point_key"]: p for p in runtime_projection(frueher, version) if p["point_key"] in mapped}
        for key in sorted(mapped):
            ohne_stand = lambda p: {k: v for k, v in p.items() if k != "catalog_version"}  # noqa: E731
            assert key in damals and ohne_stand(damals[key]) == ohne_stand(heute[key]), (
                f"box view of {key} differs in runtime {version}; it cannot mirror there")
    seen = set()
    for m in data["mappings"]:
        identity = (m["family"], m["entity_type"], m["channel"], m["point_key"])
        assert identity not in seen, f"duplicate mapping: {identity}"
        seen.add(identity)
        assert m["family"] in families, f"unknown registry family: {identity}"
        assert m["channel"] in channels.get(m["entity_type"], set()), f"unknown core channel: {identity}"
        point = points[m["point_key"]]
        assert m["address"] == point["address"], f"register drift: {identity}"
        assert m["selector"] == point["selector"], f"selector drift: {identity}"
        assert point["aggregation_kind"] == "gauge"
        assert hashlib.sha256((REPO / m["driver"]).read_bytes()).hexdigest() == m["driver_sha256"], (
            f"core decoder changed; review register evidence: {m['driver']}")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="package verified metadata for the cloud writer")
    args = parser.parse_args()
    data = validated()
    if args.write:
        WRITER.write_bytes(SOURCE.read_bytes())
    assert WRITER.read_bytes() == SOURCE.read_bytes(), "cloud writer metadata drift; run --write"
    for m in data["mappings"]:
        print(f"{m['family']} / {m['entity_type']} / {m['channel']} <-> {m['point_key']} / {m['selector']}")
    print(f"{len(data['mappings'])} proven register pairs; potential paths, not a live double-count inventory")


if __name__ == "__main__":
    main()
