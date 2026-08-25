"""Dependency-free evaluator for the JSON Schema vocabulary used here.

The catalog CI must run without downloading packages. This module evaluates
every keyword present in the committed Draft 2020-12 schemas and rejects a
schema containing an unsupported keyword, so a schema change cannot silently
degrade into annotation-only validation.
"""

from __future__ import annotations

import json
import re
from typing import Any


SUPPORTED_KEYWORDS = {
    "$defs", "$id", "$ref", "$schema", "additionalProperties", "allOf",
    "const", "description", "enum", "if", "items", "maximum", "maxItems",
    "minimum", "minItems", "minLength", "oneOf", "pattern", "prefixItems",
    "properties", "required", "then", "title", "type", "uniqueItems",
}


class SchemaValidationError(ValueError):
    """Raised when an instance does not conform to its committed schema."""


def _walk_schema_keywords(schema: Any, path: str = "$schema") -> None:
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise ValueError(f"{path}: schema must be an object or boolean")
    unknown = set(schema) - SUPPORTED_KEYWORDS
    if unknown:
        raise ValueError(f"{path}: unsupported JSON Schema keywords {sorted(unknown)}")
    for collection in ("$defs", "properties"):
        for name, child in schema.get(collection, {}).items():
            _walk_schema_keywords(child, f"{path}.{collection}.{name}")
    for collection in ("allOf", "oneOf", "prefixItems"):
        for index, child in enumerate(schema.get(collection, [])):
            _walk_schema_keywords(child, f"{path}.{collection}[{index}]")
    for keyword in ("additionalProperties", "if", "items", "then"):
        child = schema.get(keyword)
        if isinstance(child, (dict, bool)):
            _walk_schema_keywords(child, f"{path}.{keyword}")


def _resolve_ref(root: dict[str, Any], reference: str) -> Any:
    if not reference.startswith("#/"):
        raise ValueError(f"only local JSON Schema references are supported: {reference}")
    value: Any = root
    for raw_part in reference[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        value = value[part]
    return value


def _json_type_matches(value: Any, expected: str) -> bool:
    return {
        "array": isinstance(value, list),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "null": value is None,
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "object": isinstance(value, dict),
        "string": isinstance(value, str),
    }.get(expected, False)


def _validate(instance: Any, schema: Any, root: dict[str, Any], path: str) -> list[str]:
    if schema is True:
        return []
    if schema is False:
        return [f"{path}: value is forbidden by schema"]
    errors: list[str] = []

    if "$ref" in schema:
        errors.extend(_validate(instance, _resolve_ref(root, schema["$ref"]), root, path))

    expected_types = schema.get("type")
    if expected_types is not None:
        expected_types = [expected_types] if isinstance(expected_types, str) else expected_types
        if not any(_json_type_matches(instance, expected) for expected in expected_types):
            errors.append(f"{path}: expected type {expected_types}, got {type(instance).__name__}")
            return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: value {instance!r} is not in enum")

    if isinstance(instance, str):
        if len(instance) < schema.get("minLength", 0):
            errors.append(f"{path}: string is shorter than minLength")
        if "pattern" in schema and re.search(schema["pattern"], instance) is None:
            errors.append(f"{path}: string does not match pattern {schema['pattern']!r}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: number is below minimum {schema['minimum']}")
        if "maximum" in schema and instance > schema["maximum"]:
            errors.append(f"{path}: number is above maximum {schema['maximum']}")

    if isinstance(instance, dict):
        required = schema.get("required", [])
        for name in required:
            if name not in instance:
                errors.append(f"{path}: required property {name!r} is missing")
        properties = schema.get("properties", {})
        for name, value in instance.items():
            if name in properties:
                errors.extend(_validate(value, properties[name], root, f"{path}.{name}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: additional property {name!r} is not allowed")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(_validate(value, schema["additionalProperties"], root, f"{path}.{name}"))

    if isinstance(instance, list):
        if len(instance) < schema.get("minItems", 0):
            errors.append(f"{path}: array has fewer than minItems")
        if "maxItems" in schema and len(instance) > schema["maxItems"]:
            errors.append(f"{path}: array has more than maxItems")
        if schema.get("uniqueItems"):
            rendered = [json.dumps(value, ensure_ascii=False, sort_keys=True) for value in instance]
            if len(rendered) != len(set(rendered)):
                errors.append(f"{path}: array items are not unique")
        prefixes = schema.get("prefixItems", [])
        for index, child_schema in enumerate(prefixes[:len(instance)]):
            errors.extend(_validate(instance[index], child_schema, root, f"{path}[{index}]"))
        items = schema.get("items")
        if items is not None:
            for index in range(len(prefixes), len(instance)):
                errors.extend(_validate(instance[index], items, root, f"{path}[{index}]"))

    for child_schema in schema.get("allOf", []):
        errors.extend(_validate(instance, child_schema, root, path))
    if "oneOf" in schema:
        branch_errors = [_validate(instance, child, root, path) for child in schema["oneOf"]]
        matches = sum(not child_errors for child_errors in branch_errors)
        if matches != 1:
            errors.append(f"{path}: expected exactly one oneOf match, got {matches}")
            if matches == 0:
                for child_errors in branch_errors:
                    errors.extend(child_errors)
    if "if" in schema and not _validate(instance, schema["if"], root, path) and "then" in schema:
        errors.extend(_validate(instance, schema["then"], root, path))
    return errors


def validate_json_schema(instance: Any, schema: dict[str, Any], name: str = "instance") -> None:
    """Validate an instance and fail loudly on unsupported schema vocabulary."""

    _walk_schema_keywords(schema)
    errors = _validate(instance, schema, schema, "$" + name)
    if errors:
        rendered = "\n".join(f"- {error}" for error in errors[:100])
        if len(errors) > 100:
            rendered += f"\n- ... and {len(errors) - 100} more"
        raise SchemaValidationError(f"JSON Schema validation failed:\n{rendered}")
