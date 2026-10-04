#!/usr/bin/env python3
"""Baut prototyp.html aus quelle/ und den Schriften des Portal-Designsystems.

Aufruf: python3 docs/konzepte/preise-und-wetter/build.py [ZIEL_FRAGMENT]
Mit ZIEL_FRAGMENT entsteht zusätzlich eine Fassung ohne Dokumentrahmen
(ohne doctype, html, head und body), etwa zum Veröffentlichen als Seite.
Die Vergleichsbilder liegen in quelle/bilder/ (JPEG); fehlt eines, bleibt die
Stelle leer und das Skript sagt es.
"""
import base64
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE.parents[2] / 'frontend' / 'portal' / 'designsystem' / 'assets'
SRC = HERE / 'quelle'


def b64(path):
    return base64.b64encode(path.read_bytes()).decode('ascii')


def bild(match):
    path = SRC / 'bilder' / f'{match.group(1)}.jpg'
    if not path.exists():
        print('fehlt:', path.relative_to(HERE))
        return ''
    return b64(path)


style = ((SRC / 'style.css').read_text(encoding='utf-8')
         .replace('/*FONT_PJS*/', b64(ASSETS / 'fonts' / 'plus-jakarta-sans-latin.woff2'))
         .replace('/*FONT_INTER*/', b64(ASSETS / 'fonts' / 'inter-latin.woff2')))
body = re.sub(r'/\*IMG:([a-z-]+)\*/', bild, (SRC / 'body.html').read_text(encoding='utf-8'))
js = (SRC / 'daten.js').read_text(encoding='utf-8') + '\n' + (SRC / 'app.js').read_text(encoding='utf-8')
title = '<title>Preise und Wetter</title>\n'
inner_head = title + '<style>\n' + style + '\n</style>\n'
inner_body = body + '\n<script>\n' + js + '\n</script>\n'

full = ('<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + inner_head + '</head>\n<body>\n' + inner_body + '</body>\n</html>\n')
(HERE / 'prototyp.html').write_text(full, encoding='utf-8')
print('prototyp.html', len(full.encode('utf-8')), 'Bytes')

if len(sys.argv) > 1:
    target = pathlib.Path(sys.argv[1])
    target.write_text(inner_head + inner_body, encoding='utf-8')
    print(target, 'geschrieben')
