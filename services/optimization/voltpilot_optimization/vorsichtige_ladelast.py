"""Vorsichtige Lade-Last (Paket P1, Captain-Entscheid HZ-1 = A vom 14.10.2026):
für die Viertelstunden, in denen der Plan aus Überschuss laden will, rechnet er
mit dem höchsten Verbrauch derselben Tageszeit aus den letzten sieben Tagen.

Der Anlass (Pilsting/Herzogau, 13.10.2026, Scout ``vp-herzogau-minus-erloes-k4``
§4 A2 und §5): der Fahrplan ließ die Vormittagssonne ins Netz und wollte erst ab
12:30 Uhr zum Tiefpreis laden. Um 12:40 Uhr lief ein Verbraucher mit rund 37 kW
an und nahm den Überschuss; der Speicher kam auf 49 statt 95 %. Die Lastprognose
rechnete für die Lade-Stunden mit 8 bis 13 kW, obwohl die Vortage zur selben
Zeit 25 bis 36 kW gezeigt hatten. Dasselbe spätere Laden brachte im Oktober rund
23 EUR - es bleibt, es bekommt nur eine ehrliche Menge.

DIE REGEL
---------
Je Viertelstunde ``t`` des laufenden Sonnenfensters (ab Slot 1)::

    H_t   = höchste gemessene Last derselben Berliner Tageszeit (+-1 Slot)
            in den letzten 7 Tagen vor jetzt
    L^v_t = max(L_t, H_t)            (L_t = die Last, mit der der Plan rechnet)

Der Solver (``solver.build_model``, Nebenbedingung ``vorsichtige_ladelast``)
lässt eine künftige Überschuss-Viertelstunde (``pv_t > L_t``) höchstens
``max(pv_t - L^v_t, 0)`` laden. Auf den Teil des Überschusses, den der vorsichtige
Verbrauch braucht, zählt die Ladeplanung also nicht. Reicht der so gerechnete
Überschuss der billigen Stunden nicht für einen vollen Speicher, lädt der Plan
von selbst früher; reicht er, bleibt das späte Laden, wie es ist. Das ist keine
Heuristik neben dem Solver, sondern eine Nebenbedingung in ihm - die
Preisoptimierung entscheidet weiter, nur über die kleinere Menge.

Was sie NICHT tut:

* Die laufende Viertelstunde (Slot 0) antwortet die Messung (P1/P2 der
  Last-Korrektur, :mod:`voltpilot_optimization.load_nowcast`): ``L^v_0 = L_0``.
  Läuft der Verbraucher gerade nicht, darf jetzt der ganze gemessene Überschuss
  in den Speicher - genau daraus entsteht das frühere Laden.
* Sie gilt nur im LAUFENDEN Sonnenfenster (:func:`laufendes_sonnenfenster`):
  von der ersten Viertelstunde mit Sonne bis zu seinem Ende. Abends und
  nachts plant der Lauf wie vorher - würde er schon dann mit dem gekappten
  Mittag von morgen rechnen, hielte er Energie zurück, die er heute verkauft
  (Abendverkauf bleibt, HZ-2 C; Nachtdeckung rein ökonomisch,
  :mod:`voltpilot_optimization.night_reserve`; keine feste Reserve).
* Defizit-Viertelstunden (``pv_t <= L_t``) bleiben unberührt.
* Netzabgleich, Kosten, Ersparnis und der veröffentlichte Fahrplan rechnen
  weiter mit ``L_t``; ``L^v`` begrenzt nur das Laden.
* Anlagen mit Netzladen (``netzladen_erlaubt``) bekommen keinen Term: dort ist
  der Überschuss keine Grenze des Ladens, und eine Kappung nähme dem Plan das
  bewusst bezahlte Netzladen.

Nachrechnen an gespeicherten Läufen: ``tools/vorsichtige_ladelast_nachweis.py``.

Die Messwerte sind dieselben, die die Nacht-Fehlerverteilung liest: das
Viertelstunden-Mittel von ``telemetry.load_kw`` aus ``telemetry_rollup_15m``
(:func:`voltpilot_optimization.night_reserve._measured_load_slots`). Fehlen sie,
gilt die normale Prognose (kein Term, ein Logeintrag). Schalter je Anlage:
:func:`voltpilot_optimization.config.vorsichtige_ladelast_enabled`.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

BERLIN = ZoneInfo("Europe/Berlin")

#: So viele Tage vor jetzt zählen (Entscheid HZ-1 A: „die letzten 7 Tage“).
TAGE = 7

#: Toleranz um die Tageszeit in Slots (eine Viertelstunde davor und danach):
#: ein Verbraucher, der gestern um 12:40 und vorgestern um 12:50 anlief, trifft
#: dieselbe Lade-Viertelstunde.
TOLERANZ_SLOTS = 1

#: Unter diesem Abstand [kW] zur Prognose hebt ein Slot nicht - Gleitkomma-Staub
#: soll keine Nebenbedingung bauen.
HEBEN_EPS_KW = 1e-6

#: Ab dieser PV-Leistung [kW] gehört ein Slot zum Sonnenfenster.
SONNE_KW = 0.1


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _tageszeit_minute(moment: datetime) -> int:
    """Minute des Berliner Tages - die Tageszeit ist ein Kalender-Begriff, über
    die Zeitumstellung hinweg zählt die Wanduhr, nicht der UTC-Abstand."""
    lokal = _utc(moment).astimezone(BERLIN)
    return lokal.hour * 60 + lokal.minute


def hoechste_last_der_tageszeit(
    gemessen: dict[datetime, float],
    slot_starts: list[datetime],
    jetzt: datetime,
    *,
    tage: int = TAGE,
    toleranz_slots: int = TOLERANZ_SLOTS,
    slot_minutes: int = 15,
) -> list[float | None]:
    """``H_t`` je Slot: die höchste gemessene Last derselben Tageszeit (+-
    ``toleranz_slots``) aus den abgeschlossenen Viertelstunden der letzten
    ``tage`` Tage vor ``jetzt``; ``None``, wo keine Messung vorliegt.

    ``gemessen`` bildet Slot-ANFANG auf das Viertelstunden-Mittel ab. Eine
    Viertelstunde, die bei ``jetzt`` noch läuft, zählt nicht (ein halbes Mittel
    ist keine Messung), ebenso keine ältere als ``tage`` Tage.
    """
    if tage < 1 or toleranz_slots < 0 or slot_minutes <= 0:
        raise ValueError("invalid window")
    jetzt = _utc(jetzt)
    seit = jetzt - timedelta(days=tage)
    breite = timedelta(minutes=slot_minutes)
    je_tageszeit: dict[int, float] = {}
    for start, kw in gemessen.items():
        start = _utc(start)
        if start < seit or start + breite > jetzt:
            continue
        if kw is None or not math.isfinite(kw):
            continue
        minute = _tageszeit_minute(start)
        bisher = je_tageszeit.get(minute)
        je_tageszeit[minute] = kw if bisher is None else max(bisher, kw)
    out: list[float | None] = []
    for start in slot_starts:
        minute = _tageszeit_minute(start)
        werte = [
            je_tageszeit[m]
            for k in range(-toleranz_slots, toleranz_slots + 1)
            if (m := (minute + k * slot_minutes) % 1440) in je_tageszeit
        ]
        out.append(max(werte) if werte else None)
    return out


def laufendes_sonnenfenster(pv_kw: list[float]) -> int:
    """Wie viele Slots ab jetzt zum LAUFENDEN Sonnenfenster gehören: die
    zusammenhängenden Slots ab Slot 0 mit Sonne über :data:`SONNE_KW`. 0, wenn
    gerade keine Sonne scheint (Abend, Nacht)."""
    n = 0
    while n < len(pv_kw) and pv_kw[n] > SONNE_KW:
        n += 1
    return n


def vorsichtige_ladelast(
    load_kw: list[float],
    hoechste: list[float | None],
    pv_kw: list[float] | None = None,
) -> list[float] | None:
    """``L^v_t = max(L_t, H_t)``; Slot 0 bleibt ``L_0`` (die Messung).

    Mit ``pv_kw`` nur im laufenden Sonnenfenster (:func:`laufendes_sonnenfenster`).

    ``None``, wenn kein Slot steigt - dann baut der Solver keine
    Nebenbedingung, und der Plan ist byte-identisch.
    """
    if len(load_kw) != len(hoechste):
        raise ValueError("load_kw and hoechste must have one entry per slot")
    ende = len(load_kw) if pv_kw is None else laufendes_sonnenfenster(pv_kw)
    out = list(load_kw)
    gehoben = False
    for t in range(1, ende):
        h = hoechste[t]
        if h is not None and h > out[t] + HEBEN_EPS_KW:
            out[t] = h
            gehoben = True
    return out if gehoben else None
