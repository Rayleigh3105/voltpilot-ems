"""AP-19 NW-1: jeder Vektor derselben Datei wie Java und TypeScript, exakter Vergleich."""
import copy
import json
import re
from pathlib import Path

import jsonschema
import pytest

from voltpilot_optimization import energiemanagement as em

V2 = Path(__file__).resolve().parents[3] / 'docs' / 'contracts' / 'v2'
DATA = json.loads((V2 / 'energiemanagement-vectors.json').read_text())
SCHEMA = json.loads((V2 / 'energiemanagement.schema.json').read_text())
REF = json.loads((V2 / 'uems-referenzunternehmen.json').read_text())
QUELLE = Path(em.__file__).read_text()


def rechnen(fall):
    e = fall['eingang']
    match fall['operation']:
        case 'ueberpruefung': return em.ueberpruefung(e)
        case 'wiedervorlage': return em.wiedervorlage(e)
        case 'anwendungsbereich_vergleich': return em.anwendungsbereich_vergleich(e)
        case 'verzeichnis_zeile': return em.verzeichnis_zeile(e)
        case 'pruefsumme': return em.pruefsumme(e)
        case 'satz': return em.satz(e['schluessel'], e['werte'])
    raise AssertionError(f"Ungeprüfte Operation: {fall['operation']}")


def fall(anfang):
    return next(c for c in DATA['cases'] if c['name'].startswith(anfang))


@pytest.mark.parametrize('fall', DATA['cases'], ids=lambda c: c['name'])
def test_jeder_vertragsvektor(fall):
    assert rechnen(fall) == fall['erwartet']


def test_schema_startwerte_vokabular_woerter_und_saetze():
    jsonschema.validate(DATA, SCHEMA)
    assert em.STARTWERTE == DATA['startwerte']
    assert em.VOKABULARE == DATA['vokabulare']
    assert em.DOKUMENT_ART_KLASSE == DATA['dokument_art_klasse']
    assert em.LEITUNGS_PFLICHT == DATA['leitungs_pflicht']
    assert em.WOERTER == DATA['woerter']
    assert em.SAETZE == DATA['saetze']
    assert len({c['name'] for c in DATA['cases']}) == len(DATA['cases'])
    assert list(DATA['dokument_art_klasse']) == DATA['vokabulare']['dokument_art']


def test_schema_schliesst_unbekannte_felder_aus():
    falsch = copy.deepcopy(DATA)
    next(c for c in falsch['cases'] if c['operation'] == 'wiedervorlage')['eingang']['zusatz'] = 1.5
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(falsch, SCHEMA)


def test_pflichtfaelle_der_paragraf_acht_zeile():
    for anfang in ('R1 D-0001 seit 64 Tagen fällig', 'R12 BB-0002 seit 457 Tagen', 'R2 nur Strom → Gas nicht im Betrachtungsumfang'):
        assert fall(anfang)
    assert fall('R1 D-0001 seit 64 Tagen fällig')['erwartet']['satz'] == 'seit 64 Tagen fällig'
    assert fall('R12 BB-0002 seit 457 Tagen')['erwartet']['faellig'][0]['satz'] == 'seit 457 Tagen fällig'
    assert fall('R2 nur Strom → Gas nicht im Betrachtungsumfang')['erwartet']['traeger_nur_im_anwendungsbereich'] == ['Gas']


def test_datum_von_aussen_keine_uhr():
    """Jede Frist rechnet gegen den Eingang ``abruf`` — keine Uhr in der Regel (§8 IP-2)."""
    assert not re.search(r'date\.today|datetime\.now|time\.time|\.now\(|\butcnow\b', QUELLE)
    probe = fall('R1 D-0001 seit 64 Tagen fällig')['eingang']
    assert em.ueberpruefung({**probe, 'abruf': '2029-02-13'})['tage'] == 65


def test_die_staende_der_referenzdatei_sind_was_die_operationen_rechnen():
    """NW-1 ⟷ NW-3: Wiedervorlage und Überprüfung im Stand BR-2029-0001 sind genau die Ausgänge der Vektoren."""
    abzug = REF['managementbewertungen'][0]['staende'][0]['abzug']
    wv = fall('R12 BB-0002 seit 457 Tagen')['erwartet']
    assert [{k: z[k] for k in ('kennzeichen', 'titel', 'faellig_am', 'satz')} for z in wv['faellig'] + wv['vorschau']] == abzug['eingaben']['wiedervorlage']
    grundlagen = abzug['eingaben']['grundlagen']
    assert grundlagen['energiepolitik']['ueberpruefung'] == fall('R1 D-0001 seit 64 Tagen fällig')['erwartet']['satz']
    assert grundlagen['anwendungsbereich']['ueberpruefung'] == fall('R2 D-0002 am 12.02.2029')['erwartet']['satz']
    einstellung = REF['energiemanagement']['einstellung']
    assert (einstellung['ueberpruefung_monate'], einstellung['audit_rhythmus_monate'], einstellung['managementbewertung_rhythmus_monate'],
            einstellung['feststellung_frist_tage'], einstellung['vorschau_tage']) == tuple(
        em.STARTWERTE[k] for k in ('ueberpruefung_monate', 'audit_rhythmus_monate', 'managementbewertung_rhythmus_monate', 'feststellung_frist_tage', 'vorschau_tage'))
    muster = DATA['kennzeichen_muster']
    assert all(re.match(muster['dokument'], d['kennzeichen']) for d in REF['dokumente'])
    assert all(re.match(muster['internes_audit'], a['kennzeichen']) for a in REF['audits'])
    assert all(re.match(muster['feststellung'], f['kennzeichen']) for f in REF['feststellungen'])


def test_kanonische_zahlform_der_zwillinge_nicht_die_des_katalogs():
    """IP-1-Befund: json.dumps schreibt −5.0; der Bau schreibt −5 (bericht.md A1) — und nur so stimmt die Prüfsumme der Referenzdatei."""
    stand = REF['managementbewertungen'][0]['staende'][0]
    katalog = json.dumps(stand['abzug'], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    assert '-5.0' in katalog and '-5.0' not in em.kanonisch(stand['abzug'])
    assert em.pruefsumme({'kopie': stand['abzug']})['pruefsumme'] == stand['pruefsumme']
