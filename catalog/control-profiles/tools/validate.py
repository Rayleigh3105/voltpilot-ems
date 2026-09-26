#!/usr/bin/env python3
"""Validate the control-profile catalog: schemas plus the project invariants.

The schemas check the form. This file checks what a schema cannot say:
every source reference resolves, repo sources exist in the checkout, a cell
that claims A-C names a source, damping values the box USES are measured or
documented (A/B), a cell that points at an adapter sequence carries exactly
that sequence, and no two profiles can bind the same device.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from profilelib import (
    MANIFEST, MANIFEST_SCHEMA, PROFILE_SCHEMA, REPO, VOCABULARY, SchemaValidationError, load_json, profile_paths,
    validate_json_schema,
)

TEXT_BLOCKS = ("zaehler", "eigenmodus", "uebergabe", "totmann", "schreibbudget")
PERSISTENT = {"dauerspeicher", "gemischt", "unbelegt"}


def _bindings_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["marke"] != b["marke"] or a["registerfamilie"] != b["registerfamilie"]:
        return False
    if a["steuerpfad"] is not None and b["steuerpfad"] is not None and a["steuerpfad"] != b["steuerpfad"]:
        return False
    if a["modelle"] is not None and b["modelle"] is not None and not set(a["modelle"]) & set(b["modelle"]):
        return False
    return True


def validate_vocabulary(vocabulary: dict[str, Any], profile_schema: dict[str, Any], known: set[str]) -> list[str]:
    errors: list[str] = []
    cell = profile_schema["$defs"]["zelle"]["properties"]
    if set(vocabulary["sicherheit"]) != set(profile_schema["$defs"]["sicherheit"]["enum"]):
        errors.append("vocabulary.sicherheit: differs from the schema enum")
    if set(vocabulary["hebel"]) != set(cell["hebel"]["enum"]):
        errors.append("vocabulary.hebel: differs from the schema enum")
    if set(vocabulary["rueckfall"]) != set(cell["rueckfall"]["enum"]):
        errors.append("vocabulary.rueckfall: differs from the schema enum")
    intents = [a["id"] for a in vocabulary["absichten"]] + ["G"]
    if intents != profile_schema["properties"]["absichten"]["required"]:
        errors.append("vocabulary.absichten + G: differs from the schema cells")
    if "G" not in {u["id"] for u in vocabulary["ueberlagerungen"]}:
        errors.append("vocabulary.ueberlagerungen: G (Einspeisegrenze/Abregeln) missing")
    for q in vocabulary.get("quellen", []):
        if q not in known:
            errors.append(f"vocabulary.quellen: unknown source {q!r}")
    return errors


def validate_manifest(manifest: dict[str, Any], repo: Path = REPO) -> list[str]:
    errors: list[str] = []
    try:
        validate_json_schema(manifest, load_json(MANIFEST_SCHEMA), "sources/manifest.json")
    except SchemaValidationError as exc:
        return [str(exc)]
    seen: set[str] = set()
    for source in manifest["quellen"]:
        if source["id"] in seen:
            errors.append(f"manifest: duplicate source id {source['id']!r}")
        seen.add(source["id"])
        for rel in source.get("pfade", []):
            if not (repo / rel).exists():
                errors.append(f"manifest: {source['id']}: repo path {rel!r} does not exist")
    return errors


def validate_profile(profile: dict[str, Any], name: str, schema: dict[str, Any], known: set[str]) -> list[str]:
    try:
        validate_json_schema(profile, schema, name)
    except SchemaValidationError as exc:
        return [str(exc)]
    errors: list[str] = []
    pid = profile["id"]
    if name != f"{pid}.json":
        errors.append(f"{name}: file name must be {pid}.json")

    listed = set(profile["quellen"])
    referenced: list[tuple[str, str]] = [("quellen", q) for q in profile["quellen"]]
    for key, cell in profile["absichten"].items():
        referenced += [(f"absichten.{key}", q) for q in cell["quellen"]]
        if cell["sicherheit"] != "D" and cell["hebel"] != "keiner" and not cell["quellen"]:
            errors.append(f"{pid}.absichten.{key}: sicherheit {cell['sicherheit']} needs at least one source")
    referenced += [("daempfung", q) for q in profile["daempfung"]["quellen"]]
    if profile["firmware_bedingung"] is not None:
        referenced += [("firmware_bedingung", q) for q in profile["firmware_bedingung"]["quellen"]]
    for where, q in referenced:
        if q not in known:
            errors.append(f"{pid}.{where}: source {q!r} is not in sources/manifest.json")
        elif where != "quellen" and q not in listed:
            errors.append(f"{pid}.{where}: source {q!r} missing from the profile's quellen")

    for block in TEXT_BLOCKS:
        b = profile[block]
        if (b["sicherheit"] is None) != (b["text"] == "–"):
            errors.append(f"{pid}.{block}: sicherheit is null exactly when the text is '–'")

    budget = profile["schreibbudget"]
    if budget["speicher"] in PERSISTENT and budget["dauerspeicher_je_tag"] is None:
        errors.append(f"{pid}.schreibbudget: speicher {budget['speicher']} needs dauerspeicher_je_tag")
    if budget["speicher"] not in PERSISTENT and budget["dauerspeicher_je_tag"] is not None:
        errors.append(f"{pid}.schreibbudget: speicher {budget['speicher']} writes no persistent memory")

    damp = profile["daempfung"]
    timing = (damp["einschwingzeit_s"], damp["messtakt_s"])
    if damp["box_regelt"] is not True and timing != (None, None):
        errors.append(f"{pid}.daempfung: timing values only where the box regulates")
    if timing != (None, None):
        if None in timing:
            errors.append(f"{pid}.daempfung: einschwingzeit_s and messtakt_s come together")
        if damp["sicherheit"] not in ("A", "B") or not damp["quellen"]:
            errors.append(f"{pid}.daempfung: values the box uses must be measured or documented (A/B) with a source")
    if damp["sicherheit"] is None and damp["box_regelt"] is not None:
        errors.append(f"{pid}.daempfung: sicherheit may only be null without a statement (box_regelt null)")

    totmann = profile["totmann"]
    if totmann["vorhanden"] is not True and totmann["sekunden"] is not None:
        errors.append(f"{pid}.totmann: sekunden only with vorhanden = true")

    adapter = profile["adapter"]
    if adapter is not None and "uebergabe" in adapter["folgen"]:
        folge = adapter["folgen"]["uebergabe"]
        if (profile["uebergabe"]["schreibfolge"], profile["uebergabe"]["beleg"]) != (folge["schreibfolge"], folge["beleg"]):
            errors.append(f"{pid}.uebergabe: schreibfolge/beleg differ from adapter.folgen.uebergabe")
    for key, cell in profile["absichten"].items():
        name_ = cell.get("adapter_folge")
        if name_ is None:
            continue
        if adapter is None or name_ not in adapter["folgen"]:
            errors.append(f"{pid}.absichten.{key}: adapter_folge {name_!r} does not exist")
            continue
        folge = adapter["folgen"][name_]
        if cell["schreibfolge"] != folge["schreibfolge"] or cell["beleg"] != folge["beleg"]:
            errors.append(f"{pid}.absichten.{key}: schreibfolge/beleg differ from adapter.folgen.{name_}")
    return errors


def validate_bindings(profiles: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    flat = [(p["id"], b) for p in profiles for b in (p["bindung"] or [])]
    for i, (pid_a, a) in enumerate(flat):
        for pid_b, b in flat[i + 1:]:
            if _bindings_overlap(a, b):
                errors.append(f"bindung: {pid_a} and {pid_b} both bind {a['marke']}/{a['registerfamilie']}")
    return errors


def validate_catalog(profiles_dir: Path | None = None, repo: Path = REPO) -> list[str]:
    manifest = load_json(MANIFEST)
    errors = validate_manifest(manifest, repo)
    known = {s["id"] for s in manifest["quellen"]}
    schema = load_json(PROFILE_SCHEMA)
    vocabulary = load_json(VOCABULARY)
    errors += validate_vocabulary(vocabulary, schema, known)

    paths = sorted(profiles_dir.glob("*.json")) if profiles_dir else profile_paths()
    if not paths:
        errors.append("profiles: none found")
    profiles = []
    for path in paths:
        profile = load_json(path)
        errors += validate_profile(profile, path.name, schema, known)
        profiles.append(profile)
    if not errors:
        errors += validate_bindings(profiles)

    used = set(vocabulary.get("quellen", []))
    for p in profiles:
        used |= set(p.get("quellen", []))
    for q in sorted(known - used):
        errors.append(f"manifest: source {q!r} is referenced by no profile")
    return errors


def main() -> int:
    errors = validate_catalog()
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print(f"control profiles valid: {len(profile_paths())} profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
