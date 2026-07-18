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

``paho-mqtt`` stays a lazy import behind the optional ``mqtt`` extra; the
payload builder is pure (what the contract test exercises).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Protocol

from voltpilot_optimization.domain import ensure_utc
from voltpilot_optimization.entities import (
    ProducerDispatch,
    SitePlan,
    StorageDispatch,
)

logger = logging.getLogger("voltpilot.optimization.publisher_v2")

SCHEMA_VERSION_V2 = "2.0"


def plan_v2_topic(plan: SitePlan) -> str:
    return f"ems/{plan.tenant_id}/{plan.site_id}/{plan.device_id}/v2/plan"


def build_plan_v2_payload(plan: SitePlan) -> dict:
    """The contract payload for a multi-entity plan
    (``docs/contracts/v2/mqtt-schedule-2.0.schema.json``)."""
    if plan.device_id is None:
        raise ValueError("cannot build a v2 plan payload without a device")
    entities: list[dict] = []
    for storage in plan.storages:
        entities.append(_storage_entity_payload(storage))
    for producer in plan.producers:
        # Release semantics: a producer with no curtailment anywhere is
        # omitted - the edge withdraws its market desire and clears limits.
        if producer.curtails:
            entities.append(_producer_entity_payload(producer))
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
        "horizon_slots": len(plan.site_slots),
        "slot_minutes": plan.slot_minutes,
        "entities": entities,
    }
    # OPTIONAL site-level peak target (PS-1 semantics carried over 1:1 from
    # 1.0): present only while the peak-shaving module is active; a NEW plan
    # without it clears any latched target on the edge.
    if plan.peak_target_kw is not None:
        payload["grid_import_limit_kw"] = round(plan.peak_target_kw, 3)
    return payload


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
            for slot in storage.slots
        ],
    }
    # PS-2 per entity (multi-battery ready): the 1.0 top-level
    # peak_reserve_soc_pct becomes per-storage reserve_soc_pct.
    if storage.reserve_soc_pct is not None:
        entity["reserve_soc_pct"] = round(storage.reserve_soc_pct, 2)
    return entity


def _producer_entity_payload(producer: ProducerDispatch) -> dict:
    slots = []
    for slot in producer.slots:
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


def _rfc3339(dt) -> str:
    return ensure_utc(dt).isoformat().replace("+00:00", "Z")


class PlanV2Publisher(Protocol):
    """Sink for the published side of a multi-entity plan."""

    def publish(self, plan: SitePlan) -> None: ...


class RecordingPlanV2Publisher:
    """Test double: records (topic, payload) tuples."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []

    def publish(self, plan: SitePlan) -> None:
        self.published.append((plan_v2_topic(plan), build_plan_v2_payload(plan)))


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
        import paho.mqtt.client as mqtt  # lazy: optional [mqtt] extra

        topic = plan_v2_topic(plan)
        body = build_plan_v2_payload(plan)
        payload = json.dumps(body)
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
