"""Die Wahl des AKTIVEN Prognosemodells als DATEN (Captain-Auftrag 18.08.2026).

Bis hierher war die Beförderung eines Schatten-Kandidaten eine
Umgebungsvariable an drei Containern plus ein Redeploy - also die einzige
Handlung, die aus der täglichen Messung folgt, war die einzige, die das Portal
nicht anbieten konnte. Seit api-Migration ``V20260825000000`` trägt die globale
append-only Tabelle ``forecast_model_choice`` je Prognoseart die jüngste
Entscheidung samt Urheber.

**Die Präzedenz ist der ganze Vertrag und steht wortgleich in der Migration,
im Java-Service und hier:**

1. die jüngste Zeile in ``forecast_model_choice`` je Art - sie gewinnt,
2. sonst die Umgebungsvariable (``VOLTPILOT_ACTIVE_*_MODEL``),
3. sonst der Registry-Default (das Basismodell).

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


def active_models(
    env: Mapping[str, str], choices: Mapping[ForecastKind, str] | None = None
) -> dict[ForecastKind, str]:
    """Das aktive Modell je Art nach der Präzedenz oben."""
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
