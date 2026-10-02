"""MiSpeL MP-25: Rechenwerk der Pauschaloption — reine Rechnung, ohne Uhr, Datenbank oder Schreibweg.

Die Formeln (P1)–(P22)R der Formelsätze P1, P2, P3, P4, P4-Variante und P5 aus Anlage 2 der Festlegung
zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az. 618-25-02, Beschluss vom 01.10.2026)
für Optimierer-Jahreszustand (MP-26) und Haushalts-Check (MP-29). Nummern, Begriffe und Rechenwege
wörtlich wie im Vertrag ``docs/contracts/v2/mispel-pauschal.md``; Zitierweise „A2 S. 30“ = Anlage 2,
Seite 30. Zwilling des Java-Rechenwerks ``MispelPauschalRechenwerk`` (MP-25): beide rechnen
``mispel-pauschal-vectors.json`` exakt nach, Stufe für Stufe gleich (Viertelstunde → ∑J → (Rumpf-)Jahr).

Erst ab der EU-Genehmigung anwendbar (T S. 3, Tenorziffer 9 b; A2 S. 20): bis dahin ist dieses
Rechenwerk Vorbau (E7 = B), kein Kunde wird danach abgerechnet.

Regeln des Vertrags, die Anlage 2 offenlässt:

- **vergleich** — gerechnet wird ungerundet, mit exakten Brüchen (``Fraction``).
- **zeit** — eine Viertelstunde gehört zu dem Kalendertag und Kalenderjahr, an dem sie nach gesetzlicher
  Zeit (Europe/Berlin) beginnt; ``beginn`` trägt immer den Versatz zur UTC.
- **kalenderjahr** — Bezugszeitraum ist das Kalenderjahr oder ein Rumpfjahr an seiner Stelle; kein
  Monatsbezug, kein Übertrag zwischen Jahren (A2 S. 9–10; T S. 63).
- **rumpfjahre** — ganze Kalendertage, ``von`` und ``bis`` einschließlich, der Änderungstag zählt zum
  Rumpfjahr davor (A2 S. 53, TR); (P1)R ersetzt (P1) in (P15)/(P15a)/(P15b), (P4)R ersetzt (P4) in (P8).
- **ungefoerdert** — für eine ungeförderte Solaranlage entfällt ihr AW-Eingang, ihre (P12…)¼ ist 1
  (A2 S. 40, S. 50).
- **abwandlungen** — P4, P4-Variante und P5 stellt Anlage 2 in Abwandlung zum Basisfall P1 dar; mit
  Ladepunkt gelten sie in Abwandlung zu P2 oder P3 mit deren Rechengröße (A2 S. 34, S. 43, S. 49). Der
  ``basisfall`` wählt sie (Vorgabe P1); in Abwandlung zu P2 entfällt SKinst (A2 S. 27).

Die Rechnung summiert genau die übergebenen Viertelstunden. Ob ein Jahr vollständig ist, entscheidet der
Aufrufer: eine fehlende Viertelstunde ist eine Lücke, nie eine Null (Vertrag, Regel
``viertelstunden_ohne_fluss``; Stand „vorläufig“ ist der Jahreslauf ``MispelPauschalService``).
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from typing import Iterable, Mapping
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")
VIERTELSTUNDE = timedelta(minutes=15)
NULL = Fraction(0)
EINS = Fraction(1)

FORMELSAETZE = ("P1", "P2", "P3", "P4", "P4-Variante", "P5")

# Eingänge je Viertelstunde und Stammdaten je Formelsatz (Vertrag, Tabelle „Umfang“).
EINGAENGE = {
    "P1": ("Z1NB¼", "Z1NE¼", "AW¼", "SP¼"),
    "P2": ("Z1NB¼", "Z1NE¼", "AW¼", "SP¼"),
    "P3": ("Z1NB¼", "Z1NE¼", "AW¼", "SP¼"),
    "P4": ("Z1NB¼", "Z1NE¼", "AWa¼", "AWb¼", "SP¼"),
    "P4-Variante": ("Z1NB¼", "Z1NE¼", "AWa¼", "AWb¼", "SP¼"),
    "P5": ("Z1NB¼", "ZWNE¼", "AW¼", "SP¼"),
}
STAMMDATEN = {
    "P1": ("Pinst", "SKinst"),
    "P2": ("Pinst",),
    "P3": ("Pinst", "SKinst"),
    "P4": ("Pinst", "SKinst", "Painst", "Pbinst"),
    "P4-Variante": ("Pinst", "SKinst", "Painst", "Pbinst"),
    "P5": ("Pinst", "SKinst"),
}
# Die Netzeinspeisung, aus der (P6)¼ und (P13)¼ rechnen: in P5 am Zähler ZW (A2 S. 46).
_EINSPEISUNG = {fs: ("ZWNE¼" if fs == "P5" else "Z1NE¼") for fs in FORMELSAETZE}

# Formeln je Formelsatz und Ebene, in der Reihenfolge des Formelkatalogs der Vektor-Datei.
_QH = ("(P5)¼", "(P6)¼", "(P12)¼", "(P13)¼")
_SALDIERUNG = ("(P3)", "(P4)", "(P7)", "(P8)", "(P9)", "(P10)", "(P11)")
_FOERDERUNG = ("(P14)", "(P15)")
RUMPFJAHR = ("(P17)", "(P18)", "(P19)R", "(P1)R", "(P20)", "(P21)", "(P22)R", "(P3)R", "(P4)R")
FORMELN = {
    "P1": {"viertelstunde": _QH, "jahr": ("(P1)", "(P2)P1") + _SALDIERUNG + _FOERDERUNG},
    "P2": {"viertelstunde": _QH, "jahr": ("(P1)", "(P2)P2") + _SALDIERUNG + _FOERDERUNG},
    "P3": {"viertelstunde": _QH, "jahr": ("(P1)", "(P2)P1", "(P2)P2", "(P2)P3") + _SALDIERUNG + _FOERDERUNG},
    "P4": {
        "viertelstunde": ("(P5)¼", "(P6)¼", "(P12a)¼", "(P12b)¼", "(P13a)¼", "(P13b)¼"),
        "jahr": ("(P1)", "(P2)P1") + _SALDIERUNG
        + ("(ZFa)", "(ZFb)", "(P14a)", "(P14b)", "(P15a)", "(P15b)", "(P16a)", "(P16b)"),
    },
    "P4-Variante": {
        "viertelstunde": _QH,
        "jahr": ("(P1)", "(P2)P1") + _SALDIERUNG + _FOERDERUNG
        + ("(ZFa)", "(ZFb)", "(P16a)P4-Variante", "(P16b)P4-Variante"),
    },
    "P5": {"viertelstunde": ("(P5)¼", "(P6)¼ P5", "(P12)¼", "(P13)¼ P5"), "jahr": ("(P1)", "(P2)P1") + _SALDIERUNG
           + _FOERDERUNG},
}
for _fs in FORMELN:
    FORMELN[_fs]["rumpfjahr"] = RUMPFJAHR

# ∑J: Jahresformel → die Viertelstundengröße, über die sie summiert (Katalog ``summe.von``).
SUMMEN = {
    "P1": {"(P7)": "(P6)¼", "(P9)": "Z1NB¼", "(P14)": "(P13)¼"},
    "P4": {"(P7)": "(P6)¼", "(P9)": "Z1NB¼", "(P14a)": "(P13a)¼", "(P14b)": "(P13b)¼"},
    "P5": {"(P7)": "(P6)¼ P5", "(P9)": "Z1NB¼", "(P14)": "(P13)¼ P5"},
}
SUMMEN["P2"] = SUMMEN["P3"] = SUMMEN["P4-Variante"] = SUMMEN["P1"]

#: Die Sonderfälle, die Anlage 2 in Abwandlung zu einem Basisfall darstellt (Regel ``abwandlungen``).
ABWANDLUNGEN = ("P4", "P4-Variante", "P5")
BASISFAELLE = ("P1", "P2", "P3")
_RECHENGROESSEN = {"P1": ("(P2)P1",), "P2": ("(P2)P2",), "P3": ("(P2)P1", "(P2)P2", "(P2)P3")}

#: (P17) = ANZAHL [ TS ] = 183: April bis September (A2 S. 54).
TAGE_SOMMERPERIODE = 183
#: Pauschalgrenze der Förderfähigkeit je kW installierter Leistung (P1), A2 S. 28.
KWH_JE_KW = Fraction(500)


def _zahl(name, wert, *, nie_negativ):
    if wert is None or isinstance(wert, bool):
        raise ValueError(f"{name}: kein Wert — unbekannt ist keine Null")
    zahl = Fraction(wert)
    if nie_negativ and zahl < 0:
        raise ValueError(f"{name} = {wert}: Strommengen und Leistungen sind nie negativ (A2 S. 27)")
    return zahl


def _pruefe_formelsatz(formelsatz):
    if formelsatz not in FORMELN:
        raise ValueError(f"Formelsatz {formelsatz!r} nicht im Umfang: {', '.join(FORMELSAETZE)}")


def _aw_eingaenge(formelsatz):
    return tuple(e for e in EINGAENGE[formelsatz] if e.startswith("AW"))


def _pruefe_ungefoerdert(formelsatz, ungefoerdert):
    fremd = set(ungefoerdert) - set(_aw_eingaenge(formelsatz))
    if fremd:
        raise ValueError(f"ungefördert sind AW-Eingänge des Formelsatzes {formelsatz} "
                         f"({', '.join(_aw_eingaenge(formelsatz))}), nicht {sorted(fremd)} (A2 S. 40, S. 50)")


def _eingaenge(formelsatz, werte, ungefoerdert):
    erwartet = [e for e in EINGAENGE[formelsatz] if e not in ungefoerdert]
    fremd = set(werte) - set(erwartet)
    if fremd:
        raise ValueError(f"{formelsatz} kennt die Eingänge {sorted(fremd)} nicht (erwartet {erwartet})")
    return {e: _zahl(e, werte.get(e), nie_negativ=not (e.startswith("AW") or e == "SP¼")) for e in erwartet}


def _wenn(bedingung):
    return EINS if bedingung else NULL


def _aw(eingaenge, name):
    """(P12)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ] (A2 S. 31); ungefördert: 1 (A2 S. 40, S. 50)."""
    return EINS if name not in eingaenge else _wenn(eingaenge[name] > 0)


def basisfall_von(formelsatz, basisfall=None):
    """Der Basisfall, dessen Rechengröße gilt: P1–P3 sind es selbst, P4/P4-Variante/P5 nach Vorgabe, sonst P1."""
    _pruefe_formelsatz(formelsatz)
    if basisfall is None:
        return formelsatz if formelsatz in BASISFAELLE else "P1"
    if basisfall not in BASISFAELLE or (formelsatz not in ABWANDLUNGEN and basisfall != formelsatz):
        raise ValueError(f"Basisfall {basisfall!r}: P4, P4-Variante und P5 gelten in Abwandlung zu P1, P2 oder P3 "
                         f"(A2 S. 34, S. 43, S. 49), {formelsatz} ist selbst ein Basisfall")
    return basisfall


def stammdaten_namen(formelsatz, basisfall=None):
    """Die Stammdaten des Formelsatzes; in Abwandlung zu P2 (Ladepunkt) ohne SKinst (A2 S. 27)."""
    if basisfall_von(formelsatz, basisfall) == "P2":
        return tuple(n for n in STAMMDATEN[formelsatz] if n != "SKinst")
    return STAMMDATEN[formelsatz]


def jahresformeln(formelsatz, basisfall=None):
    """Die Jahresformeln in Katalog-Folge; in Abwandlung zu P2/P3 mit deren Rechengröße statt (P2)P1."""
    b = basisfall_von(formelsatz, basisfall)
    if formelsatz not in ABWANDLUNGEN:
        return FORMELN[formelsatz]["jahr"]
    out = []
    for nr in FORMELN[formelsatz]["jahr"]:
        out.extend(_RECHENGROESSEN[b] if nr == "(P2)P1" else (nr,))
    return tuple(out)


def stammdaten_pruefen(formelsatz, stammdaten, basisfall=None):
    """Die Stammdaten des Formelsatzes als Brüche: genau die des Vertrags, SKinst > 0, in P4 Pinst = Painst + Pbinst."""
    namen = stammdaten_namen(formelsatz, basisfall)
    s = stammdaten or {}
    fremd = set(s) - set(namen)
    if fremd:
        raise ValueError(f"{formelsatz} kennt die Stammdaten {sorted(fremd)} nicht (erwartet {namen})")
    out = {n: _zahl(n, s.get(n), nie_negativ=True) for n in namen}
    if "SKinst" in out and out["SKinst"] <= 0:
        raise ValueError("SKinst = 0: ohne Stromspeicher ist es nicht die Fallkonstellation P1 (A2 S. 27–28)")
    if "Painst" in out:
        if out["Painst"] + out["Pbinst"] == 0:
            raise ValueError("Painst + Pbinst = 0: ohne installierte Leistung kein Zuordnungs-Faktor (A2 S. 36)")
        if out["Pinst"] != out["Painst"] + out["Pbinst"]:
            raise ValueError(f"Pinst = {out['Pinst']} ist nicht Painst + Pbinst = "
                             f"{out['Painst'] + out['Pbinst']} (A2 S. 36)")
    return out


def viertelstunde(formelsatz, werte, *, ungefoerdert=()):
    """Viertelstundenwerte eines Formelsatzes aus Zählerwerten (kWh), AW¼ und SP¼ (ct/kWh) der Viertelstunde."""
    _pruefe_formelsatz(formelsatz)
    _pruefe_ungefoerdert(formelsatz, ungefoerdert)
    e = _eingaenge(formelsatz, werte, ungefoerdert)
    ne = e[_EINSPEISUNG[formelsatz]]
    p5 = _wenn(e["SP¼"] >= 0)  # (P5)¼ = WENN [ SP¼ ≥ 0 ; 1 ; 0 ] (A2 S. 30)
    if formelsatz == "P4":
        p12a, p12b = _aw(e, "AWa¼"), _aw(e, "AWb¼")
        return {"(P5)¼": p5, "(P6)¼": p5 * ne, "(P12a)¼": p12a, "(P12b)¼": p12b,
                "(P13a)¼": p12a * ne, "(P13b)¼": p12b * ne}
    if formelsatz == "P4-Variante":
        p12a, p12b = _aw(e, "AWa¼"), _aw(e, "AWb¼")
        if p12a != p12b:
            raise ValueError(f"beginn = {werte.get('beginn', '?')}: die P4-Variante verlangt jederzeit "
                             "übereinstimmende AW>0-Zeiten der Solaranlagen a und b (A2 S. 41)")
        p12 = p12a
    else:
        p12 = _aw(e, "AW¼")
    if formelsatz == "P5":
        return {"(P5)¼": p5, "(P6)¼ P5": p5 * ne, "(P12)¼": p12, "(P13)¼ P5": p12 * ne}
    return {"(P5)¼": p5, "(P6)¼": p5 * ne, "(P12)¼": p12, "(P13)¼": p12 * ne}


def _rechengroesse(basisfall, s):
    """(P2)P1 = 0,1 kWh/kW • Pinst / SKinst; (P2)P2 = 0,2; (P2)P3 = MIN [ (P2)P1 ; (P2)P2 ] (A2 S. 28–29)."""
    p2p1 = Fraction(1, 10) * s["Pinst"] / s["SKinst"] if "SKinst" in s else None
    p2p2 = Fraction(1, 5)
    if basisfall == "P2":
        return {"(P2)P2": p2p2}, p2p2
    if basisfall == "P3":
        p2p3 = min(p2p1, p2p2)
        return {"(P2)P1": p2p1, "(P2)P2": p2p2, "(P2)P3": p2p3}, p2p3
    return {"(P2)P1": p2p1}, p2p1


def sommertage(von: date, bis: date) -> int:
    """ANZAHL [ TRS ]: die Tage von ``von`` bis ``bis`` (einschließlich) in April bis September (A2 S. 53–54)."""
    n = 0
    for monat_ in range(4, 10):
        anfang = max(von, date(von.year, monat_, 1))
        ende = min(bis, date(von.year, monat_, calendar.monthrange(von.year, monat_)[1]))
        n += max((ende - anfang).days + 1, 0)
    return n


@dataclass(frozen=True)
class Rumpfjahr:
    """Ein Rumpfjahr (A2 S. 51–53, Abschn. 9): ganze Kalendertage ``von`` bis ``bis`` einschließlich in einem
    Kalenderjahr, mit seinen Stammdaten; der Schlüssel ist ``von/bis``."""

    von: date
    bis: date
    stammdaten: Mapping = field(default_factory=dict)

    @property
    def schluessel(self):
        return f"{self.von.isoformat()}/{self.bis.isoformat()}"


def jahr(formelsatz, summen_, stammdaten, rumpfjahr: Rumpfjahr | None = None, *, basisfall=None):
    """Die Jahreswerte aus den ∑J-Summen und den Stammdaten; im Rumpfjahr dazu (P17)–(P4)R (A2 S. 54–55)."""
    s = stammdaten_pruefen(formelsatz, stammdaten, basisfall)
    w = {"(P1)": s["Pinst"] * KWH_JE_KW}  # (P1) = Pinst • 500 kWh/kW (A2 S. 28)
    groessen, p2 = _rechengroesse(basisfall_von(formelsatz, basisfall), s)
    w.update(groessen)
    w["(P3)"] = p2 * w["(P1)"]  # (P3) = (P2) • (P1) (A2 S. 30)
    w["(P4)"] = w["(P1)"] + w["(P3)"]  # (P4) = (P1) + (P3)
    foerdergrenze, saldogrenze = w["(P1)"], w["(P4)"]
    r = {}
    if rumpfjahr is not None:
        tage_jahr = 366 if calendar.isleap(rumpfjahr.von.year) else 365
        r["(P17)"] = Fraction(TAGE_SOMMERPERIODE)
        r["(P18)"] = w["(P1)"] / r["(P17)"]
        r["(P19)R"] = Fraction(sommertage(rumpfjahr.von, rumpfjahr.bis))
        r["(P1)R"] = r["(P19)R"] * r["(P18)"]
        r["(P20)"] = Fraction(tage_jahr)
        r["(P21)"] = w["(P3)"] / r["(P20)"]
        r["(P22)R"] = Fraction((rumpfjahr.bis - rumpfjahr.von).days + 1)
        r["(P3)R"] = r["(P22)R"] * r["(P21)"]
        r["(P4)R"] = r["(P1)R"] + r["(P3)R"]
        foerdergrenze, saldogrenze = r["(P1)R"], r["(P4)R"]
    w.update({k: summen_[k] for k in ("(P7)", "(P9)")})
    w["(P8)"] = max(w["(P7)"] - saldogrenze, NULL)  # (P8) = MAX [ (P7) – (P4) ; 0 ] (A2 S. 30)
    w["(P10)"] = min(w["(P8)"], w["(P9)"])  # (P10) = MIN [ (P8) ; (P9) ] (A2 S. 31)
    w["(P11)"] = w["(P9)"] - w["(P10)"]  # (P11) = (P9) – (P10)
    if formelsatz == "P4":
        pa, pb = s["Painst"], s["Pbinst"]
        w["(ZFa)"], w["(ZFb)"] = pa / (pa + pb), pb / (pa + pb)  # A2 S. 36
        for x in "ab":
            w[f"(P14{x})"] = summen_[f"(P14{x})"]
            w[f"(P15{x})"] = min(w[f"(P14{x})"], foerdergrenze)  # A2 S. 37–38
            w[f"(P16{x})"] = w[f"(ZF{x})"] * w[f"(P15{x})"]
    else:
        w["(P14)"] = summen_["(P14)"]
        w["(P15)"] = min(w["(P14)"], foerdergrenze)  # (P15) = MIN [ (P14) ; (P1) ] (A2 S. 32)
        if formelsatz == "P4-Variante":
            pa, pb = s["Painst"], s["Pbinst"]
            w["(ZFa)"], w["(ZFb)"] = pa / (pa + pb), pb / (pa + pb)
            w["(P16a)P4-Variante"] = w["(ZFa)"] * w["(P15)"]  # A2 S. 41
            w["(P16b)P4-Variante"] = w["(ZFb)"] * w["(P15)"]
    out = {nr: w[nr] for nr in jahresformeln(formelsatz, basisfall)}
    out.update({nr: r[nr] for nr in RUMPFJAHR if rumpfjahr is not None})
    return out


@dataclass
class Ergebnis:
    """Viertelstundenwerte und Jahreswerte je Kalenderjahr (Schlüssel ``2027``) bzw. Rumpfjahr (``von/bis``)."""

    formelsatz: str
    viertelstunden: list
    jahre: dict


def _zeitpunkt(name, wert):
    t = datetime.fromisoformat(wert) if isinstance(wert, str) else wert
    if t.tzinfo is None or t.utcoffset() is None:
        raise ValueError(f"{name} = {wert}: ohne Versatz zur UTC ist der Kalendertag nicht bestimmbar")
    return t


def _tag(name, wert):
    return date.fromisoformat(wert) if isinstance(wert, str) else wert


def rumpfjahre_pruefen(rumpfjahre):
    """Rumpfjahre geordnet; jedes in einem Kalenderjahr, ``von`` ≤ ``bis``, keine Überlappung."""
    liste = []
    for r in rumpfjahre:
        von, bis = _tag("von", r.von), _tag("bis", r.bis)
        if not (von <= bis and von.year == bis.year):
            raise ValueError(f"Rumpfjahr {von}/{bis}: ganze Tage von ≤ bis in einem Kalenderjahr (A2 S. 53)")
        liste.append(Rumpfjahr(von, bis, r.stammdaten))
    liste.sort(key=lambda r: r.von)
    for a, b in zip(liste, liste[1:]):
        if b.von <= a.bis:
            raise ValueError(f"Rumpfjahre {a.schluessel} und {b.schluessel} überlappen")
    return liste


def rechne(formelsatz, viertelstunden: Iterable[Mapping], *, stammdaten=None, rumpfjahre=None, ungefoerdert=(),
           basisfall=None):
    """Rechnet einen Formelsatz über Viertelstunden: jede trägt ``beginn`` (mit Versatz zur UTC) und die Eingänge.

    Ohne ``rumpfjahre`` gilt das Kalenderjahr nach gesetzlicher Zeit mit ``stammdaten`` für alle Jahre; mit
    ``rumpfjahre`` (:class:`Rumpfjahr`) muss jede Viertelstunde an einem Tag genau eines Rumpfjahres beginnen, und
    jedes bringt seine Stammdaten mit. Jahre sind genau die (Rumpf-)Jahre mit mindestens einer Viertelstunde.
    ``basisfall`` wählt für P4, P4-Variante und P5 die Rechengröße (Regel ``abwandlungen``, Vorgabe P1)."""
    basisfall_von(formelsatz, basisfall)
    _pruefe_ungefoerdert(formelsatz, ungefoerdert)
    raeume = None if rumpfjahre is None else rumpfjahre_pruefen(rumpfjahre)
    if raeume is not None and stammdaten is not None:
        raise ValueError("Stammdaten entweder je Rumpfjahr oder für alle Jahre, nicht beides")
    if raeume is None:
        stammdaten_pruefen(formelsatz, stammdaten, basisfall)
    summen_je, rumpf_von = {}, {}
    ergebnis_qh, vorher = [], None
    for roh in viertelstunden:
        beginn = _zeitpunkt("beginn", roh.get("beginn"))
        if (beginn - datetime(2000, 1, 1, tzinfo=timezone.utc)) % VIERTELSTUNDE:
            raise ValueError(f"beginn = {roh['beginn']}: nicht auf dem Viertelstundenraster")
        if vorher is not None and beginn <= vorher:
            raise ValueError(f"beginn = {roh['beginn']}: Viertelstunden streng aufsteigend, ohne Doppel")
        vorher = beginn
        tag = beginn.astimezone(BERLIN).date()
        if raeume is None:
            schluessel, rumpf = str(tag.year), None
        else:
            treffer = [r for r in raeume if r.von <= tag <= r.bis]
            if not treffer:
                raise ValueError(f"beginn = {roh['beginn']}: liegt in keinem Rumpfjahr")
            rumpf = treffer[0]
            schluessel = rumpf.schluessel
        werte = {k: v for k, v in roh.items() if k != "beginn"}
        qh = viertelstunde(formelsatz, werte, ungefoerdert=ungefoerdert)
        alles = {**_eingaenge(formelsatz, werte, ungefoerdert), **qh}
        s = summen_je.setdefault(schluessel, {nr: NULL for nr in SUMMEN[formelsatz]})
        for nr, von in SUMMEN[formelsatz].items():
            s[nr] += alles[von]
        rumpf_von[schluessel] = rumpf
        ergebnis_qh.append({"beginn": beginn, **qh})
    jahre = {
        k: jahr(formelsatz, s, rumpf_von[k].stammdaten if rumpf_von[k] else stammdaten, rumpf_von[k],
                basisfall=basisfall)
        for k, s in summen_je.items()
    }
    return Ergebnis(formelsatz=formelsatz, viertelstunden=ergebnis_qh, jahre=jahre)
