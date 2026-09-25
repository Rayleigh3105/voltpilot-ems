#!/usr/bin/env python3
"""Klammer der Nachweis-Kandidaten (AP-20 IP-6, AP-20 NW-1) - an der Matrix im Repo und an Gegenproben.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Jede Gegenprobe ändert die grüne Matrix an genau einer Stelle und muss rot werden. Die Klammer
prüft den Baum, nicht die Laufzeit: dass ein Kandidat grün ist, sagt erst der Lauf (AP-20 IP-10).
"""

import copy
import io
import json
import pathlib
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import klammer  # noqa: E402
import nachweismatrix  # noqa: E402

# Die Zusagen, die AP-20 IP-6 zuordnet: Plan-Abnahmen AP-00 … AP-15, Betrieb und die Sätze der Notizen,
# die nicht zum ISO-Strang AP-16 … AP-19 gehören (den ordnet AP-20 IP-7 zu).
PLAN_AP00_BIS_AP15 = ['Z-006', 'Z-007', 'Z-008', 'Z-009', *(f'Z-{n:03d}' for n in range(19, 39))]
BETRIEB = ['Z-015', 'Z-016', 'Z-017', 'Z-076']


def lade():
    return json.loads(nachweismatrix.MATRIX_PFAD.read_text(encoding='utf-8'))


def zusage(m, kz):
    return next(z for z in m['zusagen'] if z['kennzeichen'] == kz)


class MatrixImRepo(unittest.TestCase):

    def setUp(self):
        self.m = lade()

    def test_jeder_kandidat_existiert_und_keine_zeile_ohne_kandidat_oder_lieferant(self):
        self.assertEqual(klammer.verstoesse(self.m), [])

    def test_jede_plan_abnahme_ap00_bis_ap15_traegt_einen_fall_und_bleibt_offen(self):
        for kz in PLAN_AP00_BIS_AP15:
            z = zusage(self.m, kz)
            self.assertEqual(z['art'], 'plan_abnahme', kz)
            self.assertTrue([k for k in z['nachweis_kandidaten'] if klammer.art(k) != 'pfad'], kz)
            # Ein Kandidat ist kein Beleg (NR7): IP-6 setzt kein Urteil, es bleibt offen bis zum Lauf.
            self.assertEqual((z['urteil'], z['nachweise']), ('offen', []), kz)

    def test_z006_und_z017_nennen_ihre_methoden(self):
        z006 = zusage(self.m, 'Z-006')['nachweis_kandidaten']
        self.assertIn('ZugriffZaunApiTest#jedeNachIp4NurZufaelligGrueneRouteTrifftEinEchtesObjektUndMachtEineZaunAussage', z006)
        self.assertTrue([k for k in z006 if k.startswith('KennzahlWerteApiTest#')], 'Z-006: Kennzahl')
        self.assertTrue([k for k in z006 if 'Csv' in k or 'Export' in k], 'Z-006: Export')
        z017 = zusage(self.m, 'Z-017')['nachweis_kandidaten']
        self.assertIn('UnterstuetzungApiTest#a5VoltPilotFragtAnUndDerKundenadministratorGewaehrt', z017)
        self.assertIn('UnterstuetzungApiTest#a14NotfallZugriffIstEngUndLaut', z017)

    def test_jede_betriebszusage_hat_artefakt_oder_bestaetigung_des_betreibers(self):
        for kz in BETRIEB:
            z = zusage(self.m, kz)
            self.assertIn('Betreiber', [w['wer'] for w in z['wer_liefert']], kz)

    def test_keine_zeile_wartet_mehr_auf_ip6(self):
        for z in self.m['zusagen']:
            for w in z.get('wer_liefert', []):
                self.assertNotRegex(w['was'], klammer.WARTET, z['kennzeichen'])

    def test_der_aufruf_zaehlt_je_form_und_nennt_die_zeilen_nur_mit_lieferant(self):
        aus = io.StringIO()
        with redirect_stdout(aus):
            self.assertEqual(klammer.main([]), 0)
        je_art, ohne = klammer.zaehlung(self.m)
        self.assertIn(f'{sum(je_art.values())} Kandidaten', aus.getvalue())
        self.assertIn(', '.join(ohne), aus.getvalue())


class Gegenproben(unittest.TestCase):

    def setUp(self):
        self.m = lade()
        self.assertEqual(klammer.verstoesse(self.m), [], 'die Matrix muss vor der Gegenprobe grün sein')

    def assertRot(self, kz, teil):
        fehler = [f for f in klammer.verstoesse(self.m) if f.startswith(f'{kz}: ')]
        self.assertTrue(fehler, f'{kz}: erwartet rot, war grün')
        self.assertIn(teil, '\n'.join(fehler))

    def kandidat(self, kz, kandidat):
        zusage(self.m, kz)['nachweis_kandidaten'].append(kandidat)

    def test_eine_erfundene_methode_ist_rot(self):
        self.kandidat('Z-006', 'ZugriffZaunApiTest#gibtEsNicht')
        self.assertRot('Z-006', 'Methode gibtEsNicht fehlt in services/api/src/test/java/com/voltpilot/api/zugriff/ZugriffZaunApiTest.java')

    def test_eine_erfundene_klasse_ist_rot(self):
        self.kandidat('Z-017', 'NotfallZugriffGibtEsNichtTest#a14')
        self.assertRot('Z-017', 'Klasse NotfallZugriffGibtEsNichtTest steht in keinem Testbaum')

    def test_eine_mehrdeutige_klasse_ist_rot(self):
        # Gleiche einfache Namen gibt es in drei Diensten - mehrdeutig ist erst ein Kandidat, der darauf zeigt.
        self.kandidat('Z-038', 'K8sReadinessConfigTest#shutdownIsGracefulSoARollingDeployDoesNotCutInFlightWork')
        self.assertRot('Z-038', 'Klasse K8sReadinessConfigTest ist mehrdeutig')

    def test_die_methode_einer_anderen_klasse_ist_rot(self):
        self.kandidat('Z-027', 'UemsStreckeAbnahmeTest#a2_nachDemEchtenChunkDropTraegtJedeViertelstundeIhreHerkunft')
        self.assertRot('Z-027', 'Methode a2_nachDemEchtenChunkDropTraegtJedeViertelstundeIhreHerkunft fehlt')

    def test_ein_erfundener_fall_je_dateiart_ist_rot(self):
        faelle = {
            'Z-021': 'frontend/portal/src/startansicht.test.ts#1 Standort, 1 Anlage → Anlage-Cockpit',
            'Z-025': 'tools/edge-simulator/test_uems_ahrenberg.py#test_a3_gibt_es_nicht',
            'Z-072': 'edge-app/core/internal/otaupdater/engine_test.go#TestAFailedSelfTest',
            'Z-007': 'edge-app/nodered/measurements/wago-registerbild.test.js#die Vertragsfaelle V1…V14',
        }
        for kz, kandidat in faelle.items():
            self.kandidat(kz, kandidat)
        for kz, kandidat in faelle.items():
            self.assertRot(kz, f'Fall „{kandidat.split("#", 1)[1]}“ fehlt')

    def test_eine_fehlende_testdatei_ist_rot(self):
        self.kandidat('Z-061', 'frontend/portal/src/gibtEsNicht.test.ts#lädt neu')
        self.assertRot('Z-061', 'Testdatei frontend/portal/src/gibtEsNicht.test.ts fehlt')

    def test_ein_fehlender_pfad_und_eine_fehlende_zeile_sind_rot(self):
        self.kandidat('Z-015', 'tools/backup/gibt-es-nicht.sh (Übung)')
        self.assertRot('Z-015', 'weder Klasse#methode noch pfad#Fall noch ein Pfad im Repo')
        self.kandidat('Z-017', 'services/api/src/main/resources/db/migration/V20260915030000__uems_zugriff.sql:99999 (zugriff_protokoll)')
        self.assertRot('Z-017', 'Zeile 99999 fehlt')

    def test_eine_klasse_ohne_methode_ist_rot(self):
        self.kandidat('Z-009', 'UemsMesskundenLaufAbnahmeTest (AP-14 NW-4)')
        self.assertRot('Z-009', 'weder Klasse#methode noch pfad#Fall noch ein Pfad im Repo')

    def test_eine_zeile_ohne_kandidat_und_ohne_lieferant_ist_rot(self):
        z = zusage(self.m, 'Z-040')
        z['nachweis_kandidaten'], z['wer_liefert'] = [], []
        self.assertRot('Z-040', 'weder Kandidat noch Lieferant (AP-20 NW-1)')

    def test_eine_plan_abnahme_nur_mit_pfad_ist_rot(self):
        zusage(self.m, 'Z-019')['nachweis_kandidaten'] = ['docs/fachmodell/tools/check_belege.sh (Glossar)']
        self.assertRot('Z-019', 'Plan-Abnahme ohne Fall')

    def test_eine_betriebszusage_ohne_betreiber_ist_rot(self):
        zusage(self.m, 'Z-076')['wer_liefert'] = [{'wer': 'Crew', 'was': 'Lauf am Stand (AP-20 IP-10)'}]
        self.assertRot('Z-076', 'Betriebszusage ohne Bestätigung des Betreibers')

    def test_eine_zeile_die_noch_auf_ip6_wartet_ist_rot(self):
        zusage(self.m, 'Z-020')['wer_liefert'] = [{'wer': 'Crew', 'was': 'Methode benennen (AP-20 IP-6)'}]
        self.assertRot('Z-020', 'wartet noch auf AP-20 IP-6')

    def test_der_aufruf_ist_rot_mit_exit_1_und_ein_falscher_aufruf_exit_2(self):
        self.kandidat('Z-006', 'ZugriffZaunApiTest#gibtEsNicht')
        with tempfile.TemporaryDirectory() as tmp:
            pfad = pathlib.Path(tmp) / 'matrix.json'
            pfad.write_text(json.dumps(copy.deepcopy(self.m), ensure_ascii=False), encoding='utf-8')
            aus = io.StringIO()
            with redirect_stdout(aus):
                self.assertEqual(klammer.main([str(pfad)]), 1)
            self.assertIn('rot: Z-006: ZugriffZaunApiTest#gibtEsNicht', aus.getvalue())
        with redirect_stdout(io.StringIO()), unittest.mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(klammer.main(['--hilfe']), 2)


if __name__ == '__main__':
    unittest.main()
