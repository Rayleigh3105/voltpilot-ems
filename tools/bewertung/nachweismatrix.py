#!/usr/bin/env python3
"""Vertrag der Nachweismatrix (AP-20 IP-2, AP-20 NW-1).

Prüft eine Matrix gegen `docs/bewertung/nachweismatrix.schema.json` und gegen die Regeln,
die ein Schema nicht ausdrücken kann: eindeutige Kennzeichen, Verweise zwischen den Teilen,
den Satz einer Kundenaufgabe (NR5, RF-04), NR9 und die Bindung von Matrix-Fassung und
Normfassung (MX6). Er urteilt NICHT über Nachweise - das tut der Matrix-Prüfer (AP-20 IP-4)
nach NR1-NR9 an Lauf-Berichten.

    python3 tools/bewertung/nachweismatrix.py [matrix.json]

Exit 0: der Vertrag hält. Exit 1: mindestens ein Verstoß, je Zeile einer.
Exit 2: Aufruffehler, unlesbare Datei oder `jsonschema` fehlt.
"""

import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
SCHEMA_PFAD = REPO / 'docs' / 'bewertung' / 'nachweismatrix.schema.json'
MATRIX_PFAD = REPO / 'docs' / 'bewertung' / 'nachweismatrix.json'

# MX6: je Matrix-Fassung genau eine Normfassung. Eine neue Ausgabe ist eine neue Fassung -
# Eintrag hier UND in der Fassungs-Tabelle von docs/bewertung/README.md, nie eine stille Änderung.
NORMFASSUNGEN = {
    1: ('ISO 50001:2018 einschließlich Amd 1:2024',
        'DIN EN ISO 50001:2018-12 mit DIN EN ISO 50001/A1:2024-12'),
}

NW_KENNUNG = re.compile(r'\bNW-\d+')
PAKET_DAVOR = re.compile(r'\bAP-\d+ $')

# NR5, RF-04: eine Kundenaufgabe urteilt nicht, auch nicht im Satz. Verboten sind die Wörter des
# Urteil-Vokabulars (aus dem Schema), die nie gesagten aus MX4 und „Lücke“, auch gebeugt. Das Verb
# der Aufgabe („belegen“, „erfüllen“) bleibt: es sagt, was der Kunde tut, nicht ob er es getan hat.
NIE_IM_SATZ = ('erfüllt', 'konform', 'zertifiziert', 'vollständig', 'Lücke')
# Kundensprache: der Satz steht später im Hilfe-Artikel (AP-20 IP-22), wo Abschnittsnummern,
# Kennzeichen, Norm und Vokabular-Schlüssel nie erscheinen.
NIE_FUER_KUNDEN = (
    (re.compile(r'\b\d+\.\d+(?:\.\d+)?\b'), 'Abschnittsnummer'),
    (re.compile(r'\b[A-Z]{1,3}-\d+\b'), 'Kennzeichen'),
    (re.compile(r'\b(?:ISO|DIN|Norm)\b'), 'Norm'),
    (re.compile(r'\w_\w'), 'Vokabular-Schlüssel'),
)


def lade_schema():
    return json.loads(SCHEMA_PFAD.read_text(encoding='utf-8'))


def _validator():
    from jsonschema import Draft202012Validator, FormatChecker
    schema = lade_schema()
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def _pfad(teile):
    return '/'.join(str(t) for t in teile) or '(Wurzel)'


def _formfehler(matrix):
    fehler = sorted(_validator().iter_errors(matrix), key=lambda e: (list(map(str, e.absolute_path)), e.message))
    return [f'{_pfad(e.absolute_path)}: {e.message}' for e in fehler]


def _doppelte(werte):
    gesehen, doppelt = set(), []
    for w in werte:
        if w in gesehen and w not in doppelt:
            doppelt.append(w)
        gesehen.add(w)
    return doppelt


def _verweise(matrix):
    """Norm-Teil, Zusagen und Kundenaufgaben nennen einander gegenseitig (MX1).

    Jeder Verweis wird geprüft, auch in einen leeren Teil: seit AP-20 IP-8 tragen alle drei
    Teile Zeilen. Eine Norm-Zeile, deren Kundenaufgabe fehlt, ist rot (AP-20 NW-1)."""
    norm = {z['abschnitt']: z for z in matrix['norm_teil']}
    zusagen = {z['kennzeichen']: z for z in matrix['zusagen']}
    aufgaben = {k['kennzeichen']: k for k in matrix['kundenaufgaben']}
    fehler = []

    von_norm = {(kz, a) for a, z in norm.items() for kz in z['zusagen']}
    von_zusage = {(kz, a) for kz, z in zusagen.items() for a in z['norm']}
    for kz, a in sorted(von_norm - von_zusage):
        fehler.append(f'norm_teil[{a}].zusagen: {kz} gibt es im Zusagen-Teil nicht' if kz not in zusagen
                      else f'norm_teil[{a}].zusagen: {kz} nennt Abschnitt {a} nicht')
    for kz, a in sorted(von_zusage - von_norm):
        fehler.append(f'zusagen[{kz}].norm: Abschnitt {a} hat keine Zeile im Norm-Teil' if a not in norm
                      else f'zusagen[{kz}].norm: die Norm-Zeile {a} nennt {kz} nicht')

    von_norm = {(z['kundenaufgabe'], a) for a, z in norm.items()}
    von_aufgabe = {(kz, a) for kz, k in aufgaben.items() for a in k['norm']}
    for kz, a in sorted(von_norm - von_aufgabe):
        fehler.append(f'norm_teil[{a}].kundenaufgabe: {kz} gibt es bei den Kundenaufgaben nicht' if kz not in aufgaben
                      else f'norm_teil[{a}].kundenaufgabe: {kz} nennt Abschnitt {a} nicht')
    for kz, a in sorted(von_aufgabe - von_norm):
        fehler.append(f'kundenaufgaben[{kz}].norm: Abschnitt {a} hat keine Zeile im Norm-Teil' if a not in norm
                      else f'kundenaufgaben[{kz}].norm: die Norm-Zeile {a} nennt eine andere Kundenaufgabe')
    return fehler


def _urteil_im_satz():
    """Ein Wort des Urteils in jeder Schreibung: „Lücke“ wie „Luecken“, „nicht_zugesagt“ wie „nicht zugesagt“."""
    stamm = []
    for wort in lade_schema()['$defs']['urteil']['enum'] + list(NIE_IM_SATZ):
        muster = re.escape(wort.lower().replace('_', ' ')).replace(r'\ ', r'[\s_]+')
        for umlaut, aus in (('ä', 'ae'), ('ö', 'oe'), ('ü', 'ue')):
            muster = muster.replace(umlaut, aus).replace(aus, f'(?:{umlaut}|{aus})')
        stamm.append(muster)
    return re.compile(rf'(?<![^\W\d_])(?:{"|".join(stamm)})(?:e|em|en|er|es|n)?(?![^\W\d_])', re.IGNORECASE)


def _kundenaufgaben(matrix):
    """Der Satz einer Kundenaufgabe: ohne Urteil (NR5, RF-04) und in Kundensprache.

    Das Feld `urteil` verbietet schon das Schema; hier fällt ein Satz, der urteilt."""
    urteil = _urteil_im_satz()
    fehler = []
    for k in matrix['kundenaufgaben']:
        for m in urteil.finditer(k['text']):
            fehler.append(f'kundenaufgaben[{k["kennzeichen"]}].text: „{m.group()}“ urteilt - '
                          f'eine Kundenaufgabe hat kein Urteil (NR5, RF-04)')
        for muster, was in NIE_FUER_KUNDEN:
            for m in muster.finditer(k['text']):
                fehler.append(f'kundenaufgaben[{k["kennzeichen"]}].text: {was} „{m.group()}“ ist keine Kundensprache')
    return fehler


def _texte(knoten, pfad=()):
    if isinstance(knoten, str):
        yield pfad, knoten
    elif isinstance(knoten, dict):
        for k, v in knoten.items():
            yield from _texte(v, pfad + (k,))
    elif isinstance(knoten, list):
        for i, v in enumerate(knoten):
            yield from _texte(v, pfad + (i,))


def _nr9(matrix):
    """NR9: eine Nachweis-Kennung trägt immer ihr Paket („AP-14 NW-6“), nie nur „NW-6“."""
    fehler = []
    for pfad, text in _texte(matrix):
        for m in NW_KENNUNG.finditer(text):
            if not PAKET_DAVOR.search(text[:m.start()]):
                fehler.append(f'{_pfad(pfad)}: Nachweis-Kennung „{m.group()}“ ohne Paket - '
                              f'„AP-nn {m.group()}“ schreiben (NR9)')
    return fehler


def _normfassung(matrix):
    erwartet = NORMFASSUNGEN.get(matrix['matrix_fassung'])
    ist = (matrix['normfassung']['international'], matrix['normfassung']['deutsch'])
    if erwartet is None:
        return [f'matrix_fassung: Fassung {matrix["matrix_fassung"]} ist nicht eingetragen (NORMFASSUNGEN, README)']
    if ist != erwartet:
        return [f'normfassung: weicht von Matrix-Fassung {matrix["matrix_fassung"]} ab - eine neue Ausgabe '
                f'ist eine neue Matrix-Fassung, keine stille Änderung (MX6)']
    return []


def gliederung(matrix):
    """RF-12: welche Abschnitte der Gliederung ohne Zeile sind, und die Zeilen je Träger.

    Gezählt wird der Träger, nie eine Erfüllung (MX4). Vollständig heißt nur: jede Zeile existiert."""
    defs = lade_schema()['$defs']
    da = {z['abschnitt'] for z in matrix['norm_teil']}
    je_traeger = dict.fromkeys(defs['traeger_norm']['enum'], 0)
    for z in matrix['norm_teil']:
        je_traeger[z['traeger']] += 1
    return [a for a in defs['abschnitt']['enum'] if a not in da], je_traeger


def verstoesse(matrix):
    """Alle Verstöße gegen den Vertrag; leer heißt: der Vertrag hält.

    Erst die Form (Schema); nur eine formgerechte Matrix wird auf Verweise geprüft."""
    fehler = _formfehler(matrix)
    if fehler:
        return fehler + _nr9(matrix)
    for teil, feld in (('norm_teil', 'abschnitt'), ('zusagen', 'kennzeichen'), ('kundenaufgaben', 'kennzeichen')):
        fehler += [f'{teil}: {w} steht mehr als einmal' for w in _doppelte(z[feld] for z in matrix[teil])]
    return fehler + _verweise(matrix) + _kundenaufgaben(matrix) + _nr9(matrix) + _normfassung(matrix)


def _anzeige(pfad):
    try:
        return pfad.resolve().relative_to(REPO)
    except ValueError:
        return pfad


def main(argv):
    if len(argv) > 1 or (argv and argv[0].startswith('-')):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    pfad = pathlib.Path(argv[0]) if argv else MATRIX_PFAD
    try:
        matrix = json.loads(pfad.read_text(encoding='utf-8'))
        fehler = verstoesse(matrix)
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except (OSError, ValueError) as e:
        print(f'{_anzeige(pfad)}: nicht lesbar: {e}', file=sys.stderr)
        return 2
    if fehler:
        for f in fehler:
            print(f'rot: {f}')
        return 1
    print(f'Vertrag hält: {_anzeige(pfad)} (Fassung {matrix["matrix_fassung"]}, Stichtag {matrix["normfassung"]["stichtag"]}, '
          f'{len(matrix["norm_teil"])} Norm-Zeilen, {len(matrix["zusagen"])} Zusagen, '
          f'{len(matrix["kundenaufgaben"])} Kundenaufgaben)')
    fehlend, je_traeger = gliederung(matrix)
    print('Norm-Teil je Träger (RF-12): ' + ' · '.join(f'{t} {n}' for t, n in je_traeger.items())
          + (f'; ohne Zeile: {", ".join(fehlend)}' if fehlend else '; jede Zeile der Gliederung existiert'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
