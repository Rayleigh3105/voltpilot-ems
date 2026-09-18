#!/usr/bin/env python3
"""Operator-only rehearsal. Untrusted SQL/log/metric text never reaches output."""
import argparse
import csv
import fnmatch
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
LABEL = 'org.voltpilot.generalprobe.copy'
IMAGE = 'timescale/timescaledb:2.17.2-pg16'
RUNNERS = ('bestand_standort', 'bestand_funktion', 'bestand_rechte')
MESSAGES = {
    10: 'Kopie-Schalter fehlt; Start verweigert.',
    11: 'Kopie-Nachweis oder Sperrliste fehlt/ungueltig; Start verweigert.',
    12: 'Ziel gesperrt oder nicht eindeutig als isolierte Kopie ausgewiesen.',
    13: 'Voraussetzung fehlt oder Werkzeug fehlgeschlagen; keine Rohdaten ausgegeben.',
    14: 'Probe unterbrochen; eigene gestartete API/Datenbank werden entfernt, Kopie-Volumes bleiben erhalten.',
    20: 'Migration gescheitert; Rollout-Satz pruefen.',
    21: 'Z03: eingerichtete Anlagen vorhanden; Betreiber muss Z03 gegen bekannten Steuerbestand pruefen.',
    22: 'Z05: Kundenbereiche ohne Stichtag; Betreiber muss Z05 erklaeren.',
    23: 'API oder Bestands-Laeufer nicht vollstaendig bereit; Probe unvollstaendig.',
    24: 'Startbudget von 180 Sekunden reicht nicht.',
    25: 'W1 UNGEPROBT: altes API-Image fehlt lokal.',
    30: 'Wiederherstellung gescheitert.',
    31: 'Rueckweg-Gegenprobe abweichend: Flyway-Stand oder Q01.',
}


class Refusal(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code=11):
    if not condition:
        raise Refusal(code)


def command(args, data=None, timeout=120, check=True, env=None):
    # Neither stderr nor exception arguments are printed (also on failures).
    p = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=timeout, env=env)
    if check and p.returncode:
        raise Refusal(13)
    return p


def docker(*args, **kwargs):
    return command(['docker', *args], **kwargs)


def private_json(path, value):
    # Refuse overwrite/symlink; no accidental replacement of an operator file.
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def read_private(path):
    require(Path(path).is_file() and not Path(path).is_symlink())
    require(Path(path).stat().st_mode & 0o077 == 0)
    return json.loads(Path(path).read_text())


def guard(args):
    require(args.ich_bin_eine_kopie, 10)
    require(args.policy and args.credentials and args.volume)
    policy = json.loads(Path(args.policy).read_text())
    creds = read_private(args.credentials)
    require(set(creds) == {'database', 'postgres_user', 'postgres_password',
                           'app_user', 'app_password', 'admin_user', 'admin_password'})
    require(all(isinstance(v, str) and v and '\n' not in v and '\r' not in v for v in creds.values()))
    for key in ('database', 'postgres_user', 'app_user', 'admin_user'):
        require(re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', creds[key]))
    require(args.volume.startswith('vp-generalprobe-'), 12)
    require(re.fullmatch(r'[a-zA-Z0-9_.-]+', args.volume), 12)
    require(policy.get('copy_volume') == args.volume and policy.get('copy_database') == creds['database'], 12)
    # Both daemon and target are checked; no remote Docker endpoint is accepted.
    context = json.loads(docker('context', 'inspect').stdout)[0]
    endpoint = os.environ.get('DOCKER_HOST', context['Endpoints']['docker']['Host'])
    require(endpoint.startswith('unix://') and context['Endpoints']['docker']['Host'].startswith('unix://'), 12)
    info = json.loads(docker('info', '--format', '{{json .}}').stdout)
    hosts = [socket.gethostname(), info['Name'], 'copy-db']
    for field, values in [('deny_hosts', hosts), ('deny_databases', [creds['database']]),
                          ('deny_volumes', [args.volume])]:
        patterns = policy.get(field)
        require(isinstance(patterns, list) and patterns and all(isinstance(x, str) and x.strip() for x in patterns))
        require(not any(fnmatch.fnmatchcase(v.lower(), p.lower()) for v in values for p in patterns), 12)
    volume = json.loads(docker('volume', 'inspect', args.volume).stdout)[0]
    require((volume.get('Labels') or {}).get(LABEL) == 'true', 12)
    # Mounted volumes (including stopped containers) and remote/bind volume drivers are refused.
    require(volume['Driver'] == 'local' and not volume.get('Options'), 12)
    require(not docker('ps', '-aq', '--filter', 'volume=' + args.volume).stdout.strip(), 12)
    return creds


def numeric(value):
    require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0, 13)
    return value


def sheet_queries(filename, prefix):
    text = (ROOT / 'tools/betriebsabfragen' / filename).read_text()
    groups = re.split(r'-- (' + prefix + r'\d\d) ·', text)[1:]
    result = {}
    for key, block in zip(groups[::2], groups[1::2]):
        sql = re.sub(r'--[^\n]*', '', block.partition('\n')[2])
        # The source sheets have no semicolons inside string literals.
        result[key] = [s.strip() for s in sql.split(';') if re.match(r'\s*(SELECT|WITH)\b', s)]
    return result


class LogFacts:
    """Bounded streaming classification; never persist container logs."""
    def __init__(self):
        self.flyway = self.schema = self.failed = self.repairs = 0
        self.summaries = {}
        self.migrations_done = False

    def feed(self, line):
        if re.search(r'Successfully applied \d+ migration|Schema .* is up to date\. No migration necessary', line):
            self.migrations_done = True
        if ('Flyway' in line or 'Migration ' in line) and re.search(r'(?i)exception|failed|error', line):
            self.flyway = 1
        if re.search(r'(?i)(column|relation).*does not exist', line):
            self.schema = 1
        if 'Running repair()' in line:
            self.repairs += 1
        if 'APPLICATION FAILED TO START' in line:
            self.failed = 1
        patterns = {
            'bestand_standort': r'UEMS-Bestandsübernahme: (\d+) Kundenbereich\(e\) betrachtet, (\d+) Standort\(e\) angelegt, (\d+) Zuordnung\(en\), (\d+) Vorschlag/Vorschläge, (\d+) Fehler',
            'bestand_funktion': r'UEMS-Umstieg der Funktionen: (\d+) Kundenbereich\(e\) betrachtet, (\d+) Funktion\(en\) angelegt, (\d+) nachgezogen, (\d+) Teilnahme\(n\) aktiv, (\d+) eingerichtet, (\d+) Fehler',
            'bestand_rechte': r'UEMS-Bestandsübernahme der Zugriffe: (\d+) Kundenbereich\(e\), (\d+) Konto/Konten, (\d+) Spiegel neu, (\d+) Kundenadministrator\(en\) zugewiesen, (\d+) Bestand/Bestände abgeschlossen, (\d+) Fehler',
        }
        for runner, pattern in patterns.items():
            m = re.search(pattern, line)
            if m:
                self.summaries[runner] = [int(x) for x in m.groups()]


def runner_counts(scrape, facts):
    result = {}
    for runner in RUNNERS:
        values = {}
        completed = False
        for line in scrape.splitlines():
            m = re.fullmatch(r'(voltpilot_uems_bestandslaeufer_total|voltpilot_uems_laeufer_zustand)\{([^}]*)\}\s+([0-9.eE+-]+)', line)
            if not m:
                continue
            labels = dict(re.findall(r'(\w+)="([^"\\]*)"', m[2]))
            if labels.get('laeufer') != runner:
                continue
            if m[1].endswith('_zustand') and labels.get('zustand') == 'gelaufen' and float(m[3]) == 1:
                completed = True
            if m[1].endswith('_total') and labels.get('ergebnis') in ('erledigt', 'fehler'):
                n = float(m[3])
                require(n >= 0 and n.is_integer(), 13)
                values[labels['ergebnis']] = int(n)
        if set(values) == {'erledigt', 'fehler'}:
            result[runner] = dict(values, metrik=1, abgeschlossen=int(completed))
        elif not values and runner in facts.summaries:
            nums = facts.summaries[runner]
            # Aggregate log counts are different semantics; never call them "erledigt".
            result[runner] = {'betrachtet': nums[0], 'fehler': nums[-1], 'metrik': 0, 'abgeschlossen': 1}
        else:
            result[runner] = {'metrik': 0, 'abgeschlossen': 0}
    return result


class Copy:
    def __init__(self, args, creds):
        self.a, self.c = args, creds
        self.prefix = 'vp-generalprobe-' + secrets.token_hex(6)
        self.net = self.prefix + '-net'
        self.db = self.prefix + '-db'
        self.api = None
        self.process = None
        self.reader = None
        self.created = []
        self.network_created = False
        self.keycloak_connected = False

    def start(self):
        docker('network', 'create', '--internal', self.net)
        self.network_created = True
        self.created.append(self.db)
        docker('run', '-d', '--name', self.db, '--network', self.net, '--network-alias', 'copy-db',
               '--log-driver', 'none', '-v', self.a.volume + ':/var/lib/postgresql/data',
               self.a.db_image, 'postgres', '-c', 'archive_mode=off', '-c', 'listen_addresses=*',
               '-c', 'timescaledb.max_background_workers=0', '-c', 'logging_collector=off',
               '-c', 'log_statement=none')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if docker('exec', self.db, 'pg_isready', '-U', self.c['postgres_user'], '-d', self.c['database'], check=False).returncode == 0:
                break
            time.sleep(1)
        else:
            raise Refusal(13)
        require(self.sql("SELECT (rolsuper OR rolbypassrls)::int FROM pg_roles WHERE rolname=current_user")[0][0] == '1', 12)
        if self.a.keycloak_container:
            name = self.a.keycloak_container
            obj = json.loads(docker('inspect', name).stdout)[0]
            require((obj['Config'].get('Labels') or {}).get(LABEL) == 'true', 12)
            require(not obj['HostConfig'].get('PortBindings'), 12)
            for net in obj['NetworkSettings']['Networks']:
                require(json.loads(docker('network', 'inspect', net).stdout)[0]['Internal'], 12)
            docker('network', 'connect', '--alias', 'copy-keycloak', self.net, name)
            self.keycloak_connected = True

    def sql(self, sql):
        p = docker('exec', '-i', '-e', 'PGPASSWORD', self.db, 'psql', '-X', '-q', '--csv', '-t', '-v', 'ON_ERROR_STOP=1',
                   '-U', self.c['postgres_user'], '-d', self.c['database'], data=sql, timeout=130, env=dict(os.environ, PGPASSWORD=self.c['postgres_password']))
        return list(csv.reader(io.StringIO(p.stdout)))

    def query(self, sql):
        rows = self.sql("BEGIN READ ONLY; SET LOCAL row_security=off; SET LOCAL statement_timeout='120s'; "
                        "SET LOCAL lock_timeout='2s'; SELECT coalesce(json_agg(x), '[]'::json) FROM (" + sql + ") x; COMMIT;")
        return json.loads(rows[0][0])

    def snapshot(self):
        rows = self.query('SELECT * FROM flyway_schema_history ORDER BY installed_rank')
        q01 = self.query(sheet_queries('bestand-vor-uems.sql', 'Q')['Q01'][0])
        digest = lambda x: hashlib.sha256(json.dumps(x, sort_keys=True).encode()).hexdigest()
        return {'history_sha256': digest(rows), 'q01_sha256': digest(q01),
                'rank': max((r['installed_rank'] for r in rows), default=0), 'angewandt': q01[0]['angewandt']}

    def start_api(self, image):
        require(docker('image', 'inspect', image, check=False).returncode == 0, 13)
        self.api = self.prefix + '-api-' + secrets.token_hex(3)
        c = self.c
        url = 'jdbc:postgresql://copy-db:5432/' + c['database']
        # Do not pass through arbitrary Spring/JDBC/Java environment from the host.
        env = {
            'SPRING_DATASOURCE_URL': url, 'SPRING_FLYWAY_URL': url,
            'POSTGRES_JDBC_URL': url, 'VOLTPILOT_ADMIN_DATASOURCE_URL': url,
            'POSTGRES_USER': c['postgres_user'], 'POSTGRES_PASSWORD': c['postgres_password'],
            'APP_DB_USER': c['app_user'], 'APP_DB_PASSWORD': c['app_password'],
            'ADMIN_DB_USER': c['admin_user'], 'ADMIN_DB_PASSWORD': c['admin_password'],
            'KEYCLOAK_ADMIN_BASE_URL': 'http://copy-keycloak:8080',
            'KEYCLOAK_API_CLIENT_SECRET': os.environ.get('GENERALPROBE_KEYCLOAK_SECRET', ''),
            'OIDC_JWK_SET_URI': 'http://copy-keycloak:8080/realms/voltpilot/protocol/openid-connect/certs',
            'API_PORT': '8090', 'JAVA_TOOL_OPTIONS': '-Xms128m -Xmx768m',
        }
        args = ['docker', 'run', '--name', self.api, '--network', self.net, '--network-alias', 'copy-api',
                '--log-driver', 'none', '--memory', '1g']
        for key in env:
            args.extend(['-e', key])  # Values travel only in environment, never argv/log files.
        args.append(image)
        self.facts = LogFacts()
        self.process = subprocess.Popen(args, env=dict(os.environ, **env), stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True)
        self.created.append(self.api)
        def consume():
            for line in self.process.stdout:
                self.facts.feed(line)
        self.reader = threading.Thread(target=consume, daemon=True)
        self.reader.start()

    def http(self, path):
        return docker('exec', self.db, 'wget', '-q', '-T', '3', '-O', '-', 'http://copy-api:8090/' + path,
                      check=False, timeout=10)

    def wait_api(self, runners=False):
        started = time.monotonic()
        ready = False
        readiness_ms = None
        counts = runner_counts('', self.facts)
        while time.monotonic() - started < self.a.timeout:
            if self.process.poll() is not None:
                break
            response = self.http('health/readiness')
            if response.returncode == 0:
                ready = True
                if readiness_ms is None:
                    readiness_ms = round((time.monotonic() - started) * 1000)
                if not runners:
                    break
                counts = runner_counts(self.http('metrics').stdout, self.facts)
                if all(v['abgeschlossen'] for v in counts.values()):
                    break
            time.sleep(1)
        return ready, counts, readiness_ms, round((time.monotonic() - started) * 1000)

    def stop_api(self):
        if self.api:
            docker('rm', '-f', self.api, check=False)
            self.created.remove(self.api)
            self.api = None
            self.process.wait(timeout=20)
            self.reader.join(timeout=5)

    def close(self):
        for name in reversed(self.created):
            docker('rm', '-f', name, check=False)
        if self.keycloak_connected:
            docker('network', 'disconnect', self.net, self.a.keycloak_container, check=False)
        if self.network_created:
            docker('network', 'rm', self.net, check=False)


def after_sheet(db):
    raw = {k: [db.query(q) for q in queries] for k, queries in sheet_queries('bestand-nach-rollout.sql', 'Z').items()}
    report = {}
    # A schema change fails closed rather than exporting an unknown field.
    columns = {
        'Z01': ('angewandt', 'fehlgeschlagen'),
        'Z04': ('mit_standort_ohne_teilnahme', 'ohne_standort', 'anlagen'),
        'Z05': ('kundenbereiche', 'stichtag_bestandslauf', 'stichtag_neu', 'ohne_stichtag', 'konten_uebernommen'),
        'Z07': ('arbeit_viertelstunde_offen', 'arbeit_tag_offen', 'arbeit_periode_offen'),
    }
    for key, cols in columns.items():
        report[key] = {col: numeric(raw[key][0][0][col]) if raw[key][0][0][col] is not None else None for col in cols}
    report['Z02'] = {'checks': len(raw['Z02'][0]),
                     'rolle_gesetzt': sum(int(r['traegt_rolle_gesetzt']) for r in raw['Z02'][0]),
                     'rolle_entzogen': sum(int(r['traegt_rolle_entzogen']) for r in raw['Z02'][0])}
    report['Z06'] = {k: int(raw['Z06'][0][0][k]) for k in ('registry_schluessel_je_box', 'offene_perioden_ohne_box')}
    report['Z03'] = {'standorte': {}, 'anlagen': {}}
    for r in raw['Z03'][0]:
        require(r['funktion'] in ('messen', 'steuern') and r['zustand_am_standort'] in ('entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert'), 13)
        report['Z03']['standorte'][r['funktion'] + '_' + r['zustand_am_standort']] = numeric(r['standorte'])
    for r in raw['Z03'][1]:
        require(r['zustand_der_anlage'] in ('entwurf', 'eingerichtet', 'aktiv', 'angehalten', 'archiviert') and isinstance(r['uebernommen'], bool), 13)
        report['Z03']['anlagen'][r['zustand_der_anlage'] + ('_uebernommen' if r['uebernommen'] else '_nicht_uebernommen')] = numeric(r['anlagen'])
    return report


LOCK_SQL = """SELECT coalesce(max(extract(epoch FROM clock_timestamp()-l.waitstart)*1000),0) AS ms
FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
WHERE NOT l.granted AND l.waitstart IS NOT NULL AND a.datname=current_database()
AND (l.relation='public.device_measurement_sample'::regclass OR l.relation IN
 (SELECT format('%I.%I',chunk_schema,chunk_name)::regclass FROM timescaledb_information.chunks
  WHERE hypertable_schema='public' AND hypertable_name='device_measurement_sample'))"""


def probe(db, a, report):
    before = db.snapshot()
    require(a.state and not Path(a.state).exists())
    private_json(a.state, before)
    stop = threading.Event()
    observation = {'stichproben': 0, 'fehler': 0, 'laengste_beobachtete_sperrwartezeit_ms': 0}
    def sample():
        while not stop.is_set():
            if getattr(db, 'facts', None) is not None and db.facts.migrations_done:
                break
            try:
                ms = float(db.query(LOCK_SQL)[0]['ms'])
                observation['stichproben'] += 1
                observation['laengste_beobachtete_sperrwartezeit_ms'] = max(ms, observation['laengste_beobachtete_sperrwartezeit_ms'])
            except (Refusal, subprocess.SubprocessError, ValueError):
                observation['fehler'] += 1
            stop.wait(0.25)
    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    try:
        db.start_api(a.new_image)
        ready, counts, startup, runners_ms = db.wait_api(runners=True)
    finally:
        stop.set()
        thread.join(timeout=140)
    durations = db.query('SELECT execution_time AS ms, success FROM flyway_schema_history WHERE installed_rank > ' + str(before['rank']) + ' ORDER BY installed_rank')
    ms = [numeric(row['ms']) for row in durations]
    report['A'] = {'migrationen': len(ms), 'je_migration_ms': ms, 'summe_ms': sum(ms),
                   'zehn_laengste_ms': sorted(ms, reverse=True)[:10],
                   'wartungsfenster_ms': max(1800000, 3 * sum(ms)),
                   'start_ms': startup, 'laeufer_abwarten_ms': runners_ms, 'startbudget_ms': 180000,
                   'startbudget_reicht': int(ready and startup <= 180000 and sum(ms) <= 180000),
                   'sperren': observation, 'flyway_reparaturen': db.facts.repairs}
    observation['migrationsende_erkannt'] = int(db.facts.migrations_done)
    report['B'] = counts
    migration_failed = (not ready and db.facts.flyway) or any(not r['success'] for r in durations)
    if migration_failed:
        raise Refusal(20)
    if not ready:
        raise Refusal(23)
    report['C'] = after_sheet(db)
    incomplete = any(not v['abgeschlossen'] or v.get('fehler', 0) for v in counts.values())
    db.stop_api()
    report['W1'] = {'versuche': 0, 'ungeprobt': 1}
    if docker('image', 'inspect', a.old_image, check=False).returncode == 0:
        before_old = db.snapshot()
        db.start_api(a.old_image)
        old_ready, _, old_ms, old_wait_ms = db.wait_api()
        if old_ready:
            time.sleep(5)
        report['W1'] = {'versuche': 1, 'ungeprobt': 0, 'bereit': int(old_ready), 'start_ms': old_ms, 'beobachtet_ms': old_wait_ms + (5000 if old_ready else 0),
                         'flyway_diagnose': db.facts.flyway, 'flyway_reparaturen': db.facts.repairs,
                         'fehlerklasse_flyway_stelle_initialisierung': int(not old_ready and db.facts.flyway),
                         'fehlerklasse_schema_stelle_sql_abfrage': db.facts.schema,
                         'fehlerklasse_start_stelle_unbestimmt': int(not old_ready and not db.facts.flyway and not db.facts.schema)}
        db.stop_api()
        report['W1']['flyway_historie_veraendert'] = int(db.snapshot()['history_sha256'] != before_old['history_sha256'])
    report['pruefen_Z03'] = sum(v for k, v in report['C']['Z03']['anlagen'].items() if k.startswith('eingerichtet_'))
    report['pruefen_Z05'] = report['C']['Z05']['ohne_stichtag']
    review(report, incomplete or not observation['stichproben'] or bool(observation['fehler']) or not observation['migrationsende_erkannt'])


def review(report, incomplete):
    if report['pruefen_Z03']:
        raise Refusal(21)
    if report['pruefen_Z05']:
        raise Refusal(22)
    if incomplete:
        raise Refusal(23)
    if not report['A']['startbudget_reicht']:
        raise Refusal(24)
    if report['W1']['ungeprobt']:
        raise Refusal(25)


def restore(a, creds, report):
    require(a.state and a.backup and a.target_time)
    before = read_private(a.state)
    require(re.fullmatch(r'\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)', a.target_time))
    require(a.from_backup == 'latest' or re.fullmatch(r'\d{8}T\d{6}Z', a.from_backup))
    # Destination must already be a specifically labelled, unused, empty COPY volume.
    started = time.monotonic()
    p = command(['bash', str(ROOT / 'tools/backup/vp-db-restore.sh'), '--backup', a.backup,
                 '--dest-volume', a.volume, '--from', a.from_backup, '--target-time', a.target_time,
                 '--pg-user', creds['postgres_user'], '--image', a.db_image, '--yes'], timeout=4000, check=False)
    report['wiederherstellung_ms'] = round((time.monotonic() - started) * 1000)
    require(p.returncode == 0, 30)
    db = Copy(a, creds)
    try:
        db.start()
        after = db.snapshot()
        report['flyway_stimmt'] = int(before['history_sha256'] == after['history_sha256'])
        report['Q01_stimmt'] = int(before['q01_sha256'] == after['q01_sha256'])
        report['angewandt'] = after['angewandt']
        require(report['flyway_stimmt'] and report['Q01_stimmt'], 31)
    finally:
        db.close()


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        print(MESSAGES[11], file=sys.stderr)
        raise SystemExit(11)


def main():
    os.umask(0o077)
    def interrupted(signum, frame):
        raise Refusal(14)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    p = SafeParser(description='Nur isolierte, wiederhergestellte Kopien; siehe README.md.')
    p.add_argument('mode', choices=['probe', 'rueckweg'])
    p.add_argument('--ich-bin-eine-kopie', action='store_true')
    for name in ('policy', 'credentials', 'volume', 'output', 'state', 'new-image', 'old-image', 'backup', 'target-time', 'keycloak-container'):
        p.add_argument('--' + name)
    p.add_argument('--db-image', default=IMAGE)
    p.add_argument('--from-backup', default='latest')
    p.add_argument('--timeout', type=int, default=900)
    a = p.parse_args()
    report = {'format': 1}
    code = 0
    try:
        creds = guard(a)
        require(a.db_image and not a.db_image.startswith('-'))
        require(a.output and not Path(a.output).exists() and 1 <= a.timeout <= 3600)
        if a.mode == 'probe':
            require(a.new_image and a.old_image and a.new_image != a.old_image)
            require(not a.new_image.startswith('-') and not a.old_image.startswith('-'))
            require(docker('image', 'inspect', a.new_image, check=False).returncode == 0, 13)
            db = Copy(a, creds)
            try:
                db.start()
                probe(db, a, report)
            finally:
                db.close()
        else:
            restore(a, creds, report)
    except Refusal as e:
        code = e.code
    except Exception:  # Fail closed; exceptions may contain credentials or customer data.
        code = 13
    report['exit_code'] = code
    if a.output and not Path(a.output).exists():
        try:
            private_json(a.output, report)
        except OSError:
            code = 13
    if 'A' in report:
        print('Startbudget 180 Sekunden reicht.' if report['A']['startbudget_reicht'] else
              'Startbudget 180 Sekunden reicht nicht oder Bereitschaft ist unbelegt.', file=sys.stderr)
    if code:
        print(MESSAGES[code], file=sys.stderr)
    else:
        print('Pruefung abgeschlossen; Ausgabe enthaelt nur Zaehler und Dauern.')
    return code


if __name__ == '__main__':
    sys.exit(main())
