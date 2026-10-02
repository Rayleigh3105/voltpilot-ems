"""MiSpeL MP-4: Leser der Vektor-Datei ``docs/contracts/v2/mispel-abgrenzung-vectors.json``.

Prüft die Datei gegen ihr Schema und die Regeln L1–L8 und L10 aus ``mispel-abgrenzung.md`` — im
Gleichlauf mit dem Java-Leser ``MispelAbgrenzungVectorsTest`` (services/api). Kein Rechenwerk:
die Formeln (1)–(33) rechnet erst MP-9 (Python) bzw. MP-8 (Java) gegen dieselben Fälle; hier
wird nur festgehalten, dass jeder Fall vollständig, zeitlich richtig zugeordnet und in seinen
Summen (∑M, ∑J) und Quotienten mit Nenner null in sich stimmig ist.
"""
import json
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import jsonschema
import pytest

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
ROH = json.loads((V2 / 'mispel-abgrenzung-vectors.json').read_text())
DOC = json.loads((V2 / 'mispel-abgrenzung-vectors.json').read_text(),
                 parse_float=Decimal, parse_int=Decimal)
SCHEMA = json.loads((V2 / 'mispel-abgrenzung.schema.json').read_text())
BERLIN = ZoneInfo('Europe/Berlin')
FORMELN = {f['nr']: f for f in DOC['formeln']}
SAETZE = DOC['formelsaetze']
# Anlage 1 S. 33–39: A1 trägt jede Formelnummer (1) bis (33) außer (7)A4 und (8)A4, A4 jede; A2 und A3
# tragen aus Abschn. 4.2.3 nur (19)A2,A3, nicht (17) und (18) (S. 36–37, Lesart in „abweichungen“).
A1_NUMMERN = set(range(1, 34)) - {7, 8}
NUMMERN = {'A1': A1_NUMMERN, 'A2': A1_NUMMERN - {17, 18}, 'A3': A1_NUMMERN - {17, 18}, 'A4': set(range(1, 34))}


def nummer(nr):
    return int(nr[1:nr.index(')')].rstrip('ab')) if nr[1].isdigit() else None


def zeit(s):
    return datetime.fromisoformat(s)


def formeln(satz, ebene):
    return [nr for nr in SAETZE[satz]['formeln'] if FORMELN[nr]['ebene'] == ebene]


def zeitraum(fall, qh):
    """L5: Kalendermonat nach gesetzlicher Zeit, oder der Rumpfmonat, der die Viertelstunde enthält."""
    beginn = zeit(qh['beginn'])
    if 'zeitraeume' not in fall:
        return beginn.astimezone(BERLIN).strftime('%Y-%m')
    treffer = [z['schluessel'] for z in fall['zeitraeume'] if zeit(z['von']) <= beginn < zeit(z['bis'])]
    assert len(treffer) == 1, f"{qh['beginn']} liegt in {len(treffer)} Zeiträumen"
    return treffer[0]


def jahr(fall, schluessel):
    if 'zeitraeume' not in fall:
        return schluessel[:4]
    z = next(z for z in fall['zeitraeume'] if z['schluessel'] == schluessel)
    return zeit(z['von']).astimezone(BERLIN).strftime('%Y')


def test_l1_schema():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    jsonschema.validate(ROH, SCHEMA)


def test_l2_katalog():
    assert len(FORMELN) == len(DOC['formeln']), 'Formelnummer doppelt'
    for satz, nummern in NUMMERN.items():
        assert {nummer(nr) for nr in SAETZE[satz]['formeln']} == nummern, satz
    alle = {nummer(f['nr']) for f in DOC['formeln'] + DOC['nicht_im_umfang']}
    assert set(range(1, 34)) <= alle
    for name, satz in SAETZE.items():
        for nr in satz['formeln']:
            assert nr in FORMELN, f'{name}: {nr} fehlt im Katalog'
            assert name in FORMELN[nr]['formelsaetze'], f'{nr} nennt {name} nicht'
    for nr, f in FORMELN.items():
        for name in f['formelsaetze']:
            assert nr in SAETZE[name]['formeln'], f'{name} führt {nr} nicht'
        if 'summe' in f:
            von = f['summe']['von']
            assert von in FORMELN or any(von in s['eingaenge'] for s in SAETZE.values()), von
        if 'quotient' in f:
            assert f['quotient']['zaehler'] in FORMELN and f['quotient']['nenner'] in FORMELN


def test_l3_namen_eindeutig():
    namen = [f['name'] for f in DOC['faelle']]
    assert len(namen) == len(set(namen))


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l3_eingaenge(fall):
    satz = SAETZE[fall['formelsatz']]
    for qh in fall['viertelstunden']:
        assert set(qh) == {'beginn', *satz['eingaenge']}, qh['beginn']
        if fall['formelsatz'] == 'A5-Variante':  # A1 S. 52: jederzeit übereinstimmende AW>0-Zeiten
            assert (qh['AWa¼'] > 0) == (qh['AWb¼'] > 0), qh['beginn']
    braucht = bool(satz['stammdaten'])
    hat = 'stammdaten' in fall or all('stammdaten' in z for z in fall.get('zeitraeume', [{}]))
    assert hat == braucht


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l4_raster(fall):
    beginne = [zeit(qh['beginn']) for qh in fall['viertelstunden']]
    assert all(b.minute % 15 == 0 for b in beginne)
    assert all(a < b for a, b in zip(beginne, beginne[1:])), 'nicht streng aufsteigend'
    for z in fall.get('zeitraeume', []):
        assert zeit(z['von']) < zeit(z['bis'])


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l5_monats_und_jahresgrenzen(fall):
    monate = {zeitraum(fall, qh) for qh in fall['viertelstunden']}
    assert set(fall['erwartet']['monate']) == monate
    assert set(fall['erwartet']['jahre']) == {jahr(fall, m) for m in monate}


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l6_vollstaendig(fall):
    name, erw = fall['formelsatz'], fall['erwartet']
    for m in erw['monate'].values():
        assert list(m) == formeln(name, 'monat')
    for j in erw['jahre'].values():
        assert list(j) == formeln(name, 'jahr')
    qh_formeln = formeln(name, 'viertelstunde')
    if not qh_formeln:
        assert 'viertelstunden' not in erw
        return
    assert [e['beginn'] for e in erw['viertelstunden']] == [q['beginn'] for q in fall['viertelstunden']]
    for e in erw['viertelstunden']:
        assert list(e) == ['beginn', *qh_formeln]


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l7_summen(fall):
    erw = fall['erwartet']
    qhs = [dict(q, **e) for q, e in zip(fall['viertelstunden'], erw.get('viertelstunden', fall['viertelstunden']))]
    je_monat = defaultdict(list)
    for q in qhs:
        je_monat[zeitraum(fall, q)].append(q)
    for nr in SAETZE[fall['formelsatz']]['formeln']:
        summe = FORMELN[nr].get('summe')
        if not summe:
            continue
        if summe['ueber'] == 'M':
            for m, werte in erw['monate'].items():
                assert werte[nr] == sum((q[summe['von']] for q in je_monat[m]), Decimal(0)), f'{m} {nr}'
        else:
            for j, werte in erw['jahre'].items():
                monate = [w for m, w in erw['monate'].items() if jahr(fall, m) == j]
                assert werte[nr] == sum((w[summe['von']] for w in monate), Decimal(0)), f'{j} {nr}'


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l8_nenner_null(fall):
    erw = fall['erwartet']
    for m, werte in erw['monate'].items():
        for nr, wert in werte.items():
            q = FORMELN[nr].get('quotient')
            nenner_null = q is not None and werte[q['nenner']] == 0
            assert (wert is None) == nenner_null, f'{m} {nr}'
    for werte in [*erw['jahre'].values(), *erw.get('viertelstunden', [])]:
        assert None not in werte.values()


@pytest.mark.parametrize('fall', DOC['faelle'], ids=lambda f: f['name'])
def test_l10_konstanten(fall):
    """L10: eine Formel mit festem Wert ((14)A2,A3,A4 = 0,85, (19)A2,A3 = 0; A1 S. 35, S. 37) trägt ihn in jedem Monat."""
    for m, werte in fall['erwartet']['monate'].items():
        for nr, wert in werte.items():
            if 'konstante' in FORMELN[nr]:
                assert wert == FORMELN[nr]['konstante'], f'{m} {nr}'
