"""AP-18 NW-1: jeder Vektor derselben Datei wie Java und TypeScript, exakter Vergleich."""
import copy
import json
import re
from pathlib import Path

import jsonschema
import pytest

from voltpilot_optimization import verbesserung as v

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DATA = json.loads((V2 / 'verbesserung-vectors.json').read_text())
SCHEMA = json.loads((V2 / 'verbesserung.schema.json').read_text())
REF = json.loads((V2 / 'uems-referenzunternehmen.json').read_text())
QUELLE = Path(v.__file__).read_text()


def rechnen(fall):
    e = fall['eingang']
    match fall['operation']:
        case 'wirkung': return v.wirkung(e)
        case 'zielstand': return v.zielstand(e)
        case 'frist': return v.frist(e)
        case 'satz': return v.satz(e['schluessel'], e['werte'])
    raise AssertionError(f"Ungeprüfte Operation: {fall['operation']}")


def fall(anfang):
    return next(c for c in DATA['cases'] if c['name'].startswith(anfang))


@pytest.mark.parametrize('fall', DATA['cases'], ids=lambda c: c['name'])
def test_jeder_vertragsvektor(fall):
    assert rechnen(fall) == fall['erwartet']


def test_schema_startwerte_vokabular_und_saetze():
    jsonschema.validate(DATA, SCHEMA)
    assert v.STARTWERTE == DATA['startwerte']
    assert v.VOKABULARE == DATA['vokabulare']
    assert v.SAETZE == DATA['saetze']
    assert len({c['name'] for c in DATA['cases']}) == len(DATA['cases'])


def test_schema_schliesst_unbekannte_felder_aus():
    falsch = copy.deepcopy(DATA)
    next(c for c in falsch['cases'] if c['operation'] == 'wirkung')['eingang']['zusatz'] = 1.5
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(falsch, SCHEMA)


def _gerundet(ergebnis):
    return dict(gemessen_kwh=int(ergebnis['gemessen']), erwartet_kwh=int(float(ergebnis['erwartet']) + 0.5),
                delta_prozent=float(ergebnis['delta_prozent']), urteil=ergebnis['urteil'], band_prozent=float(ergebnis['band_prozent']),
                monate_bewertbar=ergebnis['monate_bewertbar'], monate_gesamt=ergebnis['monate_endgueltig'],
                ausgeschlossen={n['monat']: n['grund'] for n in ergebnis['nicht_gezaehlt'] if n['grund'] != 'umsetzungsmonat'})


def test_wirkung_und_zielstand_sind_die_kopien_der_referenzdatei():
    """NW-1 ⟷ NW-3: die Stände der Referenzdatei 1.9 sind genau das, was die Operationen rechnen."""
    m1 = next(m for m in REF['massnahmen'] if m['kennzeichen'] == 'M-2028-0001')
    assert _gerundet(fall('R5 Februar bis Oktober 2028')['erwartet']) == m1['bewertungen'][0]['kopie']['wirkung']
    ez = next(z for z in REF['energieziele'] if z['kennzeichen'] == 'EZ-2028-0001')
    ende = fall('R10 11 von 12')['erwartet']
    assert _gerundet(ende) == ez['bewertung']['kopie']['stand']
    assert ende['vorschlag'] is ez['bewertung']['kopie']['vorschlag'] is None


def test_nirgends_ein_mittel_der_monats_delta():
    """WK3/Z3/U5: die Summe entsteht in bezugsbasis.zeitraum; das Mittel (−2,3 %) wäre falsch, gerechnet sind −2,4 %."""
    assert not re.search(r'\bmittel\w*\(|average|\.mean\(|statistics\.|/\s*len\(', QUELLE, re.I)
    assert 'bb.zeitraum(' in QUELLE and 'bb.vergleich(' in QUELLE
    r5 = fall('R5 Februar bis Oktober 2028')
    deltas = [float(bb_v['delta_prozent']) for bb_v in (v.bb.vergleich(m['vergleich']) for m in r5['eingang']['monate'][1:])
              if bb_v['delta_prozent'] is not None]
    assert round(sum(deltas) / len(deltas), 1) == -2.3 != float(r5['erwartet']['delta_prozent'])
