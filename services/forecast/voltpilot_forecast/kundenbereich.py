"""Kundenbereich „beendet": die Python-Schreiber lassen ihn aus (UEMS AP-20, E10 = A).

Prognose, Wetter, Bewertung und Optimierer lesen ihre Anlagenliste einmal je
Zyklus und schreiben danach je Anlage in Tabellen OHNE Fremdschlüssel auf den
Mandanten (``forecast``, ``forecast_model_state``, ``forecast_accuracy``,
``plan_accuracy``, ``weather_forecast``, ``schedule``, ``site_plan_run``,
``entity_plan_slot``). Zwei Schichten, beide nötig:

* **Anlagenliste:** jede Liste, aus der ein Zyklus schreibt, verbindet ``site``
  mit ``tenant t`` und filtert :data:`NICHT_BEENDET`. Ein beendeter Bereich
  bekommt keine Prognose, kein Wetter, keine Bewertung und keinen Plan.
* **Schreibsperre:** :func:`lebenden_bereich_sperren` steht in jeder
  Schreibtransaktion VOR den INSERTs; die INSERTs bleiben, wie sie waren. Sie
  nimmt ``FOR KEY SHARE`` auf die Mandantenzeile (dieselbe Sperre, die ein
  Fremdschlüssel beim Einfügen nimmt, dasselbe Muster wie die Rollups in
  api ``V20260926004700``) und hält sie bis zum Commit:

  - Zyklus sperrt zuerst: der Löschzug wartet an seiner ersten Sperre
    (``KundenbereichLoeschung.Wache#vorDemAbbau``, ``FOR UPDATE``) bis zum
    Commit und löscht die frischen Zeilen mit.
  - Löschzug sperrt zuerst: ``SKIP LOCKED`` -> ``False``, ohne zu warten.
  - Löschzug hat committet, oder der Bereich ist beendet (auch mitten im
    Zyklus): keine Zeile -> ``False``.

  Ohne die Sperre legte ein Zyklus, der seine Liste vor dem Löschzug las,
  nach dessen Commit Zeilen des gelöschten Bereichs an, die der Löschnachweis
  nicht sieht. Eine Sperre je Transaktion statt einer Unterabfrage je INSERT:
  ein Plan sind mehrere Anweisungen (Lauf + Slots, 192 Zeilen per
  ``executemany``) - EINE Entscheidung gilt für alle, nie ein halber Plan.

``beendet_am`` wird über ``to_jsonb`` gelesen: vor der api-Migration
``V20260925170000`` gibt es die Spalte nicht, und genau das heißt „kein
Bereich beendet" (Muster ``voltpilot_optimization.inputs.load_grenzblaetter``).
Im Cluster starten die Dienste nicht erst nach der api.
"""

from __future__ import annotations

#: Bedingung für ``tenant t`` in einer Anlagenliste: der Bereich ist nicht beendet.
NICHT_BEENDET = "(to_jsonb(t) ->> 'beendet_am') IS NULL"

_SPERRE_SQL = (
    "SELECT 1 FROM tenant t WHERE t.id = %s AND "
    + NICHT_BEENDET
    + " FOR KEY SHARE OF t SKIP LOCKED"
)


def lebenden_bereich_sperren(cur, tenant_id) -> bool:  # noqa: ANN001 - psycopg optional
    """Sperrt die Mandantenzeile bis zum Commit; ``False`` = nichts schreiben.

    ``False`` heißt: der Bereich ist beendet, gelöscht oder gerade im Löschzug
    gesperrt. Der Aufrufer schreibt dann in DIESER Transaktion nichts für ihn.
    """
    cur.execute(_SPERRE_SQL, (str(tenant_id),))
    return cur.fetchone() is not None
