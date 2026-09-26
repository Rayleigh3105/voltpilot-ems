#!/usr/bin/env python3
"""Produktbeschreibung und Übersicht für Prüfende, mit Wächter (AP-20 IP-21, E7 = A, PB1-PB5, NW-4).

Erzeugt aus einer Bewertung (BWB) und der Satz-Quelle `docs/bewertung/beschreibung-saetze.json`
nach `docs/bewertung/produktbeschreibung/`:

- `beschreibung.md`: Funktionen in Kundenwörtern, je Satz die Zusage, an die er gebunden ist, die
  Kundenaufgaben daneben, Restpunkte mit ihrer Grenze (PB1, PB4). Keine Abschnittsnummer (PB3).
- `uebersicht-fuer-pruefende.md`: Abschnitt → was VoltPilot festhält → was bei Ihnen bleibt → Stand
  der Prüfung, mit Stand und Datum der Bewertung und dem Grenz-Satz Wort für Wort (PB3, E8). Dokument auf
  Anfrage, nie im Portal, nie in einem Bericht.
- `produktbeschreibung.json`: Kennung, Zustand, Bewertung mit Prüfsumme, Wächter-Lauf je Satz.
- `produktbeschreibung.sha256`: prüfbar mit `shasum -a 256 -c`.

Der Wächter prüft jeden Satz gegen die Wortliste (AP-14 S1, AP-19 SP2, Rechtsaussagen PB2, Nummern
PB3) und gegen die Bindung: ein Satz an einer Zusage ohne positives Urteil fällt auch ohne verbotenes
Wort (PB1, RF-09). Eine Beschreibung gilt nur mit ihrer Bewertung (PB5): ist sie abgelöst, geändert
oder nicht freigegeben, sagt der Wächter das.

    python3 tools/bewertung/produktbeschreibung.py [--check] [--vor-ausgabe] [--aus <ordner>]
        [--bewertung <BWB-JJJJ-nn.json>] [--quelle <datei>]
    python3 tools/bewertung/produktbeschreibung.py --entwurf <datei> [--bewertung <BWB-JJJJ-nn.json>]

Exit 0: geschrieben, bzw. mit `--check` die Dateien im Repo sind der Bau aus der jüngsten Bewertung;
ein Entwurf wird dabei als Entwurf gemeldet. Mit `--entwurf`: jeder Satz ist zugelassen.
Exit 1: ein Satz mit verbotenem Wort, ein Restpunkt ohne Satz, eine abgelöste oder geänderte Bewertung,
eine Abweichung vom Bau, ein Verweis aus Portal oder Bericht; mit `--vor-ausgabe` zusätzlich jede nicht
freigegebene Bewertung; mit `--entwurf` jeder abgelehnte Satz.
Exit 2: Aufruffehler, unlesbare Datei, `jsonschema` fehlt.
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
BEWERTUNGEN = REPO / 'docs' / 'bewertung' / 'bewertungen'
QUELLE = REPO / 'docs' / 'bewertung' / 'beschreibung-saetze.json'
AUS_PFAD = REPO / 'docs' / 'bewertung' / 'produktbeschreibung'
DATEIEN = ('beschreibung.md', 'uebersicht-fuer-pruefende.md', 'produktbeschreibung.json')
SUMME = 'produktbeschreibung.sha256'
# PB3: kein Verweis aus einer Kundenfläche oder einem Bericht auf die Beschreibung.
KUNDENFLAECHEN = (REPO / 'frontend' / 'portal' / 'src', REPO / 'services' / 'api' / 'src' / 'main')
VERWEIS = re.compile(r'produktbeschreibung/|uebersicht-fuer-pruefende|beschreibung-saetze')

POSITIV = ('belegt', 'nicht_maschinell_pruefbar')

# --------------------------------------------------------------------------- #
# Rahmen-Sätze: §5.8 wörtlich. Sie brauchen keine Zusage, nur den Wortlaut hier (geschlossene Liste).
# --------------------------------------------------------------------------- #

# E8 = A: Wort für Wort `UEMS_NORMGRENZE` in frontend/portal/src/glossar.ts (test_produktbeschreibung prüft das).
NORMGRENZE = ('VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage '
              'zur Konformität mit einer Norm ist damit nicht verbunden.')
# AP-14 S1: die neutrale Nennung, Fuß der Übersicht.
NEUTRALE_ISO_NENNUNG = 'Eine Zertifizierung nach ISO 50001 wird nicht versprochen.'
TITEL = 'Was VoltPilot für Ihr Energiemanagement festhält — und was bei Ihnen bleibt'
ERSTER_SATZ = ('VoltPilot zeigt für jede Fähigkeit, die es zusagt, womit sie geprüft ist, an welchem Stand '
               'und wann.')
KUNDENAUFGABEN_SATZ = 'Was außerhalb von VoltPilot bei Ihnen bleibt, steht bei jeder Funktion dabei.'
UEBERSICHT_TITEL = 'Übersicht für Ihre Prüfenden'
UEBERSICHT_KOPF = ('Diese Übersicht ordnet die Abschnitte der Norm, nach der Sie Ihr Energiemanagement ausrichten, '
                   'den Funktionen von VoltPilot zu und nennt, was bei Ihnen bleibt. Sie beruht auf der '
                   'freigegebenen Bewertung; Datum und Stand stehen im Kopf.')
SPALTEN = ('Abschnitt', 'Was VoltPilot festhält', 'Was bei Ihnen bleibt', 'Stand der Prüfung')
# Träger der Norm-Zeile in Kundenwörtern (Übersicht, Spalte 2).
TRAEGER = {
    'haelt_fest': 'VoltPilot hält fest.',
    'misst': 'VoltPilot misst und rechnet.',
    'verweis': 'VoltPilot hält nur den Verweis auf Ihr Original.',
    'beim_kunden': 'Nichts; das bleibt bei Ihnen.',
}
RAHMEN = (NORMGRENZE, NEUTRALE_ISO_NENNUNG, TITEL, ERSTER_SATZ, KUNDENAUFGABEN_SATZ, UEBERSICHT_TITEL,
          UEBERSICHT_KOPF, *TRAEGER.values())
# Wie in copy.test.ts (AP-14 S1, AP-19 SP2): nur diese beiden Sätze dürfen Konformität und ISO nennen.
ERLAUBTE_SAETZE = (NORMGRENZE, NEUTRALE_ISO_NENNUNG)

# Zusagen, die ein Kunde schon liest: ihr Wortlaut ist ein Kundensatz. Plan-Abnahmen und Betrieb nicht.
KUNDENSATZ_ARTEN = ('release_notiz', 'flaeche', 'anmeldung', 'box_notiz')
URTEIL_WORT = {'belegt': 'belegt', 'nicht_maschinell_pruefbar': 'nicht maschinell prüfbar', 'offen': 'offen',
               'nicht_zugesagt': 'nicht zugesagt'}

# --------------------------------------------------------------------------- #
# Wortliste (PB2): AP-14 S1 und AP-19 SP2 aus frontend/portal/src/copy.test.ts, dazu Rechtsaussagen und
# Nummern (PB3). Python-Fassung derselben Muster; `\w` statt `\p{L}\p{N}`.
# --------------------------------------------------------------------------- #

_I = re.IGNORECASE
WORTLISTE = (
    # AP-14 S1 (copy.test.ts, „Freigabe: Sprach-Wächter und Release-Notiz“)
    ('S1', re.compile(r'ISO[-‑– ]konform', _I)),
    ('S1', re.compile(r'zertifiziert\s+nach', _I)),
    ('S1', re.compile(r'normkonform', _I)),
    ('S1', re.compile(r'ISO\s*50001', _I)),
    # AP-19 SP2 (copy.test.ts, VERBOTEN) samt den AP-18-Wörtern (VERBESSERUNG_VERBOTEN)
    ('SP2', re.compile(r'Nicht[-\s]?konformit(?:ä|ae)t', _I)),
    ('SP2', re.compile(r'(?<!\w)Korrektur[-\s]?ma(?:ß|ss)nahme', _I)),
    ('SP2', re.compile(r'(?<!\w)Aktions[-\s]?pl(?:a|ä)n', _I)),
    ('SP2', re.compile(r'(?<!\w)Ursachen[-\s]?analyse', _I)),
    ('SP2', re.compile(r'(?<!\w)Root[-\s]?Cause', _I)),
    ('SP2', re.compile(r'(?<!\w)(?:hat|haben)\s+gewirkt(?!\w)', _I)),
    ('SP2', re.compile(r'(?<!\w)Einsparung(?:en)?\s+durch(?!\w)', _I)),
    ('SP2', re.compile(r'(?<!\w)CAPA(?!\w)', _I)),
    ('SP2', re.compile(r'konform', _I)),
    ('SP2', re.compile(r'zertifizier', _I)),
    ('SP2', re.compile(r'audit-?(?:fest|sicher|bereit)(?:e[nmrs]?)?(?![^\W\d_])', _I)),
    ('SP2', re.compile(r'revisions-?sicher', _I)),
    ('SP2', re.compile(r'norm-?gerecht', _I)),
    ('SP2', re.compile(r'(?<!\w)EnMS(?!\w)', _I)),
    ('SP2', re.compile(r'management[-\s]?system', _I)),
    ('SP2', re.compile(r'erf(?:ü|ue)llungs[-\s]?grad', _I)),
    ('SP2', re.compile(r'reife[-\s]?grad', _I)),
    ('SP2', re.compile(r'vollst(?:ä|ae)ndig\s+(?:dokumentiert|erf(?:ü|ue)llt|abgedeckt|nachgewiesen)', _I)),
    ('SP2', re.compile(r'(?:Energiemanagement|Nachweise?|Dokumentation)\s+(?:ist|sind)\s+vollst(?:ä|ae)ndig', _I)),
    ('SP2', re.compile(r'alle\s+(?:erforderlichen\s+)?Nachweise\s+(?:liegen|sind)', _I)),
    ('SP2', re.compile(r'bereit\s+f(?:ü|ue)r\s+(?:[^\W\d_]+\s+){0,2}(?:Audit|Zertifizierung)', _I)),
    ('SP2', re.compile(r'(?<!\w)ISO(?!\w)', _I)),
    # PB2: Rechtsaussagen, auch an der Anmeldung
    ('PB2', re.compile(r'(?:DSGVO|GDPR)[-\s]?(?:konform|compliant)', _I)),
    ('PB2', re.compile(r'complian(?:t|ce)', _I)),
    ('PB2', re.compile(r'rechts-?sicher', _I)),
    ('PB2', re.compile(r'garanti(?:e|er)', _I)),
    # PB3 (wie NORM_NUMMER in copy.test.ts): Nummern einer Norm und Abschnitte nur in der Übersicht-Spalte
    ('PB3', re.compile(r'(?<![^\W_])(?:ISO|DIN|EN|IEC|VDI)(?:[\s/-]+(?:EN|ISO|IEC))*[\s-]*\d{3,}')),
    ('PB3', re.compile(r'(?<![\d.,])(?:5000\d|500[1-4]\d|16247)(?!\d)')),
    ('PB3', re.compile(r'(?:Kapitel|Kap\.|Abschnitt|Ziffer|Klausel)\s*\d+(?:\.\d+)+', _I)),
)


# PB3: eine nackte Abschnittsnummer der Gliederung 4 bis 10 (4.1 … 10.2, 7.5.3), kein Datum, keine Kommazahl.
ABSCHNITTSNUMMER = re.compile(r'(?<![\w.])(?:[4-9]|10)\.[1-9](?:\.[1-9])?(?!\w|\.\d)')


def sha256(daten):
    return hashlib.sha256(daten).hexdigest()


def _anzeige(pfad):
    try:
        return pfad.resolve().relative_to(REPO).as_posix()
    except ValueError:
        return pfad.as_posix()


def funde(text):
    """Die verbotenen Wörter eines Textes als [(wort, regel)], nach Stelle; die zwei erlaubten Sätze fallen vorher heraus."""
    rest = text
    for satz in ERLAUBTE_SAETZE:
        rest = rest.replace(satz, ' ')
    treffer = sorted((m.start(), m.group(0).strip(), regel)
                     for regel, muster in WORTLISTE for m in muster.finditer(rest))
    gesehen, aus = set(), []
    for _, wort, regel in treffer:
        if (wort, regel) not in gesehen:
            gesehen.add((wort, regel))
            aus.append((wort, regel))
    return aus


# --------------------------------------------------------------------------- #
# Wächter: Wortliste und Bindung (PB1, PB2, NW-4, RF-09)
# --------------------------------------------------------------------------- #

class Bewertungsstand:
    """Was der Wächter aus einer Bewertung braucht: Urteile, Kundenaufgaben, angenommene Restpunkte."""

    def __init__(self, urteile, kundenaufgaben=(), restpunkte=None, sonst=None):
        self.urteile = dict(urteile)
        self.sonst = sonst   # Urteil einer Zusage, die nicht genannt ist; None: sie steht nicht in der Bewertung
        self.kundenaufgaben = set(kundenaufgaben)
        self.restpunkte = dict(restpunkte or {})

    @classmethod
    def aus(cls, bwb):
        return cls({z['kennzeichen']: z['urteil'] for z in bwb['zusagen']},
                   [k['kennzeichen'] for k in bwb['kundenaufgaben']],
                   {l['kennzeichen']: l for l in bwb['luecken'] if l['zustand'] == 'restpunkt'})


def bindung_von(eintrag):
    for feld in ('zusage', 'kundenaufgabe', 'luecke'):
        if eintrag.get(feld):
            return feld, eintrag[feld]
    return None, None


def pruefe_satz(eintrag, stand):
    """Ein Satz gegen Wortliste und Bindung; die Form von RF-09 plus Regeln und Grund."""
    satz = eintrag['satz']
    gefunden = funde(satz)
    feld, kz = bindung_von(eintrag)
    if feld == 'zusage':
        urteil = stand.urteile.get(kz, stand.sonst)
        gebunden = urteil in POSITIV
        grund = None if gebunden else (f'an {kz} gebunden, {kz} ist {URTEIL_WORT[urteil]}' if urteil
                                       else f'an {kz} gebunden, {kz} steht nicht in der Bewertung')
    elif feld == 'kundenaufgabe':
        gebunden = kz in stand.kundenaufgaben
        grund = None if gebunden else f'an {kz} gebunden, {kz} steht nicht in der Bewertung'
    elif feld == 'luecke':
        gebunden = kz in stand.restpunkte
        grund = None if gebunden else f'an {kz} gebunden, {kz} ist kein angenommener Restpunkt'
    else:
        gebunden = satz in RAHMEN
        grund = None if gebunden else 'an keine Zusage gebunden und kein Rahmen-Satz'
    if gefunden:
        grund = ', '.join(dict.fromkeys(w for w, _ in gefunden)) + ' — verboten'
    return {
        'satz': satz,
        'funde': list(dict.fromkeys(w for w, _ in gefunden)),
        'regeln': sorted({r for _, r in gefunden}),
        'gebunden_an_positive_zeile': gebunden,
        'zugelassen': gebunden and not gefunden,
        'grund': grund,
    }


def pruefe_entwurf(entwurf, stand):
    """Der Wächter über einen Entwurf `{"saetze": [{"satz", "zusage"|"kundenaufgabe"|"luecke"}]}` (RF-09)."""
    ergebnis = [pruefe_satz(s, stand) for s in entwurf['saetze']]
    zugelassen = sum(1 for e in ergebnis if e['zugelassen'])
    return {'ergebnis': ergebnis, 'zugelassen': zugelassen, 'abgelehnt': len(ergebnis) - zugelassen}


def meldung(ergebnis):
    """„Satz 1: auditfest, konform — verboten · Satz 4: an Z-010 gebunden, Z-010 ist offen“."""
    return ' · '.join(f'Satz {i}: {e["grund"]}' for i, e in enumerate(ergebnis['ergebnis'], 1)
                      if not e['zugelassen'])


# --------------------------------------------------------------------------- #
# Bewertung: jüngste, freigegeben, abgelöst (PB5)
# --------------------------------------------------------------------------- #

def juengste_bewertung(ordner=BEWERTUNGEN):
    kandidaten = sorted(ordner.glob('BWB-*.json'))
    return kandidaten[-1] if kandidaten else None


def freigegeben(bwb):
    # Wie die Freigabe des Captains in die Bewertung kommt, legt AP-20 IP-24 fest; gelesen wird `zustand`.
    return bwb['zustand'] == 'freigegeben'


def hinweis(bwb):
    if freigegeben(bwb):
        return (f'Geprüft — Bewertung {bwb["kennung"]}, {bwb["art"]}, freigegeben; die Beschreibung selbst gibt '
                f'der Captain frei')
    return f'Entwurf — Bewertung {bwb["kennung"]}, {bwb["art"]}, nicht freigegeben'


def _tag(iso):
    return f'{iso[8:10]}.{iso[5:7]}.{iso[:4]}'


def _zelle(text):
    return text.replace('|', '\\|').replace('\n', ' ')


# --------------------------------------------------------------------------- #
# Bau
# --------------------------------------------------------------------------- #

class Bau:

    def __init__(self, quelle, bwb, bwb_pfad, bwb_bytes, quelle_pfad, quelle_bytes):
        self.quelle, self.bwb = quelle, bwb
        self.bwb_pfad, self.bwb_bytes = bwb_pfad, bwb_bytes
        self.quelle_pfad, self.quelle_bytes = quelle_pfad, quelle_bytes
        self.stand = Bewertungsstand.aus(bwb)
        self.zusagen = {z['kennzeichen']: z for z in bwb['zusagen']}
        self.ka = {k['kennzeichen']: k for k in bwb['kundenaufgaben']}
        self.norm = {n['abschnitt']: n for n in bwb['norm_teil']}
        self.lauf = {}   # Wächter-Lauf je Satz und Bindung, in der Reihenfolge des Baus
        self.fehler = []

    def pruefe(self, teil, eintrag, pflicht):
        """Prüft einen Satz; ein Wort-Fund an einem Pflichtsatz ist rot, eine fehlende Bindung hält zurück."""
        e = pruefe_satz(eintrag, self.stand)
        feld, kz = bindung_von(eintrag)
        schluessel = (e['satz'], feld, kz)
        if schluessel not in self.lauf:
            self.lauf[schluessel] = {'teile': [], 'bindung': {feld: kz} if feld else None, **e}
        if teil not in self.lauf[schluessel]['teile']:
            self.lauf[schluessel]['teile'].append(teil)
        if e['funde'] and pflicht:
            self.fehler.append(f'{teil}: „{e["satz"]}“ — {", ".join(e["funde"])} ({", ".join(e["regeln"])})')
        return e['zugelassen']

    def ka_satz(self, kz):
        """Der Kundensatz einer Kundenaufgabe: aus §5.8, sonst der Text der Bewertung."""
        for k in self.quelle['kundenaufgaben']:
            if k['kundenaufgabe'] == kz:
                return k
        return {'satz': self.ka[kz]['text'], 'kundenaufgabe': kz}

    def ka_der_zusage(self, kz):
        return list(dict.fromkeys(self.norm[a]['kundenaufgabe'] for a in self.zusagen[kz]['norm'] if a in self.norm))

    def rahmen(self, teil, satz):
        if not self.pruefe(teil, {'satz': satz}, pflicht=True) and satz not in RAHMEN:
            self.fehler.append(f'{teil}: „{satz}“ ist kein Rahmen-Satz')
        return satz

    # ---- Beschreibung ------------------------------------------------------ #

    def beschreibung(self):
        b = self.bwb
        z = []
        a = z.append
        a(f'# {self.rahmen("beschreibung/titel", TITEL)}')
        a('')
        a(f'> **{hinweis(b)}.** Diese Beschreibung gilt nur mit dieser Bewertung (PB5). Gebaut von '
          f'`tools/bewertung/produktbeschreibung.py`, nie von Hand.')
        a('')
        a(f'{self.rahmen("beschreibung/erster_satz", ERSTER_SATZ)} '
          f'{self.rahmen("beschreibung/kundenaufgaben_satz", KUNDENAUFGABEN_SATZ)}')
        a('')
        a('## Was VoltPilot festhält')
        for f in self.quelle['funktionen']:
            if not self.pruefe('beschreibung/funktion', f, pflicht=True):
                continue
            a('')
            a(f['satz'])
            a('')
            a(f'*Gebunden an {f["zusage"]}, {URTEIL_WORT[self.stand.urteile[f["zusage"]]]} in {b["kennung"]}.*')
            for kz in self.ka_der_zusage(f['zusage']):
                k = self.ka_satz(kz)
                if self.pruefe('beschreibung/kundenaufgabe', k, pflicht=True):
                    a('')
                    a(f'Bei Ihnen bleibt: {k["satz"]} *({kz})*')
        a('')
        a('## Was bei Ihnen bleibt')
        a('')
        for kz in sorted(self.ka):
            k = self.ka_satz(kz)
            if self.pruefe('beschreibung/kundenaufgabe', k, pflicht=True):
                a(f'- {k["satz"]} *({kz})*')
        a('')
        a('## Restpunkte')
        a('')
        satz_der = {r['luecke']: r for r in self.quelle['restpunkte']}
        genannt = 0
        for r in self.quelle['restpunkte']:
            self.pruefe('beschreibung/restpunkt', r, pflicht=True)
        for kz, l in sorted(self.stand.restpunkte.items()):
            if kz not in satz_der:
                self.fehler.append(f'beschreibung/restpunkt: {kz} ist Restpunkt in {b["kennung"]} und hat keinen '
                                   f'Satz in der Quelle (PB4)')
                continue
            grenze = f'Grenze: {l.get("grenze")}, bis {_tag(l["bis"])}.' if l.get('bis') else f'Grenze: {l.get("grenze")}.'
            self.pruefe('beschreibung/restpunkt_grenze', {'satz': grenze, 'luecke': kz}, pflicht=True)
            a(f'- {satz_der[kz]["satz"]} {grenze} *({kz})*')
            genannt += 1
        if not genannt:
            a(f'In der Bewertung {b["kennung"]} ist kein Restpunkt angenommen.')
        a('')
        a('## Grenze')
        a('')
        v = self.quelle['verantwortung']
        if self.pruefe('beschreibung/verantwortung', v, pflicht=True):
            a(f'{v["satz"]} *(Gebunden an {v["zusage"]}.)*')
            a('')
        a(self.rahmen('beschreibung/grenze', NORMGRENZE))
        a('')
        return '\n'.join(z)

    # ---- Übersicht für Prüfende -------------------------------------------- #

    def festhaelt(self, n):
        teile = [self.rahmen('uebersicht/traeger', TRAEGER[n['traeger']])]
        satz_der = {f['zusage']: f for f in self.quelle['funktionen']}
        ohne_satz = []
        for kz in n['zusagen']:
            z = self.zusagen[kz]
            if z['urteil'] not in POSITIV:
                continue
            if kz in satz_der:
                eintrag, pflicht = satz_der[kz], True
            elif z['art'] in KUNDENSATZ_ARTEN:
                eintrag, pflicht = {'satz': z['wortlaut'], 'zusage': kz}, False
            else:
                ohne_satz.append(kz)
                continue
            if self.pruefe(f'uebersicht/{n["abschnitt"]}', eintrag, pflicht):
                teile.append(f'{eintrag["satz"]} ({kz})')
        if ohne_satz:
            teile.append(f'Weitere belegte Zusagen: {", ".join(ohne_satz)}.')
        return ' '.join(teile)

    def pruefstand(self, n):
        if n['urteil'] == 'offen':
            text = 'Zuordnung offen: die Lesart der Fachperson steht aus.'
        else:
            text = f'Zuordnung {URTEIL_WORT[n["urteil"]]}.'
        je = {}
        for kz in n['zusagen']:
            je[self.zusagen[kz]['urteil']] = je.get(self.zusagen[kz]['urteil'], 0) + 1
        if je:
            text += ' Zusagen: ' + ' · '.join(f'{je[u]} {URTEIL_WORT[u]}' for u in URTEIL_WORT if u in je) + '.'
        return text

    def uebersicht(self):
        b = self.bwb
        enum = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']
        z = []
        a = z.append
        a(f'# {self.rahmen("uebersicht/titel", UEBERSICHT_TITEL)}')
        a('')
        a(f'> **{hinweis(b)}.** Dokument auf Anfrage; nie im Portal, nie in einem Bericht (PB3). Gebaut von '
          f'`tools/bewertung/produktbeschreibung.py`, nie von Hand.')
        a('')
        a(self.rahmen('uebersicht/kopf', UEBERSICHT_KOPF))
        a('')
        a('| Angabe | Wert |')
        a('|---|---|')
        a(f'| Bewertung | {b["kennung"]}, {b["art"]} |')
        a(f'| Stand | `{b["stand"][:9]}` |')
        a(f'| Datum | {_tag(b["erzeugt_am"])} |')
        a('')
        a(self.rahmen('uebersicht/grenze', NORMGRENZE))
        a('')
        a('| ' + ' | '.join(SPALTEN) + ' |')
        a('|' + '---|' * len(SPALTEN))
        for abschnitt in enum:
            n = self.norm[abschnitt]
            k = self.ka_satz(n['kundenaufgabe'])
            bleibt = k['satz'] if self.pruefe(f'uebersicht/{abschnitt}', k, pflicht=True) else ''
            a(f'| {abschnitt} | {_zelle(self.festhaelt(n))} | {_zelle(bleibt)} | {_zelle(self.pruefstand(n))} |')
        a('')
        a(self.rahmen('uebersicht/fuss', NEUTRALE_ISO_NENNUNG))
        a('')
        return '\n'.join(z)

    # ---- Datensatz --------------------------------------------------------- #

    def datensatz(self):
        b = self.bwb
        lauf = list(self.lauf.values())
        zugelassen = sum(1 for e in lauf if e['zugelassen'])
        return {
            'kennung': self.quelle['kennung'],
            'zustand': 'geprueft' if freigegeben(b) else 'entwurf',
            'hinweis': hinweis(b),
            'erzeugt_von': 'tools/bewertung/produktbeschreibung.py (AP-20 IP-21)',
            'freigegeben_von': None,
            'bewertung': {'kennung': b['kennung'], 'art': b['art'], 'zustand': b['zustand'], 'stand': b['stand'],
                          'datum': b['erzeugt_am'], 'pfad': _anzeige(self.bwb_pfad),
                          'sha256': sha256(self.bwb_bytes)},
            'quelle': {'pfad': _anzeige(self.quelle_pfad), 'sha256': sha256(self.quelle_bytes)},
            'waechter': {'zugelassen': zugelassen, 'zurueckgehalten': len(lauf) - zugelassen, 'saetze': lauf},
        }


def dokument_funde(md):
    """PB2/PB3 über das ganze Dokument: jede Zeile außerhalb von Code-Spannen."""
    ohne_code = re.sub(r'`[^`]*`', ' ', md)
    ohne_spalte = re.sub(r'^\| (?:\d+\.)+\d* \|', '|', ohne_code, flags=re.MULTILINE)
    return funde(ohne_spalte)


def baue(quelle_pfad=QUELLE, bewertung_pfad=None):
    """Die Dateien als {name: bytes}. Wirft ValueError mit den roten Stellen."""
    quelle_bytes = quelle_pfad.read_bytes()
    quelle = json.loads(quelle_bytes)
    bwb_pfad = bewertung_pfad or juengste_bewertung()
    if not bwb_pfad:
        raise ValueError(['keine Bewertung unter docs/bewertung/bewertungen/ (PB1: ohne Bewertung kein Satz)'])
    bwb_bytes = bwb_pfad.read_bytes()
    bwb = json.loads(bwb_bytes)
    bau = Bau(quelle, bwb, bwb_pfad, bwb_bytes, quelle_pfad, quelle_bytes)
    beschreibung = bau.beschreibung()
    uebersicht = bau.uebersicht()
    for name, md in (('beschreibung.md', beschreibung), ('uebersicht-fuer-pruefende.md', uebersicht)):
        bau.fehler += [f'{name}: {w} ({r})' for w, r in dokument_funde(md)]
    if ABSCHNITTSNUMMER.search(re.sub(r'`[^`]*`', ' ', beschreibung)):
        bau.fehler.append('beschreibung.md: eine Abschnittsnummer steht nur in der Übersicht (PB3)')
    if bau.fehler:
        raise ValueError(bau.fehler)
    dateien = {
        'beschreibung.md': beschreibung.encode('utf-8'),
        'uebersicht-fuer-pruefende.md': uebersicht.encode('utf-8'),
        'produktbeschreibung.json': (json.dumps(bau.datensatz(), ensure_ascii=False, indent=1) + '\n').encode('utf-8'),
    }
    dateien[SUMME] = ''.join(f'{sha256(dateien[n])}  {n}\n' for n in DATEIEN).encode('utf-8')
    return dateien


# --------------------------------------------------------------------------- #
# Prüfen (PB5) und Aufruf
# --------------------------------------------------------------------------- #

def verweise(wurzeln=KUNDENFLAECHEN):
    """Stellen in Portal und Berichten, die auf die Beschreibung zeigen (PB3: dort nie)."""
    treffer = []
    for w in wurzeln:
        for p in sorted(w.rglob('*')) if w.is_dir() else []:
            if p.is_file() and p.suffix in ('.ts', '.tsx', '.js', '.json', '.md', '.java', '.html', '.ftl', '.properties'):
                if VERWEIS.search(p.read_text(encoding='utf-8', errors='replace')):
                    treffer.append(_anzeige(p))
    return treffer


def pb5(aus, bewertung_pfad):
    """Gilt die Beschreibung im Ordner noch mit ihrer Bewertung? Liefert (rote Stellen, gelesener Datensatz)."""
    pfad = aus / 'produktbeschreibung.json'
    if not pfad.is_file():
        return [f'{_anzeige(pfad)} fehlt'], None
    alt = json.loads(pfad.read_text(encoding='utf-8'))
    rot = []
    juengste = bewertung_pfad or juengste_bewertung()
    kennung = json.loads(juengste.read_bytes())['kennung'] if juengste else None
    if kennung != alt['bewertung']['kennung']:
        rot.append(f'abgelöst: die Beschreibung beruht auf {alt["bewertung"]["kennung"]}, die jüngste Bewertung ist '
                   f'{kennung}; neu erzeugen (PB5)')
    else:
        jetzt = sha256(juengste.read_bytes())
        if jetzt != alt['bewertung']['sha256']:
            rot.append(f'die Bewertung {kennung} ist nicht mehr die, aus der die Beschreibung entstand (Prüfsumme); '
                       f'neu erzeugen (PB5)')
    return rot, alt


def _waechter_zeile(daten):
    w = daten['waechter']
    zurueck = [e for e in w['saetze'] if not e['zugelassen']]
    zeile = f'Wächter: {w["zugelassen"]} Sätze zugelassen, {w["zurueckgehalten"]} zurückgehalten'
    if zurueck:
        zeile += ': ' + ' · '.join(e['grund'] for e in zurueck)
    return zeile


def _entwurf(pfad, bewertung_pfad):
    entwurf = json.loads(pfad.read_text(encoding='utf-8'))
    if 'positiv_in_bewertung' in entwurf:   # Fixture-Form von RF-09: statt einer Bewertung die positiven Urteile
        stand = Bewertungsstand(entwurf['positiv_in_bewertung'], sonst='offen')
        gegen = 'positiv_in_bewertung der Fixture'
    else:
        bwb_pfad = bewertung_pfad or juengste_bewertung()
        bwb = json.loads(bwb_pfad.read_bytes())
        stand, gegen = Bewertungsstand.aus(bwb), f'{bwb["kennung"]} ({bwb["zustand"]})'
    ergebnis = pruefe_entwurf(entwurf, stand)
    print(f'Wächter über {_anzeige(pfad)} gegen {gegen}: {ergebnis["zugelassen"]} zugelassen, '
          f'{ergebnis["abgelehnt"]} abgelehnt')
    if ergebnis['abgelehnt']:
        print(f'rot: {meldung(ergebnis)}')
        return 1
    return 0


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument('--check', action='store_true')
    p.add_argument('--vor-ausgabe', action='store_true',
                   help='wie --check, dazu rot, solange die Bewertung nicht freigegeben ist (PB5)')
    p.add_argument('--aus', type=pathlib.Path, default=AUS_PFAD)
    p.add_argument('--quelle', type=pathlib.Path, default=QUELLE)
    p.add_argument('--bewertung', type=pathlib.Path)
    p.add_argument('--entwurf', type=pathlib.Path, help='einen Entwurf {"saetze": [...]} gegen den Wächter prüfen')
    try:
        args = p.parse_args(argv)
    except SystemExit:
        return 2
    try:
        if args.entwurf:
            return _entwurf(args.entwurf, args.bewertung)
        dateien = baue(args.quelle, args.bewertung)
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except ValueError as e:
        if not isinstance(e.args[0], list):
            print(f'nicht lesbar: {e}', file=sys.stderr)
            return 2
        for f in e.args[0]:
            print(f'rot: {f}')
        return 1
    except (OSError, KeyError) as e:
        print(f'nicht lesbar: {e}', file=sys.stderr)
        return 2
    daten = json.loads(dateien['produktbeschreibung.json'])
    if not (args.check or args.vor_ausgabe):
        args.aus.mkdir(parents=True, exist_ok=True)
        for n, inhalt in dateien.items():
            (args.aus / n).write_bytes(inhalt)
        print(f'Produktbeschreibung geschrieben: {_anzeige(args.aus)} ({", ".join(dateien)}) · {daten["hinweis"]}')
        print(_waechter_zeile(daten))
        return 0
    rot, _ = pb5(args.aus, args.bewertung)
    rot += [f'{_anzeige(args.aus / n)} ist nicht der Bau aus den Quellen'
            for n, inhalt in dateien.items()
            if not (args.aus / n).is_file() or (args.aus / n).read_bytes() != inhalt]
    rot += [f'{_anzeige(q)} gehört nicht zur Beschreibung'
            for q in sorted(args.aus.glob('*')) if q.name not in dateien] if args.aus.is_dir() else []
    rot += [f'{s} verweist auf die Beschreibung; sie steht nie im Portal oder in einem Bericht (PB3)'
            for s in verweise()]
    for f in rot:
        print(f'rot: {f}')
    if rot:
        print('neu erzeugen: python3 tools/bewertung/produktbeschreibung.py')
        return 1
    if args.vor_ausgabe and not freigegeben(json.loads((args.bewertung or juengste_bewertung()).read_bytes())):
        print(f'rot: {daten["hinweis"]}: keine Ausgabe, keine positive Aussage im Vertrieb (PB5)')
        return 1
    print(f'Beschreibung hält: {daten["kennung"]} beruht auf {daten["bewertung"]["kennung"]} '
          f'({daten["bewertung"]["art"]}, {daten["bewertung"]["zustand"]}) · {daten["hinweis"]}')
    print(_waechter_zeile(daten))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
