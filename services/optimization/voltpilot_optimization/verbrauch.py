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
  nur gekennzeichnet, mit Rechteck-Halten über höchstens zwei Kadenzen (M1–M6). Ein
  Vorzeichen-Wert, den eine Bindung mit Anteil liest, wird VORHER je Rohwert geteilt
  (:func:`anteil_je_rohwert`, M5/E15, AP-08 IP-7).

Die harte Hausregel der Zahlen-Ehrlichkeit gilt hier wörtlich: eine Lücke ist nie eine
Null, ein nicht gemessener Rand ist nie ein gemessener, und wo keine Menge bildbar ist,
steht ``None`` — nie ``0``.

Das Modul ist rein: keine Uhr, keine Datenbank, kein Netz. Es liest die Vektor-Datei
nicht selbst; die Aufrufer (heute nur der Test) reichen die Reihe als Wörterbuch herein.
Seit AP-08 IP-5 gehört die Zusammensetzung aus Teilperioden dazu
(:func:`zaehlerstand_aus_teilperioden`): Tag, Monat, Jahr und freier Zeitraum aus den
Periodenständen ihrer gespeicherten Teile, nie als Summe der Teilmengen.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext
from fractions import Fraction
from typing import Iterable, Mapping, Sequence
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

#: Seit ergebnis-zustand 1.3: die Anzeige-Einheit je GESPEICHERTER Einheit und ihr fester Faktor
#: (``rundung.anzeige_einheiten``, Zwilling von ``ErgebnisZustand.ANZEIGE_EINHEITEN``). Gespeichert bleibt,
#: was der Zähler liefert; ein Kennzeichen spricht kWh · kvarh · kVAh · m³. Je Einheit
#: (Anzeige-Einheit, faktor, teiler): angezeigt wird wert × faktor ÷ teiler. Seit 1.8 Scheinarbeit als
#: kVAh (nie kWh) und Wmin mit teiler 60000 — gerundet wird der EXAKTE Quotient.
ANZEIGE_EINHEITEN = {
    "Wh": ("kWh", Decimal("0.001"), 1),
    "kWh": ("kWh", Decimal("1"), 1),
    "MWh": ("kWh", Decimal("1000"), 1),
    "Wmin": ("kWh", Decimal("1"), 60000),
    "varh": ("kvarh", Decimal("0.001"), 1),
    "kvarh": ("kvarh", Decimal("1"), 1),
    "VAh": ("kVAh", Decimal("0.001"), 1),
    "kVAh": ("kVAh", Decimal("1"), 1),
    "m³": ("m³", Decimal("1"), 1),
}

#: Eine Menge IN einem Kennzeichen hat die Stellen der Viertelstunde (``rundung.kennzeichen_ebene``):
#: kWh · kvarh · kVAh · m³ je eine Nachkommastelle — der Satz wandert unverändert bis ins Jahr.
KENNZEICHEN_STELLEN = 1

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
#: E5/M4: eine Energie aus Leistung steht NIE ohne dieses Kennzeichen. Der Wortlaut ist Vertrag;
#: ``kennzeichen`` der Vektor-Datei nennt seinen Anfang „aus Leistung integriert".
AUS_LEISTUNG_INTEGRIERT = "aus Leistung integriert (Rechteck-Halten ≤ 2 × Kadenz, nur gemessene Zeit)"

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


@dataclass(frozen=True)
class ReihenKontext:
    """Der EINE Träger je Reihe (Zwilling von ``uems.ReihenKontext``): was die Regel braucht, um von ihr zu sprechen.

    ``einheit`` ist die GESPEICHERTE Einheit der Reihe (``None`` = unbekannt, nie geraten), ``zeitzone``
    die Zone des Standorts (E10), in der jedes Kennzeichen seine Uhrzeiten nennt.
    """

    einheit: str | None
    zeitzone: str


def _uhr(t: datetime, zone: str) -> str:
    """``HH:MM`` in der Zeitzone des Standorts — so nennen die Kennzeichen ihre Zeitpunkte.

    Gibt es die Wanduhr an dem Tag zweimal (Sommerzeit-Ende), trägt sie den Zusatz des Rasters
    (E10): „02:30 MESZ“ / „02:30 MEZ“ in einer Zone mit Normalzeit UTC+01:00, sonst den Offset.
    """
    info = ZoneInfo(zone)
    ort = t.astimezone(info)
    text = ort.strftime("%H:%M")
    wand = ort.replace(tzinfo=None)
    if wand.replace(tzinfo=info, fold=0).utcoffset() == wand.replace(tzinfo=info, fold=1).utcoffset():
        return text
    offset = ort.utcoffset()
    normalzeit = datetime(ort.year, 1, 1, tzinfo=timezone.utc).astimezone(info).utcoffset()
    if normalzeit == timedelta(hours=1) and offset in (timedelta(hours=1), timedelta(hours=2)):
        return text + (" MEZ" if offset == timedelta(hours=1) else " MESZ")
    minuten = int(offset.total_seconds() // 60)
    return text + " UTC%s%02d:%02d" % ("-" if minuten < 0 else "+", abs(minuten) // 60, abs(minuten) % 60)


def _menge(wert: Decimal, einheit: str | None) -> str | None:
    """E11 für den Zuwachs IN einem Kennzeichen: „337,6 kWh“ — ``None`` ohne Anzeige-Einheit.

    Zwilling von ``ErgebnisZustand.menge(wert, einheit, KENNZEICHEN_EBENE)``: umgerechnet in die
    Anzeige-Einheit, kaufmännisch auf die Stellen der Viertelstunde, Tausenderpunkt, Komma, U+00A0.
    """
    anzeige = ANZEIGE_EINHEITEN.get(einheit) if einheit is not None else None
    if anzeige is None:
        return None
    # Exakt: der Quotient als Bruch, kaufmännisch auf die Stellen gerundet — nie ein abgeschnittener Faktor.
    zaehler = Fraction(wert * anzeige[1]) * 10**KENNZEICHEN_STELLEN
    ganz_teil, rest_teil = divmod(abs(zaehler), anzeige[2])
    gerundet_ganz = ganz_teil + (1 if rest_teil * 2 >= anzeige[2] else 0)
    gerundet = Decimal(-gerundet_ganz if zaehler < 0 else gerundet_ganz).scaleb(-KENNZEICHEN_STELLEN)
    ganz, _, rest = f"{abs(gerundet):f}".partition(".")
    gruppiert = f"{int(ganz):,}".replace(",", ".")
    return ("−" if gerundet < 0 else "") + gruppiert + ("," + rest if rest else "") + "\u00a0" + anzeige[0]


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
    kontext: ReihenKontext,
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

    * Gerätegrenze (``device_boundary``) in ``(vorher, nachher]``: mit Ableseständen
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
            kontext, vorher, nachher, grenzen, kadenz, faktor, wertebereich_modul, hoechstzuwachs_je_kadenz, kennzeichen
        )
        menge += beitrag
        unvollstaendig |= offen

    unvollstaendig |= _neustart_kennzeichen(kontext, neustarts, kennzeichen)

    return {
        "menge": _runde(menge * faktor),
        "zustand": UNVOLLSTAENDIG if unvollstaendig else VOLLSTAENDIG,
        "kennzeichen": kennzeichen,
        "erhalten": len(gute),
    }


def ueberlauf(
    vorher: Rohwert,
    nachher: Rohwert,
    kadenz: timedelta,
    wertebereich_modul: Decimal | None,
    hoechstzuwachs_je_kadenz: Decimal | None,
) -> Decimal | None:
    """Z6 (E4) — ist der fallende Stand ``vorher → nachher`` ein Überlauf?

    Die EINE Entscheidung: die Mengenregel (``_paar``) fragt hier, der Java-Zwilling
    ``VerbrauchRegeln.ueberlauf`` und die Erkennung im Writer (``UeberlaufRegel``) antworten gleich.
    Nur wenn der Stand FÄLLT, Wertebereich UND Höchstzuwachs deklariert sind und
    ``Modul − vorher + nachher ≤ Höchstzuwachs × (Zeitabstand ÷ Kadenz)`` gilt; fehlt eine Angabe,
    wird nichts geraten (``None`` — der Sprung bleibt eine Rücksetzung, Z5).
    """
    if wertebereich_modul is None or hoechstzuwachs_je_kadenz is None or nachher.wert >= vorher.wert:
        return None
    ueber = wertebereich_modul - vorher.wert + nachher.wert
    if ueber <= hoechstzuwachs_je_kadenz * _dez((nachher.zeit - vorher.zeit) / kadenz):
        return ueber
    return None


def _paar(
    kontext: ReihenKontext,
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
            "Gerätegrenze "
            + _uhr(_zeit(grenze["t"]), kontext.zeitzone)
            + (" mit Ableseständen" if mit else " ohne Ablesestände")
        )
        if not mit:
            kennzeichen.append(ZUWACHS_NICHT_MESSBAR)
        if nachher.zeit - vorher.zeit > LUECKE_FAKTOR * kadenz:
            kennzeichen.append(
                "Lücke am Wechsel "
                + _uhr(vorher.zeit, kontext.zeitzone)
                + "–"
                + _uhr(nachher.zeit, kontext.zeitzone)
                + " (nicht aufgefüllt)"
            )
        return alt + neu, not mit

    zuwachs = nachher.wert - vorher.wert
    if zuwachs < 0:
        ueber = ueberlauf(vorher, nachher, kadenz, wertebereich_modul, hoechstzuwachs_je_kadenz)
        if ueber is not None:
            kennzeichen.append(
                "Überlauf " + _uhr(nachher.zeit, kontext.zeitzone) + " (Wertebereich " + str(wertebereich_modul) + ")"
            )
            return ueber, False
        # Rücksetzung ohne Endstand: gezählt sind nur die Strecken bis vorher und ab
        # nachher - was dazwischen lag, weiß niemand und wird nicht geschätzt.
        kennzeichen.append(
            RUECKSETZUNG + _uhr(nachher.zeit, kontext.zeitzone) + " ohne Endstand — bis zu 1 Kadenz nicht gezählt"
        )
        return _D(0), True

    luecke = luecken_zuwachs(vorher, nachher, (), kadenz, faktor)
    if luecke is not None:
        kennzeichen.append(luecken_kennzeichen(luecke, kontext))
    return zuwachs, False


# ------------------------------------------------- Zuwachs über eine Lücke (Z2, E2, IP-6)

#: E2: die Kette der Kalender-Zeiträume, vom feinsten zum gröbsten, in der der KLEINSTE ganz
#: enthaltende Zeitraum gesucht wird (``regeln.luecke_zeitraeume``). Ein freier Zeitraum folgt
#: derselben Regel (:func:`zaehlt_zu`), steht aber nicht in der Kette.
LUECKE_ZEITRAEUME = ("viertelstunde", "stunde", "tag", "monat", "jahr")


@dataclass(frozen=True)
class LueckenZuwachs:
    """Z2/E2 — der Zuwachs über EINE Lücke: GEMESSEN, aber NICHT VERTEILBAR.

    ``stand_vor``/``stand_nach`` in der Einheit der Reihe (Rohwert × Faktor), ``zuwachs`` =
    ``stand_nach − stand_vor`` ungerundet. Dieselben Felder trägt das Ereignis ``data_gap``.
    """

    messzeit_vor: datetime
    messzeit_nach: datetime
    stand_vor: Decimal | None = None
    stand_nach: Decimal | None = None
    zuwachs: Decimal | None = None


def luecken_zuwachs(
    vorher: Rohwert, nachher: Rohwert, ereignisse: Iterable[dict], kadenz: timedelta, faktor: Decimal = _D(1)
) -> LueckenZuwachs | None:
    """Z2/E2 — ist die Nachbarschaft zweier guter Werte eine Lücke mit gemessenem Zuwachs?

    ``None``, wenn nicht: kein Loch ÜBER ``LUECKE_FAKTOR × Kadenz``, ein fallender Stand
    (Rücksetzung oder Überlauf) oder eine Gerätegrenze in ``(vorher, nachher]``.
    """
    if nachher.zeit - vorher.zeit <= LUECKE_FAKTOR * kadenz or nachher.wert < vorher.wert:
        return None
    if any(e["art"] == "device_boundary" and vorher.zeit < _zeit(e["t"]) <= nachher.zeit for e in ereignisse):
        return None
    vor, nach = vorher.wert * faktor, nachher.wert * faktor
    return LueckenZuwachs(vorher.zeit, nachher.zeit, vor, nach, nach - vor)


def zaehlt_zu(luecke: LueckenZuwachs, von: datetime, bis: datetime, kadenz: timedelta) -> bool:
    """E2 — DIE Stelle: der Zuwachs zählt zu ``[von, bis)`` genau dann, wenn die Periode die Lücke GANZ enthält.

    Der Wert davor ist ihr Stand am Anfang oder liegt in ihr (``messzeit_vor > von − Kadenz``,
    das Fenster von Z1), der Wert danach liegt in ihr oder ist ihr Stand am Ende
    (``messzeit_nach ≤ bis``). Eine angeschnittene Periode bekommt ihn nicht.
    """
    return luecke.messzeit_vor > von - kadenz and luecke.messzeit_nach <= bis


def luecken_zuwaechse(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    ereignisse: Iterable[dict] = (),
    faktor: Decimal = _D(1),
) -> list[LueckenZuwachs]:
    """E2 — die Lücken mit gemessenem Zuwachs, die ``[von, bis)`` zählt, in Zeitfolge.

    Eine Gerätegrenze wirkt wie in :func:`menge_zaehlerstand` nur, wenn sie in ``(von, bis]`` liegt.
    """
    grenzen = [e for e in ereignisse if e["art"] == "device_boundary" and von < _zeit(e["t"]) <= bis]
    gut = sorted((w for w in werte if w.gut), key=lambda w: w.zeit)
    out = []
    for vorher, nachher in zip(gut, gut[1:]):
        luecke = luecken_zuwachs(vorher, nachher, grenzen, kadenz, faktor)
        if luecke is not None and zaehlt_zu(luecke, von, bis, kadenz):
            out.append(luecke)
    return out


def luecken_kennzeichen(luecke: LueckenZuwachs, kontext: ReihenKontext) -> str:
    """Das Kennzeichen des gezählten Zuwachses — Vertrag nach Text („Zuwachs 337,6 kWh“).

    Uhrzeiten in der Zone des Standorts, der Zuwachs UNGERUNDET in der Anzeige-Einheit; ohne
    Anzeige-Einheit steht der Satz ohne Zahl (``luecke_zuwachs_ohne_einheit``).
    """
    zahl = _menge(luecke.zuwachs, kontext.einheit)
    return (
        "Lücke "
        + _uhr(luecke.messzeit_vor, kontext.zeitzone)
        + "–"
        + _uhr(luecke.messzeit_nach, kontext.zeitzone)
        + (": Zuwachs gemessen" if zahl is None else ": Zuwachs " + zahl + " gemessen")
        + ", nicht auf Viertelstunden verteilbar"
    )


def _zeitraum(art: str, t: datetime, zone: str) -> tuple[str, datetime, datetime]:
    if art in ("viertelstunde", "stunde"):
        schritt = 900 if art == "viertelstunde" else 3600
        beginn = int(t.timestamp()) // schritt * schritt
        return art, datetime.fromtimestamp(beginn, timezone.utc), datetime.fromtimestamp(beginn + schritt, timezone.utc)
    ort = ZoneInfo(zone)
    tag = t.astimezone(ort).date()
    if art == "tag":
        a, b = tag, tag + timedelta(days=1)
    elif art == "monat":
        a = tag.replace(day=1)
        b = a.replace(year=a.year + 1, month=1) if a.month == 12 else a.replace(month=a.month + 1)
    elif art == "jahr":
        a = tag.replace(month=1, day=1)
        b = a.replace(year=a.year + 1)
    else:
        raise ValueError(f"unbekannter Zeitraum {art!r}")

    def mitternacht(d):
        return datetime(d.year, d.month, d.day, tzinfo=ort).astimezone(timezone.utc)

    return art, mitternacht(a), mitternacht(b)


def kleinster_zeitraum(
    luecke: LueckenZuwachs, kadenz: timedelta, zone: str
) -> tuple[str, datetime, datetime] | None:
    """E2 — der KLEINSTE Zeitraum der Kette, der die Lücke ganz enthält; ``None``, wenn keiner.

    Viertelstunde und Stunde im UTC-Raster, Tag/Monat/Jahr in der Zeitzone des Standorts.
    """
    for art in LUECKE_ZEITRAEUME:
        for t in (luecke.messzeit_vor, luecke.messzeit_vor + kadenz - timedelta(microseconds=1)):
            z = _zeitraum(art, t, zone)
            if zaehlt_zu(luecke, z[1], z[2], kadenz):
                return z
    return None


def _neustart_kennzeichen(kontext: ReihenKontext, neustarts: Sequence[dict], kennzeichen: list[str]) -> bool:
    """Z7 — je Neustart ein Kennzeichen, zuletzt; ``True``, wenn es einen gab."""
    for neustart in neustarts:
        kennzeichen.append(
            NEUSTART
            + _uhr(_zeit(neustart["t"]), kontext.zeitzone)
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
    kontext: ReihenKontext,
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
    out = menge_zaehlerstand(
        kontext, werte, von, bis, kadenz, ereignisse, faktor, wertebereich_modul, hoechstzuwachs_je_kadenz
    )
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
    kontext: ReihenKontext,
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
                kontext,
                vorher,
                nachher,
                grenzen,
                kadenz,
                faktor,
                wertebereich_modul,
                hoechstzuwachs_je_kadenz,
                kennzeichen,
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

    unvollstaendig |= _neustart_kennzeichen(kontext, neustarts, kennzeichen)
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
    kennzeichen = _fehlende_intervallmengen(fehlend, erwartet)
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
        kennzeichen.append(_gemessene_zeit(len(treffer) * int(kadenz.total_seconds()), von, bis))

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
        ergebnis["energie_kwh"] = _runde_energie(_integriere(werte, von, bis, kadenz))
        kennzeichen.append(AUS_LEISTUNG_INTEGRIERT)
    return ergebnis


def _integriere(werte: Sequence[Rohwert], von: datetime, bis: datetime, kadenz: timedelta) -> Decimal:
    """M4 — Rechteck-Halten: jeder Wert gilt bis zum nächsten guten Wert, höchstens
    ``HALTEN_FAKTOR × Kadenz``, geschnitten auf die Periode.

    Der nächste gute Wert darf HINTER ``bis`` liegen und der haltende VOR ``von`` (höchstens
    ``HALTEN_FAKTOR × Kadenz`` weit): nur so ergeben die Energien benachbarter Perioden
    zusammen genau die Energie der gröberen Periode (AP-08 IP-3, F24 Viertelstunde 10:15).
    """
    energie = _D(0)
    reichweite = HALTEN_FAKTOR * kadenz
    folge = [r for r in werte if r.gut and von - reichweite < r.zeit <= bis + reichweite]
    for vorher, nachher in zip(folge, folge[1:] + [None]):
        if vorher.zeit >= bis:
            break
        haelt_bis = (
            nachher.zeit
            if nachher is not None and nachher.zeit - vorher.zeit <= HALTEN_FAKTOR * kadenz
            else vorher.zeit + kadenz
        )
        start, ende = max(vorher.zeit, von), min(haelt_bis, bis)
        if ende > start:
            energie += vorher.wert * _dez((ende - start).total_seconds()) / _D(3600)
    return energie


#: Unter so vielen Stellen trägt eine ungerundete Energie nur Rechenrauschen (28-stellige Divisionen
#: durch 3 600); es wird vor der Rundung entfernt, sonst kippte F3 (24,1125) als 24,11249…9 auf 24,112.
ENERGIE_RAUSCHEN_STELLEN = 15


def _runde_energie(energie: Decimal) -> Decimal:
    return _runde(energie.quantize(_D(1).scaleb(-ENERGIE_RAUSCHEN_STELLEN), rounding=ROUND_HALF_EVEN))


def _fehlende_intervallmengen(fehlend: int, erwartet: int) -> list[str]:
    """I2 — das Kennzeichen einer Periode, der Intervallmengen fehlen (leer, wenn keine fehlt)."""
    if not fehlend:
        return []
    return [
        f"{fehlend} von {erwartet} Intervallmengen "
        + ("fehlt" if fehlend == 1 else "fehlen")
        + " — Menge ist die Summe der gemessenen"
    ]


def _gemessene_zeit(gemessen_s: int, von: datetime, bis: datetime) -> str:
    """M3 — das Kennzeichen einer unvollständigen Momentanwert-Periode."""
    return (
        f"gemessene Zeit {gemessen_s // 60}:{gemessen_s % 60:02d} min"
        f" von {int((bis - von).total_seconds()) // 60} min"
    )


# ----------------------- Momentanwert und Intervallmenge aus Teilperioden (AP-08 IP-3, §4.5)


@dataclass(frozen=True)
class Werteteil:
    """Eine gebildete Periode einer Momentanwert- oder Intervallmengen-Reihe, wie eine GRÖBERE sie braucht.

    Genau das trägt eine gespeicherte Viertelstunde, ein Tag, ein Monat (AP-08 IP-3):

    * ``teil`` — Periode, erster/letzter guter Wert und das (gerundete) Ergebnis; die Stände
      bleiben ``None``, ein Momentanwert hat keinen Periodenstand.
    * ``summe`` — die Summe der guten Werte, UNGERUNDET: beim Momentanwert der Werte in
      ``[von, bis)`` (daraus das Mittel ohne Mittel von Mitteln), bei der Intervallmenge der Mengen
      mit Ende in ``(von, bis]`` mal Faktor. ``None`` ohne guten Wert.
    * ``energie`` — nur Momentanwert mit Integration (E5): die Energie UNGERUNDET, sonst ``None``.
    * ``gemessen_s`` — Momentanwert: die gemessene Zeit, erhalten × Kadenz (M2).
    * ``luecke_innen`` — Momentanwert: zwischen zwei guten Werten DIESER Periode liegt eine Lücke
      (über ``LUECKE_FAKTOR × Kadenz``).
    """

    teil: Teilperiode
    summe: Decimal | None
    energie: Decimal | None
    gemessen_s: int
    luecke_innen: bool


def _luecke_zwischen(gute: Sequence[Rohwert], kadenz: timedelta) -> bool:
    return any(b.zeit - a.zeit > LUECKE_FAKTOR * kadenz for a, b in zip(gute, gute[1:]))


def momentanwert_teil(
    werte: Sequence[Rohwert], von: datetime, bis: datetime, kadenz: timedelta, integrieren: bool = False
) -> Werteteil:
    """Eine Momentanwert-Periode aus Rohwerten als :class:`Werteteil` — die Form, in der sie gespeichert wird.

    ``werte`` muss die Nachbarn bis ``HALTEN_FAKTOR × Kadenz`` vor ``von`` und hinter ``bis``
    enthalten, sonst fehlt der Energie das Halten über die Grenze (M4).
    """
    out = momentanwerte(werte, von, bis, kadenz, integrieren)
    gute = _gute_in(werte, von, bis)
    return Werteteil(
        Teilperiode(
            von, bis, None, None, gute[0] if gute else None, gute[-1] if gute else None,
            _mit_abdeckung(out, out["erwartet"]),
        ),
        sum((r.wert for r in gute), _D(0)) if gute else None,
        _integriere(werte, von, bis, kadenz) if integrieren and gute else None,
        len(gute) * int(kadenz.total_seconds()),
        _luecke_zwischen(gute, kadenz),
    )


def intervallmenge_teil(
    werte: Sequence[Rohwert], von: datetime, bis: datetime, kadenz: timedelta, faktor: Decimal = _D(1)
) -> Werteteil:
    """Eine Intervallmengen-Periode aus Rohwerten als :class:`Werteteil` (I1: Ende in ``(von, bis]``)."""
    out = menge_intervall(werte, von, bis, kadenz, faktor)
    treffer = [r for r in werte if r.gut and von < r.zeit <= bis]
    return Werteteil(
        Teilperiode(
            von, bis, None, None, treffer[0] if treffer else None, treffer[-1] if treffer else None,
            _mit_abdeckung(out, out["erwartet"]),
        ),
        sum((r.wert for r in treffer), _D(0)) * faktor if treffer else None,
        None,
        0,
        False,
    )


def _werteteile_ordnen(
    teile: Sequence[Werteteil], von: datetime, bis: datetime
) -> tuple[list[Werteteil], Rohwert | None, Rohwert | None]:
    """Die Teile IN ``[von, bis)``, der letzte gute Wert davor und der erste gute Wert danach."""
    innen: list[Werteteil] = []
    vorher: Rohwert | None = None
    danach: Rohwert | None = None
    for w in sorted(teile, key=lambda x: x.teil.von):
        t = w.teil
        if t.von >= von and t.bis <= bis:
            innen.append(w)
        elif t.bis <= von:
            if t.letzter is not None and (vorher is None or t.letzter.zeit > vorher.zeit):
                vorher = t.letzter
        elif t.von >= bis:
            if t.erster is not None and (danach is None or t.erster.zeit < danach.zeit):
                danach = t.erster
        else:
            raise ValueError(f"Teilperiode {t.von}–{t.bis} ragt über die Grenze von {von}–{bis}")
    return innen, vorher, danach


def _gehalten(p: Rohwert | None, n: Rohwert | None, a: datetime, b: datetime, kadenz: timedelta) -> Decimal:
    """M4 über eine Strecke ``[a, b)`` OHNE eigenen guten Wert: nur, was der Wert davor hält."""
    if p is None:
        return _D(0)
    haelt_bis = n.zeit if n is not None and n.zeit - p.zeit <= HALTEN_FAKTOR * kadenz else p.zeit + kadenz
    start, ende = max(p.zeit, a), min(haelt_bis, b)
    return p.wert * _dez((ende - start).total_seconds()) / _D(3600) if ende > start else _D(0)


def momentanwert_aus_teilperioden(
    teile: Sequence[Werteteil],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    integrieren: bool = False,
) -> Werteteil:
    """M1–M4 über eine GRÖBERE Periode aus ihren gespeicherten Teilperioden (AP-08 IP-3, §4.5).

    Dasselbe Ergebnis wie :func:`momentanwerte` über alle Rohwerte der Periode, gebildet nur aus
    dem, was die Teile tragen:

    * **Mittel** = Summe der Teilsummen ÷ Summe erhalten — nie ein Mittel von Mitteln. Ein Teil
      ohne ``summe`` (gebildet vor IP-3) trägt ``Mittel × erhalten``, genau auf die Rundung seines
      Mittels. Min/Max über die Teile.
    * **Vollständig** nur ohne Lücke zwischen zwei guten Werten — in einem Teil, zwischen zwei
      Teilen, zum letzten Wert davor und zum ersten danach — und mit beiden Rändern innerhalb einer
      Kadenz (M3). Ein unvollständiger Rand eines Teils ist an einer INNEREN Grenze kein Rand mehr.
    * **Gemessene Zeit** = Summe der gemessenen Zeiten; Abdeckung aus erhalten ÷ erwartet, ein Teil
      ohne Zeile zählt mit ``Länge ÷ Kadenz``.
    * **Energie** (nur ``integrieren``, dann trägt jeder Teil mit Werten seine) = Summe der
      ungerundeten Teil-Energien plus je Strecke ohne Teil mit Werten das Halten des Werts davor —
      nie Mittel × Länge. Ohne einen guten Wert gibt es keine Zahl.

    ``teile`` sind die Teile IN ``[von, bis)``, dazu höchstens je einer davor und danach mit gutem
    Wert (für Lücke und Halten über die Grenze); einer, der über eine Grenze ragt, ist ein Fehler.
    """
    innen, vorher, danach = _werteteile_ordnen(teile, von, bis)
    erwartet = erwartet_aus_teilperioden([w.teil for w in innen], von, bis, kadenz)
    gut = [w for w in innen if w.teil.erster is not None]
    if not gut:
        leer = {"mittel": None, "min": None, "max": None, "energie_kwh": None, "zustand": KEINE_WERTE,
                "erhalten": 0, "kennzeichen": []}
        return Werteteil(Teilperiode(von, bis, None, None, None, None, _mit_abdeckung(leer, erwartet)),
                         None, None, 0, False)
    if integrieren and any(w.energie is None for w in gut):
        raise ValueError("integrieren verlangt die Energie jeder Teilperiode mit Werten")

    erhalten = sum(w.teil.ergebnis["erhalten"] for w in gut)
    summe = sum(
        (w.summe if w.summe is not None else w.teil.ergebnis["mittel"] * w.teil.ergebnis["erhalten"] for w in gut),
        _D(0),
    )
    erster, letzter = gut[0].teil.erster, gut[-1].teil.letzter
    schwelle = LUECKE_FAKTOR * kadenz
    luecke_innen = any(w.luecke_innen for w in gut) or any(
        b.teil.erster.zeit - a.teil.letzter.zeit > schwelle for a, b in zip(gut, gut[1:])
    )
    luecke_rand = (vorher is not None and erster.zeit > von and erster.zeit - vorher.zeit > schwelle) or (
        danach is not None and danach.zeit - letzter.zeit > schwelle
    )
    vollstaendig = (
        not luecke_innen and not luecke_rand and erster.zeit - von <= kadenz and bis - letzter.zeit <= kadenz
    )
    gemessen_s = sum(w.gemessen_s for w in gut)
    kennzeichen = [] if vollstaendig else [_gemessene_zeit(gemessen_s, von, bis)]

    energie = None
    if integrieren:
        energie = sum((w.energie for w in gut), _D(0))
        stelle, wert_davor = von, vorher
        for w in gut:
            energie += _gehalten(wert_davor, w.teil.erster, stelle, w.teil.von, kadenz)
            stelle, wert_davor = w.teil.bis, w.teil.letzter
        energie += _gehalten(wert_davor, danach, stelle, bis, kadenz)
        kennzeichen.append(AUS_LEISTUNG_INTEGRIERT)

    ergebnis = {
        "mittel": _runde(summe / erhalten, 1),
        "min": min(w.teil.ergebnis["min"] for w in gut),
        "max": max(w.teil.ergebnis["max"] for w in gut),
        "energie_kwh": _runde_energie(energie) if energie is not None else None,
        "zustand": VOLLSTAENDIG if vollstaendig else UNVOLLSTAENDIG,
        "erhalten": erhalten,
        "kennzeichen": kennzeichen,
    }
    return Werteteil(
        Teilperiode(von, bis, None, None, erster, letzter, _mit_abdeckung(ergebnis, erwartet)),
        summe,
        energie,
        gemessen_s,
        luecke_innen,
    )


def intervallmenge_aus_teilperioden(
    teile: Sequence[Werteteil], von: datetime, bis: datetime, kadenz: timedelta
) -> Werteteil:
    """I1–I2 über eine GRÖBERE Periode aus ihren gespeicherten Teilperioden (AP-08 IP-3, §4.5).

    Menge = Summe der UNGERUNDETEN Teilsummen, einmal gerundet — die Summe gerundeter Teilmengen
    wäre schon ohne Lücke falsch. Jede fehlende Intervallmenge, auch die eines Teils ohne Zeile
    (``Länge ÷ Kadenz``), macht die Periode unvollständig (I2).
    """
    innen, _, _ = _werteteile_ordnen(teile, von, bis)
    erwartet = erwartet_aus_teilperioden([w.teil for w in innen], von, bis, kadenz)
    gut = [w for w in innen if w.teil.ergebnis["erhalten"] > 0]
    if not gut:
        leer = {"menge": None, "zustand": KEINE_WERTE, "erhalten": 0, "kennzeichen": []}
        return Werteteil(Teilperiode(von, bis, None, None, None, None, _mit_abdeckung(leer, erwartet)),
                         None, None, 0, False)
    erhalten = sum(w.teil.ergebnis["erhalten"] for w in gut)
    summe = sum((w.summe if w.summe is not None else w.teil.ergebnis["menge"] for w in gut), _D(0))
    fehlend = erwartet - erhalten
    ergebnis = {
        "menge": _runde(summe),
        "zustand": VOLLSTAENDIG if fehlend == 0 else UNVOLLSTAENDIG,
        "erhalten": erhalten,
        "kennzeichen": _fehlende_intervallmengen(fehlend, erwartet),
    }
    return Werteteil(
        Teilperiode(von, bis, None, None, gut[0].teil.erster, gut[-1].teil.letzter, _mit_abdeckung(ergebnis, erwartet)),
        summe,
        None,
        0,
        False,
    )


# ------------------------------------------- Anteil eines Vorzeichen-Werts (AP-08 IP-7, M5/E15)

ANTEIL_POSITIV = "positiv"
ANTEIL_NEGATIV = "negativ"


def _positiv(anteil: str) -> bool:
    if anteil == ANTEIL_POSITIV:
        return True
    if anteil == ANTEIL_NEGATIV:
        return False
    raise ValueError(f"unbekannter Anteil {anteil!r} — bekannt sind positiv, negativ")


def anteil_des_werts(wert: Decimal | None, anteil: str) -> Decimal | None:
    """Der Anteil EINES Werts: ``max(0, P)`` oder ``max(0, −P)``; kein Wert bleibt kein Wert."""
    if wert is None:
        return None
    teil = wert if _positiv(anteil) else -wert
    return teil if teil > 0 else _D(0)


def anteil_je_rohwert(werte: Sequence[Rohwert], anteil: str | None) -> list[Rohwert]:
    """M5/E15 — DIE EINE STELLE, an der ein Vorzeichen-Wert in seinen Anteil geteilt wird: JE ROHWERT,
    vor jeder Verdichtung. Erst daraus entstehen Mittel, Min, Max (die Nullen des anderen Anteils
    zählen mit) und die Energie je Anteil.

    Nie umgekehrt: das Mittel des ganzen Werts nach seinem Vorzeichen zuzuordnen (E15 Option C,
    verworfen) ließe an F19 aus 12,8 kW Bezug und 22,8 kW Abgabe nur „Abgabe 10,0“ übrig. Das
    Vorzeichen der Box ist schon im Rohwert (AP-04 E5) und wird hier nie ein zweites Mal angewendet.
    ``anteil`` ``None`` = der ganze Wert.
    """
    if anteil is None:
        return list(werte)
    _positiv(anteil)
    return [Rohwert(r.zeit, anteil_des_werts(r.wert, anteil), r.guete) for r in werte]


def anteil_kennzeichen(anteil: str, quelle: str) -> str:
    """Die Kennzeichnung, die mit dem Anteil reist — Wortlaut UND Stelle (zuerst) sind Vertrag."""
    return ("positiver Anteil von " if _positiv(anteil) else "negativer Anteil von ") + quelle


def momentanwerte_anteil(
    werte: Sequence[Rohwert],
    von: datetime,
    bis: datetime,
    kadenz: timedelta,
    integrieren: bool,
    anteil: str | None,
    quelle: str | None,
) -> dict:
    """M1–M5 — :func:`momentanwerte` über den ANTEIL der Rohwerte; das Anteil-Kennzeichen zuerst."""
    out = momentanwerte(anteil_je_rohwert(werte, anteil), von, bis, kadenz, integrieren)
    if anteil is not None:
        out["kennzeichen"] = [anteil_kennzeichen(anteil, quelle), *out["kennzeichen"]]
    return out


# ---------------------------------------------------- Ersatzwert-Methoden (E7, AP-08 IP-13)

#: E7 — die sieben Methoden in der Reihenfolge von ``vokabular.ersatzwert_methode`` der
#: Ereignis-Vektoren, je mit ihrem Namen in Kundensprache (``name``). Das Kennzeichen spricht den
#: Namen, nie das Vertragswort.
ERSATZWERT_METHODEN = {
    "gleichmaessig_verteilen": "Zuwachs gleichmäßig verteilen",
    "profil_vorperiode": "Zuwachs nach dem Profil der Vorperiode verteilen",
    "profil_vergleichsquelle": "Zuwachs nach dem Profil der Vergleichsquelle verteilen",
    "ablesestand_nachtragen": "Ablesestand nachtragen",
    "wert_eingeben": "Wert eingeben (mit Beleg)",
    "vorperiode_uebernehmen": "Vorperiode übernehmen",
    "vergleichsquelle_uebernehmen": "Vergleichsquelle übernehmen",
}
(
    GLEICHMAESSIG_VERTEILEN,
    PROFIL_VORPERIODE,
    PROFIL_VERGLEICHSQUELLE,
    ABLESESTAND_NACHTRAGEN,
    WERT_EINGEBEN,
    VORPERIODE_UEBERNEHMEN,
    VERGLEICHSQUELLE_UEBERNEHMEN,
) = ERSATZWERT_METHODEN

#: a–c verteilen einen GEMESSENEN Zuwachs; f und g übernehmen die Werte ihres Bezugs.
VERTEILEN = (GLEICHMAESSIG_VERTEILEN, PROFIL_VORPERIODE, PROFIL_VERGLEICHSQUELLE)
UEBERNEHMEN = (VORPERIODE_UEBERNEHMEN, VERGLEICHSQUELLE_UEBERNEHMEN)

#: Nur ein wirksamer Ersatzwert wirkt; ein zurückgenommener hinterlässt keine Spur in den Zahlen.
WIRKSAM = "wirksam"

MIT_ERSATZWERT = "mit Ersatzwert"

#: Ein verteilter Anteil wird zum Speichern auf so viele Nachkommastellen ABGESCHNITTEN; den Rest
#: bekommt die letzte Viertelstunde (:func:`verteilen`). Gerechnet wird davor ungerundet (E11).
ERSATZWERT_STELLEN = 9

#: Die Genauigkeit der Division vor dem Abschneiden — dieselbe wie ``MathContext(40)`` in Java.
_VERTEILEN_GENAUIGKEIT = 40

#: Die geschlossene Liste der benannten Ablehnungen (``regeln.ersatzwert_ablehnungen``). Eine
#: Methode, die nicht rechnen kann, lehnt mit ihrem Grund ab — sie weicht nie still auf eine andere aus.
ERSATZWERT_ABLEHNUNGEN = (
    "wertart_passt_nicht",
    "kein_gemessener_zuwachs",
    "zeitraum_nicht_die_luecke",
    "vorperiode_fehlt",
    "vergleichsquelle_fehlt",
    "profil_negativ",
    "profil_ohne_verbrauch",
    "betrag_fuer_mehrere_viertelstunden",
    "einheit_passt_nicht",
    "endstand_unter_letztem_wert",
    "anfangsstand_ueber_naechstem_wert",
    "ueberschneidet_ersatzwert",
)

_VIERTELSTUNDE_S = 900


class ErsatzwertAbgelehnt(ValueError):
    """Eine BENANNTE Ablehnung (``grund`` aus :data:`ERSATZWERT_ABLEHNUNGEN`) — nie ein stiller Rückfall."""

    def __init__(self, grund: str, was: str = ""):
        if grund not in ERSATZWERT_ABLEHNUNGEN:
            raise ValueError(f"unbekannte Ablehnung {grund!r}")
        super().__init__(grund + (": " + was if was else ""))
        self.grund = grund


@dataclass(frozen=True)
class Profilwert:
    """Ein Wert des Bezugs einer Viertelstunde (Vorperiode oder Vergleichsquelle): Menge und Zustand."""

    menge: Decimal | None
    zustand: str | None = VOLLSTAENDIG


@dataclass(frozen=True)
class Ersatzwert:
    """Ein Ersatzwert, wie die Rechenregel ihn braucht — die anlegende Fassung und ihr heutiger Status.

    ``von``/``bis`` im Viertelstunden-Raster (bei d die Viertelstunde des Ablesestands). a–c: ``luecke``
    ist der GEMESSENE Zuwachs ihrer Lücke, ``luecke_von`` deren erste fehlende Messzeit (``data_gap.von``).
    b, c, f, g: ``profil`` je Viertelstunde von ``[von, bis)`` in Zeitfolge (``None`` = der Bezug hat dort
    keinen Wert), bei g ``profil_einheit`` die Einheit der Vergleichsquelle. e: ``betrag`` in ``einheit``.
    d: ``zeitpunkt`` mit ``endstand`` und/oder ``anfangsstand``.
    """

    kennung: str
    methode: str
    von: datetime
    bis: datetime
    status: str = WIRKSAM
    luecke: LueckenZuwachs | None = None
    luecke_von: datetime | None = None
    profil: tuple[Profilwert | None, ...] | None = None
    profil_einheit: str | None = None
    betrag: Decimal | None = None
    einheit: str | None = None
    zeitpunkt: datetime | None = None
    endstand: Decimal | None = None
    anfangsstand: Decimal | None = None


def _raster(t: datetime, auf: bool) -> datetime:
    s = t.timestamp()
    k = (s // _VIERTELSTUNDE_S + (1 if auf and s % _VIERTELSTUNDE_S else 0)) * _VIERTELSTUNDE_S
    return datetime.fromtimestamp(k, timezone.utc)


def viertelstunden(von: datetime, bis: datetime) -> list[datetime]:
    """Die Beginne der Viertelstunden in ``[von, bis)`` (UTC-Raster)."""
    out, t = [], _raster(von, True)
    while t < bis:
        out.append(t)
        t += timedelta(seconds=_VIERTELSTUNDE_S)
    return out


def viertelstunden_der_luecke(luecke_von: datetime, luecke_bis: datetime) -> tuple[datetime, datetime]:
    """Die Viertelstunden, in denen ein Zuwachs anfiel: ``[Boden(erste fehlende Messzeit), Decke(Messzeit danach))``.

    Dieselbe Rechnung wie der Datenbank-Auslöser ``messreihe_ersatzwert_luecke``.
    """
    return _raster(luecke_von, False), _raster(luecke_bis, True)


def verteilen(zuwachs: Decimal, gewichte: Sequence[Decimal]) -> list[Decimal]:
    """Die Invariante „Summe = gemessener Zuwachs“ — für a, b und c die EINE Stelle.

    Jeder Anteil außer dem letzten ist ``Zuwachs × Gewicht ÷ Summe der Gewichte``, ungerundet gerechnet
    und erst dann auf :data:`ERSATZWERT_STELLEN` Nachkommastellen ABGESCHNITTEN (nie aufgerundet, darum
    nie negativ). Der letzte ist der Zuwachs minus alle anderen: die Summe der gespeicherten Anteile ist
    EXAKT der Zuwachs, und der Rest aus dem Abschneiden (kleiner als n × 10⁻⁹) steht in der LETZTEN
    Viertelstunde — dort, wo der Stand nach der Lücke den Zuwachs abschließt.
    """
    if not gewichte:
        raise ValueError("ein Zuwachs braucht mindestens eine Viertelstunde")
    summe = sum(gewichte, _D(0))
    stelle = _D(1).scaleb(-ERSATZWERT_STELLEN)
    with localcontext() as ctx:
        ctx.prec = _VERTEILEN_GENAUIGKEIT
        ctx.rounding = ROUND_HALF_EVEN
        anteile = [(zuwachs * g / summe).quantize(stelle, rounding=ROUND_DOWN) for g in gewichte[:-1]]
    anteile.append(zuwachs - sum(anteile, _D(0)))
    return anteile


def _profil(ew: Ersatzwert, n: int) -> list[Decimal]:
    grund = "vorperiode_fehlt" if ew.methode in (PROFIL_VORPERIODE, VORPERIODE_UEBERNEHMEN) else "vergleichsquelle_fehlt"
    if ew.profil is None or len(ew.profil) != n:
        raise ErsatzwertAbgelehnt(grund, ew.kennung)
    for p in ew.profil:
        if p is None or p.menge is None or p.zustand != VOLLSTAENDIG:
            raise ErsatzwertAbgelehnt(grund, ew.kennung)
    return [p.menge for p in ew.profil]


def ersatzwert_anteile(ew: Ersatzwert, regel: str, einheit: str | None) -> list[tuple[datetime, Decimal]]:
    """E7 — die Werte je Viertelstunde, die ein Ersatzwert setzt (a, b, c, e, f, g), in Zeitfolge.

    ``regel`` ist die Rechenregel der Reihe (``zaehlerstand`` · ``intervallmenge`` · ``momentanwert``),
    ``einheit`` ihre gespeicherte Einheit. a–c verteilen den GEMESSENEN Zuwachs genau über die
    Viertelstunden seiner Lücke (:func:`verteilen`); b und c brauchen ein vollständiges Profil ohne
    negative Werte und mit Verbrauch. e setzt den Betrag EINER Viertelstunde, f und g übernehmen die
    Werte ihres Bezugs. Methode d setzt keine Werte (:func:`ablesestand_ereignisse`).
    Kann eine Methode nicht rechnen, lehnt sie benannt ab (:class:`ErsatzwertAbgelehnt`).
    """
    m = ew.methode
    if m not in ERSATZWERT_METHODEN or m == ABLESESTAND_NACHTRAGEN:
        raise ValueError(f"{m!r} ist keine Methode mit Anteilen je Viertelstunde")
    beginne = viertelstunden(ew.von, ew.bis)
    if regel == "momentanwert" or (m in VERTEILEN and regel != "zaehlerstand"):
        raise ErsatzwertAbgelehnt("wertart_passt_nicht", f"{m} an {regel}")
    if m in VERTEILEN:
        if ew.luecke is None or ew.luecke.zuwachs is None or ew.luecke_von is None:
            raise ErsatzwertAbgelehnt("kein_gemessener_zuwachs", ew.kennung)
        if (ew.von, ew.bis) != viertelstunden_der_luecke(ew.luecke_von, ew.luecke.messzeit_nach):
            raise ErsatzwertAbgelehnt("zeitraum_nicht_die_luecke", ew.kennung)
        if m == GLEICHMAESSIG_VERTEILEN:
            gewichte = [_D(1)] * len(beginne)
        else:
            gewichte = _profil(ew, len(beginne))
            if any(g < 0 for g in gewichte):
                raise ErsatzwertAbgelehnt("profil_negativ", ew.kennung)
            if sum(gewichte, _D(0)) == 0:
                raise ErsatzwertAbgelehnt("profil_ohne_verbrauch", ew.kennung)
        return list(zip(beginne, verteilen(ew.luecke.zuwachs, gewichte)))
    if m == WERT_EINGEBEN:
        if len(beginne) != 1:
            raise ErsatzwertAbgelehnt("betrag_fuer_mehrere_viertelstunden", ew.kennung)
        if einheit is None or ew.einheit != einheit:
            raise ErsatzwertAbgelehnt("einheit_passt_nicht", f"{ew.einheit} an {einheit}")
        return [(beginne[0], ew.betrag)]
    werte = _profil(ew, len(beginne))
    if m == VERGLEICHSQUELLE_UEBERNEHMEN and (einheit is None or ew.profil_einheit != einheit):
        raise ErsatzwertAbgelehnt("einheit_passt_nicht", f"{ew.profil_einheit} an {einheit}")
    return list(zip(beginne, werte))


def ablesestand_pruefen(werte: Sequence[Rohwert], ew: Ersatzwert) -> None:
    """E7 d — ein Ablesestand passt zu den Werten um seinen Zeitpunkt, sonst benannte Ablehnung.

    Der Endstand liegt nicht unter dem letzten guten Wert VOR dem Zeitpunkt, der Anfangsstand nicht über
    dem ersten guten Wert AB dem Zeitpunkt (dieselbe Nachbarschaft ``(vorher, nachher]`` wie Z4).
    """
    gut = [w for w in werte if w.gut]
    vorher = [w for w in gut if w.zeit < ew.zeitpunkt]
    nachher = [w for w in gut if w.zeit >= ew.zeitpunkt]
    if ew.endstand is not None and vorher and ew.endstand < vorher[-1].wert:
        raise ErsatzwertAbgelehnt("endstand_unter_letztem_wert", ew.kennung)
    if ew.anfangsstand is not None and nachher and ew.anfangsstand > nachher[0].wert:
        raise ErsatzwertAbgelehnt("anfangsstand_ueber_naechstem_wert", ew.kennung)


def ablesestand_ereignisse(ereignisse: Sequence[dict], ew: Ersatzwert) -> list[dict]:
    """E7 d — die Gerätegrenze zum Zeitpunkt mit den nachgetragenen Ableseständen; Z4 rechnet danach.

    Eine Gerätegrenze genau zu diesem Zeitpunkt wird ersetzt, sonst entsteht sie (die Rücksetzung von F6
    ist nur aus den Werten erkannt). Kein Rohwert wird angefasst.
    """
    grenze = {
        "art": "device_boundary",
        "t": ew.zeitpunkt.isoformat(),
        "endstand": ew.endstand,
        "anfangsstand": ew.anfangsstand,
    }
    uebrig = [e for e in ereignisse if not (e["art"] == "device_boundary" and _zeit(e["t"]) == ew.zeitpunkt)]
    return [*uebrig, grenze]


def _kennung_folge(kennung: str) -> tuple[int, int]:
    _, jahr, nummer = kennung.split("-")
    return int(jahr), int(nummer)


def geltende(
    ersatzwerte: Sequence[Ersatzwert],
    regel: str,
    einheit: str | None,
    vorab_abgelehnt: Mapping[str, str] | None = None,
) -> tuple[list[tuple[Ersatzwert, list[tuple[datetime, Decimal]]]], dict[str, str]]:
    """Welche Ersatzwerte einer Reihe gelten — und welche benannt abgelehnt sind.

    Nur WIRKSAME zählen; ein zurückgenommener ist, als hätte es ihn nie gegeben. In der Folge ihrer
    Kennung (Jahr, Nummer) hält der frühere seine Viertelstunden: ein späterer, der eine davon berührt,
    ist ``ueberschneidet_ersatzwert`` — zwei Verteilungen desselben Zuwachses ergäben die doppelte Summe.
    Ein abgelehnter hält keine Viertelstunde. ``vorab_abgelehnt`` trägt die Ablehnungen, die nur mit den
    Rohwerten prüfbar sind (d, :func:`ablesestand_pruefen`). Geliefert werden die geltenden mit ihren
    Anteilen (d ohne) und je abgelehnter Kennung ihr Grund.
    """
    vorab = dict(vorab_abgelehnt or {})
    gelten: list[tuple[Ersatzwert, list[tuple[datetime, Decimal]]]] = []
    abgelehnt: dict[str, str] = {}
    for ew in sorted((e for e in ersatzwerte if e.status == WIRKSAM), key=lambda e: _kennung_folge(e.kennung)):
        if ew.kennung in vorab:
            abgelehnt[ew.kennung] = vorab[ew.kennung]
            continue
        if any(g.von < ew.bis and ew.von < g.bis for g, _ in gelten):
            abgelehnt[ew.kennung] = "ueberschneidet_ersatzwert"
            continue
        try:
            if ew.methode == ABLESESTAND_NACHTRAGEN and regel != "zaehlerstand":
                raise ErsatzwertAbgelehnt("wertart_passt_nicht", f"{ew.methode} an {regel}")
            anteile = [] if ew.methode == ABLESESTAND_NACHTRAGEN else ersatzwert_anteile(ew, regel, einheit)
        except ErsatzwertAbgelehnt as x:
            abgelehnt[ew.kennung] = x.grund
            continue
        gelten.append((ew, anteile))
    return gelten, abgelehnt


def ersatzwert_kennzeichen(methode: str, kennung: str) -> str:
    """Das Kennzeichen „mit Ersatzwert (Methode …)“ — Wortlaut aus ``ergebnis-zustand`` (Rang 70)."""
    return "mit Ersatzwert (Methode „" + ERSATZWERT_METHODEN[methode] + "“, " + kennung + ")"


def mit_ersatzwerten(
    kontext: ReihenKontext,
    basis: dict,
    stand_anfang: bool,
    stand_ende: bool,
    von: datetime,
    bis: datetime,
    gelten: Sequence[tuple[Ersatzwert, list[tuple[datetime, Decimal]]]],
) -> dict:
    """E7 — die Periode ``[von, bis)`` mit ihren geltenden Ersatzwerten: die neue Version über dem Bestand.

    ``basis`` ist das Ergebnis aus den Rohwerten (Version 1, bei d schon mit dem Ablesestand gerechnet),
    ``stand_anfang``/``stand_ende`` sagen, ob Z1 an den Grenzen einen Stand fand. Gerechnet wird IMMER vom
    Bestand aus — nie auf dem Ergebnis einer früheren Version.

    * a–c: Enthält die Periode die Lücke ganz, steckt der Zuwachs schon in der Menge (E2) — sie bleibt, und
      der Satz „nicht auf Viertelstunden verteilbar“ weicht dem Ersatzwert. Schneidet sie die Lücke an,
      kommen die Anteile ihrer Viertelstunden zur gemessenen Menge (``None`` hieß hier: kein gemessener Teil
      außerhalb der Lücke). Ein Rand, der IN der Lücke liegt, ist gedeckt; einer außerhalb bleibt „nicht gemessen“.
    * e–g gelten nur für die Viertelstunde selbst: ihr Wert IST die Menge (die gröbere Periode bildet die Kaskade).
    * d: der Ablesestand wirkt schon in ``basis`` (Z4); hier kommt nur sein Kennzeichen dazu.

    Der Zustand ist „mit Ersatzwert“, sobald einer wirkt und eine Zahl dasteht; die Abdeckung des Verlaufs
    bleibt die der Rohwerte. Kennzeichen: Ränder (Rang 20/21), die übrigen Sätze, zuletzt je Ersatzwert
    sein Satz (Rang 70).
    """
    menge = basis.get("menge")
    kennzeichen = list(basis.get("kennzeichen", []))
    anfang_gedeckt = ende_gedeckt = ersetzt = angeschnitten = False
    saetze: list[str] = []
    for ew, anteile in gelten:
        if ew.methode == ABLESESTAND_NACHTRAGEN:
            if von < ew.zeitpunkt <= bis:
                saetze.append(ersatzwert_kennzeichen(ew.methode, ew.kennung))
            continue
        innen = [a for t, a in anteile if von <= t < bis]
        if not innen:
            continue
        if ew.methode in VERTEILEN:
            luecke, lv, lb = ew.luecke, ew.luecke_von, ew.luecke.messzeit_nach
            if lv > von and lb <= bis:
                satz = luecken_kennzeichen(luecke, kontext)
                kennzeichen = [s for s in kennzeichen if s != satz]
            else:
                menge = (menge if menge is not None else _D(0)) + sum(innen, _D(0))
                angeschnitten = True
                anfang_gedeckt |= lv <= von < lb
                ende_gedeckt |= lv <= bis < lb
        else:
            if len(innen) != 1 or (bis - von) != timedelta(seconds=_VIERTELSTUNDE_S):
                raise ValueError("e–g bilden die Viertelstunde; die gröbere Periode bildet die Kaskade (IP-17)")
            menge, ersetzt, kennzeichen = innen[0], True, []
        saetze.append(ersatzwert_kennzeichen(ew.methode, ew.kennung))
    if not saetze:
        return dict(basis)
    if ersetzt or angeschnitten:
        # Die Ränder neu sagen: gedeckt ist, was in der Lücke liegt; „nur ein Stand“ war ein Rand.
        rand = (ANFANG_NICHT_GEMESSEN, ENDE_NICHT_GEMESSEN, NUR_EIN_STAND)
        vorn = []
        if not ersetzt and not stand_anfang and not anfang_gedeckt:
            vorn.append(ANFANG_NICHT_GEMESSEN)
        if not ersetzt and not stand_ende and not ende_gedeckt:
            vorn.append(ENDE_NICHT_GEMESSEN)
        kennzeichen = vorn + [s for s in kennzeichen if s not in rand]
    out = dict(basis)
    out["menge"] = menge
    out["kennzeichen"] = kennzeichen + saetze
    out["zustand"] = MIT_ERSATZWERT if menge is not None else basis["zustand"]
    return out


def ersatzwert_aus(eintrag: dict, reihe: dict) -> Ersatzwert:
    """Ein Ersatzwert aus seiner Beschreibung in der Vektor-Datei.

    a–c nennen ihre Lücke nur mit ``luecke: {von, bis}`` (erste fehlende Messzeit, Messzeit danach); der
    Zuwachs wird aus den Rohwerten der Reihe genommen (:func:`luecken_zuwachs`), nie abgetippt. ``profil``
    ist eine Liste von Abschnitten ``{von, bis, je_viertelstunde}`` oder ``{von, bis, fehlt: true}``.
    """
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    luecke = luecke_von = None
    if "luecke" in eintrag:
        luecke_von, nach = _zeit(eintrag["luecke"]["von"]), _zeit(eintrag["luecke"]["bis"])
        gut = [w for w in rohwerte(reihe) if w.gut]
        vorher = [w for w in gut if w.zeit < luecke_von]
        nachher = [w for w in gut if vorher and w.zeit > vorher[-1].zeit][:1]
        if vorher and nachher and nachher[0].zeit == nach and vorher[-1].zeit + kadenz == luecke_von:
            luecke = luecken_zuwachs(vorher[-1], nachher[0], reihe.get("ereignisse", []), kadenz,
                                     _dez(reihe.get("faktor", 1)))
    profil = None
    if "profil" in eintrag:
        werte: list[Profilwert | None] = []
        for a in eintrag["profil"]:
            n = len(viertelstunden(_zeit(a["von"]), _zeit(a["bis"])))
            werte += [None if a.get("fehlt") else Profilwert(_dez(a["je_viertelstunde"]), a.get("zustand", VOLLSTAENDIG))] * n
        profil = tuple(werte)

    def dez(feld: str) -> Decimal | None:
        return _dez(eintrag[feld]) if eintrag.get(feld) is not None else None

    return Ersatzwert(
        kennung=eintrag["kennung"],
        methode=eintrag["methode"],
        von=_zeit(eintrag["von"]),
        bis=_zeit(eintrag["bis"]),
        status=eintrag.get("status", WIRKSAM),
        luecke=luecke,
        luecke_von=luecke_von,
        profil=profil,
        profil_einheit=eintrag.get("profil_einheit"),
        betrag=dez("betrag"),
        einheit=eintrag.get("einheit"),
        zeitpunkt=_zeit(eintrag["zeitpunkt"]) if "zeitpunkt" in eintrag else None,
        endstand=dez("endstand"),
        anfangsstand=dez("anfangsstand"),
    )


# ------------------------------------------------------------------------ Der Eingang


def kontext(reihe: dict) -> ReihenKontext:
    """Der Träger einer Reihenbeschreibung: ihre ``einheit`` und ``zeitzone`` (ohne eigene die Beispielwelt)."""
    return ReihenKontext(reihe.get("einheit"), reihe.get("zeitzone", "Europe/Berlin"))


def ergebnis(
    reihe: dict,
    von: str,
    bis: str,
    ereignisse_zusatz: Iterable[dict] = (),
    anteil: str | None = None,
    quelle: str | None = None,
    ersatzwerte: Iterable[dict] = (),
) -> dict:
    """Der EINE Eingang: eine Reihe, eine Periode → das Ergebnis der Vektor-Datei.

    ``reihe`` ist die Reihenbeschreibung eines Falls (``wertart``, ``kadenz_s``, ``rohwerte``,
    optional ``faktor``, ``luecken``, ``ereignisse``, ``wertebereich_modul``,
    ``hoechstzuwachs_je_kadenz``, ``integrieren``). ``ereignisse_zusatz`` sind die Ereignisse
    einer Fall-VARIANTE (etwa ein nachgetragener Ablesestand, der aus der Rücksetzung eine
    Gerätegrenze macht) — sie treten zu den Ereignissen der Reihe hinzu.

    Geliefert werden genau die Felder, die die Vektor-Datei je Erwartung nennt:
    ``menge`` beziehungsweise ``mittel``/``min``/``max``/``energie_kwh``, dazu ``zustand``,
    ``erhalten``, ``erwartet``, ``abdeckung_prozent``, ``kennzeichen`` und ``stunden``.

    ``ersatzwerte`` (AP-08 IP-13) sind die Ersatzwerte der Reihe mit ihrem Status: die Erwartung ist dann
    die VERSION mit den geltenden (:func:`geltende`, :func:`mit_ersatzwerten`), und ``ersatzwert_abgelehnt``
    nennt je abgelehnter Kennung ihren Grund.
    """
    werte = rohwerte(reihe)
    kadenz = timedelta(seconds=reihe["kadenz_s"])
    a, b = _zeit(von), _zeit(bis)
    faktor = _dez(reihe.get("faktor", 1))
    wertart = reihe["wertart"]
    if anteil is not None and wertart != "momentanwert":
        raise ValueError(f"einen Anteil hat nur ein Momentanwert, nicht {wertart!r}")

    liste = [ersatzwert_aus(e, reihe) for e in ersatzwerte]
    vorab = {}
    for ew in liste:
        if ew.status == WIRKSAM and ew.methode == ABLESESTAND_NACHTRAGEN:
            try:
                ablesestand_pruefen(werte, ew)
            except ErsatzwertAbgelehnt as x:
                vorab[ew.kennung] = x.grund
    gelten, abgelehnt = geltende(liste, wertart, reihe.get("einheit"), vorab)

    if wertart == "zaehlerstand":
        ereignisse = list(reihe.get("ereignisse", [])) + list(ereignisse_zusatz)
        for ew, _ in gelten:
            if ew.methode == ABLESESTAND_NACHTRAGEN:
                ereignisse = ablesestand_ereignisse(ereignisse, ew)
        out = menge_zaehlerstand(
            kontext(reihe),
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
        out = momentanwerte_anteil(werte, a, b, kadenz, reihe.get("integrieren", False), anteil, quelle)
    else:
        raise ValueError(f"unbekannte Wertart {wertart!r} — bekannt sind zaehlerstand, intervallmenge, momentanwert")

    if gelten:
        zaehler = wertart == "zaehlerstand"
        out = mit_ersatzwerten(
            kontext(reihe),
            out,
            not zaehler or periodenstand(werte, a, kadenz) is not None,
            not zaehler or periodenstand(werte, b, kadenz) is not None,
            a,
            b,
            gelten,
        )
    if abgelehnt:
        out["ersatzwert_abgelehnt"] = abgelehnt
    # Z9: Abdeckung des VERLAUFS - sie sagt, wie viele Werte ankamen, nicht ob die Menge
    # stimmt. Ein vollständiger Tag darf 85 % Abdeckung haben (F8).
    out["abdeckung_prozent"] = (
        int(_D(out["erhalten"]) * 100 / _D(out["erwartet"])) if out["erwartet"] else None
    )
    # P3: die Länge der Periode in Stunden - am Umstellungstag 23 oder 25, weil Tage
    # Kalenderperioden in der Zeitzone des Standorts sind.
    out["stunden"] = int((b - a).total_seconds() // 3600)
    return out
