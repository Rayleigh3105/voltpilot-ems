"""Die Verbrauchsbildung (UEMS AP-08): aus Rohwerten einer Messreihe wird die Menge einer Periode.

**Die Regel steht nicht hier, sie steht in der Vektor-Datei.** Die eine Wahrheit ist
``docs/contracts/v2/verbrauch-vectors.json`` mit 23 handgerechneten Referenzfällen des
Referenzunternehmens Ahrenberg; die Prosa dazu ist ``docs/contracts/v2/verbrauch.md``.
Dieses Modul ist die PYTHON-Hälfte des Zwillingspaares, das gegen genau diese Datei
gefahren wird (``tests/test_verbrauch.py``); die Java-Hälfte ist
``services/api/src/main/java/com/voltpilot/api/uems/VerbrauchRegeln.java`` mit
``VerbrauchVectorsTest``. Wer die Regel ändert, ändert die Vektor-Datei UND beide Seiten.

Warum überhaupt zwei Umsetzungen: der Optimierer rechnet Verbrauch in Python, die
Cloud-Schnittstelle in Java. Zwei Umsetzungen derselben Rechenregel driften auseinander,
sobald sie nicht beide gegen dieselbe Datei geprüft werden — dasselbe Muster wie beim
sturen Speicher (:mod:`voltpilot_optimization.stur` ⟷ ``repo/StandardSpeicher.java``).

Drei Wertarten (AP-07 E12), je eine Rechenregel:

* ``zaehlerstand`` — Menge = Stand am Periodenende − Stand am Periodenanfang, über
  gemessene Strecken; Gerätegrenze, Rücksetzung, Überlauf und Neustart unterbrechen die
  Differenzbildung, statt einen fiktiven Verbrauch zu erzeugen (Z1–Z9).
* ``intervallmenge`` — Summe der guten Intervallmengen, deren Ende in ``(von, bis]`` liegt;
  jede fehlende Intervallmenge ist verlorene Menge, nie nur verlorene Zeit (I1–I5).
* ``momentanwert`` — Mittel/Min/Max über die guten Werte in ``[von, bis)``; Energie daraus
  nur gekennzeichnet, mit Rechteck-Halten über höchstens zwei Kadenzen (M1–M6).

Die harte Hausregel der Zahlen-Ehrlichkeit gilt hier wörtlich: eine Lücke ist nie eine
Null, ein nicht gemessener Rand ist nie ein gemessener, und wo keine Menge bildbar ist,
steht ``None`` — nie ``0``.

Das Modul ist rein: keine Uhr, keine Datenbank, kein Netz. Es liest die Vektor-Datei
nicht selbst; die Aufrufer (heute nur der Test) reichen die Reihe als Wörterbuch herein.
Noch ruft kein Produktionsweg an — der Verdichtungs-Job bekommt die Regel mit AP-08 IP-2.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, Sequence
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------- Regeln

#: Ein Loch ÜBER zwei Kadenzen ist eine Lücke (Z2). Strikt größer - genau zwei Kadenzen
#: sind noch keine Lücke, gleiche Schwelle wie ``ZustandAbleitung.LUECKE_FAKTOR``.
LUECKE_FAKTOR = 2

#: Rechteck-Halten bei der Integration: ein Momentanwert gilt höchstens so viele Kadenzen
#: lang weiter (M4).
HALTEN_FAKTOR = 2

#: Auf so viele Nachkommastellen wird verglichen; gerechnet wird ungerundet (§4.7 Nr. 12).
NACHKOMMASTELLEN = 3

#: Die Zeitzone, in der die Kennzeichen ihre Uhrzeiten nennen.
ANZEIGE_ZEITZONE = "Europe/Berlin"

VOLLSTAENDIG = "vollständig"
UNVOLLSTAENDIG = "unvollständig"
KEINE_WERTE = "keine Werte"

# Die Kennzeichen, die die Zusammensetzung aus Teilperioden (P7, §4.5) wiedererkennen muss - an
# EINER Stelle, damit Erzeugen und Wiedererkennen nicht auseinanderlaufen.
ANFANG_NICHT_GEMESSEN = "Anfang nicht gemessen (kein Stand an der Periodengrenze)"
ENDE_NICHT_GEMESSEN = "Ende nicht gemessen (kein Stand an der Periodengrenze)"
NUR_EIN_STAND = "nur ein Stand in der Periode — keine Menge bildbar"
ZUWACHS_NICHT_MESSBAR = "Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)"
RUECKSETZUNG = "Rücksetzung "
NEUSTART = "Neustart "

_D = Decimal


@dataclass(frozen=True)
class Rohwert:
    """Ein Rohwert der Reihe: Messzeit (UTC), Wert, Güte."""

    zeit: datetime
    wert: Decimal
    guete: str = "good"

    @property
    def gut(self) -> bool:
        return self.guete == "good"


# ------------------------------------------------------------------- Hilfen (Zeit/Zahl)


def _zeit(s: str) -> datetime:
    """ISO-8601 mit Offset → UTC. Gerechnet wird immer in UTC (P1)."""
    return datetime.fromisoformat(s).astimezone(timezone.utc)


def _uhr(t: datetime, zone: str = ANZEIGE_ZEITZONE) -> str:
    """``HH:MM`` in der Anzeige-Zeitzone — so nennen die Kennzeichen ihre Zeitpunkte."""
    return t.astimezone(ZoneInfo(zone)).strftime("%H:%M")


def _runde(x: Decimal, stellen: int = NACHKOMMASTELLEN) -> Decimal:
    return _D(x).quantize(_D(1).scaleb(-stellen), rounding=ROUND_HALF_UP)


def _dez(x) -> Decimal:
    """Jede Zahl über ihre Textform - so erbt die Rechnung keine Binärbruch-Fehler."""
    return _D(str(x))


# ------------------------------------------------------------------------- Rohwerte


def rohwerte(reihe: dict) -> list[Rohwert]:
    """Die Rohwerte einer Reihe aus ihrer Beschreibung in der Vektor-Datei.

    ``rohwerte`` ist eine Liste aus Abschnitten
    ``{von, bis, kadenz_s, stand_von, zuwachs_je_kadenz}`` (beide Grenzen inklusive) oder
    einzelnen Werten ``{t, v, q}``. ``luecken`` entfernt anschließend Werte in ``[von, bis)``
    — so beschreibt ein Fall einen Box-Ausfall, ohne die Abschnitte zu zerschneiden.
    """
    out: list[Rohwert] = []
    for a in reihe.get("rohwerte", []):
        if "t" in a:
            out.append(Rohwert(_zeit(a["t"]), _dez(a["v"]), a.get("q", "good")))
            continue
        von, bis = _zeit(a["von"]), _zeit(a["bis"])
        schritt = timedelta(seconds=a["kadenz_s"])
        stand, zuwachs = _dez(a["stand_von"]), _dez(a.get("zuwachs_je_kadenz", 0))
        t, i = von, 0
        while t <= bis:
            out.append(Rohwert(t, stand + zuwachs * i, a.get("q", "good")))
            t += schritt
            i += 1
    for luecke in reihe.get("luecken", []):
        von, bis = _zeit(luecke["von"]), _zeit(luecke["bis"])
        out = [r for r in out if not (von <= r.zeit < bis)]
    out.sort(key=lambda r: r.zeit)
    return out


def periodenstand(werte: Sequence[Rohwert], t: datetime, kadenz: timedelta) -> Rohwert | None:
    """Z1 — Stand(t) ist der LETZTE gute Rohwert mit Messzeit in ``(t − Kadenz, t]``.

    Kein Wert in diesem Fenster heißt: an dieser Periodengrenze wurde nicht gemessen. Der
    Stand wird dann NICHT aus einem älteren Wert fortgeschrieben (das wäre eine erfundene
    Zahl); die Periode wird unvollständig.
    """
    treffer = None
    for r in werte:
        if not r.gut:
            continue
        if t - kadenz < r.zeit <= t:
            treffer = r
        elif r.zeit > t:
            break
    return treffer


def _gute_in(werte: Sequence[Rohwert], von: datetime, bis: datetime) -> list[Rohwert]:
    """Gute Werte in ``[von, bis)`` — das Fenster der Abdeckung (Z9) und der Momentanwerte."""
    return [r for r in werte if r.gut and von <= r.zeit < bis]


def _loecher(werte: Sequence[Rohwert], kadenz: timedelta, von: datetime, bis: datetime) -> list[dict]:
    """Löcher ÜBER ``LUECKE_FAKTOR × Kadenz`` zwischen guten Werten, geschnitten auf ``[von, bis)``."""
    gut = [r for r in werte if r.gut]
    out = []
    for vorher, nachher in zip(gut, gut[1:]):
        if nachher.zeit - vorher.zeit > LUECKE_FAKTOR * kadenz:
            lo, hi = max(vorher.zeit, von), min(nachher.zeit, bis)
            if lo < hi:
                out.append({"von": vorher.zeit, "bis": nachher.zeit})
    return out


# --------------------------------------------------------------------- Zählerstand (Z)


def menge_zaehlerstand(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    ereignisse: Iterable[dict] = (),
    faktor: Decimal = _D(1),
    wertebereich_modul: Decimal | None = None,
    hoechstzuwachs_je_kadenz: Decimal | None = None,
) -> dict:
    """Z1–Z9 — die Menge einer Periode ``[von, bis)`` aus Zählerständen.

    Gerechnet wird über die Folge ``Stand(von)`` → gute Werte in der Periode →
    ``Stand(bis)``. Jede Nachbarschaft dieser Folge wird einzeln eingeordnet:

    * Gerätegrenze (``device_boundary``) in ``(vorher, nachher]``: mit Ablesestände
      ``(Endstand − vorher) + (nachher − Anfangsstand)``, ohne Ablesestände Beitrag 0 und
      die Periode ist unvollständig (Z4). Nie ``nachher − vorher``.
    * Fallender Stand mit deklariertem Wertebereich und plausiblem Zuwachs: Überlauf mit
      Beitrag ``Modul − vorher + nachher`` — lückenlos (Z6).
    * Fallender Stand sonst: Rücksetzung, Beitrag 0, Periode unvollständig (Z5).
    * Loch über ``LUECKE_FAKTOR × Kadenz``: der Zuwachs darüber ist GEMESSEN und zählt zur
      Periode, ist aber nicht auf feinere Perioden verteilbar (Z2).
    """
    stand_anfang = periodenstand(werte, von, kadenz)
    stand_ende = periodenstand(werte, bis, kadenz)
    gute = _gute_in(werte, von, bis)

    # Kadenz länger als die Periode (z. B. Monatsablesung gegen Viertelstunde, P5/E13):
    # hier ist gar kein Wert erwartbar - das ist "keine Werte", kein Fehlbestand.
    if (bis - von) < kadenz and not gute:
        return _leer(KEINE_WERTE, 0)
    if not gute and stand_ende is None:
        return _leer(KEINE_WERTE, 0)

    folge: list[Rohwert] = []
    if stand_anfang:
        folge.append(stand_anfang)
    folge += [r for r in gute if not (stand_anfang and r.zeit == stand_anfang.zeit)]
    if stand_ende and (not folge or stand_ende.zeit != folge[-1].zeit):
        folge.append(stand_ende)
    if len(folge) < 2:
        return _leer(
            UNVOLLSTAENDIG,
            len(gute),
            [NUR_EIN_STAND],
        )

    grenzen = [e for e in ereignisse if e["art"] == "device_boundary" and von < _zeit(e["t"]) <= bis]
    neustarts = [e for e in ereignisse if e["art"] == "device_restart" and von < _zeit(e["t"]) <= bis]

    kennzeichen: list[str] = []
    menge = _D(0)
    unvollstaendig = False
    if stand_anfang is None:
        unvollstaendig = True
        kennzeichen.append(ANFANG_NICHT_GEMESSEN)
    if stand_ende is None:
        unvollstaendig = True
        kennzeichen.append(ENDE_NICHT_GEMESSEN)

    for vorher, nachher in zip(folge, folge[1:]):
        beitrag, offen = _paar(
            vorher, nachher, grenzen, kadenz, faktor, wertebereich_modul, hoechstzuwachs_je_kadenz, kennzeichen
        )
        menge += beitrag
        unvollstaendig |= offen

    unvollstaendig |= _neustart_kennzeichen(neustarts, kennzeichen)

    return {
        "menge": _runde(menge * faktor),
        "zustand": UNVOLLSTAENDIG if unvollstaendig else VOLLSTAENDIG,
        "kennzeichen": kennzeichen,
        "erhalten": len(gute),
    }


def _paar(
    vorher: Rohwert,
    nachher: Rohwert,
    grenzen: Sequence[dict],
    kadenz: timedelta,
    faktor: Decimal,
    wertebereich_modul: Decimal | None,
    hoechstzuwachs_je_kadenz: Decimal | None,
    kennzeichen: list[str],
) -> tuple[Decimal, bool]:
    """Z2/Z4/Z5/Z6 — eine Nachbarschaft ``vorher → nachher`` einordnen, ihr Kennzeichen anhängen.

    Die EINE Stelle dafür: die Rohwert-Regel und die Zusammensetzung aus Teilperioden rufen
    beide hier an. Geliefert wird der Beitrag in Rohwert-Einheit (vor dem Faktor) und ob die
    Nachbarschaft die Periode unvollständig macht.
    """
    grenze = next((e for e in grenzen if vorher.zeit < _zeit(e["t"]) <= nachher.zeit), None)
    if grenze is not None:
        endstand = _dez(grenze["endstand"]) if grenze.get("endstand") is not None else None
        anfangsstand = _dez(grenze["anfangsstand"]) if grenze.get("anfangsstand") is not None else None
        alt = (endstand - vorher.wert) if endstand is not None else _D(0)
        neu = (nachher.wert - anfangsstand) if anfangsstand is not None else _D(0)
        mit = endstand is not None and anfangsstand is not None
        kennzeichen.append(
            "Gerätegrenze " + grenze["t"][11:16] + (" mit Ablesestände" if mit else " ohne Ablesestände")
        )
        if not mit:
            kennzeichen.append(ZUWACHS_NICHT_MESSBAR)
        if nachher.zeit - vorher.zeit > LUECKE_FAKTOR * kadenz:
            kennzeichen.append(
                "Lücke am Wechsel " + _uhr(vorher.zeit) + "–" + _uhr(nachher.zeit) + " (nicht aufgefüllt)"
            )
        return alt + neu, not mit

    zuwachs = nachher.wert - vorher.wert
    if zuwachs < 0:
        ueberlauf = (
            wertebereich_modul is not None
            and hoechstzuwachs_je_kadenz is not None
            and (wertebereich_modul - vorher.wert + nachher.wert)
            <= hoechstzuwachs_je_kadenz * _dez((nachher.zeit - vorher.zeit) / kadenz)
        )
        if ueberlauf:
            kennzeichen.append("Überlauf " + _uhr(nachher.zeit) + " (Wertebereich " + str(wertebereich_modul) + ")")
            return wertebereich_modul - vorher.wert + nachher.wert, False
        # Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
        # nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
        kennzeichen.append(RUECKSETZUNG + _uhr(nachher.zeit) + " ohne Endstand — bis zu 1 Kadenz nicht gezählt")
        return _D(0), True

    if nachher.zeit - vorher.zeit > LUECKE_FAKTOR * kadenz:
        kennzeichen.append(
            "Lücke "
            + _uhr(vorher.zeit)
            + "–"
            + _uhr(nachher.zeit)
            + ": Zuwachs "
            + str(_runde(zuwachs * faktor))
            + " gemessen, nicht auf Viertelstunden verteilbar"
        )
    return zuwachs, False


def _neustart_kennzeichen(neustarts: Sequence[dict], kennzeichen: list[str]) -> bool:
    """Z7 — je Neustart ein Kennzeichen, zuletzt; ``True``, wenn es einen gab."""
    for neustart in neustarts:
        kennzeichen.append(
            NEUSTART
            + neustart["t"][11:16]
            + ": bis zu "
            + str(neustart.get("verlust_s", 255))
            + " s Zählung möglicherweise verloren"
        )
    return bool(neustarts)


def _leer(zustand: str, erhalten: int, kennzeichen: list[str] | None = None) -> dict:
    return {"menge": None, "zustand": zustand, "kennzeichen": list(kennzeichen or []), "erhalten": erhalten}


# ------------------------------------------- Zählerstand aus Teilperioden (P7, §4.5)


@dataclass(frozen=True)
class Teilperiode:
    """Eine gebildete Periode, wie eine GRÖBERE sie braucht: ihr Ergebnis und ihre Stützstellen.

    Genau das trägt eine gespeicherte Viertelstunde, ein Tag, ein Monat. ``stand_anfang`` und
    ``stand_ende`` sind ``Stand(von)``/``Stand(bis)`` nach Z1 (``None`` = an dieser Grenze nicht
    gemessen), ``erster``/``letzter`` der erste und letzte gute Wert in ``[von, bis)``,
    ``ergebnis`` das Wörterbuch mit ``menge``, ``zustand``, ``erhalten``, ``erwartet``,
    ``abdeckung_prozent`` und ``kennzeichen``.
    """

    von: datetime
    bis: datetime
    stand_anfang: Rohwert | None
    stand_ende: Rohwert | None
    erster: Rohwert | None
    letzter: Rohwert | None
    ergebnis: dict


def _mit_abdeckung(out: dict, erwartet: int) -> dict:
    out["erwartet"] = erwartet
    out["abdeckung_prozent"] = int(_D(out["erhalten"]) * 100 / _D(erwartet)) if erwartet else None
    return out


def teilperiode(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    ereignisse: Iterable[dict] = (),
    faktor: Decimal = _D(1),
    wertebereich_modul: Decimal | None = None,
    hoechstzuwachs_je_kadenz: Decimal | None = None,
) -> Teilperiode:
    """Eine Periode aus Rohwerten als :class:`Teilperiode` — die Form, in der sie gespeichert wird."""
    out = menge_zaehlerstand(werte, von, bis, kadenz, ereignisse, faktor, wertebereich_modul, hoechstzuwachs_je_kadenz)
    gute = _gute_in(werte, von, bis)
    return Teilperiode(
        von,
        bis,
        periodenstand(werte, von, kadenz),
        periodenstand(werte, bis, kadenz),
        gute[0] if gute else None,
        gute[-1] if gute else None,
        _mit_abdeckung(out, int((bis - von) / kadenz)),
    )


def _stand_an_grenze(alle: Sequence[Teilperiode], t: datetime, kadenz: timedelta) -> Rohwert | None:
    """Z1 an einer Grenze ``t`` der gröberen Periode — aus den Teilperioden.

    Die Teilperiode, die dort beginnt oder endet, hat ihren Stand schon gebildet; sonst hatte an
    ``t`` keine einen Rohwert, und der Stand ist der letzte gute Wert davor, sofern er im Fenster
    ``(t − Kadenz, t]`` liegt.
    """
    for p in alle:
        if p.von == t:
            return p.stand_anfang
    for p in alle:
        if p.bis == t:
            return p.stand_ende
    kandidat = None
    for p in alle:
        if p.bis > t:
            continue
        for r in (p.letzter, p.stand_ende):
            if r is not None and r.zeit <= t and (kandidat is None or r.zeit > kandidat.zeit):
                kandidat = r
    return kandidat if kandidat is not None and kandidat.zeit > t - kadenz else None


def erwartet_aus_teilperioden(innen: Sequence[Teilperiode], von: datetime, bis: datetime, kadenz: timedelta) -> int:
    """§4.5 — Summe der Erwartungen der Teilperioden, für die Zeit ohne Teilperiode ``Länge ÷ Kadenz``."""
    bedeckt = sum((t.bis - t.von for t in innen), timedelta(0))
    frei = (bis - von) - bedeckt
    return sum(t.ergebnis["erwartet"] for t in innen) + (int(frei / kadenz) if frei > timedelta(0) else 0)


def zaehlerstand_aus_teilperioden(
    teile: Sequence[Teilperiode],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    ereignisse: Iterable[dict] = (),
    faktor: Decimal = _D(1),
    wertebereich_modul: Decimal | None = None,
    hoechstzuwachs_je_kadenz: Decimal | None = None,
) -> Teilperiode:
    """P7/§4.5 — die Menge einer GRÖBEREN Periode aus ihren Teilperioden, aus den PERIODENSTÄNDEN.

    Nie als Summe der Teilmengen: gerechnet wird ``Stand am Kettenende − Stand am Kettenanfang``,
    dazu je Teilperiode ihr BRUCH (was ihre Menge von ihrer eigenen Standdifferenz trennt —
    Gerätegrenze, Überlauf, Rücksetzung; ohne solche genau 0) und je Grenze ohne gemessenen Stand
    die Nachbarschaft ``letzter Wert davor → erster Wert danach``, eingeordnet wie jede andere.
    Randkennzeichen an INNEREN Grenzen entfallen, Neustarts kommen aus den Ereignissen der
    gröberen Periode, die Abdeckung ist Summe erhalten ÷ Summe erwartet.

    Das Ergebnis ist dasselbe wie :func:`menge_zaehlerstand` über alle Rohwerte der Periode — der
    Lockstep in ``tests/test_verbrauch.py`` hält das an jedem Zählerstand-Fall der Vektor-Datei
    fest (der Java-Zwilling: ``VerbrauchTeilperiodenTest``).
    """
    ereignisse = list(ereignisse)
    alle = sorted(teile, key=lambda t: t.von)
    innen: list[Teilperiode] = []
    bisher = von
    for t in alle:
        drin = t.von >= von and t.bis <= bis
        if t.von < bis and t.bis > von and not drin:
            raise ValueError(f"Teilperiode {t.von}–{t.bis} ragt über die Periode {von}–{bis}")
        if drin:
            if t.von < bisher:
                raise ValueError(f"Teilperioden überlappen bei {t.von}")
            innen.append(t)
            bisher = t.bis

    stand_anfang = _stand_an_grenze(alle, von, kadenz)
    stand_ende = _stand_an_grenze(alle, bis, kadenz)
    erhalten = sum(t.ergebnis["erhalten"] for t in innen)
    erwartet = erwartet_aus_teilperioden(innen, von, bis, kadenz)
    erster = next((t.erster for t in innen if t.erster is not None), None)
    letzter = next((t.letzter for t in reversed(innen) if t.letzter is not None), None)

    def ergebnis(out: dict) -> Teilperiode:
        return Teilperiode(von, bis, stand_anfang, stand_ende, erster, letzter, _mit_abdeckung(out, erwartet))

    if erster is None and ((bis - von) < kadenz or stand_ende is None):
        return ergebnis(_leer(KEINE_WERTE, 0))

    # Die Kette: Stand(von) → je Teilperiode ihre Strecke → Stand(bis). ueber[i] ist die
    # Teilperiode, deren Strecke von punkte[i] nach punkte[i+1] führt; None heißt: diese
    # Nachbarschaft liegt über einer Grenze ohne gemessenen Stand und wird hier eingeordnet.
    punkte: list[Rohwert] = []
    ueber: list[Teilperiode | None] = []

    def anhaengen(punkt: Rohwert | None, teil: Teilperiode | None) -> None:
        if punkt is None or (punkte and punkt.zeit <= punkte[-1].zeit):
            return
        if punkte:
            ueber.append(teil)
        punkte.append(punkt)

    anhaengen(stand_anfang, None)
    for t in innen:
        a = t.stand_anfang if t.stand_anfang is not None else t.erster
        e = t.stand_ende if t.stand_ende is not None else t.letzter
        a, e = (a if a is not None else e), (e if e is not None else a)
        if a is None:
            continue
        anhaengen(a, None)
        anhaengen(e, t)
    anhaengen(stand_ende, None)

    if len(punkte) < 2:
        return ergebnis(_leer(UNVOLLSTAENDIG, erhalten, [NUR_EIN_STAND]))

    grenzen = [e for e in ereignisse if e["art"] == "device_boundary" and von < _zeit(e["t"]) <= bis]
    neustarts = [e for e in ereignisse if e["art"] == "device_restart" and von < _zeit(e["t"]) <= bis]
    kennzeichen: list[str] = []
    unvollstaendig = False
    if stand_anfang is None:
        unvollstaendig = True
        kennzeichen.append(ANFANG_NICHT_GEMESSEN)
    if stand_ende is None:
        unvollstaendig = True
        kennzeichen.append(ENDE_NICHT_GEMESSEN)

    menge = (punkte[-1].wert - punkte[0].wert) * faktor
    for (vorher, nachher), t in zip(zip(punkte, punkte[1:]), ueber):
        differenz = nachher.wert - vorher.wert
        if t is None:
            beitrag, offen = _paar(
                vorher, nachher, grenzen, kadenz, faktor, wertebereich_modul, hoechstzuwachs_je_kadenz, kennzeichen
            )
            menge += (beitrag - differenz) * faktor
            unvollstaendig |= offen
            continue
        # Der BRUCH der Teilperiode — ohne Gerätegrenze, Überlauf und Rücksetzung genau 0.
        teilmenge = t.ergebnis["menge"] if t.ergebnis["menge"] is not None else _D(0)
        menge += teilmenge - _runde(differenz * faktor)
        for k in t.ergebnis["kennzeichen"]:
            if k in (ANFANG_NICHT_GEMESSEN, ENDE_NICHT_GEMESSEN, NUR_EIN_STAND) or k.startswith(NEUSTART):
                continue
            kennzeichen.append(k)
            unvollstaendig |= k == ZUWACHS_NICHT_MESSBAR or k.startswith(RUECKSETZUNG)

    unvollstaendig |= _neustart_kennzeichen(neustarts, kennzeichen)
    return ergebnis(
        {
            "menge": _runde(menge),
            "zustand": UNVOLLSTAENDIG if unvollstaendig else VOLLSTAENDIG,
            "kennzeichen": kennzeichen,
            "erhalten": erhalten,
        }
    )


# ------------------------------------------------------------------ Intervallmenge (I)


def menge_intervall(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    faktor: Decimal = _D(1),
) -> dict:
    """I1–I2 — Summe der guten Intervallmengen, deren Ende in ``(von, bis]`` liegt.

    Anders als beim Momentanwert ist hier jede fehlende Intervallmenge verlorene MENGE,
    nicht nur verlorene Zeit: schon ein fehlender Wert macht die Periode unvollständig,
    ganz ohne Loch-Kriterium.
    """
    treffer = [r for r in werte if r.gut and von < r.zeit <= bis]
    erwartet = int((bis - von) / kadenz)
    if not treffer:
        return {"menge": None, "zustand": KEINE_WERTE, "erhalten": 0, "erwartet": erwartet, "kennzeichen": []}
    summe = sum((r.wert for r in treffer), _D(0)) * faktor
    fehlend = erwartet - len(treffer)
    zustand = VOLLSTAENDIG if fehlend == 0 else UNVOLLSTAENDIG
    kennzeichen = []
    if fehlend:
        kennzeichen.append(
            f"{fehlend} von {erwartet} Intervallmengen "
            + ("fehlt" if fehlend == 1 else "fehlen")
            + " — Menge ist die Summe der gemessenen"
        )
    return {
        "menge": _runde(summe),
        "zustand": zustand,
        "erhalten": len(treffer),
        "erwartet": erwartet,
        "kennzeichen": kennzeichen,
    }


# -------------------------------------------------------------------- Momentanwert (M)


def momentanwerte(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    integrieren: bool = False,
) -> dict:
    """M1–M4 — Mittel/Min/Max über die guten Werte in ``[von, bis)``.

    Vollständig ist die Periode nur, wenn sie kein Loch über ``LUECKE_FAKTOR × Kadenz`` hat
    UND beide Ränder innerhalb einer Kadenz gemessen sind (M3). ``integrieren`` liefert
    zusätzlich die Energie aus der Leistung: Rechteck-Halten über höchstens
    ``HALTEN_FAKTOR × Kadenz`` und NUR über gemessene Zeit — nie Mittel × Periodenlänge,
    das würde die Lücke stillschweigend auffüllen (M4).
    """
    treffer = _gute_in(werte, von, bis)
    erwartet = int((bis - von) / kadenz)
    if not treffer:
        return {
            "mittel": None,
            "min": None,
            "max": None,
            "energie_kwh": None,
            "zustand": KEINE_WERTE,
            "erhalten": 0,
            "erwartet": erwartet,
            "kennzeichen": [],
        }

    rand_anfang = treffer[0].zeit - von <= kadenz
    rand_ende = bis - treffer[-1].zeit <= kadenz
    luecken = _loecher(werte, kadenz, von, bis)
    vollstaendig = not luecken and rand_anfang and rand_ende

    mittel = sum((r.wert for r in treffer), _D(0)) / len(treffer)
    kennzeichen: list[str] = []
    if not vollstaendig:
        gemessen_s = len(treffer) * int(kadenz.total_seconds())
        kennzeichen.append(
            f"gemessene Zeit {gemessen_s // 60}:{gemessen_s % 60:02d} min"
            f" von {int((bis - von).total_seconds()) // 60} min"
        )

    ergebnis = {
        "mittel": _runde(mittel, 1),
        "min": _runde(min(r.wert for r in treffer), 1),
        "max": _runde(max(r.wert for r in treffer), 1),
        "energie_kwh": None,
        "zustand": VOLLSTAENDIG if vollstaendig else UNVOLLSTAENDIG,
        "erhalten": len(treffer),
        "erwartet": erwartet,
        "kennzeichen": kennzeichen,
    }
    if integrieren:
        ergebnis["energie_kwh"] = _runde(_integriere(werte, von, bis, kadenz))
        kennzeichen.append("aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)")
    return ergebnis


def _integriere(werte: Sequence[Rohwert], von: datetime, bis: datetime, kadenz: timedelta) -> Decimal:
    """M4 — Rechteck-Halten: jeder Wert gilt bis zum nächsten guten Wert, höchstens
    ``HALTEN_FAKTOR × Kadenz``, geschnitten auf die Periode."""
    energie = _D(0)
    folge = [r for r in werte if r.gut and von - kadenz < r.zeit < bis]
    for vorher, nachher in zip(folge, folge[1:] + [None]):
        haelt_bis = (
            nachher.zeit
            if nachher is not None and nachher.zeit - vorher.zeit <= HALTEN_FAKTOR * kadenz
            else vorher.zeit + kadenz
        )
        start, ende = max(vorher.zeit, von), min(haelt_bis, bis)
        if ende > start:
            energie += vorher.wert * _dez((ende - start).total_seconds()) / _D(3600)
    return energie


# ------------------------------------------------------------------------ Der Eingang


def ergebnis(reihe: dict, von: str, bis: str, ereignisse_zusatz: Iterable[dict] = ()) -> dict:
    """Der EINE Eingang: eine Reihe, eine Periode → das Ergebnis der Vektor-Datei.

    ``reihe`` ist die Reihenbeschreibung eines Falls (``wertart``, ``kadenz_s``, ``rohwerte``,
    optional ``faktor``, ``luecken``, ``ereignisse``, ``wertebereich_modul``,
    ``hoechstzuwachs_je_kadenz``, ``integrieren``). ``ereignisse_zusatz`` sind die Ereignisse
    einer Fall-VARIANTE (etwa ein nachgetragener Ablesestand, der aus der Rücksetzung eine
    Gerätegrenze macht) — sie treten zu den Ereignissen der Reihe hinzu.

    Geliefert werden genau die Felder, die die Vektor-Datei je Erwartung nennt:
    ``menge`` beziehungsweise ``mittel``/``min``/``max``/``energie_kwh``, dazu ``zustand``,
    ``erhalten``, ``erwartet``, ``abdeckung_prozent``, ``kennzeichen`` und ``stunden``.
    """
    werte = rohwerte(reihe)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    a, b = _zeit(von), _zeit(bis)
    faktor = _dez(reihe.get("faktor", 1))
    wertart = reihe["wertart"]

    if wertart == "zaehlerstand":
        ereignisse = list(reihe.get("ereignisse", [])) + list(ereignisse_zusatz)
        out = menge_zaehlerstand(
            werte,
            a,
            b,
            kadenz,
            ereignisse,
            faktor,
            _dez(reihe["wertebereich_modul"]) if reihe.get("wertebereich_modul") else None,
            _dez(reihe["hoechstzuwachs_je_kadenz"]) if reihe.get("hoechstzuwachs_je_kadenz") else None,
        )
        out["erwartet"] = int((b - a) / kadenz)
    elif wertart == "intervallmenge":
        out = menge_intervall(werte, a, b, kadenz, faktor)
    elif wertart == "momentanwert":
        out = momentanwerte(werte, a, b, kadenz, reihe.get("integrieren", False))
    else:
        raise ValueError(f"unbekannte Wertart {wertart!r} — bekannt sind zaehlerstand, intervallmenge, momentanwert")

    # Z9: Abdeckung des VERLAUFS - sie sagt, wie viele Werte ankamen, nicht ob die Menge
    # stimmt. Ein vollständiger Tag darf 85 % Abdeckung haben (F8).
    out["abdeckung_prozent"] = (
        int(_D(out["erhalten"]) * 100 / _D(out["erwartet"])) if out["erwartet"] else None
    )
    # P3: die Länge der Periode in Stunden - am Umstellungstag 23 oder 25, weil Tage
    # Kalenderperioden in der Zeitzone des Standorts sind.
    out["stunden"] = int((b - a).total_seconds() // 3600)
    return out
