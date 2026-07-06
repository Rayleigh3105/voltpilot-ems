"""Publish plans to the edge: retained QoS1 per the frozen schedule contract.

Payload shape is ``docs/contracts/mqtt-schedule.schema.json`` (BINDING). The
message is RETAINED so a (re)connecting edge immediately receives the current
plan, and QoS1 so delivery survives a flaky link; the edge's Default-Watchdog
covers the missing/stale case (see the contract's ``x-failsafe``).

``paho-mqtt`` is a lazy import behind the optional ``mqtt`` extra so the
package (and non-MQTT tests) install without it; the payload builder itself is
pure and dependency-free, which is what the contract test exercises.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Protocol

from voltpilot_optimization.domain import SchedulePlan, ensure_utc

logger = logging.getLogger("voltpilot.optimization.publisher")

SCHEMA_VERSION = "1.0"


def schedule_topic(plan: SchedulePlan) -> str:
    return f"ems/{plan.tenant_id}/{plan.site_id}/{plan.device_id}/schedule"


def build_schedule_payload(plan: SchedulePlan) -> dict:
    """The contract payload for a plan (``mqtt-schedule.schema.json``)."""
    if plan.device_id is None:
        raise ValueError("cannot build a schedule payload without a device")
    return {
        "schema_version": SCHEMA_VERSION,
        "tenant_id": str(plan.tenant_id),
        "site_id": str(plan.site_id),
        "device_id": str(plan.device_id),
        "plan_id": str(plan.plan_id),
        "generated_at": _rfc3339(plan.generated_at),
        "horizon_slots": len(plan.slots),
        "slot_minutes": plan.slot_minutes,
        "slots": [_slot_payload(slot) for slot in plan.slots],
    }


def _slot_payload(slot) -> dict:
    payload = {
        "start": _rfc3339(slot.start),
        "battery_setpoint_kw": round(slot.battery_kw, 3),
    }
    # OPTIONAL per the contract: present only when the plan curtails, so
    # non-curtailing plans publish byte-identical payloads to before Phase 3
    # (and an edge without curtailment support has nothing to ignore).
    limit = slot.pv_limit_kw
    if limit is not None:
        payload["pv_limit_kw"] = round(limit, 3)
    return payload


def _rfc3339(dt) -> str:
    return ensure_utc(dt).isoformat().replace("+00:00", "Z")


class SchedulePublisher(Protocol):
    """Sink for the published side of a plan."""

    def publish(self, plan: SchedulePlan) -> None: ...


class NullSchedulePublisher:
    """No-op publisher for --no-publish runs and repository-only tests."""

    def publish(self, plan: SchedulePlan) -> None:  # pragma: no cover - trivial
        logger.info(
            "publish.skipped",
            extra={"context": {"plan_id": str(plan.plan_id)}},
        )


class RecordingSchedulePublisher:
    """Test double: records (topic, payload, retain, qos) tuples."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []

    def publish(self, plan: SchedulePlan) -> None:
        self.published.append((schedule_topic(plan), build_schedule_payload(plan)))


class MqttSchedulePublisher:
    """paho-mqtt publisher: one short-lived connection per run (the optimizer
    is a 15-min-cadence job, not a streaming service)."""

    def __init__(
        self,
        host: str,
        port: int = 1883,
        username: str | None = None,
        password: str | None = None,
        client_id: str = "voltpilot-optimization",
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._client_id = client_id

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "MqttSchedulePublisher":
        env = dict(os.environ) if env is None else env
        return cls(
            host=env.get("MQTT_HOST", "localhost"),
            port=int(env.get("MQTT_PORT", "1883")),
            username=env.get("MQTT_USERNAME") or None,
            password=env.get("MQTT_PASSWORD") or None,
        )

    def publish(self, plan: SchedulePlan) -> None:
        import paho.mqtt.client as mqtt  # lazy: optional [mqtt] extra

        topic = schedule_topic(plan)
        payload = json.dumps(build_schedule_payload(plan))
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
                raise RuntimeError(f"schedule publish not acknowledged: {topic}")
        finally:
            client.loop_stop()
            client.disconnect()
        logger.info(
            "publish.ok",
            extra={
                "context": {
                    "topic": topic,
                    "plan_id": str(plan.plan_id),
                    "slots": len(plan.slots),
                }
            },
        )
