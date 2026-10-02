"""MiSpeL MP-25: das Python-Rechenwerk ``mispel_pauschal`` im Gleichlauf mit den Vektoren.

Rechnet jeden Fall aus ``docs/contracts/v2/mispel-pauschal-vectors.json`` (per Pfad, dieselbe Datei wie der
Leser ``test_mispel_pauschal_vectors.py`` und das Java-Rechenwerk ``MispelPauschalRechenwerk``) und vergleicht
JEDEN Viertelstunden- und Jahreswert exakt, in Katalog-Reihenfolge; dazu alle 49 Zellen der Tabellen 1 und 2
(A2 S. 12), die tagesscharfe Verteilung der Pauschalgrenzen auf Rumpfjahre (A2 S. 53–55; T S. 88–89) und die
Eingangsprüfungen (unbekannt ist keine Null).
"""
import json
from datetime import date
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

from voltpilot_optimization import mispel_pauschal as mp

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DOC = json.loads((V2 / 'mispel-pauschal-vectors.json').read_text(), parse_float=Decimal, parse_int=Decimal)
FAELLE = {f['name']: f for f in DOC['faelle']}
KATALOG = {f['nr']: f for f in DOC['formeln']}


def rechne(fall, **mehr):
    args = dict(stammdaten=fall.get('stammdaten'), ungefoerdert=tuple(fall.get('ungefoerdert', ())))
    if 'rumpfjahre' in fall:
        args['stammdaten'] = None
        args['rumpfjahre'] = [mp.Rumpfjahr(r['von'], r['bis'], r['stammdaten']) for r in fall['rumpfjahre']]
    args.update(mehr)
    return mp.rechne(fall['formelsatz'], fall['viertelstunden'], **args)


def test_vierzehn_faelle():
    assert len(FAELLE) == 14


def test_katalog_wie_vektoren():
    assert mp.FORMELSAETZE == tuple(DOC['formelsaetze'])
    for fs, satz in DOC['formelsaetze'].items():
        assert mp.EINGAENGE[fs] == tuple(satz['eingaenge']), fs
        assert mp.STAMMDATEN[fs] == tuple(satz['stammdaten']), fs
        for ebene in ('viertelstunde', 'jahr', 'rumpfjahr'):
            soll = tuple(nr for nr in satz['formeln'] if KATALOG[nr]['ebene'] == ebene)
            assert mp.FORMELN[fs][ebene] == soll, (fs, ebene)
        for nr, von in mp.SUMMEN[fs].items():
            assert KATALOG[nr]['summe']['von'] in (von, KATALOG.get(von, {}).get('ersetzt')), (fs, nr)


@pytest.mark.parametrize('name', sorted(FAELLE))
def test_fall_exakt(name):
    fall = FAELLE[name]
    e = rechne(fall)
    soll = fall['erwartet']
    assert len(e.viertelstunden) == len(soll['viertelstunden'])
    for ist, s in zip(e.viertelstunden, soll['viertelstunden']):
        assert ist['beginn'].isoformat() == s['beginn']
        assert [k for k in ist if k != 'beginn'] == [k for k in s if k != 'beginn']
        for nr, wert in s.items():
            if nr != 'beginn':
                assert ist[nr] == Fraction(wert), (s['beginn'], nr)
    assert list(e.jahre) == list(soll['jahre'])
    for schluessel, werte in soll['jahre'].items():
        assert list(e.jahre[schluessel]) == list(werte), schluessel
        for nr, wert in werte.items():
            assert e.jahre[schluessel][nr] == Fraction(wert), (schluessel, nr, e.jahre[schluessel][nr])


def test_tabellen_1_und_2():
    assert len(DOC['pauschalgrenzen']) == 49
    for zelle in DOC['pauschalgrenzen']:
        leer = {nr: 0 for nr in mp.SUMMEN[zelle['formelsatz']]}
        j = mp.jahr(zelle['formelsatz'], leer, zelle['stammdaten'])
        for nr, wert in zelle['erwartet'].items():
            assert j[nr] == Fraction(wert), (zelle['name'], nr)


def test_bnetza_gerundet():
    """Jede gedruckte BNetzA-Zahl ist der kaufmännisch gerundete Wert des Rechenwerks (A2 S. 12, S. 56)."""
    for fall in DOC['faelle']:
        if 'bnetza' not in fall:
            continue
        e = rechne(fall)
        for schluessel, werte in fall['bnetza'].items():
            for nr, gedruckt in werte.items():
                stellen = -Decimal(str(gedruckt)).as_tuple().exponent
                exakt = e.jahre[schluessel][nr]
                gerundet = (Decimal(exakt.numerator) / Decimal(exakt.denominator)).quantize(
                    Decimal(1).scaleb(-max(stellen, 0)), rounding='ROUND_HALF_UP')
                assert gerundet == Decimal(str(gedruckt)), (fall['name'], schluessel, nr)


# --------------------------------------------------------------------------- Rumpfjahre tagesscharf


@pytest.mark.parametrize('von, bis, sommer', [
    (date(2028, 1, 1), date(2028, 3, 31), 0),
    (date(2028, 3, 31), date(2028, 4, 1), 1),
    (date(2028, 4, 1), date(2028, 9, 30), 183),
    (date(2028, 9, 30), date(2028, 10, 1), 1),
    (date(2027, 5, 17), date(2027, 12, 31), 137),
    (date(2027, 1, 1), date(2027, 5, 16), 46),
    (date(2027, 1, 1), date(2027, 12, 31), 183),
])
def test_sommertage(von, bis, sommer):
    assert mp.sommertage(von, bis) == sommer


@pytest.mark.parametrize('jahr_, grenzen', [
    (2027, [(date(2027, 1, 1), date(2027, 5, 16)), (date(2027, 5, 17), date(2027, 12, 31))]),
    (2028, [(date(2028, 1, 1), date(2028, 3, 31)), (date(2028, 4, 1), date(2028, 9, 30)),
            (date(2028, 10, 1), date(2028, 12, 31))]),
    (2028, [(date(2028, 1, 1), date(2028, d.month, d.day)) for d in [date(2028, 7, 4)]]
     + [(date(2028, 7, 5), date(2028, 12, 31))]),
])
def test_rumpfjahre_teilen_die_jahresgrenzen_ohne_rest(jahr_, grenzen):
    """Gleiche Stammdaten in allen Rumpfjahren: ∑ (P1)R = (P1) und ∑ (P3)R = (P3) — tagesscharf, ohne Rest."""
    stamm = {'Pinst': 8, 'SKinst': 10}
    p1 = p3 = Fraction(0)
    for von, bis in grenzen:
        j = mp.jahr('P1', {'(P7)': 0, '(P9)': 0, '(P14)': 0}, stamm, mp.Rumpfjahr(von, bis, stamm))
        p1 += j['(P1)R']
        p3 += j['(P3)R']
        assert j['(P20)'] == (366 if jahr_ == 2028 else 365)
    assert (p1, p3) == (4000, 320)


def test_rumpfjahr_im_winter_foerdert_nichts():
    fall = FAELLE['p1-rumpfjahre-sommerperiode-tagesscharf-schaltjahr']
    e = rechne(fall)
    winter = e.jahre['2028-01-01/2028-03-31']
    assert winter['(P14)'] == 200 and winter['(P1)R'] == 0 and winter['(P15)'] == 0
    assert winter['(P8)'] == winter['(P7)'] - winter['(P3)R']


# --------------------------------------------------------------------------- Eingangsprüfungen

QH = {'beginn': '2027-06-01T12:00:00+02:00', 'Z1NB¼': 1, 'Z1NE¼': 2, 'AW¼': 7, 'SP¼': -1}
P1 = {'Pinst': 8, 'SKinst': 10}


def test_negativer_spotpreis_ist_kein_fehler():
    e = mp.rechne('P1', [QH], stammdaten=P1)
    assert e.viertelstunden[0]['(P5)¼'] == 0 and e.viertelstunden[0]['(P13)¼'] == 2


@pytest.mark.parametrize('aenderung, text', [
    ({'Z1NE¼': None}, 'unbekannt ist keine Null'),
    ({'SP¼': None}, 'unbekannt ist keine Null'),
    ({'Z1NB¼': -1}, 'nie negativ'),
    ({'ZWNE¼': 1}, 'kennt die Eingänge'),
    ({'beginn': '2027-06-01T12:00:00'}, 'Versatz'),
    ({'beginn': '2027-06-01T12:05:00+02:00'}, 'Viertelstundenraster'),
])
def test_eingaenge_abgelehnt(aenderung, text):
    """``None`` = der Eingang fehlt in der Viertelstunde."""
    q = {k: v for k, v in {**QH, **aenderung}.items() if v is not None}
    with pytest.raises(ValueError, match=text):
        mp.rechne('P1', [q], stammdaten=P1)


def test_reihenfolge_und_doppel_abgelehnt():
    with pytest.raises(ValueError, match='streng aufsteigend'):
        mp.rechne('P1', [QH, QH], stammdaten=P1)


@pytest.mark.parametrize('formelsatz, stamm, text', [
    ('P1', {'Pinst': 8, 'SKinst': 0}, 'SKinst = 0'),
    ('P1', {'Pinst': 8}, 'unbekannt ist keine Null'),
    ('P2', {'Pinst': 8, 'SKinst': 10}, 'kennt die Stammdaten'),
    ('P4', {'Pinst': 9, 'SKinst': 10, 'Painst': 8, 'Pbinst': 0.8}, 'Painst \\+ Pbinst'),
    ('P7', P1, 'nicht im Umfang'),
])
def test_stammdaten_abgelehnt(formelsatz, stamm, text):
    with pytest.raises(ValueError, match=text):
        mp.stammdaten_pruefen(formelsatz, stamm)


def test_p4_variante_nur_bei_uebereinstimmenden_aw_zeiten():
    q = {'beginn': '2027-06-01T12:00:00+02:00', 'Z1NB¼': 0, 'Z1NE¼': 2, 'AWa¼': 7, 'AWb¼': 0, 'SP¼': 3}
    with pytest.raises(ValueError, match='übereinstimmende AW>0-Zeiten'):
        mp.rechne('P4-Variante', [q], stammdaten={'Pinst': 10, 'SKinst': 10, 'Painst': 8, 'Pbinst': 2})


def test_ungefoerdert_nur_aw_eingaenge_des_formelsatzes():
    with pytest.raises(ValueError, match='ungefördert'):
        mp.rechne('P1', [QH], stammdaten=P1, ungefoerdert=('AWb¼',))


def test_rumpfjahre_abgelehnt():
    r = mp.Rumpfjahr(date(2027, 1, 1), date(2027, 5, 31), P1)
    with pytest.raises(ValueError, match='keinem Rumpfjahr'):
        mp.rechne('P1', [QH], rumpfjahre=[r])
    with pytest.raises(ValueError, match='überlappen'):
        mp.rechne('P1', [QH], rumpfjahre=[r, mp.Rumpfjahr(date(2027, 5, 31), date(2027, 12, 31), P1)])
    with pytest.raises(ValueError, match='einem Kalenderjahr'):
        mp.rechne('P1', [QH], rumpfjahre=[mp.Rumpfjahr(date(2027, 6, 1), date(2028, 1, 31), P1)])
    with pytest.raises(ValueError, match='nicht beides'):
        mp.rechne('P1', [QH], stammdaten=P1, rumpfjahre=[r])


def test_kein_uebertrag_zwischen_jahren():
    """Jedes Kalenderjahr für sich (A2 S. 9–10; T S. 63): ein zweites Jahr ändert das erste nicht."""
    zwei = [QH, {**QH, 'beginn': '2028-06-01T12:00:00+02:00'}]
    assert mp.rechne('P1', zwei, stammdaten=P1).jahre['2027'] == mp.rechne('P1', [QH], stammdaten=P1).jahre['2027']


# --------------------------------------------------------------------------- Abwandlungen zu P2 und P3

P4_QH = {'beginn': '2027-06-01T12:00:00+02:00', 'Z1NB¼': 1500, 'Z1NE¼': 6000, 'AWa¼': 7, 'AWb¼': 7, 'SP¼': 3}


@pytest.mark.parametrize('basisfall, groessen', [
    ('P1', ('(P2)P1',)), ('P2', ('(P2)P2',)), ('P3', ('(P2)P1', '(P2)P2', '(P2)P3')),
])
def test_p4_in_abwandlung_mit_der_rechengroesse_des_basisfalls(basisfall, groessen):
    """Regel abwandlungen (A2 S. 34, S. 43, S. 49): die Saldierungsseite ist die des Basisfalls, die Förderseite P4."""
    stamm = {'Pinst': 8, 'SKinst': 10, 'Painst': 6, 'Pbinst': 2}
    if basisfall == 'P2':
        stamm.pop('SKinst')
    e = mp.rechne('P4', [P4_QH], stammdaten=stamm, basisfall=basisfall)
    j = e.jahre['2027']
    assert tuple(nr for nr in j if nr.startswith('(P2)')) == groessen
    basis = mp.rechne(basisfall, [{k: v for k, v in P4_QH.items() if k not in ('AWa¼', 'AWb¼')} | {'AW¼': 7}],
                      stammdaten={k: v for k, v in stamm.items() if k in mp.STAMMDATEN[basisfall]}).jahre['2027']
    for nr in ('(P1)', '(P3)', '(P4)', '(P7)', '(P8)', '(P9)', '(P10)', '(P11)'):
        assert j[nr] == basis[nr], nr
    assert j['(P16a)'] + j['(P16b)'] == basis['(P15)']


def test_basisfall_nur_fuer_abwandlungen():
    with pytest.raises(ValueError, match='Abwandlung'):
        mp.rechne('P1', [QH], stammdaten=P1, basisfall='P2')
    with pytest.raises(ValueError, match='Abwandlung'):
        mp.rechne('P5', [], stammdaten=P1, basisfall='P4')
