"""Pruefer der VoltPilot-Bibliothek fuer CODESYS gegen die Vertragsvektoren des Erzeuger-Bilds.

    python3 sps/codesys/pruefer/pruefe.py            # alles pruefen, Bericht, Exit 1 bei Fehler
    python3 sps/codesys/pruefer/pruefe.py --schreibe # dazu erwartung.json und plcopen/*.xml neu schreiben

Was er prueft, jeweils am Structured Text der Bibliothek (st.py fuehrt ihn aus):

1. Vertragsfaelle: fuer jeden lesbaren Fall von erzeuger-registerbild-vectors.json die Eingaenge,
   mit denen ein Anlagenprogramm genau dieses Bild meint; der Baustein muss daraus dieselben Woerter
   machen (jedes Feld, das der Vertrag liest), und sein Bild muss gelesen genau die Erwartung des
   Falls ergeben - Kopf, Werte, Gruende, Einheiten, Namen.
2. Herzschlag: +1 je Sekunde ab Programmstart, 65535 -> 0, steht ohne Aufruf.
3. Pruefwert ueber die Packfunktion, nie als zwei Konstanten (Vertrag §1, Fall E5).
4. Grundprogramm: Kopf lesbar, keine Anlage (te_anzahl 0), Herzschlag laeuft.
5. Probeprojekt: das Bild ist lesbar, und probeprojekt/erwartung.json ist, was die Box lesen muss.
6. Ungedeckt und unbekannt: das Typ-Maximum, nie 0.
7. plcopen/*.xml ist aus denselben Quellen erzeugt und aktuell.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HIER = Path(__file__).resolve().parent
sys.path.insert(0, str(HIER))

import st  # noqa: E402
import vertrag  # noqa: E402

CODESYS = HIER.parent
BIBLIOTHEK = sorted((CODESYS / "bibliothek").glob("*.st"))
GVL = CODESYS / "grundprogramm" / "GVL_VoltPilot.st"
ERWARTUNG = CODESYS / "probeprojekt" / "erwartung.json"


def projekt(programm: Path | None = None) -> st.Projekt:
    p = st.Projekt()
    for datei in BIBLIOTHEK + [GVL] + ([programm] if programm else []):
        p.lade(datei)
    return p


def bild_von(p: st.Projekt) -> list[int]:
    return list(p.globale["GVL_VoltPilot"]["aErzeugerBild"].werte)


def struktur(p: st.Projekt, typname: str, werte: dict) -> dict:
    s = p.anfang(st.Typ("ref", typname), None, {})
    for k, v in werte.items():
        if k not in s:
            raise st.StFehler(f"{typname} hat kein Glied {k}")
        s[k] = v
    return s


def baustein_aufrufen(p: st.Projekt, e: dict, herzschlag: int | None = None) -> list[int]:
    """Ein Aufruf von FB_VP_ErzeugerBild mit den Eingaengen e, auf das globale Abbild."""
    inst = p.neue_instanz(p.pous["FB_VP_ErzeugerBild"])
    if herzschlag is not None:
        # Der Herzschlag zaehlt seit Programmstart; fuer den Vergleich steht er dort, wo der Fall ihn nennt.
        inst.werte.update(uiHerzschlag=herzschlag, xGestartet=True, tLetzte=p.uhr_ms)
    w = inst.werte
    w["udiSteuerungId"] = e["udiSteuerungId"]
    w["uiProgrammstand"] = e["uiProgrammstand"]
    w["uiAnlagenart"] = e["uiAnlagenart"]
    w["uiTeAnzahl"] = e["uiTeAnzahl"]
    w["stAnlage"] = struktur(p, "ST_VP_ErzeugerAnlage", e["stAnlage"])
    w["stNetzbetreiber"] = struktur(p, "ST_VP_ErzeugerNetzbetreiber", e["stNetzbetreiber"])
    w["stDirektvermarkter"] = struktur(p, "ST_VP_ErzeugerDirektvermarkter", e["stDirektvermarkter"])
    w["stWirkung"] = struktur(p, "ST_VP_ErzeugerWirkung", e["stWirkung"])
    for n in range(1, 11):
        w["astEinheit"].werte[n - 1] = struktur(p, "ST_VP_ErzeugerEinheit", e["astEinheit"][n])
    w["xMitNamen"] = e["xMitNamen"]
    w["sNetzbetreiber"] = e["sNetzbetreiber"]
    w["sDirektvermarkter"] = e["sDirektvermarkter"]
    w["aBild"] = p.globale["GVL_VoltPilot"]["aErzeugerBild"]
    p.lauf(inst.pou, w)
    return bild_von(p)


class Bericht:
    def __init__(self):
        self.fehler: list[str] = []
        self.zeilen: list[str] = []

    def ok(self, text: str):
        self.zeilen.append("  ok   " + text)

    def nein(self, text: str):
        self.fehler.append(text)
        self.zeilen.append("  FEHLER " + text)

    def info(self, text: str):
        self.zeilen.append("  --   " + text)


def pruefe_vertragsfaelle(b: Bericht):
    for fall in vertrag.V["faelle"]:
        name = fall["name"].split()[0]
        for k, (eingabe, erwartung) in enumerate(zip(fall["input"]["lesungen"], fall["expected"]["lesungen"])):
            lesung = eingabe["woerter"]
            etikett = name if len(fall["input"]["lesungen"]) == 1 else f"{name}/{k + 1}"
            pruefe_lesung(b, etikett, fall, lesung, erwartung)


def pruefe_lesung(b: Bericht, name: str, fall: dict, lesung: list[int], erwartung: dict):
    if erwartung["ergebnis"] != "lesbar":
        b.info(f"{name}: nicht lesbar ({erwartung['grund']}) - ein Programm mit diesem Baustein erzeugt "
               "nur ein lesbares Bild der Fassung 1.0")
        return
    namen_in = fall["input"].get("namen")
    try:
        e = vertrag.eingaenge(lesung, namen_in["woerter"] if namen_in else None,
                              namen_in["ab"] if namen_in else None)
    except vertrag.NichtDarstellbar as grund:
        b.info(f"{name}: nicht vom Baustein erzeugbar - {grund}")
        return
    p = projekt()
    try:
        bild = baustein_aufrufen(p, e, herzschlag=e["herzschlag"])
    except st.StFehler as fehler:
        b.nein(f"{name}: Ausfuehrung: {fehler}")
        return
    abweichung = []
    laenge = len(lesung)
    for i in range(12):
        if i < laenge and bild[i] != lesung[i]:
            abweichung.append(f"Kopf {i}: {bild[i]:#06x} statt {lesung[i]:#06x}")
    for f in vertrag.felder_anlage():
        if vertrag.gelesen_vom_leser(lesung, f, 0):
            for k in range(f["woerter"]):
                a = f["adresse"] + k
                if bild[a] != lesung[a]:
                    abweichung.append(f"{f['feld']} [{a}]: {bild[a]:#06x} statt {lesung[a]:#06x}")
    for n in range(1, e["uiTeAnzahl"] + 1):
        basis = vertrag.FESTER_TEIL + (n - 1) * vertrag.EINHEIT_LAENGE
        for f in vertrag.felder_einheit():
            if vertrag.gelesen_vom_leser(lesung, f, basis):
                for k in range(f["woerter"]):
                    a = basis + f["adresse"] - vertrag.FESTER_TEIL + k
                    if bild[a] != lesung[a]:
                        abweichung.append(f"Einheit {n} {f['feld']} [{a}]: {bild[a]:#06x} statt {lesung[a]:#06x}")
    gelesen = vertrag.lies(bild)
    for schluessel in ("kopf", "werte", "leer"):
        if gelesen.get(schluessel) != erwartung[schluessel]:
            abweichung.append(f"gelesen {schluessel}: {gelesen.get(schluessel)} statt {erwartung[schluessel]}")
    for ist, soll in zip(gelesen.get("einheiten", []), erwartung["einheiten"]):
        if ist["werte"] != soll["werte"] or ist["leer"] != soll["leer"]:
            abweichung.append(f"Einheit {soll['n']}: {ist} statt {soll}")
    namen_soll = fall["expected"]["namen"]
    if namen_soll is not None and gelesen.get("kopf"):
        namen_ist = vertrag.namen(bild, gelesen["kopf"])
        for k in ("ergebnis", "netzbetreiber_name", "direktvermarkter_name", "t_typ_name"):
            if k in namen_ist and namen_ist.get(k) != namen_soll.get(k):
                abweichung.append(f"Namen {k}: {namen_ist.get(k)!r} statt {namen_soll.get(k)!r}")
        if namen_ist["ergebnis"] != namen_soll["ergebnis"]:
            abweichung.append(f"Namen: {namen_ist['ergebnis']} statt {namen_soll['ergebnis']}")
    if abweichung:
        b.nein(f"{name}: " + "; ".join(abweichung[:6]))
    else:
        b.ok(f"{name}: dieselben Woerter, gelesen wie erwartet")


def pruefe_herzschlag(b: Bericht):
    p = projekt()
    leer = {"udiSteuerungId": 1, "uiProgrammstand": 2611, "uiAnlagenart": 1, "uiTeAnzahl": 1,
            "stAnlage": {}, "stNetzbetreiber": {}, "stDirektvermarkter": {}, "stWirkung": {},
            "astEinheit": {n: {} for n in range(1, 11)}, "xMitNamen": False,
            "sNetzbetreiber": b"", "sDirektvermarkter": b""}
    inst = p.neue_instanz(p.pous["FB_VP_ErzeugerBild"])

    def zur(ms: int) -> int:
        p.uhr_ms = ms
        w = inst.werte
        for k in ("udiSteuerungId", "uiProgrammstand", "uiAnlagenart", "uiTeAnzahl", "xMitNamen"):
            w[k] = leer[k]
        w["aBild"] = p.globale["GVL_VoltPilot"]["aErzeugerBild"]
        p.lauf(inst.pou, w)
        return bild_von(p)[6]

    folge = [zur(t) for t in (1000, 1500, 1999, 2000, 6500, 7000)]
    if folge != [0, 0, 0, 1, 5, 6]:
        b.nein(f"Herzschlag je Sekunde: {folge} statt [0, 0, 0, 1, 5, 6]")
    else:
        b.ok("Herzschlag: beim Start 0, +1 je Sekunde, auch ueber lange Zyklen")
    inst.werte["uiHerzschlag"] = 65534
    ueber = [zur(t) for t in (8000, 9000, 10000)]
    if ueber != [65535, 0, 1]:
        b.nein(f"Herzschlag-Ueberlauf: {ueber} statt [65535, 0, 1]")
    else:
        b.ok("Herzschlag: 65535 -> 0 (Vertrag §8)")
    # TIME() laeuft nach 49 Tagen ueber: die letzte Sekunde lag 1000 ms vor dem Ueberlauf, jetzt
    # ist es 2000 ms danach - drei Sekunden.
    inst.werte["tLetzte"] = 0xFFFFFC18
    inst.werte["uiHerzschlag"] = 10
    nach = zur(0x000007D0)
    if nach != 13:
        b.nein(f"Herzschlag beim Ueberlauf von TIME(): {nach} statt 13")
    else:
        b.ok("Herzschlag: zaehlt weiter, wenn TIME() nach 49 Tagen ueberlaeuft")


def pruefe_unbekannt(b: Bericht):
    """Ein gedeckter Wert ohne sein Gueltigkeitsbit, ein Wert ohne "bekannt": das Typ-Maximum, nie 0.

    Der Leser des Vertrags liest diese Woerter nicht - darum prueft sie Abschnitt 1 nicht. Ein
    Modbus-Client ohne Deckungsregel liest sie aber, und dann soll dort kein erfundener Wert stehen.
    """
    p = projekt()
    e = {"udiSteuerungId": 0xFFFFFFFF, "uiProgrammstand": 0xFFFF, "uiAnlagenart": 0xFFFF, "uiTeAnzahl": 1,
         "stAnlage": {"diPNetzpunktW": 5, "diPErzeugungW": 5, "uiSpeicherZehntelProzent": 5,
                      "xAlterBekannt": False, "xZustandBekannt": False, "xInstalliertBekannt": False},
         "stNetzbetreiber": {"iCosPhiTausendstel": 5, "xKanalBekannt": False, "xPBekannt": False,
                             "xSeitBekannt": False},
         "stDirektvermarkter": {"udiSollW": 5, "uiSeitS": 5, "xKanalBekannt": False},
         "stWirkung": {"uiQuelle": 5, "udiGrenzeW": 5},
         "astEinheit": {n: {"uiZustand": 5, "diPIstW": 5, "udiPSollW": 5, "udiEZehntelKwh": 5,
                            "xArtBekannt": False, "xNennBekannt": False} for n in range(1, 11)},
         "xMitNamen": False, "sNetzbetreiber": b"", "sDirektvermarkter": b""}
    bild = baustein_aufrufen(p, e)
    falsch = []
    for f in vertrag.felder_anlage() + [vertrag.FELDER[k] for k in ("programmstand", "steuerung_id", "anlagenart")]:
        if f["ungueltig"] is None or f["art"] == "bitfeld":
            continue
        if vertrag.roh(bild, f["adresse"], f["typ"]) != f["ungueltig"]:
            falsch.append(f["feld"])
    for f in vertrag.felder_einheit():
        if f["ungueltig"] is not None and f["art"] != "bitfeld":
            adresse = f["adresse"]
            if vertrag.roh(bild, adresse, f["typ"]) != f["ungueltig"]:
                falsch.append("te1." + f["feld"])
    if falsch:
        b.nein(f"unbekannt ist nicht das Typ-Maximum: {falsch}")
    else:
        b.ok("unbekannt und ungedeckt: das Typ-Maximum, nie 0 (Vertrag §1, §4)")


def pruefe_pruefwert(b: Bericht):
    text = (CODESYS / "bibliothek" / "FB_VP_ErzeugerBild.st").read_text(encoding="utf-8")
    ohne = re.sub(r"\(\*.*?\*\)", "", text, flags=re.S)
    if re.search(r"aBild\s*\[\s*[23]\s*\]\s*:=", ohne):
        b.nein("der Pruefwert steht als Konstante in Wort 2/3 statt ueber VP_SetzeU32 (Fall E5)")
    elif not re.search(r"VP_SetzeU32\([^;]*uiAdresse\s*:=\s*2\s*,\s*udiWert\s*:=\s*16#01020304", ohne):
        b.nein("der Pruefwert 16#01020304 geht nicht ueber VP_SetzeU32 an Adresse 2")
    else:
        b.ok("Pruefwert ueber VP_SetzeU32, wie jeder 32-bit-Wert (Vertrag §1, Fall E5)")


def pruefe_grundprogramm(b: Bericht):
    p = projekt(CODESYS / "grundprogramm" / "PLC_PRG.st")
    p.uhr_ms = 0
    p.zyklus()
    erst = vertrag.lies(bild_von(p))
    p.uhr_ms = 3000
    p.zyklus()
    dann = vertrag.lies(bild_von(p))
    kopf = dann.get("kopf") or {}
    if (dann["grund"] != "te_anzahl_ungueltig" or kopf.get("te_anzahl") != 0 or kopf.get("version_haupt") != 1
            or kopf.get("programmstand") != 2611 or kopf.get("beschreibung_ab") != 0):
        b.nein(f"Grundprogramm: {dann}")
    elif kopf["herzschlag"] - erst["kopf"]["herzschlag"] != 3:
        b.nein("Grundprogramm: der Herzschlag laeuft nicht")
    else:
        b.ok("Grundprogramm: Kopf lesbar (VP EZ 1.0, Programm 2611), keine Anlage, Herzschlag laeuft")


def probe_erwartung() -> dict:
    p = projekt(CODESYS / "probeprojekt" / "PLC_PRG.st")
    p.uhr_ms = 0
    p.zyklus()
    bild = bild_von(p)
    gelesen = vertrag.lies(bild)
    if gelesen["ergebnis"] != "lesbar":
        raise st.StFehler(f"das Probeprojekt ergibt kein lesbares Bild: {gelesen['grund']}")
    return {
        "_comment": ["ERZEUGT von sps/codesys/pruefer/pruefe.py --schreibe aus probeprojekt/PLC_PRG.st.",
                     "Was die Box (oder eine Lesung gegen 127.0.0.1:502, Funktionscode 4) vom Probeprojekt",
                     "lesen muss (PS-P9). Der Herzschlag (Wort 6) zaehlt am Geraet; hier steht der Start 0."],
        "woerter": {"0..67": bild[0:68], "140..219": bild[140:220]},
        "gelesen": gelesen,
        "namen": vertrag.namen(bild, gelesen["kopf"]),
    }


def pruefe_probeprojekt(b: Bericht, schreibe: bool):
    neu = probe_erwartung()
    text = json.dumps(neu, ensure_ascii=False, indent=1) + "\n"
    if schreibe:
        ERWARTUNG.write_text(text, encoding="utf-8")
    g = neu["gelesen"]
    if g["ergebnis"] != "lesbar" or g["werte"]["p_nvp_w"] != -1200 or neu["namen"]["t_typ_name"][2] != "Probe-Wechselrichter 3 (Grün)":
        b.nein(f"Probeprojekt: {g.get('grund')} {g.get('werte')}")
    elif not ERWARTUNG.exists() or ERWARTUNG.read_text(encoding="utf-8") != text:
        b.nein("probeprojekt/erwartung.json ist veraltet - pruefe.py --schreibe ausfuehren und committen")
    else:
        b.ok("Probeprojekt: lesbar, drei Einheiten, Einspeisung negativ, Umlaut im Namen; erwartung.json aktuell")


def pruefe_plcopen(b: Bericht, schreibe: bool):
    import plcopen
    if schreibe:
        plcopen.main([])
    if plcopen.main(["--pruefe"]) != 0:
        b.nein("plcopen/*.xml ist veraltet - pruefe.py --schreibe (oder plcopen.py) ausfuehren und committen")
    else:
        b.ok("PLCopen XML (Bibliothek, Grundprogramm, Probeprojekt) aus denselben .st-Quellen, aktuell")


def main(argv: list[str]) -> int:
    b = Bericht()
    for pruefung in (pruefe_vertragsfaelle, pruefe_herzschlag, pruefe_unbekannt, pruefe_pruefwert,
                     pruefe_grundprogramm, lambda x: pruefe_probeprojekt(x, "--schreibe" in argv),
                     lambda x: pruefe_plcopen(x, "--schreibe" in argv)):
        try:
            pruefung(b)
        except Exception as fehler:  # noqa: BLE001 - jede Pruefung scheitert fuer sich, mit Grund
            b.nein(f"{getattr(pruefung, '__name__', 'Probeprojekt')}: {type(fehler).__name__}: {fehler}")
    print("VoltPilot-Bibliothek (CODESYS) gegen die Vertragsvektoren des Erzeuger-Bilds:")
    print("\n".join(b.zeilen))
    if b.fehler:
        print(f"{len(b.fehler)} Fehler")
        return 1
    print("alles gruen")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
