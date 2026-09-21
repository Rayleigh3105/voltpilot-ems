"""AP-14 IP-18: der Dauerläufer ohne Broker — Trennung, Neustart, SIGTERM, keine Szenarien."""

from __future__ import annotations

import ast
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
        self.getrennt = False

    def publish(self, topic, nutzlast, qos, retain):
        assert qos == 1 and retain is False
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
    return dl.Dauerlaeufer(konf, client_fabrik=lambda k, b: clients.setdefault(b.code, FakeClient()),
                           uhr=uhr, echo=lambda _t: None)


def test_zwei_boxen_mit_konfigurierter_identitaet_topic_gleich_payload():
    konf = dl.konfiguration(UMGEBUNG)
    assert [b.code for b in konf.boxen] == ["E-1", "E-2"]
    for box in konf.boxen:
        nutzlast = dl.umschlag(konf.tenant_id, box, 29_000_000)
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
    _laeufer(tmp_path, lambda: jetzt[0], vorher).einmal(dl.takt_von(jetzt[0]))
    jetzt[0] += 7 * dl.TAKT_S  # Pod neu gestartet, sieben Minuten später
    nachher: dict[str, FakeClient] = {}
    _laeufer(tmp_path, lambda: jetzt[0], nachher).einmal(dl.takt_von(jetzt[0]))

    import json
    for code in ("E-1", "E-2"):
        alt = json.loads(vorher[code].zugestellt[-1][1])
        neu = json.loads(nachher[code].zugestellt[0][1])
        assert neu["sequence"] == alt["sequence"] + 7
        for a, n in zip(alt["samples"], neu["samples"]):
            assert n["point_key"] == a["point_key"] and n["raw"] > a["raw"]


def test_sigterm_beendet_die_schleife_und_trennt_beide_boxen(tmp_path):
    clients: dict[str, FakeClient] = {}
    laeufer = _laeufer(tmp_path, time.time, clients)
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
        takte = [dl.umschlag(konf.tenant_id, box, 29_000_000 + i) for i in range(60)]
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
    import json

    jsonschema = pytest.importorskip("jsonschema", reason="Vertragspruefung braucht jsonschema")
    from uems_szenarien import VERTRAEGE

    schema = json.loads((VERTRAEGE / "mqtt-measurement-samples.schema.json").read_text())
    pruefer = jsonschema.validators.validator_for(schema)(schema)
    konf = dl.konfiguration(UMGEBUNG)
    for box in konf.boxen:
        pruefer.validate(dl.umschlag(konf.tenant_id, box, dl.takt_von(time.time())))


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
    assert '"nutzlast_bytes": 2577600' in capsys.readouterr().out
