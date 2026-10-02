"""MiSpeL MP-24: Leser der Vektor-Datei ``docs/contracts/v2/mispel-pauschal-vectors.json``.

Prüft die Datei gegen ihr Schema und die Regeln L1–L10 aus ``mispel-pauschal.md`` — im
Gleichlauf mit dem Java-Leser ``MispelPauschalVectorsTest`` (services/api). Kein Rechenwerk:
die Formeln (P1)–(P22)R rechnet erst MP-25 gegen dieselben Fälle; hier wird nur festgehalten,
dass jeder Fall vollständig, zeitlich richtig zugeordnet, in seinen Summen (∑J) stimmig, exakt
geschrieben und mit den gerundeten Zahlen der BNetzA verträglich ist.
"""
import json
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from pathlib import Path
from zoneinfo import ZoneInfo

import jsonschema
import pytest

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
ROH = json.loads((V2 / 'mispel-pauschal-vectors.json').read_text())
DOC = json.loads((V2 / 'mispel-pauschal-vectors.json').read_text(),
                 parse_float=Decimal, parse_int=Decimal)
SCHEMA = json.loads((V2 / 'mispel-pauschal.schema.json').read_text())
BERLIN = ZoneInfo('Europe/Berlin')
FORMELN = {f['nr']: f for f in DOC['formeln']}
ORDNUNG = list(FORMELN)
SAETZE = DOC['formelsaetze']
AW_DER = {'(P12)¼': 'AW¼', '(P12a)¼': 'AWa¼', '(P12b)¼': 'AWb¼'}


def nummer(nr):
    return nr[1:nr.index(')')]


def formeln(satz, *ebenen):
    return [nr for nr in SAETZE[satz]['formeln'] if FORMELN[nr]['ebene'] in ebenen]


def zeit(s):
    return datetime.fromisoformat(s)


def tag(qh):
    return zeit(qh['beginn']).astimezone(BERLIN).date()


def exakt(w):
    """L8: Dezimalzahl, wo der Wert ein endlicher Dezimalbruch ist, sonst gekürzter Bruch als Text."""
    if isinstance(w, str):
        z, n = (int(t) for t in w.split('/'))
        b = Fraction(z, n)
        assert (b.numerator, b.denominator) == (z, n), f'{w} ist nicht gekürzt'
        rest = n
        for p in (2, 5):
            while rest % p == 0:
                rest //= p
        assert rest != 1, f'{w} ist ein endlicher Dezimalbruch und gehört als Zahl geschrieben'
        return b
    return Fraction(w)


def zeitraeume(fall):
    """Schlüssel der (Rumpf-)Jahre mit den Tagen [von, bis] und den Stammdaten."""
    if 'rumpfjahre' in fall:
        return {r['schluessel']: (date.fromisoformat(r['von']), date.fromisoformat(r['bis']), r['stammdaten'])
                for r in fall['rumpfjahre']}
    jahre = sorted({tag(qh).year for qh in fall['viertelstunden']})
    return {str(j): (date(j, 1, 1), date(j, 12, 31), fall['stammdaten']) for j in jahre}


def schluessel_von(fall, qh):
    t = tag(qh)
    treffer = [k for k, (von, bis, _) in zeitraeume(fall).items() if von <= t <= bis]
    assert len(treffer) == 1, f"{qh['beginn']} liegt in genau einem (Rumpf-)Jahr"
    return treffer[0]


def ersetzt(satz):
    return {FORMELN[nr]['ersetzt']: nr for nr in SAETZE[satz]['formeln'] if 'ersetzt' in FORMELN[nr]}


def test_l1_schema():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    jsonschema.validate(ROH, SCHEMA)


def test_l2_katalog():
    assert len(FORMELN) == len(DOC['formeln']), 'Formelnummer doppelt'
    # Anlage 2 S. 28–32: jeder Basisfall trägt die Nummern (P1) bis (P15), je einmal.
    for satz in ('P1', 'P2', 'P5'):
        nummern = [nummer(nr) for nr in SAETZE[satz]['formeln'] if FORMELN[nr]['ebene'] != 'rumpfjahr']
        assert sorted(nummern, key=lambda n: int(n[1:])) == [f'P{i}' for i in range(1, 16)], satz
    # zusammen sind (P1) bis (P22) vollständig (A2 S. 28–55)
    alle = {nummer(nr).rstrip('ab') for nr in FORMELN if nr.startswith('(P')}
    assert alle == {f'P{i}' for i in range(1, 23)}
    eingaenge = {e for s in SAETZE.values() for e in s['eingaenge']}
    for name, satz in SAETZE.items():
        assert satz['formeln'] == [nr for nr in ORDNUNG if nr in satz['formeln']], f'{name}: Katalog-Reihenfolge'
        for nr in satz['formeln']:
            assert nr in FORMELN, f'{name}: {nr} im Katalog'
            assert name in FORMELN[nr]['formelsaetze'], f'{nr} nennt {name}'
    for nr, f in FORMELN.items():
        for name in f['formelsaetze']:
            assert nr in SAETZE[name]['formeln'], f'{name} führt {nr}'
        if 'summe' in f:
            assert f['summe']['von'] in FORMELN or f['summe']['von'] in eingaenge, f['summe']['von']
        if 'quotient' in f:
            assert f['quotient']['zaehler'] in FORMELN and f['quotient']['nenner'] in FORMELN
        if 'ersetzt' in f:
            alt = f['ersetzt']
            assert nummer(alt) == nummer(nr) and FORMELN[alt]['ebene'] == f['ebene'], nr
            for name in f['formelsaetze']:
                assert alt not in SAETZE[name]['formeln'], f'{name} führt {alt} neben {nr}'


def test_l3_namen_eindeutig():
    namen = [f['name'] for f in DOC['faelle']] + [p['name'] for p in DOC['pauschalgrenzen']]
    assert len(set(namen)) == len(namen)


FAELLE = DOC['faelle']
IDS = [f['name'] for f in FAELLE]


def pruefe_stammdaten(satz, sd, wo):
    assert set(sd) == set(SAETZE[satz]['stammdaten']), wo
    if 'SKinst' in sd:
        assert sd['SKinst'] > 0, f'{wo}: SKinst > 0, sonst kein Stromspeicher'
    if 'Painst' in sd:  # A2 S. 36: (P1) bezieht sich auf die Summe der Solaranlagen
        assert sd['Pinst'] == sd['Painst'] + sd['Pbinst'], wo


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l3_eingaenge_und_stammdaten(fall):
    satz = fall['formelsatz']
    ungefoerdert = set(fall.get('ungefoerdert', []))
    assert ungefoerdert <= set(SAETZE[satz]['eingaenge']), 'ungefördert nennt nur AW-Eingänge des Formelsatzes'
    soll = set(SAETZE[satz]['eingaenge']) - ungefoerdert | {'beginn'}
    for qh in fall['viertelstunden']:
        assert set(qh) == soll, qh['beginn']
        if satz == 'P4-Variante':  # A2 S. 41: jederzeit übereinstimmende AW>0-Zeiten
            assert (qh['AWa¼'] > 0) == (qh['AWb¼'] > 0), qh['beginn']
    assert ('stammdaten' in fall) != ('rumpfjahre' in fall), 'Stammdaten am Fall oder je Rumpfjahr'
    for k, (_, _, sd) in zeitraeume(fall).items():
        pruefe_stammdaten(satz, sd, f"{fall['name']} {k}")


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l4_raster(fall):
    beginne = [zeit(qh['beginn']) for qh in fall['viertelstunden']]
    for b in beginne:
        assert b.minute % 15 == 0 and b.second == 0, b
    assert all(a < b for a, b in zip(beginne, beginne[1:])), 'streng aufsteigend'
    assert [e['beginn'] for e in fall['erwartet']['viertelstunden']] == [qh['beginn'] for qh in fall['viertelstunden']]
    if 'rumpfjahre' in fall:
        rj = fall['rumpfjahre']
        for r in rj:
            assert date.fromisoformat(r['von']) <= date.fromisoformat(r['bis'])
        for a, b in zip(rj, rj[1:]):  # der Änderungstag zählt zum Rumpfjahr davor (A2 S. 53)
            assert date.fromisoformat(b['von']) == date.fromisoformat(a['bis']) + timedelta(days=1)


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l5_jahresgrenzen(fall):
    z = zeitraeume(fall)
    for k, (von, bis, _) in z.items():
        assert von.year == bis.year, f'{k} liegt in einem Kalenderjahr'
    if 'rumpfjahre' in fall:
        for r in fall['rumpfjahre']:
            assert r['schluessel'] == f"{r['von']}/{r['bis']}"
    erwartet = {schluessel_von(fall, qh) for qh in fall['viertelstunden']}
    assert set(fall['erwartet']['jahre']) == erwartet == set(z)


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l6_vollstaendig(fall):
    satz = fall['formelsatz']
    ebenen = ('jahr', 'rumpfjahr') if 'rumpfjahre' in fall else ('jahr',)
    for k, werte in fall['erwartet']['jahre'].items():
        assert list(werte) == formeln(satz, *ebenen), k
    for e in fall['erwartet']['viertelstunden']:
        assert [k for k in e if k != 'beginn'] == formeln(satz, 'viertelstunde'), e['beginn']


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l7_summen(fall):
    satz = fall['formelsatz']
    statt = ersetzt(satz)
    werte = {e['beginn']: e for e in fall['erwartet']['viertelstunden']}
    for nr in formeln(satz, 'jahr'):
        if 'summe' not in FORMELN[nr]:
            continue
        von = statt.get(FORMELN[nr]['summe']['von'], FORMELN[nr]['summe']['von'])
        summen = {k: Fraction(0) for k in fall['erwartet']['jahre']}
        for qh in fall['viertelstunden']:
            quelle = qh if von in qh else werte[qh['beginn']]
            summen[schluessel_von(fall, qh)] += exakt(quelle[von])
        for k, s in summen.items():
            assert exakt(fall['erwartet']['jahre'][k][nr]) == s, f'{k} {nr}'
    # die 0/1-Werte folgen ihren Eingängen; ungeförderte Anlagen tragen 1 (A2 S. 40, S. 50)
    for qh in fall['viertelstunden']:
        e = werte[qh['beginn']]
        assert e['(P5)¼'] == (1 if qh['SP¼'] >= 0 else 0), qh['beginn']
        for nr, aw in AW_DER.items():
            if nr in e:
                quelle = 'AWa¼' if satz == 'P4-Variante' else aw
                soll = 1 if quelle in fall.get('ungefoerdert', []) or qh[quelle] > 0 else 0
                assert e[nr] == soll, f"{qh['beginn']} {nr}"


@pytest.mark.parametrize('fall', FAELLE, ids=IDS)
def test_l8_zahlform(fall):
    for e in fall['erwartet']['viertelstunden']:
        for k, w in e.items():
            if k != 'beginn':
                exakt(w)
    for werte in fall['erwartet']['jahre'].values():
        for w in werte.values():
            exakt(w)


def sommertage(von, bis):
    return sum(1 for i in range((bis - von).days + 1) if 4 <= (von + timedelta(days=i)).month <= 9)


@pytest.mark.parametrize('fall', [f for f in FAELLE if 'rumpfjahre' in f], ids=lambda f: f['name'])
def test_l9_rumpfjahr_tage(fall):
    for r in fall['rumpfjahre']:
        von, bis = date.fromisoformat(r['von']), date.fromisoformat(r['bis'])
        jahr = fall['erwartet']['jahre'][r['schluessel']]
        j = von.year
        assert jahr['(P17)'] == 183 == sommertage(date(j, 1, 1), date(j, 12, 31))
        assert jahr['(P20)'] == (date(j + 1, 1, 1) - date(j, 1, 1)).days
        assert jahr['(P19)R'] == sommertage(von, bis)
        assert jahr['(P22)R'] == (bis - von).days + 1


def gerundet(wert, gedruckt):
    """L10: kaufmännisch (halbe Einheit aufwärts) auf die Stellen, die die BNetzA druckt."""
    stellen = max(0, -gedruckt.as_tuple().exponent)
    d = Decimal(wert.numerator) / Decimal(wert.denominator)
    return d.quantize(Decimal(1).scaleb(-stellen), rounding=ROUND_HALF_UP)


@pytest.mark.parametrize('fall', [f for f in FAELLE if 'bnetza' in f], ids=lambda f: f['name'])
def test_l10_bnetza_fall(fall):
    for k, werte in fall['bnetza'].items():
        for nr, gedruckt in werte.items():
            assert gerundet(exakt(fall['erwartet']['jahre'][k][nr]), gedruckt) == gedruckt, f'{k} {nr}'


@pytest.mark.parametrize('zelle', DOC['pauschalgrenzen'], ids=lambda z: z['name'])
def test_pauschalgrenzen_l3_l6_l8_l10(zelle):
    satz = zelle['formelsatz']
    pruefe_stammdaten(satz, zelle['stammdaten'], zelle['name'])
    grenzen = [nr for nr in formeln(satz, 'jahr') if nummer(nr) in ('P1', 'P2', 'P3', 'P4')]
    assert list(zelle['erwartet']) == grenzen
    werte = {nr: exakt(w) for nr, w in zelle['erwartet'].items()}
    for nr, gedruckt in zelle['bnetza'].items():
        assert gerundet(werte[nr], gedruckt) == gedruckt, nr
    pinst = Fraction(zelle['stammdaten']['Pinst'])
    for nr, gedruckt in zelle['bnetza_je_kwp'].items():
        assert gerundet(werte[nr] / pinst, gedruckt) == gedruckt, f'{nr} je kWp'


def test_tabelle_1_vollstaendig():
    # A2 S. 12: sieben Solarleistungen × sieben Speicherkapazitäten
    zellen = {(int(z['stammdaten']['Pinst']), int(z['stammdaten']['SKinst'])) for z in DOC['pauschalgrenzen']}
    assert zellen == {(p, s) for p in (1, 4, 6, 8, 10, 15, 30) for s in (45, 30, 15, 10, 8, 6, 4)}
