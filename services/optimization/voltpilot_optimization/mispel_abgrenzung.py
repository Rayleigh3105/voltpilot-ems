"""MiSpeL MP-9: Rechenwerk der Abgrenzungsoption — reine Rechnung, ohne Uhr, Datenbank oder Schreibweg.

Die Formeln (1)–(33) der Formelsätze A1, A5, A5-Variante, A10 und A11 aus Anlage 1 der Festlegung
zur Marktintegration von Speichern und Ladepunkten (BNetzA, Az. 618-25-02, Beschluss vom 01.10.2026)
für Optimierer (MP-10, MP-11) und Simulation (MP-13). Nummern, Begriffe und Rechenwege wörtlich wie
im Vertrag ``docs/contracts/v2/mispel-abgrenzung.md``; Zitierweise „A1 S. 35“ = Anlage 1, Seite 35.
Zwilling des Java-Rechenwerks (MP-8): beide rechnen ``mispel-abgrenzung-vectors.json`` exakt nach.

Regeln des Vertrags, die Anlage 1 offenlässt:

- **vergleich** — gerechnet wird ungerundet, mit exakten Brüchen (``Fraction``); Rundung für Anzeige
  und Nachweis ist MP-16.
- **nenner_null** — ein Quotient mit Nenner 0 ist nicht bestimmbar (``None``), ein Produkt mit ihm 0.
- **zeit** — eine Viertelstunde gehört zum Kalendermonat und -jahr, in dem sie nach gesetzlicher Zeit
  (Europe/Berlin) beginnt; ``beginn`` trägt immer den Versatz zur UTC.

Die Rechnung summiert genau die übergebenen Viertelstunden. Ob ein Monat vollständig ist, entscheidet
der Aufrufer: eine fehlende Viertelstunde ist eine Lücke, nie eine Null (Vertrag, Regel
``viertelstunden_ohne_fluss``; Stand „vorläufig“ ist MP-8). Ebenso wählt der Aufrufer den Formelsatz
und gibt Rumpfmonate als vorgegebenen :class:`Zeitraum`; ihre Grenzen bestimmt :func:`rumpfmonate` (MP-21).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from fractions import Fraction
from typing import Iterable, Mapping
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")
VIERTELSTUNDE = timedelta(minutes=15)
NULL = Fraction(0)

_Z1 = ("Z1NB¼", "Z1NE¼")
_Z1_Z2 = ("Z1NB¼", "Z1NE¼", "Z2V¼", "Z2E¼")

# Eingänge je Viertelstunde und Stammdaten je Formelsatz (Vertrag, Tabelle „Umfang“).
EINGAENGE = {
    "A1": _Z1_Z2 + ("AW¼",),
    "A5": _Z1_Z2 + ("AWa¼", "AWb¼"),
    "A5-Variante": _Z1_Z2 + ("AWa¼", "AWb¼"),
    "A10": _Z1,
    "A11": _Z1,
}
STAMMDATEN = {"A1": (), "A5": ("Painst", "Pbinst"), "A5-Variante": ("Painst", "Pbinst"), "A10": (), "A11": ()}

# Formeln je Formelsatz und Ebene, in der Reihenfolge des Formelkatalogs der Vektor-Datei.
_A1_VIERTELSTUNDE = ("(1)¼", "(2)¼", "(23)¼", "(24)¼", "(25)¼", "(27)¼")
_A1_SALDIERUNG = ("(3)", "(4)", "(5)", "(6)", "(9)", "(10)", "(11)", "(12)", "(13)", "(14)A1", "(15)",
                  "(16)", "(17)A1", "(18)", "(19)A1,A4", "(20)", "(21)")
_A1_FOERDERUNG = ("(26)", "(28)", "(29)", "(30)", "(31)", "(32)")
_A5_JE_ANLAGE = {
    x: (f"(23{x})¼ A5", f"(24{x})¼", f"(25{x})¼", f"(27{x})¼") for x in "ab"
}
_A5_MONAT_JE_ANLAGE = {
    x: (f"(26{x})", f"(28{x})A5", f"(29{x})", f"(30{x})", f"(31{x})", f"(32{x})") for x in "ab"
}
FORMELN = {
    "A1": {
        "viertelstunde": _A1_VIERTELSTUNDE,
        "monat": _A1_SALDIERUNG + _A1_FOERDERUNG,
        "jahr": ("(22)", "(33)"),
    },
    "A5": {
        "viertelstunde": ("(1)¼", "(2)¼", "(23)¼") + _A5_JE_ANLAGE["a"] + _A5_JE_ANLAGE["b"],
        "monat": _A1_SALDIERUNG + ("(28)", "(ZFa)", "(ZFb)") + _A5_MONAT_JE_ANLAGE["a"] + _A5_MONAT_JE_ANLAGE["b"],
        "jahr": ("(22)", "(33a)", "(33b)"),
    },
    "A5-Variante": {
        "viertelstunde": _A1_VIERTELSTUNDE,
        "monat": _A1_SALDIERUNG + _A1_FOERDERUNG + ("(ZFa)", "(ZFb)", "(32a)A5-Variante", "(32b)A5-Variante"),
        "jahr": ("(22)", "(33)", "(33a)A5-Variante", "(33b)A5-Variante"),
    },
    "A10": {"viertelstunde": (), "monat": ("(3)", "(20)A10", "(21)A10"), "jahr": ("(22)A10",)},
    "A11": {"viertelstunde": (), "monat": ("(3)", "(4)", "(16)A11", "(20)A11", "(21)A11"), "jahr": ("(22)A11",)},
}
FORMELSAETZE = tuple(FORMELN)

# ∑M: Monatsformel → summierter Eingang bzw. Viertelstundenwert (A1 S. 34–39, S. 47–48).
_SUMME_M = {
    "(3)": "Z1NB¼", "(4)": "Z1NE¼", "(5)": "Z2V¼", "(6)": "Z2E¼", "(9)": "(1)¼", "(11)": "(2)¼",
    "(26)": "(25)¼", "(29)": "(27)¼",
    "(26a)": "(25a)¼", "(29a)": "(27a)¼", "(26b)": "(25b)¼", "(29b)": "(27b)¼",
}
SUMMEN = {s: tuple(nr for nr in f["monat"] if nr in _SUMME_M) for s, f in FORMELN.items()}
# ∑J: Jahresformel → summierter Monatswert (A1 S. 37, S. 39, S. 49, S. 53, S. 96–97, S. 101).
_SUMME_J = {
    "(22)": "(21)", "(33)": "(32)", "(33a)": "(32a)", "(33b)": "(32b)",
    "(33a)A5-Variante": "(32a)A5-Variante", "(33b)A5-Variante": "(32b)A5-Variante",
    "(22)A10": "(21)A10", "(22)A11": "(21)A11",
}


def _quotient(zaehler, nenner):
    """Regel nenner_null: ohne Regel in Anlage 1 für den Nenner 0 ist der Quotient nicht bestimmbar."""
    return None if nenner == 0 else zaehler / nenner


def _produkt(faktor, wert):
    """Regel nenner_null: ein Produkt mit einem nicht bestimmbaren Faktor ist 0."""
    return NULL if faktor is None else faktor * wert


def _aw_groesser_null(aw):
    """(24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ] (A1 S. 38)."""
    return Fraction(1) if aw > 0 else NULL


def _zahl(name, wert, *, nie_negativ):
    if wert is None or isinstance(wert, bool):
        raise ValueError(f"{name}: kein Wert — unbekannt ist keine Null")
    zahl = Fraction(wert)
    if nie_negativ and zahl < 0:
        raise ValueError(f"{name} = {wert}: Zählerwerte und Leistungen sind nie negativ (A1 S. 32)")
    return zahl


def zuordnungsfaktoren(stammdaten):
    """(ZFa) = Painst / (Painst + Pbinst), (ZFb) = Pbinst / (Painst + Pbinst) (A1 S. 46).

    Painst und Pbinst sind die installierten Leistungen in kW nach § 24 Abs. 3 S. 2 Halbsatz 2 EEG; bei
    gleichartigen Windenergieanlagen an Land der Referenz- bzw. Standortertrag (A1 S. 45)."""
    pa = _zahl("Painst", stammdaten.get("Painst"), nie_negativ=True)
    pb = _zahl("Pbinst", stammdaten.get("Pbinst"), nie_negativ=True)
    if pa + pb == 0:
        raise ValueError("Painst + Pbinst = 0: ohne installierte Leistung kein Zuordnungs-Faktor")
    return {"(ZFa)": pa / (pa + pb), "(ZFb)": pb / (pa + pb)}


def _pruefe_formelsatz(formelsatz):
    if formelsatz not in FORMELN:
        raise ValueError(f"Formelsatz {formelsatz!r} nicht im Umfang: {', '.join(FORMELSAETZE)}")


def _eingaenge(formelsatz, werte, ungefoerdert):
    erwartet = [e for e in EINGAENGE[formelsatz] if not (e[2:3] in ungefoerdert and e.startswith("AW"))]
    fremd = set(werte) - set(erwartet)
    if fremd:
        raise ValueError(f"{formelsatz} kennt die Eingänge {sorted(fremd)} nicht (erwartet {erwartet})")
    return {e: _zahl(e, werte.get(e), nie_negativ=not e.startswith("AW")) for e in erwartet}


def _pruefe_ungefoerdert(formelsatz, ungefoerdert):
    if ungefoerdert and (formelsatz != "A5" or not set(ungefoerdert) <= {"a", "b"}):
        raise ValueError(f"ungefördert gibt es nur für die Anlagen a und b in A5 (A1 S. 52), nicht {formelsatz}")
    if set(ungefoerdert) == {"a", "b"}:
        raise ValueError("A5 braucht mindestens eine marktprämien-geförderte Anlage; ohne sie gilt Abschn. 10 (A1 S. 52)")


def viertelstunde(formelsatz, werte, stammdaten=None, *, ungefoerdert=()):
    """Viertelstundenwerte eines Formelsatzes aus den Zählerwerten der Viertelstunde (kWh) und AW¼ (ct/kWh).

    ``werte`` trägt genau die Eingänge des Formelsatzes (:data:`EINGAENGE`), ohne ``beginn``. A5 braucht
    die Stammdaten des (Rumpf-)Monats. ``ungefoerdert`` nennt in A5 eine ungeförderte gleichartige Anlage
    ohne anzulegenden Wert: ihr AW-Eingang entfällt, (24b)¼ bzw. (24a)¼ ist in allen Viertelstunden 1
    (A1 S. 52)."""
    _pruefe_formelsatz(formelsatz)
    _pruefe_ungefoerdert(formelsatz, ungefoerdert)
    e = _eingaenge(formelsatz, werte, ungefoerdert)
    if not FORMELN[formelsatz]["viertelstunde"]:
        return {}
    w = {
        "(1)¼": min(e["Z1NB¼"], e["Z2V¼"]),  # A1 S. 33
        "(2)¼": min(e["Z1NE¼"], e["Z2E¼"]),  # A1 S. 34
    }
    w["(23)¼"] = e["Z1NE¼"] - w["(2)¼"]  # A1 S. 38
    if formelsatz == "A5":
        zf = zuordnungsfaktoren(stammdaten or {})
        for x in "ab":
            w[f"(23{x})¼ A5"] = zf[f"(ZF{x})"] * w["(23)¼"]  # A1 S. 46
            w[f"(24{x})¼"] = Fraction(1) if x in ungefoerdert else _aw_groesser_null(e[f"AW{x}¼"])
            w[f"(25{x})¼"] = w[f"(24{x})¼"] * w[f"(23{x})¼ A5"]
            w[f"(27{x})¼"] = w[f"(24{x})¼"] * w["(2)¼"]  # A1 S. 47
        return w
    if formelsatz == "A5-Variante":
        # A1 S. 52: nur anwendbar bei jederzeit übereinstimmenden AW>0-Zeiten; dann ist (24)¼ für a und b gleich.
        if (e["AWa¼"] > 0) != (e["AWb¼"] > 0):
            raise ValueError("A5-Variante nicht anwendbar: AW>0-Zeiten von a und b stimmen nicht überein (A1 S. 52)")
        aw = e["AWa¼"]
    else:
        aw = e["AW¼"]
    w["(24)¼"] = _aw_groesser_null(aw)  # A1 S. 38
    w["(25)¼"] = w["(24)¼"] * w["(23)¼"]
    w["(27)¼"] = w["(24)¼"] * w["(2)¼"]
    return w


def summen(formelsatz, viertelstunden):
    """∑M der Monatsformeln aus Eingängen und Viertelstundenwerten (je Viertelstunde beides in einem Mapping)."""
    _pruefe_formelsatz(formelsatz)
    s = {nr: NULL for nr in SUMMEN[formelsatz]}
    for q in viertelstunden:
        for nr in s:
            s[nr] += q[_SUMME_M[nr]]
    return s


def monat(formelsatz, monatssummen, stammdaten=None):
    """Monatswerte aus den ∑M-Werten des (Rumpf-)Monats (:data:`SUMMEN`, z. B. aus einem laufenden Monatsstand).

    Ein Rumpfmonat tritt an die Stelle des Kalendermonats (A1 S. 102)."""
    _pruefe_formelsatz(formelsatz)
    fehlt = [nr for nr in SUMMEN[formelsatz] if nr not in monatssummen]
    if fehlt:
        raise ValueError(f"{formelsatz}: Monatssummen {fehlt} fehlen")
    m = {nr: _zahl(nr, monatssummen[nr], nie_negativ=True) for nr in SUMMEN[formelsatz]}
    if formelsatz == "A10":  # A1 S. 96
        m["(20)A10"] = m["(3)"]
        m["(21)A10"] = m["(3)"] - m["(20)A10"]
        return _geordnet(formelsatz, "monat", m)
    if formelsatz == "A11":  # A1 S. 100–101
        m["(16)A11"] = m["(4)"]
        m["(20)A11"] = min(m["(16)A11"], m["(3)"])
        m["(21)A11"] = m["(3)"] - m["(20)A11"]
        return _geordnet(formelsatz, "monat", m)
    # A1 S. 34–37: Saldierung; in A5 und A5-Variante unverändert (A1 S. 45, S. 52).
    m["(10)"] = m["(5)"] - m["(9)"]
    m["(12)"] = max(m["(6)"] - m["(5)"], NULL)
    m["(13)"] = max(m["(11)"] - m["(12)"], NULL)
    m["(14)A1"] = _quotient(m["(6)"], m["(5)"])
    m["(15)"] = _produkt(m["(14)A1"], m["(10)"])
    m["(16)"] = max(m["(13)"] - m["(15)"], NULL)
    m["(17)A1"] = max(m["(5)"] - m["(6)"], NULL)
    m["(18)"] = _quotient(m["(16)"], m["(6)"])
    m["(19)A1,A4"] = _produkt(m["(18)"], m["(17)A1"])
    m["(20)"] = min(m["(16)"] + m["(19)A1,A4"], m["(3)"])
    m["(21)"] = m["(3)"] - m["(20)"]
    m["(28)"] = min(m["(13)"], m["(15)"])  # A1 S. 38–39; in A5 für die Summe der Anlagen (S. 45)
    if formelsatz == "A5":  # A1 S. 46–49
        m.update(zuordnungsfaktoren(stammdaten or {}))
        for x in "ab":
            m[f"(28{x})A5"] = m[f"(ZF{x})"] * m["(28)"]
            m[f"(30{x})"] = _quotient(m[f"(29{x})"], m["(11)"])
            m[f"(31{x})"] = _produkt(m[f"(30{x})"], m[f"(28{x})A5"])
            m[f"(32{x})"] = m[f"(26{x})"] + m[f"(31{x})"]
        return _geordnet(formelsatz, "monat", m)
    m["(30)"] = _quotient(m["(29)"], m["(11)"])  # A1 S. 39
    m["(31)"] = _produkt(m["(30)"], m["(28)"])
    m["(32)"] = m["(26)"] + m["(31)"]
    if formelsatz == "A5-Variante":  # A1 S. 53
        m.update(zuordnungsfaktoren(stammdaten or {}))
        for x in "ab":
            m[f"(32{x})A5-Variante"] = m[f"(ZF{x})"] * m["(32)"]
    return _geordnet(formelsatz, "monat", m)


def jahr(formelsatz, monate):
    """∑J über die Monatswerte der (Rumpf-)Monate eines Kalenderjahres."""
    _pruefe_formelsatz(formelsatz)
    monate = list(monate)
    return {nr: sum((mw[_SUMME_J[nr]] for mw in monate), NULL) for nr in FORMELN[formelsatz]["jahr"]}


def _geordnet(formelsatz, ebene, werte):
    return {nr: werte[nr] for nr in FORMELN[formelsatz][ebene]}


@dataclass(frozen=True)
class Zeitraum:
    """Ein Rumpfmonat (A1 S. 102, Abschn. 11): ``[von, bis)`` innerhalb eines Kalendermonats mit eigenen
    Stammdaten; ``von``/``bis`` als ``datetime`` oder ISO-Text, beide mit Versatz zur UTC. ``schluessel``
    benennt ihn im Ergebnis (in den Vektoren z. B. ``2027-05/1``)."""

    schluessel: str
    von: datetime
    bis: datetime
    stammdaten: Mapping = field(default_factory=dict)


@dataclass
class Ergebnis:
    """Viertelstundenwerte (mit ``beginn``), Monatswerte je (Rumpf-)Monat und Jahreswerte je Kalenderjahr."""

    formelsatz: str
    viertelstunden: list
    monate: dict
    jahre: dict


def _zeitpunkt(name, wert):
    t = datetime.fromisoformat(wert) if isinstance(wert, str) else wert
    if t.tzinfo is None or t.utcoffset() is None:
        raise ValueError(f"{name} = {wert}: ohne Versatz zur UTC ist der Kalendermonat nicht bestimmbar")
    return t


def _monatsbeginn_danach(t):
    lokal = t.astimezone(BERLIN)
    jahr_, monat_ = (lokal.year + 1, 1) if lokal.month == 12 else (lokal.year, lokal.month + 1)
    return datetime(jahr_, monat_, 1, tzinfo=BERLIN)


def _zeitraeume(zeitraeume):
    liste = []
    for z in zeitraeume:
        von, bis = _zeitpunkt("von", z.von), _zeitpunkt("bis", z.bis)
        if not von < bis <= _monatsbeginn_danach(von):
            raise ValueError(f"Rumpfmonat {z.schluessel}: [von, bis) muss in einem Kalendermonat liegen (A1 S. 102)")
        liste.append(Zeitraum(z.schluessel, von, bis, z.stammdaten))
    liste.sort(key=lambda z: z.von)
    if len({z.schluessel for z in liste}) != len(liste):
        raise ValueError("Rumpfmonate mit gleichem Schlüssel")
    for a, b in zip(liste, liste[1:]):
        if b.von < a.bis:
            raise ValueError(f"Rumpfmonate {a.schluessel} und {b.schluessel} überlappen")
    return liste


def rechne(formelsatz, viertelstunden: Iterable[Mapping], *, stammdaten=None, zeitraeume=None, ungefoerdert=()):
    """Rechnet einen Formelsatz über Viertelstunden: jede trägt ``beginn`` (mit Versatz zur UTC) und die Eingänge.

    Ohne ``zeitraeume`` gilt der Kalendermonat nach gesetzlicher Zeit mit ``stammdaten`` für alle Monate;
    mit ``zeitraeume`` (Rumpfmonate, :class:`Zeitraum`) muss jede Viertelstunde in genau einem liegen, und
    jeder bringt seine Stammdaten mit. Monate sind genau die (Rumpf-)Monate mit mindestens einer
    Viertelstunde; das Kalenderjahr eines Rumpfmonats ist das seines Beginns."""
    _pruefe_formelsatz(formelsatz)
    _pruefe_ungefoerdert(formelsatz, ungefoerdert)
    raeume = None if zeitraeume is None else _zeitraeume(zeitraeume)
    braucht_stammdaten = bool(STAMMDATEN[formelsatz])
    if raeume is not None and stammdaten is not None:
        raise ValueError("Stammdaten entweder je Rumpfmonat oder für alle Monate, nicht beides")
    if braucht_stammdaten and raeume is None:
        zuordnungsfaktoren(stammdaten or {})
    je_monat, jahr_von, stamm_von = {}, {}, {}
    ergebnis_qh, vorher = [], None
    for roh in viertelstunden:
        beginn = _zeitpunkt("beginn", roh.get("beginn"))
        if (beginn - datetime(2000, 1, 1, tzinfo=timezone.utc)) % VIERTELSTUNDE:
            raise ValueError(f"beginn = {roh['beginn']}: nicht auf dem Viertelstundenraster")
        if vorher is not None and beginn <= vorher:
            raise ValueError(f"beginn = {roh['beginn']}: Viertelstunden streng aufsteigend, ohne Doppel")
        vorher = beginn
        if raeume is None:
            lokal = beginn.astimezone(BERLIN)
            schluessel, jahr_schluessel, stamm = lokal.strftime("%Y-%m"), lokal.strftime("%Y"), stammdaten
        else:
            treffer = [z for z in raeume if z.von <= beginn < z.bis]
            if not treffer:
                raise ValueError(f"beginn = {roh['beginn']}: liegt in keinem Rumpfmonat")
            z = treffer[0]
            schluessel, jahr_schluessel, stamm = z.schluessel, z.von.astimezone(BERLIN).strftime("%Y"), z.stammdaten
        werte = {k: v for k, v in roh.items() if k != "beginn"}
        qh = viertelstunde(formelsatz, werte, stamm, ungefoerdert=ungefoerdert)
        je_monat.setdefault(schluessel, []).append({**_eingaenge(formelsatz, werte, ungefoerdert), **qh})
        jahr_von[schluessel], stamm_von[schluessel] = jahr_schluessel, stamm
        if FORMELN[formelsatz]["viertelstunde"]:
            ergebnis_qh.append({"beginn": beginn, **qh})
    monate = {
        s: monat(formelsatz, summen(formelsatz, qhs), stamm_von[s]) for s, qhs in je_monat.items()
    }
    jahre = {}
    for s, j in jahr_von.items():
        jahre.setdefault(j, []).append(monate[s])
    return Ergebnis(
        formelsatz=formelsatz,
        viertelstunden=ergebnis_qh,
        monate=monate,
        jahre={j: jahr(formelsatz, ms) for j, ms in jahre.items()},
    )


# --------------------------------------------------------------------------- Rumpfmonate (MP-21)

#: Anlässe nach A1 S. 102–104; die Wirkung entscheidet der Vergleich der Stände, nicht das Wort.
ANLAESSE = frozenset({
    "speicher_ladepunkt", "erzeugung", "sonstiger_verbrauch", "messkonzept", "erstmalige_zuordnung",
    "wechsel_zuordnung", "zaehlerwechsel", "netznutzer", "direktvermarkter", "personell",
})
#: Wirkungen, die einen Rumpfmonat begründen (A1 S. 102: Formelsatz/Fallkonstellation, Messkonzept, Werte).
BESTIMMUNGSRELEVANT = frozenset({"fallkonstellation", "messkonzept", "werte"})


class RumpfmonatAbgelehnt(ValueError):
    """Eine Teilung, die die Festlegung nicht zulässt; ``code`` wie im Java-Zwilling."""

    def __init__(self, code, satz):
        super().__init__(satz)
        self.code = code


@dataclass(frozen=True)
class Stand:
    """Die Anlage ab Tag ``ab`` (``date``): Fallkonstellation (``formelsatz`` ``None`` = keine Bestimmung nach
    Anlage 1, ``basisfall``), Messkonzept ``zaehler`` (Z1/Z2/Z3 → Messstelle) und ``werte`` zur Bestimmung
    (Painst, Pbinst, AW-Regel … als exakter Text)."""

    ab: date
    anlass: str | None = None
    formelsatz: str | None = None
    basisfall: str | None = None
    zaehler: Mapping = field(default_factory=dict)
    werte: Mapping = field(default_factory=dict)


@dataclass(frozen=True)
class Rumpfmonat:
    schluessel: str
    von: date
    bis: date
    rumpf: bool
    stand: Stand


def _wirkung(vorher, nachher):
    w = []
    if (vorher.formelsatz, vorher.basisfall) != (nachher.formelsatz, nachher.basisfall):
        w.append("fallkonstellation")
    if set(vorher.zaehler) != set(nachher.zaehler):
        w.append("messkonzept")
    elif dict(vorher.zaehler) != dict(nachher.zaehler):
        w.append("zaehlerwechsel")
    if dict(vorher.werte) != dict(nachher.werte):
        w.append("werte")
    return w


def rumpfmonate(jahr_monat, staende):
    """Teilt den Kalendermonat ``jahr_monat`` (``"JJJJ-MM"``) an bestimmungsrelevanten Änderungen (A1 S. 102–104,
    Abschn. 11); Zwilling von ``MispelRumpfmonate.teilen``. Gibt ``(rumpfmonate, aenderungen)`` zurück: die Teile
    ``[von, bis)``, die nach Anlage 1 zu bestimmen sind (Schlüssel ``JJJJ-MM`` bzw. ``JJJJ-MM/T`` ab Tag T), und
    je Änderung im Monat ``{tag, anlass, wirkung, bestimmungsrelevant}``. Am Monatsersten entsteht kein Rumpfmonat;
    ein Wechsel der Zuordnung geht nur dort (A1 S. 103, § 21b Abs. 1 S. 2 EEG)."""
    j, m = (int(x) for x in jahr_monat.split("-"))
    erster = date(j, m, 1)
    ende = date(j + 1, 1, 1) if m == 12 else date(j, m + 1, 1)
    sortiert = sorted(staende, key=lambda s: s.ab)
    for s in sortiert:
        if s.anlass is not None and s.anlass not in ANLAESSE:
            raise RumpfmonatAbgelehnt("vorgaben_ungueltig", f"Anlass {s.anlass!r} ist keiner aus A1 S. 102–104")
    for a, b in zip(sortiert, sortiert[1:]):
        if a.ab == b.ab:
            raise RumpfmonatAbgelehnt("vorgaben_ungueltig", f"zwei Stände ab {b.ab}")
    leer = Stand(ab=erster)
    aktuell = None
    im_monat = []
    for s in sortiert:
        if s.ab <= erster:
            aktuell = s
        elif s.ab < ende:
            im_monat.append(s)
    aenderungen, grenzen, teile = [], [erster], [aktuell]
    for s in im_monat:
        if s.anlass == "wechsel_zuordnung":
            raise RumpfmonatAbgelehnt(
                "wechsel_nur_zum_monatsersten",
                f"Wechsel der Zuordnung nur zum ersten Kalendertag (A1 S. 103), nicht am {s.ab}",
            )
        wirkung = _wirkung(aktuell or leer, s)
        relevant = any(w in BESTIMMUNGSRELEVANT for w in wirkung)
        aenderungen.append({"tag": s.ab, "anlass": s.anlass, "wirkung": wirkung, "bestimmungsrelevant": relevant})
        if relevant:
            grenzen.append(s.ab)
            teile.append(s)
        else:
            teile[-1] = s
        aktuell = s
    grenzen.append(ende)
    geteilt = len(teile) > 1
    out = []
    for i, s in enumerate(teile):
        if s is None or s.formelsatz is None:
            continue
        von = grenzen[i]
        schluessel = f"{jahr_monat}/{von.day}" if geteilt else jahr_monat
        out.append(Rumpfmonat(schluessel, von, grenzen[i + 1], geteilt, s))
    return out, aenderungen
