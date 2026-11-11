"""Erzeugt die Vergleichsvektoren für src/qrCode.ts (src/qrCode.vektoren.json) mit `qrcode` (Python).

    python3 -m pip install --target /tmp/qr qrcode==8.2
    PYTHONPATH=/tmp/qr python3 scripts/qr-vektoren.py > src/qrCode.vektoren.json

Nicht segno: segno 1.6.6 hängt nach dem Abschluss ein Null-Byte an, wenn der Datenstrom schon auf
einer Bytegrenze endet (`write_padding_bits`), statt gleich mit 0xEC/0x11 aufzufüllen. Lesbar ist
beides, nach ISO/IEC 18004 Abschnitt 7.4.10 richtig ist nur das zweite.
"""
import json
import sys

import qrcode
from qrcode.util import MODE_8BIT_BYTE, QRData

STUFE = {'L': qrcode.constants.ERROR_CORRECT_L, 'M': qrcode.constants.ERROR_CORRECT_M}


def code(text, k, maske=None):
    q = qrcode.QRCode(error_correction=STUFE[k], border=0, mask_pattern=maske)
    q.add_data(QRData(text.encode('utf-8'), mode=MODE_8BIT_BYTE))
    q.make(fit=True)
    return q


def module(q):
    return [''.join('1' if b else '0' for b in reihe) for reihe in q.get_matrix()]


# Die Links, die auf ein Gehäuse kommen, und Fälle über die Fassungen 1 bis 9 (Byte-Modus).
TEXTE = [
    ('https://portal.voltpilot.de/k/edge-wrk7abg', 'M'),
    ('https://portal.voltpilot.de/k/edge-zay5sdd', 'M'),
    ('https://portal.voltpilot.de/k/edge-k7m2xq3', 'L'),
    ('edge-k7m2xq3', 'M'),
    ('A', 'M'),
    ('Werkstatt-Probe · Übergabe', 'M'),
    ('https://example.test', 'M'),
    ('x' * 60, 'M'),
    ('v' * 100, 'M'),
    ('w' * 115, 'M'),
    ('https://portal.voltpilot.de/#/werkstatt?box=edge-wrk7abg&schritt=probe&lang=de', 'M'),
    ('y' * 150, 'M'),
    ('z' * 200, 'L'),
]

faelle = []
for text, k in TEXTE:
    # Die Maske, die qrcode nach Strafpunkten wählt, und für den ersten Link jede der acht.
    # best_mask_pattern() baut zur Probe jede Maske und überschreibt dabei die Matrix: erst wählen,
    # dann mit der gewählten Maske neu bauen.
    masken = range(8) if text.endswith('wrk7abg') else [code(text, k).best_mask_pattern()]
    for m in masken:
        q = code(text, k, m)
        faelle.append({'text': text, 'korrektur': k, 'fassung': q.version, 'maske': m, 'module': module(q)})
json.dump({'quelle': 'qrcode 8.2, Byte-Modus; erzeugt mit frontend/portal/scripts/qr-vektoren.py',
           'faelle': faelle}, sys.stdout, ensure_ascii=False, indent=0)
sys.stdout.write('\n')
