"""Laufzeit je @Scheduled-Job aus zwei /metrics-Abzuegen (tasks_scheduled_execution_seconds_{count,sum,max}).
Aufruf: python3 -I sched.py results/<label>"""
import re, sys, collections
d = sys.argv[1]
def lese(f):
    m = collections.defaultdict(dict)
    for line in open(f, encoding="utf-8", errors="replace"):
        r = re.match(r'tasks_scheduled_execution_seconds_(count|sum|max)\{([^}]*)\}\s+(\S+)', line)
        if not r:
            continue
        lab = dict(re.findall(r'(\w+)="([^"]*)"', r.group(2)))
        key = (lab.get("code_namespace", lab.get("code.namespace", "")).split(".")[-1] + "." + lab.get("code_function", lab.get("code.function", "")), lab.get("outcome", ""))
        m[key][r.group(1)] = float(r.group(3))
    return m
a, b = lese(f"{d}/metrics-start.txt"), lese(f"{d}/metrics-end.txt")
rows = []
for k, v in b.items():
    n = v.get("count", 0) - a.get(k, {}).get("count", 0)
    s = v.get("sum", 0) - a.get(k, {}).get("sum", 0)
    if n > 0:
        rows.append((s, n, k))
for s, n, k in sorted(rows, reverse=True)[:25]:
    print(f"{k[0]:<55} {k[1]:<8} Laeufe {int(n):>4}  Summe {s:8.2f} s  Mittel {s/n:7.3f} s")
