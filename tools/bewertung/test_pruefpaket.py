#!/usr/bin/env python3
"""Prüfpaket für die Fachperson (AP-20 IP-11): Paket im Repo, Normtext-Wache, Prüfsumme, zweiter Bau.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Abnahme der §8-Zeile: der Export enthält jede der 30 Zeilen und keinen Normtext; die Prüfsumme stimmt.
Jede Gegenprobe ändert die grüne Matrix oder das Paket an genau einer Stelle und muss rot werden.
"""

import copy
import hashlib
import io
import json
import pathlib
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402
import pruefpaket  # noqa: E402

# MX4: VoltPilot sagt das nie über sich. Zitierte Zusagen (ihr Wortlaut) prüft die Wache MX5, nicht diese.
NIE_GESAGT = re.compile(r'\b(?:erfüllt|konform|zertifiziert|vollständig)\w*', re.IGNORECASE)


def lade():
    return json.loads(nachweismatrix.MATRIX_PFAD.read_text(encoding='utf-8'))


def normzeile(matrix, abschnitt):
    return next(z for z in matrix['norm_teil'] if z['abschnitt'] == abschnitt)


def still(fn, *args):
    with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
        code = fn(*args)
    return code, out.getvalue()


class PaketImRepo(unittest.TestCase):

    def setUp(self):
        self.matrix = lade()
        self.md = (pruefpaket.AUS_PFAD / 'pruefpaket.md').read_text(encoding='utf-8')
        self.vorlage = json.loads((pruefpaket.AUS_PFAD / 'protokoll-vorlage.json').read_text(encoding='utf-8'))
        self.abschnitte = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']

    def test_das_paket_im_repo_ist_der_bau_aus_den_quellen(self):
        code, out = still(pruefpaket.main, ['--check'])
        self.assertEqual(code, 0, out)

    def test_der_export_enthaelt_jede_der_30_zeilen_mit_umschreibung_traeger_und_kundenaufgabe(self):
        self.assertEqual(len(self.abschnitte), 30)
        ueberschriften = re.findall(r'^### (\S+)$', self.md, re.MULTILINE)
        self.assertEqual(ueberschriften, self.abschnitte)
        for z in self.matrix['norm_teil']:
            block = self.md.split(f'\n### {z["abschnitt"]}\n', 1)[1].split('\n### ', 1)[0]
            self.assertIn(f'| Umschreibung (eigene Worte) | {z["umschreibung"]} |', block)
            self.assertIn(f'| Träger | {pruefpaket.TRAEGER[z["traeger"]]} |', block)
            self.assertIn(f'| Kundenaufgabe | {z["kundenaufgabe"]}: ', block)
            for kz in z['zusagen']:
                self.assertIn(f'| {kz} | ', block)

    def test_keine_umschreibung_ist_normtext(self):
        for z in self.matrix['norm_teil']:
            with self.subTest(z['abschnitt']):
                self.assertLessEqual(len(z['umschreibung']), 160)
                self.assertEqual(pruefpaket.normtext_verdacht(z['umschreibung']), [])

    def test_kein_normsatz_im_ganzen_paket(self):
        for name in pruefpaket.DATEIEN:
            text = (pruefpaket.AUS_PFAD / name).read_text(encoding='utf-8')
            for muster, grund in pruefpaket.NORMSATZ[:2]:
                with self.subTest(datei=name, grund=grund):
                    self.assertIsNone(muster.search(text))

    def test_das_paket_sagt_die_grenze_und_nie_konform(self):
        self.assertIn(pruefpaket.GRENZ_SATZ, self.md)
        self.assertIn('Das Paket enthält keinen Normtext.', self.md)
        zusagen = {z['wortlaut'] for z in self.matrix['zusagen']}
        eigen = [zeile for zeile in self.md.splitlines() if not any(w in zeile for w in zusagen)]
        self.assertEqual(NIE_GESAGT.findall('\n'.join(eigen)), [])

    def test_die_frageliste_traegt_die_fragen_des_konzepts(self):
        fragen = {f['frage']: f for f in pruefpaket._fragen(self.matrix)}
        self.assertEqual(fragen['F-02']['abschnitte'], ['4.4'])
        self.assertEqual(fragen['F-03']['abschnitte'], ['6.3'])
        self.assertEqual(fragen['F-04']['abschnitte'], ['9.1.1'])
        self.assertEqual(fragen['F-05']['abschnitte'], ['4.1', '4.2'])
        self.assertIn('KA-05', fragen['F-05']['text'])
        self.assertEqual(fragen['F-06']['thema'], 'Grenze zwischen Verweis und geführt')
        verweise = [z['abschnitt'] for z in self.matrix['norm_teil'] if z['traeger'] == 'verweis']
        self.assertTrue(set(verweise) <= set(fragen['F-06']['abschnitte']))
        for kz, f in fragen.items():
            self.assertIn(f'**{kz} · {f["thema"]}**', self.md)

    def test_die_vorlage_traegt_je_zeile_die_felder_der_matrix_und_ist_leer(self):
        felder = nachweismatrix.lade_schema()['$defs']['fachperson']['required']
        self.assertEqual([l['abschnitt'] for l in self.vorlage['lesarten']], self.abschnitte)
        for l in self.vorlage['lesarten']:
            self.assertEqual(sorted(k for k in l if k != 'abschnitt'), sorted(felder))
            self.assertTrue(all(l[k] is None for k in felder))
        self.assertEqual([a['frage'] for a in self.vorlage['antworten']],
                         [f['frage'] for f in pruefpaket._fragen(self.matrix)])
        self.assertTrue(all(v is None for v in self.vorlage['fachperson'].values()))

    def test_die_pruefsumme_stimmt(self):
        zeilen = (pruefpaket.AUS_PFAD / pruefpaket.SUMME).read_text(encoding='utf-8').splitlines()
        self.assertEqual([z.split('  ', 1)[1] for z in zeilen], list(pruefpaket.DATEIEN))
        for z in zeilen:
            summe, name = z.split('  ', 1)
            self.assertEqual(hashlib.sha256((pruefpaket.AUS_PFAD / name).read_bytes()).hexdigest(), summe)
        md_sha = hashlib.sha256((pruefpaket.AUS_PFAD / 'pruefpaket.md').read_bytes()).hexdigest()
        self.assertEqual(self.vorlage['pruefpaket']['sha256'], md_sha)


class Bau(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        self.matrix = lade()

    def tearDown(self):
        self.tmp.cleanup()

    def schreibe(self, matrix):
        pfad = self.dir / 'matrix.json'
        pfad.write_text(json.dumps(matrix, ensure_ascii=False, indent=1), encoding='utf-8')
        return pfad

    def test_ein_zweiter_bau_ist_byte_gleich(self):
        a, b = self.dir / 'a', self.dir / 'b'
        self.assertEqual(still(pruefpaket.main, ['--aus', str(a)])[0], 0)
        self.assertEqual(still(pruefpaket.main, ['--aus', str(b)])[0], 0)
        for name in (*pruefpaket.DATEIEN, pruefpaket.SUMME):
            self.assertEqual((a / name).read_bytes(), (b / name).read_bytes(), name)

    def test_gegenprobe_eine_von_hand_geaenderte_datei_ist_rot(self):
        aus = self.dir / 'paket'
        still(pruefpaket.main, ['--aus', str(aus)])
        md = aus / 'pruefpaket.md'
        md.write_text(md.read_text(encoding='utf-8').replace('### 6.3', '### 6.3 ', 1), encoding='utf-8')
        code, out = still(pruefpaket.main, ['--check', '--aus', str(aus)])
        self.assertEqual(code, 1)
        self.assertIn('pruefpaket.md ist nicht der Bau aus den Quellen', out)

    def test_gegenprobe_eine_fremde_datei_im_paket_ist_rot(self):
        aus = self.dir / 'paket'
        still(pruefpaket.main, ['--aus', str(aus)])
        (aus / 'normtext.pdf').write_bytes(b'x')
        code, out = still(pruefpaket.main, ['--check', '--aus', str(aus)])
        self.assertEqual(code, 1)
        self.assertIn('normtext.pdf gehört nicht zum Paket', out)

    def gegenprobe(self, umschreibung, grund):
        m = copy.deepcopy(self.matrix)
        normzeile(m, '9.2.2')['umschreibung'] = umschreibung
        code, out = still(pruefpaket.main, ['--matrix', str(self.schreibe(m)), '--aus', str(self.dir / 'x')])
        self.assertEqual(code, 1, out)
        self.assertIn(f'rot: Norm-Zeile 9.2.2: Umschreibung {grund}', out)
        self.assertFalse((self.dir / 'x').exists())

    def test_gegenprobe_pflichtform_der_norm_ist_rot(self):
        self.gegenprobe('Die Organisation muss interne Audits in geplanten Abständen durchführen', 'Pflichtform der Norm')

    def test_gegenprobe_englische_pflichtform_ist_rot(self):
        self.gegenprobe('The organization shall conduct internal audits', 'Pflichtform der englischen Ausgabe')

    def test_gegenprobe_zitat_ist_rot(self):
        self.gegenprobe('Interne Audits: „in geplanten Abständen“', 'Zitat')

    def test_gegenprobe_zu_lange_umschreibung_ist_rot(self):
        m = copy.deepcopy(self.matrix)
        normzeile(m, '9.2.2')['umschreibung'] = 'x' * 161
        # Das Schema begrenzt schon auf 160; der Vertrag ist dann rot, das Paket entsteht nicht.
        code, out = still(pruefpaket.main, ['--matrix', str(self.schreibe(m)), '--aus', str(self.dir / 'x')])
        self.assertEqual(code, 2, out)
        self.assertFalse((self.dir / 'x').exists())
        self.assertIn('länger als 160 Zeichen (161)', pruefpaket.normtext_verdacht('x' * 161))

    def test_gegenprobe_eine_fehlende_zeile_baut_kein_paket(self):
        m = copy.deepcopy(self.matrix)
        m['norm_teil'] = [z for z in m['norm_teil'] if z['abschnitt'] != '8.3']
        code, _ = still(pruefpaket.main, ['--matrix', str(self.schreibe(m)), '--aus', str(self.dir / 'x')])
        self.assertNotEqual(code, 0)
        self.assertFalse((self.dir / 'x').exists())

    def test_eine_produktbeschreibung_im_entwurf_wird_aufgenommen(self):
        pb = self.dir / 'pb'
        pb.mkdir()
        (pb / 'uebersicht.md').write_text('Entwurf\n', encoding='utf-8')
        aus = self.dir / 'paket'
        still(pruefpaket.main, ['--aus', str(aus), '--produktbeschreibung', str(pb)])
        md = (aus / 'pruefpaket.md').read_text(encoding='utf-8')
        summe = hashlib.sha256('Entwurf\n'.encode('utf-8')).hexdigest()
        self.assertIn(f'| uebersicht.md | `{summe}` |', md)
        self.assertNotIn('Noch nicht vorhanden', md)


if __name__ == '__main__':
    unittest.main()
