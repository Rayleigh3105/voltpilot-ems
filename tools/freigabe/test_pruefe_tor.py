#!/usr/bin/env python3
"""Der Tor-Pruefer gegen Fixtures - ohne Repo, ohne Datenbank, ohne Betreiberdaten.

    python3 -m unittest discover -s tools/freigabe -p 'test_*.py'
"""

import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pruefe_tor  # noqa: E402

# G0 verlangt diese Pakete; die Nummern stehen in der verbindlichen Liste (§8).
G0_PRS = [(963, 'Halb-Zustand'), (965, 'erste Minute'), (967, 'Bestandsschutz'),
          (968, 'Zuordnung korrigieren'), (966, 'Metriken'), (981, 'Zusammenfuehrung geprobt'),
          (978, 'Sprach-Waechter')]

SUREFIRE_GRUEN = ('<?xml version="1.0" encoding="UTF-8"?>'
                  '<testsuite name="{name}" tests="{tests}" errors="0" skipped="0" failures="0" time="12.3"/>')
SUREFIRE_ROT = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<testsuite name="{name}" tests="7" errors="0" skipped="0" failures="2" time="9.1"/>')
SUREFIRE_UEBERSPRUNGEN = ('<?xml version="1.0" encoding="UTF-8"?>'
                          '<testsuite name="{name}" tests="4" errors="0" skipped="4" failures="0" time="0.1"/>')

NACHWEIS_KLASSEN = {
    'V0': 'com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest',
    'NW-2': 'com.voltpilot.api.uems.UemsBestandSteuerungAusEinemStueckTest',
    'NW-4': 'com.voltpilot.api.uems.UemsMesskundenLaufAbnahmeTest',
    'R1': 'com.voltpilot.api.zugriff.RechtMatrixApiTest',
    'NW-6k': 'com.voltpilot.api.metrics.DauerlaeuferGanzerWegDbTest',
    'NW-3u': 'com.voltpilot.api.measurement.MessplanNachBoxUpdateApiTest',
}

PROBE_GUT = {
    'exit_code': 0,
    'A': {'migrationen': 65, 'summe_ms': 184_000, 'startbudget_reicht': 1},
    'C': {'Z08': {'geloescht_markiert': 0, 'fehlgeschlagen': 0, 'sql_erfolgreich': 0, 'versionen_geloescht': 0}},
    'W1': {'ungeprobt': 0, 'bereit': 1,
           'Z08': {'geloescht_markiert': 0, 'fehlgeschlagen': 0, 'sql_erfolgreich': 0, 'versionen_geloescht': 0}},
}
RUECKWEG_GUT = {'exit_code': 0, 'wiederherstellung_ms': 412_000, 'flyway_stimmt': 1, 'Q01_stimmt': 1}

NW3_GRUEN = {
    'nachweis': 'NW-3', 'gefahren_am': '2026-09-19T02:22:05Z',
    'paar': {'name': 'edge-2026.09.4'},
    'punkte': [{'punkt': f'{n}', 'urteil': 'gruen'} for n in range(1, 8)],
    'zusammenfassung': '7 gruen, 0 rot',
}

# Genau die Punkte, die allein der Betreiber weiss - alle vier Tore zusammen.
STAND_PUNKTE = ['m1_ausgewertet', 'nw5_lastmessung', 'nw6_alarmuebung', 'kapazitaet_l6', 'pilotkunden',
                'gitops_pr37', 'gitops_platzhalter', 'supportweg', 'kundennachricht', 'ip18_dauerlaeufer',
                'startwaechter_main', 'budgetpruefung_produktion', 'core_palette_gemeinsam',
                'flotte_auf_release_a', 'q10_pending_edge', 'wago_hardware_pilot']


def git(repo, *argv):
    umgebung = dict(os.environ, GIT_AUTHOR_NAME='T', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='T',
                    GIT_COMMITTER_EMAIL='t@t')
    return subprocess.run(['git', '-C', str(repo), *argv], capture_output=True, text=True,
                          check=True, env=umgebung).stdout.strip()


class Buehne:
    """Ein Wegwerf-Repo mit genau der Geschichte, die G0 verlangt."""

    def __init__(self, wurzel: pathlib.Path):
        self.wurzel = wurzel
        git(wurzel, 'init', '-q', '-b', 'main')
        git(wurzel, 'commit', '-q', '--allow-empty', '-m', 'Ausgangsstand von main (#904)')
        for nummer, was in G0_PRS:
            git(wurzel, 'commit', '-q', '--allow-empty', '-m', f'UEMS: {was} ({nummer}) (#{nummer})')
        self.kopf = git(wurzel, 'rev-parse', 'HEAD')

        self.laeufe = wurzel / 'laeufe'
        self.laeufe.mkdir()
        (self.laeufe / 'stand.txt').write_text(self.kopf, encoding='utf-8')
        for klasse in NACHWEIS_KLASSEN.values():
            self.surefire(klasse, SUREFIRE_GRUEN.format(name=klasse, tests=11))

        (wurzel / 'docs/rollout').mkdir(parents=True)
        self.nw3(NW3_GRUEN)
        # GA verlangt ein Protokoll fuer ein ANDERES Paar als das ausgelieferte.
        neu = json.loads(json.dumps(NW3_GRUEN))
        neu['paar'] = {'name': 'edge-2026.10.1'}
        self.nw3(neu, 'edge-2026.10.1')

        self.probe = wurzel / 'probe'
        self.probe.mkdir()
        self.probe_json(PROBE_GUT)
        (self.probe / 'rueckweg.json').write_text(json.dumps(RUECKWEG_GUT), encoding='utf-8')

        self.blatt = wurzel / 'q01-q18.txt'
        self.blatt.write_text('Q01 ... 65 angewandt, 0 fehlgeschlagen\n', encoding='utf-8')

        self.stand = wurzel / 'freigabe-stand.yaml'
        self.stand_schreiben({p: ('ja', '2026-09-20') for p in STAND_PUNKTE})

    def surefire(self, klasse, inhalt):
        (self.laeufe / f'TEST-{klasse}.xml').write_text(inhalt, encoding='utf-8')

    def nw3(self, inhalt, paar='edge-2026.09.4'):
        (self.wurzel / f'docs/rollout/nw3-protokoll-{paar}.json').write_text(
            json.dumps(inhalt), encoding='utf-8')

    def probe_json(self, inhalt):
        (self.probe / 'probe.json').write_text(json.dumps(inhalt), encoding='utf-8')

    def stand_schreiben(self, punkte):
        zeilen = ['# Wegwerf-Stand-Blatt der Fixture']
        for name, (bestaetigt, am) in punkte.items():
            zeilen += [f'{name}:', f'  bestaetigt: {bestaetigt}', f'  am: {am}',
                       '  durch: Betreiber', '  beleg: Fixture']
        self.stand.write_text('\n'.join(zeilen) + '\n', encoding='utf-8')

    def fahre(self, tor, **zusatz):
        argv = [tor, '--wurzel', str(self.wurzel), '--laeufe', str(self.laeufe)]
        if tor != 'G0':
            argv += ['--stand', str(self.stand), '--blatt', str(self.blatt),
                     '--generalprobe', str(self.probe)]
        for schluessel, wert in zusatz.items():
            argv += [f'--{schluessel}', str(wert)]
        aus = io.StringIO()
        with contextlib.redirect_stdout(aus):
            code = pruefe_tor.main(argv)
        return code, aus.getvalue()


class TorPrueferTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.b = Buehne(pathlib.Path(self.tmp.name))

    # -- alles belegt --------------------------------------------------------

    def test_alles_belegt_exit_0(self):
        for tor in ('G0', 'G1', 'GA', 'GB'):
            with self.subTest(tor=tor):
                code, text = self.b.fahre(tor)
                self.assertEqual(0, code, text)
                self.assertNotIn('[offen]', text)

    def test_belegt_nennt_die_fundstelle(self):
        _, text = self.b.fahre('G0')
        self.assertIn(self.b.kopf[:8], text)
        self.assertIn('TEST-com.voltpilot.api.uems.UemsProduktionsreihenfolgeMigrationTest.xml', text)
        self.assertIn('11 Tests, 0 Fehler', text)

    def test_betreiberwort_bleibt_als_betreiberwort_stehen(self):
        _, text = self.b.fahre('G1')
        self.assertIn('nicht maschinell pruefbar', text)
        self.assertIn('das Werkzeug hat das nicht nachgeprueft', text)
        self.assertIn('nicht maschinell pruefbar, vom Betreiber bestaetigt', text)

    # -- ein Beleg fehlt -----------------------------------------------------

    def test_fehlender_surefire_bericht_ist_offen_und_wird_benannt(self):
        (self.b.laeufe / f'TEST-{NACHWEIS_KLASSEN["NW-2"]}.xml').unlink()
        code, text = self.b.fahre('G0')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-2', text)
        self.assertIn('UemsBestandSteuerungAusEinemStueckTest', text)
        self.assertIn('PR 969', text)
        self.assertIn('1 offen', text)

    def test_nicht_gemergtes_paket_ist_offen(self):
        leer = pathlib.Path(self.tmp.name) / 'leer'
        leer.mkdir()
        git(leer, 'init', '-q', '-b', 'main')
        git(leer, 'commit', '-q', '--allow-empty', '-m', 'nur die Wurzel')
        aus = io.StringIO()
        with contextlib.redirect_stdout(aus):
            code = pruefe_tor.main(['G0', '--wurzel', str(leer), '--laeufe', str(self.b.laeufe)])
        self.assertEqual(1, code)
        self.assertIn('[offen] IP-3', aus.getvalue())
        self.assertIn('PR 963', aus.getvalue())

    # -- rote und leere Berichte --------------------------------------------

    def test_roter_surefire_bericht_ist_offen(self):
        klasse = NACHWEIS_KLASSEN['V0']
        self.b.surefire(klasse, SUREFIRE_ROT.format(name=klasse))
        code, text = self.b.fahre('G0')
        self.assertEqual(1, code)
        self.assertIn('[offen] V0', text)
        self.assertIn('ROT (2 von 7)', text)

    def test_uebersprungener_lauf_ist_nicht_gruen(self):
        klasse = NACHWEIS_KLASSEN['V0']
        self.b.surefire(klasse, SUREFIRE_UEBERSPRUNGEN.format(name=klasse))
        code, text = self.b.fahre('G0')
        self.assertEqual(1, code)
        self.assertIn('uebersprungen ist nicht gruen', text)

    def test_bericht_von_einem_anderen_stand_ist_offen(self):
        (self.b.laeufe / 'stand.txt').write_text('0123456789abcdef', encoding='utf-8')
        code, text = self.b.fahre('G0')
        self.assertEqual(1, code)
        self.assertIn('stammt laut stand.txt von 0123456789abcdef', text)

    def test_bericht_aelter_als_der_stand_ist_offen(self):
        (self.b.laeufe / 'stand.txt').unlink()
        alt = time.time() - 86_400 * 30
        for klasse in NACHWEIS_KLASSEN.values():
            os.utime(self.b.laeufe / f'TEST-{klasse}.xml', (alt, alt))
        code, text = self.b.fahre('G0')
        self.assertEqual(1, code)
        self.assertIn('AELTER', text)

    # -- Bestandsblatt -------------------------------------------------------

    def test_blatt_aelter_als_sieben_tage_ist_offen(self):
        alt = time.time() - 86_400 * 9
        os.utime(self.b.blatt, (alt, alt))
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] M-1a', text)
        self.assertIn('9 Tage alt', text)
        self.assertIn('juenger als 7 Tage', text)

    def test_ohne_blatt_ist_m1_offen_und_nennt_den_betreiber(self):
        aus = io.StringIO()
        with contextlib.redirect_stdout(aus):
            code = pruefe_tor.main(['G1', '--wurzel', str(self.b.wurzel), '--laeufe', str(self.b.laeufe),
                                    '--stand', str(self.b.stand), '--generalprobe', str(self.b.probe)])
        self.assertEqual(1, code)
        self.assertIn('kein --blatt <datei>', aus.getvalue())
        self.assertIn('(Betreiber)', aus.getvalue())

    # -- Generalprobe --------------------------------------------------------

    def test_wegwerf_generalprobe_ist_kein_produktions_beleg(self):
        self.b.probe_json(dict(PROBE_GUT, A={'migrationen': 65, 'summe_ms': 143, 'startbudget_reicht': 1}))
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-1', text)
        self.assertIn('kein Produktions-Beleg', text)
        self.assertIn('143 ms', text)

    def test_z08_auffaellig_ist_offen(self):
        kaputt = json.loads(json.dumps(PROBE_GUT))
        kaputt['W1']['Z08']['geloescht_markiert'] = 18
        self.b.probe_json(kaputt)
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('W1.Z08 ist auffaellig', text)
        self.assertIn('geloescht_markiert=18', text)

    def test_nicht_vorlegbarer_exit_code_ist_offen(self):
        self.b.probe_json(dict(PROBE_GUT, exit_code=26))
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('exit_code 26', text)

    def test_exit_21_bleibt_vorlegbar_nennt_aber_den_pruefauftrag(self):
        self.b.probe_json(dict(PROBE_GUT, exit_code=21))
        code, text = self.b.fahre('G1')
        self.assertEqual(0, code, text)
        self.assertIn('Pruefauftrag an den Betreiber offen', text)

    def test_rueckweg_ohne_bytegleichen_flyway_stand_ist_offen(self):
        (self.b.probe / 'rueckweg.json').write_text(json.dumps(dict(RUECKWEG_GUT, Q01_stimmt=0)), encoding='utf-8')
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-8', text)

    # -- NW-3 ----------------------------------------------------------------

    def test_nicht_gefahrener_nw3_punkt_ist_offen(self):
        protokoll = json.loads(json.dumps(NW3_GRUEN))
        protokoll['punkte'][3] = {'punkt': '4 samples 2.0 im writer', 'urteil': 'nicht_gefahren'}
        protokoll['zusammenfassung'] = '6 gruen, 1 nicht gefahren'
        self.b.nw3(protokoll)
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-3', text)
        self.assertIn('4 samples 2.0 im writer', text)

    def test_ga_ohne_neues_image_ist_offen(self):
        (self.b.wurzel / 'docs/rollout/nw3-protokoll-edge-2026.10.1.json').unlink()
        code, text = self.b.fahre('GA')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-3neu', text)
        self.assertIn('Edge-Release A ist nicht gebaut', text)

    def test_ga_ohne_update_pfad_ist_offen(self):
        # Generalprobe B2: NW-3/NW-3neu pruefen eine frische Box, den Update-Pfad nur dieser Punkt.
        (self.b.laeufe / f'TEST-{NACHWEIS_KLASSEN["NW-3u"]}.xml').unlink()
        code, text = self.b.fahre('GA')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-3u', text)
        self.assertIn('MessplanNachBoxUpdateApiTest', text)

    def test_aus_dem_tag_gebautes_paar_wird_benannt(self):
        protokoll = json.loads(json.dumps(NW3_GRUEN))
        protokoll['paar']['herkunft'] = 'aus dem Release-Tag gebaut, NICHT das Release-Artefakt'
        self.b.nw3(protokoll)
        code, text = self.b.fahre('G1')
        # Das Protokoll bleibt ein Beleg - aber das Werkzeug sagt dem Betreiber, was er vor sich hat.
        self.assertEqual(0, code, text)
        self.assertIn('AUS DEM TAG GEBAUT', text)

    # -- Stand-Blatt des Betreibers -----------------------------------------

    def test_fehlender_punkt_im_stand_blatt_ist_offen(self):
        punkte = {p: ('ja', '2026-09-20') for p in STAND_PUNKTE if p != 'nw6_alarmuebung'}
        self.b.stand_schreiben(punkte)
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-6', text)
        self.assertIn('fehlt der Punkt "nw6_alarmuebung"', text)

    def test_bestaetigung_ohne_datum_ist_offen(self):
        self.b.stand.write_text('nw6_alarmuebung:\n  bestaetigt: ja\n', encoding='utf-8')
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('nennt aber kein Datum', text)

    def test_stand_blatt_kann_einen_maschinellen_punkt_nicht_gruen_machen(self):
        (self.b.laeufe / f'TEST-{NACHWEIS_KLASSEN["NW-4"]}.xml').unlink()
        punkte = {p: ('ja', '2026-09-20') for p in STAND_PUNKTE}
        punkte['nw4_messkundenlauf'] = ('ja', '2026-09-20')
        punkte['NW-4'] = ('ja', '2026-09-20')
        self.b.stand_schreiben(punkte)
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-4', text)

    def test_r1_standortzaun_ist_ein_testbeleg_kein_betreiberwort(self):
        # Entscheid A vom 21.09.2026: das Urteil haelt RechtMatrixApiTest fest, nicht das Stand-Blatt.
        _, text = self.b.fahre('G1')
        self.assertIn('[belegt] R1', text)
        self.assertIn(f'TEST-{NACHWEIS_KLASSEN["R1"]}.xml', text)
        (self.b.laeufe / f'TEST-{NACHWEIS_KLASSEN["R1"]}.xml').unlink()
        punkte = {p: ('ja', '2026-09-20') for p in STAND_PUNKTE}
        punkte['standortzaun_geraet'] = ('ja', '2026-09-21')
        self.b.stand_schreiben(punkte)
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] R1', text)
        self.assertIn('1 offen', text)

    def test_nw6_im_kleinen_ist_ein_testbeleg_die_uebung_bleibt_betreiberpunkt(self):
        # IP-18-Einrichtung: der Lauf belegt die Strecke bis zur Alarm-Kennzahl, nicht die Zustellung in Produktion.
        _, text = self.b.fahre('G1')
        self.assertIn('[belegt] NW-6k', text)
        self.assertIn(f'TEST-{NACHWEIS_KLASSEN["NW-6k"]}.xml', text)
        (self.b.laeufe / f'TEST-{NACHWEIS_KLASSEN["NW-6k"]}.xml').unlink()
        self.b.stand_schreiben({p: ('ja', '2026-09-20') for p in STAND_PUNKTE})
        code, text = self.b.fahre('G1')
        self.assertEqual(1, code)
        self.assertIn('[offen] NW-6k', text)
        self.assertIn('[nicht maschinell pruefbar] NW-6 ', text)
        self.assertIn('1 offen', text)

    def test_kaputtes_stand_blatt_bricht_ab_statt_zu_raten(self):
        self.b.stand.write_text('nw6_alarmuebung\n   bestaetigt ja\n', encoding='utf-8')
        fehler = io.StringIO()
        with contextlib.redirect_stderr(fehler):
            code = pruefe_tor.main(['G1', '--wurzel', str(self.b.wurzel), '--stand', str(self.b.stand)])
        self.assertEqual(2, code)
        self.assertIn('Stand-Blatt nicht lesbar', fehler.getvalue())

    def test_beispieldatei_im_repo_ist_lesbar_und_haelt_alles_offen(self):
        beispiel = pathlib.Path(__file__).resolve().parent / 'freigabe-stand.example.yaml'
        stand = pruefe_tor.lies_stand(beispiel)
        self.assertEqual(sorted(STAND_PUNKTE), sorted(stand))
        for name, eintrag in stand.items():
            self.assertEqual('nein', eintrag['bestaetigt'], name)
            self.assertTrue(eintrag['beleg'], name)

    # -- Aufruf --------------------------------------------------------------

    def test_unbekanntes_tor_zeigt_die_hilfe(self):
        fehler = io.StringIO()
        with contextlib.redirect_stderr(fehler):
            code = pruefe_tor.main(['G7'])
        self.assertEqual(2, code)
        self.assertIn('G0, G1, GA oder GB', fehler.getvalue())

    def test_hilfe_ist_kein_fehler(self):
        aus = io.StringIO()
        with contextlib.redirect_stdout(aus):
            code = pruefe_tor.main(['--help'])
        self.assertEqual(0, code)

    def test_das_werkzeug_oeffnet_kein_tor(self):
        _, text = self.b.fahre('G0')
        self.assertIn('Das Werkzeug oeffnet kein Tor', text)


if __name__ == '__main__':
    unittest.main()
