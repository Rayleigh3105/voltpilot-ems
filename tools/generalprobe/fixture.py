#!/usr/bin/env python3
"""Synthetic, disposable physical backup/PITR and full API rehearsal proof."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import threading
import zipfile

import generalprobe as g


def assert_numeric_tree(value):
    if isinstance(value, dict):
        for key, child in value.items():
            assert re.fullmatch(r'[A-Za-z0-9_]+', key), key
            assert_numeric_tree(child)
    elif isinstance(value, list):
        for child in value:
            assert_numeric_tree(child)
    else:
        assert value is None or (type(value) in (int, float) and value >= 0), value


def window():
    # One large run in this lane; reserve TWO slots for API + database.
    deadline = time.monotonic() + 1800
    while True:
        count = len(g.docker('ps', '-q').stdout.split())
        memory = subprocess.run(['memory_pressure'], capture_output=True, text=True, check=True).stdout
        free = int(re.search(r'System-wide memory free percentage: (\d+)%', memory)[1])
        if count == 0 and free >= 35:
            return
        if time.monotonic() > deadline:
            raise RuntimeError('container/memory window did not open')
        time.sleep(20)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--new-jar', type=Path, required=True)
    p.add_argument('--old-jar', type=Path, required=True)
    p.add_argument('--artifacts', type=Path, required=True)
    a = p.parse_args()
    os.umask(0o077)
    a.artifacts.mkdir(mode=0o700)
    prefix = 'vp-generalprobe-fixture-' + str(os.getpid())
    db = prefix + '-db'
    volumes = []
    containers = []
    images = []
    net = prefix + '-net'
    policy = json.loads((g.ROOT / 'tools/generalprobe/policy.example.json').read_text())
    creds = dict(database='voltpilot', postgres_user='voltpilot', postgres_password='fixture_password',
                 app_user='voltpilot_app', app_password='fixture_app_password',
                 admin_user='voltpilot_admin', admin_password='fixture_admin_password')
    g.private_json(a.artifacts / 'credentials.json', creds)
    def sql(statement):
        return g.docker('exec', '-i', db, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'voltpilot',
                        '-d', 'voltpilot', data=statement).stdout.strip()
    def volume(suffix):
        name = prefix + '-' + suffix
        g.docker('volume', 'create', '--label', g.LABEL + '=true', name)
        volumes.append(name)
        return name
    try:
        with tempfile.TemporaryDirectory(prefix='vp-ip11-fixture-') as tmp:
            tmp = Path(tmp)
            for kind, jar in [('new', a.new_jar), ('old', a.old_jar)]:
                ctx = tmp / kind
                ctx.mkdir()
                shutil.copyfile(jar, ctx / 'app.jar')
                (ctx / 'Dockerfile').write_text('FROM eclipse-temurin:21-jre\nCOPY app.jar /app.jar\nENTRYPOINT ["java","-jar","/app.jar"]\n')
                image = prefix + '-' + kind
                g.docker('build', '-q', '-t', image, str(ctx), timeout=600)
                images.append(image)
            ctx = tmp / 'db'
            ctx.mkdir()
            shutil.copyfile(g.ROOT / 'infra/prod/backup/archive-wal.sh', ctx / 'archive-wal.sh')
            (ctx / 'Dockerfile').write_text('FROM ' + g.IMAGE + '\nCOPY --chmod=755 archive-wal.sh /usr/local/bin/vp-archive-wal.sh\n')
            db_image = prefix + '-db-image'
            g.docker('build', '-q', '-t', db_image, str(ctx), timeout=300)
            images.append(db_image)
            migrations = tmp / 'main'
            migrations.mkdir()
            names = [n for n in (g.ROOT / 'services/api/src/test/resources/migration/main-migrations.txt').read_text().splitlines() if n and not n.startswith('#')]
            for name in names:
                shutil.copyfile(g.ROOT / 'services/api/src/main/resources/db/migration' / name, migrations / name)
            libs = tmp / 'libs'
            libs.mkdir()
            with zipfile.ZipFile(a.new_jar) as jar:
                for member in jar.namelist():
                    if member.startswith('BOOT-INF/lib/') and member.endswith('.jar'):
                        (libs / Path(member).name).write_bytes(jar.read(member))
            window()
            print('Containerfenster offen; physischer main-Kopie/API/PITR-Lauf startet.', flush=True)
            g.docker('network', 'create', net)
            backup, data = volume('backup'), volume('source')
            g.docker('run', '-d', '--name', db, '--network', net, '--log-driver', 'none',
                     '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=voltpilot', '-e', 'POSTGRES_DB=voltpilot',
                     '-e', 'POSTGRES_PASSWORD=fixture_password', '-v', data + ':/var/lib/postgresql/data',
                     '-v', backup + ':/backup', db_image, 'postgres', '-c', 'archive_mode=on',
                     '-c', 'archive_command=/usr/local/bin/vp-archive-wal.sh %p %f',
                     '-c', 'timescaledb.max_background_workers=0')
            containers.append(db)
            for _ in range(90):
                if g.docker('exec', db, 'pg_isready', '-U', 'voltpilot', check=False).returncode == 0:
                    break
                time.sleep(1)
            port = g.docker('port', db, '5432').stdout.strip().rsplit(':', 1)[1]
            env = dict(os.environ, FIXTURE_JDBC='jdbc:postgresql://127.0.0.1:' + port + '/voltpilot',
                       FIXTURE_MIGRATIONS=str(migrations))
            result = subprocess.run([str(Path(os.environ['JAVA_HOME']) / 'bin/java'), '-cp', str(libs / '*'),
                                     str(g.ROOT / 'tools/generalprobe/FixtureMigrate.java')],
                                    env=env, capture_output=True, text=True, timeout=300)
            (a.artifacts / 'fixture-migrations.log').write_text(result.stdout + result.stderr)
            assert result.returncode == 0, 'main migrations failed (synthetic fixture log)'
            assert int(sql('SELECT count(*) FROM flyway_schema_history WHERE success;')) == len(names)
            # Nonempty legacy tenant/site: probes must surface Z03/Z05 without identities.
            sql("INSERT INTO tenant(id,name) VALUES ('12345678-1234-1234-1234-123456789abc','CUSTOMER_SECRET_9a52'); INSERT INTO site(tenant_id,name) VALUES ('12345678-1234-1234-1234-123456789abc','SITE_SECRET_9a52'); INSERT INTO unternehmen(tenant_id,name,zeitzone) SELECT id,name,'Europe/Berlin' FROM tenant;")
            # Exercise the lock sampler with a real blocked relation lock before the backup.
            blocker = threading.Thread(target=lambda: sql("BEGIN; LOCK TABLE device_measurement_sample IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); COMMIT;"))
            blocker.start()
            time.sleep(0.4)
            waiter = threading.Thread(target=lambda: sql('SELECT count(*) FROM device_measurement_sample;'))
            waiter.start()
            time.sleep(0.6)
            lock_ms = float(sql(g.LOCK_SQL + ';'))
            blocker.join()
            waiter.join()
            assert lock_ms >= 200, 'lock sampler must observe a real wait'
            g.private_json(a.artifacts / 'sperrmessung.json', {'beobachtete_sperrwartezeit_ms': lock_ms})
            sql("CREATE TABLE generalprobe_canary(secret text); INSERT INTO generalprobe_canary VALUES ('CUSTOMER_SECRET_9a52');")
            g.docker('exec', '-u', 'root', db, 'install', '-d', '-o', 'postgres', '-g', 'postgres', '/backup/base', '/backup/wal')
            g.command(['bash', str(g.ROOT / 'tools/backup/vp-db-backup.sh'), '--container', db,
                       '--skip-keycloak', '--no-prune'], timeout=600)
            from_backup = g.docker('exec', db, 'sh', '-c', 'ls /backup/base').stdout.strip().splitlines()[-1]
            time.sleep(1)
            target = sql('SELECT clock_timestamp();')
            time.sleep(1)
            sql("INSERT INTO generalprobe_canary VALUES ('AFTER_RECOVERY_POINT');")
            segment = sql('SELECT pg_walfile_name(pg_switch_wal());')
            for _ in range(60):
                if g.docker('exec', db, 'test', '-s', '/backup/wal/' + segment + '.gz', check=False).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise AssertionError('WAL not archived')
            g.docker('rm', '-f', db)
            containers.remove(db)
            copy = volume('copy')
            # First restoration is real too; this is the input to probe.sh.
            g.command(['bash', str(g.ROOT / 'tools/backup/vp-db-restore.sh'), '--backup', backup,
                       '--dest-volume', copy, '--from', from_backup, '--target-time', target, '--yes'], timeout=600)
            policy['copy_volume'] = copy
            g.private_json(a.artifacts / 'policy.json', policy)
            common = ['--ich-bin-eine-kopie', '--credentials', str(a.artifacts / 'credentials.json'),
                      '--policy', str(a.artifacts / 'policy.json'), '--volume', copy,
                      '--state', str(a.artifacts / 'before-private.json')]
            run = g.command(['bash', str(g.ROOT / 'tools/generalprobe/probe.sh'), *common,
                             '--new-image', prefix + '-new', '--old-image', prefix + '-old',
                             '--timeout', '180', '--output', str(a.artifacts / 'probe.json')], timeout=600, check=False)
            (a.artifacts / 'probe-status.txt').write_text(run.stdout + run.stderr)
            print('Probe Exit ' + str(run.returncode), flush=True)
            assert run.returncode in (21, 22), 'expected operator review for nonempty fixture without Keycloak'
            report = json.loads((a.artifacts / 'probe.json').read_text())
            assert report['A']['migrationen'] > 0 and report['W1']['versuche'] == 1
            assert all(v['abgeschlossen'] == 1 and v['metrik'] == 1 for v in report['B'].values())
            assert report['pruefen_Z03'] == 1 and run.returncode == 21
            assert report['C']['Z05']['kundenbereiche'] == 1 and report['pruefen_Z05'] == 1
            assert report['B']['bestand_standort']['erledigt'] == 1
            assert report['B']['bestand_funktion']['erledigt'] == 1
            restored = volume('return')
            policy['copy_volume'] = restored
            g.private_json(a.artifacts / 'return-policy.json', policy)
            run = g.command(['bash', str(g.ROOT / 'tools/generalprobe/rueckweg.sh'), '--ich-bin-eine-kopie',
                             '--credentials', str(a.artifacts / 'credentials.json'), '--policy', str(a.artifacts / 'return-policy.json'),
                             '--volume', restored, '--state', str(a.artifacts / 'before-private.json'),
                             '--backup', backup, '--from-backup', from_backup, '--target-time', target,
                             '--output', str(a.artifacts / 'rueckweg.json')], timeout=600, check=False)
            (a.artifacts / 'rueckweg-status.txt').write_text(run.stdout + run.stderr)
            assert run.returncode == 0, 'return failed'
            for name in ['probe.json', 'rueckweg.json']:
                text = (a.artifacts / name).read_text()
                assert_numeric_tree(json.loads(text))
                for secret in ['CUSTOMER_SECRET', 'SITE_SECRET', '12345678-1234', 'fixture_password', 'voltpilot_app', prefix]:
                    assert secret not in text
            print('PASS: main migration set -> physical PITR copy -> new API -> old API -> physical PITR return; numeric outputs only; expected Z03/Z05 review.', flush=True)
    finally:
        for name in containers:
            g.docker('rm', '-f', name, check=False)
        for name in volumes:
            g.docker('volume', 'rm', name, check=False)
        g.docker('network', 'rm', net, check=False)
        for image in images:
            g.docker('rmi', image, check=False)


if __name__ == '__main__':
    main()
