#!/usr/bin/env python3
"""Validate the direct-marketer catalog: schema plus the project invariants.

The schema checks the form (profile.schema.json). This file checks what a
schema cannot say: every register meaning is in the vocabulary (or correctly
left for a future partner), every 'offen (Fxx)' / '<wert> (Fxx)' marker names a
real open question, no two registers of the same table overlap, a band is
sane and the rest value sits inside it, and every step name in 'einrichtung'
is a known step.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from profilelib import PROFILE_SCHEMA, VOCABULARY, SchemaValidationError, load_json, profile_paths, split_offen, validate_json_schema

WIDTH = {"u16": 1, "s16": 1, "u32": 2, "s32": 2}


def _register_errors(pid: str, registers: list[dict[str, Any]], known_bedeutungen: set[str], vorgesehen: set[str]) -> list[str]:
    errors: list[str] = []
    seen_bedeutung: set[str] = set()
    occupied: dict[str, list[tuple[int, int, str]]] = {"input": [], "holding": []}
    for reg in registers:
        bedeutung = reg["bedeutung"]
        if bedeutung in vorgesehen:
            errors.append(f"{pid}.register: bedeutung {bedeutung!r} ist für einen späteren Partner vorgesehen, noch nicht aktiv")
        elif bedeutung not in known_bedeutungen:
            errors.append(f"{pid}.register: bedeutung {bedeutung!r} ist nicht im Vokabular")
        if bedeutung in seen_bedeutung:
            errors.append(f"{pid}.register: bedeutung {bedeutung!r} steht mehr als einmal")
        seen_bedeutung.add(bedeutung)

        width = WIDTH[reg["typ"]]
        start, end = reg["adresse"], reg["adresse"] + width
        table = reg["tabelle"]
        for other_start, other_end, other_bedeutung in occupied[table]:
            if start < other_end and other_start < end:
                errors.append(f"{pid}.register: {bedeutung!r} ({table} {start}-{end - 1}) überlappt {other_bedeutung!r} ({table} {other_start}-{other_end - 1})")
        occupied[table].append((start, end, bedeutung))

        band = reg.get("band")
        if band is not None:
            lo, hi = band
            if lo > hi:
                errors.append(f"{pid}.register: {bedeutung!r}: band [{lo}, {hi}] ist leer")
            if lo < 0:
                errors.append(f"{pid}.register: {bedeutung!r}: band beginnt unter 0")
    return errors


def _offen_errors(pid: str, where: str, value: str, fragen: dict[str, str]) -> list[str]:
    _, frage = split_offen(value)
    if frage is None:
        return []
    if frage not in fragen:
        return [f"{pid}.{where}: offene Frage {frage!r} steht nicht im Vokabular"]
    return []


def validate_profile(profile: dict[str, Any], name: str, schema: dict[str, Any], vocabulary: dict[str, Any]) -> list[str]:
    try:
        validate_json_schema(profile, schema, name)
    except SchemaValidationError as exc:
        return [str(exc)]
    errors: list[str] = []
    pid = profile["partner"]
    if name != f"{pid}.json":
        errors.append(f"{name}: Dateiname muss {pid}.json sein")

    known = set(vocabulary["bedeutungen"])
    vorgesehen = set(vocabulary["vorgesehen"])
    errors += _register_errors(pid, profile["register"], known, vorgesehen)

    fragen = vocabulary["fragen"]
    errors += _offen_errors(pid, "zugang.vpn.port_protokoll", profile["zugang"]["vpn"]["port_protokoll"], fragen)
    errors += _offen_errors(pid, "zugang.modbus.wortfolge", profile["zugang"]["modbus"]["wortfolge"], fragen)
    for feld in ("vorgabe_wirkt_auf", "referenz", "bei_veraltet"):
        errors += _offen_errors(pid, f"regeln.{feld}", profile["regeln"][feld], fragen)

    setpoint_band = None
    for reg in profile["register"]:
        if reg["bedeutung"] == "vermarkter_vorgabe_pct":
            setpoint_band = reg.get("band")
    if setpoint_band is not None:
        lo, hi = setpoint_band
        if not (lo <= profile["regeln"]["ruhewert_pct"] <= hi):
            errors.append(f"{pid}.regeln.ruhewert_pct: {profile['regeln']['ruhewert_pct']} liegt außerhalb des Bands [{lo}, {hi}] von vermarkter_vorgabe_pct")

    schritte = set(vocabulary["einrichtung_schritte"])
    for block in ("vorher", "zugang", "nachher"):
        for schritt in profile["einrichtung"][block]:
            if schritt not in schritte:
                errors.append(f"{pid}.einrichtung.{block}: Schritt {schritt!r} ist nicht im Vokabular")

    return errors


def validate_catalog(profiles_dir: Path | None = None) -> list[str]:
    schema = load_json(PROFILE_SCHEMA)
    vocabulary = load_json(VOCABULARY)
    errors: list[str] = []
    overlap = set(vocabulary["bedeutungen"]) & set(vocabulary["vorgesehen"])
    if overlap:
        errors.append(f"vocabulary: {sorted(overlap)} stehen sowohl bei bedeutungen als auch bei vorgesehen")

    paths = sorted(profiles_dir.glob("*.json")) if profiles_dir else profile_paths()
    if not paths:
        errors.append("profiles: keine gefunden")
    for path in paths:
        profile = load_json(path)
        errors += validate_profile(profile, path.name, schema, vocabulary)
    return errors


def main() -> int:
    errors = validate_catalog()
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        return 1
    print(f"direktvermarkter profiles valid: {len(profile_paths())} profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
