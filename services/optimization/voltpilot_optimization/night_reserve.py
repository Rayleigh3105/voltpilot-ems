"""Nacht-Wertfunktion (P3, Konzept ``vp-nachtreserve-konzept-k2`` §3): was der
Ladestand bei SONNENAUFGANG wert ist, gemessen an der Nacht-Fehlerverteilung
DIESER Anlage.

Der Anlass (Nacht 04./05.09.2026, Pilsting/Herzogau): der Fahrplan plante die
Nacht mit der Persistenz-Lastprognose OHNE jeden Unsicherheitsaufschlag, die
Nacht kam mit +24 % Last, und der Speicher stand um 02:45 leer statt um 08:00.
Der Captain-Entscheid vom 08.09.2026 verbietet dagegen ausdrücklich jede FESTE
Reserve: der Plan soll genau so viel zurückhalten, wie **Preisabstand mal
Fehlerwahrscheinlichkeit** rechtfertigt - die ökonomische Fortsetzung von
„Nachtdeckung rein ökonomisch" (29.07.2026).

Dieses Modul hält beide Hälften davon:

**P3a - die Fehlerverteilung** (:func:`night_error_quantiles`): je vollständiger
Nacht der relative Energie-Fehler ``Σ gemessen / Σ prognostiziert − 1`` der
Nacht 18-07 Uhr Berliner Zeit, prognostiziert vom AKTIVEN Lastmodell aus dem
Lauf um 17:45 des Vortags (also aus dem, was der Plan an jenem Abend WUSSTE -
eine spätere Korrektur wäre Hellsehen). Aus den letzten ``nights`` solcher
Nächte werden die Quantile linear interpoliert; unter ``min_nights`` gibt es
KEINE Verteilung und damit (siehe unten) keinen Term. Ein DB-Lesepfad, einmal
je Takt und Anlage.

**P3b - die Wertfunktion** (:func:`night_reserve_terms`): die reine Rechnung,
die aus einer Fehlerverteilung + den Plan-Eingaben die stückweise lineare
Zusatzkosten-Kurve über dem Ladestand bei Sonnenaufgang macht. Sie ist
bewusst SOLVER-FREI, damit der Ein-Speicher-Solver
(:mod:`voltpilot_optimization.solver`) und der Co-Optimierer
(:mod:`voltpilot_optimization.co_solver`) dieselben Zahlen benutzen und nicht
auseinanderlaufen können.

Die Stufen (Report §3 P3, Formeln verbatim)::

    surplus_t = pv_t > load_t + 0,5 kW
    i0 = erster Slot >= 0 mit NICHT surplus (die laufende Überschussphase
         wird übersprungen);  i1 = erster Slot > i0 mit surplus
    Bedingung: i0 < n, i1 < n, i1 − i0 >= 4, Quantile vorhanden
    D_Rest = Σ_{t=i0}^{i1−1} max(load_t − pv_t, 0) · dt / eta   [gespeicherte kWh]
    p_imp  = Mittel(import_price_t, t in [i0, i1)) / 10         [ct/kWh]
    v_left = min(max(export_value_t, 0)/10) über t >= i1 mit surplus_t,
             sonst p_imp                                        [ct/kWh]
    Bedingung: p_imp > v_left
    eps_k = max(0, Q_{q_k});  L_k = eps_k · D_Rest;  q_0 = 0,5
    c_k = (p_imp − v_left)/100 · (q_k − q_{k−1})
          + [k = K] · (p_imp − v_left)/100 · (1 − q_K)          [EUR/kWh]
    vf_s[k] >= 0;  vf_c[k]:  vf_s[k] >= L_k − (soc[i1] − soc_floor)
    Ziel += Σ_k c_k · vf_s[k]

Die Grenzbedingung, die daraus folgt (und die der Testvektor prüft): eine kWh
wird abends verkauft **genau dann**, wenn
``p_sale − wear > v_left + (p_imp − v_left) · P(eps > slack)`` - der
Newsvendor-Bruch, aber INNERHALB des MILP und über EINEN Knoten
(``soc[i1]``), also ohne Szenario-Bäume und ohne Eingriff in die Sollwerte der
laufenden Viertelstunde.

**Ohne Fehlerdaten, ohne Preisabstand oder ohne Überschuss-Slot nach der Nacht
entsteht KEIN Term** - der Plan ist dann byte-identisch mit dem von vorher.
Dasselbe gilt für den Schalter ``OPTIMIZER_NIGHT_RESERVE_ENABLED``
(:func:`voltpilot_optimization.config.night_reserve_enabled`).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo

logger = logging.getLogger("voltpilot.optimization.night_reserve")

BERLIN = ZoneInfo("Europe/Berlin")

#: Die Quantile der Wertfunktion (q_0 = 0,5 ist die Prognose des Plans SELBST -
#: ihr Stufenkoeffizient ist deshalb 0, siehe :func:`night_reserve_terms`).
DEFAULT_QUANTILES: tuple[float, ...] = (0.5, 0.75, 0.9, 0.95)

#: Nacht-Fenster in BERLINER Stunden (18 Uhr bis 07 Uhr des Folgetags) - 52
#: Viertelstunden.
DEFAULT_WINDOW: tuple[int, int] = (18, 7)

#: So viele der 52 Viertelstunden müssen Messung UND Prognose tragen, damit die
#: Nacht als vollständig gilt. Eine halb gemessene Nacht ergibt einen
#: Energie-Quotienten über zwei verschiedenen Fenstern - das wäre kein Fehler,
#: sondern ein Vergleich zweier verschiedener Nächte.
MIN_SLOTS_PER_NIGHT = 44

#: Der Lauf, dessen Prognose gilt: der Abend-Lauf um 17:45 Berliner Zeit des
#: Vortags (+- ``RUN_TOLERANCE``) - das, was der Plan an jenem Abend WUSSTE.
RUN_HOUR, RUN_MINUTE = 17, 45
RUN_TOLERANCE = timedelta(minutes=15)

#: Ab wann ein Slot als Überschuss-Slot gilt (kW über der Last) - dieselbe
#: Schwelle wie im Report; sie hält Rausch-Slots aus der Sonnenaufgangs-Suche.
SURPLUS_DEADBAND_KW = 0.5

#: Kürzeste Nacht, für die der Term überhaupt gebaut wird (Slots).
MIN_NIGHT_SLOTS = 4

#: Unter diesem Preisabstand [ct/kWh] ist die Wertfunktion Rauschen - der Test
#: ``p_imp > v_left`` mit einer Toleranz gegen Gleitkomma-Staub.
PRICE_SPREAD_EPS_CT = 1e-4

#: Unter dieser Menge [kWh] ist eine Stufe keine Aussage (Solver-Staub).
LEVEL_EPS_KWH = 1e-3

#: Die Lage, in der die Prognose des Plans SELBST steht: der Median. Sie ist
#: der Bezugspunkt der ersten Stufe, deren Kosten deshalb 0 sind - was der Plan
#: ohnehin erwartet, kostet ihn nichts extra.
MEDIAN_Q = 0.5


@dataclass(frozen=True)
class NightErrorQuantiles:
    """Die Nacht-Fehlerverteilung EINER Anlage, wie der Plan sie kennt.

    ``quantiles`` bildet das angefragte Quantil auf den relativen Fehler ab
    (``+0,121`` = in dieser Quantilslage brauchte die Nacht 12,1 % mehr Energie
    als prognostiziert). ``nights`` ist die Zahl vollständiger Nächte, auf denen
    das ruht, ``model_id`` das Lastmodell, dessen Prognosen verglichen wurden -
    ein Modellwechsel macht die alte Verteilung ungültig, und wer sie liest,
    soll das SEHEN können.
    """

    quantiles: dict[float, float]
    nights: int
    model_id: str

    @property
    def qs(self) -> tuple[float, ...]:
        """Die Quantilslagen, aufsteigend."""
        return tuple(sorted(self.quantiles))

    def level(self, q: float) -> float:
        """Der relative Fehler in der Quantilslage ``q``."""
        return self.quantiles[q]


def quantile(values: list[float], p: float) -> float | None:
    """Linear interpoliertes ``p``-Quantil (die Definition des Harness -
    R-Typ 7, dieselbe wie ``numpy.percentile``). ``None`` für leer."""
    v = sorted(values)
    if not v:
        return None
    i = p * (len(v) - 1)
    lo = int(i)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)


# ---------------------------------------------------------------------------
# P3a: die Fehlerverteilung je Anlage (der DB-Lesepfad)
# ---------------------------------------------------------------------------


def night_error_quantiles(
    dsn: str,
    site,
    now: datetime,
    model_id: str,
    nights: int = 28,
    min_nights: int = 7,
    window: tuple[int, int] = DEFAULT_WINDOW,
    qs: tuple[float, ...] = DEFAULT_QUANTILES,
) -> NightErrorQuantiles | None:
    """Die Quantile des relativen Nacht-Lastfehlers dieser Anlage, oder ``None``.

    ``site`` ist die :class:`~voltpilot_optimization.inputs.BatterySite` (es
    werden nur ``site_id``/``tenant_id`` gebraucht), ``model_id`` das AKTIVE
    Lastmodell dieser Anlage. Gelesen werden die letzten ``nights``
    abgeschlossenen Nächte vor ``now``; jede Nacht liefert genau einen Punkt::

        rel = Σ gemessen / Σ prognostiziert − 1

    ``gemessen`` ist das Viertelstunden-MITTEL von ``telemetry.load_kw`` (die
    ``MeasuredSlots``-Größe der api - dieselbe, die ``load_kw`` prognostiziert;
    gelesen aus dem 15-min-Rollup, siehe :func:`_measured_load_slots`),
    ``prognostiziert`` sind die ``forecast``-Zeilen desselben Modells aus dem
    Abend-Lauf um 17:45 (+- 15 min) des Vortags. Eine Nacht mit weniger als
    :data:`MIN_SLOTS_PER_NIGHT` gepaarten Viertelstunden zählt nicht mit.

    ``None`` (statt einer dünnen Verteilung) sobald weniger als ``min_nights``
    vollständige Nächte zusammenkommen: eine Verteilung aus drei Nächten wäre
    eine erfundene Wahrscheinlichkeit, und der Plan soll dann exakt so laufen
    wie vor dieser Stufe.
    """
    import psycopg  # lazy: optional [db] extra

    now = _utc(now)
    windows = _night_windows(now, nights, window)
    if not windows:
        return None
    oldest = windows[-1][0]
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        measured = _measured_load_slots(cur, site.site_id, oldest, now)
        forecasts = _evening_forecasts(cur, site.site_id, model_id, windows)
    rels = night_error_rels(windows, measured, forecasts)
    if len(rels) < min_nights:
        logger.debug(
            "night_reserve.too_few_nights",
            extra={
                "context": {
                    "site_id": str(site.site_id),
                    "nights": len(rels),
                    "min_nights": min_nights,
                }
            },
        )
        return None
    return quantiles_of(rels, qs, model_id)


def night_error_rels(
    windows: list[tuple[datetime, datetime]],
    measured: dict[datetime, float],
    forecasts: dict[datetime, dict[datetime, float]],
) -> list[float]:
    """Der relative Energie-Fehler je VOLLSTÄNDIGER Nacht, ``Σ gemessen /
    Σ prognostiziert − 1``.

    Die reine Hälfte von :func:`night_error_quantiles` (dieselbe Trennung wie
    bei ``MeasuredSlots`` in der api: Fensterarithmetik Docker-frei, nur die
    Aggregation in SQL). Eine Nacht mit weniger als
    :data:`MIN_SLOTS_PER_NIGHT` gepaarten Viertelstunden wird VERWORFEN, nicht
    hochgerechnet - ein Quotient über zwei verschieden langen Fenstern wäre
    kein Fehler, sondern ein Vergleich zweier verschiedener Nächte.
    """
    rels: list[float] = []
    for start, end in windows:
        predicted = forecasts.get(start)
        if not predicted:
            continue
        act = fc = 0.0
        paired = 0
        slot = start
        while slot < end:
            m = measured.get(slot)
            f = predicted.get(slot)
            if m is not None and f is not None:
                act += m
                fc += f
                paired += 1
            slot += timedelta(minutes=15)
        if paired >= MIN_SLOTS_PER_NIGHT and fc > 0.0:
            rels.append(act / fc - 1.0)
    return rels


def quantiles_of(
    rels: list[float], qs: tuple[float, ...], model_id: str
) -> NightErrorQuantiles | None:
    """Die linear interpolierten Quantile über den Nacht-Fehlern, oder ``None``
    für eine leere Liste. Der ``min_nights``-Test gehört dem Aufrufer - er ist
    eine Aussage über BELEGBARKEIT, nicht über Arithmetik."""
    quantiles = {}
    for q in qs:
        value = quantile(rels, q)
        if value is None:
            return None
        quantiles[q] = value
    return NightErrorQuantiles(
        quantiles=quantiles, nights=len(rels), model_id=model_id
    )


def _utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _night_windows(
    now: datetime, nights: int, window: tuple[int, int]
) -> list[tuple[datetime, datetime]]:
    """Die ``nights`` jüngsten ABGESCHLOSSENEN Nacht-Fenster vor ``now``,
    neueste zuerst. Fenstergrenzen sind Berliner Ortszeit (die Nacht ist ein
    Kalender-Begriff; über die Zeitumstellung hinweg ist sie eine Stunde
    länger oder kürzer, und genau so soll sie gemessen werden)."""
    from_hour, to_hour = window
    today = now.astimezone(BERLIN).date()
    out: list[tuple[datetime, datetime]] = []
    for back in range(1, nights + 11):
        if len(out) >= nights:
            break
        day = today - timedelta(days=back)
        start = datetime.combine(day, time(from_hour), tzinfo=BERLIN).astimezone(
            timezone.utc
        )
        end = datetime.combine(
            day + timedelta(days=1), time(to_hour), tzinfo=BERLIN
        ).astimezone(timezone.utc)
        if end > now:
            continue
        out.append((start, end))
    return out


def _measured_load_slots(
    cur, site_id: UUID, since: datetime, until: datetime
) -> dict[datetime, float]:
    """Das Viertelstunden-MITTEL von ``telemetry.load_kw`` je Slot - dieselbe
    Größe, die ``load_kw`` prognostiziert (die ``MeasuredSlots``-Semantik der
    api).

    Gelesen aus ``telemetry_rollup_15m`` (``load_kwh * 4.0`` IST dieses Mittel,
    das Rollup rechnet ``avg(load_kw) * 0.25``; dasselbe Muster wie
    ``inputs._peak_so_far_kw``), NICHT aus dem rohen ``telemetry``. Die api
    liest dort roh, weil sie den LAUFENDEN Slot braucht und die Rollups ihrem
    Refresh bis zu einer Viertelstunde hinterherhinken - hier gibt es keinen
    laufenden Slot: jede bewertete Nacht ist Stunden bis Wochen alt. Dafür
    kostet die Lesung ~1500 Zeilen statt einer halben Million roher Messungen
    je Anlage und Takt, und die Rollups überleben die Retention des rohen
    ``telemetry`` (V20260831020000).

    Eine Viertelstunde ohne Rollup-Zeile fehlt schlicht; fehlen zu viele, wird
    die ganze NACHT verworfen (:func:`night_error_rels`) - nie hochgerechnet.
    """
    cur.execute(
        """
        SELECT bucket, load_kwh * 4.0 AS mean_kw FROM telemetry_rollup_15m
        WHERE site_id = %s AND load_kwh IS NOT NULL
          AND bucket >= %s AND bucket < %s
        """,
        (site_id, since, until),
    )
    return {_utc(ts): float(v) for ts, v in cur.fetchall() if v is not None}


def _evening_forecasts(
    cur, site_id: UUID, model_id: str, windows: list[tuple[datetime, datetime]]
) -> dict[datetime, dict[datetime, float]]:
    """Je Nacht die Last-Prognose des ABEND-LAUFS um 17:45 (+- 15 min) des
    Vortags, gekeyt auf den Fensteranfang.

    Der Lauf ist bewusst gepinnt statt „die frischeste Prognose je Slot": die
    Fehlerverteilung soll beschreiben, wie gut der Plan die Nacht am Abend
    VORHERSAH - mit den Nachkorrekturen der Nacht gemessen wäre sie
    systematisch zu schön und die Reserve zu klein.
    """
    if not windows:
        return {}
    oldest = min(start for start, _ in windows)
    newest = max(end for _, end in windows)
    cur.execute(
        """
        SELECT run_at, time, value_kw FROM forecast
        WHERE site_id = %s AND kind = 'load' AND model = %s
          AND time >= %s AND time < %s
        ORDER BY run_at
        """,
        (site_id, model_id, oldest, newest),
    )
    by_run: dict[datetime, dict[datetime, float]] = {}
    for run_at, ts, value in cur.fetchall():
        by_run.setdefault(_utc(run_at), {})[_utc(ts)] = float(value)
    out: dict[datetime, dict[datetime, float]] = {}
    for start, end in windows:
        target = _evening_run_target(start)
        candidates = [r for r in by_run if abs(r - target) <= RUN_TOLERANCE]
        if not candidates:
            continue
        # Bei zwei Läufen im Fenster gewinnt der, der 17:45 am nächsten liegt -
        # niemals „der neuere", sonst wandert die Definition mit dem Takt.
        best = min(candidates, key=lambda r: (abs(r - target), r))
        window_slots = {
            ts: v for ts, v in by_run[best].items() if start <= ts < end
        }
        if window_slots:
            out[start] = window_slots
    return out


def _evening_run_target(window_start: datetime) -> datetime:
    """17:45 Berliner Zeit des Tages, an dem das Nacht-Fenster beginnt."""
    day = window_start.astimezone(BERLIN).date()
    return datetime.combine(
        day, time(RUN_HOUR, RUN_MINUTE), tzinfo=BERLIN
    ).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# P3b: die reine Rechnung der Wertfunktion (solver-frei)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NightReserveTerms:
    """Die fertig gerechnete Wertfunktion EINES Laufs - alles, was ein Solver
    braucht, um die Variablen ``vf_s[k]`` und die Nebenbedingung ``vf_c[k]``
    aufzuspannen, und alles, was die Erklär-Schicht danach aussagen darf."""

    #: Der Slot des Sonnenaufgangs (erster Überschuss-Slot NACH der Nacht) -
    #: der EINE Knoten, über dem die Wertfunktion lebt.
    i1: int
    #: Der erste Nicht-Überschuss-Slot (Beginn der bewerteten Nacht).
    i0: int
    #: Gespeicherte kWh, die die Nacht laut Prognose zieht (schon durch eta).
    d_rest_kwh: float
    #: Mittlerer Bezugspreis der Nacht [ct/kWh].
    p_imp_ct: float
    #: Der Wert der kWh, die nach Sonnenaufgang übrig bleibt [ct/kWh].
    v_left_ct: float
    #: Die Quantilslagen (aufsteigend, ``q[0] = 0,5``).
    q: tuple[float, ...]
    #: Die Stufen L_k [kWh über dem Boden].
    levels_kwh: tuple[float, ...]
    #: Die Stufenkosten c_k [EUR/kWh] - ``c[0]`` ist per Konstruktion 0.
    coefficients_eur_kwh: tuple[float, ...]
    #: Der Boden, gegen den ``soc[i1]`` gerechnet wird (Reservestapel inkl.
    #: Backup/Peak) [kWh].
    soc_floor_kwh: float

    @property
    def levels(self) -> int:
        return len(self.levels_kwh)


def night_reserve_terms(
    load_kw: list[float],
    pv_kw: list[float],
    import_price_eur_mwh: list[float],
    export_value_eur_mwh: list[float],
    slot_hours: float,
    one_way_efficiency: float,
    soc_floor_kwh: float,
    errors: NightErrorQuantiles | None,
) -> NightReserveTerms | None:
    """Die Wertfunktion für EINEN Lauf, oder ``None`` = kein Term.

    ``None`` (und damit ein byte-identischer Plan) in JEDEM dieser Fälle:
    keine Fehlerverteilung, keine Nacht im Horizont, eine Nacht kürzer als
    :data:`MIN_NIGHT_SLOTS`, kein Überschuss-Slot NACH der Nacht (der
    Winterhorizont - dort trägt der Terminalwert allein), keine Nachtlast, oder
    kein Preisabstand (``p_imp <= v_left``; der ``ohne``-Tarif und die
    dynamische Nacht unter dem Verkaufspreis). Die Prüfungen stehen in dieser
    Reihenfolge, weil jede die nächste erst sinnvoll macht.
    """
    if errors is None:
        return None
    n = len(load_kw)
    surplus = [pv_kw[t] > load_kw[t] + SURPLUS_DEADBAND_KW for t in range(n)]
    i0 = 0
    while i0 < n and surplus[i0]:
        i0 += 1
    i1 = i0
    while i1 < n and not surplus[i1]:
        i1 += 1
    if i0 >= n or i1 >= n or i1 - i0 < MIN_NIGHT_SLOTS:
        return None
    if one_way_efficiency <= 0.0:  # pragma: no cover - defensive
        return None
    d_rest = (
        sum(max(load_kw[t] - pv_kw[t], 0.0) for t in range(i0, i1))
        * slot_hours
        / one_way_efficiency
    )
    if d_rest <= 0.0:
        return None
    p_imp = sum(import_price_eur_mwh[i0:i1]) / (i1 - i0) / 10.0
    later = [
        max(export_value_eur_mwh[t], 0.0) / 10.0 for t in range(i1, n) if surplus[t]
    ]
    v_left = min(later) if later else p_imp
    spread = p_imp - v_left
    if spread <= PRICE_SPREAD_EPS_CT:
        return None
    qs = errors.qs
    levels = tuple(max(0.0, errors.level(q)) * d_rest for q in qs)
    coefficients = tuple(
        spread
        / 100.0
        * (
            (q - (qs[k - 1] if k > 0 else MEDIAN_Q))
            + (1.0 - q if k == len(qs) - 1 else 0.0)
        )
        for k, q in enumerate(qs)
    )
    return NightReserveTerms(
        i1=i1,
        i0=i0,
        d_rest_kwh=d_rest,
        p_imp_ct=p_imp,
        v_left_ct=v_left,
        q=qs,
        levels_kwh=levels,
        coefficients_eur_kwh=coefficients,
        soc_floor_kwh=soc_floor_kwh,
    )


#: Wo ein gebautes Modell seine Wertfunktion trägt. Ein schlichtes Attribut
#: (keine Pyomo-Komponente): die Terme sind ein EINGABE-Fakt darüber, wie das
#: Ziel bepreist wurde, keine Entscheidungsvariable - und die Erklär-Schicht
#: muss sie aus einem Modell lesen können, das sie nicht anfassen darf.
_MODEL_ATTR = "_vp_night_reserve"


def stash_night_reserve(model, terms: NightReserveTerms | None) -> None:
    """Hinterlege die Wertfunktion dieses Laufs am Modell (siehe
    :data:`_MODEL_ATTR`)."""
    setattr(model, _MODEL_ATTR, terms)


def night_reserve_of(model) -> NightReserveTerms | None:
    """Die Wertfunktion, die ein gebautes Modell trägt, oder ``None``."""
    return getattr(model, _MODEL_ATTR, None)


def held_level(terms: NightReserveTerms, soc_at_sunrise_kwh: float) -> tuple[float, float] | None:
    """Die HÖCHSTE Stufe, die der gelöste Plan bei Sonnenaufgang tatsächlich
    deckt, als ``(kWh, q)`` - der Erklär-Fakt, den das Portal in einen Satz
    setzt („hält bis zu 4,9 kWh … in 1 von 4 Nächten nötig").

    Sie beschreibt das ERGEBNIS des Laufs, nie seine Absicht: gedeckt heißt,
    der Ladestand über dem Boden erreicht die Stufe. ``None``, wenn nicht
    einmal eine Stufe über 0 gedeckt ist - dann hält der Plan nichts zurück
    und es gibt nichts zu sagen.
    """
    slack = soc_at_sunrise_kwh - terms.soc_floor_kwh
    best: tuple[float, float] | None = None
    for level, q in zip(terms.levels_kwh, terms.q):
        if level > LEVEL_EPS_KWH and level <= slack + LEVEL_EPS_KWH:
            best = (level, q)
    return best
