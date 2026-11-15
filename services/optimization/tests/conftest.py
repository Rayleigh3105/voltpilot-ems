"""Gemeinsame Test-Fixtures des Optimierers."""

from __future__ import annotations

import pytest


@pytest.fixture
def ohne_defizitdeckung(monkeypatch):
    """Das Modell OHNE die Defizitdeckung der Box (PH-1 A, 15.11.2026).

    Nur fuer Tests, die eine Eigenschaft des LP selbst pruefen (einen
    Gleichstand-Brecher, die Huerde, die Abflachung einer Spitze) an einer
    Vorlage mit Hausdefizit in jedem Slot. Dort deckt die Box das Haus, bis der
    Speicher leer ist, und die Eigenschaft waere unsichtbar. Was die Box dabei
    tatsaechlich faehrt, pruefen ``test_defizitdeckung.py`` und die Tests ohne
    diese Fixture; jeder Aufrufer sagt im Docstring, warum er sie braucht."""
    from voltpilot_optimization import defizitdeckung

    monkeypatch.setattr(defizitdeckung, "baue", lambda m, **kw: 0.0)
