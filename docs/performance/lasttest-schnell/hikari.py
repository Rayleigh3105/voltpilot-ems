"""Hikari-Ausleihe je Pool zwischen zwei Abzuegen: python3 -I hikari.py results/<label>"""
import re, sys, collections
d = sys.argv[1]
def lese(f):
    m = collections.defaultdict(dict)
    for line in open(f):
        r = re.match(r'hikaricp_connections_acquire_seconds_(count|sum|max)\{.*pool="([^"]+)".*\}\s+(\S+)', line)
        if r:
            m[r.group(2)][r.group(1)] = float(r.group(3))
    return m
a, b = lese(f"{d}/hikari-start.txt"), lese(f"{d}/hikari-end.txt")
mx = collections.defaultdict(float)
for line in open(f"{d}/pending.txt"):
    for pool, v in re.findall(r'hikaricp_connections_pending\{[^}]*pool="([^"]+)"[^}]*\}\s+(\S+)', line):
        mx[pool] = max(mx[pool], float(v))
for pool in sorted(b):
    n = b[pool].get("count", 0) - a.get(pool, {}).get("count", 0)
    s = b[pool].get("sum", 0) - a.get(pool, {}).get("sum", 0)
    print(f"{pool:<36} Ausleihen {int(n):>7}  Mittel {1000*s/n if n else 0:8.2f} ms  max(Abzug) {1000*b[pool].get('max',0):8.1f} ms  wartend max {int(mx.get(pool,0))}")
