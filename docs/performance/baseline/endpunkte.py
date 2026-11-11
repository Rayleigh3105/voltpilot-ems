#!/usr/bin/env python3
"""p50/p95 der Zeit bis zum ersten Byte je Endpunkt, durch den Labor-nginx (gzip), warm.
Usage: endpunkte.py <user> <site> <standort|-> <runs> <label> [endpunkt ...]
Schreibt <label>.json (alle Einzelwerte) ins aktuelle Verzeichnis und druckt eine Markdown-Tabelle."""
import json, os, subprocess, sys, time, statistics
from datetime import datetime
from zoneinfo import ZoneInfo
user, site, standort, runs, label = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
only = set(sys.argv[6:])
P = os.environ.get('VP_PERF_PORTS', '157')
BASE = f'http://localhost:{P}44'
KC = f'http://localhost:{P}42/auth/realms/voltpilot/protocol/openid-connect/token'
env = dict(os.environ, LC_ALL='C')
def token():
    out = subprocess.run(['curl', '-s', '-X', 'POST', KC, '-d', f'grant_type=password&client_id=voltpilot-frontend&username={user}&password={user}'],
                         capture_output=True, text=True, env=env).stdout
    return json.loads(out)['access_token']
today = datetime.now(ZoneInfo('Europe/Berlin')).date().isoformat()
S = f'/api/v1/sites/{site}'
EPS = [
  ('me', '/api/v1/me'), ('sites', '/api/v1/sites'), ('devices', '/api/v1/devices'), ('tenant-context', '/api/v1/tenant-context'),
  ('standorte', '/api/v1/standorte'), ('unternehmen', '/api/v1/unternehmen'), ('funktionen', '/api/v1/funktionen'),
  ('overview', '/api/v1/overview'), ('portfolio-kpis', '/api/v1/portfolio/kpis'),
  ('topology', f'{S}/topology'), ('schedule', f'{S}/schedule'), ('history-day', f'{S}/history?range=day&at={today}'),
  ('earnings-day', f'{S}/earnings?range=day'), ('bilanz-tag', f'{S}/bilanz?periode=tag'),
  ('rollen-pv', f'{S}/rollen/pv'), ('profiles', f'{S}/profiles'), ('entities', f'{S}/entities'),
  ('cockpit-layout', f'{S}/cockpit-layout'), ('control-status', f'{S}/control-status'), ('sources', f'{S}/sources'),
  ('weather', f'{S}/weather'), ('history-year', f'{S}/history?range=year&at={today}'), ('earnings-year', f'{S}/earnings?range=year'),
]
if standort != '-':
    EPS.append(('standort-ausfall', f'/api/v1/standorte/{standort}/ausfall'))
if only:
    EPS = [e for e in EPS if e[0] in only]
tok, tok_at = token(), time.time()
def call(path):
    global tok, tok_at
    if time.time() - tok_at > 200:
        tok, tok_at = token(), time.time()
    out = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{time_starttransfer} %{size_download} %{http_code}',
                          '-H', f'Authorization: Bearer {tok}', '-H', 'Accept-Encoding: gzip', BASE + path],
                         capture_output=True, text=True, env=env).stdout.split()
    return float(out[0]) * 1000, int(out[1]), out[2]
def pct(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
load0 = os.getloadavg()[0]
res = {}
for name, path in EPS:
    call(path); call(path)  # warm-up
    ms, sz, code = [], 0, ''
    for _ in range(runs):
        t, sz, code = call(path); ms.append(t)
    res[name] = {'path': path, 'ms': ms, 'bytes_gz': sz, 'code': code}
load1 = os.getloadavg()[0]
json.dump({'label': label, 'user': user, 'runs': runs, 'load': [load0, load1], 'at': time.time(), 'results': res},
          open(f'{label}.json', 'w'), indent=1)
print(f'## {label} user={user} runs={runs} load={load0:.0f}->{load1:.0f}')
print('| Endpunkt | p50 ms | p95 ms | min | max | gz-Bytes | HTTP |')
print('|---|---:|---:|---:|---:|---:|---|')
for name, r in res.items():
    m = r['ms']
    print(f"| `{name}` | {pct(m, .5):.0f} | {pct(m, .95):.0f} | {min(m):.0f} | {max(m):.0f} | {r['bytes_gz']} | {r['code']} |")
