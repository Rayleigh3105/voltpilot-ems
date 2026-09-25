#!/usr/bin/env python3
"""Wache des Zusagen-Inventars (AP-20 IP-5, MX3, MX5) - an Matrix und Vorlage im Repo und an Gegenproben.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Die Gegenproben arbeiten an einer Kopie der zitierten Dateien in einem Wegwerf-Ordner; das Repo bleibt unberührt.
"""

import copy
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402
import zusagen  # noqa: E402

VORLAGE = zusagen.VORLAGE


def lade_matrix():
    return json.loads(zusagen.MATRIX_PFAD.read_text(encoding='utf-8'))


def zusage(m, kz):
    return next(z for z in m['zusagen'] if z['kennzeichen'] == kz)


class ImRepo(unittest.TestCase):

    def test_die_wache_haelt_an_matrix_und_vorlage_im_repo(self):
        self.assertEqual(zusagen.verstoesse(lade_matrix()), [])

    def test_der_vertrag_haelt_am_inventar(self):
        self.assertEqual(nachweismatrix.verstoesse(lade_matrix()), [])

    def test_jeder_ort_traegt_zusagen(self):
        arten = nachweismatrix.lade_schema()['$defs']['zusage_art']['enum']
        self.assertEqual({z['art'] for z in lade_matrix()['zusagen']}, set(arten))

    def test_z010_und_z011_stehen_woertlich_rf05(self):
        m = lade_matrix()
        z010, z011 = zusage(m, 'Z-010'), zusage(m, 'Z-011')
        self.assertEqual(z010['wortlaut'], 'An Ihren Zahlen, Ihrer Steuerung und Ihren Fahrplänen ändert sich dadurch nichts.')
        self.assertEqual(z010['quelle'], f'{VORLAGE}:42')
        self.assertEqual((z010['art'], z010['urteil'], z010['nachweise']), ('release_notiz', 'offen', []))
        self.assertEqual({w['wer'] for w in z010['wer_liefert']}, {'Crew', 'Betreiber'})
        self.assertEqual(z011['wortlaut'], 'Mehrere Boxen werden nicht als eine Einheit optimiert. Jede Box liest ihre Quellen.')
        self.assertTrue(z011['quelle'].startswith(f'{VORLAGE}:45'), z011['quelle'])
        self.assertEqual((z011['art'], z011['urteil']), ('release_notiz', 'offen'))

    def test_die_achtzehn_zusagen_des_entwurfs_behalten_kennzeichen_und_ort(self):
        arten = {zusage(lade_matrix(), f'Z-{n:03d}')['art'] for n in range(12, 15)}
        self.assertEqual(arten, {'anmeldung'})
        m = lade_matrix()
        self.assertEqual([zusage(m, f'Z-{n:03d}')['art'] for n in (15, 16, 17, 18)], ['betrieb'] * 3 + ['flaeche'])
        self.assertEqual({zusage(m, f'Z-{n:03d}')['art'] for n in range(1, 10)}, {'plan_abnahme'})

    def test_anrede_betreff_und_anleitung_sind_rahmen(self):
        saetze = [s for _, _, s in zusagen.saetze_der_vorlage((nachweismatrix.REPO / VORLAGE).read_text(encoding='utf-8'))]
        self.assertTrue(saetze)
        for s in saetze:
            self.assertNotIn('Guten Tag', s)
            self.assertNotIn('Betreff', s)
            self.assertNotIn('eckigen Klammern', s)


class Gegenproben(unittest.TestCase):
    """Jede Gegenprobe ändert eine Kopie von Vorlage oder Matrix an einer Stelle und muss rot werden."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.wurzel = pathlib.Path(self.tmp.name)
        self.m = lade_matrix()
        for z in self.m['zusagen']:
            for pfad, _ in zusagen.fundstellen(z['quelle']):
                quelle = nachweismatrix.REPO / pfad
                if quelle.is_file():
                    ziel = self.wurzel / pfad
                    ziel.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(quelle, ziel)
        self.vorlage = self.wurzel / VORLAGE
        self.assertEqual(zusagen.verstoesse(self.m, self.wurzel), [], 'die Kopie muss vor der Gegenprobe grün sein')

    def tearDown(self):
        self.tmp.cleanup()

    def zeilen(self):
        return self.vorlage.read_text(encoding='utf-8').splitlines(keepends=True)

    def schreibe(self, zeilen):
        self.vorlage.write_text(''.join(zeilen), encoding='utf-8')

    def test_eine_neue_zeile_am_ende_ohne_zusage_ist_rot_mx5(self):
        zeilen = self.zeilen()
        self.schreibe(zeilen + ['- Ihre Berichte erscheinen jetzt auch als Tabelle.\n'])
        self.assertEqual(zusagen.verstoesse(self.m, self.wurzel), [
            f'{VORLAGE}:{len(zeilen) + 1}: Satz „Ihre Berichte erscheinen jetzt auch als Tabelle.“ hat keine Zusage (MX5)'])

    def test_eine_neue_zeile_in_der_mitte_ist_rot_und_nennt_die_neuen_zeilen_der_anderen(self):
        zeilen = self.zeilen()
        self.schreibe(zeilen[:39] + ['- Ihre Berichte erscheinen jetzt auch als Tabelle.\n'] + zeilen[39:])
        fehler = zusagen.verstoesse(self.m, self.wurzel)
        self.assertIn(f'{VORLAGE}:40: Satz „Ihre Berichte erscheinen jetzt auch als Tabelle.“ hat keine Zusage (MX5)', fehler)
        self.assertIn(f'zusagen[Z-010].quelle: der Wortlaut steht nicht an {VORLAGE}:42 - Zeilen verschoben, '
                      'steht jetzt an :43; die Quelle mitziehen (MX3)', fehler)
        self.assertIn(f'zusagen[Z-011].quelle: der Wortlaut steht nicht an {VORLAGE}:62 - Zeilen verschoben, '
                      'steht jetzt an :63; die Quelle mitziehen (MX3)', fehler)
        self.assertEqual(sum('(MX5)' in f for f in fehler), 1, fehler)

    def test_ein_geaenderter_satz_ist_rot_an_zusage_und_satz(self):
        zeilen = self.zeilen()
        self.assertIn('Fahrplänen ändert sich dadurch nichts.', zeilen[41])
        zeilen[41] = zeilen[41].replace('Fahrplänen ändert sich dadurch nichts.', 'Fahrplänen ändert sich wenig.')
        self.schreibe(zeilen)
        fehler = '\n'.join(zusagen.verstoesse(self.m, self.wurzel))
        self.assertIn(f'zusagen[Z-010].quelle: der Wortlaut steht nicht an {VORLAGE}:42 - Satz geändert oder entfallen', fehler)
        self.assertIn('Satz „An Ihren Zahlen, Ihrer Steuerung und Ihren Fahrplänen ändert sich wenig.“ hat keine Zusage (MX5)', fehler)

    def test_eine_entfernte_zusage_ist_rot_mx5(self):
        self.m['zusagen'] = [z for z in self.m['zusagen'] if z['kennzeichen'] != 'Z-010']
        self.assertEqual(zusagen.verstoesse(self.m, self.wurzel), [
            f'{VORLAGE}:42: Satz „An Ihren Zahlen, Ihrer Steuerung und Ihren Fahrplänen ändert sich dadurch nichts.“ '
            'hat keine Zusage (MX5)'])

    def test_eine_quelle_ohne_zeile_ist_rot_mx3(self):
        zusage(self.m, 'Z-013')['quelle'] = 'frontend/portal/src/components/AuthScreen.tsx'
        self.assertIn('zusagen[Z-013].quelle: „frontend/portal/src/components/AuthScreen.tsx“ ist nicht datei:zeile (MX3)',
                      zusagen.verstoesse(self.m, self.wurzel))

    def test_eine_zeile_hinter_dem_dateiende_ist_rot(self):
        zusage(self.m, 'Z-013')['quelle'] = 'frontend/portal/src/components/AuthScreen.tsx:99999'
        fehler = '\n'.join(zusagen.verstoesse(self.m, self.wurzel))
        self.assertIn('zusagen[Z-013].quelle: frontend/portal/src/components/AuthScreen.tsx:99999 gibt es nicht', fehler)

    def test_eine_datei_die_es_nicht_gibt_ist_rot(self):
        zusage(self.m, 'Z-013')['quelle'] = 'frontend/portal/src/components/Gibtsnicht.tsx:1'
        self.assertIn('zusagen[Z-013].quelle: frontend/portal/src/components/Gibtsnicht.tsx gibt es nicht',
                      zusagen.verstoesse(self.m, self.wurzel))

    def test_ein_wortlaut_der_nicht_an_der_quelle_steht_ist_rot(self):
        zusage(self.m, 'Z-013')['wortlaut'] = 'Server in der EU'
        self.assertTrue(any(f.startswith('zusagen[Z-013].quelle: der Wortlaut steht nicht an') for f in
                            zusagen.verstoesse(self.m, self.wurzel)))

    def test_eine_kurzform_prueft_nur_die_zeilen(self):
        z = zusage(self.m, 'Z-015')
        self.assertTrue(zusagen.ist_kurzform(z))
        z['wortlaut'] = 'Ganz andere Worte (Kurzform)'
        self.assertEqual(zusagen.verstoesse(self.m, self.wurzel), [])
        z['quelle'] = 'docs/backup-restore.md:99999'
        self.assertTrue(zusagen.verstoesse(self.m, self.wurzel))

    def test_quellen_ausserhalb_und_an_festem_stand_prueft_die_wache_nicht(self):
        zusage(self.m, 'Z-016')['wortlaut'] = 'Hundert Jahre'
        zusage(self.m, 'Z-013')['quelle'] = 'origin/main:frontend/portal/src/components/AuthScreen.tsx:1'
        self.assertEqual(zusagen.verstoesse(self.m, self.wurzel), [])

    def test_mit_plan_ist_jeder_satz_der_abnahmen_ap01_bis_ap19_und_das_ergebnis_ap00_gedeckt(self):
        plan = self.wurzel / 'plan.md'
        plan.write_text('\n'.join([
            '### AP-00 — Fachmodell', 'Ergebnis: Ein Glossar.',
            '### AP-01 — Portal', 'Ziel: kein Satz der Wache.', 'Abnahme: Satz eins. Satz zwei.',
            '### AP-20 — Bewertung', 'Abnahme: Die Bewertung selbst ist keine Zusage an Kunden.']) + '\n', encoding='utf-8')
        m = copy.deepcopy(self.m)
        m['zusagen'] = [z for z in m['zusagen'] if not z['quelle'].startswith(zusagen.PLAN)] + [
            dict(zusage(m, 'Z-001'), kennzeichen='Z-901', wortlaut='Ein Glossar.', quelle='PG/plan.md:2'),
            dict(zusage(m, 'Z-001'), kennzeichen='Z-902', wortlaut='Satz eins.', quelle='PG/plan.md:5')]
        self.assertEqual(zusagen.verstoesse(m, self.wurzel), [], 'ohne --plan wird der Plan nicht gelesen')
        self.assertEqual(zusagen.verstoesse(m, self.wurzel, plan=plan),
                         ['PG/plan.md:5: Satz „Satz zwei.“ hat keine Zusage (MX5)'])
        zusage(m, 'Z-902')['wortlaut'] = 'Satz eins. Satz zwei.'
        self.assertEqual(zusagen.verstoesse(m, self.wurzel, plan=plan), [])
        zusage(m, 'Z-902')['quelle'] = 'PG/plan.md:4'
        self.assertTrue(zusagen.verstoesse(m, self.wurzel, plan=plan))


class Kommandozeile(unittest.TestCase):

    def lauf(self, *argv):
        aus = io.StringIO()
        with redirect_stdout(aus):
            code = zusagen.main(list(argv))
        return code, aus.getvalue()

    def test_gruen_an_der_matrix_im_repo(self):
        code, aus = self.lauf()
        self.assertEqual(code, 0, aus)
        self.assertIn('Wache hält', aus)

    def test_rot_mit_einer_zeile_je_verstoss(self):
        m = lade_matrix()
        m['zusagen'] = [z for z in m['zusagen'] if z['kennzeichen'] not in ('Z-010', 'Z-011')]
        with tempfile.TemporaryDirectory() as tmp:
            pfad = pathlib.Path(tmp) / 'matrix.json'
            pfad.write_text(json.dumps(m, ensure_ascii=False), encoding='utf-8')
            code, aus = self.lauf(str(pfad))
        self.assertEqual(code, 1)
        zeilen = aus.strip().splitlines()
        self.assertEqual(len(zeilen), 7, aus)  # Z-010 an :42, Z-011 je zwei Sätze an :45, :62, :80
        self.assertTrue(all(z.startswith('rot: ') and z.endswith('(MX5)') for z in zeilen), aus)

    def test_aufruffehler_ist_exit_2(self):
        with redirect_stdout(io.StringIO()), unittest.mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(zusagen.main(['--unbekannt']), 2)


if __name__ == '__main__':
    unittest.main()
