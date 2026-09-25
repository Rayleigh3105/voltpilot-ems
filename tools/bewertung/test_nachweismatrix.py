#!/usr/bin/env python3
"""Vertragstest der Nachweismatrix (AP-20 NW-1) - an der leeren Matrix im Repo und an einer Fixture.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Braucht `jsonschema` (wie die Vertragstests von services/optimization). Fehlt es, bricht der
Lauf mit ImportError ab - er wird nie übersprungen (NR2).
"""

import collections
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
        # Zusagen seit AP-20 IP-5 (Wache: test_zusagen.py), Norm-Teil seit IP-7 (NormTeil unten), Kundenaufgaben seit IP-8.
        self.assertTrue(m['zusagen'])
        self.assertTrue(m['norm_teil'])
        self.assertTrue(m['kundenaufgaben'])

    def test_die_gliederung_hat_dreissig_abschnitte_und_nur_nummern(self):
        gliederung = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']
        self.assertEqual(len(gliederung), 30)
        self.assertEqual(len(set(gliederung)), 30)
        for a in gliederung:
            self.assertRegex(a, r'^(4|5|6|7|8|9|10)\.\d(\.\d)?$')


class NormTeil(unittest.TestCase):
    """Der Norm-Teil der Matrix im Repo (AP-20 IP-7): RF-12, L-012, KA-05, W7 und der ISO-Strang AP-16 bis AP-19."""

    ISO_STRANG = ['Z-001', 'Z-002', 'Z-003', 'Z-004', 'Z-005', 'Z-039', *(f'Z-{n:03d}' for n in range(47, 61)), 'Z-075']
    TESTS = nachweismatrix.REPO / 'services' / 'api' / 'src' / 'test' / 'java'

    def setUp(self):
        self.m = lade(nachweismatrix.MATRIX_PFAD)

    def test_jede_zeile_der_gliederung_existiert_rf12(self):
        fehlend, _ = nachweismatrix.gliederung(self.m)
        self.assertEqual(fehlend, [])
        self.assertEqual(len(self.m['norm_teil']), 30)

    def test_gezaehlt_wird_je_traeger_nie_eine_erfuellung_rf12(self):
        _, je_traeger = nachweismatrix.gliederung(self.m)
        self.assertEqual(je_traeger, {'haelt_fest': 15, 'verweis': 7, 'misst': 4, 'beim_kunden': 4})

    def test_jede_norm_zeile_ist_offen_bis_zur_fachperson(self):
        for z in self.m['norm_teil']:
            self.assertEqual(z['urteil'], 'offen', z['abschnitt'])
            self.assertIn('Fachperson', [w['wer'] for w in z['wer_liefert']], z['abschnitt'])

    def test_4_4_6_3_und_9_1_1_sind_zugeordnet_l012(self):
        for abschnitt in ('4.4', '6.3', '9.1.1'):
            z = normzeile(self.m, abschnitt)
            self.assertIn('zugeordnet in AP-20 IP-7 (L-012)', z['herkunft'], abschnitt)
            self.assertNotIn('L-012', z['luecken'], abschnitt)

    def test_die_klimafrage_ist_die_kundenaufgabe_ka05(self):
        self.assertEqual(sorted(z['abschnitt'] for z in self.m['norm_teil'] if z['kundenaufgabe'] == 'KA-05'), ['4.1', '4.2'])
        self.assertIn('Klimawandel', normzeile(self.m, '4.1')['umschreibung'])

    def test_die_ursachenregel_nennt_ihre_quellen_und_nicht_das_etikett_w7(self):
        mit_regel = [z for z in self.m['norm_teil'] if 'Ursachenregel' in z['herkunft']]
        self.assertEqual(sorted(z['abschnitt'] for z in mit_regel), ['10.1', '10.2', '6.2', '9.1.1'])
        regel = nachweismatrix.REPO / 'docs' / 'agents' / 'root' / 'erklaerbarkeit-stufe-0-die-echtheits-reg.md'
        self.assertIn('URSACHE behauptet', ''.join(regel.read_text(encoding='utf-8').splitlines(True)[8:10]))
        for z in mit_regel:
            for quelle in ('erklaerbarkeit-stufe-0-die-echtheits-reg.md:9–10', 'PG/plan.md:413', ':659'):
                self.assertIn(quelle, z['herkunft'], z['abschnitt'])
        for pfad, text in nachweismatrix._texte(self.m):
            for treffer in re.finditer('AP-08 E7', text):
                self.assertTrue(text[:treffer.start()].endswith('nicht „'), f'{pfad}: „AP-08 E7“ ist der Kasten Ersatzwerte (W7)')

    def test_jede_zusage_des_iso_strangs_traegt_einen_kandidaten(self):
        for kz in self.ISO_STRANG:
            self.assertTrue(zusage(self.m, kz)['nachweis_kandidaten'], kz)

    def test_jeder_kandidat_klasse_methode_steht_im_testcode(self):
        for kz in self.ISO_STRANG:
            for kandidat in zusage(self.m, kz)['nachweis_kandidaten']:
                treffer = re.fullmatch(r'(\w+)#(\w+)', kandidat)
                if not treffer:
                    continue
                klasse, methode = treffer.groups()
                dateien = list(self.TESTS.rglob(f'{klasse}.java'))
                self.assertEqual(len(dateien), 1, f'{kz}: {klasse}')
                self.assertRegex(dateien[0].read_text(encoding='utf-8'), rf'void {methode}\(', f'{kz}: {kandidat}')


class Kundenaufgaben(unittest.TestCase):
    """Die Kundenaufgaben der Matrix im Repo (AP-20 IP-8, NR5, RF-04): je Norm-Zeile genau eine, keine mit Urteil."""

    def setUp(self):
        self.m = lade(nachweismatrix.MATRIX_PFAD)
        self.aufgaben = {k['kennzeichen']: k for k in self.m['kundenaufgaben']}

    def test_es_sind_die_neun_ka01_bis_ka09(self):
        self.assertEqual([k['kennzeichen'] for k in self.m['kundenaufgaben']], [f'KA-{n:02d}' for n in range(1, 10)])

    def test_jede_norm_zeile_hat_genau_eine_kundenaufgabe_nw1(self):
        je_abschnitt = collections.Counter(a for k in self.m['kundenaufgaben'] for a in k['norm'])
        self.assertEqual(sorted(je_abschnitt), sorted(z['abschnitt'] for z in self.m['norm_teil']))
        self.assertEqual(set(je_abschnitt.values()), {1})
        for z in self.m['norm_teil']:
            self.assertIn(z['abschnitt'], self.aufgaben[z['kundenaufgabe']]['norm'], z['abschnitt'])

    def test_keine_kundenaufgabe_hat_ein_urteil_nr5_rf04(self):
        for k in self.m['kundenaufgaben']:
            self.assertLessEqual(set(k), {'kennzeichen', 'text', 'norm', 'herkunft', 'wo_gesagt'}, k['kennzeichen'])
        self.assertEqual(nachweismatrix._kundenaufgaben(self.m), [])

    def test_die_herkunft_ist_der_zuschnitt_oder_die_ergaenzung(self):
        # §3.4: aus der Spalte „beim Kunden“ des AP-19-Zuschnitts; ergänzt für Leistungs-, Mess- und Betriebsteil und die Klimafrage.
        for kz, k in self.aufgaben.items():
            self.assertRegex(k['herkunft'], r'zuschnitt\.json|ergänzt', kz)
        self.assertEqual(sorted(kz for kz, k in self.aufgaben.items() if 'ergänzt' in k['herkunft']),
                         ['KA-04', 'KA-05', 'KA-06', 'KA-07'])

    def test_wo_gesagt_nennt_nur_zusagen_die_es_gibt(self):
        zusagen = {z['kennzeichen'] for z in self.m['zusagen']}
        for kz, k in self.aufgaben.items():
            for genannt in re.findall(r'Z-\d{3}', k['wo_gesagt']):
                self.assertIn(genannt, zusagen, kz)

    def test_die_klimafrage_bleibt_beim_kunden_ka05(self):
        self.assertIn('Klimawandel', self.aufgaben['KA-05']['text'])
        self.assertIn('VoltPilot führt dazu keine Angaben.', self.aufgaben['KA-05']['text'])


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

    def test_ohne_kundenaufgaben_ist_jede_norm_zeile_rot_nw1(self):
        # Seit AP-20 IP-8 tragen alle drei Teile Zeilen: ein leerer Teil setzt die Prüfung nicht mehr aus.
        self.m['kundenaufgaben'] = []
        fehler = self.assertRot(self.m, 'norm_teil[7.2].kundenaufgabe: KA-02 gibt es bei den Kundenaufgaben nicht')
        self.assertEqual(len(fehler), len(self.m['norm_teil']))

    def test_ein_verweis_in_einen_leeren_norm_teil_ist_rot(self):
        self.m['norm_teil'] = []
        self.assertRot(self.m, 'zusagen[Z-013].norm: Abschnitt 7.5.3 hat keine Zeile im Norm-Teil',
                       'kundenaufgaben[KA-02].norm: Abschnitt 7.2 hat keine Zeile im Norm-Teil')

    def test_eine_kundenaufgabe_ohne_norm_zeile_ist_rot(self):
        self.m['kundenaufgaben'][0]['norm'] = ['4.1']
        self.assertRot(self.m, 'kundenaufgaben[KA-02].norm: Abschnitt 4.1 hat keine Zeile im Norm-Teil',
                       'norm_teil[7.2].kundenaufgabe: KA-02 nennt Abschnitt 7.2 nicht')

    def test_eine_kundenaufgabe_ohne_abschnitt_oder_herkunft_ist_rot(self):
        self.m['kundenaufgaben'][0]['norm'] = []
        del self.m['kundenaufgaben'][1]['herkunft']
        self.assertRot(self.m, 'kundenaufgaben/0/norm', "kundenaufgaben/1: 'herkunft' is a required property")

    def test_eine_kundenaufgabe_die_im_satz_urteilt_ist_rot_rf04(self):
        for satz in ('Das ist erfüllt.', 'Die Aufgabe bleibt offen.', 'Belegt durch den Kunden.', 'Sonst entsteht eine Lücke.',
                     'Von VoltPilot nicht zugesagt.', 'nicht_maschinell_pruefbar', 'Damit sind Sie konform.',
                     'Die Liste ist vollständig.', 'Zertifiziert ist das nicht.'):
            with self.subTest(satz=satz):
                m = copy.deepcopy(self.m)
                m['kundenaufgaben'][0]['text'] += ' ' + satz
                self.assertRot(m, 'kundenaufgaben[KA-02].text:', 'urteilt - eine Kundenaufgabe hat kein Urteil (NR5, RF-04)')

    def test_das_verb_der_aufgabe_ist_kein_urteil(self):
        # KA-06 der Fixture sagt „erfüllen“; „belegen“ und „offenlegen“ sagen, was der Kunde tut, nicht ob er es getan hat.
        self.m['kundenaufgaben'][0]['text'] += ' Die Wirkung belegen und die Gründe offenlegen.'
        self.assertEqual(nachweismatrix.verstoesse(self.m), [])

    def test_eine_kundenaufgabe_ausserhalb_der_kundensprache_ist_rot(self):
        for zusatz, erwartet in (('(Abschnitt 7.2)', 'Abschnittsnummer „7.2“'), ('Siehe Z-005.', 'Kennzeichen „Z-005“'),
                                 ('Nach ISO 50001.', 'Norm „ISO“'), ('Träger beim_kunden.', 'Vokabular-Schlüssel')):
            with self.subTest(zusatz=zusatz):
                m = copy.deepcopy(self.m)
                m['kundenaufgaben'][0]['text'] += ' ' + zusatz
                self.assertRot(m, f'kundenaufgaben[KA-02].text: {erwartet}')

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
        self.assertIn(', 9 Kundenaufgaben)', aus)
        self.assertIn('Norm-Teil je Träger (RF-12): haelt_fest 15 · verweis 7 · misst 4 · beim_kunden 4; '
                      'jede Zeile der Gliederung existiert', aus)

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
