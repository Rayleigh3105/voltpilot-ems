"""AP-07 IP-21: der Wächter über der eingecheckten Abnahme-Vorlage.

Die Abnahme läuft in Java (Testcontainers) und startet kein Python; sie liest
die Zustellungen, erwarteten Ereignisse und Stammdaten aus einer eingecheckten
JSON-Datei. Diese Datei ist erzeugt, nicht geschrieben — hier wird sie neu
erzeugt und Zeichen für Zeichen verglichen. Läuft der Simulator weiter als die
Vorlage, ist dieser Test rot, und ``make abnahme`` stellt sie wieder her.
"""

from __future__ import annotations

import pathlib

import pytest

from uems_szenarien import abnahme_fixture, fixture_text, pruefsumme

VORLAGE = (pathlib.Path(__file__).resolve().parents[2]
           / "services/timescale-writer/src/test/resources/uems/ap07-abnahme-szenarien.json")


def test_die_eingecheckte_vorlage_ist_die_des_simulators():
    assert VORLAGE.exists(), f"{VORLAGE} fehlt — `make abnahme` erzeugt sie"
    assert VORLAGE.read_text(encoding="utf-8") == fixture_text(), (
        "Vorlage und Simulator laufen auseinander — `make abnahme` neu erzeugen "
        "und die Abnahme-Klassen erneut fahren"
    )


def test_die_pruefsumme_deckt_den_ganzen_inhalt():
    """Der Java-Lauf rechnet dieselbe Summe nach; sie darf nicht von sich selbst abhängen."""
    vorlage = abnahme_fixture()
    assert pruefsumme(vorlage) == vorlage["pruefsumme"]

    verdreht = {k: v for k, v in vorlage.items()}
    verdreht["szenarien"] = list(verdreht["szenarien"])
    verdreht["szenarien"][0] = dict(verdreht["szenarien"][0], titel="geändert")
    assert pruefsumme(verdreht) != vorlage["pruefsumme"]


@pytest.mark.parametrize("schluessel", ["A1", "A3", "A4", "A6", "A13"])
def test_jedes_szenario_traegt_seine_stammdaten(schluessel):
    """Ohne Zuständigkeit, Bindung und Einbau könnte der Java-Lauf keine Rolle prüfen."""
    szenario = next(s for s in abnahme_fixture()["szenarien"] if s["szenario"] == schluessel)
    stamm = szenario["stammdaten"]
    assert stamm["zustaendigkeiten"], "jede Box braucht ihre Datenquelle"
    assert stamm["reihen"], "jede gelieferte Reihe braucht ihre Bindung"

    # Jede erwartete Reihe ist als Stammdatum da — sonst prüft Java gegen Nichts.
    erwartet = {r["messstelle"] for r in szenario["erwartete_reihen"]}
    assert erwartet <= {r["messstelle"] for r in stamm["reihen"]}

    # Jede Box der Zustellungen hat eine Zuständigkeit zu irgendeinem Zeitpunkt.
    boxen = {z["nutzlast"]["device_id"] for z in szenario["zustellungen"]}
    assert boxen == {z["device_id"] for z in stamm["zustaendigkeiten"]}
