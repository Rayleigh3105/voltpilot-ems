"""Die Wahl des AKTIVEN Prognosemodells als DATEN - JE ANLAGE.

Bis hierher war die Beförderung eines Schatten-Kandidaten eine
Umgebungsvariable an drei Containern plus ein Redeploy - also die einzige
Handlung, die aus der täglichen Messung folgt, war die einzige, die das Portal
nicht anbieten konnte. Seit api-Migration ``V20260825000000`` trägt die globale
append-only Tabelle ``forecast_model_choice`` je Prognoseart die jüngste
Entscheidung samt Urheber.

Seit dem Anlagen-Schalter (Captain-Auftrag 19.08.2026, api-Migration
``V20260826000000``) ist die Wahl zusätzlich JE ANLAGE möglich - und der Kunde
trifft sie selbst: welches Modell am besten passt, hängt an der einzelnen
Anlage, und ein Kandidat, der auf einem Gewerbehof gewinnt, kann auf einem
Einfamilienhaus verlieren. Die plattformweite Zeile bleibt genau das, was ihr
Name sagt: die VORGABE für jede Anlage ohne eigene Wahl.

**Die Präzedenz ist der ganze Vertrag und steht wortgleich in beiden
Migrationen, im Java-``ForecastModels.resolve`` und hier:**

1. die jüngste Zeile in ``site_forecast_model_choice`` je (Anlage, Art),
2. sonst die jüngste Zeile in ``forecast_model_choice`` je Art (die
   Plattform-Vorgabe),
3. sonst die Umgebungsvariable (``VOLTPILOT_ACTIVE_*_MODEL``),
4. sonst der Registry-Default (das Basismodell).

Ohne eine einzige Zeile ist damit JEDER Pfad byte-identisch zu vorher - das ist
die Rückwärts-Sicherheit, auf die sich der Optimierer-Test beruft.

**Ehrlichkeitsregel:** eine unbekannte oder art-fremde Id in einer DB-Zeile wird
VERWORFEN (laut protokolliert), nicht übernommen. Sie kann nur von Hand
entstanden sein - der Schreibpfad validiert -, und eine übernommene Falsch-Id
fände null gespeicherte Prognosezeilen und ließe den Optimierer stillschweigend
auf seine Persistenz-Baseline zurückfallen, während das Portal weiter „live"
anzeigt. Aus demselben Grund wird sie NICHT als Ausnahme geworfen: eine
handgeschriebene Zeile darf nicht die Planung der ganzen Flotte anhalten.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field

from voltpilot_forecast import registry
from voltpilot_forecast.domain import ForecastKind

logger = logging.getLogger("voltpilot.forecast.model_choice")

#: „Was gilt gerade" - die jüngste Zeile je Art. Geordnet auf ``id DESC``,
#: nicht auf ``set_at``: zwei Umstellungen in derselben Mikrosekunde wären dort
#: ein Gleichstand, die Sequenz ist die Ordnung (identisch mit dem SQL des
#: Java-Lesepfads ``ForecastModelChoiceRepository.CURRENT_SQL``).
CURRENT_SQL = (
    "SELECT DISTINCT ON (model_kind) model_kind, model_id "
    "FROM forecast_model_choice ORDER BY model_kind, id DESC"
)

#: Dasselbe je ANLAGE - „was gilt gerade für diese Anlage". Wieder ``id DESC``,
#: wieder aus demselben Grund; identisch mit dem SQL des Java-Lesepfads
#: ``SiteForecastModelChoiceRepository.CURRENT_SQL``.
SITE_CURRENT_SQL = (
    "SELECT DISTINCT ON (site_id, model_kind) site_id, model_kind, model_id "
    "FROM site_forecast_model_choice ORDER BY site_id, model_kind, id DESC"
)


@dataclass(frozen=True)
class ModelChoices:
    """Die gespeicherten Wahlen einer Flotte: die Plattform-Vorgabe und die
    Anlagen, die eine EIGENE getroffen haben.

    Sie wird EINMAL je Lauf geladen (zwei billige indizierte Abfragen) und
    dann je Anlage ausgewertet - ein Read je Anlage wären N identische
    Abfragen. Der leere Zustand ist die Vor-Schalter-Welt: dann entscheidet
    ausschliesslich die Umgebung.
    """

    platform: dict[ForecastKind, str] = field(default_factory=dict)
    per_site: dict[str, dict[ForecastKind, str]] = field(default_factory=dict)

    def for_site(self, site_id) -> dict[ForecastKind, str]:
        """Die WIRKSAMEN Wahlen einer Anlage: ihre eigenen über der Vorgabe."""
        return {**self.platform, **self.per_site.get(str(site_id), {})}


def load_choices(conn) -> dict[ForecastKind, str]:
    """Die gespeicherte Portal-Wahl je Art (leer = nie umgestellt).

    Never raises: fehlt die Tabelle (eine DB, deren api-Migrationen noch nicht
    gelaufen sind) oder antwortet sie nicht, gilt schlicht die Umgebung - genau
    das dokumentierte Rückfall-Verhalten. Ein Prognoselauf darf daran nicht
    scheitern.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(CURRENT_SQL)
            rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 - degrade to env, never sink a run
        logger.warning(
            "model_choice.unavailable",
            extra={"context": {"error": str(exc)}},
        )
        _rollback_quietly(conn)
        return {}
    return _validated(rows)


def load_choices_dsn(dsn: str) -> dict[ForecastKind, str]:
    """:func:`load_choices` mit eigener Verbindung (der Optimierer-Aufrufer)."""
    import psycopg  # lazy: optional [db] extra, mirroring the callers

    try:
        with psycopg.connect(dsn) as conn:
            return load_choices(conn)
    except Exception as exc:  # noqa: BLE001 - same degradation as above
        logger.warning(
            "model_choice.unavailable",
            extra={"context": {"error": str(exc)}},
        )
        return {}


def load_site_choices(conn) -> dict[str, dict[ForecastKind, str]]:
    """Die gespeicherte Wahl JE ANLAGE (leer = keine Anlage hat eine eigene).

    Never raises - dieselbe Degradation wie :func:`load_choices`: fehlt die
    Tabelle (eine DB, deren api-Migrationen noch nicht gelaufen sind), gilt
    schlicht die Plattform-Vorgabe.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(SITE_CURRENT_SQL)
            rows = cur.fetchall()
    except Exception as exc:  # noqa: BLE001 - degrade to the platform default
        logger.warning(
            "model_choice.site_unavailable",
            extra={"context": {"error": str(exc)}},
        )
        _rollback_quietly(conn)
        return {}
    out: dict[str, dict[ForecastKind, str]] = {}
    for site_id, kind_value, model_id in rows:
        validated = _validated([(kind_value, model_id)])
        if validated:
            out.setdefault(str(site_id), {}).update(validated)
    return out


def load_all(conn) -> ModelChoices:
    """Plattform-Vorgabe UND Anlagen-Wahlen in einem Rutsch (zwei Abfragen)."""
    return ModelChoices(platform=load_choices(conn), per_site=load_site_choices(conn))


def load_all_dsn(dsn: str) -> ModelChoices:
    """:func:`load_all` mit eigener Verbindung (der Optimierer-Aufrufer)."""
    import psycopg  # lazy: optional [db] extra, mirroring the callers

    try:
        with psycopg.connect(dsn) as conn:
            return load_all(conn)
    except Exception as exc:  # noqa: BLE001 - same degradation as above
        logger.warning(
            "model_choice.unavailable",
            extra={"context": {"error": str(exc)}},
        )
        return ModelChoices()


def active_models(
    env: Mapping[str, str], choices: Mapping[ForecastKind, str] | None = None
) -> dict[ForecastKind, str]:
    """Das aktive Modell je Art nach der Präzedenz oben.

    ``choices`` ist die BEREITS aufgelöste Wahl-Ebene - für eine Anlage also
    :meth:`ModelChoices.for_site`, das ihre eigene Wahl über die
    Plattform-Vorgabe legt. Diese Funktion kennt den Unterschied deshalb gar
    nicht: sie sieht nur „es gibt eine Wahl" oder „es gibt keine".
    """
    stored = choices or {}
    out: dict[ForecastKind, str] = {}
    for kind in ForecastKind:
        chosen = stored.get(kind)
        out[kind] = chosen if chosen else registry.active_model(kind, env)
    return out


def _validated(rows) -> dict[ForecastKind, str]:
    out: dict[ForecastKind, str] = {}
    for kind_value, model_id in rows:
        try:
            kind = ForecastKind(kind_value)
        except ValueError:
            logger.warning(
                "model_choice.unknown_kind",
                extra={"context": {"kind": kind_value, "model": model_id}},
            )
            continue
        if model_id not in registry.KNOWN_MODELS:
            logger.warning(
                "model_choice.unknown_model",
                extra={"context": {"kind": kind_value, "model": model_id}},
            )
            continue
        if registry.kind_of(model_id) is not kind:
            logger.warning(
                "model_choice.kind_mismatch",
                extra={"context": {"kind": kind_value, "model": model_id}},
            )
            continue
        out[kind] = model_id
    return out


def _rollback_quietly(conn) -> None:
    """Eine gescheiterte Abfrage hinterlässt eine abgebrochene Transaktion -
    ohne Rollback schlüge jede FOLGE-Abfrage derselben Verbindung fehl (der
    Evaluator teilt sich eine)."""
    try:
        conn.rollback()
    except Exception:  # noqa: BLE001 - best effort
        pass
