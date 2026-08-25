#!/usr/bin/env python3
"""Reconcile the append-only Deye point-key lock with pinned source maps.

The lock is the historical identity contract. Existing point keys and aliases
are never rewritten automatically. Source locator/fingerprint aliases are added
when a source label/group or decoder changes; genuinely new points receive a
new, immediately collision-proof key.
"""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
from typing import Any, Iterable

from cataloglib import ROOT, canonical_json_bytes, read_json
from generate import (
    DEYE_KEY_LOCK_PATH,
    MANIFEST_PATH,
    deye_source_records,
    load_deye_document,
)


def allocate_point_key(record: dict[str, Any], used: set[str]) -> str:
    candidate = record["legacy_point_key"]
    if candidate not in used:
        return candidate
    addresses = record["registers"] or record["derived_registers"]
    suffix = f"r{addresses[0]:04x}" if addresses else f"h{record['lock_fingerprint'][:8]}"
    candidate = record["legacy_point_key"].split("@", 1)[0] + "@" + suffix
    if candidate not in used:
        return candidate
    for length in range(10, 65, 2):
        candidate = record["legacy_point_key"].split("@", 1)[0] + "@h" + record["lock_fingerprint"][:length]
        if candidate not in used:
            return candidate
    raise ValueError(f"unable to allocate a unique Deye key for {record['source_locator']}")


def reconcile_deye_key_lock(
    existing: dict[str, Any], source_documents: Iterable[tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, Any]:
    result = copy.deepcopy(existing)
    result.setdefault("schema_version", "1.0")
    entries = result.setdefault("entries", [])
    for entry in entries:
        entry["active"] = False

    current: list[tuple[str, dict[str, Any]]] = []
    current_locators: set[tuple[str, str]] = set()
    for source, document in source_documents:
        for record in deye_source_records(source, document):
            current.append((source["family"], record))
            current_locators.add((source["family"], record["source_locator"]))

    used_entries: set[int] = set()
    used_keys = {entry["point_key"] for entry in entries}
    for family, record in current:
        locator = record["source_locator"]
        fingerprint = record["lock_fingerprint"]
        exact = [
            entry for entry in entries
            if entry["family"] == family
            and locator in entry["source_locators"]
            and fingerprint in entry["fingerprints"]
        ]
        if len(exact) == 1:
            entry = exact[0]
        elif len(exact) > 1:
            raise ValueError(f"ambiguous Deye lock entry for {family}/{locator}")
        else:
            by_locator = [
                entry for entry in entries
                if id(entry) not in used_entries
                and entry["family"] == family
                and locator in entry["source_locators"]
            ]
            by_fingerprint = [
                entry for entry in entries
                if id(entry) not in used_entries
                and entry["family"] == family
                and fingerprint in entry["fingerprints"]
                and not any((family, old) in current_locators for old in entry["source_locators"])
            ]
            if len(by_locator) == 1:
                entry = by_locator[0]
                entry["fingerprints"] = sorted(set((*entry["fingerprints"], fingerprint)))
            elif len(by_fingerprint) == 1:
                entry = by_fingerprint[0]
                entry["source_locators"] = sorted(set((*entry["source_locators"], locator)))
            elif by_locator or by_fingerprint:
                raise ValueError(f"ambiguous Deye source change for {family}/{locator}")
            else:
                point_key = allocate_point_key(record, used_keys)
                entry = {
                    "active": True,
                    "aliases": [],
                    "family": family,
                    "fingerprints": [fingerprint],
                    "point_key": point_key,
                    "source_locators": [locator],
                }
                entries.append(entry)
                used_keys.add(point_key)
        if id(entry) in used_entries:
            raise ValueError(f"one Deye lock entry matched multiple source points: {entry['point_key']}")
        entry["active"] = True
        used_entries.add(id(entry))

    entries.sort(key=lambda entry: (entry["family"], entry["point_key"]))
    return result


def build_from_pinned_sources(existing: dict[str, Any]) -> dict[str, Any]:
    manifest = read_json(MANIFEST_PATH)
    sources = [source for source in manifest["sources"] if source["adapter"] == "deye"]
    return reconcile_deye_key_lock(
        existing,
        ((source, load_deye_document(source)) for source in sources),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed lock differs")
    args = parser.parse_args()
    existing = read_json(DEYE_KEY_LOCK_PATH) if DEYE_KEY_LOCK_PATH.exists() else {"schema_version": "1.0", "entries": []}
    rendered = canonical_json_bytes(build_from_pinned_sources(existing))
    if args.check:
        if not DEYE_KEY_LOCK_PATH.exists() or DEYE_KEY_LOCK_PATH.read_bytes() != rendered:
            raise SystemExit(f"Deye point-key lock drift: run {Path(__file__).relative_to(ROOT)} and review the diff")
    else:
        DEYE_KEY_LOCK_PATH.write_bytes(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
