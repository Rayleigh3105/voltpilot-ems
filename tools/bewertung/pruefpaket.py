#!/usr/bin/env python3
"""Prüfpaket für die Fachperson (AP-20 IP-11, E4 = A, FP1-FP4).

Baut aus der Nachweismatrix und dem jüngsten Bewertungsentwurf das Paket, das die externe
Auditorin (oder der Auditor) für Energiemanagementsysteme an ihrer lizenzierten Normausgabe liest:

- `pruefpaket.md`: Norm-Teil mit jeder der 30 Zeilen (Abschnittsnummer, eigene Umschreibung,
  Träger, Zusagen mit Urteil des Entwurfs, Kundenaufgabe, Herkunft), Stand von Übersicht und
  Beschreibung, Frageliste, Anleitung zur Protokoll-Vorlage. Kein Normtext (MX2).
- `protokoll-vorlage.json`: je Norm-Zeile und je Frage leere Felder für Name, Datum, Lesart und
  Text, in der Form des Felds `fachperson` der Matrix; AP-20 IP-12 übernimmt sie von dort.
- `pruefpaket.sha256`: Prüfsummen beider Dateien, prüfbar mit `shasum -a 256 -c`.

Das Paket wird nie von Hand geändert. Ein zweiter Bau ist byte-gleich: kein Datum der Uhr, der Tag
ist der Stichtag der Normfassung.

    python3 tools/bewertung/pruefpaket.py [--check] [--aus <ordner>] [--matrix <datei>]
        [--bewertung <BWB-JJJJ-nn.json>] [--produktbeschreibung <ordner>]

Exit 0: geschrieben, bzw. mit `--check` das Paket im Repo ist der Bau aus den Quellen.
Exit 1: `--check` findet eine Abweichung, oder eine Umschreibung ist länger als 160 Zeichen oder
sieht nach Normtext aus, oder eine Zeile der Gliederung fehlt.
Exit 2: Aufruffehler, unlesbare Datei, Vertrag der Matrix rot, `jsonschema` fehlt.
"""

import argparse
import hashlib
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402

REPO = nachweismatrix.REPO
AUS_PFAD = REPO / 'docs' / 'bewertung' / 'pruefpaket'
BEWERTUNGEN = REPO / 'docs' / 'bewertung' / 'bewertungen'
PRODUKTBESCHREIBUNG = REPO / 'docs' / 'bewertung' / 'produktbeschreibung'
DATEIEN = ('pruefpaket.md', 'protokoll-vorlage.json')
SUMME = 'pruefpaket.sha256'

GRENZ_SATZ = ('Eine mögliche Softwarezertifizierung, Förderlistung oder rechtliche Bewertung entsteht nicht '
              'automatisch durch dieses Paket.')
MAX_UMSCHREIBUNG = 160
# MX2: Normtext kommt nie ins Repo. Ein Normsatz verrät sich an der Pflichtform der Norm oder am
# Zitat; eine eigene Umschreibung sagt, worum es geht, ohne beides.
NORMSATZ = (
    (re.compile(r'\bOrganisation (?:muss|müssen|hat|soll)\b|\b(?:muss|hat|soll) die Organisation\b'),
     'Pflichtform der Norm'),
    (re.compile(r'\b(?:shall|should)\b', re.IGNORECASE), 'Pflichtform der englischen Ausgabe'),
    (re.compile(r'[„“"«»]'), 'Zitat'),
)
TRAEGER = {
    'haelt_fest': 'hält fest',
    'misst': 'misst',
    'verweis': 'Verweis auf das System des Kunden',
    'beim_kunden': 'bleibt beim Kunden',
}


def sha256(daten):
    return hashlib.sha256(daten).hexdigest()


def _anzeige(pfad):
    try:
        return pfad.resolve().relative_to(REPO).as_posix()
    except ValueError:
        return pfad.as_posix()


def normtext_verdacht(text):
    """Die Gründe, aus denen ein Text nach Normtext aussieht; leer heißt: eigene Worte."""
    grunde = [grund for muster, grund in NORMSATZ if muster.search(text)]
    if len(text) > MAX_UMSCHREIBUNG:
        grunde.append(f'länger als {MAX_UMSCHREIBUNG} Zeichen ({len(text)})')
    return grunde


def verstoesse(matrix):
    fehler = []
    fehlend, _ = nachweismatrix.gliederung(matrix)
    fehler += [f'Norm-Zeile {a} fehlt' for a in fehlend]
    for z in matrix['norm_teil']:
        fehler += [f'Norm-Zeile {z["abschnitt"]}: Umschreibung {g}' for g in normtext_verdacht(z['umschreibung'])]
    return fehler


def juengste_bewertung(ordner=BEWERTUNGEN):
    kandidaten = sorted(p for p in ordner.glob('BWB-*.json'))
    return kandidaten[-1] if kandidaten else None


def _reihenfolge(matrix):
    enum = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']
    return sorted(matrix['norm_teil'], key=lambda z: enum.index(z['abschnitt']))


def _zelle(text):
    return text.replace('|', '\\|').replace('\n', ' ')


def _fragen(matrix):
    """Die Frageliste (AP-20 §5.2): je Norm-Zeile zwei Fragen, dazu die Sonderfragen des Konzepts."""
    zeilen = {z['abschnitt']: z for z in matrix['norm_teil']}
    ka = {k['kennzeichen']: k for k in matrix['kundenaufgaben']}
    verweise = [z['abschnitt'] for z in _reihenfolge(matrix) if z['traeger'] == 'verweis']
    haelt = [z['abschnitt'] for z in _reihenfolge(matrix) if z['traeger'] == 'haelt_fest']

    def zuordnung(a):
        z = zeilen[a]
        return f'Träger: {TRAEGER[z["traeger"]]}, Kundenaufgabe {z["kundenaufgabe"]}. Herkunft: {z["herkunft"]}'

    return [
        {'frage': 'F-01', 'abschnitte': [z['abschnitt'] for z in _reihenfolge(matrix)],
         'thema': 'Gliederung',
         'text': ('Stimmt die Gliederung der 30 Zeilen mit Ihrer Ausgabe überein: die Abschnitte der zweiten '
                  'Ebene von 4 bis 10, dazu 7.5, 9.1 und 9.2 in ihre Unterabschnitte geteilt? Die Gliederung '
                  'ist aus eigenem Wissen der Crew, nicht aus einer lizenzierten Ausgabe.')},
        {'frage': 'F-02', 'abschnitte': ['4.4'], 'thema': 'Zuordnung ohne Vorlage',
         'text': ('Trägt die Zuordnung von 4.4? ' + zuordnung('4.4') + '. Bis AP-20 IP-7 hatte die Zeile keine '
                  'Zuordnung (L-012).')},
        {'frage': 'F-03', 'abschnitte': ['6.3'], 'thema': 'Zuordnung ohne Vorlage',
         'text': ('Trägt die Zuordnung von 6.3? ' + zuordnung('6.3') + '. Bis AP-20 IP-7 hatte die Zeile keine '
                  'Zuordnung (L-012).')},
        {'frage': 'F-04', 'abschnitte': ['9.1.1'], 'thema': 'Zuordnung ohne Vorlage',
         'text': ('Trägt die Zuordnung von 9.1.1? ' + zuordnung('9.1.1') + '. Bis AP-20 IP-7 hatte die Zeile keine '
                  'Zuordnung (L-012).')},
        {'frage': 'F-05', 'abschnitte': ['4.1', '4.2'], 'thema': 'Klimafrage der Änderung 1',
         'text': ('Reicht es für 4.1 und 4.2, die Klimafrage der Änderung 1 ganz als Kundenaufgabe zu führen? '
                  f'{ka["KA-05"]["kennzeichen"]}: {ka["KA-05"]["text"]} Oder erwartet Ihre Lesart, dass '
                  'VoltPilot dazu etwas festhält?')},
        {'frage': 'F-06', 'abschnitte': [z['abschnitt'] for z in _reihenfolge(matrix)
                                           if z['traeger'] in ('verweis', 'haelt_fest')],
         'thema': 'Grenze zwischen Verweis und geführt',
         'text': ('Liegt die Grenze zwischen Verweis und geführt richtig? Bei ' + ', '.join(verweise)
                  + ' verweist VoltPilot nur auf das System des Kunden und führt das Original nicht '
                  '(Kundenaufgabe KA-09 oder die der Zeile). Bei ' + ', '.join(haelt)
                  + ' hält VoltPilot fest. Genügt ein Verweis dort, wo er steht, und reicht das Festhalten '
                  'dort, wo es steht, oder braucht eine Zeile den anderen Träger?')},
    ]


def _protokoll(matrix, md_sha):
    return {
        'art': 'protokoll_vorlage',
        'paket': 'AP-20 IP-11',
        'lesehilfe': ('Vorlage für die Lesart der Fachperson (FP1). Je Norm-Zeile name, datum (JJJJ-MM-TT), lesart '
                      '(traegt, anmerkung oder widerspruch) und text; AP-20 IP-12 übernimmt sie in das Feld '
                      'fachperson der Matrix. Eine Zeile ohne Lesart bleibt offen. Ein Widerspruch wird eine '
                      'Lücke (FP3). Die Bestätigung trägt nur die Zeilen, die gelesen sind (FP4).'),
        'pruefpaket': {'datei': 'pruefpaket.md', 'sha256': md_sha},
        'matrix_fassung': matrix['matrix_fassung'],
        'normfassung': {k: matrix['normfassung'][k] for k in ('international', 'deutsch', 'stichtag')},
        'fachperson': {'name': None, 'rolle': None, 'unabhaengig_von_der_entwicklung': None,
                       'normausgabe': None},
        'lesarten': [{'abschnitt': z['abschnitt'], 'name': None, 'datum': None, 'lesart': None, 'text': None}
                     for z in _reihenfolge(matrix)],
        'antworten': [{'frage': f['frage'], 'name': None, 'datum': None, 'text': None} for f in _fragen(matrix)],
    }


def _urteile(bwb):
    return {z['kennzeichen']: z['urteil'] for z in bwb['zusagen']} if bwb else {}


def _markdown(matrix, matrix_bytes, bwb, bwb_pfad, bwb_bytes, beschreibung):
    zusagen = {z['kennzeichen']: z for z in matrix['zusagen']}
    ka = {k['kennzeichen']: k for k in matrix['kundenaufgaben']}
    urteile = _urteile(bwb)
    nf = matrix['normfassung']
    _, je_traeger = nachweismatrix.gliederung(matrix)
    tag = nf['stichtag']
    z = []
    a = z.append
    a('# Prüfpaket für die Fachperson (AP-20 IP-11)')
    a('')
    a(f'> {GRENZ_SATZ}')
    a('')
    a('Dieses Paket legt Ihnen die Zuordnung von VoltPilot zur Gliederung der Norm vor. Sie lesen sie an Ihrer '
      'lizenzierten Ausgabe und tragen je Zeile Ihre Lesart ein: trägt, Anmerkung oder Widerspruch, mit Name, '
      'Datum und Text (FP1). **Das Paket enthält keinen Normtext.** Jede Zeile trägt nur die Abschnittsnummer '
      'und eine eigene Umschreibung der Crew; Anforderungen lesen Sie an Ihrer Ausgabe.')
    a('')
    a('Ihre Unabhängigkeit: Sie beraten VoltPilot nicht bei der Umsetzung dessen, was Sie bewerten (FP2). Eine '
      'Zertifizierung, ein Rechtsgutachten oder eine Prüfung des Betriebsteils ist nicht Ihr Auftrag.')
    a('')
    a('Gebaut von `tools/bewertung/pruefpaket.py`, nie von Hand. Prüfsummen in `pruefpaket.sha256`.')
    a('')
    a('| Angabe | Wert |')
    a('|---|---|')
    a(f'| Stand des Pakets | {tag[8:10]}.{tag[5:7]}.{tag[:4]} (Stichtag der Normfassung) |')
    a(f'| Normfassung | {nf["international"]} · {nf["deutsch"]} |')
    a(f'| Matrix | docs/bewertung/nachweismatrix.json · Fassung {matrix["matrix_fassung"]} · '
      f'SHA-256 `{sha256(matrix_bytes)}` |')
    if bwb:
        a(f'| Bewertung | {_anzeige(bwb_pfad)} · {bwb["kennung"]} · {bwb["zustand"]} · Stand '
          f'`{bwb["stand"][:9]}` · SHA-256 `{sha256(bwb_bytes)}` |')
    else:
        a('| Bewertung | keine; die Urteile der Zusagen stehen darum als offen |')
    a('| Normtext | nicht enthalten; Sie bringen Ihre lizenzierte Ausgabe mit |')
    a('')
    a('## 1 Norm-Teil')
    a('')
    a(f'{len(matrix["norm_teil"])} Zeilen. Je Träger: '
      + ' · '.join(f'{n} {TRAEGER[t]}' for t, n in je_traeger.items()) + '. Gezählt wird der Träger, '
      'nie eine Erfüllung. Jede Zeile ist offen, bis Ihre Lesart sie trägt (RF-03).')
    a('')
    a('Träger: **hält fest** — VoltPilot führt die Aufzeichnung selbst · **misst** — VoltPilot misst und '
      'rechnet · **Verweis** — VoltPilot hält nur den Verweis auf das Original im System des Kunden · '
      '**bleibt beim Kunden** — VoltPilot trägt nichts dazu bei.')
    for n in _reihenfolge(matrix):
        a('')
        a(f'### {n["abschnitt"]}')
        a('')
        a('| Feld | Inhalt |')
        a('|---|---|')
        a(f'| Umschreibung (eigene Worte) | {_zelle(n["umschreibung"])} |')
        a(f'| Träger | {TRAEGER[n["traeger"]]} |')
        a(f'| Kundenaufgabe | {n["kundenaufgabe"]}: {_zelle(ka[n["kundenaufgabe"]]["text"])} |')
        a(f'| Herkunft der Zuordnung | {_zelle(n["herkunft"])} |')
        if n['luecken']:
            a(f'| Lücken des Betreibers | {", ".join(n["luecken"])} |')
        a('')
        if n['zusagen']:
            a('| Zusage | Wortlaut | Urteil im Entwurf |')
            a('|---|---|---|')
            for kz in n['zusagen']:
                a(f'| {kz} | {_zelle(zusagen[kz]["wortlaut"])} | {urteile.get(kz, "offen")} |')
        else:
            a('Keine Zusage von VoltPilot an dieser Zeile.')
    a('')
    a('## 2 Übersicht für Prüfende und Produktbeschreibung')
    a('')
    if beschreibung:
        a('Im Entwurf, gelesen aus `docs/bewertung/produktbeschreibung/`:')
        a('')
        a('| Datei | SHA-256 |')
        a('|---|---|')
        for name, daten in beschreibung:
            a(f'| {name} | `{sha256(daten)}` |')
    else:
        a('**Noch nicht vorhanden.** Beide entstehen in AP-20 IP-21 aus der freigegebenen Bewertung, also nach '
          'Ihrer Lesart (AP-20 IP-12), unter `docs/bewertung/produktbeschreibung/`. Sie lesen sie in einer '
          'eigenen Runde (½ Tag, E4). Ein neuer Bau dieses Pakets nimmt sie dann auf.')
    a('')
    a('## 3 Frageliste')
    a('')
    a('Zu jeder Zeile des Norm-Teils zwei Fragen: **Stimmt die Zuordnung** (Träger, Zusagen, Kundenaufgabe) '
      'und **ist die Lesart tragfähig**, die VoltPilot aus ihr macht? Ihre Antwort ist die Lesart der Zeile. '
      'Dazu die folgenden Fragen, deren Antwort in `antworten` der Vorlage steht:')
    for f in _fragen(matrix):
        a('')
        a(f'**{f["frage"]} · {f["thema"]}** ({", ".join(f["abschnitte"])})')
        a('')
        a(f['text'])
    a('')
    a('## 4 Protokoll-Vorlage')
    a('')
    a('`protokoll-vorlage.json` trägt je Norm-Zeile und je Frage leere Felder. Füllen Sie je gelesener Zeile:')
    a('')
    a('| Feld | Inhalt |')
    a('|---|---|')
    a('| `name` | Ihr Name |')
    a('| `datum` | Tag der Lesart, JJJJ-MM-TT |')
    a('| `lesart` | `traegt`, `anmerkung` oder `widerspruch` |')
    a('| `text` | Ihre Aussage in eigenen Worten, ohne Normtext |')
    a('')
    a('Im Kopf `fachperson`: Name, Rolle, eine Bestätigung der Unabhängigkeit von der Entwicklung (FP2) und die '
      'Ausgabe, an der Sie gelesen haben. Was danach geschieht (AP-20 IP-12): **trägt** macht die Zeile '
      '„nicht maschinell prüfbar“ mit Ihrem Namen; **Anmerkung** hält sie offen mit Ihrem Text; '
      '**Widerspruch** wird eine Lücke des Betreibers, kein Satz ändert sich still (FP3). Eine Zeile ohne Lesart '
      'bleibt offen; Ihre Bestätigung trägt nur die Zeilen, die Sie gelesen haben. Das ausgefüllte Protokoll '
      'bekommt eine eigene Prüfsumme und liegt neben der Matrix (FP4).')
    a('')
    return '\n'.join(z)


def baue(matrix_pfad=nachweismatrix.MATRIX_PFAD, bewertung_pfad=None, beschreibung_pfad=PRODUKTBESCHREIBUNG):
    """Die Dateien des Pakets als {name: bytes}. Wirft ValueError mit den Verstößen."""
    matrix_bytes = matrix_pfad.read_bytes()
    matrix = json.loads(matrix_bytes)
    fehler = nachweismatrix.verstoesse(matrix)
    if fehler:
        raise ValueError(['Vertrag der Matrix rot: ' + f for f in fehler])
    fehler = verstoesse(matrix)
    if fehler:
        raise ValueError(fehler)
    bwb_pfad = bewertung_pfad or juengste_bewertung()
    bwb_bytes = bwb_pfad.read_bytes() if bwb_pfad else b''
    bwb = json.loads(bwb_bytes) if bwb_pfad else None
    beschreibung = []
    if beschreibung_pfad and beschreibung_pfad.is_dir():
        beschreibung = [(p.relative_to(beschreibung_pfad).as_posix(), p.read_bytes())
                        for p in sorted(beschreibung_pfad.rglob('*')) if p.is_file()]
    md = _markdown(matrix, matrix_bytes, bwb, bwb_pfad, bwb_bytes, beschreibung).encode('utf-8')
    vorlage = (json.dumps(_protokoll(matrix, sha256(md)), ensure_ascii=False, indent=1) + '\n').encode('utf-8')
    dateien = {'pruefpaket.md': md, 'protokoll-vorlage.json': vorlage}
    dateien[SUMME] = ''.join(f'{sha256(dateien[n])}  {n}\n' for n in DATEIEN).encode('utf-8')
    return dateien


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument('--check', action='store_true')
    p.add_argument('--aus', type=pathlib.Path, default=AUS_PFAD)
    p.add_argument('--matrix', type=pathlib.Path, default=nachweismatrix.MATRIX_PFAD)
    p.add_argument('--bewertung', type=pathlib.Path)
    p.add_argument('--produktbeschreibung', type=pathlib.Path, default=PRODUKTBESCHREIBUNG)
    try:
        args = p.parse_args(argv)
    except SystemExit:
        return 2
    try:
        dateien = baue(args.matrix, args.bewertung, args.produktbeschreibung)
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except ValueError as e:
        if not isinstance(e.args[0], list):
            print(f'nicht lesbar: {e}', file=sys.stderr)
            return 2
        for f in e.args[0]:
            print(f'rot: {f}')
        return 2 if any(f.startswith('Vertrag der Matrix rot') for f in e.args[0]) else 1
    except OSError as e:
        print(f'nicht lesbar: {e}', file=sys.stderr)
        return 2
    if args.check:
        abweichend = [n for n, daten in dateien.items()
                      if not (args.aus / n).is_file() or (args.aus / n).read_bytes() != daten]
        fremd = sorted(p.name for p in args.aus.glob('*') if p.name not in dateien) if args.aus.is_dir() else []
        for n in abweichend:
            print(f'rot: {_anzeige(args.aus / n)} ist nicht der Bau aus den Quellen')
        for n in fremd:
            print(f'rot: {_anzeige(args.aus / n)} gehört nicht zum Paket')
        if abweichend or fremd:
            print('neu bauen: python3 tools/bewertung/pruefpaket.py')
            return 1
        print(f'Prüfpaket hält: {_anzeige(args.aus)} ist der Bau aus den Quellen')
        return 0
    args.aus.mkdir(parents=True, exist_ok=True)
    for n, daten in dateien.items():
        (args.aus / n).write_bytes(daten)
    print(f'Prüfpaket geschrieben: {_anzeige(args.aus)} ({", ".join(dateien)})')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
