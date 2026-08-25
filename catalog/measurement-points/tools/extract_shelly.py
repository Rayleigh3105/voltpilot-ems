#!/usr/bin/env python3
"""Extract the Shelly normal form from frozen official documentation HTML.

The extraction spec contains only selectors and vendor-facing field facts. The
separate annotations file adds VoltPilot cadence, aggregation and German copy.
Every method, field token, type and unit is checked against the exact raw HTML
listed in the checksum-pinned raw manifest before output is produced.
"""

from __future__ import annotations

import argparse
import copy
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from cataloglib import ROOT, canonical_json_bytes, read_json, sha256


SHELLY_DIR = ROOT / "sources" / "shelly"
RAW_MANIFEST_PATH = SHELLY_DIR / "raw-manifest.json"
SPEC_PATH = SHELLY_DIR / "extraction-spec.json"
ANNOTATIONS_PATH = SHELLY_DIR / "annotations.json"
OUTPUT_PATH = SHELLY_DIR / "status-fields.json"

TYPE_EVIDENCE = {
    "array": ("array",),
    "bool": ("bool", "boolean"),
    "bool|number|null": ("bool", "number", "null"),
    "int": ("number", "integer", "int"),
    "number": ("number",),
    "object": ("object",),
    "string": ("string",),
    "uint": ("number", "integer", "uint"),
}
UNIT_EVIDENCE = {
    "%": ("%", "percent"),
    "A": ("[a]", ", a", "amps", "ampere"),
    "B": ("byte", "bytes"),
    "Hz": ("[hz]", ", hz", "hertz"),
    "K": (" in k", "kelvin"),
    "VA": ("[va]", "volt-ampere"),
    "V": ("[v]", "volts", "voltage"),
    "W": ("[w]", "watts", "power"),
    "Wh": ("[wh]", ", wh", "watt-hours", "watt hours"),
    "Wmin": ("wmin", "watt-minute"),
    "dBm": ("dbm",),
    "mWh": ("mwh", "milliwatt-hours", "milliwatt hours"),
    "s": ("seconds", ", s", "[s]"),
    "°C": ("°c", "celsius", "tc"),
    "°F": ("°f", "fahrenheit", "tf"),
}


class MarkdownTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.markdown_depth: int | None = None
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = dict(attrs).get("class") or ""
        self.depth += 1
        if tag == "div" and ({"theme-doc-markdown", "content"} & set(classes.split())):
            self.markdown_depth = self.depth
        if self.markdown_depth is not None and tag in {"br", "li", "p", "td", "th", "tr", "h1", "h2", "h3", "pre"}:
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if self.markdown_depth is not None and tag in {"li", "p", "td", "th", "tr", "h1", "h2", "h3", "pre"}:
            self.parts.append(" ")
        if self.markdown_depth == self.depth:
            self.markdown_depth = None
        self.depth -= 1

    def handle_data(self, data: str) -> None:
        if self.markdown_depth is not None:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.parts)).strip()


class TableFactParser(HTMLParser):
    """Flatten manufacturer Property/Type/Description table rows into facts."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.row_depth = 0
        self.cell_depth = 0
        self.cell_parts: list[str] = []
        self.cells: list[str] = []
        self.rows: list[list[str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self.row_depth += 1
            if self.row_depth == 1:
                self.cells = []
        if self.row_depth and tag in {"td", "th"}:
            self.cell_depth += 1
            self.cell_parts = []

    def handle_data(self, data: str) -> None:
        if self.cell_depth:
            self.cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self.cell_depth:
            self.cells.append(re.sub(r"\s+", " ", "".join(self.cell_parts)).strip())
            self.cell_depth -= 1
        elif tag == "tr" and self.row_depth:
            if self.row_depth == 1:
                # Shelly pages use nested three-column tables. Invalidly nested
                # rows occasionally flatten into six or nine cells; preserve
                # every complete fact triplet rather than discarding them.
                for index in range(0, len(self.cells) - 2, 3):
                    self.rows.append(self.cells[index:index + 3])
            self.row_depth -= 1


def raw_document(path: Path) -> tuple[str, list[list[str]]]:
    parser = MarkdownTextParser()
    table_parser = TableFactParser()
    html = path.read_text(encoding="utf-8")
    parser.feed(html)
    table_parser.feed(html)
    text = parser.text()
    if not text:
        raise ValueError(f"Shelly raw page has no documentation body: {path.relative_to(ROOT)}")
    return text, table_parser.rows


def evidence_tokens(field_path: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_]*", field_path)
        if len(token) > 1
    ]


def require_any(text: str, candidates: tuple[str, ...], context: str) -> None:
    lowered = text.lower()
    if not any(candidate.lower() in lowered for candidate in candidates):
        raise ValueError(f"Shelly raw evidence missing for {context}: one of {candidates}")


def evidence_names(field_path: str) -> set[str]:
    clean = re.sub(r"\[\*\]|\.\*", "", field_path)
    return {clean, clean.rsplit(".", 1)[-1]}


def json_example_matches(text: str, name: str, value_type: str) -> bool:
    literal_patterns = {
        "array": r"\[",
        "bool": r"(?:true|false)",
        "bool|number|null": r"(?:true|false|null|-?[0-9]+(?:\.[0-9]+)?)",
        "number": r"-?[0-9]+(?:\.[0-9]+)?",
        "object": r"\{",
        "string": r'"',
    }
    pattern = rf'"{re.escape(name)}"\s*:\s*{literal_patterns[value_type]}'
    return re.search(pattern, text, flags=re.IGNORECASE) is not None


def verify_one_field_evidence(
    text: str, rows: list[list[str]], field_path: str, value_type: str,
    unit: str | None, context: str,
) -> None:
    names = evidence_names(field_path)
    type_tokens = TYPE_EVIDENCE[value_type]
    candidates = [
        row for row in rows
        if len(row) == 3
        and row[0].lower() in {name.lower() for name in names}
        and any(token in row[1].lower() for token in type_tokens)
    ]
    if unit is not None:
        candidates = [
            row for row in candidates
            if any(token.lower() in row[2].lower() for token in UNIT_EVIDENCE[unit])
        ]
    if candidates:
        return

    # A small number of official responses document a nested field only in an
    # exact response example (not in a property table). Extract its JSON type;
    # units still require prose/table evidence and never come from the name.
    if unit is None and any(json_example_matches(text, name, value_type) for name in names):
        return

    # Some nested tables are malformed HTML and surface as linear text. Require
    # the field name and its type immediately adjacent, never merely somewhere
    # on the same component page.
    for name in names:
        for match in re.finditer(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", text, re.IGNORECASE):
            excerpt = text[match.start():match.start() + 320]
            if not any(token in excerpt.lower()[:100] for token in type_tokens):
                continue
            if unit is None or any(token.lower() in excerpt.lower() for token in UNIT_EVIDENCE[unit]):
                return
    raise ValueError(
        f"Shelly raw field/type/unit evidence missing for {context}/{field_path}: "
        f"{value_type}, {unit}"
    )


def verify_field_evidence(
    text: str, rows: list[list[str]], field: list[Any], context: str,
    prefixes: list[str] | None = None,
) -> None:
    field_path, value_type, unit = field
    for token in evidence_tokens(field_path):
        if token.lower() not in text.lower():
            raise ValueError(f"Shelly raw evidence missing for {context}/{field_path}: {token}")
    evidence_paths = [field_path] if prefixes is None else [f"{prefix}_{field_path}" for prefix in prefixes]
    for evidence_path in evidence_paths:
        verify_one_field_evidence(text, rows, evidence_path, value_type, unit, context)


def verify_selector(text: str, component: dict[str, Any], context: str) -> None:
    selector = component.get("method") or component.get("endpoint")
    if "|" in selector:
        suffix = selector.split("|", 1)[1].split(".", 1)[1].split("?", 1)[0]
        namespaces = selector.split(".", 1)[0].split("|")
        for namespace in namespaces:
            require_any(text, (f"{namespace}.{suffix}",), f"{context} selector")
    else:
        require_any(text, (selector.split("?", 1)[0],), f"{context} selector")


def extract_document() -> dict[str, Any]:
    raw_manifest = read_json(RAW_MANIFEST_PATH)
    raw_sources = {source["id"]: source for source in raw_manifest["sources"]}
    documents: dict[str, tuple[str, list[list[str]]]] = {}
    for source_id, source in raw_sources.items():
        path = ROOT / source["path"]
        if sha256(path) != source["sha256"]:
            raise ValueError(f"Shelly raw checksum mismatch: {source['path']}")
        documents[source_id] = raw_document(path)

    spec = read_json(SPEC_PATH)
    annotations = read_json(ANNOTATIONS_PATH)
    result = {
        "annotations_sha256": sha256(ANNOTATIONS_PATH),
        "extraction_spec_sha256": sha256(SPEC_PATH),
        "families": [],
        "raw_manifest_sha256": sha256(RAW_MANIFEST_PATH),
        "schema_version": "1.0",
        "snapshot_date": "2026-08-25",
    }
    seen_annotations: set[str] = set()
    for family in spec["families"]:
        output_family = {key: copy.deepcopy(value) for key, value in family.items() if key != "components"}
        output_family["components"] = []
        for component in family["components"]:
            component_key = f"{family['family']}|{component['component']}"
            annotation = annotations["components"].get(component_key)
            if annotation is None:
                raise ValueError(f"missing Shelly annotations for {component_key}")
            seen_annotations.add(component_key)
            sources = [raw_sources[source_id] for source_id in component["source_ids"]]
            text = " ".join(documents[source_id][0] for source_id in component["source_ids"])
            rows = [row for source_id in component["source_ids"] for row in documents[source_id][1]]
            verify_selector(text, component, component_key)
            output_component = {
                key: copy.deepcopy(value)
                for key, value in component.items()
                if key not in {"fields", "phase_fields", "source_ids"}
            }
            output_component["cadence_s"] = annotation["cadence_s"]
            output_component["source_evidence"] = sources
            for list_key in ("fields", "phase_fields"):
                if list_key not in component:
                    continue
                output_fields = []
                field_annotations = annotation[list_key]
                for field in component[list_key]:
                    verify_field_evidence(
                        text,
                        rows,
                        field,
                        component_key,
                        component.get("phase_prefixes") if list_key == "phase_fields" else None,
                    )
                    field_annotation = field_annotations.get(field[0])
                    if field_annotation is None:
                        raise ValueError(f"missing Shelly annotation for {component_key}/{field[0]}")
                    output_fields.append([
                        *field,
                        field_annotation["label_de"],
                        field_annotation["aggregation_kind"],
                    ])
                if set(field_annotations) != {field[0] for field in component[list_key]}:
                    raise ValueError(f"orphan Shelly field annotation in {component_key}/{list_key}")
                output_component[list_key] = output_fields
            output_family["components"].append(output_component)
        result["families"].append(output_family)
    if seen_annotations != set(annotations["components"]):
        raise ValueError("orphan Shelly component annotations")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed extraction differs")
    args = parser.parse_args()
    rendered = canonical_json_bytes(extract_document())
    if args.check:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_bytes() != rendered:
            raise SystemExit(f"Shelly extraction drift: run {Path(__file__).relative_to(ROOT)}")
    else:
        OUTPUT_PATH.write_bytes(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
