#!/usr/bin/env python3
"""Offline semantic validation for a generated measurement-point catalog."""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path
from typing import Any

from cataloglib import (
    CATALOG_VERSION,
    EDGE_MIN_VERSION,
    POINT_KEY_RE,
    ROOT,
    GERAETE_RUECKFALL_WOERTER,
    NOCH_NICHT_AN_DER_BOX,
    RUECKFALL_OHNE_BOX,
    RUNTIME_CATALOG_VERSION,
    ZAEHLER_DEKLARATION_FIELDS,
    read_json,
    runtime_projection,
    sha256,
)
from generate import (
    DEFAULT_OUTPUT,
    DEYE_KEY_LOCK_PATH,
    MANIFEST_PATH,
    OCPP_16_STANDARD_UNITS,
    verify_source_hashes,
)
from jsonschema_validator import SchemaValidationError, validate_json_schema
from semantics import (
    DIRECTIONLESS,
    DIRECTIONS,
    ENERGY_QUANTITIES,
    ENERGY_UNITS,
    ENERGY_WITHOUT_DIRECTION,
    QUANTITIES,
    ZAEHLER_OHNE_ANZEIGE_EINHEIT,
    ZAEHLER_OHNE_ANZEIGE_EINHEIT_ARTEN,
)


REQUIRED_POINT_FIELDS = {
    "address", "aggregation_kind", "catalog_version", "default_cadence_s", "direction", "edge_min_version",
    "endian", "family", "group", "label_de", "label_source", "long_term_cadence_s",
    "min_cadence_s", "point_key", "point_key_aliases", "poll_group", "quantity", "readable", "scale", "selector",
    "semantic_status", "signed", "source_commit", "source_kind", "source_revision",
    "source_sha256", "source_url", "unit", "value_type", "width_bits",
}
SOURCE_KINDS = {
    "modbus_holding", "modbus_input", "sunspec_model", "http_api_key", "rest_json", "rpc_json",
    "ocpp_sampled_value", "wago_registerbild",
}
MODBUS_SOURCE_KINDS = {"modbus_holding", "modbus_input"}
AGGREGATIONS = {"gauge", "counter", "state", "event", "bitfield", "text", "none"}
SEMANTIC_STATUSES = {"known", "vendor_label_only", "unknown"}
SCALE_KINDS = {"none", "factor", "divisor", "conditional_factor", "sunssf", "protocol_value", "unknown"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DYNAMIC_OFFSET_RE = re.compile(r"^[0-9]+\+index\*[1-9][0-9]*\+[0-9]+$")
# VoltPilot-Registerbild WAGO v1 (docs/contracts/v2/wago-registerbild.md §3/§4): Kopf 12, Karten-Block 42 Wörter.
REGISTERBILD_KOPF, REGISTERBILD_KARTE = 12, 42
# Herkunft je Zahl (UEMS AP-05 IP-4): eine Handbuch-Angabe am Punkt einer WAGO-Karte muss DEREN Artikel nennen.
WAGO_KARTEN = {"wago.pm494": "750-494", "wago.pm495": "750-495"}
ANGABE_ARTEN = {"festlegung", "handbuch", "zu erheben"}
ANGABE_FELDER = {"address", "met_id", "range", "scale", "value_type"}
WAGO_PFLICHT_ANGABEN = {"address", "scale", "value_type"}
# Wertebereich eines Rohwerts (UEMS AP-05 IP-5) je ganzzahligem Datentyp.
GANZZAHL_BEREICH = {
    "uint16": (0, 2**16 - 1), "int16": (-(2**15), 2**15 - 1),
    "uint32": (0, 2**32 - 1), "int32": (-(2**31), 2**31 - 1),
}
CATALOG_SCHEMA_PATH = ROOT / "schema" / "catalog.schema.json"
MANIFEST_SCHEMA_PATH = ROOT / "schema" / "source-manifest.schema.json"


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
    try:
        validate_json_schema(manifest, read_json(MANIFEST_SCHEMA_PATH), " source manifest")
    except (SchemaValidationError, ValueError) as exc:
        errors.check(False, str(exc))
    errors.check(manifest.get("schema_version") == "1.0", "source manifest schema_version must be 1.0")
    sources = manifest.get("sources")
    errors.check(isinstance(sources, list) and bool(sources), "source manifest needs a non-empty sources list")
    ids: list[str] = []
    for index, source in enumerate(sources if isinstance(sources, list) else []):
        prefix = f"source[{index}]"
        source_id = source.get("id")
        ids.append(source_id)
        errors.check(isinstance(source_id, str) and bool(source_id), f"{prefix} has no id")
        errors.check(source.get("adapter") in {"deye", "sunspec", "goe", "shelly", "ocpp", "builtin_inverter", "wago", "accuracy"}, f"{prefix} has an unsupported adapter")
        errors.check(bool(source.get("source_commit") or source.get("source_revision")), f"{prefix} has neither commit nor revision")
        if source.get("adapter") == "sunspec":
            errors.check(len(source.get("models", [])) == 19, "SunSpec manifest must pin 19 models")
            for model in source.get("models", []):
                errors.check(
                    isinstance(model, list) and len(model) == 2 and isinstance(model[0], int)
                    and isinstance(model[1], str) and bool(SHA256_RE.fullmatch(model[1])),
                    f"{prefix} contains an invalid model pin",
                )
        elif source.get("adapter") != "shelly":
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
        errors.check(source_kind != "wago_registerbild", f"{prefix}: Registerbild address may not be null")
        return
    errors.check(isinstance(address, dict), f"{prefix}: address must be an object or null")
    if not isinstance(address, dict):
        return
    if source_kind in MODBUS_SOURCE_KINDS:
        registers = address.get("registers")
        errors.check(address.get("kind") == source_kind, f"{prefix}: wrong Modbus address kind")
        errors.check(isinstance(registers, list) and bool(registers), f"{prefix}: Modbus registers must not be empty")
        if isinstance(registers, list):
            errors.check(all(isinstance(register, int) and 0 <= register <= 65535 for register in registers), f"{prefix}: invalid Modbus register")
            errors.check(len(registers) == len(set(registers)), f"{prefix}: duplicate register within address")
            errors.check(address.get("width_words") == len(registers), f"{prefix}: Modbus width_words mismatch")
            errors.check(point.get("width_bits") == len(registers) * 16, f"{prefix}: Modbus width_bits mismatch")
        if point.get("family") in {"string", "hybrid_1p", "hybrid_3p", "micro"}:
            errors.check(point.get("endian") == "word_little_byte_big", f"{prefix}: Deye endian must reflect the pinned decoder")
        else:
            errors.check(point.get("endian") in {"big", "word_little_byte_big"}, f"{prefix}: invalid Modbus endian")
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
    elif source_kind == "wago_registerbild":
        offset = address.get("offset_words")
        width_words = address.get("width_words")
        karte = f"{REGISTERBILD_KOPF}+index*{REGISTERBILD_KARTE}+"
        feld = offset[len(karte):] if isinstance(offset, str) and offset.startswith(karte) else None
        errors.check(address.get("kind") == "registerbild_relative", f"{prefix}: wrong Registerbild address kind")
        errors.check(address.get("base") == "parameter",
                     f"{prefix}: the Registerbild base address is a parameter per installation")
        errors.check(feld is not None and feld.isdigit() and bool(DYNAMIC_OFFSET_RE.fullmatch(offset)),
                     f"{prefix}: Registerbild offset must be {karte}<offset in the card block>")
        errors.check(isinstance(width_words, int) and width_words > 0, f"{prefix}: invalid Registerbild width")
        if feld is not None and feld.isdigit() and isinstance(width_words, int):
            errors.check(int(feld) + width_words <= REGISTERBILD_KARTE, f"{prefix}: Registerbild field leaves the card block")
            errors.check(point.get("width_bits") == width_words * 16, f"{prefix}: Registerbild width_bits mismatch")
        errors.check(point.get("dynamic") is True, f"{prefix}: a Registerbild point is a template per card (karte[*])")
        errors.check(point.get("endian") is None,
                     f"{prefix}: the Registerbild word order is a parameter per installation, not a catalog fact")
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
    aliases = point.get("point_key_aliases")
    errors.check(
        isinstance(aliases, list)
        and all(isinstance(alias, str) and bool(POINT_KEY_RE.fullmatch(alias)) for alias in aliases),
        f"{prefix}: invalid point_key_aliases",
    )
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
    validate_semantics(errors, point, prefix)
    validate_counter_range(errors, point, prefix)
    validate_value_range(errors, point, prefix)
    validate_angaben(errors, point, prefix)


def validate_value_range(errors: ValidationErrors, point: dict[str, Any], prefix: str) -> None:
    """Wertebereich des Rohwerts (AP-05 IP-5): `min` … `max` ist ein Wert, `invalid` heißt kein Messwert.

    Fehlt das Feld, ist nichts deklariert. Ein null, ein Bereich außerhalb des Datentyps oder ein
    `invalid` INNERHALB von `min` … `max` (dann fiele ein echter Wert weg) ist keine Deklaration.
    """
    if "range" not in point:
        return
    bereich = point["range"]
    ganz = isinstance(bereich, dict) and set(bereich) == {"invalid", "max", "min"} and all(
        isinstance(bereich[key], int) and not isinstance(bereich[key], bool) for key in bereich)
    errors.check(ganz, f"{prefix}: range needs integer min, max and invalid (absent = not declared, never null)")
    if not ganz:
        return
    grenzen = GANZZAHL_BEREICH.get(point.get("value_type"))
    errors.check(grenzen is not None,
                 f"{prefix}: range needs a known integer value_type, got {point.get('value_type')!r}")
    errors.check(bereich["min"] <= bereich["max"], f"{prefix}: range min exceeds max")
    errors.check(not bereich["min"] <= bereich["invalid"] <= bereich["max"],
                 f"{prefix}: range invalid lies inside min … max — a real value would be dropped")
    if grenzen is not None:
        errors.check(all(grenzen[0] <= bereich[key] <= grenzen[1] for key in bereich),
                     f"{prefix}: range leaves the {point['value_type']} value space")


def validate_angaben(errors: ValidationErrors, point: dict[str, Any], prefix: str) -> None:
    """Herkunft je Zahl (AP-05 IP-4): festlegung · handbuch mit `gilt_fuer` · zu erheben.

    Eine Handbuch-Angabe gilt nur für die Artikel, die sie nennt — eine WAGO-Karte erbt keine Zahl einer
    anderen Karte (Befund 4 aus IP-2). Was zu erheben ist, steht nicht als Tatsache im Punkt: kein
    Datentyp, keine Skalierung, keine Einheit, kein Bereich, nicht lesbar.
    """
    family = point.get("family")
    artikel = WAGO_KARTEN.get(family)
    if isinstance(family, str) and family.startswith("wago."):
        errors.check(artikel is not None, f"{prefix}: WAGO family without a card article")
    if "angaben" not in point:
        errors.check(artikel is None, f"{prefix}: a WAGO card point names the origin of every number (angaben)")
        errors.check(point.get("value_type") != "unknown" and (point.get("scale") or {}).get("kind") != "unknown",
                     f"{prefix}: an unknown value_type or scale needs angaben (zu erheben)")
        return
    angaben = point["angaben"]
    errors.check(isinstance(angaben, dict), f"{prefix}: angaben must be an object")
    if not isinstance(angaben, dict):
        return
    if artikel is not None:
        fehlend = sorted(WAGO_PFLICHT_ANGABEN - set(angaben))
        errors.check(not fehlend, f"{prefix}: a WAGO card point names the origin of {fehlend}")
    for feld, angabe in sorted(angaben.items()):
        stelle = f"{prefix}: angaben.{feld}"
        errors.check(feld in ANGABE_FELDER, f"{stelle} is no catalog number")
        if not isinstance(angabe, dict):
            errors.check(False, f"{stelle} must be an object")
            continue
        art = angabe.get("art")
        errors.check(art in ANGABE_ARTEN, f"{stelle}: invalid art {art!r}")
        if art == "handbuch":
            gilt = angabe.get("gilt_fuer")
            errors.check(bool(angabe.get("fundstelle")) and isinstance(gilt, list) and bool(gilt),
                         f"{stelle}: a manual quote needs fundstelle and gilt_fuer")
            if artikel is not None:
                errors.check(isinstance(gilt, list) and artikel in gilt,
                             f"{stelle}: quoted for {gilt}, not for {artikel} — a number of another card "
                             f"is not inherited, it is zu erheben")
        elif art == "festlegung":
            errors.check(bool(angabe.get("fundstelle")), f"{stelle}: a festlegung needs a fundstelle")
        elif art == "zu erheben":
            errors.check(bool(angabe.get("wo")), f"{stelle}: zu erheben needs wo")

    def offen(feld: str) -> bool:
        return isinstance(angaben.get(feld), dict) and angaben[feld].get("art") == "zu erheben"

    errors.check(offen("value_type") == (point.get("value_type") == "unknown"),
                 f"{prefix}: value_type is unknown exactly when angaben.value_type is zu erheben")
    if offen("value_type"):
        errors.check(point.get("signed") is None and point.get("readable") is False,
                     f"{prefix}: without a value_type nothing is readable (signed null, readable false)")
    errors.check(offen("scale") == ((point.get("scale") or {}).get("kind") == "unknown"),
                 f"{prefix}: scale is unknown exactly when angaben.scale is zu erheben")
    if offen("scale"):
        errors.check(point.get("unit") is None, f"{prefix}: without a factor the decoded value has no unit")
    if "range" in point:
        errors.check(isinstance(angaben.get("range"), dict) and not offen("range"),
                     f"{prefix}: a range needs a quoted origin in angaben.range")
    elif isinstance(angaben.get("range"), dict):
        errors.check(offen("range"), f"{prefix}: angaben.range quotes an origin, but the point declares no range")


def validate_counter_range(errors: ValidationErrors, point: dict[str, Any], prefix: str) -> None:
    """Z6-Deklaration: Wertebereich und Überlauf stehen nur am Zähler und werden nie geraten.

    Fehlen beide Felder, ist nichts deklariert. Ein null oder ein Vorgabewert ist keine
    Deklaration und wird abgelehnt — so bleibt „nicht deklariert“ genau eine Form.
    """
    declared = [field for field in ZAEHLER_DEKLARATION_FIELDS if field in point]
    if not declared:
        return
    kind = point.get("aggregation_kind")
    errors.check(
        kind == "counter",
        f"{prefix}: {'/'.join(declared)} only on a counter point (aggregation_kind {kind!r})",
    )
    if "wertebereich_modul" in point:
        modul = point["wertebereich_modul"]
        errors.check(
            isinstance(modul, int) and not isinstance(modul, bool) and modul >= 2,
            f"{prefix}: wertebereich_modul must be an integer >= 2, got {modul!r} (absent = not declared, never null)",
        )
    if "laeuft_ueber" in point:
        errors.check(
            isinstance(point["laeuft_ueber"], bool),
            f"{prefix}: laeuft_ueber must be boolean, got {point['laeuft_ueber']!r}",
        )
        errors.check(
            "wertebereich_modul" in point,
            f"{prefix}: laeuft_ueber needs wertebereich_modul (a wrap without a declared range is guessed)",
        )


def counter_points_without_range(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Die Zähler ohne deklarierten Wertebereich, stabil nach Familie und Point-Key."""
    return sorted(
        (point for point in document["points"]
         if point.get("aggregation_kind") == "counter" and "wertebereich_modul" not in point),
        key=lambda point: (point["family"], point["point_key"]),
    )


def validate_semantics(errors: ValidationErrors, point: dict[str, Any], prefix: str) -> None:
    """Größe und Richtung: geschlossen, ehrlich, und JEDE Energie-Größe hat eine Richtung."""
    quantity = point.get("quantity")
    direction = point.get("direction")
    errors.check(quantity is None or quantity in QUANTITIES, f"{prefix}: invalid quantity")
    errors.check(direction is None or direction in DIRECTIONS, f"{prefix}: invalid direction")
    if quantity is None:
        errors.check(direction is None, f"{prefix}: a direction needs a quantity")
    if quantity in DIRECTIONLESS:
        errors.check(direction == "none", f"{prefix}: {quantity} has no flow direction")
    if quantity in ENERGY_QUANTITIES:
        if point.get("point_key") in ENERGY_WITHOUT_DIRECTION:
            errors.check(direction is None, f"{prefix}: listed as energy without direction")
        else:
            errors.check(direction is not None, f"{prefix}: energy point without direction")
    if point.get("unit") in ENERGY_UNITS:
        errors.check(quantity in ENERGY_QUANTITIES, f"{prefix}: energy unit without energy quantity")
    # Ein Zähler ohne Einheit ist BENANNT, nie still (semantics.ZAEHLER_OHNE_ANZEIGE_EINHEIT).
    named = ZAEHLER_OHNE_ANZEIGE_EINHEIT.get(point.get("point_key"))
    if point.get("aggregation_kind") == "counter" and point.get("unit") is None:
        errors.check(named is not None, f"{prefix}: counter without unit is not named")
    if named is not None:
        art, grund = named
        errors.check(point.get("aggregation_kind") == "counter", f"{prefix}: named as counter, is none")
        errors.check(art in ZAEHLER_OHNE_ANZEIGE_EINHEIT_ARTEN and bool(grund.strip()),
                     f"{prefix}: counter without display unit needs a kind and a reason")
        if art == "faktor_im_einheitennamen":
            errors.check(point.get("unit") is not None and (point.get("scale") or {}).get("kind") == "factor",
                         f"{prefix}: a unit with a baked-in factor needs the factor at scale")
        else:
            errors.check(point.get("unit") is None, f"{prefix}: named without unit, has one")
        if art == "einheit_im_schluessel":
            errors.check((point.get("scale") or {}).get("kind") == "protocol_value",
                         f"{prefix}: a unit from the key needs scale protocol_value")
        if art == "keine_energie":
            errors.check(quantity is None, f"{prefix}: no energy, but a quantity")


def validate_runtime_version(errors: ValidationErrors, document: dict[str, Any]) -> None:
    """Der Laufzeitstand ist ein ausgelieferter Stand, und Box + Writer sehen dasselbe wie dort."""
    runtime = document.get("runtime_catalog_version")
    errors.check(runtime == RUNTIME_CATALOG_VERSION, "root runtime_catalog_version mismatch")
    if not isinstance(runtime, str) or runtime != RUNTIME_CATALOG_VERSION:
        return
    order = lambda version: tuple(int(part) for part in version.split("."))  # noqa: E731
    errors.check(order(runtime) <= order(CATALOG_VERSION), "runtime version is newer than the content version")
    shipped = ROOT / "dist" / f"measurement-point-catalog-{runtime}.json"
    errors.check(shipped.exists(), f"runtime version {runtime} has no shipped artifact")
    if not shipped.exists() or not isinstance(document.get("points"), list):
        return
    errors.check(
        runtime_projection(document, runtime) == runtime_projection(read_json(shipped), runtime),
        f"content version changes what the box or writer reads; raise RUNTIME_VERSION (now {runtime})",
    )
    # Die Liste hält eine NEUE Familie von der Box fern — nie eine, die dort schon ist: sonst verschwänden
    # ihre Punkte still aus Palette und Metadaten, und beide Seiten der Gleichung oben mit ihnen.
    ausgeliefert = {point.get("family") for point in read_json(shipped).get("points", [])}
    zurueckgehalten = sorted(ausgeliefert & set(NOCH_NICHT_AN_DER_BOX))
    errors.check(not zurueckgehalten, f"families already at the box cannot be withheld from it: {zurueckgehalten}")


def validate_deye_key_lock(errors: ValidationErrors, document: dict[str, Any], points: list[dict[str, Any]]) -> None:
    lock = read_json(DEYE_KEY_LOCK_PATH)
    errors.check(
        document.get("deye_point_key_lock_sha256") == sha256(DEYE_KEY_LOCK_PATH),
        "Deye point-key lock hash mismatch",
    )
    errors.check(lock.get("schema_version") == "1.0", "Deye point-key lock schema_version must be 1.0")
    entries = lock.get("entries")
    errors.check(isinstance(entries, list), "Deye point-key lock entries must be a list")
    entries = entries if isinstance(entries, list) else []
    lock_keys: list[str] = []
    lock_aliases: list[str] = []
    identities: list[tuple[str, str, str]] = []
    allowed_fields = {"active", "aliases", "family", "fingerprints", "point_key", "source_locators"}
    for index, entry in enumerate(entries):
        prefix = f"Deye lock entry[{index}]"
        errors.check(isinstance(entry, dict), f"{prefix} must be an object")
        if not isinstance(entry, dict):
            continue
        errors.check(set(entry) == allowed_fields, f"{prefix} has unexpected or missing fields")
        key = entry.get("point_key")
        aliases = entry.get("aliases")
        fingerprints = entry.get("fingerprints")
        locators = entry.get("source_locators")
        family = entry.get("family")
        errors.check(isinstance(entry.get("active"), bool), f"{prefix} active must be boolean")
        errors.check(isinstance(family, str) and bool(family), f"{prefix} family is invalid")
        errors.check(isinstance(key, str) and bool(POINT_KEY_RE.fullmatch(key or "")), f"{prefix} point_key is invalid")
        errors.check(
            isinstance(aliases, list) and len(aliases) == len(set(aliases))
            and all(isinstance(alias, str) and bool(POINT_KEY_RE.fullmatch(alias)) for alias in aliases),
            f"{prefix} aliases are invalid",
        )
        errors.check(
            isinstance(fingerprints, list) and bool(fingerprints) and len(fingerprints) == len(set(fingerprints))
            and all(isinstance(value, str) and bool(SHA256_RE.fullmatch(value)) for value in fingerprints),
            f"{prefix} fingerprints are invalid",
        )
        errors.check(
            isinstance(locators, list) and bool(locators) and len(locators) == len(set(locators))
            and all(isinstance(value, str) and bool(value) for value in locators),
            f"{prefix} source_locators are invalid",
        )
        if isinstance(key, str):
            lock_keys.append(key)
        if isinstance(aliases, list):
            lock_aliases.extend(alias for alias in aliases if isinstance(alias, str))
        if isinstance(family, str) and isinstance(fingerprints, list) and isinstance(locators, list):
            identities.extend((family, locator, fingerprint) for locator in locators for fingerprint in fingerprints)
    errors.check(len(lock_keys) == len(set(lock_keys)), "Deye point-key lock has duplicate canonical keys")
    errors.check(len(lock_aliases) == len(set(lock_aliases)), "Deye point-key lock has duplicate aliases")
    errors.check(not (set(lock_keys) & set(lock_aliases)), "Deye alias collides with a canonical key")
    errors.check(len(identities) == len(set(identities)), "Deye point-key lock has duplicate source identities")

    deye_points = {
        point["point_key"]: point
        for point in points
        if point.get("family") in {"string", "hybrid_1p", "hybrid_3p", "micro"}
    }
    active_entries = {entry["point_key"]: entry for entry in entries if isinstance(entry, dict) and entry.get("active")}
    errors.check(set(active_entries) == set(deye_points), "active Deye lock keys differ from generated Deye points")
    for key in set(active_entries) & set(deye_points):
        errors.check(
            deye_points[key].get("point_key_aliases") == active_entries[key].get("aliases"),
            f"{key}: generated aliases differ from Deye lock",
        )


def validate_shelly_evidence(errors: ValidationErrors, points: list[dict[str, Any]]) -> None:
    raw_manifest_path = ROOT / "sources" / "shelly" / "raw-manifest.json"
    raw_manifest = read_json(raw_manifest_path)
    pinned = {source["id"]: source for source in raw_manifest["sources"]}
    shelly_points = [point for point in points if str(point.get("family", "")).startswith("shelly.")]
    errors.check(bool(shelly_points), "Shelly inventory may not be empty")
    for point in shelly_points:
        key = point["point_key"]
        evidence = point.get("source_evidence")
        errors.check(isinstance(evidence, list) and bool(evidence), f"{key}: missing Shelly raw source evidence")
        if not isinstance(evidence, list) or not evidence:
            continue
        for source in evidence:
            source_id = source.get("id") if isinstance(source, dict) else None
            errors.check(source_id in pinned, f"{key}: unknown Shelly raw source {source_id!r}")
            if source_id in pinned:
                errors.check(source == pinned[source_id], f"{key}: Shelly raw evidence differs from its manifest pin")
        errors.check(point.get("source_sha256") == evidence[0].get("sha256"), f"{key}: primary Shelly source hash mismatch")
        errors.check(point.get("source_url") == evidence[0].get("url"), f"{key}: primary Shelly source URL mismatch")


def validate_rueckfall(errors: ValidationErrors, name: str, rueckfall: Any) -> None:
    """UEMS AP-15 IP-6: der Geräte-Rückfall einer steuerbaren Familie — kein anderes Wort als `unbekannt` ohne
    Herstellerquelle (Titel, Fassung, Stelle), eine Zahl nur bei `faellt_auf_wert`, nie über den Katalog hinaus."""
    errors.check(rueckfall == RUECKFALL_OHNE_BOX.get(name), f"{name}: rueckfall_ohne_box mismatch")
    if rueckfall is None:
        return
    errors.check(isinstance(rueckfall, dict) and rueckfall and set(rueckfall) <= {"einspeisung", "bezug"},
                 f"{name}: rueckfall_ohne_box needs einspeisung and/or bezug")
    for richtung, angabe in (rueckfall.items() if isinstance(rueckfall, dict) else []):
        prefix = f"{name}.rueckfall_ohne_box.{richtung}"
        wort = angabe.get("rueckfall")
        errors.check(wort in GERAETE_RUECKFALL_WOERTER, f"{prefix}: unknown word {wort!r}")
        errors.check(isinstance(angabe.get("grund"), str) and angabe["grund"].strip() != "", f"{prefix}: grund missing")
        kw = angabe.get("rueckfall_kw")
        errors.check(kw is None or (wort == "faellt_auf_wert" and isinstance(kw, (int, float)) and kw >= 0),
                     f"{prefix}: rueckfall_kw only with faellt_auf_wert and never negative")
        nach = angabe.get("nach_s")
        errors.check(nach is None or (wort in ("haelt_letzten_wert", "faellt_auf_wert") and isinstance(nach, int) and nach >= 0),
                     f"{prefix}: nach_s only where the device acts after a period")
        quelle = angabe.get("quelle")
        if wort == "unbekannt":
            errors.check(quelle is None and kw is None and nach is None, f"{prefix}: unbekannt carries no source, value or period")
        else:
            errors.check(isinstance(quelle, dict) and all(isinstance(quelle.get(k), str) and quelle[k].strip()
                                                          for k in ("titel", "fassung", "stelle")),
                         f"{prefix}: {wort} needs a manufacturer source with titel, fassung and stelle")


def validate_catalog(path: Path) -> dict[str, Any]:
    errors = ValidationErrors()
    validate_manifest(errors)
    document = read_json(path)
    try:
        validate_json_schema(document, read_json(CATALOG_SCHEMA_PATH), " catalog")
    except (SchemaValidationError, ValueError) as exc:
        errors.check(False, str(exc))
    errors.check(document.get("schema_version") == "1.0", "catalog schema_version must be 1.0")
    errors.check(document.get("catalog_version") == CATALOG_VERSION, "root catalog_version mismatch")
    errors.check(document.get("edge_min_version") == EDGE_MIN_VERSION, "root edge_min_version mismatch")
    errors.check(document.get("source_manifest_sha256") == sha256(MANIFEST_PATH), "source manifest hash mismatch")
    validate_runtime_version(errors, document)
    points = document.get("points")
    errors.check(isinstance(points, list) and bool(points), "catalog needs a non-empty points list")
    points = points if isinstance(points, list) else []
    for index, point in enumerate(points):
        validate_point(errors, point, index)

    keys = [point.get("point_key") for point in points if isinstance(point, dict)]
    errors.check(keys == sorted(keys), "points must be sorted by point_key")
    errors.check(len(keys) == len(set(keys)), "duplicate point_key")
    aliases = [alias for point in points if isinstance(point, dict) for alias in point.get("point_key_aliases", [])]
    errors.check(len(aliases) == len(set(aliases)), "duplicate point_key alias")
    errors.check(not (set(keys) & set(aliases)), "point_key alias collides with a canonical point_key")
    stale = sorted(set(ENERGY_WITHOUT_DIRECTION) - set(keys))
    errors.check(not stale, f"energy-without-direction entries name no point: {stale}")
    stale_counters = sorted(set(ZAEHLER_OHNE_ANZEIGE_EINHEIT) - set(keys))
    errors.check(not stale_counters, f"counter-without-display-unit entries name no point: {stale_counters}")

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
    validate_deye_key_lock(errors, document, points)
    validate_shelly_evidence(errors, points)

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
            errors.check(family.get("an_der_box") is (name not in NOCH_NICHT_AN_DER_BOX), f"{name}: an_der_box mismatch")
            validate_rueckfall(errors, name, family.get("rueckfall_ohne_box"))
    stale_box = sorted(set(NOCH_NICHT_AN_DER_BOX) - set(expected_counts))
    errors.check(not stale_box, f"not-at-the-box entries name no family: {stale_box}")
    stale_rueckfall = sorted(set(RUECKFALL_OHNE_BOX) - set(expected_counts))
    errors.check(not stale_rueckfall, f"rueckfall_ohne_box names no family: {stale_rueckfall}")

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
        errors.check(dimensions.get("units") == OCPP_16_STANDARD_UNITS, "OCPP standard unit set mismatch")
        errors.check("Celcius" not in dimensions.get("units", []), "ocpp-go Celcius compatibility typo must not be a standard unit")
        errors.check(all(point.get("dimensions") == dimensions for point in ocpp), "OCPP dimensions differ between measurands")

    errors.finish()
    return document


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("catalog", type=Path, nargs="?", default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--ohne-wertebereich", action="store_true",
        help="after validation, list every counter point without wertebereich_modul "
             "(family, point_key, source_kind, unit; tab-separated) and a count; a report, exit 0",
    )
    args = parser.parse_args()
    document = validate_catalog(args.catalog)
    if args.ohne_wertebereich:
        counters = sum(point.get("aggregation_kind") == "counter" for point in document["points"])
        without = counter_points_without_range(document)
        for point in without:
            print("\t".join((point["family"], point["point_key"], point["source_kind"], point["unit"] or "-")))
        print(f"{len(without)} of {counters} counter points without wertebereich_modul "
              f"in catalog {document['catalog_version']}")
        return 0
    print(f"validated {len(document['points'])} points in catalog {document['catalog_version']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
