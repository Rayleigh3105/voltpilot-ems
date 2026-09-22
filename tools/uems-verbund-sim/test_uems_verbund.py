"""Der Simulator ohne Broker: Physik, Profile, Messung, Modbus, Nutzlasten gegen die Verträge.

Lauf: make test  (PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest)
"""

from __future__ import annotations

import datetime as dt
import json
import struct
from pathlib import Path

import jsonschema
import pytest

import nutzlast
import protokoll
import uems_verbund as uv

VERTRAEGE = Path(__file__).resolve().parents[2] / "docs" / "contracts"


# --- Geräte und Rückfall ----------------------------------------------------

def test_rueckfaelle_kommen_aus_der_referenzdatei():
    rf = uv.lade_rueckfaelle()
    assert (rf["K-1"]["rueckfall_kw"], rf["K-1"]["nach_s"]) == (40, 60)
    assert rf["K-12"]["rueckfall"] == "laeuft_frei"
    assert [rf[f"K-13.{i}"]["rueckfall_kw"] for i in range(1, 7)] == [4.1] * 6
    assert uv.lade_grenzen() == (100.0, 550.0)


def test_geraet_folgt_befehl_mit_stellzeit_und_rampe():
    g = uv.Geraet("K-1", 100, 10, rueckfall_kw=40, nach_s=60)
    g.befehl(0, 30)
    g.schritt(0)                    # Befehl wirkt erst nach 1 s Stellzeit - bis dahin Rückfall
    assert g.wirkt == 10            # Rampe 10 kW/s Richtung Rückfall 40
    g.schritt(1)
    assert g.wirkt == 20            # jetzt Richtung Befehl 30
    g.schritt(2)
    assert g.wirkt == 30


def test_geraet_faellt_nach_seinem_wachhund_zurueck():
    g = uv.Geraet("K-1", 100, 100, rueckfall_kw=40, nach_s=60)
    g.befehl(0, 10)
    for s in range(1, 62):
        g.schritt(s)
    assert g.wirkt == 10 and not g.ziel(61)[1]
    g.schritt(62)
    assert g.wirkt == 40 and g.ziel(62)[1]


def test_geraet_ohne_eigene_frist_faellt_nach_einem_fehlenden_schreibtakt():
    g = uv.Geraet("K-12", 60, 60, frei=True)
    g.befehl(0, 20)
    assert g.ziel(1 + 11) == (20, False)
    assert g.ziel(1 + 12) == (60, True)  # läuft frei mit Nennleistung


# --- Anlage und Profil ------------------------------------------------------

def test_netzpunkt_ist_die_summe_der_abgaenge_mit_vorzeichen():
    a = uv.Anlage(uv.profil("mittag"), t0_s=10)
    a.k1.wirkt = a.k12.wirkt = 1000  # frei, von der Sonne begrenzt
    a.k2.wirkt = -60
    for g in a.alle():
        g.rampe_kw_s = 0  # Werte festhalten
    a.schritt()
    assert a.pv_k1 == 100 and a.pv_k12 == 30
    assert a.abgang_e4 == -30
    assert a.netz == 0 - 60 - 100 - 30  # Bezug +, Einspeisung -


def test_mittag_hat_die_wolkenluecke_fuenf_sekunden_nach_t0():
    p = uv.profil("mittag")
    assert (p.sonne_k12(4), p.sonne_k12(5)) == (30, 60)
    assert p.e1_speicher_kw == -60
    with pytest.raises(ValueError):
        uv.profil("abend")


def test_schreibbefehl_wirkt_nur_mit_freigabe():
    a = uv.Anlage(uv.profil("mittag"), t0_s=10)
    regs = [0] * uv.N_REGISTER
    a.schreibe("E-1", uv.R_PVLIMIT, 800, regs)
    assert not a.k1.anstehend
    a.schreibe("E-1", uv.R_ENABLE, 1, regs)
    a.schreibe("E-1", uv.R_PVLIMIT, 800, regs)
    a.schreibe("E-1", uv.R_SETPOINT, (-6000) & 0xFFFF, regs)
    a.schreibe("E-4", uv.R_SETPOINT, 1234, regs)  # E-4 hat keinen Speicher
    assert a.k1.anstehend == [(1, 8.0)]
    assert a.k2.anstehend == [(1, -60.0)]
    a.schreibe("E-4", uv.R_PVLIMIT, uv.KEIN_PV_LIMIT, regs)
    assert a.k12.anstehend == [(1, 60.0)]  # keine Grenze = Nennleistung


def test_registerkarte_traegt_nur_int16_mal_0_01_kw():
    assert uv.kodiere_s16(-98.0) == (-9800) & 0xFFFF
    assert uv.s16(uv.kodiere_s16(-327.67)) == -32767
    with pytest.raises(OverflowError):
        uv.kodiere_s16(650.0)  # Nacht: 473 + 100 + 77 kW am Netzpunkt


def test_nacht_laeuft_ueber_die_karte_und_wird_gezaehlt():
    a = uv.Anlage(uv.profil("nacht"), t0_s=10)
    a.k2.wirkt, a.k2.rampe_kw_s, a.k2.rueckfall_kw = 100, 0, 100
    a.schritt()
    seite = uv.BoxSeite("E-1")
    seite.aktualisiere(a)
    assert a.netz > 327.67 and seite.ueberlauf == 1


# --- Messung M-1/M-2 --------------------------------------------------------

def test_m1_zaehlt_nur_volle_viertel_und_m2_die_laengste_strecke():
    m = uv.Messung(100.0, -1)
    for s in range(1, 901):
        m.nimm(s, -90.0)
    for s in range(901, 907):          # 6 s mit +26,8 kW darüber
        m.nimm(s, -126.8)
    for s in range(907, 1200):
        m.nimm(s, -90.0)
    m.schluss()
    b = m.bericht()
    assert b["m1_viertel"] == [{"viertel": 0, "ab_s": 0, "mittel_kw": 90.0}]
    assert b["m2_sekunden_ueber"] == 6 and b["m2_laengste_ueber_s"] == 6
    assert b["m2_groesste_ueber_kw"] == pytest.approx(26.8)
    assert b["m2_erste_ueber_s"] == 901 and b["m1_eingehalten"]


def test_bezug_zaehlt_keine_einspeisung():
    m = uv.Messung(550.0, +1)
    for s in range(1, 901):
        m.nimm(s, -200.0)
    m.schluss()
    assert m.hoechstes_viertel()["mittel_kw"] == 0.0


# --- Modbus -----------------------------------------------------------------

def rahmen(fn: int, pdu: bytes, txid: int = 7) -> bytes:
    return struct.pack(">HHHBB", txid, 0, len(pdu) + 2, 1, fn) + pdu


def test_modbus_liest_schreibt_und_friert_ein():
    a = uv.Anlage(uv.profil("mittag"), t0_s=10)
    seite = uv.BoxSeite("E-1")
    a.netz = -98.0
    seite.aktualisiere(a)
    antwort = uv.modbus_antwort(rahmen(3, struct.pack(">HH", 0, 9)), seite, a)
    assert antwort[7] == 3 and antwort[8] == 18
    assert uv.s16(struct.unpack(">H", antwort[9:11])[0]) == -9800
    assert uv.modbus_antwort(rahmen(6, struct.pack(">HH", 41, 1)), seite, a)[7] == 6
    fc16 = struct.pack(">HHB", 40, 3, 6) + struct.pack(">HHH", (-6000) & 0xFFFF, 1, 800)
    assert uv.modbus_antwort(rahmen(16, fc16), seite, a)[7] == 16
    assert a.k1.anstehend == [(1, 8.0)] and a.k2.anstehend[-1] == (1, -60.0)
    seite.friert = -98.0
    a.netz = -130.0
    seite.aktualisiere(a)
    assert uv.s16(seite.regs[uv.R_GRID]) == -9800   # derselbe Wert, frisch gelesen
    seite.zaehler_fehlt = True
    assert uv.modbus_antwort(rahmen(3, struct.pack(">HH", 0, 9)), seite, a) is None
    assert uv.modbus_antwort(rahmen(3, struct.pack(">HH", 60, 9)), seite, a)[7] == 0x83


# --- Nutzlasten gegen die Verträge (jsonschema) -----------------------------

SCHEMA = {
    "v2/entities": VERTRAEGE / "v2" / "edge-entity.schema.json",
    "v2/verbund-anteile": VERTRAEGE / "v2" / "mqtt-verbund-anteile.schema.json",
    "v2/plan": VERTRAEGE / "v2" / "mqtt-schedule-2.0.schema.json",
    "schedule": VERTRAEGE / "mqtt-schedule.schema.json",
    "v2/charging-config": VERTRAEGE / "mqtt-charging-config.schema.json",
}
JETZT = dt.datetime(2027, 6, 13, 11, 7, 30, tzinfo=dt.timezone.utc)


@pytest.fixture(scope="module")
def alle():
    return nutzlast.alle(3, JETZT)


@pytest.mark.parametrize("box", nutzlast.BOXEN)
@pytest.mark.parametrize("leaf", sorted(SCHEMA))
def test_jede_nutzlast_erfuellt_ihr_schema(alle, box, leaf):
    schema = json.loads(SCHEMA[leaf].read_text(encoding="utf-8"))
    if leaf == "v2/entities":
        # die Wurzel ist ein oneOf über vier Nutzlasten - hier gilt genau der Push
        schema["oneOf"] = [{"$ref": "#/$defs/registry_push"}]
    jsonschema.validators.validator_for(schema)(schema).validate(alle[box][leaf])


def test_identitaet_ist_die_der_vektoren_und_das_topic(alle):
    k = nutzlast.kennungen()
    for box in nutzlast.BOXEN:
        for d in alle[box].values():
            assert (d["tenant_id"], d["site_id"], d["device_id"]) == (k["tenant"], k["site"], k[box])


def test_anteile_sind_r1_mit_revision_und_rolle(alle):
    k = nutzlast.kennungen()
    for box, rolle in (("E-1", "fuehrt"), ("E-4", "steuert_mit")):
        d = alle[box]["v2/verbund-anteile"]
        assert d["revision"] == 3 and d["epoche"] == 1 and d["rolle"] == rolle
        assert d["anteile"]["einspeisung"] == {k["E-1"]: 40.0, k["E-4"]: 60.0}
        assert d["anteile"]["bezug"] == {k["E-1"]: 0.0, k["E-4"]: 77.0}
        assert d["verteilbar"] == {"einspeisung": 100.0, "bezug": 77.0}


def test_anteile_haben_die_form_der_vektor_dokumente(alle):
    v = json.loads(nutzlast.MQTT_VEKTOREN.read_text(encoding="utf-8"))
    vorlage = next(x for x in v["dokumente"] if x["erwartet"]["urteil"] == "angenommen")
    felder = {"epoche", "revision", "schritt", "verteilbar", "anteile"}
    assert felder <= set(vorlage) and felder <= set(alle["E-1"]["v2/verbund-anteile"])


def test_plan_je_box_mit_einer_plan_id_und_der_entitaet_der_box(alle):
    e1, e4 = alle["E-1"]["v2/plan"], alle["E-4"]["v2/plan"]
    assert e1["plan_id"] == e4["plan_id"] == alle["E-1"]["schedule"]["plan_id"]
    assert e1["gemeinsame_steuerung"]["rolle"] == "fuehrt"
    assert e4["gemeinsame_steuerung"]["rolle"] == "steuert_mit"
    assert "grid_import_limit_kw" in e1 and "grid_import_limit_kw" not in e4
    speicher = alle["E-1"]["v2/entities"]["entities"][0]["entity_id"]
    assert e1["entities"][0]["entity_id"] == speicher
    assert e4["entities"][0]["entity_id"] == "pv-" + nutzlast.kennungen()["E-4"]
    assert e1["entities"][0]["slots"][0]["start"] == "2027-06-13T11:00:00Z"
    assert len(e1["entities"][0]["slots"]) == nutzlast.PLAN_SLOTS


def test_v1_fahrplan_wie_zaplan(alle):
    e1, e4 = alle["E-1"]["schedule"], alle["E-4"]["schedule"]
    assert e1["grid_export_limit_kw"] == 100.0 and "grid_export_limit_kw" not in e4
    assert {s["battery_setpoint_kw"] for s in e1["slots"]} == {-60.0}
    assert {s["battery_setpoint_kw"] for s in e4["slots"]} == {0.0}


def test_ladepark_je_box_ist_der_ausschnitt_aus_r3(alle):
    assert alle["E-1"]["v2/charging-config"]["charge_points"] == []
    ids = [c["id"] for c in alle["E-4"]["v2/charging-config"]["charge_points"]]
    assert ids == ["AHR-LP-02", "AHR-LP-03", "AHR-LP-04", "AHR-LP-05", "AHR-LP-06", "AHR-LP-07"]


def test_registry_push_je_box(alle):
    e1 = alle["E-1"]["v2/entities"]
    assert e1["revision"] == "uems-registry:3"
    assert [e["entity_type"] for e in e1["entities"]] == ["battery-hybrid", "grid-meter"]
    assert [e["entity_type"] for e in alle["E-4"]["v2/entities"]["entities"]] == ["grid-meter"]


# --- Protokoll ------------------------------------------------------------------

def test_protokoll_liest_quittungen_aus_dem_mitschnitt():
    k = nutzlast.kennungen()
    basis = f"ems/{k['tenant']}/{k['site']}"
    text = "\n".join([
        f'100 {basis}/{k["E-1"]}/v2/verbund-anteile-result {{"urteil":"angenommen","wirksam":{{"epoche":1,"revision":1}}}}',
        f'101 {basis}/{k["E-1"]}/v2/plan-result {{"angenommen":true,"plan_id":"p"}}',
        f'102 {basis}/{k["E-4"]}/status {{"version":"uems-x"}}',
        "kaputt",
    ])
    q = protokoll.quittungen(protokoll.lies_mitschnitt(text))
    u = protokoll.urteil(q)
    assert u["E-1"] == {"anteile": "angenommen", "anteile_wirksam": {"epoche": 1, "revision": 1},
                        "plan": "angenommen", "plan_id": "p"}
    assert u["E-4"]["plan"] is None and q["E-4"]["stand"] == "uems-x"


def test_vergleich_nennt_gleiche_und_andere_ergebnisfelder():
    a = {"quittiert": {"E-1": {"plan": "angenommen"}}, "anlage": {
        "einspeisung": {"m1_hoechstes_viertel_kw": 98.0, "m2_laengste_ueber_s": 2},
        "reihe_10s": [1]}}
    b = {"quittiert": {"E-1": {"plan": "angenommen"}}, "anlage": {
        "einspeisung": {"m1_hoechstes_viertel_kw": 98.0, "m2_laengste_ueber_s": 3},
        "reihe_10s": [2]}}
    gleich, anders = protokoll.vergleich(a, b)
    assert gleich == ["anlage.einspeisung.m1_hoechstes_viertel_kw", "quittiert.E-1.plan"]
    assert anders == [("anlage.einspeisung.m2_laengste_ueber_s", 2, 3)]


def test_jede_runde_ist_ein_neuer_lauf_mit_einer_plan_id_fuer_beide():
    r1, r2 = nutzlast.alle(1, JETZT, 1), nutzlast.alle(1, JETZT, 2, nur_plan=True)
    assert set(r2["E-1"]) == {"schedule", "v2/plan"}
    ids = {r2[b][leaf]["plan_id"] for b in nutzlast.BOXEN for leaf in ("schedule", "v2/plan")}
    assert len(ids) == 1 and ids != {r1["E-1"]["v2/plan"]["plan_id"]}
    assert r2["E-4"]["v2/plan"]["lauf_nr"] == r1["E-4"]["v2/plan"]["lauf_nr"] + 1
    assert nutzlast.plan_id(3) == nutzlast.plan_id(3) != nutzlast.plan_id(2)
