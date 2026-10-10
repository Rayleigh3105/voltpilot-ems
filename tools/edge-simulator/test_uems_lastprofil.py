"""AP-14 IP-8: exakte Raten und Puffermengen des Lastprofils."""

import json
from collections import Counter
from datetime import datetime, timezone

import pytest

from uems_lastprofil import (
    BOXEN,
    SAMPLES_JE_BOX_MINUTE,
    SAMPLES_JE_MINUTE,
    STOSS_SAMPLES,
    STOSS_VIERTELSTUNDEN,
    bytes_der_zustellung,
    dauerlast,
    kaltstart,
    nachliefer_stoss,
)
from uems_szenarien import VERTRAEGE

jsonschema = pytest.importorskip("jsonschema", reason="Vertragspruefung braucht jsonschema")


def _zaehlen(zustellungen):
    zahlen = Counter()
    for z in zustellungen:
        zahlen[z.box] += len(z.nutzlast["samples"])
    return zahlen


def _zeit(value):
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


@pytest.mark.parametrize("minuten", [1, 3, 17])
def test_dauerlast_hat_je_box_exakt_325_samples_pro_minute(minuten):
    zahlen = _zaehlen(dauerlast(minuten).zustellungen)
    assert zahlen == Counter({box: minuten * SAMPLES_JE_BOX_MINUTE for box in BOXEN})
    assert sum(zahlen.values()) == minuten * SAMPLES_JE_MINUTE


def test_nachliefer_stoss_hat_exakt_68250_samples_und_4550_viertelstunden():
    zustellungen = list(nachliefer_stoss().zustellungen)
    replay = [z for z in zustellungen if z.box == "E-3" and z.aus_outbox]
    assert sum(len(z.nutzlast["samples"]) for z in replay) == STOSS_SAMPLES == 68_250
    assert STOSS_VIERTELSTUNDEN == 4_550
    assert [z.sequenz for z in replay] == list(range(1, 421))
    messzeiten = [z.nutzlast["observed_at"] for z in replay]
    assert messzeiten == sorted(messzeiten), "Outbox bleibt FIFO"
    assert all(z.eingangszeit > z.nutzlast["observed_at"] for z in replay)
    assert replay[0].zustellart == "nachgeliefert"
    for z in replay:
        verzug = _zeit(z.eingangszeit) - _zeit(z.nutzlast["observed_at"])
        assert z.zustellart == ("nachgeliefert" if verzug.total_seconds() > 300 else "direkt")


def test_kaltstart_ist_eine_fifo_rueckrechnung_aller_boxen():
    zustellungen = list(kaltstart(2).zustellungen)
    assert sum(len(z.nutzlast["samples"]) for z in zustellungen) == 2 * SAMPLES_JE_MINUTE
    assert all(z.aus_outbox for z in zustellungen)
    for z in zustellungen:
        verzug = _zeit(z.eingangszeit) - _zeit(z.nutzlast["observed_at"])
        assert z.zustellart == ("nachgeliefert" if verzug.total_seconds() > 300 else "direkt")


def test_gleicher_samen_erzeugt_bytegleiche_nutzlasten():
    a = b"\n".join(bytes_der_zustellung(z) for z in dauerlast(2, seed=91).zustellungen)
    b = b"\n".join(bytes_der_zustellung(z) for z in dauerlast(2, seed=91).zustellungen)
    c = b"\n".join(bytes_der_zustellung(z) for z in dauerlast(2, seed=92).zustellungen)
    assert a == b
    assert a != c


def test_jeder_umschlag_ist_der_bestehende_vertrag_2_0():
    schema = json.loads((VERTRAEGE / "mqtt-measurement-samples.schema.json").read_text())
    pruefer = jsonschema.validators.validator_for(schema)(schema)
    for z in dauerlast(2).zustellungen:
        pruefer.validate(z.nutzlast)
        segmente = z.topic.split("/")
        assert segmente[1:4] == [z.nutzlast["tenant_id"], z.nutzlast["site_id"], z.nutzlast["device_id"]]
        assert len(z.nutzlast["samples"]) in (256, 69)
        assert z.qos == 1 and z.retain is False


def test_325_bleibt_unter_dem_harten_budget_aus_dem_vertrag():
    vertrag = json.loads((VERTRAEGE / "measurement-budget-vectors.json").read_text())
    grenzen = vertrag["limits"]
    assert SAMPLES_JE_BOX_MINUTE == 325
    assert grenzen == {"samples_soft": 120, "samples_hard": 600, "requests": 30, "duty_pct": 20}
    assert grenzen["samples_soft"] < SAMPLES_JE_BOX_MINUTE < grenzen["samples_hard"]
    # E6: 25 WAGO-Karten, 2 Karten je Anfrage, 400 ms je Anfrage.
    familie = vertrag["families"]["wago_registerbild"]
    anfragen = -(-25 // familie["units_per_request"])
    buszeit = anfragen * familie["request_cost_ms"] / 60_000 * 100
    assert anfragen == 13 < grenzen["requests"]
    assert buszeit == pytest.approx(8.6666666667)
    assert buszeit < grenzen["duty_pct"]
