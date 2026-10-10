"""Publish multi-entity plans per mqtt-schedule 2.0 (E4-Basis, v2 track).

Payload shape is ``docs/contracts/v2/mqtt-schedule-2.0.schema.json`` (BINDING),
published RETAINED QoS1 on the NEW per-device v2 topic
``ems/{tenant_id}/{site_id}/{device_id}/v2/plan`` - coexistence with the
frozen 1.0 schedule is by SEPARATE TOPIC (decision D-1), so the v1 retained
plan is never touched and the E13a shadow phase (v2 publishes, v1 controls)
works by construction.

Contract rules the builder enforces:

- **D-8: ``charge_from_grid_allowed`` is ALWAYS emitted explicitly** for every
  storage entity. The 2.0 contract reads ABSENT as NOT allowed (the shipped
  edge's fail-safe promoted into the contract), so a merchant storage that
  relied on an implicit default would silently lose grid charging - the v2
  publisher therefore never omits the field.
- **Absent limit = no limit AND clears** (the 1.0 ``pv_limit_kw`` clearing
  rule): a producer entity that curtails NOTHING over the whole horizon is
  OMITTED from the plan entirely - the release semantics clear any previously
  applied limit. A producer that curtails in SOME slots carries the full
  contiguous slot grid (the contract requires contiguity): curtailing slots
  get ``limit_kw`` (the generation cap), non-curtailing slots the explicit
  no-op ``limit_pct: 100`` (a slot's commands object must not be empty).
- ``grid_import_limit_kw`` stays SITE-level (PS-1 semantics carried over 1:1);
  per-entity ``reserve_soc_pct`` replaces the 1.0 top-level peak reserve.

Plan je Box (UEMS AP-15 IP-15, P1/P2/W8): fuer eine Anlage in ``anteile_aktiv``
schneidet :func:`plan_je_box` EINEN Lauf in je ein Dokument pro steuernder Box -
dieselbe ``plan_id``, dasselbe ``generated_at``, die Laufnummer; jede Entitaet im
Dokument der Box ihrer Komponente, ``grid_import_limit_kw`` nur bei der
fuehrenden. Ohne scharfe Gemeinsame Steuerung ist es genau EIN Dokument, gebaut
von :func:`build_plan_v2_payload` wie bisher - Byte fuer Byte (NW-6).

``paho-mqtt`` stays a lazy import behind the optional ``mqtt`` extra; the
payload builder is pure (what the contract test exercises).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, replace
from typing import Protocol
from uuid import UUID

from voltpilot_optimization.domain import ensure_utc
from voltpilot_optimization.entities import (
    LoadDispatch,
    ProducerDispatch,
    SitePlan,
    StorageDispatch,
)

from voltpilot_optimization.publisher import EDGE_PLAN_SLOTS as _EDGE_PLAN_SLOTS
from voltpilot_optimization.verbund import VerbundStand, erzeuger_id

logger = logging.getLogger("voltpilot.optimization.publisher_v2")

SCHEMA_VERSION_V2 = "2.0"

#: Same edge cap as the 1.0 publisher and for the same reason - see
#: :data:`voltpilot_optimization.publisher.EDGE_PLAN_SLOTS`. Imported rather
#: than re-declared so the two contracts can never drift apart.
EDGE_PLAN_SLOTS = _EDGE_PLAN_SLOTS


def plan_v2_topic(plan: SitePlan) -> str:
    return f"ems/{plan.tenant_id}/{plan.site_id}/{plan.device_id}/v2/plan"


def build_plan_v2_payload(plan: SitePlan) -> dict:
    """The contract payload for a multi-entity plan
    (``docs/contracts/v2/mqtt-schedule-2.0.schema.json``)."""
    if plan.device_id is None:
        raise ValueError("cannot build a v2 plan payload without a device")
    site_slots = plan.site_slots[:EDGE_PLAN_SLOTS]
    entities: list[dict] = []
    for storage in plan.storages:
        entities.append(_storage_entity_payload(storage))
    for producer in plan.producers:
        # Release semantics: a producer with no curtailment anywhere is
        # omitted - the edge withdraws its market desire and clears limits.
        # Evaluated over the PUBLISHED window (EDGE_PLAN_SLOTS), never the
        # planned one: a curtailment that only happens on the second day would
        # otherwise publish an all-no-op entity today.
        if any(s.limit_kw is not None for s in producer.slots[:EDGE_PLAN_SLOTS]):
            entities.append(_producer_entity_payload(producer))
    for load in plan.loads:
        # Consumers WITHOUT a local source carry the FULL slot grid (contract
        # contiguity), always - an all-off grid IS the plan ("do not run"),
        # unlike a producer's no-limit release. Shadow discipline: the entity
        # only exists in the payload for sites the engine co-plans (flagged),
        # so an unflagged site's v2 payload stays byte-identical.
        #
        # K2 (P5): a consumer WITH a local source is silent outside its goal
        # windows (see _load_entity_payload). Silent for the WHOLE published
        # window means the plan has nothing to say about it at all - then the
        # entity is OMITTED entirely (the producer's release discipline), never
        # published with an empty slot list, which the contract refuses
        # (`slots` minItems 1) and which would read as a malformed plan rather
        # than as "the source governs".
        payload_load = _load_entity_payload(load)
        if payload_load["slots"]:
            entities.append(payload_load)
    if not entities:
        raise ValueError(
            "cannot build a v2 plan payload without any commanded entity"
        )
    payload = {
        "schema_version": SCHEMA_VERSION_V2,
        "tenant_id": str(plan.tenant_id),
        "site_id": str(plan.site_id),
        "device_id": str(plan.device_id),
        "plan_id": str(plan.plan_id),
        "generated_at": _rfc3339(plan.generated_at),
        "horizon_slots": len(site_slots),
        "slot_minutes": plan.slot_minutes,
        "entities": entities,
    }
    # OPTIONAL site-level peak target (PS-1 semantics carried over 1:1 from
    # 1.0): present only while the peak-shaving module is active; a NEW plan
    # without it clears any latched target on the edge.
    if plan.peak_target_kw is not None:
        payload["grid_import_limit_kw"] = round(plan.peak_target_kw, 3)
    return payload


#: Rollen im wahlfreien Block ``gemeinsame_steuerung`` (die Woerter der
#: Mitgliedschaft, ``steuerungsverbund_mitglied.rolle``).
ROLLE_FUEHRT = "fuehrt"
ROLLE_STEUERT_MIT = "steuert_mit"


@dataclass(frozen=True)
class BoxDokument:
    """Was EINE Box aus EINEM Lauf bekommt (IP-15, P2).

    ``payload`` ist das Plan-2.0-Dokument der Box; ``None`` heisst: die Box hat in
    diesem Lauf keine Entitaet - ein leeres Dokument lehnte sie ab
    (``keine_entitaeten``), also bekommt sie keins, und ihr gehaltener Plan wird
    mit der leeren retained Nachricht zurueckgenommen (die Freigabe-Regel des
    Erzeugers, eine Ebene hoeher: kein alter Deckel wirkt 20 min nach).
    """

    device_id: UUID
    topic: str
    payload: dict | None


def plan_je_box(
    plan: SitePlan, stand: VerbundStand | None, lauf_nr: int | None = None
) -> list[BoxDokument]:
    """Die Dokumente EINES Laufs, je Box hoechstens eins (P2, W8).

    Ohne scharfe Gemeinsame Steuerung (``stand`` fehlt oder nennt keine
    fuehrende Box): genau EIN Dokument an ``plan.device_id``, gebaut wie immer -
    kein ``lauf_nr``, kein Block (NW-6, R22).

    Mit ihr gehoert jede Entitaet genau EINER Box: der Speicher der Box seines
    Asset-Geraets (``plan.device_id``, W2), die PV einer mitsteuernden Box
    (:func:`~voltpilot_optimization.verbund.erzeuger_id`) und ihre Verbraucher
    (``steuerungsverbund_geraet``, dieselbe Zuordnung wie ihre Anteils-
    Nebenbedingung) dieser Box, alles andere der fuehrenden. Eine mitsteuernde
    Box, die der Planer als belegt rechnet (stumm, unbestaetigt, ohne
    Faehigkeit), bekommt nichts - auch keine Ruecknahme; ihre Entitaeten stehen
    in keinem Dokument. Das gilt nach einem Box-Tausch ebenso fuer die
    unbestaetigte fuehrende Nachfolgerin; die mitsteuernden Boxen bekommen ihre
    Dokumente weiter. ``grid_import_limit_kw`` (das Lastspitzen-ZIEL) traegt nur
    die fuehrende Box. Reihenfolge: fuehrende, Speicher-Box, mitsteuernde.
    """
    if stand is None or stand.fuehrende is None:
        return [BoxDokument(plan.device_id, plan_v2_topic(plan), build_plan_v2_payload(plan))]
    fuehrende = stand.fuehrende
    mitsteuernde = {box.device_id: box for box in stand.mitsteuernde}
    pv_box = {erzeuger_id(box.device_id): box.device_id for box in stand.mitsteuernde}
    verbraucher_box = {
        entity: box.device_id for box in stand.mitsteuernde for entity in box.verbraucher
    }
    speicher_box = plan.device_id if plan.device_id is not None else fuehrende

    reihenfolge: list[UUID] = []
    for box in (fuehrende, speicher_box, *mitsteuernde):
        if box not in reihenfolge:
            reihenfolge.append(box)

    dokumente: list[BoxDokument] = []
    for box in reihenfolge:
        if box == fuehrende and stand.fuehrende_belegt:
            continue
        mit = mitsteuernde.get(box)
        if mit is not None and not mit.bekommt_plan:
            continue
        teil = replace(
            plan,
            device_id=box,
            storages=[s for s in plan.storages if speicher_box == box],
            producers=[p for p in plan.producers if pv_box.get(p.entity_id, fuehrende) == box],
            loads=[l for l in plan.loads if verbraucher_box.get(l.entity_id, fuehrende) == box],
            peak_target_kw=plan.peak_target_kw if box == fuehrende else None,
        )
        topic = plan_v2_topic(teil)
        try:
            payload = build_plan_v2_payload(teil)
        except ValueError:
            dokumente.append(BoxDokument(box, topic, None))
            continue
        if lauf_nr is not None:
            payload["lauf_nr"] = lauf_nr
        if box == fuehrende:
            payload["gemeinsame_steuerung"] = {"rolle": ROLLE_FUEHRT}
        elif mit is not None:
            payload["gemeinsame_steuerung"] = {"rolle": ROLLE_STEUERT_MIT}
        dokumente.append(BoxDokument(box, topic, payload))
    return dokumente


def _storage_entity_payload(storage: StorageDispatch) -> dict:
    entity = {
        "entity_id": storage.entity_id,
        "kind": "storage",
        # D-8: ALWAYS explicit - absent means NOT allowed by contract.
        "charge_from_grid_allowed": storage.charge_from_grid_allowed,
        "slots": [
            {
                "start": _rfc3339(slot.start),
                "commands": {"setpoint_kw": round(slot.setpoint_kw, 3)},
            }
            for slot in storage.slots[:EDGE_PLAN_SLOTS]
        ],
    }
    # PS-2 per entity (multi-battery ready): the 1.0 top-level
    # peak_reserve_soc_pct becomes per-storage reserve_soc_pct.
    if storage.reserve_soc_pct is not None:
        entity["reserve_soc_pct"] = round(storage.reserve_soc_pct, 2)
    return entity


def _producer_entity_payload(producer: ProducerDispatch) -> dict:
    slots = []
    for slot in producer.slots[:EDGE_PLAN_SLOTS]:
        limit = slot.limit_kw
        if limit is not None:
            commands = {"limit_kw": round(limit, 3)}
        else:
            # Contiguity requires every slot; an empty commands object is
            # forbidden, so a non-curtailing slot carries the explicit no-op
            # limit (100% of native generation = no reduction).
            commands = {"limit_pct": 100.0}
        slots.append({"start": _rfc3339(slot.start), "commands": commands})
    return {
        "entity_id": producer.entity_id,
        "kind": "pv-generation",
        "slots": slots,
    }


def _load_entity_payload(load: LoadDispatch) -> dict:
    """A controllable consumer per mqtt-schedule 2.0 (§12.5): the generic
    command vocabulary carries it without any schema change - ``on_off`` for
    on/off consumers, ``setpoint_kw`` (+ = consume, 0 = off) for stepped and
    continuous ones. ``kind`` stays informative (the registry is the
    authority).

    ⚠ K2 - DIE STILLE-REGEL (Verbrauchsmanagement v1 / P5). Ein Verbraucher,
    dessen Policy AUCH eine lokale Quelle traegt (``has_local_source``), bekommt
    NUR die Slots, die der Plan wirklich schaltet. Ein voller Raster mit
    ausdruecklichen Aus-Slots waere hier der Plan, der die Regel des Kunden
    ueberstimmt - jede Viertelstunde, den ganzen Horizont lang -, obwohl er das
    lokale Signal per Konstruktion gar nicht sehen kann. Wo der Plan SCHWEIGT,
    regiert die Quelle.

    Der Edge liest das genau so: ``plan2.Plan.ActiveCommands`` liefert fuer eine
    nicht abgedeckte Zeit ``ok=false``, und ``runPlanExecutors`` zieht den Wunsch
    dann SAUBER zurueck (``stale=false``) - der Arbiter waehlt im selben Takt den
    naechsten Halter, also die reaktive Regel. Kein Failsafe-Blinzeln, keine
    Edge-Aenderung.

    Ein Verbraucher OHNE lokale Quelle behaelt das volle Raster - dort IST ein
    Aus-Slot die Aussage („dieses Geraet laeuft jetzt nicht"), und ein Weglassen
    hiesse „entscheide selbst", was er nicht kann.
    """
    slots = []
    for slot in load.slots[:EDGE_PLAN_SLOTS]:
        if load.has_local_source and not slot.on:
            continue
        if load.control_kind == "on_off":
            commands: dict = {"on_off": bool(slot.on)}
        else:
            commands = {"setpoint_kw": round(slot.power_kw if slot.on else 0.0, 3)}
        slots.append({"start": _rfc3339(slot.start), "commands": commands})
    return {
        "entity_id": load.entity_id,
        "kind": "consumer",
        "slots": slots,
    }


def _rfc3339(dt) -> str:
    return ensure_utc(dt).isoformat().replace("+00:00", "Z")


class PlanV2Publisher(Protocol):
    """Sink for the published side of a multi-entity plan."""

    def publish(self, plan: SitePlan) -> None: ...

    def publish_dokument(self, dokument: BoxDokument) -> None:
        """IP-15: one box's document (``payload`` None = retained clear)."""
        ...


class RecordingPlanV2Publisher:
    """Test double: records (topic, payload) tuples; clears by topic."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []
        self.cleared: list[str] = []

    def publish(self, plan: SitePlan) -> None:
        self.published.append((plan_v2_topic(plan), build_plan_v2_payload(plan)))

    def publish_dokument(self, dokument: BoxDokument) -> None:
        if dokument.payload is None:
            self.cleared.append(dokument.topic)
        else:
            self.published.append((dokument.topic, dokument.payload))


class MqttPlanV2Publisher:
    """paho-mqtt publisher for the v2 plan topic: one short-lived connection
    per run (the co-optimizer is a 15-min-cadence job), retained QoS1 -
    mirrors :class:`voltpilot_optimization.publisher.MqttSchedulePublisher`."""

    def __init__(
        self,
        host: str,
        port: int = 1883,
        username: str | None = None,
        password: str | None = None,
        client_id: str = "voltpilot-optimization-v2",
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._client_id = client_id

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "MqttPlanV2Publisher":
        env = dict(os.environ) if env is None else env
        return cls(
            host=env.get("MQTT_HOST", "localhost"),
            port=int(env.get("MQTT_PORT", "1883")),
            username=env.get("MQTT_USERNAME") or None,
            password=env.get("MQTT_PASSWORD") or None,
        )

    def publish(self, plan: SitePlan) -> None:
        topic = plan_v2_topic(plan)
        body = build_plan_v2_payload(plan)
        self._senden(topic, json.dumps(body))
        logger.info(
            "publish_v2.ok",
            extra={
                "context": {
                    "topic": topic,
                    "plan_id": str(plan.plan_id),
                    "entities": len(body["entities"]),
                }
            },
        )

    def publish_dokument(self, dokument: BoxDokument) -> None:
        """IP-15: one box's document, retained QoS1 like :meth:`publish`; a
        document without entity is the empty retained message (clear)."""
        body = dokument.payload
        self._senden(dokument.topic, json.dumps(body) if body is not None else b"")
        logger.info(
            "publish_v2.ok" if body is not None else "publish_v2.cleared",
            extra={
                "context": {
                    "topic": dokument.topic,
                    "plan_id": body["plan_id"] if body is not None else None,
                    "lauf_nr": body.get("lauf_nr") if body is not None else None,
                    "entities": len(body["entities"]) if body is not None else 0,
                }
            },
        )

    def _senden(self, topic: str, payload) -> None:
        import paho.mqtt.client as mqtt  # lazy: optional [mqtt] extra

        client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=self._client_id,
            protocol=mqtt.MQTTv5,
        )
        if self._username:
            client.username_pw_set(self._username, self._password)
        client.connect(self._host, self._port, keepalive=30)
        client.loop_start()
        try:
            info = client.publish(topic, payload, qos=1, retain=True)
            info.wait_for_publish(timeout=10)
            if not info.is_published():
                raise RuntimeError(f"v2 plan publish not acknowledged: {topic}")
        finally:
            client.loop_stop()
            client.disconnect()
