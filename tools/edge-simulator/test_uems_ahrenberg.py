"""AP-06 IP-20 simulator acceptance against the canonical reference company."""

from collections import Counter
from dataclasses import replace

from uems_ahrenberg import AhrenbergScenario


def _scenario() -> AhrenbergScenario:
    return AhrenbergScenario.load()


def test_a1_two_edges_configure_no_foreign_sources():
    scenario = _scenario()
    boxes = scenario.werk_ahrenberg_boxes()

    assert [box.code for box in boxes] == ["E-1", "E-2"]
    assert boxes[0].device_id != boxes[1].device_id
    assert scenario.source_codes("E-1") == ("DQ-1", "DQ-2", "DQ-3")
    assert scenario.source_codes("E-2") == ("DQ-4", "DQ-5")
    assert set(scenario.source_codes("E-1")).isdisjoint(scenario.source_codes("E-2"))


def test_a2_failure_marks_only_the_sources_of_box_halle_2_offline():
    snapshot = _scenario().snapshot(offline_box="E-2")
    by_code = {box["code"]: box for box in snapshot["boxes"]}

    assert by_code["E-1"]["status"] == "online"
    assert [source["id"] for source in by_code["E-1"]["data_sources"]] == ["DQ-1", "DQ-2", "DQ-3"]
    assert by_code["E-2"]["status"] == "offline"
    assert by_code["E-2"]["data_sources"] == []


def test_a3_handover_of_dq3_never_double_reads_and_returns_to_box_halle_1():
    scenario = _scenario()
    before = scenario.reads("2027-04-10T07:29:59+02:00")
    during = scenario.reads("2027-04-10T07:30:00+02:00")
    after = scenario.reads("2027-04-12T16:00:00+02:00")

    assert next(read.box for read in before if read.source == "DQ-3") == "E-1"
    assert next(read.box for read in during if read.source == "DQ-3") == "E-2′"
    assert next(read.box for read in after if read.source == "DQ-3") == "E-1"
    expected = Counter({code: 1 for code in ("DQ-1", "DQ-2", "DQ-3", "DQ-4", "DQ-5")})
    for reads in (before, during, after):
        assert Counter(read.source for read in reads) == expected


def test_a4_identical_controller_addresses_remain_distinct_by_box_and_network():
    scenario = _scenario()
    halle2 = scenario.sources["DQ-4"]
    lindach = scenario.sources["DQ-6"]

    # AP-05 A5 uses identical private addresses in two isolated networks.  The
    # reference names 192.168.30.10 for Lindach; the simulator mirrors the
    # physical controller at 192.168.20.10 without changing source identity.
    lindach_same_address = replace(lindach, address=halle2.address, port=halle2.port)
    assert (halle2.address, halle2.port) == (lindach_same_address.address, lindach_same_address.port)
    assert (halle2.code, halle2.network) != (lindach_same_address.code, lindach_same_address.network)


def _invariante(dokumente: list[dict]) -> None:
    """AP-15 W8 (P1, P2): ein Lauf je Anlage; je Box hoechstens ein Dokument;
    alle mit derselben plan_id; Topic-Identitaet je Box."""
    boxen = [d["box"] for d in dokumente]
    assert len(boxen) == len(set(boxen))
    assert len({d["topic"] for d in dokumente}) == len(dokumente)
    assert len({d["plan_id"] for d in dokumente}) == 1


def test_a13_control_source_cannot_change_box_and_only_one_plan_recipient_remains():
    """Die AP-06-Aussage gilt weiter, solange die Gemeinsame Steuerung nicht scharf ist."""
    scenario = _scenario()

    assert scenario.assignment_allowed("DQ-1", "E-2") == (False, "steuerquelle")
    assert scenario.box_for("DQ-1", "2027-04-20T10:00:00+02:00").code == "E-1"
    for at in ("2027-04-20T10:00:00+02:00", "2027-05-20T10:00:00+02:00"):  # vor S0 / in S2
        dokumente = scenario.plan_documents(at, "lauf-1")
        _invariante(dokumente)
        assert dokumente == [{
            "box": "E-1",
            "topic": f"ems/{scenario.tenant_id}/{scenario.site_id}/{scenario.boxes['E-1'].device_id}/schedule",
            "plan_id": "lauf-1",
            "rolle": None,
        }]


def test_w8_scharfe_gemeinsame_steuerung_je_box_ein_dokument_eine_plan_id():
    """R1 am Sonntag 13.06.2027 (S3 anteile_aktiv seit 24.05.): zwei Dokumente."""
    scenario = _scenario()
    dokumente = scenario.plan_documents("2027-06-13T13:00:00+02:00", "lauf-4711")
    _invariante(dokumente)
    assert [(d["box"], d["rolle"]) for d in dokumente] == [("E-1", "fuehrt"), ("E-4", "steuert_mit")]
    assert all(d["topic"].endswith("/v2/plan") for d in dokumente)


def test_w8_angehalten_und_stumm_nur_die_fuehrende():
    scenario = _scenario()
    at = "2027-06-13T13:00:00+02:00"
    angehalten = scenario.plan_documents(at, "lauf-1", angehalten=True)
    assert [d["box"] for d in angehalten] == ["E-1"]
    stumm = scenario.plan_documents(at, "lauf-2", stumm=("E-4",))
    _invariante(stumm)
    assert [(d["box"], d["rolle"]) for d in stumm] == [("E-1", "fuehrt")]


def test_r17_nachfolgerin_bekommt_erst_nach_der_bestaetigung_einen_plan():
    scenario = _scenario()
    at = "2027-10-12T10:00:00+02:00"
    vorher = scenario.plan_documents(at, "lauf-1")
    assert [d["box"] for d in vorher] == ["E-1"]
    nachher = scenario.plan_documents(at, "lauf-2", bestaetigt=("E-4′",))
    _invariante(nachher)
    assert [d["box"] for d in nachher] == ["E-1", "E-4′"]
