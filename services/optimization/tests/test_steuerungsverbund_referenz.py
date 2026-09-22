"""Die Python-Referenz der Anteile einer Gemeinsamen Steuerung (UEMS AP-15 IP-2, NW-1).

Rechenkern aus dem Konzept (``k_faelle.py``: ``anteile``, ``uebergangsstand``)
plus die Dokument-Pruefung der Box (T4, G5) - ohne Berichts-Erzeugung. Er
faehrt ``docs/contracts/v2/verbund-anteil-vectors.json``; dieselbe Datei faehrt
der Java-Zwilling (``SteuerungsverbundAnteilVectorsTest``), der Go-Zwilling der
Box kommt mit IP-17. Gerechnet wird in ganzen Zehntel-kW mit ``Decimal`` -
ein ``float`` wuerde 24,6 kW beim Aufrunden zu 24,7 machen. Rein: ohne DB,
ohne Uhr. Die Zahlen der Referenzwelt kommen ueber die Zeiger in ``quelle``
aus ``uems-referenzunternehmen.json``, nie abgetippt.
"""

from __future__ import annotations

import json
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from pathlib import Path

import pytest

V2 = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "v2"


def _lies(name: str):
    return json.loads((V2 / name).read_text(encoding="utf-8"), parse_float=Decimal)


DATA = _lies("verbund-anteil-vectors.json")
REFERENZ = _lies("uems-referenzunternehmen.json")

# ---------------------------------------------------------------------------
# Geschlossene Vokabulare - dieselben Woerter wie SteuerungsverbundVokabular
# ---------------------------------------------------------------------------
ROLLEN = ("fuehrt", "steuert_mit", "liest")
STUFEN = (("S0", "erklaert"), ("S1", "beobachtet"), ("S2", "geprueft"), ("S3", "anteile_aktiv"), (None, "angehalten"))
GRENZARTEN = ("einspeisung", "bezug", "netzbetreiber_vorgabe")
GERAETE_RUECKFAELLE = ("haelt_letzten_wert", "faellt_auf_wert", "laeuft_frei", "unbekannt")
AUSLEGUNG_URTEILE = ("passt", "auslegung_passt_nicht", "vorbehalt_ueber_grenze")
ABLEHNUNGEN = (
    "box_nicht_in_anlage",
    "kein_netzanschluss",
    "grenze_fehlt",
    "faehigkeit_fehlt",
    "nachweis_fehlt",
    "auslegung_passt_nicht",
    "fuehrende_box_misst_nicht",
    "vorgabe_signal_nicht_an_jeder_box",
    "mitsteuernde_box_misst_nicht",
)
DOKUMENT_URTEILE = ("angenommen", "abgelehnt")
DOKUMENT_ABLEHNUNGEN = ("fremde_anlage", "box_fehlt_im_dokument", "revision_aelter", "summe_ueber_verteilbar")

RICHTUNGEN = ("einspeisung", "bezug")
MITGLIED_ROLLEN = ("steuert_mit", "fuehrt")  # auch die Verteil-Reihenfolge (G4)


# ---------------------------------------------------------------------------
# Rechenkern
# ---------------------------------------------------------------------------
def _zehntel(kw, rundung) -> int:
    return int((Decimal(str(kw)) * 10).to_integral_value(rounding=rundung))


def _kw(zehntel: int) -> Decimal:
    return Decimal(zehntel).scaleb(-1)


def anteile(grenze_kw, vorbehalt_kw, mitglieder, zuschlag_kw=0):
    """Anteile einer Richtung (G2-G4). ``mitglieder``: [{box, rolle, nenn_kw, rueckfall_kw}].

    Rundung zur sicheren Seite: Grenze und Nennleistung ab-, Vorbehalt und
    Rueckfall aufrunden; jeder anteilige Zuschlag abgerundet, der Rest bleibt
    ungenutzt. Ungueltiger Eingang wirft ``ValueError``."""
    werte = [grenze_kw, vorbehalt_kw, zuschlag_kw] + [x for m in mitglieder for x in (m["nenn_kw"], m["rueckfall_kw"])]
    if any(Decimal(str(w)) < 0 for w in werte):
        raise ValueError("negativer Eingang")
    boxen = [m["box"] for m in mitglieder]
    if len(set(boxen)) != len(boxen):
        raise ValueError("Box doppelt")
    if any(m["rolle"] not in MITGLIED_ROLLEN for m in mitglieder):
        raise ValueError("nur fuehrt und steuert_mit sind Mitglieder")
    if any(Decimal(str(m["rueckfall_kw"])) > Decimal(str(m["nenn_kw"])) for m in mitglieder):
        raise ValueError("Rueckfall ueber Nennleistung")  # an den ROHEN Werten
    F = {m["box"]: _zehntel(m["rueckfall_kw"], ROUND_CEILING) for m in mitglieder}
    # Obergrenze: nie kleiner als der aufgerundete Rueckfall (22,08 / 22,08 kW -> 22,1 kW), darueber nichts
    N = {m["box"]: max(_zehntel(m["nenn_kw"], ROUND_FLOOR), F[m["box"]]) for m in mitglieder}

    V = _zehntel(grenze_kw, ROUND_FLOOR) - _zehntel(vorbehalt_kw, ROUND_CEILING)
    Z = _zehntel(zuschlag_kw, ROUND_CEILING)
    if V < 0:
        return {"urteil": "vorbehalt_ueber_grenze", "verteilbar_kw": _kw(V), "summe_rueckfall_kw": None,
                "anteile": {}, "ungenutzt_kw": None, "zuschlag_kw": _kw(Z), "zuschlag_fehlt_kw": None}
    summe_f = sum(F.values())
    if summe_f > V:
        return {"urteil": "auslegung_passt_nicht", "verteilbar_kw": _kw(V), "summe_rueckfall_kw": _kw(summe_f),
                "anteile": {}, "ungenutzt_kw": None, "zuschlag_kw": _kw(Z), "zuschlag_fehlt_kw": None}

    # Uebergangszuschlag (Lesart B): nur aus dem Rest ueber den Rueckfaellen, nie eine Ablehnung
    genommen = min(Z, V - summe_f)
    rest = V - summe_f - genommen
    e = dict(F)
    for rolle in MITGLIED_ROLLEN:
        gruppe = [m["box"] for m in mitglieder if m["rolle"] == rolle]
        bedarf = {b: N[b] - e[b] for b in gruppe}
        gesamt = sum(bedarf.values())
        if gesamt == 0 or rest == 0:
            continue
        if gesamt <= rest:
            for b in gruppe:
                e[b] += bedarf[b]
            rest -= gesamt
        else:
            for b in gruppe:
                e[b] += rest * bedarf[b] // gesamt  # ganzzahlig = abgerundet
            rest = 0  # der Rundungsrest bleibt ungenutzt, er wandert nicht weiter
    return {"urteil": "passt", "verteilbar_kw": _kw(V), "summe_rueckfall_kw": _kw(summe_f),
            "anteile": {b: _kw(e[b]) for b in boxen}, "ungenutzt_kw": _kw(V - sum(e.values()) - genommen),
            "zuschlag_kw": _kw(Z), "zuschlag_fehlt_kw": _kw(Z - genommen)}


RUECKFALLZEIT_VORGABE_S = 60  # ohne nach_s am Speicher
VIERTELSTUNDE_S = 900


def uebergangszuschlag(rueckfallzeit_s, leistung_kw) -> Decimal:
    """Puffer fuer den Ausfall der fuehrenden Box: Rueckfallzeit / 900 s x Lade- bzw. Entladeleistung ihrer
    Speicher, auf 0,1 kW AUFgerundet (zugunsten der Grenze); ohne Rueckfallzeit die Vorgabe 60 s."""
    t = RUECKFALLZEIT_VORGABE_S if rueckfallzeit_s is None else int(rueckfallzeit_s)
    if t < 0 or Decimal(str(leistung_kw)) < 0:
        raise ValueError("negativer Eingang")
    return _kw(int((Decimal(str(leistung_kw)) * t * 10 / VIERTELSTUNDE_S).to_integral_value(rounding=ROUND_CEILING)))


def ablehnung_der_auslegung(urteil: str):
    """Scharfschalten verlangt ``passt`` (I1); jedes andere Urteil lehnt mit ``auslegung_passt_nicht`` ab (E2 = A)."""
    return None if urteil == "passt" else "auslegung_passt_nicht"


def uebergangsstand(alt, neu):
    """Zweischritt (G5): je Box das Kleinere; wer in einem Stand fehlt, steht dort mit 0."""
    boxen = sorted(set(alt) | set(neu))
    ueber = {b: min(Decimal(str(alt.get(b, 0))), Decimal(str(neu.get(b, 0)))) for b in boxen}
    verengt = [b for b in boxen if ueber[b] < Decimal(str(alt.get(b, 0)))]
    zweiter = any(ueber[b] != Decimal(str(neu.get(b, 0))) for b in boxen)
    return {"uebergang": ueber, "verengte_boxen": verengt, "zweiter_schritt": zweiter}


def dokument_pruefen(identitaet, stand, dokument):
    """Die Pruefung eines Anteils-Dokuments auf der Box (T4, G5, Y1) - in dieser Reihenfolge."""
    if dokument["mandant"] != identitaet["mandant"] or dokument["anlage"] != identitaet["anlage"]:
        return ("abgelehnt", "fremde_anlage")
    if any(identitaet["box"] not in dokument["anteile"].get(r, {}) for r in RICHTUNGEN):
        return ("abgelehnt", "box_fehlt_im_dokument")
    if stand is not None and (dokument["epoche"], dokument["revision"]) < (stand["epoche"], stand["revision"]):
        return ("abgelehnt", "revision_aelter")
    for r in RICHTUNGEN:
        summe = sum((Decimal(str(v)) for v in dokument["anteile"][r].values()), Decimal(0))
        if summe > Decimal(str(dokument["verteilbar"][f"{r}_kw"])):
            return ("abgelehnt", "summe_ueber_verteilbar")
    return ("angenommen", None)


# ---------------------------------------------------------------------------
# Die Vektoren
# ---------------------------------------------------------------------------
def _gleich(a, b) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_gleich(a[k], b[k]) for k in a)
    if a is None or b is None or isinstance(a, (str, bool, list)) or isinstance(b, (str, bool, list)):
        return a == b
    return Decimal(str(a)) == Decimal(str(b))


def _zeiger(dok, zeiger: str):
    for teil in zeiger.lstrip("/").split("/"):
        dok = dok[int(teil)] if isinstance(dok, list) else dok[teil]
    return dok


def _feld(fall, pfad: str):
    for teil in pfad.split("."):
        fall = fall[teil]
    return fall


def _pruefe_quelle(fall):
    """Jede Zahl mit Zeiger steht so in der Referenzdatei 1.5 - nichts ist abgetippt."""
    for pfad, zeiger in fall.get("quelle", {}).items():
        if pfad == "geraete_rueckfaelle":
            geraete = [g for g in REFERENZ["geraete_rueckfaelle"] if g["richtung"] == zeiger]
            assert geraete, zeiger
            for feld in ("nenn_kw", "rueckfall_kw"):
                aus_referenz = sum(Decimal(str(g[feld])) for g in geraete)
                im_vektor = sum(Decimal(str(m[feld])) for m in fall["mitglieder"])
                assert aus_referenz == im_vektor, (fall["name"], feld, aus_referenz, im_vektor)
            continue
        wert, ref = _feld(fall, pfad), _zeiger(REFERENZ, zeiger)
        if pfad == "erwartet":  # das ganze Urteil: jeder Schluessel des Vektors (ausser ablehnung) gleich in der Referenz
            for k, v in wert.items():
                if k != "ablehnung":
                    assert k in ref and _gleich(v, ref[k]), (fall["name"], k, v, ref.get(k))
        else:
            assert _gleich(wert, ref), (fall["name"], pfad, wert, ref)


def test_vokabulare_sind_geschlossen_und_gleich():
    v = DATA["vokabulare"]
    assert tuple(v["rolle"]) == ROLLEN
    assert tuple((s["stufe"], s["code"]) for s in v["stufe"]) == STUFEN
    assert tuple(v["grenzart"]) == GRENZARTEN
    assert tuple(v["geraete_rueckfall"]) == GERAETE_RUECKFAELLE
    assert tuple(v["auslegung_urteil"]) == AUSLEGUNG_URTEILE
    assert tuple(v["ablehnung"]) == ABLEHNUNGEN
    assert tuple(v["dokument_urteil"]) == DOKUMENT_URTEILE
    assert tuple(v["dokument_ablehnung"]) == DOKUMENT_ABLEHNUNGEN
    # E1 = A: die Zuteilung auf Zeit ist nicht gebaut - kein Zwilling kennt ihr Wort
    for s in DATA["nicht_gebaut"]["stufe"]:
        assert s["code"] not in [c for _, c in STUFEN]
    # die Rueckfall-Arten der Referenzwelt kommen aus dem Vokabular
    assert {g["rueckfall"] for g in REFERENZ["geraete_rueckfaelle"]} <= set(GERAETE_RUECKFAELLE)
    assert {m["rolle"] for g in REFERENZ["gemeinsame_steuerungen"] for m in g["mitglieder"]} <= set(ROLLEN)
    assert {s["code"] for g in REFERENZ["gemeinsame_steuerungen"] for s in g["stufen"]} <= {c for _, c in STUFEN}


@pytest.mark.parametrize("fall", DATA["anteile"], ids=lambda f: f["name"])
def test_jeder_anteilsfall_gilt_in_der_python_referenz(fall):
    assert fall["richtung"] in RICHTUNGEN
    _pruefe_quelle(fall)
    e = fall["erwartet"]
    if e.get("fehler"):
        with pytest.raises(ValueError):
            anteile(fall["grenze_kw"], fall["vorbehalt_kw"], fall["mitglieder"])
        return
    a = anteile(fall["grenze_kw"], fall["vorbehalt_kw"], fall["mitglieder"])
    assert a["urteil"] == e["urteil"] and a["urteil"] in AUSLEGUNG_URTEILE
    assert ablehnung_der_auslegung(a["urteil"]) == e["ablehnung"]
    assert e["ablehnung"] is None or e["ablehnung"] in ABLEHNUNGEN
    assert _gleich(a["verteilbar_kw"], e["verteilbar_kw"])
    assert _gleich(a["summe_rueckfall_kw"], e.get("summe_rueckfall_kw"))
    assert _gleich(a["anteile"], e["anteile"])
    assert _gleich(a["ungenutzt_kw"], e.get("ungenutzt_kw"))
    # die Summe der Anteile ueberschreitet nie das Verteilbare (G2)
    assert sum(a["anteile"].values(), Decimal(0)) <= a["verteilbar_kw"] or not a["anteile"]


@pytest.mark.parametrize("fall", DATA["uebergangszuschlag"], ids=lambda f: f["name"])
def test_jeder_uebergangszuschlag_gilt_in_der_python_referenz(fall):
    e = fall["erwartet"]
    z = uebergangszuschlag(fall["rueckfallzeit_s"], fall["leistung_kw"])
    assert _gleich(z, e["zuschlag_kw"])
    a = anteile(fall["grenze_kw"], fall["vorbehalt_kw"], fall["mitglieder"], zuschlag_kw=z)
    ohne = anteile(fall["grenze_kw"], fall["vorbehalt_kw"], fall["mitglieder"])
    assert a["urteil"] == e["urteil"] == ohne["urteil"]  # der Puffer aendert kein Urteil
    assert _gleich(a["verteilbar_kw"], e["verteilbar_kw"]) and a["verteilbar_kw"] == ohne["verteilbar_kw"]
    assert _gleich(a["summe_rueckfall_kw"], e["summe_rueckfall_kw"])
    assert _gleich(a["anteile"], e["anteile"])
    assert _gleich(a["ungenutzt_kw"], e["ungenutzt_kw"])
    assert _gleich(a["zuschlag_kw"], e["zuschlag_kw"])
    assert _gleich(a["zuschlag_fehlt_kw"], e["zuschlag_fehlt_kw"])
    if z == 0:
        assert a["anteile"] == ohne["anteile"]  # ohne Speicher byte-gleich
    if a["anteile"]:
        genommen = a["zuschlag_kw"] - a["zuschlag_fehlt_kw"]
        assert sum(a["anteile"].values(), Decimal(0)) + genommen <= a["verteilbar_kw"]


def test_ungeregeltes_hinter_dem_abgang_steht_in_beiden_summen():
    fall = next(f for f in DATA["anteile"] if f["name"].startswith("ungeregeltes_hinter_dem_abgang"))
    m = next(x for x in fall["mitglieder"] if "zusammensetzung" in x)
    z = m["zusammensetzung"]
    assert _gleich(m["nenn_kw"], Decimal(str(z["geraete_nenn_kw"])) + Decimal(str(z["ungeregelt_hoechstwert_kw"])))
    assert _gleich(m["rueckfall_kw"], Decimal(str(z["geraete_rueckfall_kw"])) + Decimal(str(z["ungeregelt_hoechstwert_kw"])))
    # der Vektor beweist etwas: mit der Nennleistung NUR der Geraete waere es ein (falscher) Eingabefehler
    with pytest.raises(ValueError):
        anteile(fall["grenze_kw"], fall["vorbehalt_kw"],
                [dict(x, nenn_kw=z["geraete_nenn_kw"]) if x is m else x for x in fall["mitglieder"]])


def test_abrunden_nie_aufrunden_ist_ein_eigener_vektor():
    fall = next(f for f in DATA["anteile"] if f["name"].startswith("Abrunden, nie Aufrunden"))
    a = anteile(fall["grenze_kw"], fall["vorbehalt_kw"], fall["mitglieder"])
    aufgerundet = fall["aufgerundet_waere"]
    # der Vektor beweist etwas: aufgerundet laege die Summe ueber dem Verteilbaren
    assert _gleich(sum(aufgerundet["anteile"].values(), Decimal(0)), aufgerundet["summe_kw"])
    assert Decimal(str(aufgerundet["summe_kw"])) > a["verteilbar_kw"]
    assert sum(a["anteile"].values(), Decimal(0)) <= a["verteilbar_kw"]
    assert a["ungenutzt_kw"] > 0


@pytest.mark.parametrize("fall", DATA["uebergangsstand"], ids=lambda f: f["name"])
def test_jeder_uebergangsstand_gilt_in_der_python_referenz(fall):
    _pruefe_quelle(fall)
    u = uebergangsstand(fall["alt"]["anteile"], fall["neu"]["anteile"])
    e = fall["erwartet"]
    assert _gleich(u["uebergang"], e["uebergang"])
    assert u["verengte_boxen"] == e["verengte_boxen"]
    assert u["zweiter_schritt"] == e["zweiter_schritt"]
    for stand, feld in (("alt", "summe_alt_kw"), ("neu", "summe_neu_kw")):
        summe = sum((Decimal(str(v)) for v in fall[stand]["anteile"].values()), Decimal(0))
        assert _gleich(summe, e[feld])
        assert summe <= Decimal(str(fall[stand]["verteilbar_kw"]))
    summe_u = sum(u["uebergang"].values(), Decimal(0))
    assert _gleich(summe_u, e["summe_uebergang_kw"])
    # der Uebergang passt unter BEIDE Staende
    assert summe_u <= min(Decimal(str(fall["alt"]["verteilbar_kw"])), Decimal(str(fall["neu"]["verteilbar_kw"])))


@pytest.mark.parametrize("fall", DATA["dokument_pruefen"], ids=lambda f: f["name"])
def test_jede_dokument_pruefung_gilt_in_der_python_referenz(fall):
    urteil, grund = dokument_pruefen(fall["identitaet"], fall["stand"], fall["dokument"])
    assert urteil in DOKUMENT_URTEILE and (grund is None or grund in DOKUMENT_ABLEHNUNGEN)
    assert (urteil, grund) == (fall["erwartet"]["urteil"], fall["erwartet"]["grund"])
