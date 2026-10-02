"""MiSpeL MP-13b: der MiSpeL-Check je Anlage gerechnet und abgelegt.

Rechnet den Check von MP-13 (:func:`voltpilot_optimization.simulation.mispel_check.mispel_check`)
für jede echte Anlage mit Speicher und legt das Ergebnis in ``site_mispel_check`` ab
(Vertrag ``docs/contracts/v2/mispel-check.md`` § 6): vor dem Rechnen ``wird_gerechnet``
(Beträge leer), danach ``fertig`` mit allen Beträgen oder ``fehlgeschlagen`` /
``nicht_unterstuetzt`` mit einem Satz in ``hinweis`` - immer mit neuem ``stand_seit``.

**Auslöser** ist ein eigener Lauf (``python -m voltpilot_optimization mispel-check``), kein
Dienst: er rechnet nur Anlagen ohne aktuelles Ergebnis (keine Zeile, verwaist in
``wird_gerechnet``, neues Preisfenster, geänderte Datenbasis, ein Fehlschlag älter als
:data:`FEHLSCHLAG_WARTEN`) und davon höchstens ``max_anlagen`` je Lauf. Ein Postgres-
Advisory-Lock lässt nie zwei Läufe zugleich rechnen. Der Lauf ist ein eigener Prozess
neben ``simulate-serve`` - der Simulations-JobStore (ein Auftrag zur Zeit) bleibt frei -
und rechnet mit höchstens :data:`MAX_WORKERS` Solver-Prozessen.

**Datenbasis je Anlage** (Vertrag § 4): Stammdaten aus derselben Auflösung wie der
Optimierer (:func:`voltpilot_optimization.inputs.load_battery_sites`); Jahresverbrauch und
Erzeugung **gemessen** aus dem Tagesverlauf (``telemetry_rollup_1d``) des Fensters, wenn er
mindestens :data:`DECKUNG_MIN` der Tage deckt, sonst ``angenommen`` mit Quelle; der
Formelsatz ist der gewählte (``site_foerderweg``) oder - solange keiner gewählt ist - der
aus den Zählerrollen der Anlage nach dem Gebot der Bestnutzung (Anlage 1 Abschn. 3.2.3,
S. 24; wie der Formelsatz-Vorschlag aus MP-17), dann ``angenommen``. Formelsätze, die
MP-13 nicht rechnet, bekommen ``nicht_unterstuetzt`` mit Satz statt einer Näherung.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from typing import Callable
from uuid import UUID

from voltpilot_optimization.simulation import mispel_check as mc
from voltpilot_optimization.simulation.data import BERLIN

logger = logging.getLogger("voltpilot.simulation.mispel_check_lauf")

#: Das Fenster: die letzten zwölf vollen Kalendermonate (Vertrag § 2, tagesgenau
#: einschließlich des letzten Tages).
FENSTER_MONATE = 12
#: Ab diesem Anteil der Tage des Fensters mit Verlauf gilt eine Jahresmenge als gemessen.
DECKUNG_MIN = 0.9
#: Höchstens zwei Solver-Prozesse: der Lauf darf die Maschine nicht fluten.
MAX_WORKERS = 2
#: Ein Fehlschlag wird frühestens nach dieser Zeit neu versucht (sonst bei jeder neuen Datenbasis).
FEHLSCHLAG_WARTEN = timedelta(hours=20)
#: Unter diesem Verbrauch im Fenster (kWh) ist die Anlage ohne sonstigen Verbrauch (A10).
KEIN_VERBRAUCH_KWH = 1.0
#: Der Schlüssel des Advisory-Locks: nie zwei Läufe zugleich.
LOCK_SCHLUESSEL = 0x4D53504C13B  # "MSPL" 13b

#: Annahmen ohne Messung oder Stammdaten (Konzept § 3, Gewerbe-Kundentypen a2/b).
JAHRESVERBRAUCH_ANGENOMMEN_KWH = 60_000.0
QUELLE_VERBRAUCH = "Konzept § 3 a2 (Gewerbe)"

STAND_WIRD_GERECHNET = "wird_gerechnet"
STAND_FERTIG = "fertig"
STAND_FEHLGESCHLAGEN = "fehlgeschlagen"
STAND_NICHT_UNTERSTUETZT = "nicht_unterstuetzt"

#: Die Posten von MP-13 auf das geschlossene Vokabular ``art`` (Vertrag § 3).
POSTEN_ART = {
    "Netzladen-Handel mit Saldierung": "handel_saldierung",
    "Handel mit Saldierung (MiSpeL)": "handel_saldierung",
    "abzüglich Handel heute ohne Saldierung": "handel_heute",
    "Jahresmarktwert statt Monatsmarktwert": "jahresmarktwert",
    "Zweiter Zähler Z2": "zaehler_z2",
    "Gesonderter Bilanzkreis": "bilanzkreis",
    "Mehr Vermarktungsentgelt auf die zusätzliche Rückspeisung": "vermarktungsentgelt",
}

FEHLGESCHLAGEN_SATZ = "Der Check konnte für diese Anlage nicht gerechnet werden"


# ---------------------------------------------------------------------------
# Fenster
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Fenster:
    beginn: tuple[int, int]
    monate: int
    von: date
    bis: date

    @property
    def tage(self) -> int:
        return (self.bis - self.von).days + 1


def fenster(heute: date, monate: int = FENSTER_MONATE) -> Fenster:
    """Die letzten ``monate`` vollen Kalendermonate vor ``heute`` (Berliner Tag)."""
    erster = heute.replace(day=1)
    bis = erster - timedelta(days=1)
    jahr, monat = erster.year, erster.month - monate
    while monat <= 0:
        jahr, monat = jahr - 1, monat + 12
    return Fenster((jahr, monat), monate, date(jahr, monat, 1), bis)


# ---------------------------------------------------------------------------
# Datenbasis und Formelsatz (rein, ohne Datenbank)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Stammdaten:
    """Was die Datenbank je Anlage liefert."""

    tenant_id: UUID
    site_id: UUID
    zone: str
    speicher_kwh: float
    speicher_kw: float
    foerderweg: str
    formelsatz: str | None  # gewählt (site_foerderweg), sonst None
    pv_kwp: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    anzulegender_wert_ct: float | None = None
    zaehler: frozenset[str] = frozenset()
    netzentgelt_arbeitspreis_ct: float | None = None
    umlagen_ct: float | None = None
    konzessionsabgabe_ct: float | None = None
    ust_pct: float | None = None
    #: Verlauf im Fenster: Tage mit Wert und Summe (kWh), je Größe.
    verbrauch_tage: int = 0
    verbrauch_kwh: float = 0.0
    erzeugung_tage: int = 0
    erzeugung_kwh: float = 0.0


@dataclass(frozen=True)
class Eingang:
    """Was der Lauf für eine Anlage rechnet: Formelsatz, Anlage oder Satz, Datenbasis."""

    formelsatz: str | None
    datenbasis: list[dict]
    anlage: mc.CheckAnlage | None = None
    stand: str | None = None  # gesetzt = ohne Rechnung abzulegen
    hinweis: str | None = None


def _angabe(angabe: str, wert, einheit: str | None, herkunft: str, quelle: str | None) -> dict:
    return {"angabe": angabe, "wert": wert, "einheit": einheit, "herkunft": herkunft, "quelle": quelle}


def _datum(tag: date) -> str:
    return tag.strftime("%d.%m.%Y")


def _gemessen(tage: int, kwh: float, f: Fenster) -> float | None:
    """Die Jahresmenge aus dem Verlauf, aufs Fenster und ein Jahr hochgerechnet - None ohne Deckung."""
    if tage < DECKUNG_MIN * f.tage:
        return None
    return round(kwh * f.tage / tage * 12 / f.monate)


def _messquelle(tage: int, f: Fenster) -> str:
    return (f"Verlauf {_datum(f.von)}–{_datum(f.bis)}, {tage} von {f.tage} Tagen"
            + ("" if tage == f.tage else ", aufs Fenster hochgerechnet"))


def formelsatz_angenommen(st: Stammdaten, mit_verbrauch: bool) -> tuple[str, str]:
    """Der Formelsatz aus den Zählerrollen, solange die Anlage keinen gewählt hat:
    das Gebot der Bestnutzung (A1 S. 24, Abschn. 3.2.3) wie der Vorschlag aus MP-17.
    Liefert (Formelsatz, Quelle)."""
    z1z2 = {"Z1", "Z2"} <= st.zaehler
    if st.pv_kwp:
        if z1z2 and "Z3" in st.zaehler:
            return "A4", "Zähler Z1, Z2 und Z3: Basisfall A4 (Gebot der Bestnutzung, A1 S. 24)"
        if z1z2:
            return "A1", "Zähler Z1 und Z2: Basisfall A1 (Gebot der Bestnutzung, A1 S. 24)"
        return "A1", ("Basisfall A1 für Erzeugungsanlage mit Speicher; Z2 fehlt noch, "
                      "seine Kosten stehen im Posten „Zweiter Zähler Z2“ (A1 S. 32–33)")
    if z1z2:
        # Mit Z1 und Z2 sind die vereinfachten A10/A11 ausgeschlossen (A1 S. 24).
        return "A1", "Zähler Z1 und Z2: vereinfachte A10/A11 nicht anwendbar (Gebot der Bestnutzung, A1 S. 24)"
    if mit_verbrauch:
        return "A11", "Speicher ohne sonstige Erzeugung, mit sonstigem Verbrauch: Sonderfall A11 (A1 Abschn. 10.3.1)"
    return "A10", "Rein netzgekoppelter Speicher ohne sonstigen Verbrauch: Sonderfall A10 (A1 Abschn. 10.2.1)"


def eingang(st: Stammdaten, f: Fenster) -> Eingang:
    """Die Eingabe des Checks für eine Anlage und ihre Datenbasis (Vertrag § 4)."""
    basis = mc.CheckAnlage(formelsatz="A1", speicher_kwh=0.0, speicher_kw=0.0)
    db: list[dict] = [
        _angabe("Förderweg", st.foerderweg, None, "stammdaten", "site_foerderweg, sonst Bestand"),
        _angabe("Speicher", round(st.speicher_kwh, 1), "kWh", "stammdaten", None),
        _angabe("Speicherleistung", round(st.speicher_kw, 1), "kW", "stammdaten", None),
    ]

    verbrauch = _gemessen(st.verbrauch_tage, st.verbrauch_kwh, f)
    if verbrauch is not None:
        db.append(_angabe("Jahresverbrauch", verbrauch, "kWh", "gemessen", _messquelle(st.verbrauch_tage, f)))

    if st.formelsatz is not None:
        formelsatz = st.formelsatz
        db.append(_angabe("Formelsatz", formelsatz, None, "stammdaten", "gewählt im Förderweg"))
    else:
        mit_verbrauch = verbrauch is None or verbrauch >= KEIN_VERBRAUCH_KWH
        formelsatz, quelle = formelsatz_angenommen(st, mit_verbrauch)
        db.append(_angabe("Formelsatz", formelsatz, None, "angenommen", quelle))

    if formelsatz not in mc.CHECK_FORMELSAETZE:
        return Eingang(formelsatz, db, stand=STAND_NICHT_UNTERSTUETZT, hinweis=(
            f"Formelsatz {formelsatz}: {mc.NICHT_UNTERSTUETZT}. Der Check rechnet "
            f"{', '.join(mc.CHECK_FORMELSAETZE)}."))

    a1 = formelsatz == "A1"
    if a1 and not st.pv_kwp:
        return Eingang(formelsatz, db, stand=STAND_NICHT_UNTERSTUETZT, hinweis=(
            "Der Check rechnet A1 nur mit einer Erzeugungsanlage; diese Anlage hat keine."))
    if a1 and st.anzulegender_wert_ct is None:
        return Eingang(formelsatz, db, stand=STAND_NICHT_UNTERSTUETZT, hinweis=(
            "Der Check rechnet A1 mit der Marktprämie auf den anzulegenden Wert; "
            "für diese Anlage ist keiner hinterlegt."))
    if not a1 and st.pv_kwp:
        return Eingang(formelsatz, db, stand=STAND_FEHLGESCHLAGEN, hinweis=(
            f"{formelsatz} gilt nur ohne sonstige Erzeugung (A1 Abschn. 10.2.1, 10.3.1); "
            "diese Anlage hat eine PV-Anlage."))

    if formelsatz == "A10":
        if verbrauch is not None and verbrauch >= KEIN_VERBRAUCH_KWH:
            return Eingang(formelsatz, db, stand=STAND_FEHLGESCHLAGEN, hinweis=(
                "A10 gilt nur ohne sonstigen Verbrauch (A1 Abschn. 10.2.1); "
                f"gemessen sind {verbrauch:,.0f} kWh im Jahr.".replace(",", ".")))
        jahresverbrauch = 0.0
    elif verbrauch is not None:
        jahresverbrauch = float(verbrauch)
    else:
        jahresverbrauch = JAHRESVERBRAUCH_ANGENOMMEN_KWH
        db.append(_angabe("Jahresverbrauch", round(jahresverbrauch), "kWh", "angenommen", QUELLE_VERBRAUCH))
    if jahresverbrauch > 0:
        db.append(_angabe("Lastgang", "Gewerbe", None, "angenommen", "Gewerbeprofil der Simulation (Konzept § 3)"))

    erzeugung = None
    if a1:
        db.append(_angabe("PV-Leistung", round(float(st.pv_kwp), 1), "kWp", "stammdaten", None))
        db.append(_angabe("Anzulegender Wert", round(float(st.anzulegender_wert_ct), 3), "ct/kWh",
                          "stammdaten", None))
        erzeugung = _gemessen(st.erzeugung_tage, st.erzeugung_kwh, f)
        if erzeugung is not None:
            db.append(_angabe("Erzeugung im Jahr", erzeugung, "kWh", "gemessen",
                              _messquelle(st.erzeugung_tage, f)))
        else:
            db.append(_angabe("Erzeugung im Jahr", None, None, "angenommen",
                              "aus PV-Leistung und Wetter des Fensters, Ausrichtung Süd 30°"))
        if st.latitude is None or st.longitude is None:
            db.append(_angabe("Standort", f"{basis.latitude}° N, {basis.longitude}° O", None, "angenommen",
                              "Standard der Simulation, kein Standort hinterlegt"))
        else:
            db.append(_angabe("Standort", f"{st.latitude:.2f}° N, {st.longitude:.2f}° O", None,
                              "stammdaten", None))

    preise = (
        ("Netzentgelt-Arbeitspreis", "netzentgelt_arbeitspreis_ct", "ct/kWh", "Konzept § 3 (Gewerbe)"),
        ("Umlagen", "umlagen_ct", "ct/kWh", "R3 § 2.2"),
        ("Konzessionsabgabe", "konzessionsabgabe_ct", "ct/kWh", "KAV Sondervertrag"),
        ("Umsatzsteuer", "ust_pct", "%", "Gewerbe mit Vorsteuerabzug"),
    )
    werte = {}
    for angabe, feld, einheit, quelle in preise:
        wert = getattr(st, feld)
        if wert is None:
            werte[feld] = getattr(basis, feld)
            db.append(_angabe(angabe, werte[feld], einheit, "angenommen", quelle))
        else:
            werte[feld] = float(wert)
            db.append(_angabe(angabe, werte[feld], einheit, "stammdaten", "Preisblatt der Anlage"))

    anlage = replace(
        basis,
        formelsatz=formelsatz,
        speicher_kwh=float(st.speicher_kwh),
        speicher_kw=float(st.speicher_kw),
        pv_kwp=float(st.pv_kwp) if a1 else 0.0,
        latitude=st.latitude if st.latitude is not None else basis.latitude,
        longitude=st.longitude if st.longitude is not None else basis.longitude,
        jahresverbrauch_kwh=jahresverbrauch,
        anzulegender_wert_ct=float(st.anzulegender_wert_ct) if a1 else None,
        pv_jahreserzeugung_kwh=float(erzeugung) if erzeugung is not None else None,
        zone=st.zone,
        **werte,
    )
    return Eingang(formelsatz, db, anlage=anlage)


def ergebnis_zeile(result: dict) -> dict:
    """Beträge und Posten aus dem Ergebnis von MP-13 (Vertrag §§ 2-3)."""
    faelle = result["faelle"]
    fehlt = [name for name in mc.FAELLE if name not in faelle]
    if fehlt:
        raise ValueError(f"es fehlen Fälle: {', '.join(fehlt)}")
    posten: dict[str, dict] = {}
    for name in mc.FAELLE:
        for p in faelle[name]["posten"]:
            art = POSTEN_ART.get(p["posten"])
            if art is None:
                raise ValueError(f"unbekannter Posten von MP-13: {p['posten']}")
            zeile = posten.setdefault(art, {"art": art, "niedrig_eur": None, "mittel_eur": None,
                                            "hoch_eur": None, "herkunft": p["herkunft"]})
            zeile[f"{name}_eur"] = p["eur"] + 0.0  # nie „-0.0“: die Datenbank kennt keine negative Null
    return {
        "differenz": {name: result["spanne"][name] + 0.0 for name in mc.FAELLE},
        "posten": list(posten.values()),
        "fenster_von": result["fenster"]["von"],
        "fenster_bis": result["fenster"]["bis"],
    }


@dataclass(frozen=True)
class Zeile:
    """Der abgelegte Stand einer Anlage (was der Lauf zum Vergleich liest)."""

    stand: str
    stand_seit: datetime
    formelsatz: str | None
    fenster_bis: date | None
    datenbasis: list


def grund(alt: Zeile | None, e: Eingang, f: Fenster, jetzt: datetime) -> str | None:
    """Warum die Anlage (neu) zu rechnen ist - ``None`` = das Ergebnis ist aktuell.

    Der Lauf hält den Advisory-Lock: ein ``wird_gerechnet`` ohne ihn ist verwaist."""
    if alt is None:
        return "noch nie gerechnet"
    if alt.stand == STAND_WIRD_GERECHNET:
        return "verwaist in wird_gerechnet"
    if alt.formelsatz != e.formelsatz or alt.datenbasis != e.datenbasis:
        return "Datenbasis geändert"
    if alt.stand == STAND_FERTIG and alt.fenster_bis != f.bis:
        return "neues Preisfenster"
    if alt.stand == STAND_FEHLGESCHLAGEN and jetzt - alt.stand_seit >= FEHLSCHLAG_WARTEN:
        return "neuer Versuch nach Fehlschlag"
    return None


# ---------------------------------------------------------------------------
# Datenbank
# ---------------------------------------------------------------------------


def _zaehler(cur, site_id: UUID, tag: date) -> frozenset[str]:
    """Die Zählerrollen der Messstellen, die am Tag an der Anlage stehen (MP-6;
    je Messstelle die Fassung mit dem letzten „gültig ab“ ≤ Tag)."""
    import psycopg  # lazy: optional [db] extra

    try:
        cur.execute(
            """
            SELECT DISTINCT ON (zr.messstelle_id) zr.rolle
            FROM messstelle_stellung ms
            JOIN messstelle_zaehlerrolle zr
              ON zr.messstelle_id = ms.messstelle_id AND zr.aufgehoben_am IS NULL AND zr.gueltig_ab <= %(tag)s
            WHERE ms.site_id = %(site)s AND ms.aufgehoben_am IS NULL AND ms.gueltig_ab <= %(tag)s
              AND (ms.gueltig_bis IS NULL OR ms.gueltig_bis >= %(tag)s)
            ORDER BY zr.messstelle_id, zr.gueltig_ab DESC, zr.created_at DESC
            """,
            {"site": site_id, "tag": tag},
        )
    except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn):
        cur.connection.rollback()
        return frozenset()
    return frozenset(r for (r,) in cur.fetchall() if r is not None)


def _verlauf(cur, site_id: UUID, f: Fenster) -> tuple[int, float, int, float]:
    """Tage mit Wert und Summe von Verbrauch und Erzeugung im Fenster (Tagesverlauf)."""
    import psycopg  # lazy: optional [db] extra

    von = datetime(f.von.year, f.von.month, f.von.day, tzinfo=BERLIN)
    bis = datetime.combine(f.bis + timedelta(days=1), datetime.min.time(), tzinfo=BERLIN)
    try:
        cur.execute(
            """
            SELECT count(load_kwh), COALESCE(sum(load_kwh), 0), count(pv_kwh), COALESCE(sum(pv_kwh), 0)
            FROM telemetry_rollup_1d
            WHERE site_id = %s AND bucket >= %s AND bucket < %s AND n_samples > 0
            """,
            (site_id, von, bis),
        )
    except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn):
        cur.connection.rollback()
        return 0, 0.0, 0, 0.0
    tv, sv, te, se = cur.fetchone()
    return int(tv), float(sv), int(te), float(se)


def lade_stammdaten(dsn: str, f: Fenster, heute: date, site_id: UUID | None = None) -> list[Stammdaten]:
    """Je Anlage mit Speicher die Stammdaten (wie der Optimierer), Zählerrollen und Verlauf."""
    import psycopg  # lazy: optional [db] extra

    from voltpilot_optimization.inputs import load_battery_sites

    sites = load_battery_sites(dsn, site_id)
    out = []
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        for s in sites:
            sp = s.tariff.supply_price
            tv, sv, te, se = _verlauf(cur, s.site_id, f)
            out.append(Stammdaten(
                tenant_id=s.tenant_id,
                site_id=s.site_id,
                zone=s.bidding_zone,
                speicher_kwh=s.battery.capacity_kwh,
                speicher_kw=min(s.battery.max_charge_kw, s.battery.max_discharge_kw),
                foerderweg=s.foerderweg,
                formelsatz=s.formelsatz,
                pv_kwp=s.tariff.pv_capacity_kwp,
                latitude=s.latitude,
                longitude=s.longitude,
                anzulegender_wert_ct=s.tariff.anzulegender_wert_ct_kwh,
                zaehler=_zaehler(cur, s.site_id, heute),
                netzentgelt_arbeitspreis_ct=sp.netzentgelt_arbeitspreis_ct if sp else None,
                umlagen_ct=sp.umlagen_ct if sp else None,
                konzessionsabgabe_ct=sp.konzessionsabgabe_ct if sp else None,
                ust_pct=sp.ust_pct if sp else None,
                verbrauch_tage=tv, verbrauch_kwh=sv, erzeugung_tage=te, erzeugung_kwh=se,
            ))
    return out


def lade_zeilen(dsn: str) -> dict[UUID, Zeile]:
    import psycopg  # lazy: optional [db] extra

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT site_id, stand, stand_seit, formelsatz, fenster_bis, datenbasis FROM site_mispel_check")
        return {r[0]: Zeile(r[1], r[2], r[3], r[4], r[5]) for r in cur.fetchall()}


_UPSERT = """
INSERT INTO site_mispel_check (site_id, tenant_id, stand, stand_seit, formelsatz, fenster_von, fenster_bis,
    differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten, datenbasis, hinweis)
VALUES (%(site)s, %(tenant)s, %(stand)s, now(), %(formelsatz)s, %(von)s, %(bis)s,
    %(niedrig)s, %(mittel)s, %(hoch)s, %(posten)s::jsonb, %(datenbasis)s::jsonb, %(hinweis)s)
ON CONFLICT (site_id) DO UPDATE SET
    tenant_id = EXCLUDED.tenant_id, stand = EXCLUDED.stand, stand_seit = EXCLUDED.stand_seit,
    formelsatz = EXCLUDED.formelsatz, fenster_von = EXCLUDED.fenster_von, fenster_bis = EXCLUDED.fenster_bis,
    differenz_niedrig_eur = EXCLUDED.differenz_niedrig_eur, differenz_mittel_eur = EXCLUDED.differenz_mittel_eur,
    differenz_hoch_eur = EXCLUDED.differenz_hoch_eur, posten = EXCLUDED.posten,
    datenbasis = EXCLUDED.datenbasis, hinweis = EXCLUDED.hinweis
"""


def ablegen(conn, st: Stammdaten, e: Eingang, stand: str, *, ergebnis: dict | None = None,
            f: Fenster | None = None, hinweis: str | None = None) -> None:
    """Einen Stand ablegen (Vertrag § 6) - Beträge nur in ``fertig``."""
    differenz = (ergebnis or {}).get("differenz") or {}
    conn.execute(_UPSERT, {
        "site": st.site_id, "tenant": st.tenant_id, "stand": stand, "formelsatz": e.formelsatz,
        "von": (ergebnis or {}).get("fenster_von") or (f.von if f else None),
        "bis": (ergebnis or {}).get("fenster_bis") or (f.bis if f else None),
        "niedrig": differenz.get("niedrig"), "mittel": differenz.get("mittel"), "hoch": differenz.get("hoch"),
        "posten": json.dumps((ergebnis or {}).get("posten") or [], ensure_ascii=False),
        "datenbasis": json.dumps(e.datenbasis, ensure_ascii=False),
        "hinweis": hinweis,
    })
    conn.commit()


def check_deps(dsn: str, workers: int) -> mc.CheckDeps:
    """Preise und amtliche Marktwerte aus der Datenbank, Wetter aus dem Open-Meteo-Archiv."""
    import psycopg  # lazy: optional [db] extra

    from voltpilot_optimization.simulation import data as sim_data
    from voltpilot_optimization.simulation.archive import ArchiveWeatherSource

    monate: dict[date, float] = {}
    jahre: dict[int, float] = {}
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        try:
            cur.execute("SELECT month, value_ct_kwh FROM monthly_market_value WHERE technology = 'solar'")
            monate = {m: float(v) for m, v in cur.fetchall()}
            cur.execute("SELECT year, value_ct_kwh FROM annual_market_value WHERE technology = 'solar'")
            jahre = {int(j): float(v) for j, v in cur.fetchall()}
        except (psycopg.errors.UndefinedTable, psycopg.errors.UndefinedColumn):
            conn.rollback()
    return mc.CheckDeps(
        load_prices=lambda zone, slots: sim_data.load_year_prices(dsn, zone, slots),
        weather=ArchiveWeatherSource(),
        monatsmarktwerte_ct=monate,
        jahresmarktwerte_ct=jahre,
        max_workers=min(max(workers, 1), MAX_WORKERS),
    )


# ---------------------------------------------------------------------------
# Der Lauf
# ---------------------------------------------------------------------------


@dataclass
class Bericht:
    site_id: UUID
    grund: str
    stand: str
    sekunden: float
    hinweis: str | None = None
    spanne: dict | None = None
    eingang: dict | None = field(default=None, repr=False)


def lauf(
    dsn: str,
    deps: mc.CheckDeps,
    *,
    jetzt: datetime | None = None,
    site_id: UUID | None = None,
    max_anlagen: int = 4,
    neu: bool = False,
    rechne: Callable[..., dict] = mc.mispel_check,
) -> list[Bericht] | None:
    """Ein Lauf: die Anlagen ohne aktuelles Ergebnis rechnen und ablegen, höchstens
    ``max_anlagen``; ``None``, wenn schon ein anderer Lauf rechnet (Advisory-Lock).
    ``neu`` rechnet die gewählten Anlagen auch mit aktuellem Ergebnis."""
    import psycopg  # lazy: optional [db] extra

    jetzt = jetzt or datetime.now(timezone.utc)
    heute = jetzt.astimezone(BERLIN).date()
    f = fenster(heute)
    deps = replace(deps, max_workers=min(max(deps.max_workers, 1), MAX_WORKERS))
    with psycopg.connect(dsn, autocommit=True) as lock:
        if not lock.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_SCHLUESSEL,)).fetchone()[0]:
            logger.info("mispel_check.lauf_belegt")
            return None
        try:
            alte = lade_zeilen(dsn)
            offen = []
            for st in lade_stammdaten(dsn, f, heute, site_id):
                e = eingang(st, f)
                warum = "neu angestoßen" if neu else grund(alte.get(st.site_id), e, f, jetzt)
                if warum is not None:
                    offen.append((alte.get(st.site_id) is not None, st, e, warum))
            # Zuerst die Anlagen ohne Zeile, dann die übrigen in der Reihenfolge der Abfrage.
            offen.sort(key=lambda o: o[0])
            berichte = []
            with psycopg.connect(dsn) as conn:
                for _, st, e, warum in offen[:max(max_anlagen, 0)]:
                    berichte.append(_eine_anlage(conn, st, e, f, deps, warum, rechne))
            return berichte
        finally:
            lock.execute("SELECT pg_advisory_unlock(%s)", (LOCK_SCHLUESSEL,))


def _eine_anlage(conn, st: Stammdaten, e: Eingang, f: Fenster, deps: mc.CheckDeps, warum: str,
                 rechne: Callable[..., dict]) -> Bericht:
    start = time.monotonic()
    eingabe = asdict(e.anlage) if e.anlage is not None else None
    if e.anlage is None:
        ablegen(conn, st, e, e.stand, hinweis=e.hinweis)
        return Bericht(st.site_id, warum, e.stand, 0.0, e.hinweis)
    ablegen(conn, st, e, STAND_WIRD_GERECHNET, f=f)
    logger.info("mispel_check.anlage_start", extra={"context": {
        "site_id": str(st.site_id), "grund": warum, "formelsatz": e.formelsatz}})
    try:
        result = rechne(e.anlage, deps, f.beginn, f.monate)
        if not result.get("unterstuetzt"):
            ablegen(conn, st, e, STAND_NICHT_UNTERSTUETZT, hinweis=result.get("hinweis"))
            return Bericht(st.site_id, warum, STAND_NICHT_UNTERSTUETZT, time.monotonic() - start,
                           result.get("hinweis"), eingang=eingabe)
        zeile = ergebnis_zeile(result)
    except Exception as exc:  # noqa: BLE001 - je Anlage isoliert: die nächste rechnet weiter
        conn.rollback()
        satz = f"{FEHLGESCHLAGEN_SATZ}: {exc}"
        logger.warning("mispel_check.anlage_fehlgeschlagen", extra={"context": {
            "site_id": str(st.site_id), "error": str(exc)}})
        ablegen(conn, st, e, STAND_FEHLGESCHLAGEN, hinweis=satz[:500])
        return Bericht(st.site_id, warum, STAND_FEHLGESCHLAGEN, time.monotonic() - start, satz, eingang=eingabe)
    # MP-33c: ein Rückfall auf „ohne Gutschrift“ steht im Hinweis, nie still im Betrag.
    hinweis = result.get("hinweis")
    ablegen(conn, st, e, STAND_FERTIG, ergebnis=zeile, hinweis=hinweis)
    sekunden = time.monotonic() - start
    logger.info("mispel_check.anlage_fertig", extra={"context": {
        "site_id": str(st.site_id), "sekunden": round(sekunden, 1), "spanne": zeile["differenz"],
        "hinweis": hinweis}})
    return Bericht(st.site_id, warum, STAND_FERTIG, sekunden, hinweis, spanne=zeile["differenz"],
                   eingang=eingabe)
