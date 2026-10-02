"""MiSpeL MP-9: das Python-Rechenwerk ``mispel_abgrenzung`` im Gleichlauf mit den Vektoren.

Rechnet jeden Fall aus ``docs/contracts/v2/mispel-abgrenzung-vectors.json`` (per Pfad, dieselbe Datei
wie der Leser ``test_mispel_abgrenzung_vectors.py`` und das Java-Rechenwerk MP-8) und vergleicht JEDEN
Viertelstunden-, Monats- und Jahreswert exakt — ``null`` gegen ``None``, Zahlen als Bruch. Dazu der
Katalog im Code gegen den Katalog der Datei, die Aussagen von Anlage 1 über gleiche Ergebnisse
(A5 ≡ A5-Variante S. 50, A1 ≡ A10 S. 94), die ungeförderte Anlage in A5 (S. 52) und die Eingangsprüfungen.
"""
import json
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

from voltpilot_optimization import mispel_abgrenzung as mw

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DOC = json.loads((V2 / 'mispel-abgrenzung-vectors.json').read_text(), parse_float=Decimal, parse_int=Decimal)
FAELLE = {f['name']: f for f in DOC['faelle']}
KATALOG = {f['nr']: f for f in DOC['formeln']}


def bruch(wert):
    return None if wert is None else Fraction(wert)


def rechne(fall, formelsatz=None):
    args = dict(stammdaten=fall.get('stammdaten'))
    if 'zeitraeume' in fall:
        args = dict(zeitraeume=[mw.Zeitraum(**z) for z in fall['zeitraeume']])
    return mw.rechne(formelsatz or fall['formelsatz'], fall['viertelstunden'], **args)


def test_vierzehn_faelle():
    assert len(FAELLE) == 14


def test_katalog_wie_vektoren():
    assert set(mw.FORMELSAETZE) == set(DOC['formelsaetze'])
    for name, satz in DOC['formelsaetze'].items():
        assert mw.EINGAENGE[name] == tuple(satz['eingaenge']), name
        assert mw.STAMMDATEN[name] == tuple(satz['stammdaten']), name
        for ebene in ('viertelstunde', 'monat', 'jahr'):
            erwartet = tuple(nr for nr in satz['formeln'] if KATALOG[nr]['ebene'] == ebene)
            assert mw.FORMELN[name][ebene] == erwartet, f'{name} {ebene}'


def test_summen_wie_vektoren():
    for nr, f in KATALOG.items():
        if 'summe' in f:
            tabelle = mw._SUMME_M if f['summe']['ueber'] == 'M' else mw._SUMME_J
            assert tabelle[nr] == f['summe']['von'], nr


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_gleichlauf(fall):
    erw, ist = fall['erwartet'], rechne(fall)
    assert list(ist.monate) == list(erw['monate'])
    for m, werte in erw['monate'].items():
        assert ist.monate[m] == {nr: bruch(w) for nr, w in werte.items()}, m
    assert ist.jahre == {j: {nr: bruch(w) for nr, w in werte.items()} for j, werte in erw['jahre'].items()}
    erw_qh = erw.get('viertelstunden', [])
    assert len(ist.viertelstunden) == len(erw_qh)
    for e, q in zip(erw_qh, ist.viertelstunden):
        assert q['beginn'] == mw._zeitpunkt('beginn', e['beginn'])
        assert q == {'beginn': q['beginn'], **{nr: bruch(w) for nr, w in e.items() if nr != 'beginn'}}, e['beginn']


def test_monat_aus_laufenden_summen():
    """MP-11 rechnet mit dem bisherigen Monatsstand: Monatswerte aus den ∑M-Summen statt aus Viertelstunden."""
    fall = FAELLE['a1-monat-alle-formeln']
    ist = rechne(fall)
    qhs = [{**{k: Fraction(v) for k, v in q.items() if k != 'beginn'}, **e}
           for q, e in zip(fall['viertelstunden'], ist.viertelstunden)]
    assert mw.monat('A1', mw.summen('A1', qhs)) == ist.monate['2027-04']
    assert set(mw.SUMMEN['A1']) == {'(3)', '(4)', '(5)', '(6)', '(9)', '(11)', '(26)', '(29)'}


def test_a5_und_a5_variante_gleich():
    """A1 S. 50: die A5-Variante stellt bei übereinstimmenden AW>0-Zeiten weder besser noch schlechter."""
    fall = FAELLE['a5-uebereinstimmende-aw']
    a5, variante = rechne(fall), rechne(fall, 'A5-Variante')
    for m, werte in a5.monate.items():
        for x in 'ab':
            assert werte[f'(32{x})'] == variante.monate[m][f'(32{x})A5-Variante']
    for j, werte in a5.jahre.items():
        for x in 'ab':
            assert werte[f'(33{x})'] == variante.jahre[j][f'(33{x})A5-Variante']


@pytest.mark.parametrize('name', ['a1-netzspeicher-voller-zyklus', 'a1-monatsgrenze-speicherinhalt-als-fremdtankstrom'])
def test_a10_aus_denselben_z1_werten(name):
    """A1 S. 94: A10 ist die vereinfachte Alternative zu A1; über einen vollen Zyklus im Monat gleich, über
    die Monatsgrenze trägt A1 Umlage und A10 nicht (Befund im Vertrag)."""
    fall = FAELLE[name]
    a1 = rechne(fall)
    a10 = mw.rechne('A10', [{k: q[k] for k in ('beginn', 'Z1NB¼', 'Z1NE¼')} for q in fall['viertelstunden']])
    for m in a1.monate:
        assert a10.monate[m]['(21)A10'] == 0
        if name.endswith('voller-zyklus'):
            assert a1.monate[m]['(20)'] == a10.monate[m]['(20)A10']


def test_ungefoerderte_anlage():
    """A1 S. 52: eine ungeförderte gleichartige Anlage hat keinen anzulegenden Wert — ihr (24x)¼ ist in allen
    Viertelstunden 1; die förderfähige Netzeinspeisung der geförderten Anlage bleibt unverändert. Der Fall
    hat AWa¼ = 0 bei AWb¼ > 0, darum ist hier a die ungeförderte (S. 52 nennt b; die Regel gilt je Anlage)."""
    fall = FAELLE['a5-zwei-anlagen-unterschiedliche-aw']
    ohne_awa = [{k: v for k, v in q.items() if k != 'AWa¼'} for q in fall['viertelstunden']]
    ungefoerdert = mw.rechne('A5', ohne_awa, stammdaten=fall['stammdaten'], ungefoerdert=('a',))
    immer_eins = mw.rechne('A5', [{**q, 'AWa¼': 1} for q in ohne_awa], stammdaten=fall['stammdaten'])
    gefoerdert = rechne(fall)
    assert ungefoerdert.monate == immer_eins.monate and ungefoerdert.jahre == immer_eins.jahre
    assert all(q['(24a)¼'] == 1 for q in ungefoerdert.viertelstunden)
    assert any(q['(24a)¼'] == 0 for q in gefoerdert.viertelstunden), 'Fall muss AWa¼ = 0 enthalten'
    for m, werte in ungefoerdert.monate.items():
        assert werte['(32b)'] == gefoerdert.monate[m]['(32b)']
        assert werte['(32a)'] > gefoerdert.monate[m]['(32a)']
    with pytest.raises(ValueError, match='A5'):
        mw.rechne('A1', [], ungefoerdert=('b',))
    with pytest.raises(ValueError, match='Abschn. 10'):
        mw.rechne('A5', [], stammdaten=fall['stammdaten'], ungefoerdert=('a', 'b'))
    with pytest.raises(ValueError, match='kennt die Eingänge'):
        mw.rechne('A5', fall['viertelstunden'], stammdaten=fall['stammdaten'], ungefoerdert=('a',))


QH_A11 = {'beginn': '2027-02-01T10:00:00+01:00', 'Z1NB¼': 5, 'Z1NE¼': 0}


@pytest.mark.parametrize('qh, meldung', [
    ({**QH_A11, 'Z1NB¼': -1}, 'nie negativ'),
    ({**QH_A11, 'Z1NE¼': None}, 'unbekannt ist keine Null'),
    ({k: v for k, v in QH_A11.items() if k != 'Z1NE¼'}, 'unbekannt ist keine Null'),
    ({**QH_A11, 'Z2V¼': 3}, 'kennt die Eingänge'),
    ({**QH_A11, 'beginn': '2027-02-01T10:00:00'}, 'Versatz zur UTC'),
    ({**QH_A11, 'beginn': '2027-02-01T10:05:00+01:00'}, 'Viertelstundenraster'),
])
def test_eingang_abgelehnt(qh, meldung):
    with pytest.raises(ValueError, match=meldung):
        mw.rechne('A11', [qh])


def test_viertelstunden_streng_aufsteigend():
    with pytest.raises(ValueError, match='streng aufsteigend'):
        mw.rechne('A11', [QH_A11, QH_A11])


def test_unbekannter_formelsatz():
    with pytest.raises(ValueError, match='nicht im Umfang'):
        mw.rechne('A2', [])


def test_a5_variante_braucht_gleiche_aw_zeiten():
    fall = FAELLE['a5-zwei-anlagen-unterschiedliche-aw']
    with pytest.raises(ValueError, match='S. 52'):
        mw.rechne('A5-Variante', fall['viertelstunden'], stammdaten=fall['stammdaten'])


@pytest.mark.parametrize('stammdaten', [None, {'Painst': 0, 'Pbinst': 0}, {'Painst': 30}, {'Painst': -1, 'Pbinst': 10}])
def test_a5_braucht_stammdaten(stammdaten):
    with pytest.raises(ValueError):
        mw.rechne('A5', [], stammdaten=stammdaten)


def test_rumpfmonate_pruefen():
    fall = FAELLE['a5-rumpfmonate-leistungsaenderung']
    erster, zweiter = (mw.Zeitraum(**z) for z in fall['zeitraeume'])
    ueber_monat = mw.Zeitraum('x', erster.von, '2027-06-01T00:15:00+02:00', erster.stammdaten)
    with pytest.raises(ValueError, match='Kalendermonat'):
        mw.rechne('A5', fall['viertelstunden'], zeitraeume=[ueber_monat])
    with pytest.raises(ValueError, match='keinem Rumpfmonat'):
        mw.rechne('A5', fall['viertelstunden'], zeitraeume=[erster])
    with pytest.raises(ValueError, match='überlappen'):
        mw.rechne('A5', [], zeitraeume=[erster, mw.Zeitraum('y', '2027-05-14T00:00:00+02:00', zweiter.bis)])
    with pytest.raises(ValueError, match='nicht beides'):
        mw.rechne('A5', [], zeitraeume=[erster], stammdaten=erster.stammdaten)
