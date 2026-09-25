#!/usr/bin/env python3
"""Der Matrix-Prüfer an Fixtures (AP-20 NW-2): grün → belegt; übersprungen, rot, älterer Stand, ohne
stand.txt, Bestätigung ohne Person, offene Lücke → offen.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Die Fixture unter `fixtures/pruefer/` hält beide Wachen (Vertrag und Lückenliste). Jeder Test baut sich
in einem Wegwerf-Ordner ein git-Repo mit zwei Ständen, einen Lauf-Ordner mit stand.txt, einen
Artefakt-Ordner und ein Stand-Blatt. Braucht `jsonschema`; fehlt es, bricht der Lauf ab (NR2).
"""

import contextlib
import copy
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import luecken  # noqa: E402
import nachweismatrix  # noqa: E402
import pruefe_matrix  # noqa: E402

HIER = pathlib.Path(__file__).resolve().parent
FIXTURE = HIER / 'fixtures' / 'pruefer'
RF07 = HIER / 'fixtures' / 'uebungen' / 'rf07'
KLASSE_BERICHT = 'TEST-com.voltpilot.api.UemsKlasseApiTest.xml'
ABNAHME_BERICHT = 'TEST-com.voltpilot.api.uems.UemsFixtureAbnahmeTest.xml'
HEUTE = '2026-09-28'
GEFAHREN = 'Crew (Lauf AP-20 IP-10)'
RUECKWEG = 'tools/generalprobe/rueckweg.sh'
RUECKWEG_GUT = {'exit_code': 0, 'wiederherstellung_ms': 412_000, 'flyway_stimmt': 1, 'Q01_stimmt': 1}
BLATT = """\
Z-004:
  bestaetigt: ja
  am: 2026-09-27
  durch: Betreiber (A. Muster)
  beleg: archive_command schreibt in den Speicher, letztes Segment 2 min alt

Z-007:
  bestaetigt: ja
  am: 2026-09-26
  durch: {durch}
  beleg: Anruf und Rückruf an einem Probe-Kundenbereich geprobt
"""
# G6/MX4: diese Wörter sagt VoltPilot nie über sich selbst.
VERBOTEN = re.compile(r'\b(erfüllt|konform|zertifiziert|vollständig|auditfest)', re.IGNORECASE)


def lade(pfad):
    return json.loads(pathlib.Path(pfad).read_text(encoding='utf-8'))


def git(repo, *argv):
    umgebung = dict(os.environ, GIT_AUTHOR_NAME='T', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='T',
                    GIT_COMMITTER_EMAIL='t@t')
    return subprocess.run(['git', '-C', str(repo), *argv], capture_output=True, text=True,
                          check=True, env=umgebung).stdout.strip()


def zeile(bericht, kennung):
    teil = 'zusagen' if kennung.startswith('Z-') else 'norm_teil'
    schluessel = 'kennzeichen' if teil == 'zusagen' else 'abschnitt'
    return next(z for z in bericht[teil] if z[schluessel] == kennung)


def gruende(z):
    return [b['grund'] for b in z['pruefung']['befunde'] if b['ergebnis'] == 'offen']


class Buehne:
    """Wegwerf-Repo mit den Ständen alt → neu, Lauf-Ordner, Artefakte, Stand-Blatt."""

    def __init__(self, wurzel: pathlib.Path):
        self.wurzel = wurzel
        self.repo = wurzel / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'main')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'alter Stand')
        self.alt = git(self.repo, 'rev-parse', 'HEAD')
        git(self.repo, 'commit', '-q', '--allow-empty', '-m', 'gebauter Stand')
        self.neu = git(self.repo, 'rev-parse', 'HEAD')
        self.laeufe = wurzel / 'laeufe'
        shutil.copytree(FIXTURE / 'berichte', self.laeufe)
        self.stand_txt(self.laeufe, self.neu)
        self.artefakte = wurzel / 'artefakte'
        self.artefakte.mkdir()
        (self.artefakte / 'rueckweg.json').write_text(json.dumps(RUECKWEG_GUT), encoding='utf-8')
        self.stand_txt(self.artefakte, self.neu, gefahren_von='Betreiber (A. Muster)')
        self.blatt = wurzel / 'stand-blatt.yaml'
        self.blatt_mit(durch='Betreiber (A. Muster)')
        self.matrix, self.liste = lade(FIXTURE / 'matrix.json'), lade(FIXTURE / 'luecken.json')

    @staticmethod
    def stand_txt(ordner, sha, datum=HEUTE, gefahren_von=GEFAHREN):
        zeilen = [sha] + ([f'datum: {datum}'] if datum else []) + ([f'gefahren_von: {gefahren_von}'] if gefahren_von else [])
        (ordner / 'stand.txt').write_text('\n'.join(zeilen) + '\n', encoding='utf-8')

    def blatt_mit(self, durch):
        text = BLATT.format(durch=durch)
        if not durch:
            text = text.replace('  durch: \n', '')
        self.blatt.write_text(text, encoding='utf-8')

    def bericht(self, laeufe=None, artefakte=None, blatt=True, heute=HEUTE, stand=None):
        ctx = pruefe_matrix.Kontext(stand or self.neu, pruefe_matrix.datetime.date.fromisoformat(heute), self.repo,
                                    [self.laeufe] if laeufe is None else laeufe,
                                    [self.artefakte] if artefakte is None else artefakte,
                                    self.blatt if blatt else None, self.liste)
        eingaben = {'matrix': {'pfad': 'matrix.json', 'sha256': '0' * 64},
                    'luecken': {'pfad': 'luecken.json', 'sha256': '0' * 64}}
        return pruefe_matrix.bewerte(self.matrix, self.liste, ctx, eingaben, 'BWB-2026-01', 'gebaut')

    def bericht_aendern(self, datei, alt, neu):
        pfad = self.laeufe / datei
        text = pfad.read_text(encoding='utf-8')
        assert alt in text, alt
        pfad.write_text(text.replace(alt, neu), encoding='utf-8')

    def main(self, *argv, aus=None):
        for name in ('matrix.json', 'luecken.json'):
            ziel = self.wurzel / name
            if not ziel.exists():
                ziel.write_text(json.dumps(self.matrix if name == 'matrix.json' else self.liste, ensure_ascii=False),
                                encoding='utf-8')
        aus = aus or self.wurzel / 'aus'
        raus, fehler = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(raus), contextlib.redirect_stderr(fehler):
            code = pruefe_matrix.main(['--matrix', str(self.wurzel / 'matrix.json'),
                                       '--luecken', str(self.wurzel / 'luecken.json'),
                                       '--wurzel', str(self.repo), '--stand', self.neu, '--heute', HEUTE,
                                       '--aus', str(aus), *argv])
        return code, raus.getvalue(), fehler.getvalue()


class MitBuehne(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.b = Buehne(pathlib.Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()


class GruenIstBelegt(MitBuehne):
    """RF-01: belegt an Test, Stand und Datum gebunden."""

    def test_zwei_gruene_methoden_dieses_standes_belegen_die_zusage_mit_stand_datum_und_wer(self):
        z = zeile(self.b.bericht(), 'Z-001')
        self.assertEqual(z['urteil'], 'belegt')
        bericht = self.b.laeufe / ABNAHME_BERICHT
        self.assertEqual([n['fundstelle'] for n in z['nachweise']],
                         ['UemsFixtureAbnahmeTest#erstensGruen', 'UemsFixtureAbnahmeTest#zweitensGruen'])
        for n in z['nachweise']:
            self.assertEqual((n['art'], n['stand'], n['datum'], n['gefahren_von']),
                             ('test_lauf', self.b.neu, HEUTE, GEFAHREN))
            self.assertEqual(n['lauf_sha256'], hashlib.sha256(bericht.read_bytes()).hexdigest())
        self.assertNotIn('wer_liefert', z)

    def test_eine_ganze_gruene_klasse_und_eine_gruene_vitest_datei_belegen(self):
        b = self.b.bericht()
        self.assertEqual(zeile(b, 'Z-002')['urteil'], 'belegt')
        z3 = zeile(b, 'Z-003')
        self.assertEqual(z3['urteil'], 'belegt')
        self.assertTrue(z3['nachweise'][0]['lauf'].endswith('portal-junit.xml'))

    def test_ohne_datum_in_der_stand_txt_gilt_der_tag_der_berichtsdatei(self):
        self.b.stand_txt(self.b.laeufe, self.b.neu, datum=None)
        os.utime(self.b.laeufe / KLASSE_BERICHT, (1790467200, 1790467200))  # 2026-09-27 00:00 UTC
        self.assertEqual(zeile(self.b.bericht(), 'Z-002')['nachweise'][0]['datum'], '2026-09-27')

    def test_ein_aelterer_roter_lauf_neben_einem_gruenen_dieses_standes_stoert_nicht(self):
        alt = self.b.wurzel / 'alt'
        shutil.copytree(FIXTURE / 'berichte', alt)
        (alt / KLASSE_BERICHT).write_text((alt / KLASSE_BERICHT).read_text(encoding='utf-8')
                                          .replace('failures="0"', 'failures="2"'), encoding='utf-8')
        self.b.stand_txt(alt, self.b.alt)
        self.assertEqual(zeile(self.b.bericht(laeufe=[alt, self.b.laeufe]), 'Z-002')['urteil'], 'belegt')


class FallInJederTestwelt(MitBuehne):
    """`pfad#Fall` der Klammer (AP-20 IP-6): Vitest, node --test, pytest und Go über gotestsum."""

    def test_ein_gruener_fall_belegt_in_jeder_testwelt(self):
        b = self.b.bericht()
        for kz, bericht in (('Z-014', 'portal-junit.xml'), ('Z-015', 'node-junit.xml'),
                            ('Z-016', 'pytest-junit.xml'), ('Z-017', 'go-junit.xml')):
            with self.subTest(kz=kz):
                z = zeile(b, kz)
                self.assertEqual(z['urteil'], 'belegt', z['pruefung'])
                self.assertTrue(z['nachweise'][0]['lauf'].endswith(bericht))
                self.assertEqual(z['nachweise'][0]['fundstelle'], z['nachweis_kandidaten'][0])

    def test_ein_fall_der_nicht_im_bericht_steht_ist_kein_beleg(self):
        self.b.bericht_aendern('portal-junit.xml', 'S1 &gt; der Grenz-Satz steht an jeder Fläche', 'S1 &gt; umbenannt')
        z = zeile(self.b.bericht(), 'Z-014')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['fall_fehlt']))

    def test_ein_uebersprungener_fall_aus_node_test_ist_nicht_gruen(self):
        self.b.bericht_aendern('node-junit.xml', 'fixture.test.js"/>\n\t<testsuite',
                               'fixture.test.js"><skipped type="skipped" message="true"/></testcase>\n\t<testsuite')
        self.assertEqual(gruende(zeile(self.b.bericht(), 'Z-015')), ['uebersprungen'])

    def test_ein_go_unterfall_ist_nicht_der_test_selbst(self):
        self.b.bericht_aendern('go-junit.xml', 'name="TestFixtureGruen" ', 'name="TestAnders" ')
        self.assertEqual(gruende(zeile(self.b.bericht(), 'Z-017')), ['fall_fehlt'])


class UngeprueftBleibtOffen(MitBuehne):
    """NR2, NR3, RF-01 Gegenproben, RF-11: nichts Ungeprüftes wird positiv."""

    def assertOffen(self, bericht, kennung, grund):
        z = zeile(bericht, kennung)
        self.assertEqual(z['urteil'], 'offen', z['pruefung'])
        self.assertIn(grund, gruende(z))
        self.assertTrue(z['wer_liefert'])
        self.assertEqual(z['nachweise'], [n for n in z['nachweise'] if n['stand'] == self.b.neu])
        return z

    def test_uebersprungen_ist_nicht_gruen(self):
        self.b.bericht_aendern(KLASSE_BERICHT, 'skipped="0"', 'skipped="3"')
        z = self.assertOffen(self.b.bericht(), 'Z-002', 'uebersprungen')
        self.assertIn('Crew', [w['wer'] for w in z['wer_liefert']])

    def test_auch_ein_einzelner_uebersprungener_fall_haelt_die_klasse_offen(self):
        self.b.bericht_aendern(KLASSE_BERICHT, 'skipped="0"', 'skipped="1"')
        self.assertOffen(self.b.bericht(), 'Z-002', 'uebersprungen')

    def test_eine_uebersprungene_methode_haelt_ihre_zusage_offen(self):
        self.b.bericht_aendern(ABNAHME_BERICHT, 'name="erstensGruen" classname="com.voltpilot.api.uems.UemsFixtureAbnahmeTest" time="4.1"/>',
                               'name="erstensGruen" classname="com.voltpilot.api.uems.UemsFixtureAbnahmeTest" time="0"><skipped/></testcase>')
        self.assertOffen(self.b.bericht(), 'Z-001', 'uebersprungen')

    def test_rot_ist_nicht_gruen(self):
        self.b.bericht_aendern(KLASSE_BERICHT, 'failures="0"', 'failures="1"')
        self.assertOffen(self.b.bericht(), 'Z-002', 'rot')

    def test_eine_rote_methode_haelt_offen_auch_wenn_die_andere_gruen_ist(self):
        self.b.bericht_aendern(ABNAHME_BERICHT, 'name="zweitensGruen(String)[2]" classname="com.voltpilot.api.uems.UemsFixtureAbnahmeTest" time="4.2"/>',
                               'name="zweitensGruen(String)[2]" classname="com.voltpilot.api.uems.UemsFixtureAbnahmeTest" time="4.2"><failure message="x"/></testcase>')
        z = self.assertOffen(self.b.bericht(), 'Z-001', 'rot')
        self.assertEqual([b['ergebnis'] for b in z['pruefung']['befunde']], ['belegt', 'offen'])

    def test_eine_methode_die_nicht_im_bericht_steht_ist_kein_beleg(self):
        self.b.bericht_aendern(ABNAHME_BERICHT, 'name="erstensGruen"', 'name="umbenannt"')
        self.assertOffen(self.b.bericht(), 'Z-001', 'fall_fehlt')

    def test_ein_aelterer_stand_traegt_den_gebauten_nicht(self):
        self.b.stand_txt(self.b.laeufe, self.b.alt)
        z = self.assertOffen(self.b.bericht(), 'Z-001', 'aelterer_stand')
        self.assertEqual(z['nachweise'], [])
        self.assertIn('älterer Stand', z['wer_liefert'][0]['was'])

    def test_ein_fremder_stand_traegt_ihn_auch_nicht(self):
        self.b.stand_txt(self.b.laeufe, '0123456789abcdef0123456789abcdef01234567')
        self.assertOffen(self.b.bericht(), 'Z-002', 'anderer_stand')

    def test_ohne_stand_txt_traegt_ein_gruener_bericht_keinen_stand(self):
        (self.b.laeufe / 'stand.txt').unlink()
        b = self.b.bericht()
        for kz in ('Z-001', 'Z-002', 'Z-003'):
            self.assertOffen(b, kz, 'ohne_stand_txt')

    def test_ohne_gefahren_von_ist_der_lauf_kein_beleg(self):
        self.b.stand_txt(self.b.laeufe, self.b.neu, gefahren_von=None)
        self.assertOffen(self.b.bericht(), 'Z-002', 'ohne_gefahren_von')

    def test_ein_lauf_datiert_nach_dem_prueftag_ist_kein_beleg(self):
        self.b.stand_txt(self.b.laeufe, self.b.neu, datum='2026-10-01')
        self.assertOffen(self.b.bericht(), 'Z-002', 'datum_in_zukunft')

    def test_ohne_lauf_ordner_bleibt_jeder_test_kandidat_offen(self):
        b = self.b.bericht(laeufe=[])
        for kz in ('Z-001', 'Z-002', 'Z-003', 'Z-005', 'Z-011'):
            self.assertOffen(b, kz, 'kein_bericht')


class BestaetigungZaehltNurMitPerson(MitBuehne):
    """NR4, RF-03: nicht maschinell prüfbar nur mit Person, Datum und Aussage."""

    def test_stand_blatt_mit_person_datum_und_aussage_ist_nicht_maschinell_pruefbar(self):
        z = zeile(self.b.bericht(), 'Z-007')
        self.assertEqual(z['urteil'], 'nicht_maschinell_pruefbar')
        self.assertEqual(z['bestaetigung'], {'von': 'Betreiber (A. Muster)', 'datum': '2026-09-26',
                                             'aussage': 'Anruf und Rückruf an einem Probe-Kundenbereich geprobt'})
        self.assertEqual(z['nachweise'][0]['art'], 'betreiber_bestaetigung')

    def test_bestaetigung_ohne_person_ist_offen(self):
        for durch in ('', 'Betreiber', 'captain'):
            with self.subTest(durch=durch):
                self.b.blatt_mit(durch=durch)
                z = zeile(self.b.bericht(), 'Z-007')
                self.assertEqual(z['urteil'], 'offen')
                self.assertEqual(gruende(z), ['ohne_person'])

    def test_bestaetigung_ohne_datum_nach_dem_prueftag_oder_mit_nein_ist_offen(self):
        for alt, neu, grund in (('  am: 2026-09-26\n', '', 'ohne_datum'),
                                ('am: 2026-09-26', 'am: 2026-10-26', 'datum_in_zukunft'),
                                ('  bestaetigt: ja\n  am: 2026-09-26', '  bestaetigt: nein\n  am: 2026-09-26',
                                 'nicht_bestaetigt')):
            with self.subTest(grund=grund):
                kopf, _, supportweg = BLATT.format(durch='Betreiber (A. Muster)').partition('Z-007:')
                self.b.blatt.write_text(kopf + 'Z-007:' + supportweg.replace(alt, neu, 1), encoding='utf-8')
                self.assertEqual(gruende(zeile(self.b.bericht(), 'Z-007')), [grund])

    def test_ohne_stand_blatt_bleibt_die_zusage_offen_und_der_betreiber_liefert(self):
        z = zeile(self.b.bericht(blatt=False), 'Z-007')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['blatt_fehlt']))
        self.assertIn('Betreiber', [w['wer'] for w in z['wer_liefert']])

    def test_die_bestaetigung_der_matrix_zaehlt_nur_mit_person(self):
        self.assertEqual(zeile(self.b.bericht(), 'Z-006')['urteil'], 'nicht_maschinell_pruefbar')
        next(z for z in self.b.matrix['zusagen'] if z['kennzeichen'] == 'Z-006')['bestaetigung']['von'] = 'Betreiber'
        z = zeile(self.b.bericht(), 'Z-006')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['ohne_person']))

    def test_ein_rest_der_crew_oder_des_captains_haelt_offen_auch_neben_gruenem_test(self):
        b = self.b.bericht()
        z = zeile(b, 'Z-012')
        self.assertEqual([x['ergebnis'] for x in z['pruefung']['befunde']], ['belegt', 'offen'])
        self.assertEqual(gruende(z), ['rest_offen'])
        self.assertIn('Crew', [w['wer'] for w in z['wer_liefert']])
        self.assertTrue(any(w['was'].startswith('Zusicherung ergänzen') for w in z['wer_liefert']))
        self.assertEqual(gruende(zeile(b, 'Z-013')), ['rest_offen'])
        self.assertEqual(zeile(b, 'Z-013')['wer_liefert'][0]['wer'], 'Captain')

    def test_das_stand_blatt_macht_keinen_test_kandidaten_gruen(self):
        self.b.blatt.write_text(self.b.blatt.read_text(encoding='utf-8')
                                + '\nZ-002:\n  bestaetigt: ja\n  am: 2026-09-26\n'
                                  '  durch: Betreiber (A. Muster)\n  beleg: alles gut\n', encoding='utf-8')
        z = zeile(self.b.bericht(laeufe=[]), 'Z-002')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['kein_bericht']))

    def test_norm_zeile_mit_lesart_traegt_und_benannter_fachperson(self):
        b = self.b.bericht()
        z = zeile(b, '9.2.2')
        self.assertEqual(z['urteil'], 'nicht_maschinell_pruefbar')
        self.assertEqual(z['fachperson']['name'], 'Fachperson F. (Auditorin, extern; Fixture)')
        self.assertEqual(z['kundenaufgabe'], 'KA-08')
        self.assertEqual(gruende(zeile(b, '9.2.1')), ['ohne_person'])
        self.assertEqual(gruende(zeile(b, '7.2')), ['anmerkung'])
        z63 = zeile(b, '6.3')
        self.assertEqual((z63['urteil'], gruende(z63)), ('offen', ['ohne_lesart']))
        self.assertIn('Fachperson', [w['wer'] for w in z63['wer_liefert']])


class LueckeHaeltOffen(MitBuehne):
    """NR6, LU4: eine offene Lücke hält offen; ein Restpunkt begrenzt nur."""

    def test_eine_offene_luecke_haelt_die_zusage_offen_obwohl_der_test_gruen_ist(self):
        z = zeile(self.b.bericht(), 'Z-005')
        self.assertEqual(z['urteil'], 'offen')
        self.assertEqual(gruende(z), ['luecke_offen'])
        self.assertEqual([b['ergebnis'] for b in z['pruefung']['befunde']], ['belegt', 'offen'])
        self.assertEqual(z['pruefung']['luecken_offen'], ['L-002'])
        self.assertIn({'wer': 'Crew', 'was': 'L-002: L-002 beheben (Fixture)'}, z['wer_liefert'])

    def test_eine_offene_luecke_haelt_auch_eine_getragene_norm_zeile_offen(self):
        self.assertEqual(gruende(zeile(self.b.bericht(), '7.5.3')), ['luecke_offen'])

    def test_ein_restpunkt_haelt_nicht_offen_steht_aber_mit_grenze_und_frist_dabei(self):
        z = zeile(self.b.bericht(), 'Z-011')
        self.assertEqual(z['urteil'], 'belegt')
        self.assertEqual(z['pruefung']['restpunkte'], [{'kennzeichen': 'L-003', 'bis': '2026-12-31', 'frist_ueberschritten': False,
                                                        'grenze': 'gilt nicht für getrennte Stromsysteme (Fixture)'}])
        spaeter = zeile(self.b.bericht(heute='2027-01-05', laeufe=[]), 'Z-011')
        self.assertTrue(spaeter['pruefung']['restpunkte'][0]['frist_ueberschritten'])


class KandidatIstKeinBeleg(MitBuehne):
    """NR1, NR7, RF-05: was der Prüfer nicht lesen kann, bleibt offen und nennt, wer liefert."""

    def test_ein_kandidat_ohne_lesbaren_lauf_bleibt_offen(self):
        z = zeile(self.b.bericht(), 'Z-008')
        self.assertEqual(gruende(z), ['kandidat_ohne_lauf'])
        self.assertEqual(z['wer_liefert'][0]['wer'], 'Crew')

    def test_eine_zusage_ohne_kandidat_bleibt_offen(self):
        self.assertEqual(gruende(zeile(self.b.bericht(), 'Z-009')), ['ohne_kandidat'])

    def test_nicht_zugesagt_bleibt_grenze(self):
        z = zeile(self.b.bericht(), 'Z-010')
        self.assertEqual((z['urteil'], z['grund']), ('nicht_zugesagt', 'zurückgenommen, erscheint als Grenze (Fixture)'))

    def test_das_artefakt_zaehlt_nur_mit_bestandenem_inhalt_und_stand(self):
        befunde = lambda: {b['kandidat'].split()[0]: (b['ergebnis'], b['grund'])  # noqa: E731
                           for b in zeile(self.b.bericht(), 'Z-004')['pruefung']['befunde']}
        self.assertEqual(befunde()[RUECKWEG], ('belegt', 'gruen'))
        self.assertEqual(befunde()['Stand-Blatt'], ('bestaetigt', 'bestaetigt'))
        self.assertEqual(befunde()['L-001'], ('offen', 'luecke_offen'))
        (self.b.artefakte / 'rueckweg.json').write_text(json.dumps({**RUECKWEG_GUT, 'exit_code': 1}), encoding='utf-8')
        self.assertEqual(befunde()[RUECKWEG], ('offen', 'artefakt_offen'))
        (self.b.artefakte / 'rueckweg.json').write_text(json.dumps(RUECKWEG_GUT), encoding='utf-8')
        (self.b.artefakte / 'stand.txt').unlink()
        self.assertEqual(befunde()[RUECKWEG], ('offen', 'ohne_stand_txt'))
        z = zeile(self.b.bericht(artefakte=[]), 'Z-004')
        self.assertIn('artefakt_fehlt', gruende(z))

    def test_ein_teil_nur_mit_bestaetigung_macht_die_zeile_nicht_belegt(self):
        # L-001 behoben: jetzt tragen Artefakt und Stand-Blatt; das schwächste Glied entscheidet.
        l = self.b.liste['luecken'][0]
        l['verlauf'] += [{'am': '2026-09-21', 'nach': 'in_arbeit', 'person': 'Crew (Fixture)', 'begruendung': 'x'},
                         {'am': '2026-09-22', 'nach': 'behoben', 'person': 'Crew (Fixture)', 'begruendung': 'x',
                          'nachweis': {'art': 'stand_mit_pruefsumme', 'fundstelle': 'Fixture', 'stand': self.b.neu,
                                       'datum': '2026-09-22', 'gefahren_von': 'Crew (Fixture)'}}]
        l['zustand'] = 'behoben'
        next(z for z in self.b.matrix['zusagen'] if z['kennzeichen'] == 'Z-004')['luecken'] = []
        z = zeile(self.b.bericht(), 'Z-004')
        self.assertEqual(z['urteil'], 'nicht_maschinell_pruefbar')
        self.assertEqual([n['art'] for n in z['nachweise']], ['werkzeug_artefakt', 'betreiber_bestaetigung'])
        self.assertEqual(z['bestaetigung']['von'], 'Betreiber (A. Muster)')


class Z015NurMitUebung(MitBuehne):
    """BT1, BT2, NR3, NR4: Z-015 ist nur belegt mit Q15 (Person, Datum, Aussage) UND einer Rückweg-Übung,
    die ihren Stand trägt und nicht fällig ist. Ein loses rueckweg.json in --artefakte zählt dort nicht."""

    TAG = '2026-10-06'
    Q15 = ('q15_wal_archiv:\n  bestaetigt: ja\n  am: 2026-10-05\n  durch: {durch}\n'
           '  beleg: vp-db-backup-check.sh Exit 0, WAL-Archiv aktuell (2 min)\n')

    def setUp(self):
        super().setUp()
        self.uebungen = self.b.wurzel / 'uebungen'
        shutil.copytree(RF07, self.uebungen)
        (self.uebungen / 'stand-q15.yaml').unlink()
        self.q15(durch='Betreiber (A. Muster)')
        z = next(z for z in self.b.matrix['zusagen'] if z['kennzeichen'] == 'Z-015')
        z.update(art='betrieb', nachweis_kandidaten=[f'{RUECKWEG} → rueckweg.json (AP-14 NW-8)'], luecken=[],
                 wer_liefert=[{'wer': 'Betreiber', 'was': 'Q15 „WAL-Archiv läuft“ bestätigen und die Rückweg-Übung '
                                                          'fahren (AP-20 IP-19)'}])

    def q15(self, durch):
        text = self.b.blatt.read_text(encoding='utf-8')
        text = text.split('q15_wal_archiv:')[0].rstrip('\n') + '\n\n' + self.Q15.format(durch=durch)
        self.b.blatt.write_text(text.replace('  durch: \n', ''), encoding='utf-8')

    def uebung(self, **felder):
        pfad = self.uebungen / 'U-2026-01.json'
        u = lade(pfad)
        for k, v in felder.items():
            if v is None:
                u.pop(k, None)
            else:
                u[k] = v
        pfad.write_text(json.dumps(u, ensure_ascii=False, indent=2), encoding='utf-8')

    def z015(self, heute=TAG, artefakte=None):
        ctx = pruefe_matrix.Kontext(self.b.neu, pruefe_matrix.datetime.date.fromisoformat(heute), self.b.repo,
                                    [self.b.laeufe], [self.b.artefakte] if artefakte is None else artefakte,
                                    self.b.blatt, self.b.liste, self.uebungen)
        eingaben = {'matrix': {'pfad': 'matrix.json', 'sha256': '0' * 64},
                    'luecken': {'pfad': 'luecken.json', 'sha256': '0' * 64}}
        return zeile(pruefe_matrix.bewerte(self.b.matrix, self.b.liste, ctx, eingaben, 'BWB-2026-01', 'gebaut'),
                     'Z-015')

    def test_uebung_mit_stand_in_der_frist_und_q15_mit_person_belegt(self):
        z = self.z015()
        self.assertEqual('belegt', z['urteil'], z['pruefung'])
        (n,) = z['nachweise']
        self.assertEqual(('werkzeug_artefakt', '8be6a15b2', '2026-10-05', 'Betreiber (A. Muster)'),
                         (n['art'], n['stand'], n['datum'], n['gefahren_von']))
        self.assertEqual(lade(RF07 / 'U-2026-01.json')['artefakt']['sha256'], n['lauf_sha256'])
        self.assertEqual(['Übung U-2026-01 → rueckweg.json'], [n['fundstelle'] for n in z['nachweise']])
        # Das lose Artefakt trägt Z-015 nicht; ohne --artefakte bleibt es belegt.
        self.assertEqual('belegt', self.z015(artefakte=[])['urteil'])

    def test_ohne_stand_bleibt_offen(self):
        self.uebung(stand=None)
        z = self.z015()
        self.assertEqual(('offen', ['uebung_ohne_stand']), (z['urteil'], gruende(z)))
        self.assertIn('trägt keinen Stand des Produktions-Images', z['wer_liefert'][0]['was'])

    def test_ueberfaellig_ist_offen_mit_uebung_faellig(self):
        self.assertEqual('belegt', self.z015(heute='2027-04-05')['urteil'])
        z = self.z015(heute='2027-04-06')
        self.assertEqual(('offen', ['uebung_faellig']), (z['urteil'], gruende(z)))
        self.assertEqual('Betreiber', z['wer_liefert'][0]['wer'])
        self.assertIn('Betreiber: Übung fällig - U-2026-01 vom 2026-10-05 belegt nur bis 2027-04-05',
                      z['wer_liefert'][0]['was'])

    def test_q15_ohne_person_ist_offen(self):
        for durch in ('Betreiber', ''):
            with self.subTest(durch=durch):
                self.q15(durch=durch)
                z = self.z015()
                self.assertEqual(('offen', ['q15_offen']), (z['urteil'], gruende(z)))
                self.assertIn('ist keine benannte Person', z['wer_liefert'][0]['was'])

    def test_ohne_q15_oder_ohne_uebung_ist_offen(self):
        self.b.blatt.write_text(self.b.blatt.read_text(encoding='utf-8').split('q15_wal_archiv:')[0],
                                encoding='utf-8')
        self.assertEqual(['q15_offen'], gruende(self.z015()))
        self.q15(durch='Betreiber (A. Muster)')
        (self.uebungen / 'U-2026-01.json').unlink()
        z = self.z015()
        self.assertEqual(('offen', ['uebung_fehlt']), (z['urteil'], gruende(z)))

    def test_fehlgeschlagene_oder_rote_uebung_belegt_nicht(self):
        self.uebung(zustand='fehlgeschlagen')  # rueckweg.json sagt durchgefuehrt: rot in uebungen.py
        z = self.z015()
        self.assertEqual(['uebung_fehlt'], gruende(z))
        self.assertIn('1 Verstoß/Verstöße in den Übungen zählen nicht', z['wer_liefert'][0]['was'])

    def test_eine_uebung_nach_dem_prueftag_zaehlt_nicht(self):
        self.assertEqual(['uebung_fehlt'], gruende(self.z015(heute='2026-10-04')))

    def test_andere_zusagen_lesen_rueckweg_json_weiter_aus_artefakte(self):
        befunde = {b['kandidat'].split()[0]: b['grund'] for b in zeile(self.b.bericht(), 'Z-004')['pruefung']['befunde']}
        self.assertEqual('gruen', befunde[RUECKWEG])
        self.assertEqual('bestaetigt', befunde['Stand-Blatt'])

    def test_am_repo_bleibt_z015_heute_offen(self):
        matrix, liste = lade(nachweismatrix.MATRIX_PFAD), lade(luecken.LISTE_PFAD)
        ctx = pruefe_matrix.Kontext(self.b.neu, pruefe_matrix.datetime.date.fromisoformat('2026-09-25'), self.b.repo,
                                    liste=liste)
        z = zeile(pruefe_matrix.bewerte(matrix, liste, ctx, {}, 'BWB-2026-01', 'gebaut'), 'Z-015')
        self.assertEqual('offen', z['urteil'])
        self.assertIn('uebung_fehlt', gruende(z))
        self.assertNotIn('blatt_fehlt', gruende(z), 'den Rest des Betreibers trägt der Übungs-Befund')


class DerEntwurf(MitBuehne):
    """BWB-Entwurf als .json und .md mit SHA-256 (G3, G5, MX4, NR5, NR9)."""

    def test_das_urteil_haelt_den_vertrag_der_matrix_und_die_luecken_wache(self):
        b = self.b.bericht()
        beurteilt = copy.deepcopy(self.b.matrix)
        beurteilt['zusagen'] = [{k: v for k, v in z.items() if k != 'pruefung'} for z in b['zusagen']]
        beurteilt['norm_teil'] = [{k: v for k, v in z.items() if k != 'pruefung'} for z in b['norm_teil']]
        self.assertEqual(nachweismatrix.verstoesse(beurteilt), [])
        self.assertEqual(luecken.verstoesse(self.b.liste, beurteilt), [])
        self.assertEqual(nachweismatrix._nr9(b), [])

    def test_zaehlung_nur_je_urteil_und_traeger_kundenaufgaben_ohne_urteil(self):
        b = self.b.bericht()
        self.assertEqual(b['zaehlung']['zusagen'],
                         {'belegt': 8, 'nicht_maschinell_pruefbar': 2, 'offen': 6, 'nicht_zugesagt': 1})
        self.assertEqual(b['zaehlung']['norm_teil']['je_urteil'], {'nicht_maschinell_pruefbar': 1, 'offen': 4})
        self.assertEqual(set(b['zaehlung']), {'zusagen', 'norm_teil'})
        self.assertEqual(b['kundenaufgaben'], self.b.matrix['kundenaufgaben'])
        self.assertFalse(any('urteil' in k for k in b['kundenaufgaben']))
        self.assertEqual((b['zustand'], b['stand']), ('entwurf', self.b.neu))

    def test_json_md_und_sha256_werden_geschrieben_und_nie_ueberschrieben(self):
        code, raus, fehler = self.b.main('--laeufe', str(self.b.laeufe), '--artefakte', str(self.b.artefakte),
                                         '--blatt', str(self.b.blatt))
        self.assertEqual(code, 0, fehler)
        aus = self.b.wurzel / 'aus'
        roh, md = (aus / 'BWB-2026-01.json').read_bytes(), (aus / 'BWB-2026-01.md').read_text(encoding='utf-8')
        json_sha, md_sha = hashlib.sha256(roh).hexdigest(), hashlib.sha256(md.encode('utf-8')).hexdigest()
        self.assertEqual((aus / 'BWB-2026-01.sha256').read_text(encoding='utf-8'),
                         f'{json_sha}  BWB-2026-01.json\n{md_sha}  BWB-2026-01.md\n')
        self.assertIn(f'SHA-256 `{json_sha}`', md)
        self.assertIn(pruefe_matrix.GRENZ_SATZ, md)
        self.assertIn('Von 17 Zusagen: 8 belegt · 2 nicht maschinell prüfbar · 6 offen · 1 nicht zugesagt.', md)
        self.assertIn('| Z-001 |', md)
        self.assertIn('UemsFixtureAbnahmeTest#erstensGruen · Stand ' + self.b.neu[:9] + ' · 28.09.2026 · ' + GEFAHREN, md)
        self.assertIn('L-003 · Grenze: gilt nicht für getrennte Stromsysteme (Fixture) · bis 31.12.2026', md)
        self.assertIn('## 2 Kundenaufgaben', md)
        self.assertNotIn('%', md)
        self.assertIsNone(VERBOTEN.search(md), 'MX4/G6: kein erfüllt, konform, zertifiziert, vollständig, auditfest')
        self.assertIn(json_sha, raus)

        vorher = roh
        code, _, fehler = self.b.main('--laeufe', str(self.b.laeufe), '--kennung', 'BWB-2026-01')
        self.assertEqual(code, 2)
        self.assertIn('nie überschrieben (G3)', fehler)
        self.assertEqual((aus / 'BWB-2026-01.json').read_bytes(), vorher)
        self.assertEqual(self.b.main('--laeufe', str(self.b.laeufe))[0], 0)
        self.assertTrue((aus / 'BWB-2026-02.json').exists())

    def test_gleiche_eingaben_gleiche_bytes(self):
        argv = ('--laeufe', str(self.b.laeufe), '--artefakte', str(self.b.artefakte), '--blatt', str(self.b.blatt))
        self.assertEqual(self.b.main(*argv, aus=self.b.wurzel / 'eins')[0], 0)
        self.assertEqual(self.b.main(*argv, aus=self.b.wurzel / 'zwei')[0], 0)
        for endung in ('json', 'md', 'sha256'):
            self.assertEqual((self.b.wurzel / 'eins' / f'BWB-2026-01.{endung}').read_bytes(),
                             (self.b.wurzel / 'zwei' / f'BWB-2026-01.{endung}').read_bytes())

    def test_eine_rote_matrix_wird_nicht_beurteilt(self):
        self.b.matrix['zusagen'][0]['urteil'] = 'erfüllt'
        code, _, fehler = self.b.main()
        self.assertEqual(code, 2)
        self.assertIn('Vertrag und Lückenliste', fehler)
        self.assertFalse((self.b.wurzel / 'aus').exists())

    def test_ein_unlesbares_stand_blatt_bricht_ab_statt_zu_raten(self):
        self.b.blatt.write_text('supportweg\n  bestaetigt: ja\n', encoding='utf-8')
        self.assertEqual(self.b.main('--blatt', str(self.b.blatt))[0], 2)

    def test_kein_ordner_ist_ein_aufruffehler(self):
        self.assertEqual(self.b.main('--laeufe', str(self.b.wurzel / 'gibt-es-nicht'))[0], 2)


class AnDerEchtenMatrix(unittest.TestCase):
    """NR7 am Bestand: ohne Lauf, Artefakt und Blatt ist nichts positiv - und das Urteil hält den Vertrag."""

    def test_ohne_eingaben_ist_jede_zusage_offen_oder_nicht_zugesagt(self):
        matrix, liste = lade(nachweismatrix.MATRIX_PFAD), lade(luecken.LISTE_PFAD)
        ctx = pruefe_matrix.Kontext('0' * 40, pruefe_matrix.datetime.date(2026, 9, 25), liste=liste)
        eingaben = {'matrix': {'pfad': 'm', 'sha256': '0' * 64}, 'luecken': {'pfad': 'l', 'sha256': '0' * 64}}
        b = pruefe_matrix.bewerte(matrix, liste, ctx, eingaben, 'BWB-2026-01', 'gebaut')
        self.assertEqual({z['urteil'] for z in b['zusagen']} - {'offen', 'nicht_zugesagt'}, set())
        for n in b['norm_teil']:
            self.assertTrue(n['urteil'] == 'offen' or 'fachperson' in n, n['abschnitt'])
        beurteilt = dict(matrix, zusagen=[{k: v for k, v in z.items() if k != 'pruefung'} for z in b['zusagen']],
                         norm_teil=[{k: v for k, v in z.items() if k != 'pruefung'} for z in b['norm_teil']])
        self.assertEqual(nachweismatrix.verstoesse(beurteilt), [])
        self.assertEqual(nachweismatrix._nr9(b), [])


if __name__ == '__main__':
    unittest.main()
