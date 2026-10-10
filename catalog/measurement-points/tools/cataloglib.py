"""Shared helpers for the deterministic measurement-point catalog tooling."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
# Zwei Stände (README „Inhaltsstand und Laufzeitstand“): VERSION ist der Inhaltsstand dieses
# Artefakts, RUNTIME_VERSION der Stand, den die Box spricht — die Palette lehnt jede
# Mess-Konfiguration mit fremder catalog_version ab (measurement-planner.js).
CATALOG_VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
RUNTIME_CATALOG_VERSION = (ROOT / "RUNTIME_VERSION").read_text(encoding="utf-8").strip()
EDGE_MIN_VERSION = "unreleased"
POINT_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9._*\[\]@-]*$")

# Was die Box je Punkt liest (der Palette-Katalog) ... `range` (UEMS AP-05 IP-5: `invalid` = kein
# Messwert) tragen die WAGO-Karten; gelesen wird es vom Treiber aus AP-05 IP-6 und kam mit dem
# Laufzeitstand 2026.09.23.3 an die Box (IP-6b) — wer es an einen weiteren Punkt schreibt, hebt ihn.
EDGE_FIELDS = (
    "address", "aggregation_kind", "catalog_version", "decoder",
    "default_cadence_s", "derived_from", "edge_min_version", "endian",
    "family", "min_cadence_s", "point_key", "poll_group", "range", "readable",
    "scale", "selector", "signed", "source_kind", "unit", "value_type",
    "width_bits", "dimensions",
)
# ... und was der Writer je Punkt nachschlägt (die Metadaten-Migration).
RUNTIME_FIELDS = EDGE_FIELDS + ("long_term_cadence_s",)
# Familien, die der INHALTSSTAND führt, die aber noch an keine Box gehen (README „Familien noch nicht
# an der Box“): ihre Punkte fehlen in der Box-Sicht, im Palette-Katalog und in der Metadaten-Migration,
# und die api bietet sie nicht zur Auswahl an. So hebt eine neue Quelle den Laufzeitstand NICHT — der
# Eintrag fällt erst mit dem Edge-Release, das ihre Punkte lesen kann, und dann steigt RUNTIME_VERSION.
# ⚠ Nie eine Familie eintragen, die schon an einer Box ist (`validate.py` lehnt das ab).
# Heute leer: `wago.pm494`/`wago.pm495` gingen mit dem Laufzeitstand 2026.09.23.3 an die Box (UEMS AP-05
# IP-6b, wirksam mit dem Box-Release, das diese Palette trägt).
NOCH_NICHT_AN_DER_BOX: dict[str, str] = {}

# Cloud-only fact for UEMS AP-06 IP-21.  Family metadata is deliberately not part of
# EDGE_FIELDS/runtime_projection: deciding whether two boxes may read the same physical device is
# a cloud-side creation rule, not a decoder concern and therefore needs no Edge release.
SINGLE_READER_FAMILIES = {
    "hybrid_1p", "hybrid_3p", "micro", "string",  # Solarman data logger
    "wago.pm494", "wago.pm495",                    # WAGO coupler mailbox
}
# Geräte-Rückfall je STEUERBARER Familie (UEMS AP-15 IP-6, Regel G3, Kasten E2 = A; Vokabular
# `geraete_rueckfall` aus docs/contracts/v2/steuerungsverbund.md §2): was ein Gerät tut, wenn seine Box
# schweigt, je Richtung. Cloud-only wie SINGLE_READER_FAMILIES — nicht in EDGE_FIELDS, kein Edge-Release.
# Eine Familie fehlt hier = VoltPilot steuert sie nicht (`null` im Artefakt); eine Richtung fehlt = keine
# Angabe. Die Zahl macht allein die api (uems/GeraeteRueckfallRegel): `unbekannt`, `laeuft_frei` und
# `haelt_letzten_wert` zählen mit Nennleistung, nur `faellt_auf_wert` mit `rueckfall_kw` weniger.
# ⚠ KEINE ERFUNDENEN HERSTELLERANGABEN: ein anderes Wort als `unbekannt` nur mit `quelle` (Titel, Fassung,
# Stelle) — `validate.py` lehnt es sonst ab. Die Bestätigung je Modell am Prüfstand trägt der Betreiber ein
# (NW-7), nicht dieser Katalog. `grund` sagt, was belegt ist und warum die Familie es nicht festlegt.
def _unbekannt(grund: str) -> dict[str, Any]:
    return {"grund": grund, "nach_s": None, "quelle": None, "rueckfall": "unbekannt", "rueckfall_kw": None}


_DEYE = ("Zwei Steuerwege je Gerät: Fernsteuerung verlässt nach dem Totmann-Register 1101 den Remote-Modus "
         "(Deye MODBUS RTU V105.1, ohne Seite; ab Werk 0xFFFF = aus), Zeitfenster hält die EEPROM-Werte — "
         "die Familie legt das Verhalten nicht fest; Angabe je Komponente")
_SUNSPEC_123 = ("WMaxLimPct_RvrtTms „Timeout period for power limit.“ (SunSpec-Modell 123) nennt eine Frist, "
                "nicht das Verhalten danach; Fronius: 0 = aktiv bis zur Abwahl — hängt an der Einstellung")
_SUNSPEC_124 = ("InOutWRte_RvrtTms: Verhalten nach der Frist beim Hersteller nicht dokumentiert "
                "(edge-app/nodered/FRONIUS.md, Prüfstand-Punkt)")
_KOSTAL = ("Rückkehr zur internen Batteriesteuerung nach einem im Webserver einstellbaren Timeout "
           "(KOSTAL Interface description MODBUS (TCP) & SunSpec Rev. 2.9 laut edge-app/nodered/KOSTAL.md, "
           "ohne Seite) — ob und wann, hängt an der Einstellung am Gerät")
_GOE = "Die Schlüsselliste des Herstellers (API v2) nennt für frc/amp keinen Rückfall ohne Steuerung"
_SHELLY = ("Der Rückfall-Timer (toggle_after bzw. timer) setzt der Schaltbefehl der Box, nicht das Modell; "
           "was die geschaltete Last danach bezieht, weiß der Katalog nicht (z. B. SG-Ready)")
_OCPP = ("OCPP-eigener Rückfall auf das gespeicherte Standardprofil der Säule — sein Wert gehört der "
         "einzelnen Säule (Angabe je Komponente); eine Stelle der Spezifikation zitiert das Repo nicht")

RUECKFALL_OHNE_BOX: dict[str, dict[str, dict[str, Any]]] = {
    "goe.api_v2": {"bezug": _unbekannt(_GOE)},
    "hybrid_1p": {"bezug": _unbekannt(_DEYE), "einspeisung": _unbekannt(_DEYE)},
    "hybrid_3p": {"bezug": _unbekannt(_DEYE), "einspeisung": _unbekannt(_DEYE)},
    "kostal_plenticore": {"bezug": _unbekannt(_KOSTAL), "einspeisung": _unbekannt(_KOSTAL)},
    "ocpp.1_6": {"bezug": _unbekannt(_OCPP)},
    "shelly.gen1": {"bezug": _unbekannt(_SHELLY)},
    "shelly.gen2plus": {"bezug": _unbekannt(_SHELLY)},
    "sunspec.model_123": {"einspeisung": _unbekannt(_SUNSPEC_123)},
    "sunspec.model_124": {"bezug": _unbekannt(_SUNSPEC_124), "einspeisung": _unbekannt(_SUNSPEC_124)},
}
GERAETE_RUECKFALL_WOERTER = ("haelt_letzten_wert", "faellt_auf_wert", "laeuft_frei", "unbekannt")
# Z6-Deklaration eines Zählers (AP-08 IP-7, README „Wertebereich eines Zählers“): optional, nur
# am Zähler, nur aus einer Quelle übernommen. Fehlt ein Feld, ist nichts deklariert — der
# Generator schreibt nie null oder einen Vorgabewert.
ZAEHLER_DEKLARATION_FIELDS = ("wertebereich_modul", "laeuft_ueber")


def box_points(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    """Die Punkte, die an eine Box gehen — ohne die Familien aus `NOCH_NICHT_AN_DER_BOX`."""
    return [point for point in catalog["points"] if point["family"] not in NOCH_NICHT_AN_DER_BOX]


def runtime_projection(catalog: dict[str, Any], version: str) -> list[dict[str, Any]]:
    """Die Punkte, wie Box und Writer sie sehen, gestempelt mit dem Laufzeitstand `version`."""
    return [
        {key: (version if key == "catalog_version" else point[key])
         for key in RUNTIME_FIELDS if key in point}
        for point in box_points(catalog)
    ]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    result = re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")
    return result or "unnamed"


def width_bits_from_type(value_type: str | None) -> int | None:
    if not value_type:
        return None
    cleaned = value_type.replace("&lt;", "<").replace("&gt;", ">")
    cleaned = re.sub(r"^(optional|get:)<*", "", cleaned).strip(" >")
    if cleaned == "bool":
        return 1
    if "double" in cleaned or "uint64" in cleaned or "int64" in cleaned:
        return 64
    if "float" in cleaned or "uint32" in cleaned or "int32" in cleaned or "milliseconds" in cleaned:
        return 32
    if "uint16" in cleaned or "int16" in cleaned:
        return 16
    if "uint8" in cleaned or "int8" in cleaned:
        return 8
    return None


def signed_from_type(value_type: str | None) -> bool | None:
    if not value_type:
        return None
    cleaned = value_type.lower()
    if "|" in cleaned or any(token in cleaned for token in ("string", "legacy", "json", "array", "object")):
        return None
    if "uint" in cleaned or "bool" in cleaned or "bitfield" in cleaned or "enum" in cleaned or "acc" in cleaned or "count" in cleaned:
        return False
    if "int" in cleaned or "float" in cleaned or "double" in cleaned or "sunssf" in cleaned:
        return True
    return None


def base_point(
    *,
    family: str,
    point_key: str,
    source_kind: str,
    address: dict[str, Any] | None,
    selector: str,
    width_bits: int | None,
    value_type: str,
    signed: bool | None,
    endian: str | None,
    scale: dict[str, Any],
    unit: str | None,
    group: str,
    label_de: str | None,
    label_source: str | None,
    semantic_status: str,
    aggregation_kind: str,
    default_cadence_s: int | None,
    min_cadence_s: int | None,
    long_term_cadence_s: int | None,
    poll_group: str,
    source: dict[str, Any],
    **extra: Any,
) -> dict[str, Any]:
    point_key_aliases = extra.pop("point_key_aliases", [])
    point = {
        "address": address,
        "aggregation_kind": aggregation_kind,
        "catalog_version": CATALOG_VERSION,
        "default_cadence_s": default_cadence_s,
        "edge_min_version": EDGE_MIN_VERSION,
        "endian": endian,
        "family": family,
        "group": group,
        "label_de": label_de,
        "label_source": label_source,
        "long_term_cadence_s": long_term_cadence_s,
        "min_cadence_s": min_cadence_s,
        "point_key": point_key,
        "point_key_aliases": point_key_aliases,
        "poll_group": poll_group,
        "scale": scale,
        "selector": selector,
        "semantic_status": semantic_status,
        "signed": signed,
        "source_commit": source.get("source_commit"),
        "source_kind": source_kind,
        "source_revision": source.get("source_revision"),
        "source_sha256": source["source_sha256"],
        "source_url": source["source_url"],
        "unit": unit,
        "value_type": value_type,
        "width_bits": width_bits,
    }
    point.update(extra)
    return point


def source_file(source: dict[str, Any], relative: str | None = None) -> Path:
    path = relative or source["path"]
    return ROOT / path
