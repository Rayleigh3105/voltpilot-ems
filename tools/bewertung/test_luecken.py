#!/usr/bin/env python3
"""Wache der Lückenliste (AP-20 NW-3) - an der Liste im Repo, an Gegenproben und am Referenzfall RF-06.

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Braucht `jsonschema` (wie der Vertragstest der Matrix). Fehlt es, bricht der Lauf mit ImportError
ab - er wird nie übersprungen (NR2).
"""

import copy
import datetime
import io
import json
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import luecken  # noqa: E402

README = luecken.REPO / 'docs' / 'bewertung' / 'README.md'

# Das geschlossene Vokabular Zustand, festgenagelt: wer es ändert, ändert Schema, README,
# UEBERGAENGE und diese Zeile.
ZUSTAENDE = ['offen', 'in_arbeit', 'behoben', 'restpunkt']

# Der Startbestand des Fundaments (report.md §3.3): Kennzeichen und was die Lücke betrifft.
STARTBESTAND = {
    'L-001': ['Z-016'], 'L-002': ['Z-012'], 'L-003': ['Z-015'], 'L-004': ['Z-015'],
    'L-005': ['Z-017'], 'L-006': ['Z-009'], 'L-007': ['Z-007'], 'L-008': ['Z-008'],
    'L-009': ['Z-004'], 'L-010': [], 'L-011': ['Z-012'], 'L-012': ['4.4', '6.3', '9.1.1'],
}

STAND = '0c53dadd9'


def lade(pfad):
    return json.loads(pathlib.Path(pfad).read_text(encoding='utf-8'))


def luecke(liste, kz):
    return next(l for l in liste['luecken'] if l['kennzeichen'] == kz)


def zusage(matrix, kz):
    return next(z for z in matrix['zusagen'] if z['kennzeichen'] == kz)


def normzeile(matrix, abschnitt):
    return next(z for z in matrix['norm_teil'] if z['abschnitt'] == abschnitt)


def l012_wieder_offen(liste):
    """L-012 wie vor AP-20 IP-7: nur der Übergang nach offen."""
    l = luecke(liste, 'L-012')
    l['verlauf'], l['zustand'] = l['verlauf'][:1], 'offen'


def l003_wie_im_referenzfall(liste):
    """L-003 wie im Referenzfall RF-06 (`offen` seit 2026-09-25): die Liste im Repo steht seit AP-20 IP-19
    auf `in_arbeit`; RF-06 und die Gegenproben spielen den ganzen Weg ab `offen`."""
    l = luecke(liste, 'L-003')
    l['verlauf'], l['zustand'] = l['verlauf'][:1], 'offen'


def uebergang(liste, kz, am, nach, **mehr):
    l = luecke(liste, kz)
    l['verlauf'].append({'am': am, 'nach': nach, 'person': 'Crew (Test)', 'begruendung': 'Gegenprobe', **mehr})
    l['zustand'] = nach


def nachweis():
    return {'art': 'protokoll', 'fundstelle': 'Alarm-Übung VoltPilotSicherungZuAlt, Protokoll', 'stand': STAND,
            'datum': '2026-11-02', 'gefahren_von': 'Betreiber'}


def restpunkt(bis='2027-03-31', **ueber):
    return {'angenommen_von': 'Captain', 'grenze': 'Ein Verlust der Daten-VM verliert auch die Sicherung.',
            'bis': bis, **ueber}


def rf06():
    """RF-06: L-003 offen → in_arbeit → behoben, L-004 offen → restpunkt (Captain, Grenze, bis 31.03.2027)."""
    liste, matrix = lade(luecken.LISTE_PFAD), lade(luecken.MATRIX_PFAD)
    l003_wie_im_referenzfall(liste)
    uebergang(liste, 'L-003', '2026-10-01', 'in_arbeit')
    uebergang(liste, 'L-003', '2026-11-02', 'behoben', nachweis=nachweis())
    zusage(matrix, 'Z-015')['luecken'].remove('L-003')
    uebergang(liste, 'L-004', '2026-10-05', 'restpunkt', **restpunkt())
    return liste, matrix


class ImRepo(unittest.TestCase):

    def test_das_schema_ist_ein_gueltiges_json_schema(self):
        from jsonschema import Draft202012Validator
        Draft202012Validator.check_schema(luecken.lade_schema())

    def test_die_liste_im_repo_haelt_die_wache(self):
        self.assertEqual(luecken.verstoesse(lade(luecken.LISTE_PFAD), lade(luecken.MATRIX_PFAD)), [])

    def test_keine_luecke_steht_auf_einer_kundenflaeche_g2(self):
        self.assertEqual(luecken.auf_kundenflaechen(), [])

    def test_der_startbestand_sind_die_zwoelf_luecken_des_fundaments(self):
        liste = lade(luecken.LISTE_PFAD)
        self.assertEqual({l['kennzeichen']: l['betrifft'] for l in liste['luecken'][:12]}, STARTBESTAND)
        for l in liste['luecken'][:12]:
            self.assertEqual((l['verlauf'][0]['am'], l['verlauf'][0]['nach']), ('2026-09-25', 'offen'), l['kennzeichen'])

    def test_l003_ist_erst_mit_ausgeloester_alarm_uebung_behoben_nr8(self):
        """AP-20 IP-19 liefert Export und Regel-Vorschlag; behoben trägt erst gitops-Merge UND Alarm-Übung (RF-06)."""
        l = luecke(lade(luecken.LISTE_PFAD), 'L-003')
        if l['zustand'] == 'behoben':
            self.assertIn('VoltPilotSicherungZuAlt', l['verlauf'][-1]['nachweis']['fundstelle'])
            self.assertEqual('Betreiber', l['verlauf'][-1]['nachweis']['gefahren_von'])
        else:
            self.assertEqual('in_arbeit', l['zustand'])
            self.assertIn('Betreiber', [w['wer'] for w in l['wer_liefert']])

    def test_l004_steht_offen_bis_der_captain_den_restpunkt_annimmt_la6(self):
        l = luecke(lade(luecken.LISTE_PFAD), 'L-004')
        self.assertTrue(l['zustand'] != 'restpunkt' or l['verlauf'][-1]['angenommen_von'] == 'Captain')
        self.assertIn('Captain', [w['wer'] for w in l['wer_liefert']])


class Gegenproben(unittest.TestCase):
    """Jede Gegenprobe ändert die grüne Liste oder Matrix an genau einer Stelle und muss rot werden."""

    def setUp(self):
        self.l, self.m = lade(luecken.LISTE_PFAD), lade(luecken.MATRIX_PFAD)
        l003_wie_im_referenzfall(self.l)
        self.assertEqual(luecken.verstoesse(self.l, self.m), [], 'Liste und Matrix müssen vor der Gegenprobe grün sein')

    def assertRot(self, *erwartet, liste=None, matrix=None):
        fehler = luecken.verstoesse(liste or self.l, matrix or self.m)
        self.assertTrue(fehler, 'erwartet rot, war grün')
        text = '\n'.join(fehler)
        for teil in erwartet:
            self.assertIn(teil, text)
        return fehler

    def assertGruen(self):
        self.assertEqual(luecken.verstoesse(self.l, self.m), [])

    # LU5: neue Lücke ohne Eintrag

    def test_eine_neue_luecke_an_einer_zusage_ohne_eintrag_ist_rot_lu5(self):
        zusage(self.m, 'Z-010')['luecken'].append('L-013')
        self.assertRot('zusagen[Z-010].luecken: L-013 steht nicht auf der Lückenliste - neue Lücke ohne Eintrag (LU5)')

    def test_eine_neue_luecke_an_einer_norm_zeile_ohne_eintrag_ist_rot_lu5(self):
        normzeile(self.m, '7.2')['luecken'].append('L-013')
        self.assertRot('norm_teil[7.2].luecken: L-013 steht nicht auf der Lückenliste')

    def test_eine_neue_luecke_in_einem_text_der_matrix_ist_rot_lu5(self):
        zusage(self.m, 'Z-010')['wer_liefert'][0]['was'] += ' (siehe L-013)'
        self.assertRot('zusagen/', 'L-013 steht nicht auf der Lückenliste')

    def test_eine_neue_luecke_mit_eintrag_ist_gruen(self):
        neu = copy.deepcopy(luecke(self.l, 'L-011'))
        neu.update(kennzeichen='L-013', text='Ein Befund aus dem Review', quelle='Review', betrifft=['Z-010'])
        self.l['luecken'].append(neu)
        zusage(self.m, 'Z-010')['luecken'].append('L-013')
        self.assertGruen()

    # LU5: geheilt, heißt aber offen

    def test_eine_geheilte_luecke_die_noch_offen_heisst_ist_rot_lu5(self):
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot('L-003 heißt offen, aber zusagen[Z-015] nennt sie nicht mehr - geheilt?')

    def test_in_arbeit_zaehlt_wie_offen_lu5(self):
        uebergang(self.l, 'L-003', '2026-10-01', 'in_arbeit')
        self.assertGruen()
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot('L-003 heißt in_arbeit, aber zusagen[Z-015] nennt sie nicht mehr')

    def test_ein_restpunkt_den_die_zeile_nicht_mehr_nennt_ist_rot_lu4(self):
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **restpunkt())
        zusage(self.m, 'Z-015')['luecken'].remove('L-004')
        self.assertRot('L-004 heißt restpunkt, aber zusagen[Z-015] nennt sie nicht mehr')

    def test_l012_ist_mit_ip7_behoben_und_ohne_eintrag_waere_sie_rot(self):
        self.assertEqual(luecke(self.l, 'L-012')['zustand'], 'behoben')
        self.assertEqual(luecke(self.l, 'L-012')['verlauf'][-1]['nachweis']['stand'][:9], '1575a6311')
        l012_wieder_offen(self.l)
        self.assertRot('L-012 heißt offen, aber norm_teil[4.4] nennt sie nicht mehr',
                       'norm_teil[6.3] nennt sie nicht mehr', 'norm_teil[9.1.1] nennt sie nicht mehr')

    def test_ein_noch_leerer_teil_wird_nicht_gebunden(self):
        l012_wieder_offen(self.l)
        self.m['norm_teil'] = []
        self.assertGruen()

    def test_eine_behobene_luecke_die_noch_genannt_wird_ist_rot(self):
        uebergang(self.l, 'L-003', '2026-10-01', 'in_arbeit')
        uebergang(self.l, 'L-003', '2026-11-02', 'behoben', nachweis=nachweis())
        self.assertRot('zusagen[Z-015].luecken: L-003 ist behoben und hält nichts mehr - den Verweis entfernen')

    def test_eine_zeile_die_eine_fremde_luecke_nennt_ist_rot(self):
        zusage(self.m, 'Z-016')['luecken'].append('L-003')
        self.assertRot('zusagen[Z-016].luecken: L-003 betrifft Z-016 nicht')

    def test_betrifft_eine_zusage_die_es_nicht_gibt_ist_rot(self):
        luecke(self.l, 'L-010')['betrifft'] = ['Z-999']
        self.assertRot('L-010.betrifft: Z-999 gibt es im Teil zusagen der Matrix nicht')

    def test_betrifft_eine_kundenaufgabe_ist_rot_nr5(self):
        luecke(self.l, 'L-010')['betrifft'] = ['KA-01']
        self.assertRot('luecken/9/betrifft/0')

    # LU3: Restpunkt nur mit dem Captain, mit Grenze und Datum

    def test_ein_restpunkt_ohne_captain_ist_rot_lu3(self):
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **restpunkt(angenommen_von='Crew'))
        self.assertRot('luecken/3/verlauf/1/angenommen_von', "'Captain' was expected",
                       'L-004.verlauf[1]: Restpunkt ohne angenommen_von: Captain - einen Restpunkt nimmt nur der Captain an')

    def test_ein_restpunkt_ohne_annahme_ist_rot_lu3(self):
        rp = restpunkt()
        del rp['angenommen_von']
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **rp)
        self.assertRot("'angenommen_von' is a required property")

    def test_ein_restpunkt_ohne_grenze_ist_rot_lu3(self):
        rp = restpunkt()
        del rp['grenze']
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **rp)
        self.assertRot("'grenze' is a required property", 'L-004.verlauf[1]: Restpunkt ohne grenze')

    def test_ein_restpunkt_ohne_datum_bis_ist_rot_lu3(self):
        rp = restpunkt()
        del rp['bis']
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **rp)
        self.assertRot("'bis' is a required property")

    def test_ein_restpunkt_der_nicht_nach_der_annahme_endet_ist_rot_lu3(self):
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **restpunkt(bis='2026-10-05'))
        self.assertRot('L-004.verlauf[1]: Restpunkt bis 2026-10-05 endet nicht nach der Annahme')

    def test_eine_annahme_an_einem_anderen_uebergang_ist_rot(self):
        uebergang(self.l, 'L-004', '2026-10-05', 'in_arbeit', angenommen_von='Captain')
        self.assertRot('luecken/3/verlauf/1')

    def test_der_captain_kann_einen_restpunkt_verlaengern(self):
        uebergang(self.l, 'L-004', '2026-10-05', 'restpunkt', **restpunkt())
        uebergang(self.l, 'L-004', '2027-04-16', 'restpunkt', **restpunkt(bis='2027-09-30'))
        self.assertGruen()

    # LU1/LU2: Verlauf und Nachweis

    def test_behoben_ohne_nachweis_ist_rot_lu2(self):
        uebergang(self.l, 'L-003', '2026-10-01', 'in_arbeit')
        uebergang(self.l, 'L-003', '2026-11-02', 'behoben')
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot("'nachweis' is a required property")

    def test_ein_nachweis_ohne_stand_ist_rot_nr3(self):
        n = nachweis()
        del n['stand']
        uebergang(self.l, 'L-003', '2026-10-01', 'in_arbeit')
        uebergang(self.l, 'L-003', '2026-11-02', 'behoben', nachweis=n)
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot("'stand' is a required property")

    def test_ein_test_lauf_ohne_bericht_ist_rot_nr1(self):
        n = dict(nachweis(), art='test_lauf')
        uebergang(self.l, 'L-003', '2026-10-01', 'in_arbeit')
        uebergang(self.l, 'L-003', '2026-11-02', 'behoben', nachweis=n)
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot("'lauf' is a required property")

    def test_offen_direkt_nach_behoben_ist_rot_lu2(self):
        uebergang(self.l, 'L-003', '2026-11-02', 'behoben', nachweis=nachweis())
        zusage(self.m, 'Z-015')['luecken'].remove('L-003')
        self.assertRot('L-003.verlauf[1]: offen → behoben ist kein erlaubter Übergang')

    def test_ein_verlauf_der_nicht_mit_offen_beginnt_ist_rot_lu1(self):
        luecke(self.l, 'L-001')['verlauf'][0]['nach'] = 'in_arbeit'
        luecke(self.l, 'L-001')['zustand'] = 'in_arbeit'
        self.assertRot('L-001.verlauf[0]: der erste Übergang führt nach offen')

    def test_ein_uebergang_ohne_begruendung_ist_rot_lu1(self):
        del luecke(self.l, 'L-001')['verlauf'][0]['begruendung']
        self.assertRot("'begruendung' is a required property")

    def test_ein_uebergang_ohne_person_ist_rot_lu1(self):
        luecke(self.l, 'L-001')['verlauf'][0]['person'] = ''
        self.assertRot('luecken/0/verlauf/0/person')

    def test_ein_uebergang_vor_dem_vorigen_ist_rot_lu1(self):
        uebergang(self.l, 'L-003', '2026-09-24', 'in_arbeit')
        self.assertRot('L-003.verlauf[1]: 2026-09-24 liegt vor dem Übergang davor')

    def test_ein_zustand_der_nicht_dem_letzten_uebergang_folgt_ist_rot_lu1(self):
        luecke(self.l, 'L-001')['zustand'] = 'in_arbeit'
        self.assertRot('L-001.zustand: in_arbeit, der letzte Übergang führt nach offen')

    def test_ein_zustand_ausserhalb_des_vokabulars_ist_rot(self):
        luecke(self.l, 'L-001')['zustand'] = 'erledigt'
        self.assertRot('luecken/0/zustand', "'erledigt' is not one of")

    def test_eine_geloeschte_luecke_ist_rot(self):
        del self.l['luecken'][4]
        self.assertRot('luecken[4]: L-006 steht, wo L-005 stehen muss',
                       'zusagen[Z-017].luecken: L-005 steht nicht auf der Lückenliste')

    def test_ein_doppeltes_kennzeichen_ist_rot(self):
        self.l['luecken'][1]['kennzeichen'] = 'L-001'
        self.assertRot('luecken[1]: L-001 steht, wo L-002 stehen muss')

    def test_ein_unbekanntes_feld_ist_rot(self):
        luecke(self.l, 'L-001')['kunde_sieht'] = True
        self.assertRot('Additional properties are not allowed')

    def test_eine_nachweis_kennung_ohne_paket_ist_rot_nr9(self):
        luecke(self.l, 'L-006')['text'] = 'Alarm-Übung NW-6 offen'
        self.assertRot('luecken/5/text: Nachweis-Kennung „NW-6“ ohne Paket')

    # NR6/LU4: eine offene Lücke hält die Zeile offen, ein Restpunkt begrenzt nur

    def test_eine_offene_luecke_haelt_die_zusage_offen_nr6(self):
        z = zusage(self.m, 'Z-015')
        z['urteil'], z['nachweise'] = 'belegt', [nachweis()]
        self.assertRot('zusagen[Z-015]: Urteil belegt, aber die Lücke L-003 (offen) hält die Zeile offen (NR6)',
                       'die Lücke L-004 (offen)')

    def test_eine_offene_luecke_haelt_die_norm_zeile_offen_nr6(self):
        l012_wieder_offen(self.l)
        for a in ('4.4', '6.3', '9.1.1'):
            normzeile(self.m, a)['luecken'].append('L-012')
        self.assertGruen()
        normzeile(self.m, '4.4')['urteil'] = 'nicht_maschinell_pruefbar'
        self.assertRot('norm_teil[4.4]: Urteil nicht_maschinell_pruefbar, aber die Lücke L-012 (offen)')

    def test_nicht_zugesagt_mit_offener_luecke_ist_gruen(self):
        z = zusage(self.m, 'Z-012')
        z['urteil'], z['grund'] = 'nicht_zugesagt', 'die Zeile entfällt (AP-20 E9 = A)'
        self.assertGruen()

    def test_ein_restpunkt_haelt_die_zusage_nicht_offen_lu4(self):
        self.l, self.m = rf06()
        z = zusage(self.m, 'Z-015')
        z['urteil'], z['nachweise'] = 'belegt', [nachweis()]
        self.assertGruen()


class Kundenflaechen(unittest.TestCase):

    def baum(self, dateien):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        wurzel = pathlib.Path(tmp.name)
        for pfad, inhalt in dateien.items():
            (wurzel / pfad).parent.mkdir(parents=True, exist_ok=True)
            (wurzel / pfad).write_text(inhalt, encoding='utf-8')
        return wurzel

    def test_eine_luecke_im_portal_ist_rot_g2(self):
        wurzel = self.baum({'frontend/portal/src/Hilfe.tsx': 'export const x = 1;\nconst hinweis = "L-004";\n'})
        self.assertEqual(luecken.auf_kundenflaechen(wurzel),
                         ['frontend/portal/src/Hilfe.tsx:2: L-004 auf einer Kundenfläche - eine Lücke von VoltPilot '
                          'erscheint nie beim Kunden (G2)'])

    def test_eine_luecke_in_berichtsvorlage_theme_und_release_notiz_ist_rot_g2(self):
        wurzel = self.baum({
            'services/api/src/main/resources/berichte/bericht-vorlagen.json': '{"satz": "L-001"}',
            'deploy/keycloak/themes/voltpilot/login/messages/messages_de.properties': 'x=L-002',
            'docs/rollout/release-notiz-vorlage.md': 'Hinweis zu L-003',
        })
        self.assertEqual(len(luecken.auf_kundenflaechen(wurzel)), 3)

    def test_tests_und_betreiber_dokumente_sind_keine_kundenflaeche(self):
        wurzel = self.baum({
            'frontend/portal/src/Hilfe.test.tsx': 'L-004',
            'frontend/portal/e2e/hilfe.spec.ts': 'L-004',
            'services/api/src/test/java/X.java': 'L-004',
            'docs/bewertung/luecken.json': 'L-004',
            'docs/backup-restore.md': 'L-004',
        })
        self.assertEqual(luecken.auf_kundenflaechen(wurzel), [])


class ReferenzfallRF06(unittest.TestCase):
    """RF-06: Zustände einer Lücke, Restpunkt mit Grenze, Frist beim Abruf, nie beim Kunden."""

    def setUp(self):
        self.l, self.m = rf06()

    def test_der_verlauf_haelt_die_wache(self):
        self.assertEqual(luecken.verstoesse(self.l, self.m), [])
        self.assertEqual([u['nach'] for u in luecke(self.l, 'L-003')['verlauf']], ['offen', 'in_arbeit', 'behoben'])
        self.assertEqual([u['nach'] for u in luecke(self.l, 'L-004')['verlauf']], ['offen', 'restpunkt'])
        self.assertEqual(luecke(self.l, 'L-004')['verlauf'][-1]['angenommen_von'], 'Captain')

    def test_am_lesetag_ist_die_frist_ueberschritten(self):
        zeile = luecken.zeile(luecke(self.l, 'L-004'), datetime.date(2027, 4, 15))
        self.assertEqual(zeile, 'L-004 · restpunkt seit 2026-10-05 · Grenze: Ein Verlust der Daten-VM verliert auch '
                                'die Sicherung. · angenommen vom Captain · bis 2027-03-31 · Frist überschritten seit '
                                '2027-03-31 · betrifft Z-015 · liefert: Betreiber, Captain')

    def test_am_letzten_tag_der_frist_ist_sie_nicht_ueberschritten(self):
        zeile = luecken.zeile(luecke(self.l, 'L-004'), datetime.date(2027, 3, 31))
        self.assertNotIn('überschritten', zeile)

    def test_eine_behobene_luecke_nennt_keinen_lieferanten(self):
        self.assertEqual(luecken.zeile(luecke(self.l, 'L-003'), datetime.date(2027, 4, 15)),
                         'L-003 · behoben seit 2026-11-02 · betrifft Z-015')


class Vokabulare(unittest.TestCase):

    def test_das_schema_traegt_genau_das_festgenagelte_vokabular(self):
        self.assertEqual(luecken.lade_schema()['$defs']['zustand']['enum'], ZUSTAENDE)
        self.assertEqual(sorted(luecken.UEBERGAENGE), sorted(ZUSTAENDE))
        self.assertTrue(set(luecken.HAELT_OFFEN) < set(ZUSTAENDE))

    def test_das_readme_nennt_jeden_zustand_und_jeden_uebergang(self):
        text = README.read_text(encoding='utf-8')
        for z in ZUSTAENDE:
            self.assertIn(f'`{z}`', text)
        for von, nach in ((v, n) for v, ns in luecken.UEBERGAENGE.items() for n in ns):
            self.assertIn(f'`{von}` → `{nach}`', text)


class Kommandozeile(unittest.TestCase):

    def lauf(self, *argv):
        aus = io.StringIO()
        with redirect_stdout(aus):
            code = luecken.main(list(argv))
        return code, aus.getvalue()

    def schreibe(self, tmp, liste, matrix):
        pl, pm = pathlib.Path(tmp) / 'luecken.json', pathlib.Path(tmp) / 'matrix.json'
        pl.write_text(json.dumps(liste, ensure_ascii=False), encoding='utf-8')
        pm.write_text(json.dumps(matrix, ensure_ascii=False), encoding='utf-8')
        return str(pl), str(pm)

    def test_gruen_an_der_liste_im_repo(self):
        code, aus = self.lauf('--heute', '2026-09-25')
        self.assertEqual(code, 0, aus)
        zeilen = aus.strip().splitlines()
        self.assertIn('Wache hält', zeilen[0])
        self.assertEqual([z.split(' · ')[0] for z in zeilen[1:13]], list(STARTBESTAND))

    def test_die_frist_wird_beim_abruf_gerechnet(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, aus = self.lauf('--heute', '2027-04-15', *self.schreibe(tmp, *rf06()))
        self.assertEqual(code, 0, aus)
        self.assertIn('Frist überschritten seit 2027-03-31', aus)
        self.assertIn('1 restpunkt', aus)

    def test_rot_mit_einer_zeile_je_verstoss(self):
        liste, matrix = lade(luecken.LISTE_PFAD), lade(luecken.MATRIX_PFAD)
        zusage(matrix, 'Z-010')['luecken'].append('L-013')
        zusage(matrix, 'Z-015')['luecken'].remove('L-003')
        with tempfile.TemporaryDirectory() as tmp:
            code, aus = self.lauf(*self.schreibe(tmp, liste, matrix))
        self.assertEqual(code, 1)
        zeilen = aus.strip().splitlines()
        self.assertEqual(len(zeilen), 2, aus)
        self.assertTrue(all(z.startswith('rot: ') for z in zeilen), aus)

    def test_aufruffehler_ist_exit_2(self):
        for argv in (['--heute', '15.04.2027'], ['--weg'], ['a', 'b', 'c']):
            with self.subTest(argv=argv), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(luecken.main(argv), 2)


if __name__ == '__main__':
    unittest.main()
