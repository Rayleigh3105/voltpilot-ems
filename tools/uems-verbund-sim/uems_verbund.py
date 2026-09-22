#!/usr/bin/env python3
"""AP-15 IP-28 (NW-3, E6 = A): das Anlagenmodell des Simulator-Aufbaus.

EIN Netzpunkt, zwei Abgänge - Anlage AN-1 am Netzanschluss NA-1 des
Referenzunternehmens (Fassung 1.5, `docs/contracts/v2/uems-referenzunternehmen.json`):

    NA-1 (Grenze 100 kW Einspeisung, 550 kW Bezug) - gemessen von Box Halle 1 (E-1, DQ-2)
    ├── Abgang Halle 1:     ungeregelte Last, K-1 PV 100 kW, K-2 Speicher 100 kW
    └── Abgang Verwaltung:  K-12 PV 60 kW, K-13.1 … K-13.6 Ladepunkte je 22 kW
                            gemessen von Box Verwaltung (E-4, DQ-10)

Dieselbe Physik wie `edge-app/core/internal/agent/zwei_agenten_modell_test.go`
(IP-27, NW-2) - nur dass hier ECHTE Box-Container dagegen regeln. Der Prozess
steht an der Stelle des SunSpec-Simulators `edge/sim` (Dienst `edge-sim`): er
bedient dessen kompakte Registerkarte über Modbus TCP an Port 502, und zwar für
BEIDE Boxen. Welche Box fragt, erkennt er an der eigenen Adresse, an der die
Verbindung ankommt - er hängt in beiden Box-Netzen, in jedem unter dem Alias
`edge-sim` und zusätzlich `anlage-e1` bzw. `anlage-e4`.

  gelesen (FC3, Register 0..8): grid_power ist der Netzzähler an E-1 und der
      Abgangszähler an E-4 · pv_power · load_power · battery_power · soc ·
      wmax_lim_pct · grid_conn_nameplate
  geschrieben (FC6/FC16, Register 40/41/42): Speicher-Sollwert, Freigabe,
      PV-Grenze - genau was der Node-RED-Tab „SunSpec (Simulator)" der Box
      schreibt; jeder Schreibbefehl wirkt nach 1 s Stellzeit am Gerät.

Takt: 1 Simulator-Sekunde = 1 echte Sekunde. Kein Zeitraffer, weil die Box
ausschließlich mit echten Sekunden rechnet - Frische 30 s, Geräte-Rückfall
60 s, Einfrierprobe 30 + 20 s, der Node-RED-Lesetakt 2 s. Ein gestauchter
Simulator würde die Physik gegen diese Uhren verschieben und M-2 verfälschen.

Gemessen am Netzpunkt, jede Sekunde ab Messbeginn (§4.12 des Konzepts):
  M-1 das Mittel je voller Viertelstunde (900 Simulator-Sekunden ab Messbeginn)
  M-2 Sekunden über der Grenze, längste Strecke, größte Überschreitung

Aufrufe:
  uems_verbund.py anlage [--profil mittag|nacht|nacht_a20] [--anlauf 300] [--dauer 2700]
                         [--t0 600] [--nullpunkt 400] [--ladepunkte host:port,…]
  uems_verbund.py steuer '<json>'      (start, stand, stoerung, rueckfall, protokoll)

Die Uhr des Laufs beginnt mit {"cmd":"start"} - verbund.sh schickt es, sobald
beide Boxen Anteils- und Plan-Dokument quittiert haben. Bis dahin stehen alle
Register auf ihrem Anfangswert.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import socket
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

EINSPEISEGRENZE_KW = 100.0
BEZUGSGRENZE_KW = 550.0
EPS = 1e-6

SCHREIB_TAKT_S = 10  # zwei_agenten_modell_test.go zaSchreibTakt: der Watchdog-Boden
STELLZEIT_S = 1      # zaStellzeit: Modbus-Schreiben, bis das Gerät es übernimmt

# Rampen aus zwei_agenten_modell_test.go neueAnlage - die Referenzdatei nennt
# Nennleistung und Rückfall, aber keine Rampe.
RAMPE_KW_S = {"K-1": 10.0, "K-2": 25.0, "K-12": 6.0, "K-13": 5.5}

STEUER_PORT = 7000
MODBUS_PORT = 502

# Registerkarte von edge/sim/sunspec-sim.js und nodered/modbus-tcp.js (Profil sunspec)
R_GRID, R_PV, R_LOAD, R_BATT, R_SOC, R_WMAXLIM, R_GRIDCONN = 0, 1, 2, 3, 4, 5, 6
R_SETPOINT, R_ENABLE, R_PVLIMIT = 40, 41, 42
KEIN_PV_LIMIT = 0xFFFF
N_REGISTER = 64


def referenz_pfad() -> Path:
    """Die Referenzdatei: im Bild neben dem Modul, im Repo unter docs/."""
    if os.environ.get("VB_REFERENZ"):
        return Path(os.environ["VB_REFERENZ"])
    hier = Path(__file__).resolve().parent
    neben = hier / "uems-referenzunternehmen.json"
    if neben.exists():
        return neben
    # Nur im Repo gibt es zwei Eltern über tools/uems-verbund-sim/ (Lehre PR 996:
    # unter /app/ gäbe es sie nicht, darum erst nach dem Blick daneben).
    return hier.parents[1] / "docs" / "contracts" / "v2" / "uems-referenzunternehmen.json"


def lade_rueckfaelle(pfad: Path | None = None) -> dict[str, dict]:
    """geraete_rueckfaelle der Referenzdatei, je Komponente."""
    d = json.loads((pfad or referenz_pfad()).read_text(encoding="utf-8"))
    return {r["komponente"]: r for r in d["geraete_rueckfaelle"]}


def lade_grenzen(pfad: Path | None = None) -> tuple[float, float]:
    d = json.loads((pfad or referenz_pfad()).read_text(encoding="utf-8"))
    g = next(x for x in d["netzanschluss_grenzen"] if x["netzanschluss"] == "NA-1")
    return float(g["einspeisegrenze_kw"]), float(g["bezugsgrenze_kw"])


# --- Geräte -----------------------------------------------------------------

@dataclass
class Geraet:
    """Ein steuerbares Gerät: folgt seinem letzten Befehl mit Rampe und fällt
    zurück, wenn Befehle ausbleiben (zaGeraet)."""

    name: str
    nenn_kw: float
    rampe_kw_s: float
    frei: bool = False          # kein Rückfallwert: läuft frei mit Nennleistung
    rueckfall_kw: float = 0.0
    nach_s: int = 0
    soll: float = 0.0
    hat_soll: bool = False
    befehl_am: float = -1e9
    wirkt: float = 0.0
    anstehend: list = field(default_factory=list)

    @classmethod
    def aus_referenz(cls, r: dict, rampe: float) -> "Geraet":
        return cls(name=r["komponente"], nenn_kw=float(r["nenn_kw"]), rampe_kw_s=rampe,
                   frei=r["rueckfall"] == "laeuft_frei", rueckfall_kw=float(r["rueckfall_kw"]),
                   nach_s=int(r["nach_s"]))

    def befehl(self, jetzt: float, kw: float) -> None:
        self.anstehend.append((jetzt + STELLZEIT_S, kw))

    def ziel(self, jetzt: float) -> tuple[float, bool]:
        while self.anstehend and self.anstehend[0][0] <= jetzt:
            ab, kw = self.anstehend.pop(0)
            self.soll, self.hat_soll, self.befehl_am = kw, True, ab
        wachhund = max(self.nach_s, SCHREIB_TAKT_S + STELLZEIT_S)
        if not self.hat_soll or jetzt - self.befehl_am > wachhund:
            return (self.nenn_kw if self.frei else self.rueckfall_kw), True
        return self.soll, False

    def schritt(self, jetzt: float, dt: float = 1.0) -> None:
        z, _ = self.ziel(jetzt)
        d = z - self.wirkt
        grenze = self.rampe_kw_s * dt
        if abs(d) > grenze:
            d = math.copysign(grenze, d)
        self.wirkt += d


# --- Profile (M-3: der ungünstigste Betriebspunkt je Richtung) --------------

@dataclass
class Profil:
    name: str
    richtung: str
    grundlast: callable
    sonne_k1: callable
    sonne_k12: callable
    autos: callable
    e1_speicher_kw: float  # was der Plan der führenden Box vom Speicher will


def profil(name: str) -> Profil:
    """t = Sekunden seit dem Störungszeitpunkt T0 (wie im Zwei-Agenten-Test)."""
    if name == "mittag":
        # zaMittag: volle Sonne an Halle 1, keine Last (R1: „bei JEDER Last ≥ 0"),
        # der Speicher entlädt 60 kW für den Markt (V6), kein Auto - und die
        # Wolkenlücke über der Verwaltung 5 s nach T0: K-12 von 30 auf 60 kW.
        return Profil("mittag", "Einspeisung", lambda t: 0.0, lambda t: 100.0,
                      lambda t: 60.0 if t >= 5 else 30.0, lambda t: 0.0, -60.0)
    if name == "nacht":
        # zaNacht: ungeregelte Last genau am Vorbehalt 473 kW, sechs Autos zu
        # je 22 kW, der Plan lädt den Speicher 100 kW aus dem Netz.
        return Profil("nacht", "Bezug", lambda t: 473.0, lambda t: 0.0, lambda t: 0.0,
                      lambda t: 22.0, 100.0)
    raise ValueError(f"unbekanntes Profil {name!r} (mittag, nacht)")


# --- Messung M-1/M-2 --------------------------------------------------------

@dataclass
class Messung:
    grenze_kw: float
    richtung: int  # +1 Bezug, -1 Einspeisung
    sekunden_ueber: int = 0
    laengste_ueber: int = 0
    lauf: int = 0
    groesste_ueber_kw: float = 0.0
    erste_ueber_s: int | None = None
    viertel: list = field(default_factory=list)
    summe: float = 0.0
    n: int = 0
    viertel_nr: int = 0

    def nimm(self, sekunde: int, netz_kw: float) -> None:
        """sekunde = 1, 2, … ab Messbeginn; die Probe gehört zum Viertel von sekunde-1."""
        wert = max(self.richtung * netz_kw, 0.0)
        ueber = wert - self.grenze_kw
        if ueber > EPS:
            if self.sekunden_ueber == 0:
                self.erste_ueber_s = sekunde
            self.sekunden_ueber += 1
            self.lauf += 1
            self.laengste_ueber = max(self.laengste_ueber, self.lauf)
            self.groesste_ueber_kw = max(self.groesste_ueber_kw, ueber)
        else:
            self.lauf = 0
        q = (sekunde - 1) // 900
        if q != self.viertel_nr:
            self._schliesse()
            self.viertel_nr, self.summe, self.n = q, 0.0, 0
        self.summe += wert
        self.n += 1

    def _schliesse(self) -> None:
        if self.n == 900:
            self.viertel.append({"viertel": self.viertel_nr, "ab_s": self.viertel_nr * 900,
                                 "mittel_kw": round(self.summe / 900, 3)})

    def schluss(self) -> None:
        self._schliesse()
        self.n = 0

    def hoechstes_viertel(self) -> dict | None:
        return max(self.viertel, key=lambda v: v["mittel_kw"]) if self.viertel else None

    def bericht(self) -> dict:
        h = self.hoechstes_viertel()
        return {
            "grenze_kw": self.grenze_kw,
            "m1_hoechstes_viertel_kw": h["mittel_kw"] if h else None,
            "m1_eingehalten": (h is None) or h["mittel_kw"] <= self.grenze_kw + EPS,
            "m1_viertel": self.viertel,
            "m2_sekunden_ueber": self.sekunden_ueber,
            "m2_laengste_ueber_s": self.laengste_ueber,
            "m2_groesste_ueber_kw": round(self.groesste_ueber_kw, 3),
            "m2_erste_ueber_s": self.erste_ueber_s,
        }


# --- Die Anlage -------------------------------------------------------------

class Anlage:
    """Der Anlagenzustand; `schritt()` rückt eine Simulator-Sekunde vor."""

    def __init__(self, p: Profil, t0_s: int, rueckfaelle: dict[str, dict] | None = None):
        rf = rueckfaelle or lade_rueckfaelle()
        self.p = p
        self.t0_s = t0_s
        self.s = 0  # Simulator-Sekunde seit Start des Laufs
        self.k1 = Geraet.aus_referenz(rf["K-1"], RAMPE_KW_S["K-1"])
        self.k2 = Geraet.aus_referenz(rf["K-2"], RAMPE_KW_S["K-2"])
        self.k12 = Geraet.aus_referenz(rf["K-12"], RAMPE_KW_S["K-12"])
        self.k13 = [Geraet.aus_referenz(rf[f"K-13.{i}"], RAMPE_KW_S["K-13"]) for i in range(1, 7)]
        self.pv_k1 = self.pv_k12 = self.batt_k2 = self.laden_k13 = 0.0
        self.netz = self.abgang_e4 = 0.0
        self.soc_pct = 50.0  # fest wie im Zwei-Agenten-Test (msg["soc_pct"] = 50)

    def alle(self) -> list[Geraet]:
        return [self.k1, self.k12, self.k2, *self.k13]

    def schritt(self) -> None:
        self.s += 1
        t = self.s - self.t0_s
        for g in self.alle():
            g.schritt(self.s)
        self.pv_k1 = min(max(self.k1.wirkt, 0.0), self.p.sonne_k1(t))
        self.pv_k12 = min(max(self.k12.wirkt, 0.0), self.p.sonne_k12(t))
        self.batt_k2 = self.k2.wirkt
        self.laden_k13 = sum(min(max(g.wirkt, 0.0), self.p.autos(t)) for g in self.k13)
        self.abgang_e4 = self.laden_k13 - self.pv_k12
        self.netz = self.p.grundlast(t) + self.batt_k2 - self.pv_k1 + self.abgang_e4

    def schreibe(self, box: str, adresse: int, wert: int, regs: list[int]) -> None:
        """Ein Schreibbefehl der Box am Register: wird Gerätebefehl, wenn die
        Box die Steuerung freigegeben hat (Register 41 = 1)."""
        regs[adresse] = wert & 0xFFFF
        if regs[R_ENABLE] != 1:
            return
        if adresse == R_PVLIMIT:
            kw = math.inf if wert == KEIN_PV_LIMIT else wert / 100.0
            g = self.k1 if box == "E-1" else self.k12
            g.befehl(self.s, min(kw, g.nenn_kw))
        elif adresse == R_SETPOINT and box == "E-1":
            self.k2.befehl(self.s, s16(wert) / 100.0)


def s16(v: int) -> int:
    v &= 0xFFFF
    return v - 0x10000 if v > 0x7FFF else v


def kodiere_s16(kw: float) -> int:
    """int16 × 0,01 kW. Außerhalb von ±327,67 kW trägt die Karte den Wert nicht."""
    raw = round(kw * 100)
    if not -0x8000 <= raw <= 0x7FFF:
        raise OverflowError(f"{kw:.2f} kW passt nicht in int16 × 0,01 kW (±327,67 kW)")
    return raw & 0xFFFF


# --- Die Box-Seite: Register je Box ----------------------------------------

@dataclass
class BoxSeite:
    box: str
    regs: list = field(default_factory=lambda: [0] * N_REGISTER)
    friert: float | None = None      # A7: derselbe Zählerwert mit frischem Zeitstempel
    zaehler_fehlt: bool = False       # A7: der Zähler antwortet nicht
    stumm: bool = False               # keine Antwort auf Modbus (Box-LAN weg, A15)
    lesen: int = 0
    schreiben: int = 0
    letzter_schreib_s: int | None = None
    ueberlauf: int = 0

    def __post_init__(self):
        self.regs[R_PVLIMIT] = KEIN_PV_LIMIT
        self.regs[R_WMAXLIM] = 10000        # 100,00 %: der §14a-Rahmen engt nichts ein
        self.regs[R_GRIDCONN] = int(BEZUGSGRENZE_KW * 100)

    def aktualisiere(self, a: Anlage) -> None:
        if self.box == "E-1":
            zaehler, pv, last, batt = a.netz, a.pv_k1, a.p.grundlast(a.s - a.t0_s), a.batt_k2
        else:
            zaehler, pv, last, batt = a.abgang_e4, a.pv_k12, a.laden_k13, 0.0
        if self.friert is not None:
            zaehler = self.friert
        try:
            self.regs[R_GRID] = kodiere_s16(zaehler)
            self.regs[R_PV] = kodiere_s16(pv)
            self.regs[R_LOAD] = kodiere_s16(last)
            self.regs[R_BATT] = kodiere_s16(batt)
        except OverflowError:
            self.ueberlauf += 1
        self.regs[R_SOC] = int(round(a.soc_pct * 10))


# --- Modbus TCP (FC3, FC6, FC16) ---------------------------------------------

def modbus_antwort(anfrage: bytes, seite: BoxSeite, anlage: Anlage) -> bytes | None:
    """Beantwortet einen vollständigen MBAP-Rahmen; None = keine Antwort (Zeitüberschreitung)."""
    txid, _proto, _laenge, unit, fn = struct.unpack(">HHHBB", anfrage[:8])
    pdu = anfrage[8:]

    def rahmen(nutz: bytes) -> bytes:
        return struct.pack(">HHHB", txid, 0, len(nutz) + 1, unit) + nutz

    if seite.stumm:
        return None
    if fn == 0x03:
        adr, anz = struct.unpack(">HH", pdu[:4])
        if adr + anz > N_REGISTER or anz == 0:
            return rahmen(bytes([fn | 0x80, 0x02]))
        if seite.zaehler_fehlt and adr <= R_GRID < adr + anz:
            return None
        seite.lesen += 1
        daten = b"".join(struct.pack(">H", seite.regs[i]) for i in range(adr, adr + anz))
        return rahmen(bytes([fn, len(daten)]) + daten)
    if fn == 0x06:
        adr, wert = struct.unpack(">HH", pdu[:4])
        if adr >= N_REGISTER:
            return rahmen(bytes([fn | 0x80, 0x02]))
        anlage.schreibe(seite.box, adr, wert, seite.regs)
        seite.schreiben += 1
        seite.letzter_schreib_s = anlage.s
        return rahmen(bytes([fn]) + pdu[:4])
    if fn == 0x10:
        adr, anz, _bc = struct.unpack(">HHB", pdu[:5])
        if adr + anz > N_REGISTER:
            return rahmen(bytes([fn | 0x80, 0x02]))
        for i in range(anz):
            (wert,) = struct.unpack(">H", pdu[5 + 2 * i:7 + 2 * i])
            anlage.schreibe(seite.box, adr + i, wert, seite.regs)
        seite.schreiben += 1
        seite.letzter_schreib_s = anlage.s
        return rahmen(bytes([fn]) + pdu[:4])
    return rahmen(bytes([fn | 0x80, 0x01]))


# --- Der Prozess --------------------------------------------------------------

class Lauf:
    def __init__(self, a: argparse.Namespace):
        self.args = a
        self.anlage = Anlage(profil(a.profil), t0_s=a.anlauf + a.t0)
        ein, bez = lade_grenzen()
        self.ein = Messung(ein, -1)
        self.bez = Messung(bez, +1)
        self.nullpunkt_kw = float(getattr(a, "nullpunkt", 0.0) or 0.0)
        self.seiten = {"E-1": BoxSeite("E-1", nullpunkt_kw=self.nullpunkt_kw), "E-4": BoxSeite("E-4")}
        self.ladepunkte = [x for x in (getattr(a, "ladepunkte", "") or "").split(",") if x]
        self.ladepunkte_stand: dict[str, dict] = {}
        self.adresse_zu_box: dict[str, str] = {}
        self.stoerungen: list[dict] = []
        self.reihe: list[dict] = []
        self.fertig = asyncio.Event()
        self.gestartet = asyncio.Event()  # die Uhr läuft erst, wenn die Nutzlasten quittiert sind

    def ordne_adressen(self) -> None:
        for box, name in (("E-1", "anlage-e1"), ("E-4", "anlage-e4")):
            try:
                self.adresse_zu_box[socket.gethostbyname(name)] = box
            except OSError:
                pass

    def box_fuer(self, lokal: str) -> str | None:
        if lokal not in self.adresse_zu_box:
            self.ordne_adressen()
        return self.adresse_zu_box.get(lokal)

    async def modbus(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        lokal = writer.get_extra_info("sockname")[0]
        box = self.box_fuer(lokal)
        if box is None:
            writer.close()
            return
        seite = self.seiten[box]
        try:
            while True:
                kopf = await reader.readexactly(6)
                (laenge,) = struct.unpack(">H", kopf[4:6])
                rest = await reader.readexactly(laenge)
                antwort = modbus_antwort(kopf + rest, seite, self.anlage)
                if antwort is not None:
                    writer.write(antwort)
                    await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()

    def mess_sekunde(self) -> int:
        return self.anlage.s - self.args.anlauf

    async def steuer(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        zeile = await reader.readline()
        try:
            antwort = self.befehl(json.loads(zeile))
        except Exception as e:  # die Antwort geht an den Aufrufer, nicht in den Lauf
            antwort = {"fehler": str(e)}
        writer.write((json.dumps(antwort, ensure_ascii=False) + "\n").encode())
        await writer.drain()
        writer.close()

    def befehl(self, b: dict) -> dict:
        cmd = b.get("cmd")
        if cmd == "start":
            self.gestartet.set()
            return {"gestartet": True}
        if cmd == "stand":
            return self.stand()
        if cmd == "protokoll":
            return self.protokoll()
        if cmd == "stoerung":
            return self.stoerung(b)
        if cmd == "rueckfall":
            # A10 (R12): der Installateur setzt den Rückfall von K-1 auf 10 kW
            g = {x.name: x for x in self.anlage.alle()}[b["komponente"]]
            g.rueckfall_kw = float(b["kw"])
            eintrag = {"art": "rueckfall", "komponente": g.name, "kw": g.rueckfall_kw,
                       "sim_s": self.anlage.s, "mess_s": self.mess_sekunde()}
            self.stoerungen.append(eintrag)
            return eintrag
        raise ValueError(f"unbekannter Befehl {cmd!r}")

    def stoerung(self, b: dict) -> dict:
        """Nur, was die ANLAGE tut: Zähler einfrieren/fehlen, Box-LAN weg.
        Alles am Container (trennen, stoppen, Uhr) macht stoerung.sh und meldet
        es hier nur an, damit es im Protokoll mit Simulator-Sekunden steht."""
        art, phase = b["art"], b.get("phase", "start")
        seite = self.seiten.get(b.get("box", "E-1"))
        if art == "zaehler_friert" and seite:
            seite.friert = None if phase == "ende" else (
                self.anlage.netz if seite.box == "E-1" else self.anlage.abgang_e4)
        elif art == "zaehler_fehlt" and seite:
            seite.zaehler_fehlt = phase != "ende"
        elif art == "lan_weg" and seite:
            seite.stumm = phase != "ende"
        eintrag = {"art": art, "phase": phase, "box": b.get("box"), "zeile": b.get("zeile"),
                   "sim_s": self.anlage.s, "mess_s": self.mess_sekunde()}
        if seite and seite.friert is not None and art == "zaehler_friert":
            eintrag["wert_kw"] = round(seite.friert, 3)
        self.stoerungen.append(eintrag)
        return eintrag

    def stand(self) -> dict:
        a = self.anlage
        return {
            "sim_s": a.s, "mess_s": self.mess_sekunde(), "profil": a.p.name,
            "netz_kw": round(a.netz, 3), "abgang_e4_kw": round(a.abgang_e4, 3),
            "pv_k1_kw": round(a.pv_k1, 3), "pv_k12_kw": round(a.pv_k12, 3),
            "speicher_k2_kw": round(a.batt_k2, 3),
            "geraete": {g.name: {"wirkt_kw": round(g.wirkt, 3), "rueckfall": g.ziel(a.s)[1]}
                        for g in a.alle()},
            "boxen": {k: {"lesen": v.lesen, "schreiben": v.schreiben,
                          "letzter_schreib_s": v.letzter_schreib_s,
                          "freigabe": v.regs[R_ENABLE], "pv_limit_raw": v.regs[R_PVLIMIT],
                          "speicher_soll_kw": s16(v.regs[R_SETPOINT]) / 100.0,
                          "ueberlauf": v.ueberlauf}
                      for k, v in self.seiten.items()},
            "gestartet": self.gestartet.is_set(), "fertig": self.fertig.is_set(),
            "laden_k13_kw": round(a.laden_k13, 3),
            "ladepunkte": self.ladepunkte_stand,
        }

    def protokoll(self) -> dict:
        a = self.args
        return {
            "werkzeug": "tools/uems-verbund-sim (AP-15 IP-28, NW-3)",
            "takt": "1 Simulator-Sekunde = 1 echte Sekunde (die Box rechnet in echten Sekunden)",
            "profil": a.profil, "anlauf_s": a.anlauf, "dauer_s": a.dauer, "t0_mess_s": a.t0,
            "nullpunkt_e1_kw": self.nullpunkt_kw, "ladepunkte": self.ladepunkte,
            "sim_s": self.anlage.s, "mess_s": max(self.mess_sekunde(), 0),
            "fertig": self.fertig.is_set(),
            "einspeisung": self.ein.bericht(), "bezug": self.bez.bericht(),
            "stoerungen": self.stoerungen,
            "boxen": self.stand()["boxen"],
            "reihe_10s": self.reihe,
        }

    async def takt(self) -> None:
        a = self.args
        await self.gestartet.wait()
        start = time.monotonic()
        ende = a.anlauf + a.dauer
        while self.anlage.s < ende:
            naechste = start + self.anlage.s + 1
            await asyncio.sleep(max(0.0, naechste - time.monotonic()))
            self.anlage.schritt()
            for seite in self.seiten.values():
                seite.aktualisiere(self.anlage)
            m = self.mess_sekunde()
            if m >= 1:
                self.ein.nimm(m, self.anlage.netz)
                self.bez.nimm(m, self.anlage.netz)
            if self.anlage.s % 10 == 0:
                self.reihe.append({"mess_s": m, "netz_kw": round(self.anlage.netz, 2),
                                   "abgang_e4_kw": round(self.anlage.abgang_e4, 2),
                                   "pv_k1_kw": round(self.anlage.pv_k1, 2),
                                   "pv_k12_kw": round(self.anlage.pv_k12, 2),
                                   "speicher_k2_kw": round(self.anlage.batt_k2, 2),
                                   "laden_k13_kw": round(self.anlage.laden_k13, 2)})
        self.ein.schluss()
        self.bez.schluss()
        self.fertig.set()

    def lies_ladepunkte(self) -> None:
        """Ein Faden: je Sekunde /status jeder Säule (vp-ocpp-sim). Eine Säule,
        die nicht antwortet, zählt mit ihrem letzten Wert - ihr Wagen zieht weiter."""
        while True:
            summe = 0.0
            for adr in self.ladepunkte:
                try:
                    with urllib.request.urlopen(f"http://{adr}/status", timeout=0.8) as r:
                        d = json.loads(r.read())
                    self.ladepunkte_stand[adr] = {"id": d.get("id"), "kw": d.get("total_kw", 0.0)}
                except (OSError, ValueError):
                    self.ladepunkte_stand.setdefault(adr, {"id": None, "kw": 0.0})["fehler"] = True
                summe += float(self.ladepunkte_stand[adr].get("kw") or 0.0)
            self.anlage.ladepunkte_kw = summe
            time.sleep(1.0)

    async def lauf(self) -> None:
        self.ordne_adressen()
        if self.ladepunkte:
            self.anlage.ladepunkte_kw = 0.0
            threading.Thread(target=self.lies_ladepunkte, daemon=True).start()
        mb = await asyncio.start_server(self.modbus, "0.0.0.0", MODBUS_PORT)
        st = await asyncio.start_server(self.steuer, "127.0.0.1", STEUER_PORT)
        print(f"[anlage] Profil {self.args.profil}, Anlauf {self.args.anlauf} s, "
              f"Messung {self.args.dauer} s, T0 = Messsekunde {self.args.t0}; "
              f"Adressen {self.adresse_zu_box}", flush=True)
        async with mb, st:
            await self.takt()
            print("[anlage] Lauf zu Ende; Protokoll bereit", flush=True)
            await asyncio.Event().wait()  # bleibt erreichbar, bis der Aufbau abgebaut wird


def steuer_senden(befehl: str) -> None:
    with socket.create_connection(("127.0.0.1", STEUER_PORT), timeout=5) as s:
        s.sendall(befehl.encode() + b"\n")
        daten = b""
        while chunk := s.recv(65536):
            daten += chunk
    sys.stdout.write(daten.decode())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="was", required=True)
    an = sub.add_parser("anlage", help="das Anlagenmodell als Prozess")
    an.add_argument("--profil", default=os.environ.get("VB_PROFIL", "mittag"))
    an.add_argument("--anlauf", type=int, default=int(os.environ.get("VB_ANLAUF_S", "300")))
    an.add_argument("--dauer", type=int, default=int(os.environ.get("VB_DAUER_S", "2700")))
    an.add_argument("--t0", type=int, default=int(os.environ.get("VB_T0_S", "600")))
    an.add_argument("--nullpunkt", type=float, default=float(os.environ.get("VB_NULLPUNKT_KW", "0")))
    an.add_argument("--ladepunkte", default=os.environ.get("VB_LADEPUNKTE", ""),
                    help="host:port,… der vp-ocpp-sim-Statusseiten")
    st = sub.add_parser("steuer", help="Befehl an den laufenden Prozess")
    st.add_argument("json")
    a = p.parse_args(argv)
    if a.was == "steuer":
        steuer_senden(a.json)
        return 0
    asyncio.run(Lauf(a).lauf())
    return 0


if __name__ == "__main__":
    sys.exit(main())
