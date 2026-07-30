"""The collectors' `serve` loop container behaviour (docs/k8s-readiness.md).

test_runtime.py proves the ServeRuntime primitives; this proves the weather
collector's loop is actually WIRED to them. Its 3 h cadence is the extreme
case: without an interruptible wait every rollout would end in SIGKILL after
the grace period, and a cold start whose first cycle fails (no depends_on in
Kubernetes - the DB may not be up yet) would idle three hours.
"""

from __future__ import annotations

import os
import signal

import pytest

from voltpilot_forecast import weather_collect


@pytest.fixture(autouse=True)
def _restore_sigterm():
    """main() installs a process-wide handler; give pytest its own back."""
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


def test_a_failed_cycle_retries_in_seconds_instead_of_three_hours(monkeypatch):
    delays: list[float] = []

    def boom(_env, _source, _persist):
        raise RuntimeError("connection to server failed")

    def fake_sleep(_runtime, seconds):
        delays.append(seconds)
        return len(delays) < 3  # False ends the loop

    monkeypatch.setattr(weather_collect, "_run_cycle", boom)
    monkeypatch.setattr(weather_collect.ServeRuntime, "sleep", fake_sleep)

    rc = weather_collect.main(
        ["serve", "--interval-seconds", "10800", "--health-port", "0"]
    )

    assert rc == 0
    assert delays == [5.0, 10.0, 20.0]


def test_a_successful_cycle_keeps_the_three_hour_cadence(monkeypatch):
    delays: list[float] = []
    monkeypatch.setattr(weather_collect, "_run_cycle", lambda *_a: None)
    monkeypatch.setattr(
        weather_collect.ServeRuntime,
        "sleep",
        lambda _r, s: (delays.append(s), False)[1],
    )

    rc = weather_collect.main(
        ["serve", "--interval-seconds", "10800", "--health-port", "0"]
    )
    assert rc == 0
    assert delays == [10800.0]


def test_sigterm_ends_the_loop_instead_of_waiting_out_the_interval(monkeypatch):
    cycles: list[int] = []

    def cycle_then_signal(_env, _source, _persist):
        cycles.append(1)
        os.kill(os.getpid(), signal.SIGTERM)

    monkeypatch.setattr(weather_collect, "_run_cycle", cycle_then_signal)

    # No sleep stub: the test itself hangs for 3 h if the wait is not
    # interruptible.
    rc = weather_collect.main(
        ["serve", "--interval-seconds", "10800", "--health-port", "0"]
    )
    assert rc == 0
    assert cycles == [1]
