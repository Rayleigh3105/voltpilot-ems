"""AP-14 IP-18: der Dauerläufer ohne Broker — Trennung, Neustart, SIGTERM, keine Szenarien."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import uems_dauerlaeufer as dl

HIER = Path(__file__).resolve().parent
TENANT = "e1b07da2-5f48-4330-a46b-6457ab9fb020"
UMGEBUNG = {
    "VP_DAUERLAEUFER_TENANT": TENANT,
    "VP_DAUERLAEUFER_E1_SITE": "d1000000-0000-4000-8000-000000000001",
    "VP_DAUERLAEUFER_E1_DEVICE": "d1b00000-0000-4000-8000-000000000001",
    "VP_DAUERLAEUFER_E2_SITE": "d1000000-0000-4000-8000-000000000002",
    "VP_DAUERLAEUFER_E2_DEVICE": "d1b00000-0000-4000-8000-000000000002",
}


class FakeClient:
    """Wie paho mit loop_start: publish nimmt immer an, zugestellt wird erst bei Verbindung."""

    def __init__(self):
        self.verbunden = True
        self.warteschlange: list[tuple[str, bytes]] = []
        self.zugestellt: list[tuple[str, bytes]] = []
        self.gehalten: dict[str, bytes] = {}
        self.getrennt = False

    def publish(self, topic, nutzlast, qos, retain):
        # Nur die Quittung wird gehalten (retained), wie im Vertrag measurement-config-status.
        assert qos == 1 and retain is topic.endswith("/v2/measurement-config-status")
        if retain:
            self.gehalten[topic] = nutzlast
            return
        self.warteschlange.append((topic, nutzlast))
        if self.verbunden:
            self.zustellen()

    def zustellen(self):
        self.zugestellt.extend(self.warteschlange)
        self.warteschlange.clear()

    def is_connected(self):
        return self.verbunden

    def disconnect(self):
        self.getrennt = True

    def loop_stop(self):
        pass


def _laeufer(tmp_path, uhr, clients):
    konf = dl.konfiguration(UMGEBUNG | {
        "VP_DAUERLAEUFER_BROKER": "broker.invalid",
        "VP_DAUERLAEUFER_LEBENSZEICHEN": str(tmp_path / "lebt"),
    })
    return dl.Dauerlaeufer(konf, client_fabrik=lambda k, b, _bei: clients.setdefault(b.code, FakeClient()),
                           uhr=uhr, echo=lambda _t: None)


def _auswahl(tenant: str, box: dl.BoxZugang, revision: int = 1, messstellen=None) -> dict:
    """Die Zustellung, die die Plattform nach „Eigenen Messwert hinzufügen“ hält (retained)."""
    return {"schema_version": "2.0", "tenant_id": tenant, "site_id": box.site_id, "device_id": box.device_id,
            "revision": revision, "catalog_version": dl.KATALOGSTAND,
            "selections": [{"point_key": dl.beispiel_schluessel(m), "cadence_s": 60,
                            "definition": dl.eigener_messwert(m)}
                           for m in (messstellen or dl.BOX_REIHEN[box.code])]}


def _zustellen(laeufer: dl.Dauerlaeufer, revision: int = 1) -> None:
    for box in laeufer.konf.boxen:
        laeufer.empfangen(box.code, dl.auswahl_topic(laeufer.konf.tenant_id, box),
                          dl.draht(_auswahl(laeufer.konf.tenant_id, box, revision)))


def test_zwei_boxen_mit_konfigurierter_identitaet_topic_gleich_payload():
    konf = dl.konfiguration(UMGEBUNG)
    assert [b.code for b in konf.boxen] == ["E-1", "E-2"]
    for box in konf.boxen:
        nutzlast = dl.umschlag(konf.tenant_id, box, 29_000_000, dl.beispiel_gelernt(box.code))
        teile = dl.topic(konf.tenant_id, box).split("/")
        assert teile[1:4] == [nutzlast["tenant_id"], nutzlast["site_id"], nutzlast["device_id"]]
        assert teile[4:] == ["v2", "measurement-samples"]
        assert nutzlast["schema_version"] == "2.0"
        assert len(nutzlast["samples"]) == len(dl.BOX_REIHEN[box.code])
        assert {s["quality"] for s in nutzlast["samples"]} == {"good"}


def test_falsche_oder_fehlende_kennung_bricht_vor_dem_senden_ab():
    with pytest.raises(ValueError, match="VP_DAUERLAEUFER_TENANT"):
        dl.konfiguration(UMGEBUNG | {"VP_DAUERLAEUFER_TENANT": "CHANGE-ME-dauerlaeufer-tenant"})
    with pytest.raises(ValueError, match="E2_DEVICE"):
        dl.konfiguration({k: v for k, v in UMGEBUNG.items() if k != "VP_DAUERLAEUFER_E2_DEVICE"})
    with pytest.raises(ValueError, match="zwei verschiedene"):
        dl.konfiguration(UMGEBUNG | {"VP_DAUERLAEUFER_E2_DEVICE": UMGEBUNG["VP_DAUERLAEUFER_E1_DEVICE"]})


def test_broker_trennung_haelt_umschlaege_vor_und_die_schleife_laeuft_weiter(tmp_path):
    jetzt = [1_800_000_000.0]
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, lambda: jetzt[0], clients)
    _zustellen(laeufer)

    laeufer.einmal(dl.takt_von(jetzt[0]))
    for c in clients.values():
        c.verbunden = False
    for _ in range(5):  # fünf Minuten ohne Broker
        jetzt[0] += dl.TAKT_S
        laeufer.einmal(dl.takt_von(jetzt[0]))
    assert all(len(c.warteschlange) == 5 for c in clients.values())
    assert laeufer.lebenszeichen.lebt(time.time()), "getrennt ist nicht tot - die Probe bleibt grün"
    assert '"verbunden": {"E-1": false, "E-2": false}' in (tmp_path / "lebt").read_text()

    for c in clients.values():  # paho verbindet neu und stellt FIFO zu
        c.verbunden = True
        c.zustellen()
    for c in clients.values():
        sequenzen = [int(n.split(b'"sequence":')[1].split(b",")[0]) for _t, n in c.zugestellt]
        assert sequenzen == sorted(sequenzen) and len(set(sequenzen)) == 6


def test_neustart_setzt_sequenz_und_zaehler_fort_ohne_reset(tmp_path):
    jetzt = [1_800_000_000.0]
    vorher: dict[str, FakeClient] = {}
    erster = _laeufer(tmp_path, lambda: jetzt[0], vorher)
    _zustellen(erster)
    erster.einmal(dl.takt_von(jetzt[0]))
    jetzt[0] += 7 * dl.TAKT_S  # Pod neu gestartet, sieben Minuten später
    nachher: dict[str, FakeClient] = {}
    zweiter = _laeufer(tmp_path, lambda: jetzt[0], nachher)
    assert zweiter.einmal(dl.takt_von(jetzt[0])) == 0, "ohne Gedächtnis: erst die Zustellung, dann Werte"
    _zustellen(zweiter)  # der Broker stellt die gehaltene Auswahl nach dem Neuabonnieren erneut zu
    zweiter.einmal(dl.takt_von(jetzt[0]))

    for code in ("E-1", "E-2"):
        alt = json.loads(vorher[code].zugestellt[-1][1])
        neu = json.loads(nachher[code].zugestellt[0][1])
        assert neu["sequence"] == alt["sequence"] + 7
        for a, n in zip(alt["samples"], neu["samples"]):
            assert n["point_key"] == a["point_key"] and n["raw"] > a["raw"]


def test_sigterm_beendet_die_schleife_und_trennt_beide_boxen(tmp_path):
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, time.time, clients)
    _zustellen(laeufer)
    faden = threading.Thread(target=laeufer.laufen)
    faden.start()
    time.sleep(0.3)
    laeufer.anhalten(signal.SIGTERM, None)
    faden.join(timeout=5)
    assert not faden.is_alive()
    assert all(c.getrennt for c in clients.values())
    assert laeufer.gesendet == 2


def test_sigterm_am_echten_prozess_endet_mit_null(tmp_path):
    umgebung = os.environ | UMGEBUNG | {"VP_DAUERLAEUFER_LEBENSZEICHEN": str(tmp_path / "lebt"),
                                        "PYTHONPATH": str(HIER)}
    umgebung.pop("VP_DAUERLAEUFER_BROKER", None)
    prozess = subprocess.Popen([sys.executable, str(HIER / "uems_dauerlaeufer.py")], env=umgebung,
                               stderr=subprocess.PIPE, text=True)
    frist = time.time() + 10
    while not (tmp_path / "lebt").exists() and time.time() < frist:
        time.sleep(0.05)
    probe = subprocess.run([sys.executable, str(HIER / "uems_dauerlaeufer.py"), "--probe"], env=umgebung)
    assert probe.returncode == 0
    prozess.send_signal(signal.SIGTERM)
    assert prozess.wait(timeout=10) == 0
    assert "Dauerläufer beendet" in prozess.stderr.read()


def test_probe_meldet_tot_ohne_oder_mit_altem_lebenszeichen(tmp_path):
    zeichen = dl.Lebenszeichen(str(tmp_path / "lebt"))
    assert not zeichen.lebt(time.time())
    zeichen.setzen({"takt": 1})
    assert zeichen.lebt(time.time())
    assert not zeichen.lebt(time.time() + dl.PROBE_GRENZE_S + 1)


def test_keine_stoerungs_szenarien_im_dauerbetrieb():
    """Der Dauerläufer kennt nur den Normalbetrieb: kein Szenario, kein Nachliefern, keine Uhr-Verschiebung."""
    baum = ast.parse((HIER / "uems_dauerlaeufer.py").read_text(encoding="utf-8"))
    importiert = {a.name for n in ast.walk(baum) if isinstance(n, ast.ImportFrom) for a in n.names}
    assert importiert.isdisjoint({"szenarien", "Streckenszenarien", "spiele", "Szenario"})
    konf = dl.konfiguration(UMGEBUNG)
    for box in konf.boxen:
        takte = [dl.umschlag(konf.tenant_id, box, 29_000_000 + i, dl.beispiel_gelernt(box.code))
                 for i in range(60)]
        assert [t["sequence"] for t in takte] == list(range(29_000_000, 29_000_060))
        for t in takte:  # Messzeit = Takt, alle Werte gut, nichts nachgeliefert
            assert all(s["observed_at"] == t["observed_at"] for s in t["samples"])
            assert "delivery" not in t and "events" not in t


def test_datenmenge_wenige_megabyte_je_tag():
    menge = dl.bytes_je_tag(TENANT, dl.konfiguration(UMGEBUNG).boxen)
    assert menge["umschlaege"] == 2 * 1440
    assert menge["samples"] == 9 * 1440
    assert 1_000_000 < menge["nutzlast_bytes"] < 5_000_000


def test_umschlag_erfuellt_den_vertrag_measurement_samples():
    jsonschema = pytest.importorskip("jsonschema", reason="Vertragspruefung braucht jsonschema")
    from uems_szenarien import VERTRAEGE

    schema = json.loads((VERTRAEGE / "mqtt-measurement-samples.schema.json").read_text())
    pruefer = jsonschema.validators.validator_for(schema)(schema)
    konf = dl.konfiguration(UMGEBUNG)
    for box in konf.boxen:
        pruefer.validate(dl.umschlag(konf.tenant_id, box, dl.takt_von(time.time()), dl.beispiel_gelernt(box.code)))


def _flach_laden(verzeichnis: Path, monkeypatch):
    """Lädt die drei Module so, als lägen sie unter ``verzeichnis`` (wie im Image), ohne dorthin zu schreiben."""
    import types

    for name in ("uems_ahrenberg", "uems_szenarien", "uems_dauerlaeufer"):
        modul = types.ModuleType(name)
        modul.__file__ = str(verzeichnis / f"{name}.py")
        monkeypatch.setitem(sys.modules, name, modul)
        exec(compile((HIER / f"{name}.py").read_text(encoding="utf-8"), modul.__file__, "exec"), modul.__dict__)
    return sys.modules["uems_dauerlaeufer"]


def _workdir_des_images() -> Path:
    zeilen = (HIER / "Dockerfile.dauerlaeufer").read_text(encoding="utf-8").splitlines()
    return Path(next(z.split()[1] for z in zeilen if z.startswith("WORKDIR ")))


def test_image_layout_laedt_und_rechnet_die_menge(monkeypatch, capsys):
    """Befund firstmate zu PR 996: unter /app/*.py scheiterte der Import an parents[2]."""
    with pytest.raises(IndexError):
        _flach_laden(Path("/app"), monkeypatch)  # die alte Lage: eine Ebene unter der Wurzel

    modul = _flach_laden(_workdir_des_images(), monkeypatch)
    for schluessel, wert in UMGEBUNG.items():
        monkeypatch.setenv(schluessel, wert)
    assert modul.main(["--menge"]) == 0
    assert '"nutzlast_bytes": 2694240' in capsys.readouterr().out


NW6_VORLAGE = HIER / "abnahme" / "dauerlaeufer-nw6.json"


def test_nw6_vorlage_ist_die_des_simulators():
    """Der Java-Lauf ``DauerlaeuferGanzerWegDbTest`` startet kein Python; er liest diese Datei."""
    assert NW6_VORLAGE.read_text(encoding="utf-8") == dl.nw6_text(), (
        "Vorlage und Dauerläufer laufen auseinander — `make abnahme` und den Java-Lauf erneut fahren")
    summe = NW6_VORLAGE.with_suffix(NW6_VORLAGE.suffix + ".sha256").read_text(encoding="utf-8").strip()
    assert summe == dl.nw6_dateisumme() == hashlib.sha256(NW6_VORLAGE.read_bytes()).hexdigest()


def test_nw6_vorlage_traegt_beide_boxen_mit_topic_gleich_nutzlast():
    vorlage = dl.nw6_vorlage()
    assert [z["box"] for z in vorlage["zustellungen"]] == ["E-1", "E-2"] * dl.NW6_TAKTE
    for z in vorlage["zustellungen"]:
        n = z["nutzlast"]
        assert z["topic"] == f"ems/{n['tenant_id']}/{n['site_id']}/{n['device_id']}/v2/measurement-samples"
    letzte = vorlage["zustellungen"][-1]["nutzlast"]["observed_at"]
    assert letzte == "2026-11-03T09:59:00Z"


# ---------------------------------------------------------------- IP-18-Einrichtung: der Lernweg (a+)

def test_ohne_zustellung_sendet_die_box_nichts(tmp_path):
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, time.time, clients)
    assert laeufer.einmal(dl.takt_von(time.time())) == 0
    assert all(not c.warteschlange and not c.zugestellt for c in clients.values())
    assert '"gelernt": {"E-1": 0, "E-2": 0}' in (tmp_path / "lebt").read_text(), "lebt trotzdem"


def test_lernt_die_zugestellten_schluessel_quittiert_und_sendet_genau_diese(tmp_path):
    jetzt = [1_800_000_000.0]
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, lambda: jetzt[0], clients)
    konf = laeufer.konf
    e1 = konf.boxen[0]
    # Die Plattform vergibt die Schlüssel; hier zwei, die der Simulator nie gesehen hat.
    auswahl = _auswahl(konf.tenant_id, e1, revision=7, messstellen=["MS-05", "MS-07"])
    auswahl["selections"][0]["point_key"] = "custom.0123456789abcdef0123456789abcdef"
    auswahl["selections"][1]["point_key"] = "custom.fedcba9876543210fedcba9876543210"
    laeufer.empfangen("E-1", dl.auswahl_topic(konf.tenant_id, e1), dl.draht(auswahl))

    quittung = json.loads(clients["E-1"].gehalten[dl.quittung_topic(konf.tenant_id, e1)])
    assert quittung["revision"] == 7 and quittung["rejected"] == []
    assert quittung["accepted"] == ["custom.0123456789abcdef0123456789abcdef",
                                    "custom.fedcba9876543210fedcba9876543210"]
    assert quittung["applied_at"] == "2027-01-15T08:00:00Z" and quittung["edge_version"] == dl.EDGE_VERSION

    assert laeufer.einmal(dl.takt_von(jetzt[0])) == 1, "E-2 hat noch keine Auswahl"
    nutzlast = json.loads(clients["E-1"].zugestellt[-1][1])
    assert [(s["point_key"], s["raw"]) for s in nutzlast["samples"]] == [
        ("custom.0123456789abcdef0123456789abcdef", dl.zaehlerstand("MS-05", dl.takt_von(jetzt[0]))),
        ("custom.fedcba9876543210fedcba9876543210", dl.zaehlerstand("MS-07", dl.takt_von(jetzt[0])))]
    assert nutzlast["samples"][0]["decoded"] == round(nutzlast["samples"][0]["raw"] * 0.1, 3)


def test_fremde_alte_oder_unpassende_zustellung(tmp_path):
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, time.time, clients)
    konf = laeufer.konf
    e1, e2 = konf.boxen
    thema = dl.auswahl_topic(konf.tenant_id, e1)
    laeufer.empfangen("E-1", thema, dl.draht(_auswahl(konf.tenant_id, e1, revision=3)))
    assert len(laeufer.gedaechtnis["E-1"].gelernt) == 4
    clients["E-1"].gehalten.clear()

    # gleiche oder ältere Revision: ignoriert, keine zweite Quittung
    laeufer.empfangen("E-1", thema, dl.draht(_auswahl(konf.tenant_id, e1, revision=3, messstellen=["MS-05"])))
    assert not clients["E-1"].gehalten and len(laeufer.gedaechtnis["E-1"].gelernt) == 4
    # fremde Identität (E-2s Auswahl auf E-1s Thema): ignoriert
    laeufer.empfangen("E-1", thema, dl.draht(_auswahl(konf.tenant_id, e2, revision=9)))
    assert not clients["E-1"].gehalten
    laeufer.empfangen("E-1", thema, b"{kaputt")
    assert not clients["E-1"].gehalten

    # ein Register der anderen Halle, ein Katalog-Punkt und ein falscher Typ: benannt abgelehnt
    auswahl = _auswahl(konf.tenant_id, e1, revision=4, messstellen=["MS-05", "MS-10", "MS-06"])
    auswahl["selections"][2]["definition"] = dl.eigener_messwert("MS-06") | {"valueType": "float32"}
    auswahl["selections"].append({"point_key": "sunspec.m1.sn", "cadence_s": 60})
    laeufer.empfangen("E-1", thema, dl.draht(auswahl))
    quittung = json.loads(clients["E-1"].gehalten[dl.quittung_topic(konf.tenant_id, e1)])
    assert quittung["accepted"] == [dl.beispiel_schluessel("MS-05")]
    assert [r["point_key"] for r in quittung["rejected"]] == [
        dl.beispiel_schluessel("MS-10"), dl.beispiel_schluessel("MS-06"), "sunspec.m1.sn"]
    assert {r["reason"] for r in quittung["rejected"]} == {"unknown_point"}
    assert set(laeufer.gedaechtnis["E-1"].gelernt) == {"MS-05"}

    # die Plattform löscht den Plan (leere gehaltene Nachricht): die Box vergisst ihn
    laeufer.empfangen("E-1", thema, b"")
    assert laeufer.gedaechtnis["E-1"].gelernt == {} and laeufer.gedaechtnis["E-1"].revision is None


def test_baukasten_lesung_liefert_den_zaehlerstand_und_benennt_fehler(tmp_path):
    jetzt = [1_800_000_000.0]
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, lambda: jetzt[0], clients)
    konf = laeufer.konf
    e2 = konf.boxen[1]
    anfrage = dl.nw6_lesung(dl.NW6_BOXEN[1]) | {"tenant_id": konf.tenant_id, "site_id": e2.site_id,
                                                "device_id": e2.device_id}
    lesen = anfrage["ops"][0]
    anfrage["ops"] = [lesen,
                      lesen | {"id": "fremd", "host": "10.99.1.10"},
                      lesen | {"id": "leer", "address": 501},
                      {"op": "test_connection", "id": "katalog", "brand": "deye", "connection": {}}]
    laeufer.empfangen("E-2", dl.probe_topic(konf.tenant_id, e2), dl.draht(anfrage))
    thema, antwort = clients["E-2"].zugestellt[-1]
    assert thema == dl.probe_antwort_topic(konf.tenant_id, e2)
    antwort = json.loads(antwort)
    assert antwort["request_id"] == anfrage["request_id"]
    gut, fremd, leer, katalog = antwort["results"]
    roh = dl.zaehlerstand("MS-10", dl.takt_von(jetzt[0]))
    assert gut == {"id": "probe", "ok": True, "raw": roh, "registers": [roh >> 16, roh & 0xFFFF],
                   "value": round(roh * 0.1, 6)}
    assert (fremd["error_code"], leer["error_code"], katalog["error_code"]) == (
        "unreachable", "no_answer", "not_supported")
    assert not any("value" in r for r in (fremd, leer, katalog))


def test_lesung_zustellung_und_quittung_erfuellen_ihre_vertraege():
    jsonschema = pytest.importorskip("jsonschema", reason="Vertragspruefung braucht jsonschema")
    from uems_szenarien import VERTRAEGE

    def pruefer(pfad: Path):
        schema = json.loads(pfad.read_text(encoding="utf-8"))
        return jsonschema.validators.validator_for(schema)(schema, format_checker=jsonschema.FormatChecker())

    probe = pruefer(VERTRAEGE.parent / "mqtt-probe.schema.json")
    auswahl = pruefer(VERTRAEGE / "mqtt-measurement-config.schema.json")
    quittung = pruefer(VERTRAEGE / "mqtt-measurement-config-status.schema.json")
    for e in dl.nw6_vorlage()["einrichtung"]:
        probe.validate(e["lesung"]["anfrage"])
        probe.validate(e["lesung"]["antwort"])
        auswahl.validate(e["auswahl"]["nutzlast"])
        quittung.validate(e["quittung"]["nutzlast"])
        assert e["quittung"]["nutzlast"]["rejected"] == [], "die Vorlage nimmt jede Messstelle an"


def test_nw6_vorlage_sendet_nur_zugestellte_schluessel():
    vorlage = dl.nw6_vorlage()
    zugestellt = {e["box"]: {s["point_key"] for s in e["auswahl"]["nutzlast"]["selections"]}
                  for e in vorlage["einrichtung"]}
    for z in vorlage["zustellungen"]:
        assert {s["point_key"] for s in z["nutzlast"]["samples"]} == zugestellt[z["box"]]
    assert all(k.startswith("custom.") and len(k) == 39 for ks in zugestellt.values() for k in ks)
