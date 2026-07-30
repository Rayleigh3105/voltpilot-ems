"""The `serve` loop's container behaviour (docs/k8s-readiness.md).

test_runtime.py proves the ServeRuntime primitives; this proves the optimizer's
loop is actually WIRED to them: a SIGTERM leaves the 15-min wait, and a failed
cycle retries in seconds instead of idling a full interval (the Kubernetes
cold-start case - there is no depends_on, so the DB may simply not be up yet).
"""

from __future__ import annotations

import os
import signal

import pytest

from voltpilot_optimization import cli


@pytest.fixture(autouse=True)
def _restore_sigterm():
    """main() installs a process-wide handler; give pytest its own back."""
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


def test_a_failed_cycle_retries_in_seconds_instead_of_a_full_interval(monkeypatch):
    delays: list[float] = []

    def boom(_args, _env):
        raise RuntimeError("connection to server failed")

    def fake_sleep(_runtime, seconds):
        delays.append(seconds)
        return len(delays) < 3  # False ends the loop

    monkeypatch.setattr(cli, "_run_one", boom)
    monkeypatch.setattr(cli.ServeRuntime, "sleep", fake_sleep)

    rc = cli.main(["serve", "--interval-seconds", "900", "--health-port", "0"])

    assert rc == 0
    # Exponential from 5 s, NOT 3 x 900 s of doing nothing while the DB waits.
    assert delays == [5.0, 10.0, 20.0]


def test_a_successful_cycle_keeps_the_configured_cadence(monkeypatch):
    delays: list[float] = []
    monkeypatch.setattr(cli, "_run_one", lambda _a, _e: None)
    monkeypatch.setattr(
        cli.ServeRuntime, "sleep", lambda _r, s: (delays.append(s), False)[1]
    )

    assert cli.main(["serve", "--interval-seconds", "900", "--health-port", "0"]) == 0
    assert delays == [900.0]


def test_sigterm_ends_the_loop_instead_of_waiting_out_the_interval(monkeypatch):
    # Real signal, real Event: without the installed handler a Python PID 1
    # would ignore SIGTERM entirely and be SIGKILLed after the grace period.
    cycles: list[int] = []

    def cycle_then_signal(_args, _env):
        cycles.append(1)
        os.kill(os.getpid(), signal.SIGTERM)

    monkeypatch.setattr(cli, "_run_one", cycle_then_signal)

    # A 15-min interval and NO sleep stub: the test itself would hang if the
    # wait were not interruptible.
    assert cli.main(["serve", "--interval-seconds", "900", "--health-port", "0"]) == 0
    assert cycles == [1]
