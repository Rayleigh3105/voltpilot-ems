#!/usr/bin/env python3
"""Größen eines Portal-Builds (`vite build`-outDir). Usage: bundle.py <dist> [label]; schreibt <label>.json ins aktuelle Verzeichnis."""
import gzip, os, re, sys, json
d = sys.argv[1]; label = sys.argv[2] if len(sys.argv) > 2 else 'bundle'
files = []
for root, _, names in os.walk(d):
    for n in names:
        p = os.path.join(root, n); files.append((os.path.relpath(p, d), os.path.getsize(p)))
def gz(p):
    return len(gzip.compress(open(os.path.join(d, p), 'rb').read(), 9))
html = open(os.path.join(d, 'index.html')).read()
entry = re.search(r'src="/(assets/index-[^"]+\.js)"', html).group(1)
preloads = re.findall(r'rel="modulepreload"[^>]*href="/(assets/[^"]+)"', html)
css = re.findall(r'href="/(assets/[^"]+\.css)"', html)
js = sorted([f for f in files if f[0].endswith('.js')], key=lambda f: -f[1])
tot = sum(s for _, s in files)
initial = [entry] + preloads + css
out = {'label': label, 'total_bytes': tot, 'files': len(files), 'js_files': len(js),
       'css_files': len([f for f in files if f[0].endswith('.css')]),
       'entry': {'file': entry, 'raw': os.path.getsize(os.path.join(d, entry)), 'gz': gz(entry)},
       'initial_gz': sum(gz(p) for p in initial), 'initial_files': initial,
       'index_html': os.path.getsize(os.path.join(d, 'index.html')),
       'top_js': [{'file': f, 'raw': s, 'gz': gz(f)} for f, s in js[:8]]}
json.dump(out, open(f'{label}.json', 'w'), indent=1)
print(f"## {label}: dist {tot/1e6:.2f} MB, {len(files)} Dateien ({out['js_files']} JS, {out['css_files']} CSS), index.html {out['index_html']} B")
print(f"Einstieg {entry}: {out['entry']['raw']/1000:.1f} kB roh / {out['entry']['gz']/1000:.1f} kB gz (gzip -9)")
print(f"Erstladung (Einstieg + modulepreload + CSS, {len(initial)} Dateien): {out['initial_gz']/1000:.1f} kB gz")
print('| Chunk | roh kB | gz kB |'); print('|---|---:|---:|')
HASH = re.compile(r'-[A-Za-z0-9_-]{8}\.js$')
for t in out['top_js']:
    name = HASH.sub('.js', t['file'])
    print(f"| `{name}` | {t['raw']/1000:.1f} | {t['gz']/1000:.1f} |")
