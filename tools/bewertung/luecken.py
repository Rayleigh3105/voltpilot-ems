#!/usr/bin/env python3
"""Lückenliste des Betreibers und ihre Wache (AP-20 IP-3, LU1-LU5, AP-20 NW-3).

Prüft `docs/bewertung/luecken.json` gegen `docs/bewertung/luecken.schema.json` und gegen die
Nachweismatrix `docs/bewertung/nachweismatrix.json`. Rot ist

- eine neue Lücke ohne Eintrag: die Matrix nennt eine L-nnn, die nicht auf der Liste steht (LU5);
- eine geheilte Lücke, die noch offen heißt: eine Zeile, die die Lücke betrifft, nennt sie nicht
  mehr, die Liste führt sie aber nicht als behoben (LU5);
- ein Restpunkt ohne `angenommen_von: Captain`, Grenze und Datum `bis` (LU3);
- `behoben` ohne Nachweis an einem Stand (LU2), ein Übergang außerhalb von UEBERGAENGE, ein
  Verlauf ohne Datum, Person oder Begründung (LU1);
- eine Zeile mit positivem Urteil, die eine offene Lücke nennt (NR6, LU4);
- eine L-nnn auf einer Kundenfläche (G2): eine Lücke von VoltPilot erscheint nie beim Kunden.

Die Wache urteilt nicht und ändert nichts (G4). Sie zeigt die Liste; eine überschrittene Frist
eines Restpunkts rechnet sie beim Abruf aus (LU3), ohne Läufer und ohne Nachricht.

    python3 tools/bewertung/luecken.py [--heute JJJJ-MM-TT] [luecken.json [matrix.json]]

Exit 0: die Wache hält, danach die Liste. Exit 1: mindestens ein Verstoß, je Zeile einer.
Exit 2: Aufruffehler, unlesbare Datei oder `jsonschema` fehlt.
"""

import datetime
import functools
import json
import os
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402

REPO = nachweismatrix.REPO
SCHEMA_PFAD = REPO / 'docs' / 'bewertung' / 'luecken.schema.json'
LISTE_PFAD = REPO / 'docs' / 'bewertung' / 'luecken.json'
MATRIX_PFAD = nachweismatrix.MATRIX_PFAD

# LU2/LU3: der erste Übergang führt nach offen. Wer hier einen Übergang ergänzt, ändert auch
# docs/bewertung/README.md (Abschnitt Lückenliste).
UEBERGAENGE = {
    'offen': ('in_arbeit', 'restpunkt'),
    'in_arbeit': ('behoben', 'restpunkt', 'offen'),
    'restpunkt': ('in_arbeit', 'restpunkt'),
    'behoben': ('offen',),
}

# NR6: diese Zustände halten jede Zeile offen, die die Lücke nennt. Ein Restpunkt begrenzt nur (LU4).
HAELT_OFFEN = ('offen', 'in_arbeit')
POSITIV = ('belegt', 'nicht_maschinell_pruefbar')

# G2: Orte, an denen ein Kunde liest. Testdateien liest kein Kunde.
KUNDENFLAECHEN = (
    'frontend/portal/src',
    'frontend/portal/public',
    'services/api/src/main',
    'deploy/keycloak/themes',
    'docs/rollout/release-notiz-vorlage.md',
)
KEINE_KUNDENFLAECHE = {'node_modules', 'target', 'dist', 'build', 'test', 'tests', '__tests__', 'e2e'}
TESTDATEI = re.compile(r'\.(test|spec)\.[a-z]+$')

L_KENNUNG = re.compile(r'\bL-\d{3}\b')


def lade_schema():
    return json.loads(SCHEMA_PFAD.read_text(encoding='utf-8'))


@functools.lru_cache(maxsize=1)
def _validator():
    """Einmal je Lauf: das Schema ändert sich während eines Laufs nicht."""
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource
    schema = lade_schema()
    Draft202012Validator.check_schema(schema)
    matrix_schema = nachweismatrix.lade_schema()
    registry = Registry().with_resource(matrix_schema['$id'], Resource.from_contents(matrix_schema))
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def _formfehler(liste):
    fehler = sorted(_validator().iter_errors(liste), key=lambda e: (list(map(str, e.absolute_path)), e.message))
    return [f'{nachweismatrix._pfad(e.absolute_path)}: {e.message}' for e in fehler]


def _restpunkte(liste):
    """LU3 in Worten neben dem Schema-Fehler: wer einen Restpunkt einträgt, sieht, was fehlt."""
    fehler = []
    for i, l in enumerate(liste.get('luecken') or []):
        verlauf = l.get('verlauf') if isinstance(l, dict) else None
        for k, u in enumerate(verlauf if isinstance(verlauf, list) else []):
            if not isinstance(u, dict) or u.get('nach') != 'restpunkt':
                continue
            fehlt = ([] if u.get('angenommen_von') == 'Captain' else ['angenommen_von: Captain'])
            fehlt += [f for f in ('grenze', 'bis') if not u.get(f)]
            if fehlt:
                fehler.append(f'{l.get("kennzeichen", f"luecken[{i}]")}.verlauf[{k}]: Restpunkt ohne {", ".join(fehlt)} - '
                              f'einen Restpunkt nimmt nur der Captain an, mit Grenze und Datum bis (LU3)')
    return fehler


def _reihe(liste):
    """L-001 … L-nnn lückenlos aufsteigend: eine Lücke wird nie gelöscht, nur behoben oder Restpunkt."""
    for i, l in enumerate(liste['luecken']):
        erwartet = f'L-{i + 1:03d}'
        if l['kennzeichen'] != erwartet:
            return [f'luecken[{i}]: {l["kennzeichen"]} steht, wo {erwartet} stehen muss - L-nnn lückenlos '
                    f'aufsteigend; eine Lücke wird nie gelöscht, sie wird behoben oder Restpunkt']
    return []


def _verlauf(l):
    """LU1-LU3: Verlauf ab offen, nur erlaubte Übergänge, Daten in Folge, Zustand = letzter Übergang."""
    kz, verlauf, fehler = l['kennzeichen'], l['verlauf'], []
    if verlauf[0]['nach'] != 'offen':
        fehler.append(f'{kz}.verlauf[0]: der erste Übergang führt nach offen, nicht nach {verlauf[0]["nach"]}')
    for i, (vorher, nachher) in enumerate(zip(verlauf, verlauf[1:]), start=1):
        if nachher['nach'] not in UEBERGAENGE[vorher['nach']]:
            fehler.append(f'{kz}.verlauf[{i}]: {vorher["nach"]} → {nachher["nach"]} ist kein erlaubter Übergang '
                          f'(erlaubt: {", ".join(UEBERGAENGE[vorher["nach"]])})')
        if nachher['am'] < vorher['am']:
            fehler.append(f'{kz}.verlauf[{i}]: {nachher["am"]} liegt vor dem Übergang davor ({vorher["am"]})')
    for i, u in enumerate(verlauf):
        if u['nach'] == 'restpunkt' and u['bis'] <= u['am']:
            fehler.append(f'{kz}.verlauf[{i}]: Restpunkt bis {u["bis"]} endet nicht nach der Annahme am {u["am"]} (LU3)')
    if l['zustand'] != verlauf[-1]['nach']:
        fehler.append(f'{kz}.zustand: {l["zustand"]}, der letzte Übergang führt nach {verlauf[-1]["nach"]} (LU1)')
    return fehler


def _zeilen(matrix):
    """Die Zeilen der Matrix, die eine Lücke nennen können: Zusagen und Norm-Zeilen."""
    zeilen = {z['kennzeichen']: ('zusagen', z) for z in matrix.get('zusagen', [])}
    zeilen.update({z['abschnitt']: ('norm_teil', z) for z in matrix.get('norm_teil', [])})
    return zeilen


def _teil(ziel):
    return 'zusagen' if ziel.startswith('Z-') else 'norm_teil'


def _bindung(liste, matrix):
    """Liste und Matrix nennen einander (E6 = A, LU4, LU5, NR6).

    Eine nicht behobene Lücke wird von jeder Zeile genannt, die sie betrifft; eine behobene von
    keiner. Eine Zeile in einem Teil, der noch keine Zeile trägt, wird nicht geprüft: der Norm-Teil
    entsteht erst in AP-20 IP-7."""
    luecken = {l['kennzeichen']: l for l in liste['luecken']}
    zeilen = _zeilen(matrix)
    befuellt = {teil for teil in ('zusagen', 'norm_teil') if matrix.get(teil)}
    fehler = []

    for kennung, (teil, zeile) in zeilen.items():
        ort = f'{teil}[{kennung}]'
        for kz in zeile['luecken']:
            l = luecken.get(kz)
            if l is None:
                fehler.append(f'{ort}.luecken: {kz} steht nicht auf der Lückenliste - neue Lücke ohne Eintrag (LU5)')
            elif l['zustand'] == 'behoben':
                fehler.append(f'{ort}.luecken: {kz} ist behoben und hält nichts mehr - den Verweis entfernen')
            elif kennung not in l['betrifft']:
                fehler.append(f'{ort}.luecken: {kz} betrifft {kennung} nicht - betrifft der Lücke ergänzen '
                              f'oder den Verweis entfernen')
            elif l['zustand'] in HAELT_OFFEN and zeile['urteil'] in POSITIV:
                fehler.append(f'{ort}: Urteil {zeile["urteil"]}, aber die Lücke {kz} ({l["zustand"]}) '
                              f'hält die Zeile offen (NR6)')

    for pfad, text in nachweismatrix._texte(matrix):
        if 'luecken' in pfad:
            continue
        for kz in sorted(set(L_KENNUNG.findall(text)) - set(luecken)):
            fehler.append(f'{nachweismatrix._pfad(pfad)}: {kz} steht nicht auf der Lückenliste - neue Lücke '
                          f'ohne Eintrag (LU5)')

    for kz, l in luecken.items():
        for ziel in l['betrifft']:
            if _teil(ziel) not in befuellt:
                continue
            if ziel not in zeilen:
                fehler.append(f'{kz}.betrifft: {ziel} gibt es im Teil {_teil(ziel)} der Matrix nicht')
            elif l['zustand'] != 'behoben' and kz not in zeilen[ziel][1]['luecken']:
                fehler.append(f'{kz} heißt {l["zustand"]}, aber {_teil(ziel)}[{ziel}] nennt sie nicht mehr - '
                              f'geheilt? dann in_arbeit → behoben mit Nachweis an einem Stand (LU2, LU5); '
                              f'sonst den Verweis zurück (NR6)')
    return fehler


def verstoesse(liste, matrix):
    """Alle Verstöße gegen Vertrag und Bindung; leer heißt: die Wache hält.

    Erst die Form (Schema); nur eine formgerechte Liste wird an die Matrix gebunden. Die Matrix
    selbst prüft nachweismatrix.py (AP-20 NW-1)."""
    fehler = _formfehler(liste)
    if fehler:
        return fehler + _restpunkte(liste) + nachweismatrix._nr9(liste)
    fehler += _reihe(liste)
    for l in liste['luecken']:
        fehler += _verlauf(l)
    return fehler + _bindung(liste, matrix) + nachweismatrix._nr9(liste)


def _kundendateien(wurzel):
    for teil in KUNDENFLAECHEN:
        start = wurzel / teil
        if start.is_file():
            yield start
            continue
        for ordner, unterordner, dateien in os.walk(start):
            unterordner[:] = sorted(u for u in unterordner if u not in KEINE_KUNDENFLAECHE)
            for name in sorted(dateien):
                if not TESTDATEI.search(name):
                    yield pathlib.Path(ordner) / name


def auf_kundenflaechen(wurzel=REPO):
    """G2: je Fundstelle einer L-nnn auf einer Kundenfläche ein Verstoß."""
    fehler = []
    for datei in _kundendateien(pathlib.Path(wurzel)):
        roh = datei.read_bytes()
        if b'\0' in roh[:4096]:
            continue
        for nr, zeile in enumerate(roh.decode('utf-8', errors='replace').splitlines(), start=1):
            for kz in L_KENNUNG.findall(zeile):
                fehler.append(f'{datei.relative_to(wurzel)}:{nr}: {kz} auf einer Kundenfläche - eine Lücke von '
                              f'VoltPilot erscheint nie beim Kunden (G2)')
    return fehler


def zeile(l, heute):
    """Eine Zeile der Betreiber-Liste; die Frist eines Restpunkts wird beim Abruf gerechnet (LU3)."""
    letzter = l['verlauf'][-1]
    teile = [l['kennzeichen'], f'{l["zustand"]} seit {letzter["am"]}']
    if l['zustand'] == 'restpunkt':
        teile += [f'Grenze: {letzter["grenze"]}', f'angenommen vom {letzter["angenommen_von"]}', f'bis {letzter["bis"]}']
        if heute.isoformat() > letzter['bis']:
            teile.append(f'Frist überschritten seit {letzter["bis"]}')
    teile.append('betrifft ' + (', '.join(l['betrifft']) or '—'))
    if l['zustand'] != 'behoben':
        teile.append('liefert: ' + ', '.join(dict.fromkeys(w['wer'] for w in l['wer_liefert'])))
    return ' · '.join(teile)


def _anzeige(pfad):
    try:
        return pfad.resolve().relative_to(REPO)
    except ValueError:
        return pfad


def main(argv):
    argv, heute = list(argv), datetime.date.today()
    if argv[:1] == ['--heute'] and len(argv) > 1:
        try:
            heute = datetime.date.fromisoformat(argv[1])
        except ValueError:
            print(__doc__.strip(), file=sys.stderr)
            return 2
        argv = argv[2:]
    if len(argv) > 2 or any(a.startswith('-') for a in argv):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    pfade = [pathlib.Path(a) for a in argv] + [LISTE_PFAD, MATRIX_PFAD][len(argv):]
    try:
        liste, matrix = (json.loads(p.read_text(encoding='utf-8')) for p in pfade)
        fehler = verstoesse(liste, matrix) + auf_kundenflaechen()
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except (OSError, ValueError) as e:
        print(f'nicht lesbar: {e}', file=sys.stderr)
        return 2
    if fehler:
        for f in fehler:
            print(f'rot: {f}')
        return 1
    je = {z: sum(l['zustand'] == z for l in liste['luecken']) for z in UEBERGAENGE}
    print(f'Wache hält: {_anzeige(pfade[0])} gegen {_anzeige(pfade[1])} ({len(liste["luecken"])} Lücken: '
          + ', '.join(f'{n} {z}' for z, n in je.items()) + f'; gelesen am {heute.isoformat()})')
    for l in liste['luecken']:
        print(zeile(l, heute))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
