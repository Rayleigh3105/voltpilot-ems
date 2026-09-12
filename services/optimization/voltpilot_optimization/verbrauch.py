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
            ["nur ein Stand in der Periode — keine Menge bildbar"],
        )

    grenzen = [e for e in ereignisse if e["art"] == "device_boundary" and von < _zeit(e["t"]) <= bis]
    neustarts = [e for e in ereignisse if e["art"] == "device_restart" and von < _zeit(e["t"]) <= bis]

    kennzeichen: list[str] = []
    menge = _D(0)
    unvollstaendig = False
    if stand_anfang is None:
        unvollstaendig = True
        kennzeichen.append("Anfang nicht gemessen (kein Stand an der Periodengrenze)")
    if stand_ende is None:
        unvollstaendig = True
        kennzeichen.append("Ende nicht gemessen (kein Stand an der Periodengrenze)")

    for vorher, nachher in zip(folge, folge[1:]):
        grenze = next((e for e in grenzen if vorher.zeit < _zeit(e["t"]) <= nachher.zeit), None)
        if grenze is not None:
            endstand = _dez(grenze["endstand"]) if grenze.get("endstand") is not None else None
            anfangsstand = _dez(grenze["anfangsstand"]) if grenze.get("anfangsstand") is not None else None
            alt = (endstand - vorher.wert) if endstand is not None else _D(0)
            neu = (nachher.wert - anfangsstand) if anfangsstand is not None else _D(0)
            menge += alt + neu
            mit = endstand is not None and anfangsstand is not None
            kennzeichen.append(
                "Gerätegrenze " + grenze["t"][11:16] + (" mit Ablesestände" if mit else " ohne Ablesestände")
            )
            if not mit:
                unvollstaendig = True
                kennzeichen.append("Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)")
            if nachher.zeit - vorher.zeit > LUECKE_FAKTOR * kadenz:
                kennzeichen.append(
                    "Lücke am Wechsel " + _uhr(vorher.zeit) + "–" + _uhr(nachher.zeit) + " (nicht aufgefüllt)"
                )
            continue

        zuwachs = nachher.wert - vorher.wert
        if zuwachs < 0:
            ueberlauf = (
                wertebereich_modul is not None
                and hoechstzuwachs_je_kadenz is not None
                and (wertebereich_modul - vorher.wert + nachher.wert)
                <= hoechstzuwachs_je_kadenz * _dez((nachher.zeit - vorher.zeit) / kadenz)
            )
            if ueberlauf:
                ueber = wertebereich_modul - vorher.wert + nachher.wert
                menge += ueber
                kennzeichen.append(
                    "Überlauf " + _uhr(nachher.zeit) + " (Wertebereich " + str(wertebereich_modul) + ")"
                )
            else:
                # Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
                # nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
                unvollstaendig = True
                kennzeichen.append(
                    "Rücksetzung " + _uhr(nachher.zeit) + " ohne Endstand — bis zu 1 Kadenz nicht gezählt"
                )
            continue

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
        menge += zuwachs

    for neustart in neustarts:
        unvollstaendig = True
        kennzeichen.append(
            "Neustart "
            + neustart["t"][11:16]
            + ": bis zu "
            + str(neustart.get("verlust_s", 255))
            + " s Zählung möglicherweise verloren"
        )

    return {
        "menge": _runde(menge * faktor),
        "zustand": UNVOLLSTAENDIG if unvollstaendig else VOLLSTAENDIG,
        "kennzeichen": kennzeichen,
        "erhalten": len(gute),
    }


def _leer(zustand: str, erhalten: int, kennzeichen: list[str] | None = None) -> dict:
    return {"menge": None, "zustand": zustand, "kennzeichen": list(kennzeichen or []), "erhalten": erhalten}


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
