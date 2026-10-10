"""NW-1: jeder Vektor derselben Datei wie Java und TypeScript, exakter Vergleich."""
import copy
import json
from pathlib import Path

import jsonschema
import pytest

from voltpilot_optimization import bezugsbasis as b

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DATA = json.loads((V2 / 'bezugsbasis-vectors.json').read_text())
SCHEMA = json.loads((V2 / 'bezugsbasis.schema.json').read_text())
REF = json.loads((V2 / 'uems-referenzunternehmen.json').read_text())


def rechnen(fall):
    e = fall['eingang']
    match fall['operation']:
        case 'referenzperiode': return b.referenzperiode(e['text'], e['laufender_monat'])
        case 'basiswert': return b.basiswert(e['grundlage'])
        case 'modell': return b.modell(e['methode'], e['reihe'])
        case 'abhaengigkeit': return b.abhaengigkeit(e['x1'], e['x2'])
        case 'vergleich': return b.vergleich(e)
        case 'roh_und_bereinigt': return b.roh_und_bereinigt(e)
        case 'methoden_paar': return b.methoden_paar(e)
        case 'zeitraum': return b.zeitraum(e)
        case 'roh': return b.roh(e['aktuell'], e['vorher'])
        case 'runden': return b.runden(e['wert'], e['stellen'])
        case 'frist': return b.frist(e)
        case _: raise AssertionError(f"Ungeprüfte Operation: {fall['operation']}")


@pytest.mark.parametrize('fall', DATA['cases'], ids=lambda f: f['name'])
def test_jeder_vertragsvektor(fall):
    assert rechnen(fall) == fall['erwartet']


def test_schema_startwerte_und_vokabular():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)
    jsonschema.validate(DATA, SCHEMA)
    assert b.STARTWERTE == DATA['startwerte']
    assert {'methode': b.METHODEN, 'urteil': b.URTEILE, 'grund': b.GRUENDE, 'datenlage': b.DATENLAGE, 'richtung': b.RICHTUNGEN,
            'anpassungsgrund': b.ANPASSUNGSGRUENDE, 'faktor_art': b.FAKTOR_ARTEN, 'basis_zustand': b.BASIS_ZUSTAENDE,
            'freigabe_status': b.FREIGABE_STATUS} == DATA['vokabulare']
    assert len({f['name'] for f in DATA['cases']}) == len(DATA['cases'])


@pytest.mark.parametrize('mutation', ['zusatz', 'float'])
def test_schema_schliesst_unbekannte_felder_und_floatwerte_aus(mutation):
    falsch = copy.deepcopy(DATA)
    grundlage = next(f for f in falsch['cases'] if f['operation'] == 'basiswert')['eingang']['grundlage'][0]
    grundlage['zusatz' if mutation == 'zusatz' else 'zaehler'] = 1.5
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(falsch, SCHEMA)


def _fassung(kennzeichen, nr):
    basis = next(x for x in REF['bezugsbasen'] if x['kennzeichen'] == kennzeichen)
    return next(f for f in basis['fassungen'] if f['fassung'] == nr)


def _zahl(text):
    return float(text) if text is not None else None


def test_fassungen_der_vektoren_sind_die_der_referenzdatei():
    """NW-3-Naht: jede zitierte BB-000x-Fassung trägt Basiswert, Koeffizienten, Streuung, Toleranz und Monate der Datei 1.8."""
    gesehen = set()
    for fall in DATA['cases']:
        e = fall['eingang']
        for f in [e.get('fassung')] + [e.get(k, {}).get('fassung') for k in ('bereinigt', 'modell', 'verhaeltnis') if isinstance(e.get(k), dict)]:
            if not f or f['kennzeichen'] == 'BB-9001':
                continue
            datei = _fassung(f['kennzeichen'], f['fassung'])
            gesehen.add((f['kennzeichen'], f['fassung']))
            assert _zahl(f['basiswert']) == datei['basiswert'], fall['name']
            assert int(datei['monate'].split(' ')[0]) == f['monate'], fall['name']
            assert _zahl(f['toleranz_prozent']) == datei['toleranz_prozent'], fall['name']
            if f['methode'] == datei['methode']:
                assert (f['koeffizienten'] and {k: float(v) for k, v in f['koeffizienten'].items()}) == datei['koeffizienten'], fall['name']
                assert _zahl(f['streuung_prozent']) == datei['streuung_prozent'], fall['name']
                if f['spannweite']:
                    assert {k: float(v) for k, v in f['spannweite'][0].items()} == {k: datei['spannweite'][k] for k in f['spannweite'][0]}
    assert gesehen == {('BB-0001', 1), ('BB-0001', 2), ('BB-0002', 2), ('BB-0003', 1), ('BB-0004', 1)}


# Benannte Ausnahme von M5 (Entscheid 27.09.2026): BB-0001 Fassung 2 bleibt a = 10 523 — die AP-18-Daten rechnen damit.
M5_AUSNAHME = {('BB-0001', 'a'): 0}


def test_modell_rechnet_die_referenzdatei_auf_ihre_stellen_nach():
    """M5: die Datei friert die Koeffizienten auf vier Stellen ein, wie die Rechnung sie liefert (BB-0004 seit 27.09.2026;
    1.8 trug die Anzeige-Werte des Konzepts 119 / 3,8) — außer der benannten Ausnahme; M2: jedes Modell trägt seine Spannweite."""
    cases = {x['name']: x for x in DATA['cases']}
    for name, kz in (('R12 Modell mit einer Einflussgröße über zwölf Monate', 'BB-0001'), ('R3 Gradtage: Modell mit Konstante', 'BB-0004')):
        datei = _fassung(kz, 2 if kz == 'BB-0001' else 1)
        aus = cases[name]['erwartet']
        for k, v in datei['koeffizienten'].items():
            stellen = M5_AUSNAHME.get((kz, k), 4)
            assert b.fest(b.q(aus['koeffizienten'][k]), stellen) == f'{v:.{stellen}f}', (kz, k)
            assert stellen == 0 or f'{v:.4f}' == f'{float(aus["koeffizienten"][k]):.4f}', (kz, k, 'vier Stellen')
        assert (float(aus['r2']), float(aus['streuung_prozent']), float(aus['basiswert'])) == (datei['r2'], datei['streuung_prozent'], datei['basiswert'])
        assert {k: float(x) for k, x in aus['spannweite'][0].items()} == {k: datei['spannweite'][k] for k in aus['spannweite'][0]}, kz


def test_abnahmefaelle_der_referenzdatei():
    cases = {x['name']: x['erwartet'] for x in DATA['cases']}
    g = {x['fall']: x['gegeben'] for x in REF['abnahmefaelle_ap17']['faelle']}
    jan = cases['Verhältnis über Gradtage sagt besser, Modell im Rahmen']
    assert jan['modell']['urteil'] == g['R3']['januar_2028']['modell']['urteil']
    assert (jan['modell']['erwartet'], jan['modell']['delta_prozent']) == ('1944.8784', '-0.8'), 'M5: vier Stellen'
    # Konzept R3 rechnet mit den Anzeige-Koeffizienten 119 / 3,8: dieselbe Operation liefert dann 1 943 und −0,7 %
    konzept = copy.deepcopy(next(x for x in DATA['cases'] if x['name'] == 'Verhältnis über Gradtage sagt besser, Modell im Rahmen'))
    konzept['eingang']['modell']['fassung']['koeffizienten'] = {
        'a': str(g['R3']['modell']['a_m3']), 'b': str(g['R3']['modell']['b_m3_je_kd'])}
    alt = rechnen(konzept)
    for seite, zahlen in (('modell', alt), ('verhaeltnis', jan)):
        soll = g['R3']['januar_2028'][seite]
        assert (b.runden(zahlen[seite]['erwartet'], 0), float(zahlen[seite]['delta_prozent']), zahlen[seite]['urteil']) == (
            str(soll['erwartet_m3']), soll['delta_prozent'], soll['urteil']), seite
    vb = REF['leistungsvergleiche'][0]['vergleich']
    dez = cases['R2 Dezember 2027 bereinigt: 12,9 % über dem Modell, schlechter']
    assert (float(b.runden(dez['erwartet'], 0)), float(dez['delta_prozent']), float(dez['band_prozent']), dez['urteil']) == (
        vb['erwartet'], vb['delta_prozent'], vb['band_prozent'], vb['urteil'])
    r5 = cases['R5 November 2026 Netzbezug je m²: 4,1 % mehr, schlechter']
    assert (float(r5['delta_prozent']), r5['urteil']) == (g['R5']['november_2026']['delta_prozent'], g['R5']['november_2026']['urteil'])
    assert g['R5']['november_2026']['kennzeichen'] in r5['kennzeichen']
    r7 = cases['R7 November 2026 gegen Fassung 2 nach der Korrektur: im Rahmen']
    assert (float(r7['delta_prozent']), r7['urteil']) == (g['R7']['november_2026']['gegen_fassung_2']['delta_prozent'],
                                                         g['R7']['november_2026']['gegen_fassung_2']['urteil'])
    assert cases['R5 Januar 2027: Basis beendet, nicht bewertbar']['grund'] == g['R5']['januar_februar_2027']['grund']


def test_rundung_ist_kaufmaennisch_nicht_python_round():
    assert round(81984.5) == 81984 and b.runden('81984.5', 0) == '81985'
    assert b.runden('-2.05', 1) == '-2.1' and b.runden('2.05', 1) == '2.1'


def test_startwerte_und_methoden_sind_die_des_methoden_katalogs():
    """IP-5 liefert den Katalog, dieser Vertrag rechnet mit denselben Startwerten und Kennungen."""
    katalog = json.loads((V2 / 'bezugsbasis-methoden.json').read_text())
    p = katalog['parameter']
    assert (p['mindest_monate_referenzperiode'], float(p['toleranz_prozent_startwert']), float(p['spannweite_prozent_startwert']),
            float(p['abhaengigkeit_r_startwert']), p['wiedervorlage_monate_startwert']) == (
        b.STARTWERTE['mindest_monate'], float(b.STARTWERTE['toleranz_prozent']), float(b.STARTWERTE['spannweite_prozent']),
        float(b.STARTWERTE['abhaengig_r']), b.STARTWERTE['wiedervorlage_monate'])
    assert [m['kennung'] for m in katalog['methoden']] == b.METHODEN
