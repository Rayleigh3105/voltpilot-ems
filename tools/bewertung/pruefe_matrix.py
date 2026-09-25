#!/usr/bin/env python3
"""Matrix-Prüfer der Bewertung (AP-20 IP-4, E3 = A, NR1-NR9, AP-20 NW-2).

Liest die Nachweismatrix, die Lauf-Berichte eines Standes (Surefire oder Vitest, je Ordner eine
`stand.txt`), das Stand-Blatt des Betreibers, Artefakte und die Lückenliste. Daraus fällt er je
Zeile ein Urteil nach NR1-NR9. Er fährt keine Tests und ändert die Matrix nicht. Er schreibt einen
Entwurf des Bewertungsberichts BWB-JJJJ-nn als `.json` und `.md`, dazu `.sha256` mit den
Prüfsummen beider Dateien. Freigeben kann ihn nur der Captain (G5). Kein Tor, kein Läufer (G4).
Z-015 urteilt er über die Übungen des Betreibers (`--uebungen`, Leser `uebungen.py`) und Q15 im
Stand-Blatt: belegt nur mit beidem, die Übung mit Stand und nicht fällig (BT1, BT2, NR3, NR4).

    python3 tools/bewertung/pruefe_matrix.py [--laeufe <ordner>]… [--artefakte <ordner>]…
        [--blatt <stand-blatt>] [--uebungen <ordner>] [--stand <commit>] [--heute JJJJ-MM-TT] [--aus <ordner>]
        [--kennung BWB-JJJJ-nn] [--art gebaut|ausgeliefert] [--matrix <datei>] [--luecken <datei>]

Exit 0: Entwurf geschrieben; die Zählung sagt, was belegt und was offen ist. Das ist kein Tor.
Exit 2: Aufruffehler, unlesbare Datei, `jsonschema` fehlt, Vertrag oder Lückenliste rot, kein
Stand, oder die Kennung gibt es schon (G3: ein Bericht wird nie überschrieben).
"""

import argparse
import datetime
import functools
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import types
import xml.etree.ElementTree as ET

HIER = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HIER))
sys.path.insert(0, str(HIER.parent / 'freigabe'))
import luecken  # noqa: E402
import nachweismatrix  # noqa: E402
import pruefe_tor  # noqa: E402
import uebungen  # noqa: E402

REPO = nachweismatrix.REPO
AUS_PFAD = REPO / 'docs' / 'bewertung' / 'bewertungen'

GRENZ_SATZ = ('Dieser Bericht zeigt, welche Zusagen von VoltPilot an welchem Stand mit welchem Nachweis '
              'geprüft sind. Er ist keine Zertifizierung, keine Förderlistung und keine rechtliche Bewertung.')
ARTEN = {'gebaut': 'gebauter Stand', 'ausgeliefert': 'ausgelieferter Stand'}
KENNUNG = re.compile(r'^BWB-(\d{4})-(\d{2})$')
COMMIT = re.compile(r'^[0-9a-f]{7,40}$')

# Die Kandidaten, die der Prüfer lesen kann: die Formen der Klammer (tools/bewertung/klammer.py,
# AP-20 IP-6). Eine Klasse oder Testdatei darf eine Anmerkung in Klammern tragen. Alles andere ist
# ein Kandidat ohne lesbaren Lauf und bleibt offen (NR7), auch „pfad[:zeile] Bemerkung“ ohne Artefakt.
ANMERKUNG = r'(?:\s+\(.*\))?$'
KLASSE = re.compile(r'^(?P<klasse>[A-Z][A-Za-z0-9_]*)(?:#(?P<methode>[A-Za-z_][A-Za-z0-9_]*))?' + ANMERKUNG)
DATEI_FALL = re.compile(r'^(?P<datei>[^\s#]+\.(?:py|go|ts|tsx|js|mjs|cjs))#(?P<fall>.+)$')
TESTDATEI = re.compile(r'^(?P<datei>(?:[\w.-]+/)*(?:[\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?|test_\w+\.py|\w+_test\.go))'
                       + ANMERKUNG)
ARTEFAKT = re.compile(r'^\S+\s+→\s*(?P<artefakt>[\w.-]+\.json)' + ANMERKUNG)

# Ein Eintrag in `wer_liefert`, den der Lauf selbst liefert. Jeder andere nennt einen Rest, den kein
# Kandidat trägt (AP-20 IP-6), und hält die Zusage offen; einen Rest des Betreibers deckt nur seine
# Bestätigung im Stand-Blatt unter dem Kennzeichen der Zusage (NR4).
LAUF_EINTRAEGE = ('Lauf am Stand (AP-20 IP-10)', 'neuer Lauf an diesem Stand (AP-20 IP-10)')

# NR1: ein Artefakt zählt nur, wenn ein Werkzeug seinen Inhalt prüft. Die Leser sind die des
# Tor-Prüfers; ein weiteres Artefakt braucht hier einen Leser, sonst bleibt es offen.
ARTEFAKT_LESER = {
    'probe.json': pruefe_tor.nw1_generalprobe,
    'rueckweg.json': pruefe_tor.nw8_rueckweg,
}

# BT1, BT2: eine Wiederherstellung zählt nur mit Übung und Artefakt. Für diese Zusagen urteilt über
# „→ rueckweg.json“ die Rückweg-Übung aus docs/bewertung/uebungen/ zusammen mit Q15 im Stand-Blatt,
# nicht ein loses Artefakt; den Rest des Betreibers („Q15 bestätigen und die Übung fahren“) trägt
# derselbe Befund.
UEBUNG_PFLICHT = ('Z-015',)

# Reihenfolge, in der ein schlechter Befund eines Laufs einen anderen verdrängt.
SCHLECHT = ('rot', 'uebersprungen', 'fall_fehlt')


class EingabeFehler(Exception):
    """Aufruf oder Eingabe unbrauchbar - lieber abbrechen als raten."""


def sha256(pfad):
    return hashlib.sha256(pathlib.Path(pfad).read_bytes()).hexdigest()


def anzeige(pfad):
    pfad = pathlib.Path(pfad)
    try:
        return str(pfad.resolve().relative_to(REPO))
    except ValueError:
        return str(pfad)


rollen = uebungen.rollen


def offen(grund, text, wer):
    return {'ergebnis': 'offen', 'grund': grund, 'text': text, 'wer': wer}


def ergebnis_ohne_objekte(e):
    """Der Befund je Kandidat für den Bericht: ohne Nachweis und Bestätigung, die an der Zeile stehen."""
    return {k: v for k, v in e.items() if k not in ('nachweis', 'bestaetigung')}


# --------------------------------------------------------------------------- #
# Eingaben: Ordner mit stand.txt, Lauf-Berichte, Kontext
# --------------------------------------------------------------------------- #

class Ordner:
    """Ein Ordner mit Berichten oder Artefakten und seiner stand.txt (NR3)."""

    def __init__(self, pfad):
        self.pfad = pathlib.Path(pfad)
        if not self.pfad.is_dir():
            raise EingabeFehler(f'{pfad}: kein Ordner')
        self.stand_txt = pruefe_tor.lies_stand_txt(self.pfad)
        felder = self.stand_txt['felder'] if self.stand_txt else {}
        self.sha = self.stand_txt['stand'] if self.stand_txt else ''
        self.gefahren_von = felder.get('gefahren_von', '')
        self.datum = felder.get('datum', '')

    def grund(self, ctx):
        """None, wenn Berichte dieses Ordners den geprüften Stand tragen; sonst (grund, text)."""
        if not hasattr(self, '_grund'):
            self._grund = self._stand_befund(ctx)
        return self._grund

    def _stand_befund(self, ctx):
        kurz = ctx.stand[:9]
        if self.stand_txt is None:
            return 'ohne_stand_txt', (f'{anzeige(self.pfad)} hat keine stand.txt - ohne sie trägt ein Bericht '
                                      f'keinen Stand (NR3)')
        if not COMMIT.match(self.sha):
            return 'ohne_stand_txt', f'die stand.txt in {anzeige(self.pfad)} nennt keinen Commit (NR3)'
        if not pruefe_tor.gleicher_stand(self.sha, ctx.stand):
            if ctx.ist_vorfahre(self.sha):
                return 'aelterer_stand', (f'älterer Stand: der Bericht stammt laut stand.txt von {self.sha[:9]}, '
                                          f'geprüft wird {kurz} - ein älterer Lauf trägt den neueren Stand nicht (NR3)')
            return 'anderer_stand', (f'anderer Stand: der Bericht stammt laut stand.txt von {self.sha[:9]}, '
                                     f'geprüft wird {kurz} (NR3)')
        if not self.gefahren_von:
            return 'ohne_gefahren_von', (f'die stand.txt in {anzeige(self.pfad)} nennt nicht, wer gefahren hat '
                                         f'(Zeile „gefahren_von:“)')
        if self.datum:
            try:
                tag = datetime.date.fromisoformat(self.datum)
            except ValueError:
                return 'datum_unlesbar', f'„datum: {self.datum}“ in der stand.txt ist kein Datum JJJJ-MM-TT'
            if tag > ctx.heute:
                return 'datum_in_zukunft', f'„datum: {self.datum}“ in der stand.txt liegt nach dem Prüftag'
        return None

    def datum_fuer(self, datei):
        """Tag des Laufs: `datum:` der stand.txt, sonst der Zeitpunkt der Berichtsdatei."""
        if self.datum:
            return self.datum
        zeit = datetime.datetime.fromtimestamp(pathlib.Path(datei).stat().st_mtime, datetime.timezone.utc)
        return zeit.date().isoformat()

    def eingabe(self, ctx):
        grund = self.grund(ctx)
        return {'ordner': anzeige(self.pfad), 'stand': self.sha or None, 'datum': self.datum or None,
                'gefahren_von': self.gefahren_von or None, 'traegt_den_stand': grund is None,
                'grund': grund[0] if grund else None}


class Lauf(Ordner):
    """Ein Lauf-Ordner: jede JUnit-Datei darin - Surefire `TEST-*.xml`, Vitest und `node --test` mit
    `--reporter=junit`, pytest `--junitxml`, Go über gotestsum oder go-junit-report."""

    def __init__(self, pfad):
        super().__init__(pfad)
        self.suiten, self.faelle, self.gruppen, self.unlesbar = [], [], [], []
        self.fehler_ohne_fall = {}
        for datei in sorted(self.pfad.rglob('*.xml')):
            try:
                wurzel = ET.parse(datei).getroot()
            except ET.ParseError:
                self.unlesbar.append(anzeige(datei))
                continue
            self._lies(datei, wurzel, wurzel.get('name') or '')
            self.fehler_ohne_fall[datei] = _fehler_ohne_fall(datei, wurzel)

    def _lies(self, datei, knoten, suite):
        if knoten.tag == 'testsuite':
            self.suiten.append((datei, knoten))
            suite = knoten.get('name') or ''
        for kind in knoten:
            if kind.tag == 'testcase':
                self.faelle.append((datei, suite, kind))
            elif kind.tag in ('testsuite', 'testsuites'):
                if kind.tag == 'testsuite':
                    self.gruppen.append((datei, suite, kind))
                self._lies(datei, kind, suite)

    def eingabe(self, ctx):
        return {**super().eingabe(ctx), 'suiten': len(self.suiten), 'faelle': len(self.faelle),
                'unlesbar': self.unlesbar}


class Kontext:
    def __init__(self, stand, heute, wurzel=REPO, laeufe=(), artefakte=(), blatt=None, liste=None,
                 uebungen_ordner=uebungen.ORDNER):
        self.wurzel = pathlib.Path(wurzel)
        self.heute = heute
        self.stand = self._voll(stand)
        self.laeufe = [Lauf(p) for p in laeufe]
        self.artefakte = [Ordner(p) for p in artefakte]
        self.blatt_pfad = pathlib.Path(blatt) if blatt else None
        self.blatt = pruefe_tor.lies_stand(self.blatt_pfad) if self.blatt_pfad else None
        self.luecken = {l['kennzeichen']: l for l in (liste or {}).get('luecken', [])}
        self.rollen = rollen()
        self.uebungen_ordner = pathlib.Path(uebungen_ordner)

    @functools.cached_property
    def uebungen(self):
        """Die Übungen mit dem Leser aus uebungen.py: (verstöße, ergebnisse)."""
        return uebungen.lies(self.uebungen_ordner, self.blatt_pfad)

    def git(self, *argv):
        return subprocess.run(['git', '-C', str(self.wurzel), *argv], capture_output=True, text=True, check=False)

    def _voll(self, stand):
        if stand is None:
            lauf = self.git('rev-parse', 'HEAD')
            if lauf.returncode:
                raise EingabeFehler('kein Stand: --stand <commit> angeben oder in einem git-Repo aufrufen')
            return lauf.stdout.strip()
        lauf = self.git('rev-parse', '--verify', '--quiet', f'{stand}^{{commit}}')
        voll = lauf.stdout.strip() if lauf.returncode == 0 else stand
        if not COMMIT.match(voll):
            raise EingabeFehler(f'--stand {stand}: kein Commit (7 bis 40 Zeichen hex)')
        return voll

    def ist_vorfahre(self, sha):
        return self.git('merge-base', '--is-ancestor', sha, self.stand).returncode == 0

    def nr4(self, von, datum, aussage):
        """NR4: eine Bestätigung zählt nur mit Person, Datum und Aussage; sonst (grund, text)."""
        von = (von or '').strip()
        if not von or von.lower() in self.rollen:
            return 'ohne_person', (f'Bestätigung ohne Person: „{von or "(leer)"}“ ist keine benannte Person, '
                                   f'die Zeile bleibt offen (NR4)')
        try:
            tag = datetime.date.fromisoformat(datum or '')
        except ValueError:
            return 'ohne_datum', f'Bestätigung von {von} ohne Datum JJJJ-MM-TT (NR4)'
        if tag > self.heute:
            return 'datum_in_zukunft', f'Bestätigung von {von} ist auf {datum} datiert, nach dem Prüftag'
        if not (aussage or '').strip():
            return 'ohne_aussage', f'Bestätigung von {von} am {datum} ohne Aussage (NR4)'
        return None

    def luecken_fuer(self, kennung, genannt):
        """NR6: nicht behobene Lücken halten offen; ein Restpunkt begrenzt nur (LU4)."""
        haelt, rest = [], []
        for kz in sorted(set(genannt) | {kz for kz, l in self.luecken.items() if kennung in l['betrifft']}):
            l = self.luecken.get(kz)
            if l is None:
                continue
            if l['zustand'] in luecken.HAELT_OFFEN:
                haelt.append(l)
            elif l['zustand'] == 'restpunkt':
                rest.append(l)
        return haelt, rest


# --------------------------------------------------------------------------- #
# Ein Kandidat - ein Befund
# --------------------------------------------------------------------------- #

def _ist_fall(name, fall):
    """Ein Fall im Bericht: wörtlich, parametrisiert („m(String)[1]“, „f[a]“) oder unter describe („… > f“)."""
    return name == fall or name.startswith((fall + '(', fall + '[')) or name.endswith(' > ' + fall)


def _fehler_ohne_fall(datei, wurzel):
    """`node --test` schreibt den Fehler eines Tests mit Untertests an keinen `<testcase>`, nur in die
    Summe `<!-- fail N -->` am Ende; was darin über die roten Fälle hinausgeht, gehört keinem Fall."""
    summe = re.search(r'<!--\s*fail\s+(\d+)\s*-->', datei.read_text(encoding='utf-8', errors='replace'))
    if summe is None:
        return 0
    rot = sum(1 for f in wurzel.iter('testcase') if _zustand(f) == 'rot')
    return max(0, int(summe[1]) - rot)


def _zustand(fall):
    if fall.find('failure') is not None or fall.find('error') is not None:
        return 'rot'
    return 'uebersprungen' if fall.find('skipped') is not None else 'gruen'


def _gruppen_zustand(gruppe, fehler_ohne_fall):
    """Ein Test mit Untertests (`node --test` schreibt ihn als `<testsuite>`): grün nur, wenn jeder Untertest
    grün ist; ein roter macht ihn rot, ein übersprungener übersprungen, ohne Untertest ist nichts gelaufen.
    Ein Fehler im Bericht, der keinem Fall gehört, kann seiner sein - dann ist er rot."""
    zustaende = [_zustand(f) for f in gruppe.iter('testcase')]
    if fehler_ohne_fall or 'rot' in zustaende or _zustand(gruppe) == 'rot':
        return 'rot'
    return 'uebersprungen' if not zustaende or 'uebersprungen' in zustaende else 'gruen'


def _befund(suiten, faelle, fall, gruppen=(), fehler_ohne_fall=None):
    """(befund, text, datei) eines Ziels in einem Lauf-Ordner; NR2: übersprungen ist nicht grün, rot nicht.
    Ein Fall ist ein `<testcase>` oder ein `<testsuite>` mit Untertests (`node --test`)."""
    if fall is None:
        zahlen = [pruefe_tor.zaehler(s) for _, s in suiten]
        tests, rot = sum(z['tests'] for z in zahlen), sum(z['failures'] + z['errors'] for z in zahlen)
        sprung = sum(z['skipped'] for z in zahlen)
        if rot:
            return 'rot', f'{rot} von {tests} Tests rot', suiten[0][0]
        if sprung:
            return 'uebersprungen', f'{sprung} von {tests} Tests übersprungen - übersprungen ist nicht grün (NR2)', \
                suiten[0][0]
        if not faelle:
            if tests == 0:
                return 'uebersprungen', 'nichts ausgeführt - übersprungen ist nicht grün (NR2)', suiten[0][0]
            return 'gruen', f'{tests} Tests grün', suiten[0][0]
        zustaende = [_zustand(f) for _, f in faelle]
    else:
        faelle = [(d, f) for d, f in faelle if _ist_fall(f.get('name') or '', fall)]
        gruppen = [(d, g) for d, g in gruppen if _ist_fall(g.get('name') or '', fall)]
        if not faelle and not gruppen:
            return 'fall_fehlt', f'der Fall „{fall}“ steht nicht im Bericht', None
        zustaende = [_zustand(f) for _, f in faelle] + \
            [_gruppen_zustand(g, (fehler_ohne_fall or {}).get(d, 0)) for d, g in gruppen]
        faelle = faelle + gruppen
    for schlecht, satz in (('rot', 'rot'), ('uebersprungen', 'übersprungen - übersprungen ist nicht grün (NR2)')):
        if schlecht in zustaende:
            return schlecht, f'{zustaende.count(schlecht)} von {len(zustaende)} Fällen {satz}', faelle[0][0]
    return 'gruen', f'{len(zustaende)} {"Fall" if len(zustaende) == 1 else "Fälle"} grün', faelle[0][0]


def _test(ctx, fundstelle, suite_passt, fall_gehoert, fall):
    """NR1-NR3: ein Test zählt nur mit grünem Lauf-Bericht dieses Standes."""
    treffer = []
    for lauf in ctx.laeufe:
        suiten = [(d, s) for d, s in lauf.suiten if suite_passt(s.get('name') or '')]
        faelle = [(d, f) for d, suite, f in lauf.faelle if fall_gehoert(suite, f)]
        gruppen = [(d, g) for d, _, g in lauf.gruppen
                   if any(fall_gehoert(g.get('name') or '', f) for f in g.iter('testcase'))]
        if suiten or faelle or gruppen:
            treffer.append((lauf, suiten, faelle, gruppen))
    if not treffer:
        woher = (f'in {len(ctx.laeufe)} Lauf-Ordner{"n" if len(ctx.laeufe) > 1 else ""}' if ctx.laeufe
                 else '- kein Lauf-Ordner angegeben (--laeufe)')
        return offen('kein_bericht', f'kein Lauf-Bericht für {fundstelle} {woher}; Lauf am Stand '
                                     f'{ctx.stand[:9]} (NR7)', 'Crew')
    am_stand = [t for t in treffer if t[0].grund(ctx) is None]
    if not am_stand:
        grund, text = treffer[0][0].grund(ctx)
        return offen(grund, f'{fundstelle}: {text}', 'Crew')
    befunde = [(lauf, *_befund(suiten, faelle, fall, gruppen, lauf.fehler_ohne_fall))
               for lauf, suiten, faelle, gruppen in am_stand]
    for schlecht in SCHLECHT:
        for lauf, befund, text, datei in befunde:
            if befund == schlecht:
                wo = f' im Bericht {anzeige(datei)}' if datei else ''
                return offen(befund, f'{fundstelle}{wo}: {text}', 'Crew')
    lauf, _, text, datei = befunde[0]
    nachweis = {'art': 'test_lauf', 'fundstelle': fundstelle, 'stand': lauf.sha, 'lauf': anzeige(datei),
                'lauf_sha256': sha256(datei), 'datum': lauf.datum_fuer(datei), 'gefahren_von': lauf.gefahren_von}
    return {'ergebnis': 'belegt', 'grund': 'gruen', 'text': f'{fundstelle}: {text}', 'wer': None, 'nachweis': nachweis}


def _klasse(klasse):
    """Suite und Fälle einer Java-Klasse: Surefire nennt sie voll qualifiziert."""
    kurz = lambda name: (name or '').rsplit('.', 1)[-1]  # noqa: E731
    return (lambda name: kurz(name) == klasse,
            lambda suite, f: kurz(f.get('classname') or suite) == klasse)


def _pfad_passt(pfad, wert):
    wert = (wert or '').replace('\\', '/')
    return bool(wert) and (wert == pfad or pfad.endswith('/' + wert) or wert.endswith('/' + pfad))


def _py_modul_passt(modul, klasse):
    """pytest nennt die Datei als Modul, relativ zu seinem Wurzelordner, gefolgt von Klassen."""
    teile = (klasse or '').split('.')
    return any(modul == m or modul.endswith('.' + m) for m in ('.'.join(teile[:i]) for i in range(len(teile), 0, -1)))


@functools.lru_cache(maxsize=None)
def _go_paket(pfad):
    """Import-Pfad des Pakets einer Go-Testdatei aus dem go.mod darüber; gotestsum nennt die Suite so."""
    ordner = (REPO / pfad).parent
    for oben in (ordner, *ordner.parents):
        if oben != REPO and REPO not in oben.parents:
            return None
        mod = oben / 'go.mod'
        if mod.is_file():
            modul = re.search(r'^module\s+(\S+)', mod.read_text(encoding='utf-8'), re.M)
            rel = ordner.relative_to(oben).as_posix()
            return None if modul is None else (modul[1] if rel == '.' else f'{modul[1]}/{rel}')
    return None


def _datei(pfad):
    """Suite und Fälle einer Testdatei: Vitest nennt den Pfad in Suite und classname, `node --test` in
    `file`, pytest das Modul in classname, gotestsum das Paket."""
    modul = pfad[:-3].replace('/', '.') if pfad.endswith('.py') else None
    paket = _go_paket(pfad) if pfad.endswith('.go') else None

    def gehoert(suite, f):
        if any(_pfad_passt(pfad, w) for w in (f.get('file'), f.get('classname'), suite)):
            return True
        if modul and _py_modul_passt(modul, f.get('classname')):
            return True
        return bool(paket) and paket in (suite, f.get('classname'))

    return (lambda name: _pfad_passt(pfad, name) or (bool(paket) and name == paket)), gehoert


def _artefakt(ctx, name):
    """NR1: ein Werkzeug zählt nur mit seinem Artefakt - geprüft vom Leser des Tor-Prüfers."""
    leser = ARTEFAKT_LESER.get(name)
    if leser is None:
        return offen('kein_leser', (f'für {name} hat der Matrix-Prüfer keinen Leser; ein Artefakt zählt nur, '
                                    f'wenn ein Werkzeug seinen Inhalt prüft (NR1)'), 'Crew')
    fund = [o for o in ctx.artefakte if (o.pfad / name).is_file()]
    if not fund:
        woher = 'liegt in keinem --artefakte-Ordner' if ctx.artefakte else 'fehlt - kein --artefakte-Ordner angegeben'
        return offen('artefakt_fehlt', f'{name} {woher}; die Übung ist nicht gefahren', 'Betreiber')
    am_stand = [o for o in fund if o.grund(ctx) is None]
    if not am_stand:
        grund, text = fund[0].grund(ctx)
        return offen(grund, f'{name}: {text}', 'Betreiber')
    ordner = am_stand[0]
    urteil, text = leser(types.SimpleNamespace(generalprobe=ordner.pfad))
    if urteil != pruefe_tor.BELEGT:
        return offen('artefakt_offen', text, 'Betreiber')
    datei = ordner.pfad / name
    nachweis = {'art': 'werkzeug_artefakt', 'fundstelle': name, 'stand': ordner.sha, 'lauf': anzeige(datei),
                'lauf_sha256': sha256(datei), 'datum': ordner.datum_fuer(datei), 'gefahren_von': ordner.gefahren_von}
    return {'ergebnis': 'belegt', 'grund': 'gruen', 'text': text, 'wer': None, 'nachweis': nachweis}


def _uebung(ctx, kennung):
    """BT1, BT2, NR3, NR4: belegt nur mit Q15 (Person, Datum, Aussage) UND einer durchgeführten
    Rückweg-Übung, die ihren Stand trägt und nicht fällig ist."""
    rot, ergebnisse = ctx.uebungen
    wieder = sorted((e for e in ergebnisse if e['art'] == 'wiederherstellung' and kennung in e['betrifft']
                     and e['uebung_zustand'] == 'durchgefuehrt' and e['datum'] <= ctx.heute.isoformat()),
                    key=lambda e: e['datum'])
    if not wieder:
        rot_text = f'; {len(rot)} Verstoß/Verstöße in den Übungen zählen nicht (uebungen.py)' if rot else ''
        return offen('uebung_fehlt', f'keine durchgeführte Rückweg-Übung für {kennung} in '
                                     f'{anzeige(ctx.uebungen_ordner)}{rot_text} - fällig vor dem Rollout '
                                     f'(BT2, AP-14 NW-8)', 'Betreiber')
    e = wieder[-1]
    if not e['stand']:
        return offen('uebung_ohne_stand', f'{e["kennzeichen"]} vom {e["datum"]} trägt keinen Stand des '
                                          f'Produktions-Images; ein Beleg gilt nur an seinem Stand (NR3)', 'Betreiber')
    if ctx.heute.isoformat() > e['naechste_faellig']:
        return offen('uebung_faellig', f'Betreiber: Übung fällig - {e["kennzeichen"]} vom {e["datum"]} belegt nur '
                                       f'bis {e["naechste_faellig"]} (BT1, Rhythmus {uebungen.RHYTHMUS_MONATE} '
                                       f'Monate)', 'Betreiber')
    q15_urteil, q15_text = uebungen.q15(ctx.blatt_pfad)
    if q15_urteil != 'nicht_maschinell_pruefbar':
        return offen('q15_offen', q15_text, 'Betreiber')
    q = ctx.blatt[uebungen.Q15_PUNKT]
    if grund := ctx.nr4(q['durch'], q['am'], q['beleg']):
        return offen(*grund, 'Betreiber')
    datei = ctx.uebungen_ordner / e['artefakt']['pfad']
    nachweis = {'art': 'werkzeug_artefakt', 'fundstelle': f'Übung {e["kennzeichen"]} → rueckweg.json',
                'stand': e['stand'], 'lauf': anzeige(datei), 'lauf_sha256': e['artefakt']['sha256'],
                'datum': e['datum'], 'gefahren_von': e['person']}
    return {'ergebnis': 'belegt', 'grund': 'gruen',
            'text': (f'{e["kennzeichen"]} am Stand {e["stand"]}, nächste fällig {e["naechste_faellig"]}; '
                     f'Q15 {q["durch"]} am {q["am"]}: {q["beleg"]}'), 'wer': None, 'nachweis': nachweis}


def _bestaetigt(ctx, von, datum, aussage, nachweis):
    grund = ctx.nr4(von, datum, aussage)
    if grund:
        return offen(*grund, 'Betreiber')
    return {'ergebnis': 'bestaetigt', 'grund': 'bestaetigt', 'text': f'{von} bestätigt am {datum}: {aussage}',
            'wer': None, 'bestaetigung': {'von': von, 'datum': datum, 'aussage': aussage}, 'nachweis': nachweis}


def _blatt(ctx, kennung, reste):
    """Den Rest des Betreibers beantwortet allein sein Stand-Blatt, unter dem Kennzeichen der Zusage."""
    was = '; '.join(r['was'] for r in reste)
    if ctx.blatt is None:
        return offen('blatt_fehlt', f'{was} - kein --blatt angegeben; das bestätigt der Betreiber im Stand-Blatt',
                     'Betreiber')
    eintrag = ctx.blatt.get(kennung)
    if eintrag is None:
        return offen('blatt_fehlt', f'{was} - im Stand-Blatt {ctx.blatt_pfad.name} fehlt der Punkt „{kennung}“',
                     'Betreiber')
    if eintrag.get('bestaetigt', '').lower() not in ('ja', 'yes', 'true'):
        grund = eintrag.get('beleg') or eintrag.get('grund') or 'ohne Begründung'
        return offen('nicht_bestaetigt', f'{was} - „{kennung}“ steht im Stand-Blatt auf bestaetigt: '
                                         f'{eintrag.get("bestaetigt") or "(leer)"} ({grund})', 'Betreiber')
    von, datum = eintrag.get('durch', ''), eintrag.get('am', '')
    aussage = eintrag.get('aussage') or eintrag.get('beleg') or ''
    nachweis = {'art': 'betreiber_bestaetigung', 'fundstelle': f'Stand-Blatt {kennung}', 'stand': ctx.stand,
                'lauf': ctx.blatt_pfad.name, 'lauf_sha256': sha256(ctx.blatt_pfad), 'datum': datum,
                'gefahren_von': von}
    return _bestaetigt(ctx, von, datum, aussage, nachweis)


def kandidat(ctx, text, kennung=None):
    """Ein Befund je Kandidat. Ein Kandidat, den der Prüfer nicht lesen kann, ist kein Beleg (NR7)."""
    if (m := ARTEFAKT.match(text)) and m['artefakt'] == 'rueckweg.json' and kennung in UEBUNG_PFLICHT:
        befund = _uebung(ctx, kennung)
    elif m:
        befund = _artefakt(ctx, m['artefakt'])
    elif m := DATEI_FALL.match(text):
        befund = _test(ctx, text, *_datei(m['datei']), m['fall'])
    elif m := KLASSE.match(text):
        fundstelle = f'{m["klasse"]}#{m["methode"]}' if m['methode'] else m['klasse']
        befund = _test(ctx, fundstelle, *_klasse(m['klasse']), m['methode'])
    elif m := TESTDATEI.match(text):
        befund = _test(ctx, m['datei'], *_datei(m['datei']), None)
    else:
        befund = offen('kandidat_ohne_lauf', (f'„{text}“ nennt keinen Lauf, den der Prüfer lesen kann - '
                                              f'Klasse#methode, Testdatei#Fall oder „werkzeug → artefakt.json“ '
                                              f'benennen (NR1, NR7)'), 'Crew')
    return {'kandidat': text, **befund}


# --------------------------------------------------------------------------- #
# Urteil je Zeile
# --------------------------------------------------------------------------- #

def _wer_liefert(befunde, aus_matrix=None):
    """Wer liefert: je offenem Befund; eine Lücke bringt ihre eigenen Lieferanten mit."""
    eintraege = []
    for b in befunde:
        if b['ergebnis'] == 'offen':
            eintraege += ([{'wer': w['wer'], 'was': f'{b["kandidat"]}: {w["was"]}'} for w in b['liefert']]
                          if b.get('liefert') else [{'wer': b['wer'], 'was': b['text']}])
    eintraege += aus_matrix or []
    return list({(e['wer'], e['was']): e for e in eintraege}.values())


def _restbefunde(ctx, z):
    """Was `wer_liefert` außer dem Lauf nennt, trägt kein Kandidat (AP-20 IP-6): es hält offen, bis es
    geliefert und aus der Matrix genommen ist. Den Rest des Betreibers deckt sein Stand-Blatt (NR4)."""
    reste = [w for w in z.get('wer_liefert') or [] if not (w['wer'] == 'Crew' and w['was'] in LAUF_EINTRAEGE)]
    befunde = [{'kandidat': 'wer_liefert', **offen('rest_offen', r['was'], r['wer'])}
               for r in reste if r['wer'] != 'Betreiber']
    betreiber = [r for r in reste if r['wer'] == 'Betreiber']
    if betreiber and z['kennzeichen'] in UEBUNG_PFLICHT and any(
            (m := ARTEFAKT.match(k)) and m['artefakt'] == 'rueckweg.json' for k in z['nachweis_kandidaten']):
        betreiber = []
    if betreiber:
        befunde.append({'kandidat': f'Stand-Blatt {z["kennzeichen"]}', **_blatt(ctx, z['kennzeichen'], betreiber)})
    return befunde


def _lueckenbefunde(ctx, kennung, genannt):
    haelt, rest = ctx.luecken_fuer(kennung, genannt)
    befunde = []
    for l in haelt:
        befunde.append({'kandidat': l['kennzeichen'], 'liefert': l['wer_liefert'], **offen(
            'luecke_offen', (f'Lücke {l["kennzeichen"]} ({l["zustand"]}: {l["text"]}) hält die Zeile offen, '
                             f'auch wenn ein Test grün ist (NR6)'), None)})
    return befunde, [l['kennzeichen'] for l in haelt], [_restpunkt(ctx, l) for l in rest]


def _restpunkt(ctx, l):
    letzter = l['verlauf'][-1]
    return {'kennzeichen': l['kennzeichen'], 'grenze': letzter['grenze'], 'bis': letzter['bis'],
            'frist_ueberschritten': ctx.heute.isoformat() > letzter['bis']}


def urteile_zusage(ctx, z):
    """Urteil einer Zusage: belegt nur, wenn JEDER Kandidat einen grünen Lauf oder ein geprüftes Artefakt
    dieses Standes hat; nicht_maschinell_pruefbar, wenn mindestens einer nur eine Bestätigung mit
    Person, Datum und Aussage hat; sonst offen mit dem, was fehlt, und wer es liefert."""
    zeile = {k: z[k] for k in ('kennzeichen', 'art', 'wortlaut', 'quelle', 'traeger', 'norm', 'nachweis_kandidaten')}
    if z['urteil'] == 'nicht_zugesagt':
        zeile.update(nachweise=[], urteil='nicht_zugesagt', grund=z['grund'], luecken=z['luecken'])
        zeile['pruefung'] = {'urteil_matrix': z['urteil'], 'befunde': [], 'luecken_offen': [], 'restpunkte': []}
        return zeile
    befunde = [kandidat(ctx, k, z['kennzeichen']) for k in z['nachweis_kandidaten']] + _restbefunde(ctx, z)
    if b := z.get('bestaetigung'):
        befunde.append({'kandidat': 'bestaetigung', **_bestaetigt(ctx, b['von'], b['datum'], b['aussage'], None)})
    if not befunde:
        befunde.append({'kandidat': None, **offen('ohne_kandidat', 'die Zusage nennt keinen Kandidaten und keine '
                                                                   'Bestätigung; sie bleibt offen (RF-05)', 'Crew')})
    lb, luecken_offen, restpunkte = _lueckenbefunde(ctx, z['kennzeichen'], z['luecken'])
    befunde += lb
    nachweise = [b['nachweis'] for b in befunde if b.get('nachweis')]
    zeile['nachweise'] = nachweise
    if any(b['ergebnis'] == 'offen' for b in befunde):
        zeile.update(urteil='offen', wer_liefert=_wer_liefert(befunde))
    elif bestaetigt := [b for b in befunde if b['ergebnis'] == 'bestaetigt']:
        zeile.update(urteil='nicht_maschinell_pruefbar', bestaetigung=bestaetigt[0]['bestaetigung'])
    else:
        zeile['urteil'] = 'belegt'
    zeile['luecken'] = z['luecken']
    zeile['pruefung'] = {'urteil_matrix': z['urteil'], 'befunde': [ergebnis_ohne_objekte(b) for b in befunde],
                         'luecken_offen': luecken_offen, 'restpunkte': restpunkte}
    return zeile


def urteile_norm(ctx, n):
    """Eine Norm-Zeile trägt nur die Fachperson an ihrer lizenzierten Ausgabe (FP1, RF-03)."""
    zeile = {k: n[k] for k in ('abschnitt', 'umschreibung', 'traeger', 'zusagen', 'kundenaufgabe', 'herkunft')}
    fp = n.get('fachperson')
    if fp is None:
        befunde = [{'kandidat': 'fachperson', **offen('ohne_lesart', 'keine Lesart der Fachperson an der '
                                                                     'lizenzierten Ausgabe (AP-20 IP-12)', 'Fachperson')}]
    else:
        befund = _bestaetigt(ctx, fp['name'], fp['datum'], fp['text'], None)
        if befund['ergebnis'] == 'bestaetigt' and fp['lesart'] == 'anmerkung':
            befund = offen('anmerkung', f'Anmerkung von {fp["name"]} am {fp["datum"]}: {fp["text"]}', 'Crew')
        elif befund['ergebnis'] == 'bestaetigt' and fp['lesart'] == 'widerspruch':
            befund = offen('widerspruch', (f'Widerspruch von {fp["name"]} am {fp["datum"]}: {fp["text"]} - '
                                           f'er wird eine Lücke (FP3)'), 'Crew')
        elif befund['ergebnis'] == 'offen':
            befund['wer'] = 'Fachperson'
        befunde = [{'kandidat': 'fachperson', **befund}]
        zeile['fachperson'] = fp
    lb, luecken_offen, restpunkte = _lueckenbefunde(ctx, n['abschnitt'], n['luecken'])
    befunde += lb
    zeile['luecken'] = n['luecken']
    if any(b['ergebnis'] == 'offen' for b in befunde):
        zeile.update(urteil='offen', wer_liefert=_wer_liefert(befunde, n.get('wer_liefert')))
    else:
        zeile['urteil'] = 'nicht_maschinell_pruefbar'
    zeile['pruefung'] = {'urteil_matrix': n['urteil'], 'befunde': [ergebnis_ohne_objekte(b) for b in befunde],
                         'luecken_offen': luecken_offen, 'restpunkte': restpunkte}
    return zeile


def zaehlung(zusagen, norm_teil):
    """MX4: gezählt wird je Urteil und je Träger, nie in Prozent. Kundenaufgaben nie (NR5)."""
    defs = nachweismatrix.lade_schema()['$defs']
    je = lambda zeilen, feld, worte: {w: sum(z[feld] == w for z in zeilen) for w in worte}  # noqa: E731
    return {'zusagen': je(zusagen, 'urteil', defs['urteil']['enum']),
            'norm_teil': {'je_urteil': je(norm_teil, 'urteil', defs['urteil_norm']['enum']),
                          'je_traeger': je(norm_teil, 'traeger', defs['traeger_norm']['enum'])}}


def bewerte(matrix, liste, ctx, eingaben, kennung, art):
    """Der BWB-Entwurf als Wörterbuch; urteilt nur über eine Matrix, deren Wachen halten."""
    fehler = nachweismatrix.verstoesse(matrix) + luecken.verstoesse(liste, matrix)
    if fehler:
        raise EingabeFehler('der Matrix-Prüfer urteilt nur über eine Matrix, deren Vertrag und Lückenliste '
                            'halten:\n' + '\n'.join(f'rot: {f}' for f in fehler))
    zusagen = [urteile_zusage(ctx, z) for z in matrix['zusagen']]
    norm_teil = [urteile_norm(ctx, n) for n in matrix['norm_teil']]
    nicht_behoben = [l for l in liste['luecken'] if l['zustand'] != 'behoben']
    return {
        'kennung': kennung,
        'zustand': 'entwurf',
        'art': ARTEN[art],
        'grenze': GRENZ_SATZ,
        'stand': ctx.stand,
        'erzeugt_am': ctx.heute.isoformat(),
        'erzeugt_von': 'tools/bewertung/pruefe_matrix.py (AP-20 IP-4)',
        'freigabe': 'keine - freigeben kann nur der Captain (G5)',
        'matrix_fassung': matrix['matrix_fassung'],
        'normfassung': matrix['normfassung'],
        'eingaben': {
            **eingaben,
            'laeufe': [l.eingabe(ctx) for l in ctx.laeufe],
            'artefakte': [o.eingabe(ctx) for o in ctx.artefakte],
            'stand_blatt': ({'datei': ctx.blatt_pfad.name, 'sha256': sha256(ctx.blatt_pfad)}
                            if ctx.blatt_pfad else None),
        },
        'zaehlung': zaehlung(zusagen, norm_teil),
        'zusagen': zusagen,
        'norm_teil': norm_teil,
        'kundenaufgaben': matrix['kundenaufgaben'],
        'luecken': [{'kennzeichen': l['kennzeichen'], 'zustand': l['zustand'], 'text': l['text'],
                     'betrifft': l['betrifft'], 'wer_liefert': l['wer_liefert'],
                     **({k: v for k, v in _restpunkt(ctx, l).items() if k != 'kennzeichen'}
                        if l['zustand'] == 'restpunkt' else {})}
                    for l in nicht_behoben],
    }


# --------------------------------------------------------------------------- #
# Der Bericht als Markdown
# --------------------------------------------------------------------------- #

URTEIL_WORT = {'belegt': 'belegt', 'nicht_maschinell_pruefbar': 'nicht maschinell prüfbar', 'offen': 'offen',
               'nicht_zugesagt': 'nicht zugesagt'}


def _tag(iso):
    return datetime.date.fromisoformat(iso).strftime('%d.%m.%Y') if iso else '—'


def _zelle(text):
    return ' '.join(str(text).split()).replace('|', '\\|')


def _was_steht(zeile):
    """Nachweis, Bestätigung, Grund oder was fehlt - je nach Urteil."""
    if zeile['urteil'] == 'belegt':
        return '<br>'.join(f'{n["fundstelle"]} · Stand {n["stand"][:9]} · {_tag(n["datum"])} · {n["gefahren_von"]}'
                           for n in zeile['nachweise'])
    if zeile['urteil'] == 'nicht_maschinell_pruefbar':
        b = zeile.get('bestaetigung') or {'von': zeile['fachperson']['name'], 'datum': zeile['fachperson']['datum'],
                                          'aussage': zeile['fachperson']['text']}
        return f'bestätigt von {b["von"]} am {_tag(b["datum"])}: {b["aussage"]}'
    if zeile['urteil'] == 'nicht_zugesagt':
        return f'Grenze: {zeile["grund"]}'
    return '<br>'.join(f'fehlt: {b["text"]}' for b in zeile['pruefung']['befunde'] if b['ergebnis'] == 'offen')


def _liefert(zeile):
    if zeile['urteil'] != 'offen':
        return '—'
    return ', '.join(dict.fromkeys(w['wer'] for w in zeile['wer_liefert']))


def _zaehl_satz(je, worte=URTEIL_WORT):
    return ' · '.join(f'{n} {worte.get(w, w)}' for w, n in je.items())


def _kennung(zeile):
    return zeile.get('kennzeichen') or zeile['abschnitt']


def _offene_zeilen(zeilen):
    je_wer = {}
    for z in zeilen:
        if z['urteil'] == 'offen':
            for wer in dict.fromkeys(w['wer'] for w in z['wer_liefert']):
                je_wer.setdefault(wer, []).append(_kennung(z))
    return [f'- liefert {wer}: {", ".join(kz)}' for wer, kz in je_wer.items()] or ['- keine']


def _restpunkte(zeilen):
    return [f'- {_kennung(z)} · {r["kennzeichen"]} · Grenze: {r["grenze"]} · bis {_tag(r["bis"])}'
            + (' · Frist überschritten' if r['frist_ueberschritten'] else '')
            for z in zeilen for r in z['pruefung']['restpunkte']] or ['- keine']


def _eingabe_zeile(titel, o):
    if not o['stand']:
        stand = 'ohne stand.txt'
    else:
        stand = (f'Stand {o["stand"][:9]} · {_tag(o["datum"]) if o["datum"] else "Tag der Berichtsdatei"} · '
                 f'{o["gefahren_von"] or "ohne gefahren_von"}')
    menge = f' · {o["suiten"]} Suiten' if 'suiten' in o else ''
    traegt = '' if o['traegt_den_stand'] else f' · trägt den Stand nicht ({o["grund"]})'
    return f'| {titel} | {_zelle(o["ordner"])} · {stand}{menge}{traegt} |'


def markdown(b, json_sha):
    """Der Entwurf zum Lesen. Jeder Abschnitt schließt mit Restpunkten und offenen Zeilen samt Lieferant."""
    e, z = b['eingaben'], b['zaehlung']
    blatt = e['stand_blatt']
    zeilen = [
        f'# {b["kennung"]} · Entwurf · {b["art"]}', '',
        f'> {b["grenze"]}', '',
        'Entwurf des Matrix-Prüfers (AP-20 IP-4). Er urteilt nach NR1 bis NR9 aus Lauf-Berichten, '
        'Stand-Blatt, Artefakten und Lückenliste und fährt selbst keinen Test. Freigeben kann ihn nur '
        'der Captain (G5).', '',
        '| Angabe | Wert |', '|---|---|',
        f'| Stand | `{b["stand"]}` |',
        f'| erzeugt am | {_tag(b["erzeugt_am"])} |',
        f'| Normfassung | {b["normfassung"]["international"]} · {b["normfassung"]["deutsch"]} · '
        f'Stichtag {_tag(b["normfassung"]["stichtag"])} |',
        f'| Matrix | {e["matrix"]["pfad"]} · Fassung {b["matrix_fassung"]} · SHA-256 `{e["matrix"]["sha256"]}` |',
        f'| Lückenliste | {e["luecken"]["pfad"]} · SHA-256 `{e["luecken"]["sha256"]}` |',
    ]
    for titel, schluessel in (('Lauf-Berichte', 'laeufe'), ('Artefakte', 'artefakte')):
        zeilen += [_eingabe_zeile(titel, o) for o in e[schluessel]] or [f'| {titel} | keine angegeben |']
    zeilen += [
        f'| Stand-Blatt | {_zelle(blatt["datei"]) + " · SHA-256 `" + blatt["sha256"] + "`" if blatt else "keines angegeben"} |',
        f'| Prüfsumme der JSON-Fassung | SHA-256 `{json_sha}` |', '',
        '## Zählung', '',
        f'Von {len(b["zusagen"])} Zusagen: {_zaehl_satz(z["zusagen"])}.', '',
        f'Norm-Teil mit {len(b["norm_teil"])} Zeilen: {_zaehl_satz(z["norm_teil"]["je_urteil"])}; '
        f'je Träger {_zaehl_satz(z["norm_teil"]["je_traeger"], {})}.', '',
        'Gezählt wird nur je Urteil und je Träger, nie in Prozent (MX4). Kundenaufgaben haben kein Urteil '
        'und werden nicht gezählt (NR5).', '',
        '## 1 Nachweismatrix', '', '### Zusagen', '',
        '| Zusage | Wortlaut | Urteil | Nachweis oder was fehlt | liefert |', '|---|---|---|---|---|',
    ]
    zeilen += [f'| {s["kennzeichen"]} | {_zelle(s["wortlaut"])} | {URTEIL_WORT[s["urteil"]]} | '
               f'{_zelle(_was_steht(s))} | {_liefert(s)} |' for s in b['zusagen']]
    zeilen += ['', '### Norm-Teil', '',
               '| Abschnitt | Umschreibung | Träger | Urteil | bestätigt oder was fehlt | liefert | bleibt bei Ihnen |',
               '|---|---|---|---|---|---|---|']
    zeilen += [f'| {n["abschnitt"]} | {_zelle(n["umschreibung"])} | {n["traeger"]} | {URTEIL_WORT[n["urteil"]]} | '
               f'{_zelle(_was_steht(n))} | {_liefert(n)} | {n["kundenaufgabe"]} |' for n in b['norm_teil']]
    zeilen += ['', '### Restpunkte', ''] + _restpunkte(b['zusagen'] + b['norm_teil'])
    zeilen += ['', '### Offene Zeilen und wer liefert', ''] + _offene_zeilen(b['zusagen'] + b['norm_teil'])
    if b['kundenaufgaben']:
        zeilen += ['', '## 2 Kundenaufgaben', '',
                   'Was außerhalb der Software beim Kunden bleibt. Ohne Urteil (NR5).', '',
                   '| Kundenaufgabe | Text | Abschnitte |', '|---|---|---|']
        zeilen += [f'| {k["kennzeichen"]} | {_zelle(k["text"])} | {", ".join(k["norm"])} |'
                   for k in b['kundenaufgaben']]
    if b['luecken']:
        zeilen += ['', '## 6 Lücken', '', '| Lücke | Zustand | Text | betrifft | liefert |', '|---|---|---|---|---|']
        for l in b['luecken']:
            zustand = l['zustand']
            if 'grenze' in l:
                zustand += f' · Grenze: {l["grenze"]} · bis {_tag(l["bis"])}'
                zustand += ' · Frist überschritten' if l['frist_ueberschritten'] else ''
            wer = ', '.join(dict.fromkeys(w['wer'] for w in l['wer_liefert']))
            zeilen.append(f'| {l["kennzeichen"]} | {_zelle(zustand)} | {_zelle(l["text"])} | '
                          f'{", ".join(l["betrifft"])} | {wer} |')
    return '\n'.join(zeilen) + '\n'


# --------------------------------------------------------------------------- #
# Schreiben und Aufruf
# --------------------------------------------------------------------------- #

def naechste_kennung(aus, jahr):
    da = [int(m[2]) for p in aus.glob(f'BWB-{jahr}-*.json') if (m := KENNUNG.match(p.stem)) and m[1] == str(jahr)]
    return f'BWB-{jahr}-{max(da, default=0) + 1:02d}'


def schreibe(bericht, aus):
    """`.json`, `.md` und `.sha256`; die `.md` nennt die Prüfsumme der JSON-Fassung. Nie überschreiben (G3)."""
    kennung = bericht['kennung']
    pfade = {endung: aus / f'{kennung}.{endung}' for endung in ('json', 'md', 'sha256')}
    if any(p.exists() for p in pfade.values()):
        raise EingabeFehler(f'{kennung} gibt es unter {anzeige(aus)} schon - ein Bericht wird nie überschrieben (G3)')
    aus.mkdir(parents=True, exist_ok=True)
    roh = (json.dumps(bericht, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    json_sha = hashlib.sha256(roh).hexdigest()
    md = markdown(bericht, json_sha).encode('utf-8')
    md_sha = hashlib.sha256(md).hexdigest()
    pfade['json'].write_bytes(roh)
    pfade['md'].write_bytes(md)
    pfade['sha256'].write_text(f'{json_sha}  {kennung}.json\n{md_sha}  {kennung}.md\n', encoding='utf-8')
    return pfade, json_sha, md_sha


def _datum(text):
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f'{text}: kein Datum JJJJ-MM-TT') from None


def main(argv=None):
    p = argparse.ArgumentParser(prog='pruefe_matrix.py', description=__doc__.split('\n\n')[1],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog='Exit 0 = Entwurf geschrieben (kein Tor) · 2 = Aufruf, Eingabe oder Wache rot.')
    p.add_argument('--laeufe', action='append', default=[], metavar='ORDNER',
                   help='Lauf-Berichte (Surefire, Vitest-JUnit) mit stand.txt; mehrfach')
    p.add_argument('--artefakte', action='append', default=[], metavar='ORDNER',
                   help='Artefakte (rueckweg.json, probe.json) mit stand.txt; mehrfach')
    p.add_argument('--blatt', metavar='DATEI', help='Stand-Blatt des Betreibers (Form wie tools/freigabe/)')
    p.add_argument('--uebungen', default=str(uebungen.ORDNER), metavar='ORDNER',
                   help='Übungen des Betreibers (BT1); Vorgabe docs/bewertung/uebungen')
    p.add_argument('--stand', metavar='COMMIT', help='geprüfter Stand; Vorgabe HEAD')
    p.add_argument('--heute', type=_datum, default=datetime.date.today(), metavar='JJJJ-MM-TT',
                   help='Prüftag; Vorgabe heute')
    p.add_argument('--aus', default=str(AUS_PFAD), metavar='ORDNER',
                   help=f'wohin der Entwurf geht; Vorgabe {anzeige(AUS_PFAD)}')
    p.add_argument('--kennung', metavar='BWB-JJJJ-nn', help='Vorgabe: die nächste freie im Jahr des Prüftags')
    p.add_argument('--art', choices=sorted(ARTEN), default='gebaut', help='gebauter oder ausgelieferter Stand')
    p.add_argument('--matrix', default=str(nachweismatrix.MATRIX_PFAD), metavar='DATEI')
    p.add_argument('--luecken', default=str(luecken.LISTE_PFAD), metavar='DATEI')
    p.add_argument('--wurzel', default=str(REPO), metavar='ORDNER', help='git-Repo für Stand und Vorfahren')
    try:
        args = p.parse_args(argv)
    except SystemExit as ende:
        return 2 if ende.code else 0
    aus = pathlib.Path(args.aus)
    if args.kennung and not KENNUNG.match(args.kennung):
        print(f'--kennung {args.kennung}: erwartet BWB-JJJJ-nn', file=sys.stderr)
        return 2
    try:
        matrix_pfad, liste_pfad = pathlib.Path(args.matrix), pathlib.Path(args.luecken)
        matrix = json.loads(matrix_pfad.read_text(encoding='utf-8'))
        liste = json.loads(liste_pfad.read_text(encoding='utf-8'))
        ctx = Kontext(args.stand, args.heute, args.wurzel, args.laeufe, args.artefakte, args.blatt, liste,
                      args.uebungen)
        eingaben = {'matrix': {'pfad': anzeige(matrix_pfad), 'sha256': sha256(matrix_pfad)},
                    'luecken': {'pfad': anzeige(liste_pfad), 'sha256': sha256(liste_pfad)}}
        kennung = args.kennung or naechste_kennung(aus, args.heute.year)
        bericht = bewerte(matrix, liste, ctx, eingaben, kennung, args.art)
        pfade, json_sha, md_sha = schreibe(bericht, aus)
    except ImportError:
        print('jsonschema fehlt: python3 -m pip install jsonschema', file=sys.stderr)
        return 2
    except (EingabeFehler, pruefe_tor.StandFehler, OSError, ValueError) as fehler:
        print(f'nicht beurteilt: {fehler}', file=sys.stderr)
        return 2
    z = bericht['zaehlung']
    print(f'Entwurf {kennung} ({ARTEN[args.art]}) am Stand {ctx.stand[:9]}, Prüftag {args.heute.isoformat()}')
    print(f'Zusagen ({len(bericht["zusagen"])}): {_zaehl_satz(z["zusagen"])}')
    print(f'Norm-Teil ({len(bericht["norm_teil"])} Zeilen): {_zaehl_satz(z["norm_teil"]["je_urteil"])}; '
          f'je Träger {_zaehl_satz(z["norm_teil"]["je_traeger"], {})}')
    print(f'{anzeige(pfade["json"])}  SHA-256 {json_sha}')
    print(f'{anzeige(pfade["md"])}  SHA-256 {md_sha}')
    print('Kein Tor: der Entwurf gibt nichts frei; freigeben kann nur der Captain (G5).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
