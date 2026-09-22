"""NW-1: jeder Vektor derselben Datei wie Java und TypeScript, exakter Vergleich."""
import copy
import json
from pathlib import Path

import jsonschema
import pytest

from voltpilot_optimization import bewertung as b

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DATA = json.loads((V2 / 'bewertung-vectors.json').read_text())
MESSABDECKUNG = json.loads((V2 / 'messabdeckung.json').read_text())
SCHEMA = json.loads((V2 / 'bewertung.schema.json').read_text())


def rechnen(fall):
    e = fall['eingang']
    match fall['operation']:
        case 'nenner': return b.nenner(e['anlagen'])
        case 'menge': return b.menge(e['messstellen'], e['traeger'])
        case 'rangliste' | 'urteil': return b.urteil(e)
        case 'abdeckung': return b.abdeckung(e)
        case 'prozess_summe_passt': return b.prozess_summe_passt(e['gemessen'], e['summen'])
        case 'toleranz': return b.toleranz(e['fuehrend'], e['vergleich'], e['toleranz'])
        case _: raise AssertionError(f"Ungeprüfte Operation: {fall['operation']}")


@pytest.mark.parametrize('fall', DATA['cases'], ids=lambda f: f['name'])
def test_jeder_vertragsvektor(fall):
    assert rechnen(fall) == fall['erwartet']


def test_schema_und_startwerte():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    jsonschema.validate(DATA, SCHEMA)
    assert b.STARTWERTE == DATA['startwerte']
    assert list(b.TRAEGER) == DATA['vokabulare']['traeger']
    assert b.URTEILE == DATA['vokabulare']['urteil']
    assert b.ABDECKUNG == DATA['vokabulare']['abdeckung']
    assert b.EINSTUFUNGEN == DATA['vokabulare']['einstufung']
    assert len({f['name'] for f in DATA['cases']}) == len(DATA['cases'])


@pytest.mark.parametrize('mutation', ['zusatz', 'float'])
def test_schema_schliesst_unbekannte_felder_und_floatwerte_aus(mutation):
    falsch = copy.deepcopy(DATA)
    anlage = falsch['cases'][0]['eingang']['anlagen'][0]
    anlage['zusatz' if mutation == 'zusatz' else 'zufluss'] = 1.5
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(falsch, SCHEMA)


def test_ahrenberg_werte_sind_die_der_referenzdatei():
    ref = json.loads((V2 / 'uems-referenzunternehmen.json').read_text())
    gegeben = {x['fall']: x['gegeben'] for x in ref['abnahmefaelle_ap16']['faelle']}
    cases = {x['name']: x for x in DATA['cases']}
    assert cases['R1-Nenner-185380']['erwartet']['wert'] == str(gegeben['R1']['nenner_kwh'])
    for x in cases['R2-Oktober-2026']['eingang']['einsaetze']:
        assert x['menge'] == str(gegeben['R2']['rangliste'][x['kennung']]['menge_kwh'])
    assert [x['name'] for x in ref['bewertung_umfang']['fassungen'][0]['traeger'] if x['mit_anteil']] == ['Strom']
    for k in ref['bewertung_kriterien'][0]['kriterien']:
        if k['schwelle'] is not None:
            assert str(DATA['startwerte'][k['kennung']]) == str(k['schwelle'])


def test_messabdeckung_ahrenberg_laeuft_durch_denselben_p3_zwilling():
    messstellen = []
    for einsatz in MESSABDECKUNG['je_einsatz']:
        if einsatz['traeger'] != 'Strom':
            continue
        messstellen.extend(dict(kennung=m['messstelle'], traeger='Strom', art='gemessen', direkt=True,
                                archiviert=False, wert=m['oktober_2026'].replace(' ', '').split('kWh')[0], ersatz='0')
                            for m in einsatz['gemessen'])
        messstellen.extend(dict(kennung=m['messstelle'], traeger='Strom', art='gemessen', direkt=True,
                                archiviert=False, wert=None, ersatz='0') for m in einsatz['geplant'])
    reste = [{'kennung': kennung, 'wert': str(rest['kwh'])}
             for kennung, rest in MESSABDECKUNG['rest_je_anlage'].items()]
    aus = b.abdeckung(dict(messstellen=messstellen, traeger='Strom', reste=reste,
                           nenner=str(MESSABDECKUNG['summe']['nenner_kwh']), offene_bedarfe=[],
                           schwelle=b.STARTWERTE['K8']))
    assert aus['menge'] == str(MESSABDECKUNG['summe']['gemessen_zugeordnet_kwh'])
    assert aus['ersatz'] == str(MESSABDECKUNG['summe']['ersatz_kwh'])
    assert aus['ungemessen'] == str(MESSABDECKUNG['summe']['ungemessen_kwh'])
    assert aus['abdeckung_prozent'] == str(MESSABDECKUNG['summe']['abdeckung_prozent'])
    assert aus['K8'] == MESSABDECKUNG['summe']['K8']
    assert len(aus['gemessen']) == 9
    assert aus['geplant'] == ['MS-23']
