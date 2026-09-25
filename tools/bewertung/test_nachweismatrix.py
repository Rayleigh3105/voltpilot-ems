#!/usr/bin/env python3
"""Vertragstest der Nachweismatrix (AP-20 NW-1) - an der leeren Matrix im Repo und an einer Fixture.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Braucht `jsonschema` (wie die Vertragstests von services/optimization). Fehlt es, bricht der
Lauf mit ImportError ab - er wird nie übersprungen (NR2).
"""

import copy
import io
import json
import pathlib
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402

HIER = pathlib.Path(__file__).resolve().parent
FIXTURE = HIER / 'fixtures' / 'matrix-beispiel.json'
README = nachweismatrix.REPO / 'docs' / 'bewertung' / 'README.md'

# Die geschlossenen Vokabulare, festgenagelt: wer eines ändert, ändert Schema, README und diese Zeilen.
VOKABULARE = {
    'urteil': ['belegt', 'nicht_maschinell_pruefbar', 'offen', 'nicht_zugesagt'],
    'traeger_norm': ['haelt_fest', 'verweis', 'misst', 'beim_kunden'],
    'nachweis_art': ['test_lauf', 'vektor_lauf', 'werkzeug_artefakt', 'betreiber_bestaetigung',
                     'fachperson_bestaetigung', 'protokoll', 'stand_mit_pruefsumme'],
    'zusage_art': ['plan_abnahme', 'release_notiz', 'flaeche', 'anmeldung', 'betrieb', 'box_notiz'],
    'wer': ['Crew', 'Betreiber', 'Kunde', 'Fachperson', 'Captain'],
    'lesart': ['traegt', 'anmerkung', 'widerspruch'],
}


def lade(pfad):
    return json.loads(pathlib.Path(pfad).read_text(encoding='utf-8'))


def zusage(m, kz):
    return next(z for z in m['zusagen'] if z['kennzeichen'] == kz)


def normzeile(m, abschnitt):
    return next(z for z in m['norm_teil'] if z['abschnitt'] == abschnitt)


class LeereMatrix(unittest.TestCase):

    def test_das_schema_ist_ein_gueltiges_json_schema(self):
        from jsonschema import Draft202012Validator
        Draft202012Validator.check_schema(nachweismatrix.lade_schema())

    def test_die_leere_matrix_im_repo_haelt_den_vertrag(self):
        self.assertEqual(nachweismatrix.verstoesse(lade(nachweismatrix.MATRIX_PFAD)), [])

    def test_die_matrix_traegt_normfassung_und_stichtag_und_die_zusagen(self):
        m = lade(nachweismatrix.MATRIX_PFAD)
        self.assertEqual(m['matrix_fassung'], 1)
        self.assertEqual((m['normfassung']['international'], m['normfassung']['deutsch']),
                         nachweismatrix.NORMFASSUNGEN[1])
        self.assertRegex(m['normfassung']['stichtag'], r'^\d{4}-\d{2}-\d{2}$')
        # Das Zusagen-Inventar steht seit AP-20 IP-5 (Wache: test_zusagen.py); Norm-Teil (IP-7) und Kundenaufgaben (IP-8) folgen.
        self.assertTrue(m['zusagen'])

    def test_die_gliederung_hat_dreissig_abschnitte_und_nur_nummern(self):
        gliederung = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']
        self.assertEqual(len(gliederung), 30)
        self.assertEqual(len(set(gliederung)), 30)
        for a in gliederung:
            self.assertRegex(a, r'^(4|5|6|7|8|9|10)\.\d(\.\d)?$')


class FixtureMatrix(unittest.TestCase):

    def test_die_fixture_haelt_den_vertrag(self):
        self.assertEqual(nachweismatrix.verstoesse(lade(FIXTURE)), [])

    def test_die_fixture_traegt_jedes_urteil_und_jeden_traeger(self):
        m = lade(FIXTURE)
        self.assertEqual({z['urteil'] for z in m['zusagen']}, set(VOKABULARE['urteil']))
        self.assertEqual({z['traeger'] for z in m['norm_teil']}, set(VOKABULARE['traeger_norm']))


class Gegenproben(unittest.TestCase):
    """Jede Gegenprobe ändert die grüne Fixture an genau einer Stelle und muss rot werden."""

    def setUp(self):
        self.m = lade(FIXTURE)
        self.assertEqual(nachweismatrix.verstoesse(self.m), [], 'die Fixture muss vor der Gegenprobe grün sein')

    def assertRot(self, matrix, *erwartet):
        fehler = nachweismatrix.verstoesse(matrix)
        self.assertTrue(fehler, 'erwartet rot, war grün')
        text = '\n'.join(fehler)
        for teil in erwartet:
            self.assertIn(teil, text)
        return fehler

    def test_ein_urteil_ausserhalb_des_vokabulars_ist_rot(self):
        zusage(self.m, 'Z-005')['urteil'] = 'erfuellt'
        self.assertRot(self.m, 'zusagen/0/urteil', "'erfuellt' is not one of")

    def test_eine_norm_zeile_ohne_kundenaufgabe_ist_rot(self):
        del normzeile(self.m, '7.2')['kundenaufgabe']
        self.assertRot(self.m, 'norm_teil/2', "'kundenaufgabe' is a required property")

    def test_eine_norm_zeile_mit_leerer_kundenaufgabe_ist_rot(self):
        normzeile(self.m, '7.2')['kundenaufgabe'] = ''
        self.assertRot(self.m, 'norm_teil/2/kundenaufgabe')

    def test_eine_kundenaufgabe_mit_urteil_ist_rot_nr5(self):
        self.m['kundenaufgaben'][0]['urteil'] = 'offen'
        self.assertRot(self.m, 'kundenaufgaben/0', "'urteil' was unexpected")

    def test_nicht_maschinell_pruefbar_ohne_person_ist_rot_nr4(self):
        del zusage(self.m, 'Z-013')['bestaetigung']
        self.assertRot(self.m, 'zusagen/2', "'bestaetigung' is a required property")

    def test_eine_bestaetigung_ohne_aussage_ist_rot_nr4(self):
        del zusage(self.m, 'Z-013')['bestaetigung']['aussage']
        self.assertRot(self.m, 'zusagen/2/bestaetigung', "'aussage' is a required property")

    def test_eine_norm_zeile_nicht_maschinell_pruefbar_ohne_fachperson_ist_rot(self):
        del normzeile(self.m, '9.2.2')['fachperson']
        self.assertRot(self.m, 'norm_teil/7', "'fachperson' is a required property")

    def test_eine_norm_zeile_mit_belegt_ist_rot(self):
        normzeile(self.m, '9.2.2')['urteil'] = 'belegt'
        self.assertRot(self.m, 'norm_teil/7/urteil')

    def test_offen_ohne_wer_liefert_ist_rot_nr7(self):
        del zusage(self.m, 'Z-015')['wer_liefert']
        self.assertRot(self.m, 'zusagen/3', "'wer_liefert' is a required property")

    def test_wer_liefert_ausserhalb_des_vokabulars_ist_rot(self):
        zusage(self.m, 'Z-015')['wer_liefert'][0]['wer'] = 'Werkzeug'
        self.assertRot(self.m, 'zusagen/3/wer_liefert/0/wer')

    def test_belegt_ohne_nachweis_ist_rot(self):
        zusage(self.m, 'Z-005')['nachweise'] = []
        self.assertRot(self.m, 'zusagen/0/nachweise')

    def test_ein_test_lauf_ohne_lauf_bericht_ist_rot_nr1(self):
        del zusage(self.m, 'Z-005')['nachweise'][0]['lauf']
        self.assertRot(self.m, 'zusagen/0/nachweise/0', "'lauf' is a required property")

    def test_ein_nachweis_ohne_stand_ist_rot_nr3(self):
        del zusage(self.m, 'Z-005')['nachweise'][0]['stand']
        self.assertRot(self.m, 'zusagen/0/nachweise/0', "'stand' is a required property")

    def test_belegt_nur_mit_einer_bestaetigung_ist_rot_nr4(self):
        n = zusage(self.m, 'Z-005')['nachweise'][0]
        n['art'] = 'betreiber_bestaetigung'
        del n['lauf'], n['lauf_sha256']
        self.assertRot(self.m, 'zusagen/0/nachweise', 'does not contain items matching')

    def test_nicht_zugesagt_ohne_grund_ist_rot(self):
        del zusage(self.m, 'Z-012')['grund']
        self.assertRot(self.m, 'zusagen/1', "'grund' is a required property")

    def test_ein_unbekanntes_feld_ist_rot(self):
        zusage(self.m, 'Z-005')['erfuellt'] = True
        self.assertRot(self.m, 'zusagen/0', "'erfuellt' was unexpected")

    def test_ein_abschnitt_ausserhalb_der_gliederung_ist_rot(self):
        zusage(self.m, 'Z-013')['norm'] = ['7.5']
        self.assertRot(self.m, 'zusagen/2/norm/0')

    def test_eine_lange_umschreibung_ist_rot_mx2(self):
        normzeile(self.m, '7.2')['umschreibung'] = 'x' * 161
        self.assertRot(self.m, 'norm_teil/2/umschreibung', 'is too long')

    def test_ein_ungueltiges_datum_ist_rot(self):
        zusage(self.m, 'Z-005')['nachweise'][0]['datum'] = '2026-13-01'
        self.assertRot(self.m, 'zusagen/0/nachweise/0/datum')

    def test_eine_nachweis_kennung_ohne_paket_ist_rot_nr9(self):
        zusage(self.m, 'Z-015')['wer_liefert'][1]['was'] = 'Rückweg-Übung NW-8 fahren'
        self.assertRot(self.m, 'zusagen/3/wer_liefert/1/was', '„NW-8“ ohne Paket')

    def test_eine_nachweis_kennung_mit_paket_ist_gruen_nr9(self):
        zusage(self.m, 'Z-015')['grund'] = 'AP-14 NW-8 und AP-20 NW-1 offen'
        self.assertEqual(nachweismatrix.verstoesse(self.m), [])

    def test_ein_doppeltes_kennzeichen_ist_rot(self):
        self.m['kundenaufgaben'].append(copy.deepcopy(self.m['kundenaufgaben'][0]))
        self.assertRot(self.m, 'kundenaufgaben: KA-02 steht mehr als einmal')

    def test_eine_norm_zeile_mit_fehlender_kundenaufgabe_ist_rot(self):
        normzeile(self.m, '9.1.2')['kundenaufgabe'] = 'KA-09'
        self.assertRot(self.m, 'norm_teil[9.1.2].kundenaufgabe: KA-09 gibt es bei den Kundenaufgaben nicht',
                       'kundenaufgaben[KA-03].norm: die Norm-Zeile 9.1.2 nennt eine andere Kundenaufgabe')

    def test_eine_zusage_die_ihre_norm_zeile_nicht_nennt_ist_rot(self):
        normzeile(self.m, '7.5.3')['zusagen'] = ['Z-015']
        self.assertRot(self.m, 'zusagen[Z-013].norm: die Norm-Zeile 7.5.3 nennt Z-013 nicht')

    def test_ein_verweis_in_einen_noch_leeren_teil_wird_nicht_geprueft(self):
        # Die Teile entstehen nacheinander: Zusagen (AP-20 IP-5) vor Norm-Teil (IP-7) vor Kundenaufgaben (IP-8).
        nur_zusagen = copy.deepcopy(self.m)
        nur_zusagen['norm_teil'], nur_zusagen['kundenaufgaben'] = [], []
        self.assertEqual(nachweismatrix.verstoesse(nur_zusagen), [])
        ohne_aufgaben = copy.deepcopy(self.m)
        ohne_aufgaben['kundenaufgaben'] = []
        self.assertEqual(nachweismatrix.verstoesse(ohne_aufgaben), [])

    def test_eine_geaenderte_normfassung_ohne_neue_matrix_fassung_ist_rot_mx6(self):
        self.m['normfassung']['international'] = 'ISO 50001:2031'
        self.assertRot(self.m, 'normfassung: weicht von Matrix-Fassung 1 ab')

    def test_eine_normfassung_ohne_stichtag_ist_rot_mx6(self):
        del self.m['normfassung']['stichtag']
        self.assertRot(self.m, 'normfassung', "'stichtag' is a required property")


class Vokabulare(unittest.TestCase):

    def test_das_schema_traegt_genau_die_festgenagelten_vokabulare(self):
        defs = nachweismatrix.lade_schema()['$defs']
        for name, woerter in VOKABULARE.items():
            self.assertEqual(defs[name]['enum'], woerter, name)
        self.assertTrue(set(defs['urteil_norm']['enum']) <= set(VOKABULARE['urteil']))

    def test_das_readme_nennt_jedes_wort_jedes_vokabulars(self):
        text = README.read_text(encoding='utf-8')
        for name, woerter in VOKABULARE.items():
            for wort in woerter:
                self.assertIn(f'`{wort}`', text, f'{name}: {wort} fehlt im README')

    def test_das_readme_nennt_jede_eingetragene_normfassung(self):
        text = README.read_text(encoding='utf-8')
        for fassung, (international, deutsch) in nachweismatrix.NORMFASSUNGEN.items():
            self.assertRegex(text, rf'\|\s*{fassung}\s*\|\s*{re.escape(international)}\s*\|\s*{re.escape(deutsch)}\s*\|')


class Kommandozeile(unittest.TestCase):

    def lauf(self, *argv):
        aus = io.StringIO()
        with redirect_stdout(aus):
            code = nachweismatrix.main(list(argv))
        return code, aus.getvalue()

    def test_gruen_an_der_matrix_im_repo(self):
        code, aus = self.lauf()
        self.assertEqual(code, 0)
        self.assertIn('Vertrag hält', aus)

    def test_rot_mit_einer_zeile_je_verstoss(self):
        m = lade(FIXTURE)
        zusage(m, 'Z-005')['urteil'] = 'erfuellt'
        del normzeile(m, '7.2')['kundenaufgabe']
        with tempfile.TemporaryDirectory() as tmp:
            pfad = pathlib.Path(tmp) / 'matrix.json'
            pfad.write_text(json.dumps(m, ensure_ascii=False), encoding='utf-8')
            code, aus = self.lauf(str(pfad))
        self.assertEqual(code, 1)
        zeilen = aus.strip().splitlines()
        self.assertEqual(len(zeilen), 2, aus)
        self.assertTrue(all(z.startswith('rot: ') for z in zeilen), aus)


if __name__ == '__main__':
    unittest.main()
