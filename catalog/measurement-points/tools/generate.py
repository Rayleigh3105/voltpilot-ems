#!/usr/bin/env python3
"""Generate the canonical catalog from pinned, vendored source snapshots."""

from __future__ import annotations

import argparse
import collections
import hashlib
import re
from pathlib import Path
from typing import Any, Iterable

from cataloglib import (
    CATALOG_VERSION,
    EDGE_MIN_VERSION,
    NOCH_NICHT_AN_DER_BOX,
    RUECKFALL_OHNE_BOX,
    SINGLE_READER_FAMILIES,
    ROOT,
    RUNTIME_CATALOG_VERSION,
    ZAEHLER_DEKLARATION_FIELDS,
    base_point,
    canonical_json_bytes,
    read_json,
    sha256,
    signed_from_type,
    slug,
    source_file,
    width_bits_from_type,
)
from semantics import classify


MANIFEST_PATH = ROOT / "sources" / "manifest.json"
DEYE_KEY_LOCK_PATH = ROOT / "sources" / "deye" / "point-key-lock.json"
DEFAULT_OUTPUT = ROOT / "dist" / f"measurement-point-catalog-{CATALOG_VERSION}.json"

DEYE_LABELS_DE = {
    "Battery Current": "Batteriestrom",
    "Battery Power": "Batterieleistung",
    "Battery SOC": "Batterieladestand",
    "Battery SOH": "Batteriegesundheit",
    "Battery State": "Batteriezustand",
    "Battery Temperature": "Batterietemperatur",
    "Battery Voltage": "Batteriespannung",
    "Date & Time": "Datum und Uhrzeit",
    "Device": "Gerät",
    "Device Alarm": "Gerätealarm",
    "Device Fault": "Gerätefehler",
    "Device Rated Power": "Nennleistung des Geräts",
    "Device Serial Number": "Seriennummer des Geräts",
    "Device State": "Gerätezustand",
    "Grid Current": "Netzstrom",
    "Grid Frequency": "Netzfrequenz",
    "Grid Power": "Netzleistung",
    "Grid Voltage": "Netzspannung",
    "Load Power": "Lastleistung",
    "PV Power": "PV-Leistung",
    "Temperature": "Temperatur",
    "Today Production": "Heutige Erzeugung",
    "Total Production": "Gesamterzeugung",
}

SUNSPEC_LABELS_DE = {
    "AC Current": "AC-Strom",
    "AC Frequency": "AC-Frequenz",
    "AC Power": "AC-Leistung",
    "Amps": "Strom",
    "Cabinet Temperature": "Gehäusetemperatur",
    "DC Current": "DC-Strom",
    "DC Power": "DC-Leistung",
    "DC Voltage": "DC-Spannung",
    "Frequency": "Frequenz",
    "Heat Sink Temperature": "Kühlkörpertemperatur",
    "Input ID": "Eingangskennung",
    "Input ID String": "Eingangsbezeichnung",
    "Lifetime Energy": "Lebenszeitenergie",
    "Manufacturer": "Hersteller",
    "Model": "Modell",
    "Model ID": "Modellkennung",
    "Model Length": "Modelllänge",
    "Operating State": "Betriebszustand",
    "Serial Number": "Seriennummer",
    "Temperature": "Temperatur",
    "Voltage": "Spannung",
    "Watts": "Wirkleistung",
}

OCPP_LABELS_DE = {
    "Current.Export": "Exportstrom",
    "Current.Import": "Importstrom",
    "Current.Offered": "Angebotener Strom",
    "Energy.Active.Export.Register": "Exportierte Wirkenergie (Zähler)",
    "Energy.Active.Import.Register": "Importierte Wirkenergie (Zähler)",
    "Energy.Reactive.Export.Register": "Exportierte Blindenergie (Zähler)",
    "Energy.Reactive.Import.Register": "Importierte Blindenergie (Zähler)",
    "Energy.Active.Export.Interval": "Exportierte Wirkenergie (Intervall)",
    "Energy.Active.Import.Interval": "Importierte Wirkenergie (Intervall)",
    "Energy.Reactive.Export.Interval": "Exportierte Blindenergie (Intervall)",
    "Energy.Reactive.Import.Interval": "Importierte Blindenergie (Intervall)",
    "Frequency": "Frequenz",
    "Power.Active.Export": "Exportierte Wirkleistung",
    "Power.Active.Import": "Importierte Wirkleistung",
    "Power.Factor": "Leistungsfaktor",
    "Power.Offered": "Angebotene Leistung",
    "Power.Reactive.Export": "Exportierte Blindleistung",
    "Power.Reactive.Import": "Importierte Blindleistung",
    "RPM": "Drehzahl",
    "SoC": "Ladestand",
    "Temperature": "Temperatur",
    "Voltage": "Spannung",
}

# OCPP 1.6 JSON Schema, UnitOfMeasure. ``ocpp-go`` also exports the misspelled
# compatibility constant ``Celcius``. It is intentionally not protocol truth.
OCPP_16_STANDARD_UNITS = [
    "Wh", "kWh", "varh", "kvarh", "W", "kW", "VA", "kVA", "var", "kvar",
    "A", "V", "Celsius", "Fahrenheit", "K", "Percent",
]

GOE_COUNTER_KEYS = {"eto", "eto_mid", "wh", "wh_mid", "whb", "whg", "who", "whs"}


def scale_metadata(item: dict[str, Any]) -> dict[str, Any]:
    if "scale" in item:
        value = item["scale"]
        return {"kind": "conditional_factor" if isinstance(value, list) else "factor", "value": value}
    if "divide" in item:
        return {"kind": "divisor", "value": item["divide"]}
    return {"kind": "none"}


def long_term_cadence(unit: str | None, aggregation: str, text: str) -> int | None:
    haystack = text.lower()
    if aggregation == "none":
        return None
    if aggregation in {"event", "state", "bitfield", "text"}:
        # State-like samples must enter both durable physical rollups. 900 s is
        # their storage cadence; the refresh procedure intentionally also
        # admits them to the 5-minute table so 7/30-day windows remain usable.
        return 900
    if aggregation == "counter":
        return 900
    if unit in {"W", "kW", "VA", "var", "A", "V", "Hz", "PF", "Pct"}:
        return 300
    if any(token in haystack for token in ("power", "current", "voltage", "frequency", "phase", "mppt", "pv")):
        return 300
    return 900


def deye_value_type(item: dict[str, Any], width_bits: int | None) -> tuple[str, bool | None]:
    rule = item["rule"]
    if rule == 5:
        return "ascii_string", None
    if rule == 7:
        return "version", None
    if rule == 8:
        return "datetime", None
    if rule == 9:
        return "time", None
    if item.get("class") == "enum" or "lookup" in item:
        is_bitfield = any("bit" in entry for entry in item.get("lookup", []))
        return ("bitfield" if is_bitfield else "enum") + (str(width_bits or "") if width_bits else ""), False
    signed = rule in {2, 4}
    return ("int" if signed else "uint") + (str(width_bits or "") if width_bits else ""), signed


def deye_aggregation(item: dict[str, Any], value_type: str) -> str:
    if not item.get("name"):
        return "none"
    if value_type.startswith("bitfield"):
        return "bitfield"
    if value_type.startswith("enum") or item.get("platform") in {"switch", "select"}:
        return "state"
    if value_type in {"ascii_string", "version", "datetime", "time"}:
        return "text"
    if item.get("state_class") == "total_increasing" or item.get("class") == "energy":
        return "counter"
    if item.get("state_class") == "measurement" or item.get("class") in {"power", "current", "voltage", "temperature", "frequency"}:
        return "gauge"
    return "none"


def deye_label_de(name: str | None) -> str | None:
    if not name:
        return None
    if name in DEYE_LABELS_DE:
        return DEYE_LABELS_DE[name]
    match = re.fullmatch(r"PV(\d+) (Power|Current|Voltage)", name)
    if match:
        noun = {"Power": "Leistung", "Current": "Strom", "Voltage": "Spannung"}[match.group(2)]
        return f"PV{match.group(1)} {noun}"
    match = re.fullmatch(r"(Grid|Load|Output) L([123]) (Power|Current|Voltage)", name)
    if match:
        prefix = {"Grid": "Netz", "Load": "Last", "Output": "Ausgang"}[match.group(1)]
        noun = {"Power": "Leistung", "Current": "Strom", "Voltage": "Spannung"}[match.group(3)]
        return f"{prefix} L{match.group(2)} {noun}"
    return None


def sensor_registers(item: dict[str, Any]) -> list[int]:
    found: list[int] = []

    def append_registers(values: Any) -> None:
        if isinstance(values, int):
            found.append(values)
        elif isinstance(values, list):
            for value in values:
                append_registers(value)

    for sensor in item.get("sensors", []):
        # The upstream P3 source contains two deliberately nested register
        # lists for loss calculations. Preserve their order while flattening
        # them into the canonical dependency selector.
        append_registers(sensor.get("registers", []))
        append_registers(sensor.get("multiply", {}).get("registers", []))
    return list(dict.fromkeys(found))


def deye_decoder(item: dict[str, Any]) -> dict[str, Any]:
    decoder_fields = (
        "rule", "scale", "divide", "mask", "bit", "bitmask", "offset", "magnitude",
        "inverted", "registers", "sensors", "lookup", "range", "validation", "value",
        "enabled_lookup", "name_lookup", "l", "alt", "hex", "delimiter", "remove", "dec",
    )
    return {field: item[field] for field in decoder_fields if field in item}


def deye_source_key(item: dict[str, Any]) -> str:
    """The pinned parser's ``entity_key(name, platform)`` lookup identifier."""
    platform = item.get("platform", "number" if "configurable" in item else "sensor")
    value = f"{item.get('name') or ''}_{platform}"
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def deye_lock_fingerprint(registers: list[int], derived_registers: list[int], decoder: dict[str, Any]) -> str:
    identity = {
        "decoder": decoder,
        "derived_registers": derived_registers,
        "registers": registers,
    }
    return hashlib.sha256(canonical_json_bytes(identity)).hexdigest()


def deye_source_records(source: dict[str, Any], document: dict[str, Any]) -> Iterable[dict[str, Any]]:
    default_cadence = document.get("default", {}).get("update_interval")
    default_digits = document.get("default", {}).get("digits", 6)
    family = source["family"]
    for group in document["parameters"]:
        group_name = group["group"]
        group_cadence = group.get("update_interval", default_cadence)
        duplicates = collections.Counter((item.get("name") or "") for item in group["items"])
        for ordinal, item in enumerate(group["items"]):
            name = item.get("name") or None
            registers = item.get("registers") or []
            derived_registers = sensor_registers(item)
            selector_addresses = registers or derived_registers
            selector = (
                "holding:" + ",".join(f"0x{address:04x}" for address in registers)
                if registers
                else "derived:" + slug(group_name) + "/" + slug(name or f"unnamed-{ordinal}")
            )
            key = f"deye.{family}.{slug(group_name)}.{slug(name or 'unnamed')}"
            if duplicates[item.get("name") or ""] > 1:
                suffix = f"r{selector_addresses[0]:04x}" if selector_addresses else f"n{ordinal}"
                key += "@" + suffix
            decoder = deye_decoder(item)
            source_locator = f"{group_name}/{name or f'<unnamed:{ordinal}>'}"
            yield {
                "decoder": decoder,
                "default_digits": default_digits,
                "derived_registers": derived_registers,
                "group_cadence": group_cadence,
                "group_name": group_name,
                "item": item,
                "legacy_point_key": key,
                "lock_fingerprint": deye_lock_fingerprint(registers, derived_registers, decoder),
                "name": name,
                "ordinal": ordinal,
                "registers": registers,
                "selector": selector,
                "source_locator": source_locator,
            }


def load_deye_document(source: dict[str, Any]) -> dict[str, Any]:
    normalized = read_json(source_file(source, source["input_path"]))
    if normalized.get("normalizer_version") != "1.0":
        raise ValueError(f"unsupported Deye normalizer version for {source['id']}")
    if normalized.get("raw_sha256") != source["source_sha256"]:
        raise ValueError(f"normalized Deye source mismatch for {source['id']}")
    if normalized.get("raw_file") != Path(source["path"]).name:
        raise ValueError(f"normalized Deye filename mismatch for {source['id']}")
    return normalized["document"]


def resolve_deye_key(
    key_lock: dict[str, Any], family: str, source_locator: str, fingerprint: str,
) -> dict[str, Any]:
    matches = [
        entry
        for entry in key_lock["entries"]
        if entry["family"] == family
        and source_locator in entry["source_locators"]
        and fingerprint in entry["fingerprints"]
    ]
    if len(matches) != 1:
        raise ValueError(
            f"Deye point-key lock mismatch for {family}/{source_locator} ({fingerprint[:12]}): "
            "run tools/update_deye_key_lock.py and review the lock diff"
        )
    return matches[0]


def generate_deye_points(
    source: dict[str, Any], document: dict[str, Any], key_lock: dict[str, Any],
) -> Iterable[dict[str, Any]]:
    family = source["family"]
    for record in deye_source_records(source, document):
        item = record["item"]
        name = record["name"]
        registers = record["registers"]
        derived_registers = record["derived_registers"]
        group_name = record["group_name"]
        lock_entry = resolve_deye_key(
            key_lock, family, record["source_locator"], record["lock_fingerprint"],
        )
        width_bits = len(registers) * 16 if registers else None
        value_type, signed = deye_value_type(item, width_bits)
        aggregation = deye_aggregation(item, value_type)
        cadence = item.get("update_interval", record["group_cadence"])
        runtime_decoder = dict(record["decoder"])
        runtime_decoder["source_key"] = deye_source_key(item)
        runtime_decoder["digits"] = item.get("digits", record["default_digits"])
        item_range = item.get("range") or {}
        validation = item.get("validation") or {}
        if family == "hybrid_3p" and any(
            isinstance(value, list)
            for value in (
                item.get("scale"), item_range.get("min"), item_range.get("max"),
                validation.get("min"), validation.get("max"),
            )
        ):
            # ha-solarman's pinned autodetection maps these register-0 device
            # types to mod=1; all other P3 devices use the source default mod=0.
            runtime_decoder["variant"] = {
                "register": 0,
                "index_1_values": [0x0006, 0x0007, 0x0600, 0x0008, 0x0601],
                "default_index": 0,
            }
        yield base_point(
            family=family,
            point_key=lock_entry["point_key"],
            source_kind="modbus_holding",
            address={
                "kind": "modbus_holding", "registers": registers, "width_words": len(registers),
            } if registers else None,
            selector=record["selector"],
            width_bits=width_bits,
            value_type=value_type,
            signed=signed,
            endian="word_little_byte_big" if registers else None,
            scale=scale_metadata(item),
            unit=item.get("uom"),
            group=group_name,
            label_de=deye_label_de(name),
            label_source=name,
            semantic_status="unknown" if name is None else "vendor_label_only",
            aggregation_kind=aggregation,
            default_cadence_s=cadence,
            min_cadence_s=cadence,
            long_term_cadence_s=long_term_cadence(
                item.get("uom"), aggregation, f"{group_name} {name or ''}",
            ),
            poll_group=f"deye:{family}:{slug(group_name)}:{cadence or 'source-default'}",
            source=source,
            decoder=runtime_decoder,
            derived_from=[f"holding:0x{address:04x}" for address in derived_registers],
            point_key_aliases=lock_entry["aliases"],
            recommended=name in {
                "PV Power", "Grid Power", "Load Power", "Battery Power", "Battery SOC",
                "Device State", "Device Alarm", "Device Fault", "Temperature",
                "Today Production", "Total Production",
            },
            readable=True,
        )


def generate_deye(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    return generate_deye_points(source, load_deye_document(source), read_json(DEYE_KEY_LOCK_PATH))


def sunspec_aggregation(value_type: str) -> str:
    if value_type.startswith("acc"):
        return "counter"
    if value_type.startswith("bitfield"):
        return "bitfield"
    if value_type.startswith("enum"):
        return "state"
    if value_type in {"string", "ipaddr", "ipv6addr"}:
        return "text"
    if value_type in {"pad", "sunssf"}:
        return "none" if value_type == "pad" else "state"
    return "gauge"


def sunspec_cadence(model_id: int, point: dict[str, Any], dynamic: bool) -> tuple[int, int]:
    value_type = point["type"]
    name = point["name"]
    if point.get("static") == "S" or value_type in {"string", "sunssf", "pad"} or name in {"ID", "L"}:
        return 3600, 300
    if model_id in {121, 123}:
        return 300, 300
    if value_type.startswith("enum") or value_type.startswith("bitfield"):
        return 300, 30
    if dynamic and name in {"DCA", "DCV", "DCW"}:
        return 30, 5
    if point.get("units") in {"W", "A", "V", "Hz", "VA", "var", "PF", "Pct"}:
        return 30, 5
    return 60, 30


def generate_sunspec(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for model_id, model_sha in source["models"]:
        relative_path = source["path_pattern"].format(model_id=model_id)
        model = read_json(source_file(source, relative_path))
        model_source = dict(source)
        model_source.update(
            source_sha256=model_sha,
            source_url=source["source_url_pattern"].format(model_id=model_id),
        )
        root_group = model["group"]
        cursor = 0
        for point in root_group.get("points", []):
            size = point.get("size", 1)
            yield sunspec_point(model_id, (), point, cursor, False, model_source)
            cursor += size
        for child in root_group.get("groups", []):
            child_size = sum(point.get("size", 1) for point in child.get("points", []))
            dynamic = child.get("count") == 0
            repetitions = 1 if dynamic else int(child.get("count", 1))
            for repetition in range(repetitions):
                local = 0
                segment = f"{child['name']}[*]" if dynamic else f"{child['name']}[{repetition}]"
                for point in child.get("points", []):
                    offset: int | str = cursor + repetition * child_size + local
                    if dynamic:
                        offset = f"{cursor}+index*{child_size}+{local}"
                    yield sunspec_point(model_id, (segment,), point, offset, dynamic, model_source)
                    local += point.get("size", 1)
            cursor += child_size * repetitions


def sunspec_point(
    model_id: int,
    path: tuple[str, ...],
    point: dict[str, Any],
    offset: int | str,
    dynamic: bool,
    source: dict[str, Any],
) -> dict[str, Any]:
    value_type = point["type"]
    size = point.get("size", 1)
    name_path = ".".join((*path, point["name"]))
    key_path = ".".join((*path, point["name"].lower()))
    label_source = point.get("label") or point["name"]
    aggregation = sunspec_aggregation(value_type)
    default_cadence, min_cadence = sunspec_cadence(model_id, point, dynamic)
    scale = {"kind": "sunssf", "point": point["sf"]} if point.get("sf") else {"kind": "none"}
    return base_point(
        family=f"sunspec.model_{model_id}",
        point_key=f"sunspec.model_{model_id}.{key_path}",
        source_kind="sunspec_model",
        address={
            "base": "discovered",
            "kind": "sunspec_relative",
            "model_id": model_id,
            "offset_words": offset,
            "width_words": size,
        },
        selector=f"model:{model_id}/{name_path}",
        width_bits=size * 16,
        value_type=value_type,
        signed=signed_from_type(value_type),
        endian="big",
        scale=scale,
        unit=point.get("units"),
        group="/".join(path) if path else f"model_{model_id}",
        label_de=SUNSPEC_LABELS_DE.get(label_source),
        label_source=label_source,
        semantic_status="known",
        aggregation_kind=aggregation,
        default_cadence_s=default_cadence,
        min_cadence_s=min_cadence,
        long_term_cadence_s=long_term_cadence(point.get("units"), aggregation, f"{name_path} {label_source}"),
        poll_group=f"sunspec:model_{model_id}:{slug('/'.join(path) if path else 'root')}",
        source=source,
        dynamic=dynamic,
        mandatory=point.get("mandatory") == "M",
        readable=True,
    )


def parse_markdown_table(path: Path) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5 or cells[0].lower() == "key" or set(cells[0]) <= {"-", ":"}:
            continue
        rows.append(cells)
    return rows


def generate_goe(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    german_rows = parse_markdown_table(source_file(source, source["german_labels_path"]))
    german: dict[str, str] = {}
    for row in german_rows:
        # The general manufacturer table groups the ten RFID name, energy and
        # enable keys into one documented row. Assign that one source label to
        # every explicitly named key. Parenthesized lifecycle notes are not a
        # part of the API key.
        documented_keys = row[0].split(" (", 1)[0].split()
        for documented_key in documented_keys:
            german[documented_key] = row[4]
    for raw_key, access, value_type, category, description in parse_markdown_table(source_file(source)):
        # Firmware 60.4 has three accidental tab characters inside
        # ``pvopt_averageP*`` keys. The same pinned repository's German table
        # contains their intact API spellings, so normalization is sourced,
        # not guessed.
        key = re.sub(r"\s+", "", raw_key)
        readable = "R" in access
        aggregation = (
            "none" if not readable or "legacy" in value_type.lower() or "json" in value_type.lower()
            else "counter" if key in GOE_COUNTER_KEYS
            else "state" if category in {"Config", "Constant"} or value_type == "bool"
            else "text" if "string" in value_type.lower()
            else "gauge"
        )
        default_cadence = None if not readable else (30 if category == "Status" else 3600)
        yield base_point(
            family=source["family"],
            point_key=f"goe.api_v2.{key.lower()}",
            source_kind="http_api_key",
            address=None,
            selector=f"api/status?filter={key}",
            width_bits=width_bits_from_type(value_type),
            value_type=value_type,
            signed=signed_from_type(value_type),
            endian=None,
            scale={"kind": "none"},
            unit=None,
            group=category,
            label_de=german.get(key),
            label_source=description or key,
            semantic_status="unknown" if not description else "vendor_label_only",
            aggregation_kind=aggregation,
            default_cadence_s=default_cadence,
            min_cadence_s=(5 if category == "Status" and readable else default_cadence),
            long_term_cadence_s=long_term_cadence(None, aggregation, f"{key} {description}"),
            poll_group=f"goe:api_v2:{category.lower()}",
            source=source,
            access=access,
            readable=readable,
            **(
                {
                    "label_source_sha256": source["german_labels_sha256"],
                    "label_source_url": source["german_labels_url"],
                }
                if key in german
                else {}
            ),
            **({"source_key_raw": raw_key} if raw_key != key else {}),
        )


def path_segment(value: str) -> str:
    value = value.lower().replace(":", ".").replace("/", ".")
    value = re.sub(r"[^a-z0-9._*\[\]-]+", "-", value)
    return value.strip(".-")


def shelly_fields(component: dict[str, Any]) -> Iterable[list[Any]]:
    yield from component.get("fields", [])
    for prefix in component.get("phase_prefixes", []):
        for field in component.get("phase_fields", []):
            yield [f"{prefix}_{field[0]}", *field[1:]]


def generate_shelly(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    document = read_json(source_file(source))
    for family in document["families"]:
        for component in family["components"]:
            source_evidence = component["source_evidence"]
            primary_evidence = source_evidence[0]
            component_source = dict(source)
            component_source["source_sha256"] = primary_evidence["sha256"]
            component_source["source_url"] = primary_evidence["url"]
            method = component.get("method") or component.get("endpoint")
            for field_path, value_type, unit, label_de, aggregation in shelly_fields(component):
                component_key = path_segment(component["component"])
                field_key = path_segment(field_path)
                cadence = component["cadence_s"]
                yield base_point(
                    family=family["family"],
                    point_key=f"{family['family']}.{component_key}.{field_key}",
                    source_kind=family["source_kind"],
                    address=None,
                    selector=f"{method}#{field_path}",
                    width_bits=width_bits_from_type(value_type),
                    value_type=value_type,
                    signed=signed_from_type(value_type),
                    endian=None,
                    scale={"kind": "none"},
                    unit=unit,
                    group=component["component"],
                    label_de=label_de,
                    label_source=field_path,
                    semantic_status="known",
                    aggregation_kind=aggregation,
                    default_cadence_s=cadence,
                    min_cadence_s=min(cadence, 5 if cadence <= 30 else 30),
                    long_term_cadence_s=long_term_cadence(unit, aggregation, f"{component['component']} {field_path}"),
                    poll_group=f"shelly:{family['family']}:{path_segment(method)}",
                    source=component_source,
                    dynamic="*" in component["component"] or "*" in field_path,
                    optional=True,
                    readable=True,
                    source_evidence=source_evidence,
                )


def parse_ocpp_constants(path: Path) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = collections.defaultdict(list)
    pattern = re.compile(
        r'^\s*\w+\s+(ReadingContext|ValueFormat|Measurand|Phase|Location|UnitOfMeasure)\s+=\s+"([^"]+)"'
    )
    for line in path.read_text(encoding="utf-8").splitlines():
        match = pattern.match(line)
        if match:
            groups[match.group(1)].append(match.group(2))
    return dict(groups)


def generate_ocpp(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    constants = parse_ocpp_constants(source_file(source))
    parsed_units = set(constants["UnitOfMeasure"])
    missing_units = set(OCPP_16_STANDARD_UNITS) - parsed_units
    compatibility_units = parsed_units - set(OCPP_16_STANDARD_UNITS)
    if missing_units or compatibility_units != {"Celcius"}:
        raise ValueError(
            "unexpected ocpp-go UnitOfMeasure constants: "
            f"missing={sorted(missing_units)}, compatibility={sorted(compatibility_units)}"
        )
    dimensions = {
        "contexts": constants["ReadingContext"],
        "formats": constants["ValueFormat"],
        "locations": constants["Location"],
        "phases": constants["Phase"],
        "units": OCPP_16_STANDARD_UNITS,
    }
    for measurand in constants["Measurand"]:
        aggregation = "counter" if measurand.endswith(".Register") else "gauge"
        yield base_point(
            family=source["family"],
            point_key=(
                f"ocpp.1_6.metervalues.{measurand.lower()}."
                "context[*].format[*].phase[*].location[*].unit[*]"
            ),
            source_kind="ocpp_sampled_value",
            address=None,
            selector=(
                f"SampledValue[measurand={measurand},context={{context}},format={{format}},"
                "phase={phase},location={location},unit={unit}]"
            ),
            width_bits=None,
            value_type="decimal_string",
            signed=None,
            endian=None,
            scale={"kind": "protocol_value"},
            unit=None,
            group="MeterValues",
            label_de=OCPP_LABELS_DE[measurand],
            label_source=measurand,
            semantic_status="known",
            aggregation_kind=aggregation,
            default_cadence_s=None,
            min_cadence_s=None,
            long_term_cadence_s=long_term_cadence(None, aggregation, measurand),
            poll_group="ocpp:meter-values:event",
            source=source,
            dimensions=dimensions,
            dynamic=True,
            point_key_template=True,
            readable=True,
        )


def generate_builtin_inverter(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """Package the points already proven by the in-repo inverter decoders.

    The JSON source is intentionally boring and explicit: it mirrors only fields
    and registers the runtime actually reads. It is not a guessed vendor-wide map.
    """
    document = read_json(source_file(source))
    by_family = {family["family"]: family for family in document["families"]}
    for family in document["families"]:
        inherited = by_family.get(family.get("inherits"), {}).get("points", [])
        for item in [*inherited, *family["points"]]:
            address = None
            source_kind = "rest_json"
            selector = item.get("selector", "")
            if "address" in item:
                registers = list(range(item["address"], item["address"] + item["width_words"]))
                address = {"kind": "modbus_holding", "registers": registers,
                           "width_words": item["width_words"]}
                source_kind = "modbus_holding"
                selector = "holding:" + ",".join(f"0x{register:04x}" for register in registers)
            yield base_point(
                family=family["family"],
                point_key=f"{family['family']}.{item['key']}",
                source_kind=source_kind,
                address=address,
                selector=selector,
                width_bits=item.get("width_words", 0) * 16 or None,
                value_type=item["value_type"],
                signed=item["signed"],
                endian=item.get("endian"),
                scale=item["scale"],
                unit=item["unit"],
                group=item["group"],
                label_de=item["label_de"],
                label_source=item["label_source"],
                semantic_status="known",
                aggregation_kind=item["aggregation_kind"],
                default_cadence_s=item["cadence_s"],
                min_cadence_s=item["cadence_s"],
                long_term_cadence_s=long_term_cadence(
                    item["unit"], item["aggregation_kind"],
                    f"{item['group']} {item['label_source']}",
                ),
                # One JSON poll group is exactly one physical endpoint. KACO's
                # device=2/device=3/device=4 payloads are separate requests;
                # grouping only by the display group silently dropped fields.
                poll_group=(f"{family['family']}:{selector.split('#', 1)[0]}"
                            if source_kind == "rest_json"
                            else f"{family['family']}:{item['group'].lower().replace(' ', '-')}"),
                source={**source, "source_url": family["source_url"],
                        "source_revision": family["source_revision"]},
                **({"decoder": {"byte_order": family["byte_order"]}}
                   if item.get("width_words", 0) > 1 and family.get("byte_order") else {}),
                # Z6-Deklaration nur, wenn die Quelle sie nennt; sonst fehlt das Feld (nie null).
                **{field: item[field] for field in ZAEHLER_DEKLARATION_FIELDS if field in item},
                dynamic=item.get("dynamic", False),
                point_key_template=item.get("dynamic", False),
                recommended=item.get("recommended", False),
                readable=True,
            )


def generate_wago(source: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """Punkte je Kartentyp am VoltPilot-Registerbild WAGO v1 (UEMS AP-05 IP-4).

    Die Quelle nennt je Karte und je Zahl die Herkunft (`angaben`, wie die Vektor-Datei des Vertrags).
    Der Adapter übernimmt sie wörtlich und rät nichts dazu: eine Zahl, die für DIESE Karte nicht belegt
    ist, steht als zu erheben da (`value_type`/`scale` unknown, keine Einheit, kein Bereich, nicht
    lesbar). Adresse = Kopf + index · Karten-Block + Feld; Basisadresse, Funktionscode und Wortfolge
    sind Parameter der Anlage (wago-registerbild.md §2) und darum weder `address.base` noch `endian`.
    """
    document = read_json(source_file(source))
    bild = document["registerbild"]
    offset_prefix = f"{bild['kopflaenge']}+index*{bild['kartenblocklaenge']}+"
    for karte in document["karten"]:
        family = karte["family"]
        for feld in document["felder"]:
            wert = karte["werte"][feld["key"]]
            yield base_point(
                family=family,
                point_key=f"{family}.karte[*].{feld['key']}",
                source_kind="wago_registerbild",
                address={"base": "parameter", "kind": "registerbild_relative",
                         "offset_words": f"{offset_prefix}{feld['offset']}",
                         "width_words": feld["width_words"]},
                selector=f"registerbild:v{bild['hauptversion']}/karte[*]+{feld['offset']}",
                width_bits=feld["width_words"] * 16,
                value_type=wert["value_type"],
                signed=wert["signed"],
                endian=None,
                scale=wert["scale"],
                unit=wert["unit"],
                group=feld["group"],
                label_de=feld["label_de"],
                label_source=feld["label_source"],
                semantic_status="known",
                aggregation_kind=feld["aggregation_kind"],
                default_cadence_s=document["kadenz_s"],
                min_cadence_s=document["kadenz_s"],
                long_term_cadence_s=long_term_cadence(
                    wert["unit"], feld["aggregation_kind"], f"{feld['group']} {feld['key']}"),
                poll_group=document["poll_group"],
                source={**source, "source_url": karte["source_url"],
                        "source_revision": karte["source_revision"]},
                angaben=wert["angaben"],
                **({"range": wert["range"]} if "range" in wert else {}),
                dynamic=True,
                point_key_template=True,
                readable=wert["value_type"] != "unknown",
            )


ADAPTERS = {
    "builtin_inverter": generate_builtin_inverter,
    "deye": generate_deye,
    "goe": generate_goe,
    "ocpp": generate_ocpp,
    "shelly": generate_shelly,
    "sunspec": generate_sunspec,
    "wago": generate_wago,
}


def verify_source_hashes(manifest: dict[str, Any]) -> None:
    failures = []
    for source in manifest["sources"]:
        if source["adapter"] == "sunspec":
            for model_id, expected in source["models"]:
                path = source_file(source, source["path_pattern"].format(model_id=model_id))
                if sha256(path) != expected:
                    failures.append(str(path.relative_to(ROOT)))
            continue
        if source["adapter"] == "shelly":
            for path_key, hash_key in (
                ("path", "extracted_sha256"),
                ("raw_manifest_path", "raw_manifest_sha256"),
                ("extraction_spec_path", "extraction_spec_sha256"),
                ("annotations_path", "annotations_sha256"),
            ):
                if sha256(source_file(source, source[path_key])) != source[hash_key]:
                    failures.append(source[path_key])
            raw_manifest = read_json(source_file(source, source["raw_manifest_path"]))
            for raw_source in raw_manifest["sources"]:
                if sha256(ROOT / raw_source["path"]) != raw_source["sha256"]:
                    failures.append(raw_source["path"])
            continue
        for path_key, hash_key in (("path", "source_sha256"), ("input_path", "input_sha256"), ("german_labels_path", "german_labels_sha256")):
            if path_key in source and sha256(source_file(source, source[path_key])) != source[hash_key]:
                failures.append(source[path_key])
    if failures:
        raise ValueError("pinned source checksum mismatch: " + ", ".join(failures))


def build_catalog() -> dict[str, Any]:
    manifest = read_json(MANIFEST_PATH)
    verify_source_hashes(manifest)
    points: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []
    for source in manifest["sources"]:
        if source["adapter"] == "accuracy":
            document = read_json(source_file(source))
            models.extend(document["models"])
            continue
        points.extend(ADAPTERS[source["adapter"]](source))
    points.sort(key=lambda point: point["point_key"])
    models.sort(key=lambda model: (model["hersteller"].casefold(), model["modell"].casefold()))
    for point in points:
        point["quantity"], point["direction"] = classify(point)
    family_counts = collections.Counter(point["family"] for point in points)
    families = [
        {
            "an_der_box": family not in NOCH_NICHT_AN_DER_BOX,
            "family": family,
            "point_count": family_counts[family],
            "rueckfall_ohne_box": RUECKFALL_OHNE_BOX.get(family),
            "single_reader": family in SINGLE_READER_FAMILIES,
            "template_count": sum(bool(point.get("dynamic")) for point in points if point["family"] == family),
        }
        for family in sorted(family_counts)
    ]
    return {
        "catalog_version": CATALOG_VERSION,
        "deye_point_key_lock_sha256": sha256(DEYE_KEY_LOCK_PATH),
        "edge_min_version": EDGE_MIN_VERSION,
        "families": families,
        "models": models,
        "points": points,
        "runtime_catalog_version": RUNTIME_CATALOG_VERSION,
        "schema_version": "1.0",
        "source_manifest_sha256": sha256(MANIFEST_PATH),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed artifact differs")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    rendered = canonical_json_bytes(build_catalog())
    if args.check:
        if not args.output.exists() or args.output.read_bytes() != rendered:
            raise SystemExit(f"catalog drift: run {Path(__file__).relative_to(ROOT)}")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
