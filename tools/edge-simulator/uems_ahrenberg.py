#!/usr/bin/env python3
"""Offline UEMS scenario with the two Ahrenberg boxes and their data sources.

The scenario deliberately has no broker dependency.  It reads the canonical
reference company, resolves the time-valid source assignments and emits the
same ``data_sources`` heartbeat blocks that a real edge sends.  This makes it
usable from unit tests and Testcontainers fixtures without credentials.
"""

from __future__ import annotations

import argparse
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import cast


REFERENCE = Path(__file__).resolve().parents[2] / "docs/contracts/v2/uems-referenzunternehmen.json"
DEFAULT_AT = "2026-10-20T10:15:00+02:00"
TENANT_NAMESPACE = uuid.UUID("36e63b7e-a37b-55bf-9eac-a3b70ea3427c")


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp requires an offset: {value}")
    return parsed.astimezone(timezone.utc)


def _identity(kind: str, key: str) -> str:
    return str(uuid.uuid5(TENANT_NAMESPACE, f"ahrenberg:{kind}:{key}"))


@dataclass(frozen=True)
class Source:
    code: str
    site: str
    protocol: str
    address: str
    port: int | None
    network: str
    cadence_s: int
    channels: int
    control_source: bool


@dataclass(frozen=True)
class Box:
    code: str
    name: str
    serial: str
    site: str
    device_id: str


@dataclass(frozen=True)
class Read:
    source: str
    box: str
    at: str


class AhrenbergScenario:
    """Time-aware, deterministic two-edge fixture for Werk Ahrenberg."""

    def __init__(self, document: dict):
        self.document = document
        self.tenant_id = _identity("tenant", "Kunststoffwerk Ahrenberg GmbH")
        self.site_id = _identity("standort", "ST-1")
        self.sources = {
            item["kennzeichen"]: Source(
                code=item["kennzeichen"],
                site=item["anlage"],
                protocol=item["protokoll"],
                address=item["adresse"],
                port=item.get("port"),
                network=item["netz"],
                cadence_s=item["kadenz_s"],
                channels=item["kanaele"],
                control_source=item["steuerquelle"],
            )
            for item in document["datenquellen"]
        }
        self.boxes = {
            item["kennzeichen"]: Box(
                code=item["kennzeichen"],
                name=item["name"],
                serial=item["seriennummer"],
                site=item["heimat_anlage"],
                device_id=_identity("box", item["seriennummer"]),
            )
            for item in document["boxen"]
        }
        self.assignments = tuple(
            item for item in document["zuordnungen"]
            if item["art"] == "datenquelle_box"
        )

    @classmethod
    def load(cls, path: Path = REFERENCE) -> "AhrenbergScenario":
        with path.open(encoding="utf-8") as handle:
            return cls(json.load(handle))

    def box_for(self, source: str, at: str) -> Box | None:
        moment = _instant(at)
        matches = []
        for assignment in self.assignments:
            if assignment["von"] != source:
                continue
            start = _instant(assignment["gueltig_ab"])
            end = _instant(assignment["gueltig_bis"]) if assignment["gueltig_bis"] else None
            if start <= moment and (end is None or moment < end):
                matches.append(self.boxes[assignment["nach"]])
        if len(matches) > 1:
            raise ValueError(f"overlapping assignments for {source} at {at}")
        return matches[0] if matches else None

    def werk_ahrenberg_boxes(self, at: str = DEFAULT_AT) -> tuple[Box, Box]:
        """The active readers for AN-1/AN-2, never the separate Lindach site."""
        assigned = {
            box.code: box
            for code in ("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5")
            if (box := self.box_for(code, at)) is not None
        }
        boxes = tuple(sorted(assigned.values(), key=lambda item: item.code))
        if len(boxes) != 2:
            raise ValueError(f"expected two active Werk Ahrenberg boxes at {at}, got {len(boxes)}")
        return cast(tuple[Box, Box], boxes)

    def source_codes(self, box: str, at: str = DEFAULT_AT) -> tuple[str, ...]:
        return tuple(sorted(
            code for code in ("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5")
            if (assigned := self.box_for(code, at)) is not None and assigned.code == box
        ))

    def reads(self, at: str = DEFAULT_AT) -> tuple[Read, ...]:
        """One reading per active source; assignment makes double-reading impossible."""
        return tuple(
            Read(source=source, box=box.code, at=at)
            for source in ("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5")
            if (box := self.box_for(source, at)) is not None
        )

    def heartbeat(self, box: str, at: str = DEFAULT_AT, *, online: bool = True) -> dict:
        edge = self.boxes[box]
        sources = []
        if online:
            for code in self.source_codes(box, at):
                source = self.sources[code]
                sources.append({
                    "id": code,
                    "health": "ok",
                    "read_at": _instant(at).isoformat().replace("+00:00", "Z"),
                    "requests_per_min": max(1, 60 // source.cadence_s),
                    "samples_per_min": max(1, 60 // source.cadence_s) * source.channels,
                })
        return {
            "schema_version": "1.0",
            "tenant_id": self.tenant_id,
            "site_id": self.site_id,
            "device_id": edge.device_id,
            "ts": _instant(at).isoformat().replace("+00:00", "Z"),
            "status": "online" if online else "offline",
            "data_sources": sources,
        }

    def assignment_allowed(self, source: str, target_box: str) -> tuple[bool, str | None]:
        if target_box not in self.boxes:
            raise KeyError(target_box)
        if self.sources[source].control_source:
            return False, "steuerquelle"
        return True, None

    def snapshot(self, at: str = DEFAULT_AT, *, offline_box: str | None = None) -> dict:
        boxes = self.werk_ahrenberg_boxes(at)
        return {
            "scenario": "Kunststoffwerk Ahrenberg GmbH",
            "at": at,
            "boxes": [
                self.heartbeat(box.code, at, online=box.code != offline_box)
                | {"code": box.code, "name": box.name, "serial": box.serial}
                for box in boxes
            ],
            "reads": [vars(read) for read in self.reads(at)],
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Two-box UEMS simulator for the Ahrenberg reference company")
    parser.add_argument("--at", default=DEFAULT_AT, help="offset timestamp used to resolve assignments")
    parser.add_argument("--offline-box", choices=("E-1", "E-2", "E-2′"))
    parser.add_argument("--reference", type=Path, default=REFERENCE)
    args = parser.parse_args(argv)
    scenario = AhrenbergScenario.load(args.reference)
    print(json.dumps(scenario.snapshot(args.at, offline_box=args.offline_box), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
