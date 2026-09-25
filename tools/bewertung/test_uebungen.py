#!/usr/bin/env python3
"""Übungen des Betreibers (AP-20 IP-19) - am Referenzfall RF-07, am echten `rueckweg.json` und an Gegenproben.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Braucht `jsonschema` (wie der Vertragstest der Matrix). Fehlt es, bricht der Lauf mit ImportError
ab - er wird nie übersprungen (NR2).
"""

import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import uebungen  # noqa: E402

HIER = pathlib.Path(__file__).resolve().parent
RF07 = HIER / 'fixtures' / 'uebungen' / 'rf07'
STAND_Q15 = RF07 / 'stand-q15.yaml'
REPO = uebungen.REPO


def lade(pfad):
    return json.loads(pathlib.Path(pfad).read_text(encoding='utf-8'))


def fahre(*argv):
    aus, err = io.StringIO(), io.StringIO()
    with redirect_stdout(aus), redirect_stderr(err):
        code = uebungen.main(list(argv))
    return code, aus.getvalue(), err.getvalue()


def rueckweg_vom_echten_schreiber(tmp, vorher, nachher, sekunden, rueckgabe=0):
    """`rueckweg.json`, geschrieben von tools/generalprobe/generalprobe.py selbst: main() → restore()
    → private_json(). Nur Docker, Datenbank und Uhr sind ersetzt - Felder, Format und Bytes sind die
    des echten Werkzeugs."""
    spec = importlib.util.spec_from_file_location('generalprobe', REPO / 'tools/generalprobe/generalprobe.py')
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    state, out = pathlib.Path(tmp) / 'state', pathlib.Path(tmp) / 'rueckweg.json'
    g.private_json(state, vorher)
    db = Mock()
    db.snapshot.return_value = nachher
    argv = ['generalprobe.py', 'rueckweg', '--ich-bin-eine-kopie', '--state', str(state),
            '--backup', '/srv/backup/voltpilot-db', '--target-time', '2026-10-05 06:00:00+00',
            '--volume', 'vp-generalprobe-rueckweg', '--output', str(out)]
    with patch.object(sys, 'argv', argv), patch.object(g, 'guard', return_value={'postgres_user': 'voltpilot'}), \
            patch.object(g, 'Copy', return_value=db), patch.object(g, 'command') as command, \
            patch.object(g.time, 'monotonic', side_effect=[1000.0, 1000.0 + sekunden]), \
            redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        command.return_value.returncode = rueckgabe
        code = g.main()
    return code, out.read_bytes()


VORHER = {'history_sha256': 'a' * 64, 'q01_sha256': 'b' * 64, 'angewandt': 251}


class EchtesFormatTest(unittest.TestCase):
    """Die Fixture ist, was das Werkzeug schreibt - nicht, was jemand dafür hält."""

    def test_fixture_ist_bytegleich_mit_dem_echten_schreiber(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, roh = rueckweg_vom_echten_schreiber(tmp, VORHER, VORHER, 1260)
        self.assertEqual(0, code)
        self.assertEqual(roh, (RF07 / 'U-2026-01' / 'rueckweg.json').read_bytes(),
                         'generalprobe.py schreibt rueckweg.json anders - Fixture und uebungen.aus_rueckweg nachziehen')

    def test_abweichende_gegenprobe_schreibt_exit_31_und_der_leser_sagt_fehlgeschlagen(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, roh = rueckweg_vom_echten_schreiber(tmp, VORHER, dict(VORHER, q01_sha256='c' * 64), 1260)
        bericht = json.loads(roh)
        self.assertEqual((31, 31), (code, bericht['exit_code']))
        self.assertEqual({'zustand': 'fehlgeschlagen',
                          'ergebnis': {'dauer_ms': 1260000, 'flyway_bytegleich': True, 'q01_zaehlungen_gleich': False}},
                         uebungen.aus_rueckweg(bericht))

    def test_gescheiterte_wiederherstellung_hat_nur_dauer_und_exit_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, roh = rueckweg_vom_echten_schreiber(tmp, VORHER, VORHER, 60, rueckgabe=1)
        bericht = json.loads(roh)
        self.assertEqual(30, code)
        self.assertEqual({'format', 'wiederherstellung_ms', 'exit_code'}, set(bericht))
        self.assertEqual('fehlgeschlagen', uebungen.aus_rueckweg(bericht)['zustand'])

    def test_leser_und_tor_pruefer_nw8_urteilen_gleich(self):
        ctx = type('Ctx', (), {'generalprobe': RF07 / 'U-2026-01'})()
        urteil, text = uebungen.pruefe_tor.nw8_rueckweg(ctx)
        self.assertEqual(uebungen.pruefe_tor.BELEGT, urteil)
        self.assertIn('Wiederherstellung 1260000 ms', text)
        self.assertEqual('durchgefuehrt', uebungen.aus_rueckweg(lade(RF07 / 'U-2026-01' / 'rueckweg.json'))['zustand'])


class RF07Test(unittest.TestCase):
    """RF-07: eine Wiederherstellungs-Übung mit festgehaltenem Ergebnis (report.md §7)."""

    def test_rf07_erwartetes_ergebnis(self):
        fehler, e = uebungen.bewerte(RF07 / 'U-2026-01.json', RF07, STAND_Q15)
        self.assertEqual([], fehler)
        self.assertEqual({'uebung_zustand': 'durchgefuehrt', 'dauer_min': 21, 'teil_wiederherstellung': 'belegt',
                          'q15': 'nicht_maschinell_pruefbar', 'naechste_faellig': '2027-04-05'},
                         {k: e[k] for k in ('uebung_zustand', 'dauer_min', 'teil_wiederherstellung', 'q15',
                                            'naechste_faellig')})

    def test_rf07_was_man_sieht(self):
        code, aus, _ = fahre('--heute', '2026-10-06', '--stand', str(STAND_Q15), str(RF07))
        self.assertEqual(0, code)
        self.assertIn('U-2026-01 · Wiederherstellung · 21 min · Zählungen gleich · 05.10.2026 · Betreiber · '
                      'nächste fällig 05.04.2027', aus)
        self.assertIn('nicht_maschinell_pruefbar: Q15 WAL-Archiv laeuft - Betreiber bestaetigt am 2026-10-05', aus)
        self.assertNotIn('Wiederherstellung: nächste Übung fällig seit', aus)

    def test_naechste_uebung_ist_beim_abruf_faellig_ohne_laeufer(self):
        code, aus, _ = fahre('--heute', '2027-04-06', str(RF07))
        self.assertEqual(0, code)
        self.assertIn('offen: Wiederherstellung: nächste Übung fällig seit 05.04.2027 (BT1; Betreiber)', aus)
        code, aus, _ = fahre('--heute', '2027-04-05', str(RF07))
        self.assertNotIn('fällig seit', aus)

    def test_ohne_stand_blatt_bleibt_q15_offen(self):
        _, e = uebungen.bewerte(RF07 / 'U-2026-01.json', RF07, None)
        self.assertEqual('offen', e['q15'])
        self.assertEqual('belegt', e['teil_wiederherstellung'], 'Q15 ist ein eigener Teil von Z-015')

    def test_q15_ohne_datum_ist_offen(self):
        with tempfile.TemporaryDirectory() as tmp:
            stand = pathlib.Path(tmp) / 'stand.yaml'
            stand.write_text('q15_wal_archiv:\n  bestaetigt: ja\n', encoding='utf-8')
            urteil, text = uebungen.q15(stand)
        self.assertEqual('offen', urteil)
        self.assertIn('nennt aber kein Datum', text)

    def test_monate_am_monatsende(self):
        self.assertEqual('2027-02-28', uebungen.plus_monate(uebungen.datetime.date(2026, 8, 31), 6).isoformat())
        self.assertEqual('2027-04-05', uebungen.plus_monate(uebungen.datetime.date(2026, 10, 5), 6).isoformat())


class GegenprobenTest(unittest.TestCase):
    """Rot, wenn das Artefakt die Übung nicht trägt (NR1)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ordner = pathlib.Path(self.tmp.name)
        shutil.copytree(RF07 / 'U-2026-01', self.ordner / 'U-2026-01')
        self.uebung = lade(RF07 / 'U-2026-01.json')

    def schreibe(self, uebung, name='U-2026-01.json'):
        (self.ordner / name).write_text(json.dumps(uebung, ensure_ascii=False), encoding='utf-8')

    def rot(self, erwartet, name='U-2026-01.json'):
        fehler, _ = uebungen.lies(self.ordner)
        self.assertTrue(any(erwartet in f for f in fehler), fehler)
        code, aus, _ = fahre(str(self.ordner))
        self.assertEqual(1, code)
        self.assertIn(f'rot: {name}: ', aus)

    def test_kopie_der_fixture_ist_gruen(self):
        self.schreibe(self.uebung)
        self.assertEqual([], uebungen.lies(self.ordner)[0])

    def test_fremde_pruefsumme_ist_rot(self):
        self.uebung['artefakt']['sha256'] = '0' * 64
        self.schreibe(self.uebung)
        self.rot('sha256 von U-2026-01/rueckweg.json stimmt nicht')

    def test_fehlendes_artefakt_ist_rot(self):
        (self.ordner / 'U-2026-01' / 'rueckweg.json').unlink()
        self.schreibe(self.uebung)
        self.rot('fehlt - ohne Artefakt kein Beleg (NR1)')

    def test_durchgefuehrt_behauptet_aber_rueckweg_sagt_31(self):
        bericht = lade(RF07 / 'U-2026-01' / 'rueckweg.json')
        bericht.update(exit_code=31, Q01_stimmt=0)
        roh = (json.dumps(bericht, indent=2, sort_keys=True) + '\n').encode()
        (self.ordner / 'U-2026-01' / 'rueckweg.json').write_bytes(roh)
        self.uebung['artefakt']['sha256'] = hashlib.sha256(roh).hexdigest()
        self.schreibe(self.uebung)
        self.rot('zustand: durchgefuehrt, aber rueckweg.json trägt fehlgeschlagen')
        self.rot('ergebnis.q01_zaehlungen_gleich: True, rueckweg.json sagt False')

    def test_fehlgeschlagene_uebung_steht_und_belegt_nichts(self):
        bericht = lade(RF07 / 'U-2026-01' / 'rueckweg.json')
        bericht.update(exit_code=31, Q01_stimmt=0)
        roh = (json.dumps(bericht, indent=2, sort_keys=True) + '\n').encode()
        (self.ordner / 'U-2026-01' / 'rueckweg.json').write_bytes(roh)
        self.uebung['artefakt']['sha256'] = hashlib.sha256(roh).hexdigest()
        self.uebung['zustand'] = 'fehlgeschlagen'
        self.uebung['ergebnis']['q01_zaehlungen_gleich'] = False
        self.schreibe(self.uebung)
        fehler, (e,) = uebungen.lies(self.ordner)
        self.assertEqual([], fehler)
        self.assertEqual('offen', e['teil_wiederherstellung'])
        self.assertNotIn('naechste_faellig', e)
        code, aus, _ = fahre('--heute', '2026-10-06', str(self.ordner))
        self.assertEqual(0, code)
        self.assertIn('fehlgeschlagen - belegt nichts', aus)
        self.assertIn('offen: Wiederherstellung: keine durchgeführte Übung - fällig vor dem Rollout', aus)

    def test_dateiname_und_kennzeichen_passen_zusammen(self):
        self.schreibe(self.uebung, 'U-2026-02.json')
        self.rot('kennzeichen U-2026-01 steht in der Datei U-2026-02.json', 'U-2026-02.json')

    def test_alarm_ohne_namen_ist_rot(self):
        alarm = lade(REPO / 'docs/bewertung/uebungen/vorlage-alarm.json')
        del alarm['alarm']
        self.assertTrue(any("'alarm' is a required property" in f for f in uebungen.formfehler(alarm)))


class VorlagenTest(unittest.TestCase):
    """Die Übungs-Vorlagen im Repo passen ausgefüllt zum Schema; der Ordner selbst ist lesbar."""

    AUSFUELLEN = {
        'U-JJJJ-nn': 'U-2026-02', 'JJJJ-MM-TT': '2026-10-06',
        '<wer die Übung gefahren hat>': 'Betreiber',
        '<durchgefuehrt oder fehlgeschlagen, so wie rueckweg.json es trägt>': 'durchgefuehrt',
        '<durchgefuehrt, wenn die Meldung beim Empfänger ankam, sonst fehlgeschlagen>': 'durchgefuehrt',
        '<wiederherstellung_ms aus rueckweg.json>': 1260000,
        '<flyway_stimmt aus rueckweg.json: true bei 1>': True,
        '<Q01_stimmt aus rueckweg.json: true bei 1>': True,
        '<JJJJ-MM-TTThh:mm:ssZ, Ankunft der Meldung>': '2026-10-06T10:12:00Z',
        '<JJJJ-MM-TTThh:mm:ssZ, Ankunft der Entwarnung>': '2026-10-06T10:31:00Z',
        '<Empfänger im Alertmanager>': 'betreiber',
    }

    def ausgefuellt(self, name):
        def fuellen(k):
            if isinstance(k, dict):
                return {s: fuellen(w) for s, w in k.items()}
            if isinstance(k, list):
                return [fuellen(w) for w in k]
            if isinstance(k, str):
                if k in self.AUSFUELLEN:
                    return self.AUSFUELLEN[k]
                k = k.replace('U-JJJJ-nn', 'U-2026-02')
                return ('0' * 64) if k.startswith('<shasum') else ('ausgefüllt' if k.startswith('<') else k)
            return k
        return fuellen(lade(REPO / 'docs/bewertung/uebungen' / name))

    def test_vorlagen_ausgefuellt_passen_zum_schema(self):
        for name in ('vorlage-wiederherstellung.json', 'vorlage-alarm.json'):
            with self.subTest(name):
                self.assertEqual([], uebungen.formfehler(self.ausgefuellt(name)))

    def test_vorlagen_selbst_sind_keine_uebung(self):
        for name in ('vorlage-wiederherstellung.json', 'vorlage-alarm.json'):
            self.assertTrue(uebungen.formfehler(lade(REPO / 'docs/bewertung/uebungen' / name)), name)

    def test_ordner_im_repo_ist_lesbar_und_nennt_was_fehlt(self):
        code, aus, _ = fahre('--heute', '2026-09-25')
        self.assertEqual(0, code, aus)
        self.assertIn('Übungen lesbar: 0', aus)
        self.assertIn('offen: Wiederherstellung: keine durchgeführte Übung - fällig vor dem Rollout '
                      '(BT2, Tor G1 NW-8; Betreiber)', aus)
        self.assertIn('offen: Alarm VoltPilotSicherungZuAlt nie ausgelöst - nicht geliefert (NR8', aus)

    def test_alarm_uebung_macht_den_alarm_geliefert(self):
        with tempfile.TemporaryDirectory() as tmp:
            ordner = pathlib.Path(tmp)
            (ordner / 'U-2026-02').mkdir()
            roh = b'[FIRING:2] VoltPilotSicherungZuAlt monitoring\n'
            (ordner / 'U-2026-02' / 'zustellung.txt').write_bytes(roh)
            alarm = self.ausgefuellt('vorlage-alarm.json')
            alarm['artefakt']['sha256'] = hashlib.sha256(roh).hexdigest()
            (ordner / 'U-2026-02.json').write_text(json.dumps(alarm, ensure_ascii=False), encoding='utf-8')
            code, aus, _ = fahre('--heute', '2026-10-06', str(ordner))
        self.assertEqual(0, code, aus)
        self.assertIn('U-2026-02 · Alarm VoltPilotSicherungZuAlt · zugestellt an betreiber · 06.10.2026 · Betreiber · '
                      'nächste fällig 06.04.2027', aus)
        self.assertNotIn('nie ausgelöst', aus)

    def test_aufruffehler_ist_exit_2(self):
        self.assertEqual(2, fahre('--heute', 'morgen')[0])
        self.assertEqual(2, fahre('--stand')[0])
        self.assertEqual(2, fahre('a', 'b')[0])


if __name__ == '__main__':
    unittest.main()
