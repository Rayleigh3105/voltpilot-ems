"""MiSpeL MP-7: AW>0-Zeiten der UeNB und Jahresmarktwert.

Alle Fixtures sind woertlich vom Live-Endpunkt aufgezeichnet (02.10.2026); kein
Test ruft das Netz. Der Import-Test mit einem echten Monat ist Juni 2026
(Regel "1 Viertelstunde"): 2 880 Viertelstunden, davon 199 "Nein".
"""

from __future__ import annotations

import base64
import json
from datetime import date, datetime, timezone

import pytest

from tests.conftest import load_fixture
from voltpilot_market_data.energy_charts import parse_price_response
from voltpilot_market_data.http import HttpResponse
from voltpilot_market_data.market_value import (
    MarketValueSourceError,
    MarketValueSourceUnavailable,
)
from voltpilot_market_data.netztransparenz_aw import (
    REGEL_NACH_KEY,
    REGELN,
    InMemoryAwZeitRepository,
    NetztransparenzAwSource,
    csv_request,
    intervalle_im_monat,
    monate_zum_abruf,
    parse_aw_csv,
    refresh_aw_zeiten,
)
from voltpilot_market_data.netztransparenz_jahresmarktwert import (
    AnnualMarketValue,
    InMemoryAnnualMarketValueRepository,
    NetztransparenzJahresmarktwertSource,
    parse_jahresmarktwert_html,
)

JUNI = date(2026, 6, 1)


def _aw(name: str, regel: str, monat: date):
    return parse_aw_csv(
        load_fixture(f"netztransparenz_aw_{name}.csv"), REGEL_NACH_KEY[regel], monat
    )


def _utc(text: str) -> datetime:
    return datetime.fromisoformat(text).astimezone(timezone.utc)


# --- Import-Test mit einem echten Monat ------------------------------------


def test_echter_monat_juni_2026_viertelstunde():
    monat = _aw("viertelstunde_2026_06", "viertelstunde", JUNI)
    assert monat.veroeffentlicht and monat.vollstaendig and monat.luecken == 0
    assert len(monat.zeiten) == 2880 == intervalle_im_monat(JUNI, "PT15M")
    nein = [z for z in monat.zeiten if not z.aw_groesser_null]
    assert len(nein) == 199
    # erste Zeile = 01.06.2026 00:00 Ortszeit (Sommerzeit) = 31.05. 22:00 UTC
    assert monat.zeiten[0].ts == _utc("2026-05-31T22:00:00+00:00")
    assert monat.zeiten[-1].ts == _utc("2026-06-30T21:45:00+00:00")
    # erste Null-Foerderung: 04.06.2026 "11:45 - 12:00 Uhr" = 09:45 UTC
    assert nein[0].ts == _utc("2026-06-04T09:45:00+00:00")
    assert {z.aufloesung for z in monat.zeiten} == {"PT15M"}
    assert {z.regel for z in monat.zeiten} == {"viertelstunde"}


def test_regel_viertelstunde_trifft_genau_die_negativen_spotpreise_15_06_2026():
    """Gegenprobe gegen eine zweite, unabhaengige Quelle: § 51 EEG (ab
    25.02.2025) nullt den AW in jeder Viertelstunde mit negativem
    Spotmarktpreis - die UeNB-Liste muss also an diesem Tag genau die
    negativen Day-Ahead-Viertelstunden von energy-charts tragen."""
    monat = _aw("viertelstunde_2026_06", "viertelstunde", JUNI)
    tag = date(2026, 6, 15)
    nein = {z.ts for z in monat.zeiten if not z.aw_groesser_null and z.ts.date() == tag}
    preise = parse_price_response(load_fixture("energy_charts_de_lu_20260615.json"), "DE-LU")
    negativ = {p.start for p in preise.points if p.price_eur_mwh < 0}
    assert len(nein) == 18
    assert nein == negativ


def test_stundentabelle_juni_2026():
    monat = _aw("stunden_1_2026_06", "stunden_1", JUNI)
    assert len(monat.zeiten) == 720 and monat.vollstaendig
    assert sum(not z.aw_groesser_null for z in monat.zeiten) == 52
    assert {z.aufloesung for z in monat.zeiten} == {"PT60M"}
    assert [z.ts for z in monat.zeiten if not z.aw_groesser_null][0] == _utc(
        "2026-06-04T09:00:00+00:00"
    )


def test_biogas_2ct_logik_nullt_mehr_viertelstunden_als_negativpreis():
    zwei_ct = _aw("viertelstunde_2ct_2026_06", "viertelstunde_2ct", JUNI)
    negativ = _aw("viertelstunde_2026_06", "viertelstunde", JUNI)
    nein_2ct = {z.ts for z in zwei_ct.zeiten if not z.aw_groesser_null}
    nein_neg = {z.ts for z in negativ.zeiten if not z.aw_groesser_null}
    assert len(nein_2ct) == 368
    # "schwach positive Spotmarktpreise" (A1 S. 17 Fn. 7): eine Obermenge
    assert nein_neg <= nein_2ct


# --- Zeitumstellung --------------------------------------------------------


def test_fruehjahr_ausgefallene_stunde_hat_keine_zeile():
    monat = _aw("viertelstunde_2026_03", "viertelstunde", date(2026, 3, 1))
    assert len(monat.zeiten) == 31 * 96 - 4 == 2972 and monat.vollstaendig
    assert monat.luecken == 0  # die leeren Zellen 02:00-03:00 sind keine Luecke
    tag = [z.ts for z in monat.zeiten if z.ts.date() == date(2026, 3, 29) or
           z.ts == _utc("2026-03-28T23:00:00+00:00")]
    # 29.03.2026: 01:45 MEZ = 00:45 UTC, danach 03:00 MESZ = 01:00 UTC
    assert _utc("2026-03-29T00:45:00+00:00") in tag
    assert _utc("2026-03-29T01:00:00+00:00") in tag
    utc = [z.ts for z in monat.zeiten]
    assert len(utc) == len(set(utc)) and utc == sorted(utc)


def test_herbst_doppelte_stunde_ergibt_zwei_zeilen():
    monat = _aw("viertelstunde_2025_10", "viertelstunde", date(2025, 10, 1))
    assert len(monat.zeiten) == 31 * 96 + 4 == 2980 and monat.vollstaendig
    utc = [z.ts for z in monat.zeiten]
    assert len(utc) == len(set(utc))
    # 26.10.2025 02:00 kommt zweimal: 00:00 UTC (MESZ) und 01:00 UTC (MEZ)
    assert _utc("2025-10-26T00:00:00+00:00") in utc
    assert _utc("2025-10-26T01:00:00+00:00") in utc
    assert _utc("2025-10-26T01:45:00+00:00") in utc


def test_herbst_paar_erster_wert_ist_sommerzeit():
    kopf = load_fixture("netztransparenz_aw_viertelstunde_2025_10.csv").splitlines()[0]
    zellen = ["Ja"] * 96
    zellen[8:12] = ["Ja, Ja"] * 4  # 02:00 - 03:00 Uhr kommt zweimal vor
    zellen[8] = "Nein, Ja"  # 02:00 - 02:15 Uhr
    body = kopf + "\r\n26.10.2025;" + ";".join(zellen) + "\r\n"
    monat = parse_aw_csv(body, REGEL_NACH_KEY["viertelstunde"], date(2025, 10, 1))
    werte = {z.ts: z.aw_groesser_null for z in monat.zeiten}
    assert werte[_utc("2025-10-26T00:00:00+00:00")] is False
    assert werte[_utc("2025-10-26T01:00:00+00:00")] is True
    assert len(monat.zeiten) == 100


# --- Luecken und Fehler (Lueckenregel wie bei den Day-Ahead-Preisen) --------


def test_noch_nicht_veroeffentlichter_monat_ist_leer_nicht_null():
    monat = parse_aw_csv("", REGEL_NACH_KEY["viertelstunde"], date(2026, 9, 1))
    assert monat.zeiten == () and not monat.veroeffentlicht and not monat.vollstaendig


def test_leere_zelle_ist_luecke_kein_ja_und_kein_nein():
    zeilen = load_fixture("netztransparenz_aw_viertelstunde_2026_06.csv").splitlines()
    zellen = zeilen[1].split(";")
    zellen[5] = ""
    zeilen[1] = ";".join(zellen)
    monat = parse_aw_csv("\r\n".join(zeilen), REGEL_NACH_KEY["viertelstunde"], JUNI)
    assert monat.luecken == 1 and len(monat.zeiten) == 2879 and not monat.vollstaendig
    assert _utc("2026-05-31T23:00:00+00:00") not in {z.ts for z in monat.zeiten}


@pytest.mark.parametrize(
    "aendern",
    [
        lambda z: [z[0].replace("00:00 - 00:15 Uhr", "00:00 - 00:30 Uhr"), *z[1:]],
        lambda z: [z[0], z[1].replace("01.06.2026", "01.07.2026"), *z[2:]],
        lambda z: [z[0], z[1].replace("Ja", "Vielleicht", 1), *z[2:]],
        lambda z: [z[0], z[1].rsplit(";", 1)[0], *z[2:]],
        lambda z: [z[0], z[1], z[1], *z[2:]],
    ],
    ids=["kopf", "fremder-monat", "zellwert", "zu-kurz", "tag-doppelt"],
)
def test_abweichende_tabellenform_bricht_laut_ab(aendern):
    zeilen = load_fixture("netztransparenz_aw_viertelstunde_2026_06.csv").splitlines()
    with pytest.raises(MarketValueSourceError):
        parse_aw_csv("\r\n".join(aendern(zeilen)), REGEL_NACH_KEY["viertelstunde"], JUNI)


def test_wert_an_ausgefallener_ortszeit_bricht_ab():
    zeilen = load_fixture("netztransparenz_aw_viertelstunde_2026_03.csv").splitlines()
    zeilen = [z.replace(";;", ";Ja;", 1) if z.startswith("29.03.2026") else z for z in zeilen]
    with pytest.raises(MarketValueSourceError):
        parse_aw_csv("\r\n".join(zeilen), REGEL_NACH_KEY["viertelstunde"], date(2026, 3, 1))


# --- Abruf und Speicherung --------------------------------------------------


class _FakeGet:
    def __init__(self, antworten: dict[str, HttpResponse]):
        self.antworten = antworten
        self.calls: list[dict] = []

    def get(self, url, params, timeout):
        anfrage = json.loads(base64.b64decode(params["request"])) if params else {}
        self.calls.append({"url": url, "anfrage": anfrage})
        schluessel = anfrage.get("FromDate", url)
        return self.antworten.get(schluessel, HttpResponse(200, ""))


def test_anfrage_ist_die_der_seite():
    anfrage = json.loads(base64.b64decode(csv_request(REGEL_NACH_KEY["stunden_3"], date(2026, 12, 1))))
    assert anfrage == {
        "PublicationId": {"Type": 0, "Logic": 0, "AggregationPeriod": 0, "ConsecutiveCount": 3},
        "FromDate": "2026-12-01T00:00:00",
        "ToDate": "2027-01-01T00:00:00",
    }


def test_refresh_schreibt_veroeffentlichte_monate_und_ueberspringt_leere():
    http = _FakeGet({
        "2026-06-01T00:00:00": HttpResponse(
            200, load_fixture("netztransparenz_aw_viertelstunde_2026_06.csv")
        ),
    })
    repo = InMemoryAwZeitRepository()
    ergebnis = refresh_aw_zeiten(
        NetztransparenzAwSource(http_client=http),
        repo,
        [date(2026, 6, 1), date(2026, 7, 1)],
        regeln=[REGEL_NACH_KEY["viertelstunde"]],
    )
    assert ergebnis.rows_written == 2880 and len(repo.rows) == 2880
    assert [m.veroeffentlicht for m in ergebnis.monate] == [True, False]
    assert ergebnis.fehler == ()
    assert http.calls[0]["url"].endswith("/Marktwerte/CsvDownload.ashx")


def test_refresh_ein_fehler_haelt_die_anderen_regeln_nicht_auf():
    class _Kaputt:
        def get(self, url, params, timeout):
            anfrage = json.loads(base64.b64decode(params["request"]))
            if anfrage["PublicationId"]["Logic"] == 1:
                return HttpResponse(503, "down")
            return HttpResponse(200, "")

    ergebnis = refresh_aw_zeiten(
        NetztransparenzAwSource(http_client=_Kaputt()), None, [JUNI], regeln=REGELN
    )
    assert len(ergebnis.monate) == len(REGELN) - 1
    assert len(ergebnis.fehler) == 1 and ergebnis.fehler[0].startswith("viertelstunde_2ct")


def test_refresh_bricht_bei_unerreichbarer_quelle_ab():
    class _Weg:
        calls = 0

        def get(self, url, params, timeout):
            _Weg.calls += 1
            raise TimeoutError("read timed out")

    ergebnis = refresh_aw_zeiten(
        NetztransparenzAwSource(http_client=_Weg()), None, [JUNI, date(2026, 7, 1)], regeln=REGELN
    )
    assert _Weg.calls == 1 and len(ergebnis.fehler) == 1 and ergebnis.monate == ()


def test_monate_zum_abruf_ueber_den_jahreswechsel():
    assert monate_zum_abruf(date(2027, 1, 20)) == (
        date(2026, 11, 1), date(2026, 12, 1), date(2027, 1, 1)
    )


# --- Jahresmarktwert -------------------------------------------------------


def test_jahresmarktwert_2025_aus_der_uenb_tabelle():
    werte = parse_jahresmarktwert_html(load_fixture("netztransparenz_jahresmarktwert_2025.html"))
    assert {(w.technology, w.value_ct_kwh) for w in werte} == {
        ("allgemein", 8.932),
        ("wind_an_land", 7.441),
        ("wind_auf_see", 8.059),
        ("solar", 4.508),
    }
    assert {w.year for w in werte} == {2025} and not any(w.provisional for w in werte)


def test_jahresmarktwert_ohne_tabelle_oder_mit_fremder_zeile_bricht_ab():
    html = load_fixture("netztransparenz_jahresmarktwert_2025.html")
    with pytest.raises(MarketValueSourceUnavailable):
        parse_jahresmarktwert_html("<html>relaunch</html>")
    with pytest.raises(MarketValueSourceError):
        parse_jahresmarktwert_html(html.replace("<span>Solar</span>", "<span>Biomasse</span>"))
    with pytest.raises(MarketValueSourceError):
        parse_jahresmarktwert_html(html.replace(">2025<", ">Jahr<"))


def test_jahresmarktwert_quelle_und_vorrang_veroeffentlicht():
    seite = load_fixture("netztransparenz_jahresmarktwert_2025.html")

    class _Seite:
        def get(self, url, params, timeout):
            assert "Marktwert%C3%BCbersicht" in url
            return HttpResponse(200, seite)

    werte = NetztransparenzJahresmarktwertSource(http_client=_Seite()).fetch_neuestes_jahr()
    repo = InMemoryAnnualMarketValueRepository()
    repo.upsert_values([AnnualMarketValue(2025, "solar", 4.9, provisional=True)])
    assert repo.upsert_values(werte) == 4
    assert repo.upsert_values([AnnualMarketValue(2025, "solar", 5.1, provisional=True)]) == 0
    assert repo.rows[("solar", 2025)].value_ct_kwh == 4.508
