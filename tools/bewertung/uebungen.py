#!/usr/bin/env python3
"""Übungen des Betreibers lesen (AP-20 IP-19, BT1–BT3, NR8, RF-07).

Eine Übung ist der Beleg für eine Wiederherstellung (Z-015) oder für einen Alarm (NR8). Der
Betreiber fährt sie, die Crew trägt sie unter `docs/bewertung/uebungen/U-JJJJ-nn.json` ein und legt
das Artefakt mit Prüfsumme daneben (Vorlagen im selben Ordner). Dieses Werkzeug liest die Übungen
gegen `docs/bewertung/uebung.schema.json` und rechnet jedes Ergebnis am Artefakt nach. Rot ist

- eine Übung, die nicht zum Schema passt oder anders heißt als ihre Datei;
- ein Artefakt, das fehlt oder eine andere Prüfsumme hat (NR1: ein Werkzeug zählt nur mit Artefakt);
- ein Ergebnis oder Zustand, den das Artefakt nicht trägt: `durchgefuehrt` verlangt bei einer
  Wiederherstellung in `rueckweg.json` exit_code 0, Flyway-Stand und Q01 bytegleich und eine
  Dauer - dieselbe Regel wie NW-8 im Tor-Prüfer (`tools/freigabe/pruefe_tor.py`).

Q15 „WAL-Archiv läuft“ liest es aus dem Stand-Blatt des Betreibers (`--stand`, Punkt
`q15_wal_archiv`) mit dem Leser des Tor-Prüfers: bestätigt mit Datum heißt
`nicht_maschinell_pruefbar`, sonst `offen`. Die nächste Übung ist beim Abruf fällig
(Startwert sechs Monate nach der letzten durchgeführten, E11 = A) - kein Läufer, keine Nachricht.
Ein Alarm ohne durchgeführte Übung ist nicht geliefert (NR8); das Werkzeug sagt das und bleibt
grün, denn offen ist kein Verstoß. Es urteilt über keine Zusage; das tut der Matrix-Prüfer
(AP-20 IP-4) mit `bewerte()`.

    python3 tools/bewertung/uebungen.py [--heute JJJJ-MM-TT] [--stand <stand-blatt>] [ordner]

Exit 0: alle Übungen tragen ihr Ergebnis, danach die Liste. Exit 1: mindestens ein Verstoß, je
Zeile einer. Exit 2: Aufruffehler, unlesbare Datei oder `jsonschema` fehlt.
"""

import calendar
import datetime
import functools
import hashlib
import json
import pathlib
import sys
import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'freigabe'))
import nachweismatrix  # noqa: E402
import pruefe_tor  # noqa: E402

REPO = nachweismatrix.REPO
SCHEMA_PFAD = REPO / 'docs' / 'bewertung' / 'uebung.schema.json'
ORDNER = REPO / 'docs' / 'bewertung' / 'uebungen'

# BT1, E11 = A: Startwert des Rhythmus. Wer ihn ändert, ändert auch docs/bewertung/uebungen/README.md.
RHYTHMUS_MONATE = 6
# Der Alarm aus IP-19. Er ist erst geliefert, wenn eine Übung ihn ausgelöst hat (NR8).
ALARME = ('VoltPilotSicherungZuAlt',)
# Der Punkt im Stand-Blatt (tools/freigabe/freigabe-stand.example.yaml), den auch Tor G1 M-1b liest.
Q15_PUNKT = 'q15_wal_archiv'


def lade_schema():
    return json.loads(SCHEMA_PFAD.read_text(encoding='utf-8'))


@functools.lru_cache(maxsize=1)
def _validator():
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource
    schema = lade_schema()
    Draft202012Validator.check_schema(schema)
    matrix_schema = nachweismatrix.lade_schema()
    registry = Registry().with_resource(matrix_schema['$id'], Resource.from_contents(matrix_schema))
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def formfehler(uebung):
    fehler = sorted(_validator().iter_errors(uebung), key=lambda e: (list(map(str, e.absolute_path)), e.message))
    return [f'{nachweismatrix._pfad(e.absolute_path)}: {e.message}' for e in fehler]


def plus_monate(tag, monate):
    """Kalendermonate addieren; der 31. wird im kürzeren Monat zum letzten Tag."""
    m = tag.month - 1 + monate
    jahr, monat = tag.year + m // 12, m % 12 + 1
    return datetime.date(jahr, monat, min(tag.day, calendar.monthrange(jahr, monat)[1]))


def aus_rueckweg(bericht):
    """Was `rueckweg.json` (tools/generalprobe/generalprobe.py, Format 1) trägt - wie NW-8 im Tor-Prüfer."""
    bestanden = (bericht.get('exit_code') == 0 and bool(bericht.get('flyway_stimmt'))
                 and bool(bericht.get('Q01_stimmt')) and bool(bericht.get('wiederherstellung_ms')))
    return {
        'zustand': 'durchgefuehrt' if bestanden else 'fehlgeschlagen',
        'ergebnis': {
            'dauer_ms': bericht.get('wiederherstellung_ms'),
            'flyway_bytegleich': bool(bericht.get('flyway_stimmt')),
            'q01_zaehlungen_gleich': bool(bericht.get('Q01_stimmt')),
        },
    }


def q15(stand_pfad):
    """Q15 „WAL-Archiv läuft“ aus dem Stand-Blatt, geurteilt vom Leser des Tor-Prüfers (NR4)."""
    if stand_pfad is None:
        return 'offen', 'kein Stand-Blatt angegeben (--stand); der Betreiber bestätigt Q15 dort (Betreiber)'
    ctx = types.SimpleNamespace(stand_pfad=stand_pfad, stand=pruefe_tor.lies_stand(stand_pfad))
    urteil, text = pruefe_tor.betreiber(Q15_PUNKT, 'Q15 WAL-Archiv laeuft')(ctx)
    return ('nicht_maschinell_pruefbar' if urteil == pruefe_tor.BETREIBER_WORT else 'offen'), text


def bewerte(pfad, ordner=ORDNER, stand_pfad=None):
    """Eine Übung lesen und am Artefakt nachrechnen: (verstöße, ergebnis). RF-07 ist das Ergebnis."""
    pfad = pathlib.Path(pfad)
    uebung = json.loads(pfad.read_text(encoding='utf-8'))
    fehler = formfehler(uebung)
    if fehler:
        return fehler, None
    if pfad.stem != uebung['kennzeichen']:
        fehler.append(f'kennzeichen {uebung["kennzeichen"]} steht in der Datei {pfad.name}')
    artefakt = pathlib.Path(ordner) / uebung['artefakt']['pfad']
    if not artefakt.is_file():
        return fehler + [f'artefakt: {uebung["artefakt"]["pfad"]} fehlt - ohne Artefakt kein Beleg (NR1)'], None
    roh = artefakt.read_bytes()
    if hashlib.sha256(roh).hexdigest() != uebung['artefakt']['sha256']:
        return fehler + [f'artefakt: sha256 von {uebung["artefakt"]["pfad"]} stimmt nicht - Artefakt und '
                         f'Eintrag gehören nicht zusammen'], None
    ergebnis = {'kennzeichen': uebung['kennzeichen'], 'art': uebung['art'], 'datum': uebung['datum'],
                'person': uebung['person'], 'uebung_zustand': uebung['zustand']}
    if uebung['art'] == 'wiederherstellung':
        try:
            nachgerechnet = aus_rueckweg(json.loads(roh.decode('utf-8')))
        except ValueError as e:
            return fehler + [f'artefakt: {uebung["artefakt"]["pfad"]} ist kein JSON ({e})'], None
        if nachgerechnet['zustand'] != uebung['zustand']:
            fehler.append(f'zustand: {uebung["zustand"]}, aber rueckweg.json trägt {nachgerechnet["zustand"]} '
                          f'(exit_code 0, Flyway-Stand und Q01 bytegleich, Dauer bekannt)')
        for feld, wert in nachgerechnet['ergebnis'].items():
            if uebung['ergebnis'][feld] != wert:
                fehler.append(f'ergebnis.{feld}: {uebung["ergebnis"][feld]!r}, rueckweg.json sagt {wert!r}')
        dauer = uebung['ergebnis']['dauer_ms']
        ergebnis.update({
            'dauer_min': round(dauer / 60000),
            'zaehlungen_gleich': uebung['ergebnis']['q01_zaehlungen_gleich'],
            'teil_wiederherstellung': 'belegt' if not fehler and uebung['zustand'] == 'durchgefuehrt' else 'offen',
        })
        ergebnis['q15'], ergebnis['q15_text'] = q15(stand_pfad)
    else:
        ergebnis.update({'alarm': uebung['alarm'], **uebung['ergebnis']})
    if uebung['zustand'] == 'durchgefuehrt':
        ergebnis['naechste_faellig'] = plus_monate(datetime.date.fromisoformat(uebung['datum']),
                                                   RHYTHMUS_MONATE).isoformat()
    return fehler, ergebnis


def lies(ordner=ORDNER, stand_pfad=None):
    """Alle Übungen eines Ordners: (verstöße, ergebnisse). Vorlagen und Artefakte zählen nicht."""
    ordner = pathlib.Path(ordner)
    fehler, ergebnisse = [], []
    for pfad in sorted(ordner.glob('U-*.json')):
        f, e = bewerte(pfad, ordner, stand_pfad)
        fehler += [f'{pfad.name}: {x}' for x in f]
        if e is not None and not f:
            ergebnisse.append(e)
    return fehler, ergebnisse


def _datum(iso):
    return datetime.date.fromisoformat(iso).strftime('%d.%m.%Y')


def zeile(e):
    """Eine Zeile der Betreiber-Liste, wie RF-07 sie zeigt."""
    if e['art'] == 'wiederherstellung':
        teile = [e['kennzeichen'], 'Wiederherstellung', f'{e["dauer_min"]} min',
                 'Zählungen gleich' if e['zaehlungen_gleich'] else 'Zählungen abweichend']
    else:
        teile = [e['kennzeichen'], f'Alarm {e["alarm"]}', f'zugestellt an {e["zugestellt_an"]}']
    teile += [_datum(e['datum']), e['person']]
    if e['uebung_zustand'] == 'fehlgeschlagen':
        teile.append('fehlgeschlagen - belegt nichts')
    else:
        teile.append(f'nächste fällig {_datum(e["naechste_faellig"])}')
    return ' · '.join(teile)


def faelligkeit(ergebnisse, heute, stand_pfad=None):
    """Was beim Abruf fällig ist (BT1, BT2, NR8) - gerechnet, nicht gemeldet. Zeilen mit Urteil vorn."""
    zeilen = []
    wieder = [e for e in ergebnisse if e['art'] == 'wiederherstellung' and e['uebung_zustand'] == 'durchgefuehrt']
    if not wieder:
        zeilen.append('offen: Wiederherstellung: keine durchgeführte Übung - fällig vor dem Rollout '
                      '(BT2, Tor G1 NW-8; Betreiber)')
    else:
        faellig = max(e['naechste_faellig'] for e in wieder)
        if heute.isoformat() > faellig:
            zeilen.append(f'offen: Wiederherstellung: nächste Übung fällig seit {_datum(faellig)} (BT1; Betreiber)')
    urteil, text = q15(stand_pfad)
    zeilen.append(f'{urteil}: {text}')
    for alarm in ALARME:
        if not any(e['art'] == 'alarm' and e['alarm'] == alarm and e['uebung_zustand'] == 'durchgefuehrt'
                   for e in ergebnisse):
            zeilen.append(f'offen: Alarm {alarm} nie ausgelöst - nicht geliefert (NR8; Betreiber: Alarm-Übung)')
    return zeilen


def main(argv):
    argv, heute, stand = list(argv), datetime.date.today(), None
    try:
        while argv[:1] in (['--heute'], ['--stand']):
            if len(argv) < 2:
                raise ValueError(argv[0])
            if argv[0] == '--heute':
                heute = datetime.date.fromisoformat(argv[1])
            else:
                stand = pathlib.Path(argv[1])
            argv = argv[2:]
    except ValueError:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    if len(argv) > 1 or any(a.startswith('-') for a in argv):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    ordner = pathlib.Path(argv[0]) if argv else ORDNER
    try:
        fehler, ergebnisse = lies(ordner, stand)
        offen = faelligkeit(ergebnisse, heute, stand)
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except (OSError, ValueError, pruefe_tor.StandFehler) as e:
        print(f'nicht lesbar: {e}', file=sys.stderr)
        return 2
    if fehler:
        for f in fehler:
            print(f'rot: {f}')
        return 1
    print(f'Übungen lesbar: {len(ergebnisse)} in {ordner} (gelesen am {heute.isoformat()})')
    for e in ergebnisse:
        print(zeile(e))
    for z in offen:
        print(z)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
