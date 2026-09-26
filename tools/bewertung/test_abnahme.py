#!/usr/bin/env python3
"""Abnahme-Test AP-20 (AP-20 NW-6, AP-20 IP-23): die zwölf Referenzfälle RF-01 … RF-12 aus dem Konzept
(FM/vp-uems-ap20-fundament/report.md §7) an EINER Fixture-Matrix, gefahren über die echten Werkzeuge.

    python3 -m unittest discover -s tools/bewertung -p 'test_abnahme.py'

Die Welt steht unter `fixtures/abnahme/` (README.md dort): Matrix mit allen 30 Norm-Zeilen und den Zusagen
der Fälle, Lückenliste im Startbestand vom 25.09.2026, Lauf-Berichte an zwei Ständen, Stand-Blätter,
eine Übung mit Artefakt, spätere Lücken-Übergänge, der Entwurf PB-01, das Protokoll PA-2026-01 und die
Artefakte des Vertragsendes. Was ein Mensch liefert - die Lesart der Fachperson (RF-03), das Ergebnis
der Übung (RF-07), der Durchlauf (RF-10), die Annahme des Captains (RF-06) - ist als FIXTURE
gekennzeichnet und ersetzt nichts davon (AP-20 IP-12, IP-14, IP-19).

Die Stände sind zwei leere Commits mit festem Autor und festem Datum in einem Wegwerf-Repo; ihre
Kennungen stehen darum wörtlich in den `stand.txt` der Fixture. Jeder Fall prüft das „Ergebnis
(erwartet)“ des Konzepts; wo die Fixture-Welt einen anderen Wert trägt (Stand, „gefahren von“), steht
das am Fall. Jede Gegenprobe ändert genau eine Eingabe und muss rot werden: offen, Verstoß,
abgelehnt oder Exit ≠ 0. Braucht `jsonschema` (wie alle Wachen unter tools/bewertung).
"""

import contextlib
import copy
import datetime
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import luecken  # noqa: E402
import nachweismatrix  # noqa: E402
import klammer  # noqa: E402
import produktbeschreibung  # noqa: E402
import pruefe_matrix  # noqa: E402
import uebungen  # noqa: E402
import zusagen  # noqa: E402

HIER = pathlib.Path(__file__).resolve().parent
WELT = HIER / 'fixtures' / 'abnahme'
REPO = nachweismatrix.REPO

# Die zwei Stände der Fixture-Welt: leere Commits, fester Autor, festes Datum - also feste Kennungen.
ALT = '513f6b35ae408611c6e12ff6824e5f4c265185ed'   # Tor-Beleg G1 vom 19.09.2026 (RF-11)
NEU = 'dcd7db4092511b00a1c39b8cd7d358a1362cc6cb'   # gebauter Stand, Lauf AP-20 IP-10 am 28.09.2026
STAENDE = (('2026-09-19T12:00:00+00:00', 'Fixture: Stand des Tor-Belegs (19.09.2026)', ALT),
           ('2026-09-28T08:00:00+00:00', 'Fixture: gebauter Stand (28.09.2026)', NEU))
GEBAUT_VON = 'Crew (Lauf AP-20 IP-10, Fixture AP-20 IP-23)'   # Konzept: „Crew (Lauf IP-10)“
FACHPERSON = 'Fachperson F. (Auditorin für Energiemanagementsysteme, extern; Name im Bau)'
PRODUKTIONSRUECKGANG = 'TEST-com.voltpilot.api.uems.UemsProduktionsrueckgangAbnahmeTest.xml'
LOESCHEN = 'TEST-com.voltpilot.api.uems.KundenbereichLoeschenApiTest.xml'
LOESCHNACHWEIS_SQL = (REPO / 'services' / 'api' / 'src' / 'main' / 'resources' / 'db' / 'migration'
                      / 'V20260925223000__uems_mandant_loeschnachweis.sql')
# RF-08: was ein Löschnachweis nie trägt - Name, Konten, Personen, Auftrag, Begründung (Freitext).
PERSONENDATEN = re.compile(r'name|konto|konten|person|email|mail|auftrag|begruendung', re.IGNORECASE)


def lade(pfad):
    return json.loads(pathlib.Path(pfad).read_text(encoding='utf-8'))


def sha256(pfad):
    return hashlib.sha256(pathlib.Path(pfad).read_bytes()).hexdigest()


def zeile(bewertung, kennung):
    teil, schluessel = ('zusagen', 'kennzeichen') if kennung.startswith('Z-') else ('norm_teil', 'abschnitt')
    return next(z for z in bewertung[teil] if z[schluessel] == kennung)


def befunde(z):
    return {b['kandidat']: b for b in z['pruefung']['befunde']}


def gruende(z):
    return [b['grund'] for b in z['pruefung']['befunde'] if b['ergebnis'] == 'offen']


def wer(z):
    return list(dict.fromkeys(w['wer'] for w in z.get('wer_liefert', [])))


def md_zeile(md, anfang):
    return next(z for z in md.splitlines() if z.startswith(anfang))


def luecke(liste, kz):
    return next(l for l in liste['luecken'] if l['kennzeichen'] == kz)


def pruefsummen_abweichend(ordner, datei):
    """`sha256sum -c` über eine Summen-Datei: die Pfade, deren Bytes nicht zur Summe passen."""
    falsch = []
    for z in (ordner / datei).read_text(encoding='utf-8').splitlines():
        summe, pfad = z.split('  ', 1)
        if not (ordner / pfad).is_file() or sha256(ordner / pfad) != summe:
            falsch.append(pfad)
    return falsch


def spalten_loeschnachweis():
    """Die Spalten der Tabelle mandant_loeschnachweis, gelesen aus der Migration des Produkts."""
    sql = LOESCHNACHWEIS_SQL.read_text(encoding='utf-8')
    block = sql[sql.index('CREATE TABLE IF NOT EXISTS mandant_loeschnachweis'):]
    block = block[:block.index(');')]
    return {m[1] for m in re.finditer(r'^\s{4}([a-z_0-9]+)\s+[A-Z]', block, re.MULTILINE)} - {'id'}


class Welt:
    """Wegwerf-Repo mit den zwei Ständen und je Fall eine Kopie von Matrix und Lückenliste."""

    def __init__(self, wurzel: pathlib.Path):
        self.wurzel = wurzel
        self.repo = wurzel / 'repo'
        self.repo.mkdir()
        self._git('init', '-q')
        for datum, text, erwartet in STAENDE:
            self._git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', text, datum=datum)
            sha = self._git('rev-parse', 'HEAD')
            if sha != erwartet:
                raise AssertionError(f'git bildet {sha} statt {erwartet} - die stand.txt der Fixture passen nicht')
        self.matrix, self.liste = lade(WELT / 'matrix.json'), lade(WELT / 'luecken.json')
        self.keine_uebung = wurzel / 'keine-uebung'
        self.keine_uebung.mkdir()
        self._laeufe = 0

    def _git(self, *argv, datum='2026-09-19T12:00:00+00:00'):
        umgebung = dict(os.environ, GIT_AUTHOR_NAME='Fixture AP-20 IP-23',
                        GIT_AUTHOR_EMAIL='fixture@voltpilot.invalid', GIT_COMMITTER_NAME='Fixture AP-20 IP-23',
                        GIT_COMMITTER_EMAIL='fixture@voltpilot.invalid', GIT_AUTHOR_DATE=datum,
                        GIT_COMMITTER_DATE=datum, GIT_CONFIG_NOSYSTEM='1', HOME=str(self.wurzel))
        return subprocess.run(['git', '-C', str(self.repo), *argv], capture_output=True, text=True, check=True,
                              env=umgebung).stdout.strip()

    def uebergaenge(self, fall):
        """Die späteren Übergänge eines Falls (uebergaenge.json); eine behobene Lücke nennt keine Zeile mehr."""
        for kz, schritte in lade(WELT / 'uebergaenge.json')[fall].items():
            l = luecke(self.liste, kz)
            for s in schritte:
                l['verlauf'].append(copy.deepcopy(s))
                l['zustand'] = s['nach']
            if l['zustand'] == 'behoben':
                for z in self.matrix['zusagen'] + self.matrix['norm_teil']:
                    if kz in z['luecken']:
                        z['luecken'].remove(kz)

    def kopie(self, name, stand=None, aendern=None):
        """Ein Lauf-Ordner der Fixture als Wegwerf-Kopie: andere stand.txt oder ein geänderter Bericht."""
        ziel = self.wurzel / f'{name}-{len(list(self.wurzel.glob(name + "-*")))}'
        shutil.copytree(WELT / 'laeufe' / name, ziel)
        if stand is not None:
            text = (ziel / 'stand.txt').read_text(encoding='utf-8').split('\n', 1)[1]
            (ziel / 'stand.txt').write_text(f'{stand}\n{text}', encoding='utf-8')
        if stand is False:
            (ziel / 'stand.txt').unlink()
        for datei, (alt, neu) in (aendern or {}).items():
            text = (ziel / datei).read_text(encoding='utf-8')
            assert alt in text, alt
            (ziel / datei).write_text(text.replace(alt, neu), encoding='utf-8')
        return ziel

    def pruefe(self, heute, laeufe=('gebaut',), blatt=None, uebung=False, kennung=None, aus=None, lauf=None):
        """Der Matrix-Prüfer über seinen Aufruf (pruefe_matrix.main): (exit, Bewertung, Markdown, Pfad, Ausgabe)."""
        self._laeufe += 1
        lauf = lauf or self.wurzel / f'lauf-{self._laeufe}'
        lauf.mkdir(exist_ok=True)
        for name, daten in (('matrix.json', self.matrix), ('luecken.json', self.liste)):
            (lauf / name).write_text(json.dumps(daten, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        argv = ['--matrix', str(lauf / 'matrix.json'), '--luecken', str(lauf / 'luecken.json'),
                '--wurzel', str(self.repo), '--stand', NEU, '--heute', heute, '--aus', str(aus or lauf / 'aus'),
                '--uebungen', str(WELT / 'uebungen' if uebung else self.keine_uebung)]
        for l in laeufe:
            argv += ['--laeufe', str(l if isinstance(l, pathlib.Path) else WELT / 'laeufe' / l)]
        if blatt:
            argv += ['--blatt', str(WELT / 'blatt' / blatt)]
        if kennung:
            argv += ['--kennung', kennung]
        raus, fehler = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(raus), contextlib.redirect_stderr(fehler):
            code = pruefe_matrix.main(argv)
        if code:
            return code, None, None, None, raus.getvalue() + fehler.getvalue()
        pfad = next((aus or lauf / 'aus').glob('BWB-*.json'))
        return code, lade(pfad), pfad.with_suffix('.md').read_text(encoding='utf-8'), pfad, raus.getvalue()

    def bewertung(self, heute, **kw):
        code, b, md, _, ausgabe = self.pruefe(heute, **kw)
        if code:
            raise AssertionError(f'der Matrix-Prüfer urteilt nicht (Exit {code}): {ausgabe}')
        return b, md


class Fall(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.w = Welt(pathlib.Path(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()


# --------------------------------------------------------------------------- #
# Die Welt selbst
# --------------------------------------------------------------------------- #

class DieWelt(Fall):
    """Die Fixture hält die Wachen, und alles, was ein Mensch liefert, ist als Fixture gekennzeichnet."""

    def test_matrix_und_luecken_halten_ihre_wachen(self):
        self.assertEqual(nachweismatrix.verstoesse(self.w.matrix), [])
        self.assertEqual(luecken.verstoesse(self.w.liste, self.w.matrix), [])
        self.assertIn('FIXTURE', self.w.matrix['lesehilfe'])
        # Die Klammer (AP-20 IP-6): jeder Kandidat existiert im Repo; offen ist nur Z-010, das mit Absicht
        # wie vor AP-20 IP-6 steht (RF-05).
        self.assertEqual(klammer.verstoesse(self.w.matrix),
                         ['Z-010: wartet noch auf AP-20 IP-6: Bestandsschutz-Tests als Nachweis zuordnen (AP-20 IP-6)'])
        self.assertIn('FIXTURE', self.w.liste['lesehilfe'])

    def test_jede_menschliche_eingabe_ist_als_fixture_gekennzeichnet(self):
        dateien = ['fachperson-rf03.json', 'uebergaenge.json', 'pilot/PA-2026-01.json', 'uebungen/U-2026-01.json',
                   'blatt/vor-der-uebung.yaml', 'blatt/nach-der-uebung.yaml', 'beschreibung/pb-01.json',
                   'vertragsende/selbstauskunft.json', 'vertragsende/abzug/manifest.json',
                   'laeufe/gebaut/stand.txt', 'laeufe/tor-g1/stand.txt']
        for d in dateien + [p.relative_to(WELT).as_posix() for p in WELT.glob('laeufe/*/TEST-*.xml')]:
            with self.subTest(datei=d):
                self.assertIn('FIXTURE' if not d.endswith('stand.txt') else 'Fixture',
                              (WELT / d).read_text(encoding='utf-8'))
        self.assertIn('Fixture', lade(WELT / 'vertragsende' / 'loeschnachweis.json')['geloescht_von'])
        for s in lade(WELT / 'uebergaenge.json')['RF-06']['L-004']:
            self.assertIn('Fixture', s['person'])

    def test_zweiter_lauf_gleich(self):
        """Gleiche Eingaben ergeben gleiche Bytes: Bewertung (json, md, sha256) und Beschreibung."""
        self.w.uebergaenge('RF-09')
        aus = [self.w.wurzel / 'eins', self.w.wurzel / 'zwei']
        for a in aus:
            self.w.pruefe('2027-01-20', kennung='BWB-2027-01', aus=a, lauf=self.w.wurzel / 'eingaben')
        for name in ('BWB-2027-01.json', 'BWB-2027-01.md', 'BWB-2027-01.sha256'):
            self.assertEqual((aus[0] / name).read_bytes(), (aus[1] / name).read_bytes(), name)
        # Die Beschreibung nennt den Pfad ihrer Bewertung - gleich gebaut wird sie aus derselben Datei.
        erst, dann = (produktbeschreibung.baue(produktbeschreibung.QUELLE, aus[0] / 'BWB-2027-01.json') for _ in aus)
        self.assertEqual(erst, dann)


# --------------------------------------------------------------------------- #
# RF-01 … RF-12
# --------------------------------------------------------------------------- #

class RF01ZeileBelegt(Fall):
    """RF-01: Eine Zeile „belegt“ - an Test, Stand und Datum gebunden (NW-2, NW-6)."""

    def test_fall(self):
        b, md = self.w.bewertung('2026-09-28')
        z = zeile(b, 'Z-002')
        n = z['nachweise'][0]
        self.assertEqual({'urteil': z['urteil'], 'fundstelle': n['fundstelle'], 'stand': n['stand'],
                          'datum': n['datum'], 'gefahren_von': n['gefahren_von']},
                         {'urteil': 'belegt',
                          'fundstelle': 'UemsProduktionsrueckgangAbnahmeTest#r2PlanAbnahmeRohOhneUrteilBereinigtSchlechter',
                          'stand': NEU, 'datum': '2026-09-28', 'gefahren_von': GEBAUT_VON})
        self.assertEqual(n['lauf_sha256'], sha256(WELT / 'laeufe' / 'gebaut' / PRODUKTIONSRUECKGANG))
        self.assertIn('| Z-002 |', md)
        self.assertIn('| belegt |', md_zeile(md, '| Z-002 |'))

    def test_gegenprobe_uebersprungen_ist_offen(self):
        """Derselbe Bericht mit 4 übersprungenen Tests (kein Docker) → offen (NR2)."""
        bericht = (WELT / 'laeufe' / 'gebaut' / PRODUKTIONSRUECKGANG).read_text(encoding='utf-8')
        neu = bericht.replace('skipped="0"', 'skipped="4"').replace('time="1.5"/>', 'time="0"><skipped/></testcase>')
        lauf = self.w.kopie('gebaut', aendern={PRODUKTIONSRUECKGANG: (bericht, neu)})
        z = zeile(self.w.bewertung('2026-09-28', laeufe=[lauf])[0], 'Z-002')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['uebersprungen', 'uebersprungen']))

    def test_gegenprobe_aelterer_stand_ist_offen(self):
        """Ein grüner Bericht vom älteren Stand → offen, „älterer Stand“ (NR3)."""
        z = zeile(self.w.bewertung('2026-09-28', laeufe=[self.w.kopie('gebaut', stand=ALT)])[0], 'Z-002')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['aelterer_stand', 'aelterer_stand']))
        self.assertIn('älterer Stand', befunde(z)[z['nachweis_kandidaten'][0]]['text'])


class RF02ZeileOffen(Fall):
    """RF-02: Eine Zeile „offen“ - mit dem Namen dessen, der liefert (NW-2)."""

    RUECKWEG = 'tools/generalprobe/rueckweg.sh → rueckweg.json (AP-14 NW-8)'

    def test_fall(self):
        b, md = self.w.bewertung('2026-09-28', blatt='vor-der-uebung.yaml')
        z = zeile(b, 'Z-015')
        rueckweg = befunde(z)[self.RUECKWEG]
        self.assertEqual({'urteil': z['urteil'], 'wer_liefert': rueckweg['wer'], 'luecken_offen': z['pruefung']['luecken_offen']},
                         {'urteil': 'offen', 'wer_liefert': 'Betreiber', 'luecken_offen': ['L-003', 'L-004']})
        # fehlt: Q15 und die Rückweg-Übung - so zeigt es die Betreiber-Liste der Übungen beim Abruf.
        fehlt = uebungen.faelligkeit([], datetime.date(2026, 9, 28), WELT / 'blatt' / 'vor-der-uebung.yaml')
        self.assertTrue(fehlt[0].startswith('offen: Wiederherstellung: keine durchgeführte Übung'), fehlt)
        self.assertTrue(fehlt[1].startswith('offen: ') and 'Q15' in fehlt[1], fehlt)
        self.assertIn('Betreiber', md_zeile(md, '| Z-015 |'))

    def test_gegenprobe_q15_ohne_uebung_bleibt_offen(self):
        z = zeile(self.w.bewertung('2026-09-28', blatt='nach-der-uebung.yaml')[0], 'Z-015')
        self.assertEqual((z['urteil'], befunde(z)[self.RUECKWEG]['grund']), ('offen', 'uebung_fehlt'))

    def test_gegenprobe_uebung_ohne_q15_bleibt_offen(self):
        z = zeile(self.w.bewertung('2026-10-05', blatt='vor-der-uebung.yaml', uebung=True)[0], 'Z-015')
        self.assertEqual((z['urteil'], befunde(z)[self.RUECKWEG]['grund']), ('offen', 'q15_offen'))


class RF03NichtMaschinellPruefbar(Fall):
    """RF-03: „nicht maschinell prüfbar“ nur mit der prüfenden Person (NW-1, NW-2). Die Lesart ist FIXTURE."""

    def setUp(self):
        super().setUp()
        rf03 = lade(WELT / 'fachperson-rf03.json')
        self.lesart = rf03['fachperson']
        zeile(self.w.matrix, rf03['abschnitt'])['fachperson'] = self.lesart   # was AP-20 IP-12 übernimmt

    def test_fall(self):
        b, md = self.w.bewertung('2026-11-12')
        n = zeile(b, '9.2.2')
        self.assertEqual({'urteil': n['urteil'], 'bestaetigt_von': n['fachperson']['name'],
                          'datum': n['fachperson']['datum'], 'kundenaufgabe': n['kundenaufgabe']},
                         {'urteil': 'nicht_maschinell_pruefbar', 'bestaetigt_von': FACHPERSON,
                          'datum': '2026-11-12', 'kundenaufgabe': 'KA-08'})
        self.assertIn('| nicht maschinell prüfbar |', md_zeile(md, '| 9.2.2 |'))

    def test_gegenprobe_ohne_person_ist_offen(self):
        """Dieselbe Aussage ohne Namen, nur mit der Rolle → offen (NR4)."""
        self.lesart['name'] = 'Fachperson'
        n = zeile(self.w.bewertung('2026-11-12')[0], '9.2.2')
        self.assertEqual((n['urteil'], gruende(n)), ('offen', ['ohne_person']))

    def test_gegenprobe_lesart_vor_ihrem_datum_ist_offen(self):
        n = zeile(self.w.bewertung('2026-11-11')[0], '9.2.2')
        self.assertEqual((n['urteil'], gruende(n)), ('offen', ['datum_in_zukunft']))


class RF04Kundenaufgabe(Fall):
    """RF-04: Eine Kundenaufgabe ist benannt, hat kein Urteil und wird nie gezählt (NW-1, NW-6)."""

    def test_fall(self):
        b, md = self.w.bewertung('2026-09-28')
        ka = next(k for k in b['kundenaufgaben'] if k['kennzeichen'] == 'KA-02')
        self.assertEqual({'urteil_kundenaufgabe': ka.get('urteil'), 'norm': ka['norm']},
                         {'urteil_kundenaufgabe': None, 'norm': ['7.2', '7.3']})
        # nie gezählt: die Zählung kennt nur Zusagen und Norm-Zeilen (MX4, NR5)
        self.assertEqual(sum(b['zaehlung']['zusagen'].values()), len(b['zusagen']))
        self.assertEqual(sum(b['zaehlung']['norm_teil']['je_urteil'].values()), 30)
        self.assertNotIn('kundenaufgaben', b['zaehlung'])
        self.assertIn('Kundenaufgaben haben kein Urteil und werden nicht gezählt (NR5)', md)
        self.assertIn('| KA-02 |', md.split('## 2 Kundenaufgaben', 1)[1])
        # „bleibt bei Ihnen“: die Übersicht für Prüfende aus derselben Bewertung
        _, _, _, pfad, _ = self.w.pruefe('2026-09-28', aus=self.w.wurzel / 'ka')
        uebersicht = produktbeschreibung.baue(produktbeschreibung.QUELLE, pfad)['uebersicht-fuer-pruefende.md']
        z73 = md_zeile(uebersicht.decode('utf-8'), '| 7.3 |')
        self.assertIn('Nichts; das bleibt bei Ihnen.', z73)
        self.assertIn('Kompetenz', z73)

    def test_gegenprobe_urteilender_satz_ist_rot(self):
        ka = next(k for k in self.w.matrix['kundenaufgaben'] if k['kennzeichen'] == 'KA-02')
        ka['text'] += ' Das ist erfüllt.'
        self.assertIn('kundenaufgaben[KA-02].text: „erfüllt“ urteilt - eine Kundenaufgabe hat kein Urteil (NR5, RF-04)',
                      nachweismatrix.verstoesse(self.w.matrix))
        code, _, _, _, ausgabe = self.w.pruefe('2026-09-28')
        self.assertEqual(code, 2)
        self.assertIn('nicht beurteilt', ausgabe)

    def test_gegenprobe_urteil_als_feld_ist_rot(self):
        next(k for k in self.w.matrix['kundenaufgaben'] if k['kennzeichen'] == 'KA-02')['urteil'] = 'offen'
        self.assertTrue(any(f.startswith('kundenaufgaben/1:') for f in nachweismatrix.verstoesse(self.w.matrix)))


class RF05ZusageAusReleaseNotiz(Fall):
    """RF-05: Eine Zusage aus der Release-Notiz ohne Beleg - offen, nie erfüllt (NW-2, NW-6)."""

    SATZ = 'An Ihren Zahlen, Ihrer Steuerung und Ihren Fahrplänen ändert sich dadurch nichts.'

    def test_fall(self):
        b, md = self.w.bewertung('2026-09-28')
        z = zeile(b, 'Z-010')
        satz = produktbeschreibung.pruefe_satz({'satz': z['wortlaut'], 'zusage': 'Z-010'},
                                               produktbeschreibung.Bewertungsstand.aus(b))
        self.assertEqual({'urteil': z['urteil'], 'wer_liefert': wer(z), 'nachweise': z['nachweise'],
                          'in_beschreibung_zulaessig': satz['zugelassen']},
                         {'urteil': 'offen', 'wer_liefert': ['Crew', 'Betreiber'], 'nachweise': [],
                          'in_beschreibung_zulaessig': False})
        self.assertEqual(satz['grund'], 'an Z-010 gebunden, Z-010 ist offen')
        # MX5: der Satz der Vorlage hat seine Zeile
        self.assertEqual([f for f in zusagen.verstoesse(self.w.matrix) if self.SATZ in f or 'Z-010' in f], [])

    def test_gegenprobe_satz_ohne_zeile_ist_rot(self):
        """Die Release-Notiz-Zeile ohne Zusage → die Wache MX5 ist rot."""
        self.w.matrix['zusagen'] = [z for z in self.w.matrix['zusagen'] if z['kennzeichen'] != 'Z-010']
        self.assertEqual([f for f in zusagen.verstoesse(self.w.matrix) if self.SATZ in f],
                         [f'docs/rollout/release-notiz-vorlage.md:42: Satz „{self.SATZ}“ hat keine Zusage (MX5)'])

    def test_gegenprobe_zeile_ohne_person_im_blatt_bleibt_offen(self):
        """Ein Stand-Blatt, das Z-010 nur mit der Rolle bestätigt, macht die Zeile nicht positiv (NR4)."""
        blatt = self.w.wurzel / 'z010.yaml'
        blatt.write_text('Z-010:\n  bestaetigt: ja\n  am: 2026-09-27\n  durch: Betreiber\n  beleg: Generalprobe gefahren\n',
                         encoding='utf-8')
        z = zeile(self.w.bewertung('2026-09-28', blatt=blatt)[0], 'Z-010')
        self.assertEqual(z['urteil'], 'offen')
        self.assertIn('ohne_person', gruende(z))


class RF06LueckeDesBetreibers(Fall):
    """RF-06: Eine Lücke auf der Betreiber-Liste - mit ihren Zuständen, nie beim Kunden (NW-3)."""

    def setUp(self):
        super().setUp()
        self.w.uebergaenge('RF-06')

    def test_fall(self):
        self.assertEqual(luecken.verstoesse(self.w.liste, self.w.matrix), [])
        l003, l004 = luecke(self.w.liste, 'L-003'), luecke(self.w.liste, 'L-004')
        anzeige = luecken.zeile(l004, datetime.date(2027, 4, 15))
        self.assertEqual({'l003_verlauf': [u['nach'] for u in l003['verlauf']],
                          'l004_verlauf': [u['nach'] for u in l004['verlauf']],
                          'restpunkt_angenommen_von': l004['verlauf'][-1]['angenommen_von'],
                          'beim_kunden_sichtbar': bool(luecken.auf_kundenflaechen())},
                         {'l003_verlauf': ['offen', 'in_arbeit', 'behoben'], 'l004_verlauf': ['offen', 'restpunkt'],
                          'restpunkt_angenommen_von': 'Captain', 'beim_kunden_sichtbar': False})
        self.assertIn('Frist überschritten seit 2027-03-31', anzeige)
        self.assertIn('angenommen vom Captain', anzeige)
        self.assertNotIn('Frist überschritten', luecken.zeile(l004, datetime.date(2027, 3, 31)))
        # Der Prüfer rechnet die Frist beim Abruf; L-003 ist behoben und steht nicht mehr am Urteil.
        b, md = self.w.bewertung('2027-04-15', blatt='nach-der-uebung.yaml', uebung=True)
        z = zeile(b, 'Z-015')
        self.assertEqual(z['pruefung']['restpunkte'],
                         [{'kennzeichen': 'L-004', 'grenze': 'Ein Verlust der Daten-VM verliert auch die Sicherung.',
                           'bis': '2027-03-31', 'frist_ueberschritten': True}])
        self.assertEqual(z['pruefung']['luecken_offen'], [])
        self.assertNotIn('L-003', [l['kennzeichen'] for l in b['luecken']])
        self.assertIn('Frist überschritten', md_zeile(md, '| L-004 |'))

    def test_gegenprobe_restpunkt_ohne_captain_ist_rot(self):
        del luecke(self.w.liste, 'L-004')['verlauf'][-1]['angenommen_von']
        self.assertTrue(any('Restpunkt ohne angenommen_von: Captain' in f
                            for f in luecken.verstoesse(self.w.liste, self.w.matrix)))

    def test_gegenprobe_behoben_ohne_nachweis_ist_rot(self):
        del luecke(self.w.liste, 'L-003')['verlauf'][-1]['nachweis']
        self.assertTrue(any('nachweis' in f for f in luecken.verstoesse(self.w.liste, self.w.matrix)))

    def test_gegenprobe_luecke_auf_einer_kundenflaeche_ist_rot(self):
        flaeche = self.w.wurzel / 'kunde' / 'frontend' / 'portal' / 'src' / 'Hinweis.tsx'
        flaeche.parent.mkdir(parents=True)
        flaeche.write_text('export const hinweis = "Sicherung außer Haus fehlt (L-004)";\n', encoding='utf-8')
        self.assertEqual(luecken.auf_kundenflaechen(self.w.wurzel / 'kunde'),
                         ['frontend/portal/src/Hinweis.tsx:1: L-004 auf einer Kundenfläche - eine Lücke von '
                          'VoltPilot erscheint nie beim Kunden (G2)'])


class RF07WiederherstellungsUebung(Fall):
    """RF-07: Eine Wiederherstellungs-Übung mit festgehaltenem Ergebnis (NW-2). Übung und Q15 sind FIXTURE."""

    RUECKWEG = RF02ZeileOffen.RUECKWEG

    def test_fall(self):
        fehler, e = uebungen.bewerte(WELT / 'uebungen' / 'U-2026-01.json', WELT / 'uebungen',
                                     WELT / 'blatt' / 'nach-der-uebung.yaml')
        self.assertEqual(fehler, [])
        self.assertEqual({k: e[k] for k in ('uebung_zustand', 'dauer_min', 'teil_wiederherstellung', 'q15',
                                            'naechste_faellig')},
                         {'uebung_zustand': 'durchgefuehrt', 'dauer_min': 21, 'teil_wiederherstellung': 'belegt',
                          'q15': 'nicht_maschinell_pruefbar', 'naechste_faellig': '2027-04-05'})
        self.assertEqual(uebungen.zeile(e), 'U-2026-01 · Wiederherstellung · 21 min · Zählungen gleich · '
                                            'Stand dcd7db409 · 05.10.2026 · Betreiber (A. Muster, Fixture) · '
                                            'nächste fällig 05.04.2027')
        # Im Prüfer ist der Teil „Wiederherstellung geübt“ belegt; offen halten Z-015 nur die Lücken (NR6).
        z = zeile(self.w.bewertung('2026-10-05', blatt='nach-der-uebung.yaml', uebung=True)[0], 'Z-015')
        teil = befunde(z)[self.RUECKWEG]
        self.assertEqual((teil['ergebnis'], teil['grund']), ('belegt', 'gruen'))
        self.assertEqual(z['nachweise'][0]['fundstelle'], 'Übung U-2026-01 → rueckweg.json')
        self.assertEqual((z['urteil'], z['pruefung']['luecken_offen']), ('offen', ['L-003', 'L-004']))

    def test_gegenprobe_geaendertes_artefakt_ist_rot(self):
        ordner = self.w.wurzel / 'uebungen'
        shutil.copytree(WELT / 'uebungen', ordner)
        artefakt = ordner / 'U-2026-01' / 'rueckweg.json'
        artefakt.write_text(artefakt.read_text(encoding='utf-8').replace('"exit_code": 0', '"exit_code": 1'),
                            encoding='utf-8')
        fehler, e = uebungen.bewerte(ordner / 'U-2026-01.json', ordner, WELT / 'blatt' / 'nach-der-uebung.yaml')
        self.assertIsNone(e)
        self.assertEqual(fehler, ['artefakt: sha256 von U-2026-01/rueckweg.json stimmt nicht - Artefakt und Eintrag '
                                  'gehören nicht zusammen'])

    def test_gegenprobe_nach_dem_rhythmus_ist_die_uebung_faellig(self):
        z = zeile(self.w.bewertung('2027-04-15', blatt='nach-der-uebung.yaml', uebung=True)[0], 'Z-015')
        self.assertEqual(befunde(z)[self.RUECKWEG]['grund'], 'uebung_faellig')
        _, e = uebungen.bewerte(WELT / 'uebungen' / 'U-2026-01.json', WELT / 'uebungen')
        self.assertIn('offen: Wiederherstellung: nächste Übung fällig seit 05.04.2027 (BT1; Betreiber)',
                      uebungen.faelligkeit([e], datetime.date(2027, 4, 15)))


class RF08Vertragsende(Fall):
    """RF-08: Das Vertragsende nach E10 = A - beenden, mitnehmen, nach der Frist löschen, Löschnachweis (NW-5).

    Der Ablauf selbst läuft im Produkt (KundenbereichBeendetApiTest, GesamtabzugApiTest,
    KundenbereichLoeschenApiTest, Testcontainers); hier trägt ihn die Matrix über deren Lauf-Berichte,
    und die Artefakte des Produkts (Selbstauskunft, Gesamtabzug mit Manifest, Löschnachweis) liegen als
    FIXTURE in seiner Form vor."""

    V = WELT / 'vertragsende'

    def setUp(self):
        super().setUp()
        self.w.uebergaenge('RF-08')
        self.auskunft = lade(self.V / 'selbstauskunft.json')['kundenbereich']['beendet']
        self.manifest = lade(self.V / 'abzug' / 'manifest.json')
        self.nachweis = lade(self.V / 'loeschnachweis.json')

    def test_fall(self):
        self.assertEqual(luecken.verstoesse(self.w.liste, self.w.matrix), [])
        z = zeile(self.w.bewertung('2026-09-28')[0], 'Z-016')
        self.assertEqual((z['urteil'], [n['fundstelle'] for n in z['nachweise']]), ('belegt', z['nachweis_kandidaten']))
        frist = (datetime.date.fromisoformat(self.auskunft['beendet_am'])
                 + datetime.timedelta(days=self.nachweis['frist_tage'])).isoformat()
        spalten = spalten_loeschnachweis()
        self.assertEqual({
            'loeschung_fruehestens': frist,
            'gleich_in_auskunft_manifest_nachweis': {self.auskunft['loeschung_fruehestens'],
                                                     self.manifest['loeschung_fruehestens'],
                                                     self.nachweis['loeschung_fruehestens']} == {frist},
            'abzug_manifest': pruefsummen_abweichend(self.V / 'abzug', 'pruefsummen.sha256') == [],
            'abzug_sha256_im_nachweis': self.nachweis['abzug_sha256'] == sha256(self.V / 'abzug' / 'manifest.json'),
            'loeschnachweis_nur_spalten_des_produkts': set(self.nachweis) <= spalten,
            'loeschnachweis_mit_personendaten': any(PERSONENDATEN.search(s) for s in spalten | set(self.nachweis)),
            'anonymisiert': self.nachweis['verblieben'] != {},
        }, {'loeschung_fruehestens': '2029-09-28', 'gleich_in_auskunft_manifest_nachweis': True,
            'abzug_manifest': True, 'abzug_sha256_im_nachweis': True, 'loeschnachweis_nur_spalten_des_produkts': True,
            'loeschnachweis_mit_personendaten': False, 'anonymisiert': False})
        self.assertIn('frühestens am 28.09.2029', self.auskunft['text'])
        self.assertEqual((self.nachweis['zaehlungen']['benutzer'], self.nachweis['zaehlungen']['energiemanagement_person']),
                         (7, 6))

    def test_gegenprobe_loeschtest_uebersprungen_ist_offen(self):
        bericht = (WELT / 'laeufe' / 'gebaut' / LOESCHEN).read_text(encoding='utf-8')
        neu = bericht.replace('skipped="0"', 'skipped="2"').replace('time="1.5"/>', 'time="0"><skipped/></testcase>')
        z = zeile(self.w.bewertung('2026-09-28', laeufe=[self.w.kopie('gebaut', aendern={LOESCHEN: (bericht, neu)})])[0],
                  'Z-016')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['uebersprungen']))

    def test_gegenprobe_offene_luecke_haelt_das_vertragsende_offen(self):
        """Vor dem Übergang von L-001 hält die Lücke Z-016 offen, obwohl jeder Test grün ist (NR6)."""
        self.w.matrix, self.w.liste = lade(WELT / 'matrix.json'), lade(WELT / 'luecken.json')
        z = zeile(self.w.bewertung('2026-09-28')[0], 'Z-016')
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['luecke_offen']))

    def test_gegenprobe_name_im_loeschnachweis_ist_rot(self):
        nachweis = dict(self.nachweis, name='Kunststoffwerk Ahrenberg GmbH')
        self.assertEqual(set(nachweis) - spalten_loeschnachweis(), {'name'})
        self.assertTrue(any(PERSONENDATEN.search(s) for s in nachweis))

    def test_gegenprobe_geaenderte_datei_im_abzug_ist_rot(self):
        abzug = self.w.wurzel / 'abzug'
        shutil.copytree(self.V / 'abzug', abzug)
        (abzug / 'messreihen' / 'messwert.csv').write_bytes(b'\xef\xbb\xbfzeit;wert\r\n2029-06-29T22:00:00Z;0\r\n')
        self.assertEqual(pruefsummen_abweichend(abzug, 'pruefsummen.sha256'), ['messreihen/messwert.csv'])


class RF09Produktbeschreibung(Fall):
    """RF-09: Der Wächter findet verbotene Wörter UND verweigert Sätze an offenen Zeilen (NW-4, NW-6).

    Geprüft gegen die Bewertung BWB-2027-01, die der Matrix-Prüfer aus der Fixture-Matrix schreibt - nicht
    gegen die Kurzform `positiv_in_bewertung` des Konzepts."""

    # Konzept wörtlich; der Wächter darf mehr Funde nennen („ISO“ neben „ISO 50001“), nie weniger.
    ERWARTET = [
        (['auditfest', 'konform', 'ISO 50001'], False, False),
        (['konform', 'DSGVO-konform'], False, False),
        ([], True, True),
        ([], False, False),
        ([], True, True),
    ]

    def entwurf_gegen_bwb(self):
        _, b, _, pfad, _ = self.w.pruefe('2027-01-20', kennung='BWB-2027-01', aus=self.w.wurzel / 'bwb')
        return b, pfad, produktbeschreibung.pruefe_entwurf(lade(WELT / 'beschreibung' / 'pb-01.json'),
                                                           produktbeschreibung.Bewertungsstand.aus(b))

    def test_fall(self):
        self.w.uebergaenge('RF-09')
        b, pfad, ergebnis = self.entwurf_gegen_bwb()
        self.assertEqual((zeile(b, 'Z-004')['urteil'], zeile(b, 'Z-010')['urteil']), ('belegt', 'offen'))
        for ist, (funde, gebunden, zugelassen) in zip(ergebnis['ergebnis'], self.ERWARTET, strict=True):
            with self.subTest(satz=ist['satz']):
                self.assertLessEqual(set(funde), set(ist['funde']))
                self.assertEqual((bool(ist['funde']), ist['gebunden_an_positive_zeile'], ist['zugelassen']),
                                 (bool(funde), gebunden, zugelassen))
        self.assertEqual((ergebnis['zugelassen'], ergebnis['abgelehnt']), (2, 3))
        raus = io.StringIO()
        with contextlib.redirect_stdout(raus):
            code = produktbeschreibung.main(['--entwurf', str(WELT / 'beschreibung' / 'pb-01.json'),
                                             '--bewertung', str(pfad)])
        self.assertEqual(code, 1)
        rot = next(z for z in raus.getvalue().splitlines() if z.startswith('rot: '))
        self.assertRegex(rot, r'^rot: Satz 1: auditfest, .*konform — verboten · Satz 2: DSGVO-konform, konform — '
                              r'verboten · Satz 4: an Z-010 gebunden, Z-010 ist offen$')

    def test_gegenprobe_offene_luecke_verweigert_auch_satz_3(self):
        """Ohne den Übergang von L-009 ist Z-004 offen (NR6) - dann fällt auch der Satz an Z-004."""
        b, _, ergebnis = self.entwurf_gegen_bwb()
        self.assertEqual(zeile(b, 'Z-004')['urteil'], 'offen')
        self.assertEqual((ergebnis['zugelassen'], ergebnis['abgelehnt']), (1, 4))
        self.assertEqual(ergebnis['ergebnis'][2]['grund'], 'an Z-004 gebunden, Z-004 ist offen')


class RF10PilotDurchlauf(Fall):
    """RF-10: Der Pilot-Auditdurchlauf am Referenzfall (NW-6). Protokoll und Durchlauf sind FIXTURE.

    Einen Leser für ein Protokoll gibt es erst mit AP-20 IP-14. Geprüft wird, was die Werkzeuge heute
    tragen: Prüfsumme, Person nach NR4, Befund-Ziele auf Lückenliste und Kundenaufgaben, G2."""

    P = WELT / 'pilot'

    def setUp(self):
        super().setUp()
        self.protokoll = lade(self.P / 'PA-2026-01.json')
        self.ctx = pruefe_matrix.Kontext(NEU, datetime.date(2026, 11, 20), self.w.repo, liste=self.w.liste)

    def test_fall(self):
        p = self.protokoll
        b, _ = self.w.bewertung(p['datum'])
        ziele = {x['kennung']: x['ziel'] for x in p['befunde']}
        ka = {k['kennzeichen']: k for k in b['kundenaufgaben']}
        self.assertEqual({
            'zustaende': [z['nach'] for z in p['zustaende']],
            'befunde': ziele,
            'b1_haelt_den_umfang_offen': [kz for kz in p['umfang_zusagen']
                                          if ziele['B-1'] in zeile(b, kz)['pruefung']['luecken_offen']],
            'b2_ist_kundenaufgabe_ohne_urteil': 'urteil' not in ka[ziele['B-2']],
            'b2_im_umfang': set(ka[ziele['B-2']]['norm']) <= set(p['umfang_norm']),
            'protokoll_mit_pruefsumme': pruefsummen_abweichend(self.P, 'PA-2026-01.sha256') == [],
            'auditorin_ist_person': self.ctx.nr4(p['auditorin'], p['datum'], p['aussage']),
            'luecke_beim_kunden': luecken.auf_kundenflaechen(),
        }, {'zustaende': ['vorbereitet', 'durchgefuehrt', 'protokolliert'], 'befunde': {'B-1': 'L-009', 'B-2': 'KA-08'},
            'b1_haelt_den_umfang_offen': ['Z-004'], 'b2_ist_kundenaufgabe_ohne_urteil': True, 'b2_im_umfang': True,
            'protokoll_mit_pruefsumme': True, 'auditorin_ist_person': None, 'luecke_beim_kunden': []})
        self.assertLessEqual(set(p['umfang_norm']), {n['abschnitt'] for n in b['norm_teil']})
        self.assertEqual(luecke(self.w.liste, 'L-009')['zustand'], 'offen')

    def test_gegenprobe_geaendertes_protokoll_ist_rot(self):
        kopie = self.w.wurzel / 'pilot'
        shutil.copytree(self.P, kopie)
        text = (kopie / 'PA-2026-01.json').read_text(encoding='utf-8')
        (kopie / 'PA-2026-01.json').write_text(text.replace('"ziel": "L-009"', '"ziel": "KA-08"'), encoding='utf-8')
        self.assertEqual(pruefsummen_abweichend(kopie, 'PA-2026-01.sha256'), ['PA-2026-01.json'])

    def test_gegenprobe_auditorin_nur_als_rolle_ist_offen(self):
        grund, _ = self.ctx.nr4('Fachperson', self.protokoll['datum'], self.protokoll['aussage'])
        self.assertEqual(grund, 'ohne_person')


class RF11AelterBelegTraegtNicht(Fall):
    """RF-11: Ungeprüft bleibt offen - ein älterer Beleg trägt einen neuen Stand nicht (NW-2)."""

    def test_fall(self):
        b, md = self.w.bewertung('2026-09-28', laeufe=('gebaut', 'tor-g1'))
        z = zeile(b, 'Z-009')
        kandidaten = [befunde(z)[k]['grund'] for k in z['nachweis_kandidaten']]
        self.assertEqual((z['urteil'], kandidaten), ('offen', ['aelterer_stand', 'aelterer_stand']))
        self.assertIn('älterer Stand', md_zeile(md, '| Z-009 |'))
        self.assertIn('Crew', wer(z))

    def test_gegenprobe_ohne_stand_txt_bleibt_offen(self):
        z = zeile(self.w.bewertung('2026-09-28', laeufe=(self.w.kopie('tor-g1', stand=False),))[0], 'Z-009')
        self.assertEqual([befunde(z)[k]['grund'] for k in z['nachweis_kandidaten']], ['ohne_stand_txt'] * 2)

    def test_kontrolle_derselbe_bericht_am_gepruefen_stand_ist_gruen(self):
        """Ursache ist der Stand: derselbe Bericht mit der Kennung dieses Standes ist grün; offen hält Z-009
        dann nur noch L-006 (NR6). Die Prüfung „älterer Stand“ des Falls ist hier rot."""
        z = zeile(self.w.bewertung('2026-09-28', laeufe=(self.w.kopie('tor-g1', stand=NEU),))[0], 'Z-009')
        self.assertEqual([befunde(z)[k]['grund'] for k in z['nachweis_kandidaten']], ['gruen', 'gruen'])
        self.assertEqual((z['urteil'], gruende(z)), ('offen', ['luecke_offen']))


class RF12NormTeil(Fall):
    """RF-12: Der Norm-Teil ist in der Gliederung vollständig - und sagt nichts über den Kunden (NW-1)."""

    TRAEGER = {'haelt_fest': 15, 'verweis': 7, 'misst': 4, 'beim_kunden': 4}

    def test_fall(self):
        fehlend, je_traeger = nachweismatrix.gliederung(self.w.matrix)
        b, _ = self.w.bewertung('2026-09-28')
        self.assertEqual({'zeilen': len(self.w.matrix['norm_teil']), 'je_traeger': je_traeger, 'fehlend': fehlend,
                          'ohne_zuordnung': [n['abschnitt'] for n in b['norm_teil']
                                             if n['pruefung']['luecken_offen'] == ['L-012']],
                          'aussage_ueber_kunden': [k for k in b['kundenaufgaben'] if 'urteil' in k] or None},
                         {'zeilen': 30, 'je_traeger': self.TRAEGER, 'fehlend': [],
                          'ohne_zuordnung': ['4.4', '6.3', '9.1.1'], 'aussage_ueber_kunden': None})
        self.assertEqual(b['zaehlung']['norm_teil']['je_traeger'], self.TRAEGER)
        raus = io.StringIO()
        with contextlib.redirect_stdout(raus):
            self.assertEqual(nachweismatrix.main([str(WELT / 'matrix.json')]), 0)
        self.assertIn('Norm-Teil je Träger (RF-12): haelt_fest 15 · verweis 7 · misst 4 · beim_kunden 4; '
                      'jede Zeile der Gliederung existiert', raus.getvalue())

    def test_gegenprobe_fehlende_zeile_ist_rot(self):
        self.w.matrix['norm_teil'] = [n for n in self.w.matrix['norm_teil'] if n['abschnitt'] != '9.1.1']
        self.assertEqual(nachweismatrix.gliederung(self.w.matrix)[0], ['9.1.1'])
        self.assertIn('kundenaufgaben[KA-04].norm: Abschnitt 9.1.1 hat keine Zeile im Norm-Teil',
                      nachweismatrix.verstoesse(self.w.matrix))
        self.assertEqual(self.w.pruefe('2026-09-28')[0], 2)


if __name__ == '__main__':
    unittest.main()
