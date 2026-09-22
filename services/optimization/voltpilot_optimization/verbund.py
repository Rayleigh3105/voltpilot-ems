"""Planlauf mit Anteilen (UEMS AP-15 IP-14, Regeln P4, B5, Y4, Entscheid E7 = A).

In einer Anlage mit Gemeinsamer Steuerung in Stufe ``anteile_aktiv`` rechnet der
EINE Lauf die ganze Anlage - aber MIT den Anteilen: fuer jede Box, die den
Netzanschluss nicht sieht (Rolle ``steuert_mit``), ist ihr Anteil je Richtung
eine Nebenbedingung (P4). Ein Plan, den ihr Waechter ohnehin abschnitte, waere
kein Plan. Die fuehrende Box bekommt KEINE Anteils-Nebenbedingung: sie regelt
mit ihrer Messung gegen das Ganze (Konzept §3.4 Punkt 3).

Was je mitsteuernder Box gilt (Solver: :func:`solver._add_verbund`,
Co-Optimierer: :class:`modules.VerbundAnteileModule`):

- **Einspeisung** (V6): PV-Grenze der Erzeuger der Box + Entladung des geplanten
  Speichers, wenn er an ihr haengt, <= Einspeise-Anteil.
- **Bezug**: steuerbare Verbraucher der Box (Ladepark-Deckel, Verbraucher) <=
  Bezugs-Anteil; haengt der geplante Speicher an ihr (Lesart LA1), zaehlt
  zusaetzlich sein Netzladen = Ladung ueber der eigenen PV der Box (V3).
- **Ein Speicher** (E7 = A): geplant wird wie heute die EINE primaere Batterie;
  ein zweiter Speicher kommt im Eingang gar nicht vor.
- **Stumm** (Y4: 90 s ohne Herzschlag) oder **ohne Wert** (B5): die Box wird mit
  vollem Anteil als BELEGT geplant - ihre PV laeuft ungeplant bis zum Anteil, ihre
  Verbraucher bekommen nichts, und die Anschlussgrenzen der uebrigen Anlage sind
  um ihren vollen Anteil enger. Ihr ungenutzter Anteil geht an niemanden (R7).
- **Abregeln nach Wert**: an EINEM Anschluss hat jede erzeugte kWh je Slot
  denselben Wert (eine Verguetung, ein Eigenverbrauchswert - dieselben Grundlagen
  wie die Erloesanzeige); die Zielfunktion regelt nur ab, wo die kWh weniger wert
  ist als nichts oder eine Grenze es verlangt. Bei gleichem Wert entscheidet ein
  Gleichstand-Brecher: zuerst die Erzeugung der fuehrenden Box (ihr Regelkreis
  korrigiert gegen Messung), die einer mitsteuernden nur, soweit ihr Anteil es
  verlangt.

Welcher Anteil fuer den Planer gilt: WIRKSAM ist der quittierte Stand; solange
ein gesendetes Dokument noch nicht quittiert ist (Zweischritt, G5), gilt je
Richtung das KLEINERE aus quittiertem und gesendetem Stand - der Waechter der Box
haelt, was sie zuletzt angenommen hat, und bekommt vielleicht gleich das Engere
(``mqtt-verbund-anteile.md`` §2/§4). Vor der ersten Quittung ist der gesendete
Stand der Planwert: der erste Uebergang einer mitsteuernden Box ist ihr
Rueckfall, also genau das, was sie ohne Dokument haelt.

Die PV der Anlage kommt als EINE Prognose; der Teil einer Box ist ihr Anteil an
der Nennleistung der PV-Anlagen (``asset.pv_capacity_kwp`` je ``device_id``).
Ohne PV-Anlage an der Box traegt sie keinen Teil - dann gibt der Plan ihr auch
kein PV-Kommando.

Ohne Verbund, in jeder anderen Stufe (angehalten eingeschlossen) und vor der
api-Migration (Tabelle fehlt) liest der Optimierer nichts davon: der Eingang ist
Feld fuer Feld der von heute (NW-6).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from uuid import UUID

logger = logging.getLogger("voltpilot.optimization.verbund")

#: Y4: nach 90 s ohne Herzschlag gilt eine Box dem Planer als stumm.
STUMM_NACH = timedelta(seconds=90)

#: Die einzige Stufe, in der die Anteile den Lauf binden.
STUFE_ANTEILE_AKTIV = "anteile_aktiv"


@dataclass(frozen=True)
class MitsteuerndeBox:
    """Eine mitsteuernde Box, wie der Zyklus sie aus der Datenbank liest.

    ``einspeisung_kw``/``bezug_kw``: der Planwert je Richtung
    (:func:`planer_anteil`), ``None`` = kein Dokument nennt die Box.
    ``pv_kwp``: Nennleistung der PV-Anlagen an dieser Box. ``verbraucher``:
    Entitaeten (Messpunkt-IDs) der Box auf der Bezugsseite
    (``steuerungsverbund_geraet``).
    """

    device_id: UUID
    einspeisung_kw: float | None
    bezug_kw: float | None
    stumm: bool
    pv_kwp: float = 0.0
    verbraucher: tuple[str, ...] = ()

    @property
    def bekommt_plan(self) -> bool:
        """IP-15 (P2, R7, R14, R17): eine mitsteuernde Box bekommt ihr Plan-Dokument
        genau dann, wenn der Planer sie NICHT als belegt rechnet - stumm, nach dem
        Box-Tausch unbestaetigt und ohne die Faehigkeit ``steuerungsverbund_anteil``
        sind derselbe Zustand: kein Kommando, kein Dokument."""
        return not self.stumm


@dataclass(frozen=True)
class VerbundStand:
    """Die Gemeinsame Steuerung einer Anlage in ``anteile_aktiv``."""

    mitsteuernde: tuple[MitsteuerndeBox, ...]
    #: Nennleistung ALLER PV-Anlagen der Anlage (Nenner der Aufteilung).
    pv_kwp_gesamt: float = 0.0
    #: Die fuehrende Box (Rolle ``fuehrt``) - Empfaenger von allem, was keiner
    #: mitsteuernden Box gehoert, und allein Traeger von ``grid_import_limit_kw``
    #: (IP-15). ``None`` = keine gueltige fuehrende Box: dann bleibt es beim
    #: EINEN Dokument von heute.
    fuehrende: UUID | None = None


@dataclass(frozen=True)
class BoxAnteil:
    """Eine mitsteuernde Box im Eingang EINES Laufs (je Slot aufgeloest).

    ``pv_kw`` ist ihr Teil der PV-Prognose der Anlage (Teil von
    ``OptimizationInput.pv_kw``); ``stumm`` = Y4/B5: mit vollem Anteil belegt.
    """

    device_id: UUID
    einspeisung_kw: float
    bezug_kw: float
    pv_kw: tuple[float, ...] = ()
    stumm: bool = False
    verbraucher: tuple[str, ...] = field(default=())


def planer_anteil(quittiert: float | None, gesendet: float | None) -> float | None:
    """Der Anteil, mit dem der Planer rechnet: das Kleinere aus quittiertem und
    gesendetem Stand; nur einer bekannt -> dieser; keiner -> ``None``."""
    werte = [w for w in (quittiert, gesendet) if w is not None]
    return min(werte) if werte else None


def ist_stumm(herzschlag: datetime | None, jetzt: datetime) -> bool:
    """Y4: ohne Herzschlag oder mit einem aelter als 90 s ist die Box stumm."""
    return herzschlag is None or jetzt - herzschlag > STUMM_NACH


def anteile_je_box(dokument, richtung: str, box: UUID) -> float | None:
    """Der Wert der Box in einer Richtung eines Anteils-Dokuments (``anteile``-JSON)."""
    if not dokument:
        return None
    wert = (dokument.get(richtung) or {}).get(str(box))
    return float(wert) if wert is not None else None


def fuer_lauf(stand: VerbundStand | None, pv_kw: list[float]) -> tuple[BoxAnteil, ...]:
    """Den gelesenen Stand auf die Slots EINES Laufs auflösen.

    Die PV-Prognose der Anlage wird nach der Nennleistung geteilt; die Summe der
    Box-Teile bleibt so nie ueber der Prognose. Eine Box ohne bekannten Anteil ist
    B5: sie wird stumm mit Anteil 0 geplant - kein Kommando, und nichts wird fuer
    sie reserviert, was niemand kennt.
    """
    if stand is None or not stand.mitsteuernde:
        return ()
    boxen = []
    for box in stand.mitsteuernde:
        if stand.pv_kwp_gesamt > 0 and box.pv_kwp > 0:
            teil = min(box.pv_kwp / stand.pv_kwp_gesamt, 1.0)
            pv_box = tuple(max(p, 0.0) * teil for p in pv_kw)
        else:
            pv_box = tuple(0.0 for _ in pv_kw)
        unbekannt = box.einspeisung_kw is None or box.bezug_kw is None
        if unbekannt:
            logger.warning(
                "verbund.anteil_unbekannt",
                extra={"context": {"device_id": str(box.device_id)}},
            )
        boxen.append(
            BoxAnteil(
                device_id=box.device_id,
                einspeisung_kw=box.einspeisung_kw if box.einspeisung_kw is not None else 0.0,
                bezug_kw=box.bezug_kw if box.bezug_kw is not None else 0.0,
                pv_kw=pv_box,
                stumm=box.stumm or unbekannt,
                verbraucher=box.verbraucher,
            )
        )
    return tuple(boxen)


def erzeuger_id(device_id: UUID) -> str:
    """Entitaets-Kennung der PV einer mitsteuernden Box im Co-Optimierer."""
    return f"pv-{device_id}"


# ---------------------------------------------------------------------------
# DB-Leser (vertrauenswuerdige Backend-Rolle, wie load_grenzblaetter).
# ---------------------------------------------------------------------------

#: Box-Tausch (A14/R17): das gespeicherte Dokument fuehrt den Anteil einer
#: Nachfolgerin noch unter der Vorgaengerin (``m.anteil_kennung``); der Eintrag
#: wird fuer sie umgeschluesselt - sonst waere ihr Anteil unbekannt (B5) und nichts
#: fuer ihre Geraete reserviert. Ohne Tausch (``anteil_kennung`` NULL) das
#: Dokument unveraendert.
_UMSCHLUESSELN = """CASE WHEN m.anteil_kennung IS NULL OR {d}.anteile IS NULL THEN {d}.anteile
       ELSE (SELECT jsonb_object_agg(r.key, CASE
                WHEN jsonb_typeof(r.value) = 'object' AND r.value ? m.anteil_kennung::text
                     AND NOT r.value ? m.device_id::text
                THEN (r.value - m.anteil_kennung::text)
                     || jsonb_build_object(m.device_id::text, r.value -> m.anteil_kennung::text)
                ELSE r.value END)
             FROM jsonb_each({d}.anteile) r) END"""

_MITGLIEDER_SQL = f"""
SELECT v.site_id, m.device_id,
       {_UMSCHLUESSELN.format(d="q")} AS quittiert,
       {_UMSCHLUESSELN.format(d="g")} AS gesendet,
       d.device_status_seen_at, m.bestaetigt_am,
       COALESCE(d.supports ? 'steuerungsverbund_anteil', false) AS faehig
FROM steuerungsverbund v
JOIN steuerungsverbund_mitglied m
  ON m.steuerungsverbund_id = v.id AND m.tenant_id = v.tenant_id
LEFT JOIN steuerungsverbund_anteile q
  ON q.steuerungsverbund_id = v.id
 AND q.epoche = m.quittiert_epoche AND q.revision = m.quittiert_revision
LEFT JOIN steuerungsverbund_anteile g
  ON g.steuerungsverbund_id = v.id
 AND g.epoche = m.gesendet_epoche AND g.revision = m.gesendet_revision
LEFT JOIN device d ON d.id = m.device_id
WHERE v.stufe = 'anteile_aktiv'
  AND m.rolle = 'steuert_mit'
  AND m.aufgehoben_am IS NULL
  AND m.gueltig_ab <= %(jetzt)s
  AND (m.gueltig_bis IS NULL OR m.gueltig_bis > %(jetzt)s)
  AND (%(site_id)s::uuid IS NULL OR v.site_id = %(site_id)s::uuid)
ORDER BY v.site_id, m.device_id
"""

#: IP-15: die fuehrende Box je Anlage (hoechstens eine ``fuehrt`` je Zeitpunkt,
#: von der Datenbank erzwungen - IP-4).
_FUEHRENDE_SQL = """
SELECT v.site_id, f.device_id
FROM steuerungsverbund_mitglied f
JOIN steuerungsverbund v
  ON v.id = f.steuerungsverbund_id AND v.tenant_id = f.tenant_id
WHERE v.stufe = 'anteile_aktiv'
  AND f.rolle = 'fuehrt'
  AND f.aufgehoben_am IS NULL
  AND f.gueltig_ab <= %(jetzt)s
  AND (f.gueltig_bis IS NULL OR f.gueltig_bis > %(jetzt)s)
  AND v.site_id = ANY(%(sites)s)
"""

_PV_SQL = """
SELECT site_id, device_id, sum(pv_capacity_kwp)
FROM asset
WHERE type = 'pv' AND pv_capacity_kwp > 0 AND site_id = ANY(%(sites)s)
GROUP BY site_id, device_id
"""

_VERBRAUCHER_SQL = """
SELECT g.site_id, g.device_id, g.entity_id::text
FROM steuerungsverbund_geraet g
JOIN steuerungsverbund v
  ON v.id = g.steuerungsverbund_id AND v.tenant_id = g.tenant_id
WHERE v.stufe = 'anteile_aktiv'
  AND g.aufgehoben_am IS NULL
  AND g.richtung = 'bezug'
  AND g.entity_id IS NOT NULL
  AND g.site_id = ANY(%(sites)s)
ORDER BY g.site_id, g.device_id, g.entity_id
"""


def _json(value):
    if isinstance(value, str):
        import json

        return json.loads(value)
    return value


def load_verbund(dsn: str, jetzt: datetime, site_id: UUID | None = None) -> dict:
    """``{site_id: VerbundStand}`` fuer jede Anlage in ``anteile_aktiv``.

    Eine Anlage ohne Gemeinsame Steuerung, in einer anderen Stufe oder ohne
    mitsteuernde Box fehlt - fuer sie aendert sich nichts (I6). Vor der
    api-Migration gibt es die Tabellen nicht: das ist genau "kein Verbund".
    Ein Mitglied, das der Betreiber nach dem Box-Tausch noch nicht bestaetigt
    hat, bekommt keinen Plan (R17) - der Planer rechnet es wie eine stumme Box;
    ebenso eine Box, die ``steuerungsverbund_anteil`` nicht meldet (A12, R14).
    """
    import psycopg  # lazy: optional [db] extra

    try:
        with psycopg.connect(dsn) as conn, conn.cursor() as cur:
            cur.execute(
                _MITGLIEDER_SQL,
                {"jetzt": jetzt, "site_id": str(site_id) if site_id else None},
            )
            mitglieder = cur.fetchall()
            if not mitglieder:
                return {}
            sites = sorted({row[0] for row in mitglieder}, key=str)
            cur.execute(_PV_SQL, {"sites": sites})
            pv_rows = cur.fetchall()
            cur.execute(_VERBRAUCHER_SQL, {"sites": sites})
            verbraucher_rows = cur.fetchall()
            cur.execute(_FUEHRENDE_SQL, {"jetzt": jetzt, "sites": sites})
            fuehrende = dict(cur.fetchall())
    except psycopg.errors.UndefinedTable:
        logger.warning("verbund.table_missing")
        return {}

    pv_gesamt: dict = {}
    pv_je_box: dict = {}
    for sid, box, kwp in pv_rows:
        pv_gesamt[sid] = pv_gesamt.get(sid, 0.0) + float(kwp)
        if box is not None:
            pv_je_box[(sid, box)] = pv_je_box.get((sid, box), 0.0) + float(kwp)
    verbraucher: dict = {}
    for sid, box, entity in verbraucher_rows:
        verbraucher.setdefault((sid, box), []).append(entity)

    boxen: dict = {}
    for sid, box, quittiert, gesendet, herzschlag, bestaetigt_am, faehig in mitglieder:
        quittiert, gesendet = _json(quittiert), _json(gesendet)
        boxen.setdefault(sid, []).append(
            MitsteuerndeBox(
                device_id=box,
                einspeisung_kw=planer_anteil(
                    anteile_je_box(quittiert, "einspeisung", box),
                    anteile_je_box(gesendet, "einspeisung", box),
                ),
                bezug_kw=planer_anteil(
                    anteile_je_box(quittiert, "bezug", box),
                    anteile_je_box(gesendet, "bezug", box),
                ),
                # R17: unbestaetigt nach dem Box-Tausch; A12/R14: ohne die
                # Faehigkeit (alter Edge-Stand) liest die Box nur - beides wie stumm.
                stumm=ist_stumm(herzschlag, jetzt)
                or bestaetigt_am is None
                or not faehig,
                pv_kwp=pv_je_box.get((sid, box), 0.0),
                verbraucher=tuple(verbraucher.get((sid, box), ())),
            )
        )
    return {
        sid: VerbundStand(
            mitsteuernde=tuple(liste),
            pv_kwp_gesamt=pv_gesamt.get(sid, 0.0),
            fuehrende=fuehrende.get(sid),
        )
        for sid, liste in boxen.items()
    }
