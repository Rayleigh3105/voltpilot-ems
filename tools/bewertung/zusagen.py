#!/usr/bin/env python3
"""Wache des Zusagen-Inventars (AP-20 IP-5, MX3, MX5).

Liest die Orte, an denen VoltPilot einem UEMS-Kunden etwas zusagt, gegen den Zusagen-Teil der
Nachweismatrix `docs/bewertung/nachweismatrix.json`:

- MX5: jeder Satz der Release-Notiz-Vorlage steht im Wortlaut einer Zusage, deren Quelle genau
  diese Zeilen nennt. Eine neue Zeile ohne Zusage ist rot.
- MX3: jede Quelle ist `datei:zeile`. Liegt die Datei im Repo, gibt es die Zeilen, und der Wortlaut
  steht dort. Verglichen wird nur über Buchstaben und Ziffern, damit Anführungszeichen, Einrückung und
  Zeilenumbrüche im Quelltext nicht zählen. Eine Kurzform prüft nur, dass es die Zeilen gibt.
- Mit `--plan PFAD` zusätzlich die Plan-Abnahmen: jeder Satz der Abnahme AP-01 … AP-19 und des
  Ergebnisses AP-00 steht im Wortlaut einer Zusage mit Quelle `PG/plan.md:zeile`.

Die Wache urteilt nicht. Urteile fällt der Matrix-Prüfer (AP-20 IP-4); den Vertrag prüft
`nachweismatrix.py` (AP-20 NW-1).

    python3 tools/bewertung/zusagen.py [--plan PFAD] [matrix.json]

Exit 0: jede Release-Notiz-Zeile hat eine Zusage, und jede Quelle trägt ihren Wortlaut.
Exit 1: mindestens ein Verstoß, je Zeile einer. Exit 2: Aufruffehler oder unlesbare Datei.
"""

import collections
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
MATRIX_PFAD = REPO / 'docs' / 'bewertung' / 'nachweismatrix.json'
VORLAGE = 'docs/rollout/release-notiz-vorlage.md'
PLAN = 'PG/plan.md'

# Quellen außerhalb des Repos, in der Programm-Ablage des Captains: PG = der Programmplan
# (`data/vp-uems-programm/`), FM = die Ablage eines Pakets (`data/<paket>/`). Nur mit --plan geprüft.
AUSSERHALB = ('PG/', 'FM/')

# Rahmen der Release-Notiz, keine Zusage: die Anrede. Der Betreff wiederholt den ersten Satz des
# Abschnitts, der die Zusage trägt. Wer hier ein Wort ergänzt, nimmt einen Satz aus der Wache.
RAHMEN = ('Guten Tag,',)

FUNDSTELLE = re.compile(r'^(?P<pfad>\S+?):(?P<bereiche>\d+(?:[–-]\d+)?(?:, :\d+(?:[–-]\d+)?)*)$')
BEREICH = re.compile(r'(\d+)(?:[–-](\d+))?')
SATZGRENZE = re.compile(r'(?<=[.!?])\s+(?=[A-ZÄÖÜ„\[])')
KURZFORM = re.compile(r'\(Kurzform\b')
ABSCHNITT_PLAN = re.compile(r'^### (AP-\d\d) ')


def einzeilig(text):
    return ' '.join(text.split())


def buchstaben(text):
    """Nur Buchstaben und Ziffern: so zählen Anführungszeichen, Umbrüche und Code-Syntax nicht."""
    return re.sub(r'[\W_]+', '', text)


def ist_kurzform(zusage):
    return bool(KURZFORM.search(zusage['wortlaut']))


def fundstellen(quelle):
    """`a.md:3, :54–58; b.ts:7` -> [('a.md', [(3, 3), (54, 58)]), ('b.ts', [(7, 7)])]; None, wenn nicht lesbar."""
    ergebnis = []
    for teil in quelle.split('; '):
        m = FUNDSTELLE.match(teil.strip())
        if not m:
            return None
        bereiche = [(int(a), int(b or a)) for a, b in BEREICH.findall(m.group('bereiche'))]
        ergebnis.append((m.group('pfad'), bereiche))
    return ergebnis


def bereich_text(von, bis):
    return str(von) if von == bis else f'{von}–{bis}'


def _saetze(block):
    """Ein Absatz oder Listenpunkt [(zeile, text)] -> [(von, bis, satz)]."""
    text, anfaenge = '', []
    for nr, s in block:
        if text:
            text += ' '
        anfaenge.append((len(text), nr))
        text += s

    def zeile(offset):
        return max(nr for start, nr in anfaenge if start <= offset)

    ergebnis, start = [], 0
    for m in list(SATZGRENZE.finditer(text)) + [None]:
        ende = m.start() if m else len(text)
        ergebnis.append((zeile(start), zeile(ende - 1), text[start:ende]))
        start = m.end() if m else start
    return ergebnis


def saetze_der_vorlage(text):
    """Die Kundensätze der Release-Notiz-Vorlage: [(von, bis, satz)].

    Gelesen wird ab dem ersten Abschnitt `## …` (davor steht die Anleitung für den Betreiber).
    Überschriften, Leerzeilen, Betreff und Anrede sind Rahmen; ein Listenpunkt beginnt einen neuen Block."""
    ergebnis, block, im_abschnitt = [], [], False

    def schliessen():
        if block:
            ergebnis.extend(_saetze(block))
            block.clear()

    for nr, zeile in enumerate(text.splitlines(), 1):
        s = zeile.strip()
        if s.startswith('## '):
            schliessen()
            im_abschnitt = True
            continue
        if not im_abschnitt:
            continue
        if not s or s.startswith('#') or s.startswith('**Betreff:**') or s in RAHMEN:
            schliessen()
            continue
        if s.startswith('- '):
            schliessen()
            s = s[2:]
        block.append((nr, s))
    schliessen()
    return ergebnis


def saetze_des_plans(text):
    """Die Sätze der Plan-Abnahmen AP-01 … AP-19 und des Ergebnisses AP-00: [(von, bis, satz)]."""
    ergebnis, paket = [], None
    for nr, zeile in enumerate(text.splitlines(), 1):
        m = ABSCHNITT_PLAN.match(zeile)
        if m:
            paket = m.group(1)
            continue
        if paket is None or not 'AP-00' <= paket <= 'AP-19':
            continue
        kopf = 'Ergebnis: ' if paket == 'AP-00' else 'Abnahme: '
        if zeile.startswith(kopf):
            ergebnis.extend(_saetze([(nr, zeile[len(kopf):].strip())]))
    return ergebnis


def _gedeckt(zusagen, pfad, saetze, quelle_des_ortes):
    """Jeder Satz steht im Wortlaut einer Zusage, deren Quelle diesen Ort nennt (MX5).

    Ob die Zeilen stimmen, prüft `_quellen`: ein verschobener Satz ist dort einmal rot, mit neuer Zeile."""
    fehler = []
    for von, bis, satz in saetze:
        gedeckt = any(
            einzeilig(satz) in einzeilig(z['wortlaut'])
            and any(p == pfad for p, _ in (fundstellen(z['quelle']) or []))
            for z in zusagen)
        if not gedeckt:
            fehler.append(f'{quelle_des_ortes}:{bereich_text(von, bis)}: Satz „{satz}“ hat keine Zusage (MX5)')
    return fehler


def _quellen(zusagen, wurzel, abgebildet):
    """MX3: jede Quelle ist `datei:zeile`; im Repo gibt es die Zeilen, und der Wortlaut steht dort."""
    fehler, gelesen = [], {}
    for z in zusagen:
        kz = z['kennzeichen']
        stellen = fundstellen(z['quelle'])
        if stellen is None:
            fehler.append(f'zusagen[{kz}].quelle: „{z["quelle"]}“ ist nicht datei:zeile (MX3)')
            continue
        for pfad, bereiche in stellen:
            if pfad in abgebildet:
                datei = abgebildet[pfad]
            elif pfad.startswith(AUSSERHALB) or ':' in pfad:
                continue  # außerhalb des Repos oder an einem festen Stand (`<rev>:pfad`)
            else:
                datei = wurzel / pfad
            if datei not in gelesen:
                gelesen[datei] = datei.read_text(encoding='utf-8').splitlines() if datei.is_file() else None
            zeilen = gelesen[datei]
            if zeilen is None:
                fehler.append(f'zusagen[{kz}].quelle: {pfad} gibt es nicht')
                continue
            for von, bis in bereiche:
                ort = f'{pfad}:{bereich_text(von, bis)}'
                if not 1 <= von <= bis <= len(zeilen):
                    fehler.append(f'zusagen[{kz}].quelle: {ort} gibt es nicht ({len(zeilen)} Zeilen)')
                elif not ist_kurzform(z) and not _steht(z['wortlaut'], zeilen, von, bis):
                    jetzt = _jetzt(z['wortlaut'], zeilen, von, bis)
                    fehler.append(f'zusagen[{kz}].quelle: der Wortlaut steht nicht an {ort} - '
                                  + (f'Zeilen verschoben, steht jetzt an :{bereich_text(*jetzt)}; die Quelle mitziehen (MX3)'
                                     if jetzt else 'Satz geändert oder entfallen; die Zusage mitziehen (MX3)'))
    return fehler


def _steht(wortlaut, zeilen, von, bis):
    return buchstaben(wortlaut) in buchstaben(' '.join(zeilen[von - 1:bis]))


def _jetzt(wortlaut, zeilen, von, bis):
    """Die nächstgelegenen gleich langen Zeilen, an denen der Wortlaut jetzt steht, oder None."""
    laenge = bis - von
    treffer = [(abs(a - von), a) for a in range(1, len(zeilen) - laenge + 1) if _steht(wortlaut, zeilen, a, a + laenge)]
    return (min(treffer)[1], min(treffer)[1] + laenge) if treffer else None


def verstoesse(matrix, wurzel=REPO, plan=None):
    """Alle Verstöße der Wache; leer heißt: jede Release-Notiz-Zeile hat eine Zusage."""
    zusagen = matrix['zusagen']
    abgebildet = {PLAN: pathlib.Path(plan)} if plan else {}
    fehler = [f'zusagen[{z["kennzeichen"]}].wortlaut: steht an keinem Ort mit datei:zeile (MX3)'
              for z in zusagen if not einzeilig(z['wortlaut'])]
    fehler += _quellen(zusagen, wurzel, abgebildet)
    fehler += _gedeckt(zusagen, VORLAGE, saetze_der_vorlage((wurzel / VORLAGE).read_text(encoding='utf-8')), VORLAGE)
    if plan:
        fehler += _gedeckt(zusagen, PLAN, saetze_des_plans(pathlib.Path(plan).read_text(encoding='utf-8')), PLAN)
    return fehler


def _anzeige(pfad):
    try:
        return pfad.resolve().relative_to(REPO)
    except ValueError:
        return pfad


def main(argv):
    argv, plan = list(argv), None
    if argv[:1] == ['--plan'] and len(argv) >= 2:
        plan, argv = argv[1], argv[2:]
    if len(argv) > 1 or (argv and argv[0].startswith('-')):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    pfad = pathlib.Path(argv[0]) if argv else MATRIX_PFAD
    try:
        matrix = json.loads(pfad.read_text(encoding='utf-8'))
        fehler = verstoesse(matrix, plan=plan)
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f'{_anzeige(pfad)}: nicht lesbar: {e}', file=sys.stderr)
        return 2
    if fehler:
        for f in fehler:
            print(f'rot: {f}')
        return 1
    je_art = collections.Counter(z['art'] for z in matrix['zusagen'])
    je_urteil = collections.Counter(z['urteil'] for z in matrix['zusagen'])
    saetze = len(saetze_der_vorlage((REPO / VORLAGE).read_text(encoding='utf-8')))
    print(f'Wache hält: {saetze} Sätze der Release-Notiz-Vorlage, jeder mit Zusage'
          + (', dazu die Plan-Abnahmen' if plan else '') + '; '
          f'{len(matrix["zusagen"])} Zusagen, je Art {dict(sorted(je_art.items()))}, '
          f'je Urteil {dict(sorted(je_urteil.items()))}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
