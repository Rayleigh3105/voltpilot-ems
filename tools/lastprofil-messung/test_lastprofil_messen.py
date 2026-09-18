from pathlib import Path

import pytest

from lastprofil_messen import Messfehler, auswerten, bericht, fixture_lesen

FIXTURES = Path(__file__).parent / "fixtures"
TENANT = "a4e0b000-0000-4000-8000-000000000001"


def test_aufgezeichnete_metriken_werden_richtig_gerechnet():
    ergebnis = auswerten(
        fixture_lesen(FIXTURES, "before"),
        fixture_lesen(FIXTURES, "after"),
        tenant=TENANT,
        profil_minuten=15,
    )
    assert ergebnis["verbraucher_rueckstand"] == {
        "vorher": 68_250.0, "nachher": 0.0, "abgebaut_spaetestens_min": 5.0,
    }
    assert ergebnis["writer_rate_samples_min"] == 3_900
    assert ergebnis["arbeitslisten_alter_s"] == {
        "viertelstunde": 120.0, "tag": 180.0, "periode": 0.0,
    }
    assert ergebnis["stundenlauf_beobachtet_s"] == 270
    assert ergebnis["rohzeilen"] == {"gemessen": 19_500, "erwartet": 19_500.0}
    assert ergebnis["viertelstundenzeilen"] == {"gemessen": 1_300, "erwartet": 1_300.0}
    assert ergebnis["cloud_verworfene_samples"] == 0
    assert ergebnis["cloud_unlesbare_umschlaege"] == 0
    assert ergebnis["cloud_verworfene_samples_luecke"] is None


def test_bericht_enthaelt_alle_schwellen_aber_keine_kennung():
    ergebnis = auswerten(
        fixture_lesen(FIXTURES, "before"), fixture_lesen(FIXTURES, "after"),
        tenant=TENANT, profil_minuten=15,
    )
    text = bericht(ergebnis, umgebung="Testcontainers", commit="deadbeef")
    for erwartung in ("< 15 min", "< 10 min", "±20 %", "1 872 000", "124 800",
                       "Samples verworfen | 0 | 0", "BESTANDEN",
                       "Werkzeug-Beleg, keine Abnahme-Messung"):
        assert erwartung in text
    assert TENANT not in text


def test_fehlende_pflichtmetrik_scheitert_laut():
    vorher = fixture_lesen(FIXTURES, "before")
    nachher = fixture_lesen(FIXTURES, "after")
    nachher["writer_metrics"] = nachher["writer_metrics"].replace(
        'voltpilot_kafka_consumer_lag{group="timescale-writer",topic="measurements.raw"} 0\n', "")
    with pytest.raises(Messfehler, match="Pflichtmetrik.*fehlt"):
        auswerten(vorher, nachher, tenant=TENANT, profil_minuten=15)


def test_altersmetrik_darf_nur_bei_leerer_liste_fehlen():
    vorher = fixture_lesen(FIXTURES, "before")
    nachher = fixture_lesen(FIXTURES, "after")
    nachher["api_metrics"] = nachher["api_metrics"].replace(
        'voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste="tag"} 180\n', "")
    with pytest.raises(Messfehler, match="fehlt bei offener Arbeit"):
        auswerten(vorher, nachher, tenant=TENANT, profil_minuten=15)


def test_verwerfzaehler_zuwachs_macht_die_schwelle_rot():
    vorher = fixture_lesen(FIXTURES, "before")
    nachher = fixture_lesen(FIXTURES, "after")
    nachher["writer_metrics"] = nachher["writer_metrics"].replace(
        'voltpilot_writer_verworfene_samples_total{grund="identitaet"} 0\n',
        'voltpilot_writer_verworfene_samples_total{grund="identitaet"} 3\n')
    nachher["writer_metrics"] = nachher["writer_metrics"].replace(
        'voltpilot_writer_verworfen_total{grund="identitaet",strom="measurements"} 0\n',
        'voltpilot_writer_verworfen_total{grund="identitaet",strom="measurements"} 1\n')
    ergebnis = auswerten(vorher, nachher, tenant=TENANT, profil_minuten=15)
    assert ergebnis["cloud_verworfene_samples"] == 3
    text = bericht(ergebnis, umgebung="Test", commit="deadbeef")
    assert "Samples verworfen | 0 | 3" in text
    assert "NICHT BESTANDEN" in text


def test_alter_writer_ohne_verwerfmetrik_bleibt_laut_nicht_messbar():
    vorher = fixture_lesen(FIXTURES, "before")
    nachher = fixture_lesen(FIXTURES, "after")
    for messpunkt in (vorher, nachher):
        messpunkt["writer_metrics"] = "\n".join(
            line for line in messpunkt["writer_metrics"].splitlines()
            if not line.startswith("voltpilot_writer_verworfen")) + "\n"
    ergebnis = auswerten(vorher, nachher, tenant=TENANT, profil_minuten=15)
    assert ergebnis["cloud_verworfene_samples"] is None
    text = bericht(ergebnis, umgebung="Altbestand", commit="deadbeef")
    assert "NICHT MESSBAR" in text
    assert "Pflichtmetrik" in text


def test_unlesbarer_umschlag_macht_die_samplezahl_nicht_messbar():
    vorher = fixture_lesen(FIXTURES, "before")
    nachher = fixture_lesen(FIXTURES, "after")
    nachher["writer_metrics"] = nachher["writer_metrics"].replace(
        'voltpilot_writer_verworfen_total{grund="unlesbar",strom="measurements"} 0\n',
        'voltpilot_writer_verworfen_total{grund="unlesbar",strom="measurements"} 1\n')
    ergebnis = auswerten(vorher, nachher, tenant=TENANT, profil_minuten=15)
    assert ergebnis["cloud_verworfene_samples"] == 0
    assert ergebnis["cloud_unlesbare_umschlaege"] == 1
    text = bericht(ergebnis, umgebung="Test", commit="deadbeef")
    assert "Sample-Zahl in 1 unlesbaren Umschlägen unbekannt" in text
    assert "NICHT MESSBAR" in text
