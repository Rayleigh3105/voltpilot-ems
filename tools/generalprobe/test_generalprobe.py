"""No Docker needed. The separate fixture exercises the real database/API/restore."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('generalprobe', HERE / 'generalprobe.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class Guards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.policy = json.loads((HERE / 'policy.example.json').read_text())
        self.creds = dict(database='voltpilot', postgres_user='voltpilot', postgres_password='SECRET',
                          app_user='voltpilot_app', app_password='SECRET',
                          admin_user='voltpilot_admin', admin_password='SECRET')
        self.a = argparse.Namespace(ich_bin_eine_kopie=True, policy=str(self.root / 'policy'),
                                    credentials=str(self.root / 'creds'), volume='vp-generalprobe-kopie')
        g.private_json(self.a.credentials, self.creds)
        self.save_policy()
        self.remote = False
        self.mounted = False
        self.label = True
        self.options = None

    def save_policy(self):
        Path(self.a.policy).write_text(json.dumps(self.policy))

    def docker(self, *args, **kwargs):
        if args[:2] == ('context', 'inspect'):
            result = [{'Endpoints': {'docker': {'Host': 'tcp://remote:2375' if self.remote else 'unix:///tmp/docker.sock'}}}]
        elif args[0] == 'info':
            result = {'Name': 'test-host'}
        elif args[0] == 'volume':
            result = [{'Labels': {g.LABEL: 'true'} if self.label else {}, 'Driver': 'local', 'Options': self.options}]
        elif args[0] == 'ps':
            return subprocess.CompletedProcess(args, 0, 'container' if self.mounted else '', '')
        else:
            self.fail('unexpected Docker call')
        return subprocess.CompletedProcess(args, 0, json.dumps(result), '')

    def guard(self):
        with patch.object(g, 'docker', self.docker), patch.dict(os.environ, {}, clear=True):
            return g.guard(self.a)

    def refused(self, code):
        with self.assertRaises(g.Refusal) as raised:
            self.guard()
        self.assertEqual(code, raised.exception.code)

    def test_no_copy_switch_before_docker(self):
        self.a.ich_bin_eine_kopie = False
        with patch.object(g, 'docker') as docker:
            self.refused(10)
            docker.assert_not_called()

    def test_valid_copy(self):
        self.assertEqual(self.creds, self.guard())

    def test_denied_host_database_volume(self):
        for field, denied in [('deny_hosts', 'test-*'), ('deny_databases', 'voltpilot'), ('deny_volumes', 'vp-*')]:
            with self.subTest(field=field):
                before = self.policy[field]
                self.policy[field] = [denied]
                self.save_policy()
                self.refused(12)
                self.policy[field] = before

    def test_incomplete_policy(self):
        self.policy['deny_hosts'] = []
        self.save_policy()
        self.refused(11)

    def test_remote_daemon(self):
        self.remote = True
        self.refused(12)

    def test_volume_already_mounted(self):
        self.mounted = True
        self.refused(12)

    def test_volume_unlabelled(self):
        self.label = False
        self.refused(12)

    def test_bind_volume(self):
        self.options = {'device': '/production'}
        self.refused(12)

    def test_world_readable_credentials(self):
        os.chmod(self.a.credentials, 0o644)
        self.refused(11)

    def test_target_not_allowlisted(self):
        self.policy['copy_database'] = 'another'
        self.save_policy()
        self.refused(12)

    def test_wrapper_refusal_file_has_no_input(self):
        out = self.root / 'out'
        p = subprocess.run([str(HERE / 'probe.sh'), '--volume', 'SECRET-customer-123', '--output', str(out)],
                           capture_output=True, text=True)
        self.assertEqual(10, p.returncode)
        self.assertEqual({'format': 1, 'exit_code': 10}, json.loads(out.read_text()))
        self.assertNotIn('SECRET', p.stderr + p.stdout + out.read_text())

    def test_report_never_overwrites(self):
        with self.assertRaises(FileExistsError):
            g.private_json(self.a.credentials, {'replace': 1})
        self.assertEqual(self.creds, json.loads(Path(self.a.credentials).read_text()))


class Results(unittest.TestCase):
    def test_metrics_preferred_and_completed_required(self):
        facts = g.LogFacts()
        facts.summaries['bestand_standort'] = [999, 1, 1, 1, 888]
        scrape = '\n'.join([
            'voltpilot_uems_bestandslaeufer_total{laeufer="bestand_standort",ergebnis="erledigt"} 2.0',
            'voltpilot_uems_bestandslaeufer_total{ergebnis="fehler",laeufer="bestand_standort"} 0',
            'voltpilot_uems_kundenbereich_messwert_zustand{tenant="CUSTOMER-SECRET"} 1'])
        r = g.runner_counts(scrape, facts)
        self.assertEqual({'erledigt': 2, 'fehler': 0, 'metrik': 1, 'abgeschlossen': 0}, r['bestand_standort'])
        scrape += '\nvoltpilot_uems_laeufer_zustand{laeufer="bestand_standort",zustand="gelaufen"} 1'
        self.assertEqual(1, g.runner_counts(scrape, facts)['bestand_standort']['abgeschlossen'])
        self.assertNotIn('SECRET', json.dumps(r))

    def test_log_fallback_only_aggregate(self):
        facts = g.LogFacts()
        facts.feed('UEMS-Bestandsübernahme: Kundenbereich SECRET — Standort SECRET angelegt')
        self.assertFalse(facts.summaries)
        facts.feed('UEMS-Bestandsübernahme: 4 Kundenbereich(e) betrachtet, 3 Standort(e) angelegt, 3 Zuordnung(en), 0 Vorschlag/Vorschläge, 1 Fehler')
        self.assertEqual({'betrachtet': 4, 'fehler': 1, 'metrik': 0, 'abgeschlossen': 1},
                         g.runner_counts('', facts)['bestand_standort'])
        self.assertNotIn('SECRET', json.dumps(vars(facts)))

    def test_unknown_is_not_zero(self):
        self.assertEqual({'metrik': 0, 'abgeschlossen': 0}, g.runner_counts('', g.LogFacts())['bestand_rechte'])

    def test_sampling_stops_at_flyway_completion_not_runner_completion(self):
        facts = g.LogFacts()
        facts.feed('Successfully validated 235 migrations')
        self.assertFalse(facts.migrations_done)
        facts.feed('Successfully applied 67 migrations to schema "public"')
        self.assertTrue(facts.migrations_done)
        facts = g.LogFacts()
        facts.feed('Schema "public" is up to date. No migration necessary.')
        self.assertTrue(facts.migrations_done)

    def test_error_classification_drops_data(self):
        facts = g.LogFacts()
        facts.feed('org.flywaydb.core.FlywayException: customer SECRET failed password=PRIVATE')
        facts.feed('ERROR: column "CUSTOMER_NAME" does not exist')
        self.assertEqual(1, facts.flyway)
        self.assertEqual(1, facts.schema)
        self.assertNotIn('SECRET', json.dumps(vars(facts)))
        self.assertNotIn('PRIVATE', json.dumps(vars(facts)))

    def test_actual_sheets_extracted(self):
        sheets = g.sheet_queries('bestand-nach-rollout.sql', 'Z')
        self.assertEqual({'Z01', 'Z02', 'Z03', 'Z04', 'Z05', 'Z06', 'Z07'}, set(sheets))
        self.assertEqual(9, sum(map(len, sheets.values())))
        self.assertEqual(1, len(g.sheet_queries('bestand-vor-uems.sql', 'Q')['Q01']))

    def test_sheet_export_drops_names_and_versions_from_generated_file(self):
        raw = [
            [{'angewandt': 235, 'fehlgeschlagen': 0, 'hoechste_version': 20269999000000}],
            [{'description': 'CUSTOMER_SECRET', 'version': 'SECRET_VERSION', 'millisekunden': 2}],
            [{'conname': 'SECRET_CONSTRAINT', 'traegt_rolle_gesetzt': True, 'traegt_rolle_entzogen': True}],
            [{'funktion': 'steuern', 'zustand_am_standort': 'eingerichtet', 'standorte': 1}],
            [{'zustand_der_anlage': 'eingerichtet', 'uebernommen': True, 'anlagen': 1}],
            [{'mit_standort_ohne_teilnahme': 0, 'ohne_standort': 0, 'anlagen': 1}],
            [{'kundenbereiche': 1, 'stichtag_bestandslauf': 0, 'stichtag_neu': 0, 'ohne_stichtag': 1, 'konten_uebernommen': None}],
            [{'registry_schluessel_je_box': True, 'offene_perioden_ohne_box': 0}],
            [{'arbeit_viertelstunde_offen': 0, 'arbeit_tag_offen': 0, 'arbeit_periode_offen': 0}],
        ]
        from unittest.mock import Mock
        db = Mock()
        db.query.side_effect = raw
        result = g.after_sheet(db)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'report.json'
            g.private_json(output, result)
            text = output.read_text()
            self.assertNotIn('SECRET', text)
            self.assertNotIn('20269999000000', text)
            self.assertEqual(1, json.loads(text)['Z03']['anlagen']['eingerichtet_uebernommen'])

    def test_writer_template_does_not_execute_rpk_or_expand_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / 'rpk'
            fake.write_text('#!/bin/sh\nexit 99\n')
            fake.chmod(0o755)
            env = dict(os.environ, PATH=tmp + ':' + os.environ['PATH'], RPK_CONFIG='SECRET_CONFIG',
                       WRITER_REPLAY_EPOCH_MS='SECRET_TIMESTAMP')
            result = subprocess.run([str(HERE / 'writer-ruecksetzen-dry-run.sh')], env=env,
                                    capture_output=True, text=True, check=True)
            self.assertNotIn('SECRET', result.stdout)
            self.assertIn('${WRITER_REPLAY_EPOCH_MS:?}', result.stdout)
            self.assertIn('telemetry.raw,telemetry-v2.raw,measurements.raw,events.raw', result.stdout)

    def test_operator_review_codes_and_all_counts_survive(self):
        report = {'pruefen_Z03': 2, 'pruefen_Z05': 3, 'A': {'startbudget_reicht': 1}, 'W1': {'ungeprobt': 0}}
        with self.assertRaises(g.Refusal) as raised:
            g.review(report, False)
        self.assertEqual(21, raised.exception.code)
        self.assertEqual(3, report['pruefen_Z05'])
        report['pruefen_Z03'] = 0
        with self.assertRaises(g.Refusal) as raised:
            g.review(report, False)
        self.assertEqual(22, raised.exception.code)
        report['pruefen_Z05'] = 0
        g.review(report, False)
        for code, incomplete, budget, untested in [(23, True, 1, 0), (24, False, 0, 0), (25, False, 1, 1)]:
            report['A']['startbudget_reicht'] = budget
            report['W1']['ungeprobt'] = untested
            with self.assertRaises(g.Refusal) as raised:
                g.review(report, incomplete)
            self.assertEqual(code, raised.exception.code)

    def test_restore_calls_existing_tool_with_exact_point_and_compares_both(self):
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'state'
            before = {'history_sha256': 'aaa', 'q01_sha256': 'bbb', 'angewandt': 168}
            g.private_json(state, before)
            a = argparse.Namespace(state=str(state), backup='copy-backup', target_time='2026-09-18 20:00:00+00',
                                   from_backup='20260918T190000Z', volume='vp-generalprobe-return', db_image=g.IMAGE)
            db = Mock()
            db.snapshot.return_value = before
            with patch.object(g, 'Copy', return_value=db), patch.object(g, 'command') as command:
                command.return_value.returncode = 0
                report = {}
                g.restore(a, {'postgres_user': 'voltpilot'}, report)
                self.assertEqual(1, report['flyway_stimmt'])
                self.assertEqual(1, report['Q01_stimmt'])
                args = command.call_args.args[0]
                self.assertEqual(str(g.ROOT / 'tools/backup/vp-db-restore.sh'), args[1])
                self.assertEqual(a.target_time, args[args.index('--target-time') + 1])
                db.snapshot.return_value = dict(before, q01_sha256='different')
                with self.assertRaises(g.Refusal) as raised:
                    g.restore(a, {'postgres_user': 'voltpilot'}, {})
                self.assertEqual(31, raised.exception.code)
                self.assertEqual(2, db.close.call_count)

    def test_negative_or_nonfinite_counts_rejected(self):
        for value in (-1, float('inf'), float('nan'), 'CUSTOMER-SECRET', True):
            with self.assertRaises(g.Refusal):
                g.numeric(value)


if __name__ == '__main__':
    unittest.main()
