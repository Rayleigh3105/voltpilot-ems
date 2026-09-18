#!/usr/bin/env python3
"""AP-14 IP-8: lesende Messung und Bericht fuer das UEMS-Lastprofil.

Das Werkzeug liest die vorhandenen API-/Writer-Metrik-Endpunkte und genau eine
zaehlende, READ-ONLY-Abfrage. Es schreibt nie in die Probe-Umgebung. Fuer Tests
und einen Werkzeug-Beleg koennen aufgezeichnete Antworten verwendet werden.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ARBEIT_ALTER = "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds"
ARBEIT_OFFEN = "voltpilot_uems_arbeitsliste_offen"
LAEUFER_ALTER = "voltpilot_uems_laeufer_letzter_lauf_age_seconds"
DB_BYTES = "voltpilot_db_table_bytes"
LAG = "voltpilot_kafka_consumer_lag"
LAG_AGE = "voltpilot_kafka_consumer_lag_collect_age_seconds"
LISTEN = ("viertelstunde", "tag", "periode")
KLASSEN = ("roh", "vm", "tag", "ereignis")

PLAN_BYTES = {
    "roh": 20_217_600_000,
    "vm": 109_414_656_000,
    "tag": 1_329_692_000,
    "ereignis": 350_688_000,
}
PLAN_TAGE = {"roh": 90, "vm": 3653, "tag": 3653, "ereignis": 3653}
TAGES_ROHZEILEN = 1_872_000
TAGES_VIERTELSTUNDEN = 124_800

SQL = r"""
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';
SELECT json_build_object(
  'captured_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'raw_rows', (SELECT count(*) FROM device_measurement_sample WHERE tenant_id = :'tenant'::uuid),
  'quarter_rows', (SELECT count(*) FROM messreihe_viertelstunde WHERE tenant_id = :'tenant'::uuid),
  'box_reported_dropped_samples',
    (SELECT coalesce(sum(dropped_samples), 0) FROM device_measurement_sample
      WHERE tenant_id = :'tenant'::uuid)
);
COMMIT;
""".strip()


class Messfehler(RuntimeError):
    pass


@dataclass(frozen=True)
class Sample:
    name: str
    labels: dict[str, str]
    value: float


def prometheus(text: str) -> list[Sample]:
    result = []
    line_re = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([-+0-9.eE]+)$")
    label_re = re.compile(r'(\w+)="((?:\\.|[^"\\])*)"(?:,|$)')
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = line_re.match(line)
        if not match:
            continue
        labels = {m.group(1): bytes(m.group(2), "utf-8").decode("unicode_escape")
                  for m in label_re.finditer(match.group(2) or "")}
        result.append(Sample(match.group(1), labels, float(match.group(3))))
    return result


def _wert(samples: list[Sample], name: str, **labels: str) -> float:
    found = [s.value for s in samples if s.name == name
             and all(s.labels.get(k) == v for k, v in labels.items())]
    if len(found) != 1:
        detail = "fehlt" if not found else f"ist {len(found)}-fach vorhanden"
        label_text = ",".join(f'{k}="{v}"' for k, v in labels.items())
        raise Messfehler(f"Pflichtmetrik {name}{{{label_text}}} {detail}")
    return found[0]


def _http(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.read().decode("utf-8")
    except Exception as exc:
        raise Messfehler(f"Metrik-Endpunkt nicht lesbar: {url}: {exc}") from exc


def _sql(db_url: str, tenant: str) -> dict:
    try:
        uuid.UUID(tenant)
    except ValueError as exc:
        raise Messfehler("--tenant muss eine UUID sein") from exc
    try:
        run = subprocess.run(
            ["psql", db_url, "-XqAt", "-v", "ON_ERROR_STOP=1", "-v", f"tenant={tenant}", "-c", SQL],
            check=True, text=True, capture_output=True, timeout=150,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        stderr = getattr(exc, "stderr", "") or str(exc)
        raise Messfehler(f"READ-ONLY-Zählabfrage fehlgeschlagen: {stderr.strip()}") from exc
    lines = [line for line in run.stdout.splitlines() if line.lstrip().startswith("{")]
    if len(lines) != 1:
        raise Messfehler("READ-ONLY-Zählabfrage lieferte nicht genau ein JSON-Ergebnis")
    return json.loads(lines[0])


def aufnehmen(api_url: str, writer_url: str, db_url: str, tenant: str) -> dict:
    return {
        "captured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "api_metrics": _http(api_url),
        "writer_metrics": _http(writer_url),
        "sql": _sql(db_url, tenant),
    }


def fixture_lesen(pfad: Path, name: str) -> dict:
    basis = pfad / name
    return {
        "captured_at": (basis / "captured-at.txt").read_text().strip(),
        "api_metrics": (basis / "api.prom").read_text(),
        "writer_metrics": (basis / "writer.prom").read_text(),
        "sql": json.loads((basis / "counts.json").read_text()),
    }


def _zeit(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def auswerten(vorher: dict, nachher: dict, *, tenant: str, profil_minuten: int) -> dict:
    if profil_minuten < 1:
        raise Messfehler("Profil-Minuten muessen groesser als 0 sein")
    api_vor = prometheus(vorher["api_metrics"])
    api_nach = prometheus(nachher["api_metrics"])
    writer_vor = prometheus(vorher["writer_metrics"])
    writer_nach = prometheus(nachher["writer_metrics"])
    dauer_s = (_zeit(nachher["captured_at"]) - _zeit(vorher["captured_at"])).total_seconds()
    if dauer_s <= 0:
        raise Messfehler("der zweite Messpunkt muss nach dem ersten liegen")

    offen = {}
    arbeitsalter = {}
    for liste in LISTEN:
        offen[liste] = _wert(api_nach, ARBEIT_OFFEN, liste=liste)
        alter = [s.value for s in api_nach if s.name == ARBEIT_ALTER and s.labels.get("liste") == liste]
        if offen[liste] > 0 and len(alter) != 1:
            raise Messfehler(f"Pflichtmetrik {ARBEIT_ALTER}{{liste=\"{liste}\"}} fehlt bei offener Arbeit")
        if offen[liste] == 0 and alter:
            raise Messfehler(f"{ARBEIT_ALTER}{{liste=\"{liste}\"}} darf bei leerer Liste nicht stehen")
        arbeitsalter[liste] = alter[0] if alter else 0.0

    lag_vor = _wert(writer_vor, LAG, group="timescale-writer", topic="measurements.raw")
    lag_nach = _wert(writer_nach, LAG, group="timescale-writer", topic="measurements.raw")
    _wert(writer_nach, LAG_AGE)

    lauf_vor = _wert(api_vor, LAEUFER_ALTER, laeufer="endgueltigkeit")
    lauf_nach = _wert(api_nach, LAEUFER_ALTER, laeufer="endgueltigkeit")
    ohne_neuen_lauf = lauf_vor + dauer_s
    if lauf_nach >= ohne_neuen_lauf:
        stundenlauf_s = None
    else:
        stundenlauf_s = max(0.0, dauer_s - lauf_nach)

    bytes_delta = {}
    bytes_erwartet = {}
    for klasse in KLASSEN:
        vor = _wert(api_vor, DB_BYTES, **{"class": klasse, "tenant": tenant})
        nach = _wert(api_nach, DB_BYTES, **{"class": klasse, "tenant": tenant})
        bytes_delta[klasse] = int(nach - vor)
        bytes_erwartet[klasse] = PLAN_BYTES[klasse] / PLAN_TAGE[klasse] * profil_minuten / (24 * 60)

    sql_vor, sql_nach = vorher["sql"], nachher["sql"]
    raw_delta = int(sql_nach["raw_rows"] - sql_vor["raw_rows"])
    quarter_delta = int(sql_nach["quarter_rows"] - sql_vor["quarter_rows"])
    writer_rate = raw_delta / (dauer_s / 60)
    erwartet_raw = TAGES_ROHZEILEN * profil_minuten / (24 * 60)
    erwartet_quarter = TAGES_VIERTELSTUNDEN * profil_minuten / (24 * 60)

    # dropped_samples ist nur das, was die Box SELBST meldet. Der Writer hat
    # keinen Zaehler fuer verworfene Umschlaege/Samples; die NW-5-Schwelle ist
    # damit trotz dieser Zusatzbeobachtung nicht entscheidbar.
    box_dropped = int(sql_nach["box_reported_dropped_samples"]
                      - sql_vor["box_reported_dropped_samples"])
    lag_abgebaut_min = dauer_s / 60 if lag_vor > 0 and lag_nach == 0 else None

    relevante_klassen = ("roh", "vm")
    bytes_ist = sum(bytes_delta[k] for k in relevante_klassen)
    bytes_soll = sum(bytes_erwartet[k] for k in relevante_klassen)
    return {
        "messdauer_s": dauer_s,
        "profil_minuten": profil_minuten,
        "verbraucher_rueckstand": {"vorher": lag_vor, "nachher": lag_nach,
                                    "abgebaut_spaetestens_min": lag_abgebaut_min},
        "writer_rate_samples_min": writer_rate,
        "arbeitslisten_offen": offen,
        "arbeitslisten_alter_s": arbeitsalter,
        "stundenlauf_beobachtet_s": stundenlauf_s,
        "bytes_delta": bytes_delta,
        "bytes_erwartet": bytes_erwartet,
        "rohzeilen": {"gemessen": raw_delta, "erwartet": erwartet_raw},
        "viertelstundenzeilen": {"gemessen": quarter_delta, "erwartet": erwartet_quarter},
        "box_gemeldete_verworfene_samples": box_dropped,
        "cloud_verworfene_samples": None,
        "cloud_verworfene_samples_luecke": (
            "Keine vorhandene Metrik oder Tabelle zaehlt vom Writer verworfene Umschlaege/Samples; "
            "dropped_samples belegt nur von der Box gemeldete Pufferverluste."
        ),
        "speicher_gesamt": {"gemessen": bytes_ist, "erwartet": bytes_soll,
                             "untergrenze": bytes_soll * 0.8, "obergrenze": bytes_soll * 1.2},
    }


def _urteil(ok: bool | None) -> str:
    if ok is None:
        return "NICHT MESSBAR"
    return "BESTANDEN" if ok else "NICHT BESTANDEN"


def bericht(ergebnis: dict, *, umgebung: str, commit: str) -> str:
    max_alter = max(ergebnis["arbeitslisten_alter_s"].values())
    lag_min = ergebnis["verbraucher_rueckstand"]["abgebaut_spaetestens_min"]
    lauf = ergebnis["stundenlauf_beobachtet_s"]
    speicher = ergebnis["speicher_gesamt"]
    speicher_ok = speicher["untergrenze"] <= speicher["gemessen"] <= speicher["obergrenze"]
    rows_ok = (round(ergebnis["rohzeilen"]["gemessen"]) == round(ergebnis["rohzeilen"]["erwartet"])
               and round(ergebnis["viertelstundenzeilen"]["gemessen"])
               == round(ergebnis["viertelstundenzeilen"]["erwartet"]))
    lines = [
        "# NW-5 Lastprofil — Messbericht",
        "",
        f"- Umgebung: {umgebung}",
        f"- Stand (Commit): {commit}",
        f"- Messdauer: {ergebnis['messdauer_s']:.0f} s",
        f"- Simulierte Dauer: {ergebnis['profil_minuten']} min",
        "- Einordnung: Werkzeug-Beleg, keine Abnahme-Messung",
        "",
        "| Schwelle aus §3.3 | Soll | Gemessen | Urteil |",
        "|---|---:|---:|---|",
        f"| Samples verworfen | 0 | keine vollständige Quelle (Box meldete {ergebnis['box_gemeldete_verworfene_samples']}) | {_urteil(None)} |",
        f"| Ereignis-Bus-Rückstand nach Stoß abgebaut | < 15 min | {f'≤ {lag_min:.2f} min' if lag_min is not None else 'nicht abgebaut'} | {_urteil(lag_min is not None and lag_min < 15)} |",
        f"| Ältester Arbeitslisten-Eintrag im Dauerlauf | < 15 min | {max_alter / 60:.2f} min | {_urteil(max_alter < 15 * 60)} |",
        f"| Stundenlauf | < 10 min | {f'≤ {lauf / 60:.2f} min' if lauf is not None else 'kein Abschluss beobachtet'} | {_urteil(lauf is not None and lauf < 10 * 60)} |",
        f"| Datenbankwachstum (roh + vm) | ±20 % der Speicherrechnung | {speicher['gemessen']:.0f} B (Soll {speicher['erwartet']:.0f} B) | {_urteil(speicher_ok)} |",
        f"| Zeilen bei Profil-Dauer | skaliert aus 1 872 000 roh / 124 800 vm je Tag | {ergebnis['rohzeilen']['gemessen']} roh / {ergebnis['viertelstundenzeilen']['gemessen']} vm | {_urteil(rows_ok)} |",
        "",
        "## Messwerte",
        "",
        f"- Writer-Rate: {ergebnis['writer_rate_samples_min']:.2f} Rohzeilen/min (Wanduhr)",
        f"- Verbraucher-Rückstand: {ergebnis['verbraucher_rueckstand']['vorher']:.0f} → {ergebnis['verbraucher_rueckstand']['nachher']:.0f}",
        "- Bytes je Speicherklasse: " + ", ".join(
            f"{k} {v} B" for k, v in ergebnis["bytes_delta"].items()),
        "",
        "## Benannte Messlücke",
        "",
        ergebnis["cloud_verworfene_samples_luecke"],
        "Die Zeile „Samples verworfen“ darf deshalb nicht als bestanden markiert werden.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AP-14 IP-8: Lastprofil lesend messen")
    quelle = parser.add_mutually_exclusive_group(required=True)
    quelle.add_argument("--fixtures", type=Path, help="aufgezeichnete before/after-Antworten")
    quelle.add_argument("--api-url", help="API-/metrics; live zusammen mit --writer-url/--db-url/--tenant")
    parser.add_argument("--writer-url")
    parser.add_argument("--db-url")
    parser.add_argument("--tenant", required=True, help="interne UUID; erscheint nicht im Bericht")
    parser.add_argument("--intervall-s", type=int, default=300)
    parser.add_argument("--profil-minuten", type=int, required=True)
    parser.add_argument("--umgebung", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.fixtures:
            vorher = fixture_lesen(args.fixtures, "before")
            nachher = fixture_lesen(args.fixtures, "after")
        else:
            if not args.writer_url or not args.db_url:
                raise Messfehler("live brauchen --writer-url und --db-url")
            vorher = aufnehmen(args.api_url, args.writer_url, args.db_url, args.tenant)
            time.sleep(args.intervall_s)
            nachher = aufnehmen(args.api_url, args.writer_url, args.db_url, args.tenant)
        ergebnis = auswerten(vorher, nachher, tenant=args.tenant, profil_minuten=args.profil_minuten)
        text = bericht(ergebnis, umgebung=args.umgebung, commit=args.commit)
        if args.output:
            args.output.write_text(text, encoding="utf-8")
        else:
            print(text, end="")
        return 0
    except (Messfehler, KeyError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"FEHLER: {exc}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
