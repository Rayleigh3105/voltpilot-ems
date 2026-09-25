#!/usr/bin/env python3
"""Klammer der Nachweis-Kandidaten (AP-20 IP-6, AP-20 NW-1).

Ein Kandidat ist kein Beleg (NR7) - aber er muss auf etwas zeigen, das es gibt. Die Klammer liest
jede Zusage der Matrix und verlangt von jedem Kandidaten, dass er heute existiert. Ob er grün ist,
sagt erst der Lauf am Stand (AP-20 IP-10) und der Matrix-Prüfer (AP-20 IP-4).

Ein Kandidat hat eine von drei Formen:

- `Klasse#methode`: eine Java-Testklasse unter `services/*/src/test/java`, genau einmal im Baum,
  mit `void methode(`.
- `pfad#Fall`: eine Testdatei im Repo mit ihrem Fall - `.py` mit `def Fall(`, `.go` mit
  `func Fall(`, `.ts`/`.tsx`/`.js` mit `it('Fall'` oder `test('Fall'` (Titel wörtlich).
- `pfad[:zeile] Bemerkung`: ein Artefakt, Werkzeug oder Dokument im Repo; die Zeile muss es geben.

Dazu gilt je Zusage: keine Zeile ohne Kandidat oder Lieferant; jede Plan-Abnahme trägt einen Fall
(`Klasse#methode` oder `pfad#Fall`); jede offene Betriebszusage nennt den Betreiber, der bestätigt;
kein Text wartet noch auf AP-20 IP-6.

    python3 tools/bewertung/klammer.py [matrix.json]

Exit 0: die Klammer hält. Exit 1: mindestens ein Verstoß, je Zeile einer. Exit 2: Aufruffehler.
"""

import functools
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from nachweismatrix import MATRIX_PFAD, REPO  # noqa: E402

JAVA_BAEUME = 'services/*/src/test/java'
KLASSE_METHODE = re.compile(r'([A-Z][A-Za-z0-9_]*)#([A-Za-z_][A-Za-z0-9_]*)')
DATEI_FALL = re.compile(r'([^\s#]+\.(?:py|go|ts|tsx|js))#(.+)')
PFAD = re.compile(r'([^\s:]+)(?::(\d+)(?:[–-](\d+))?)?(?:[,\s].*)?')
WARTET = re.compile(r'\bAP-20 IP-6\b')


@functools.lru_cache(maxsize=1)
def _java_klassen():
    klassen = {}
    for datei in sorted(REPO.glob(f'{JAVA_BAEUME}/**/*.java')):
        klassen.setdefault(datei.stem, []).append(datei)
    return klassen


@functools.lru_cache(maxsize=None)
def _text(datei):
    return datei.read_text(encoding='utf-8')


def _im_repo(pfad):
    datei = (REPO / pfad).resolve()
    return datei if datei.is_relative_to(REPO) and datei.exists() else None


def _fall_in_datei(datei, fall):
    text = _text(datei)
    if datei.suffix == '.py':
        return re.search(rf'^\s*def {re.escape(fall)}\(', text, re.M)
    if datei.suffix == '.go':
        return re.search(rf'^func {re.escape(fall)}\(', text, re.M)
    return re.search(r'\b(?:it|test)\(\s*([\'"`])' + re.escape(fall) + r'\1', text)


def art(kandidat):
    """`klasse_methode`, `datei_fall` oder `pfad` - nach der Form, nicht nach der Existenz."""
    if KLASSE_METHODE.fullmatch(kandidat):
        return 'klasse_methode'
    if DATEI_FALL.fullmatch(kandidat):
        return 'datei_fall'
    return 'pfad'


def pruefe_kandidat(kandidat, klassen):
    """Verstoß als Satz, oder None."""
    form = art(kandidat)
    if form == 'klasse_methode':
        klasse, methode = KLASSE_METHODE.fullmatch(kandidat).groups()
        dateien = klassen.get(klasse, [])
        if not dateien:
            return f'Klasse {klasse} steht in keinem Testbaum ({JAVA_BAEUME})'
        if len(dateien) > 1:
            return f'Klasse {klasse} ist mehrdeutig: ' + ', '.join(str(d.relative_to(REPO)) for d in dateien)
        if not re.search(rf'\bvoid {methode}\(', _text(dateien[0])):
            return f'Methode {methode} fehlt in {dateien[0].relative_to(REPO)}'
        return None
    if form == 'datei_fall':
        pfad, fall = DATEI_FALL.fullmatch(kandidat).groups()
        datei = _im_repo(pfad)
        if datei is None or not datei.is_file():
            return f'Testdatei {pfad} fehlt'
        if not _fall_in_datei(datei, fall):
            return f'Fall „{fall}“ fehlt in {pfad}'
        return None
    treffer = PFAD.fullmatch(kandidat)
    datei = _im_repo(treffer.group(1)) if treffer and '/' in treffer.group(1) else None
    if datei is None:
        return 'weder Klasse#methode noch pfad#Fall noch ein Pfad im Repo'
    bis = treffer.group(3) or treffer.group(2)
    if bis and (not datei.is_file() or int(bis) > len(_text(datei).splitlines())):
        return f'Zeile {bis} fehlt in {treffer.group(1)}'
    return None


def verstoesse(matrix):
    klassen = _java_klassen()
    fehler = []
    for z in matrix['zusagen']:
        kz = z['kennzeichen']
        kandidaten = z['nachweis_kandidaten']
        lieferanten = z.get('wer_liefert', [])
        for kandidat in kandidaten:
            satz = pruefe_kandidat(kandidat, klassen)
            if satz:
                fehler.append(f'{kz}: {kandidat}: {satz}')
        if not kandidaten and not lieferanten and not z['nachweise']:
            fehler.append(f'{kz}: weder Kandidat noch Lieferant (AP-20 NW-1)')
        if z['art'] == 'plan_abnahme' and not any(art(k) != 'pfad' for k in kandidaten):
            fehler.append(f'{kz}: Plan-Abnahme ohne Fall (Klasse#methode oder pfad#Fall)')
        if z['art'] == 'betrieb' and z['urteil'] == 'offen' and 'Betreiber' not in [w['wer'] for w in lieferanten]:
            fehler.append(f'{kz}: Betriebszusage ohne Bestätigung des Betreibers in wer_liefert')
        for text in [*kandidaten, *(w['was'] for w in lieferanten)]:
            if WARTET.search(text):
                fehler.append(f'{kz}: wartet noch auf AP-20 IP-6: {text}')
    return fehler


def zaehlung(matrix):
    je_art = {'klasse_methode': 0, 'datei_fall': 0, 'pfad': 0}
    for z in matrix['zusagen']:
        for k in z['nachweis_kandidaten']:
            je_art[art(k)] += 1
    ohne = [z['kennzeichen'] for z in matrix['zusagen'] if not z['nachweis_kandidaten']]
    return je_art, ohne


def main(argv):
    if len(argv) > 1 or (argv and argv[0].startswith('-')):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    pfad = pathlib.Path(argv[0]) if argv else MATRIX_PFAD
    try:
        matrix = json.loads(pfad.read_text(encoding='utf-8'))
        fehler = verstoesse(matrix)
    except (OSError, ValueError, KeyError) as e:
        print(f'{pfad}: nicht lesbar: {e}', file=sys.stderr)
        return 2
    if fehler:
        for f in fehler:
            print(f'rot: {f}')
        return 1
    je_art, ohne = zaehlung(matrix)
    print(f'Klammer hält: {sum(je_art.values())} Kandidaten an {len(matrix["zusagen"]) - len(ohne)} Zusagen '
          f'({je_art["klasse_methode"]} Klasse#methode, {je_art["datei_fall"]} pfad#Fall, {je_art["pfad"]} Pfad), '
          f'jeder existiert; {len(ohne)} Zusagen nur mit Lieferant: {", ".join(ohne) or "keine"}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
