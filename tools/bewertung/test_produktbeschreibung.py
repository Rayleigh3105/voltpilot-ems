#!/usr/bin/env python3
"""Produktbeschreibung und Übersicht für Prüfende mit Wächter (AP-20 IP-21, E7 = A, PB1-PB5, NW-4).

    python3 -m unittest discover -s tools/bewertung -p 'test_*.py'

Abnahme der §8-Zeile: RF-09 — Satz 1 und 2 rot an Wörtern, Satz 4 rot an der Bindung, Satz 3 und die
neutrale Nennung grün (NW-4). Jede Gegenprobe ändert genau eine Stelle und muss rot werden. Dazu: die
Dateien im Repo sind der Bau aus der jüngsten Bewertung, ein zweiter Bau ist byte-gleich, der Entwurf trägt
sichtbar seinen Stand, und eine abgelöste, geänderte oder nicht freigegebene Bewertung meldet der Wächter (PB5).
"""

import copy
import io
import json
import pathlib
import re
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import nachweismatrix  # noqa: E402
import produktbeschreibung as pb  # noqa: E402

HIER = pathlib.Path(__file__).resolve().parent
RF09 = HIER / 'fixtures' / 'produktbeschreibung' / 'rf09.json'
GLOSSAR = pb.REPO / 'frontend' / 'portal' / 'src' / 'glossar.ts'
ENTWURF = 'Entwurf — Bewertung BWB-2026-01, gebauter Stand, nicht freigegeben'


def still(fn, *args):
    with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()):
        code = fn(*args)
    return code, out.getvalue()


def rf09():
    return json.loads(RF09.read_text(encoding='utf-8'))


def fixture_stand(positiv):
    return pb.Bewertungsstand(positiv, sonst='offen')


def glossar_satz(name):
    text = GLOSSAR.read_text(encoding='utf-8')
    return re.search(rf"export const {name} =\s*'([^']*)'", text).group(1)


class RF09Waechter(unittest.TestCase):
    """RF-09 an der Fixture aus dem Konzept, wörtlich (NW-4)."""

    def setUp(self):
        self.fall = rf09()
        self.ergebnis = pb.pruefe_entwurf(self.fall, fixture_stand(self.fall['positiv_in_bewertung']))

    def test_rf09_satz_1_und_2_rot_an_woertern_satz_4_an_der_bindung_satz_3_und_die_neutrale_nennung_gruen(self):
        erwartet = self.fall['erwartet']
        self.assertEqual((self.ergebnis['zugelassen'], self.ergebnis['abgelehnt']),
                         (erwartet['zugelassen'], erwartet['abgelehnt']))
        for ist, soll in zip(self.ergebnis['ergebnis'], erwartet['ergebnis'], strict=True):
            with self.subTest(soll['satz']):
                self.assertEqual(ist['satz'], soll['satz'])
                self.assertEqual(ist['gebunden_an_positive_zeile'], soll['gebunden_an_positive_zeile'])
                self.assertEqual(ist['zugelassen'], soll['zugelassen'])
                # Die Funde des Konzepts findet der Wächter alle; er darf mehr nennen (etwa „ISO“ neben „ISO 50001“).
                self.assertTrue(set(soll['funde']) <= set(ist['funde']), ist['funde'])
                self.assertEqual(bool(ist['funde']), bool(soll['funde']))

    def test_die_meldung_nennt_woerter_und_bindung(self):
        meldung = pb.meldung(self.ergebnis)
        self.assertIn('Satz 1: auditfest', meldung)
        self.assertIn('Satz 2: DSGVO-konform, konform — verboten', meldung)
        self.assertIn('Satz 4: an Z-010 gebunden, Z-010 ist offen', meldung)
        self.assertNotIn('Satz 3', meldung)
        self.assertNotIn('Satz 5', meldung)

    def test_der_aufruf_ueber_die_fixture_ist_rot(self):
        code, out = still(pb.main, ['--entwurf', str(RF09)])
        self.assertEqual(code, 1, out)
        self.assertIn('2 zugelassen, 3 abgelehnt', out)

    # ---- Gegenproben: je eine Änderung, jede rot ---------------------------- #

    def pruefe(self, satz, zusage=None, positiv=None):
        return pb.pruefe_satz({'satz': satz, 'zusage': zusage},
                              fixture_stand(positiv if positiv is not None else self.fall['positiv_in_bewertung']))

    def test_gegenprobe_satz_3_an_offener_zeile_faellt_ohne_verbotenes_wort(self):
        satz3 = self.fall['saetze'][2]['satz']
        e = self.pruefe(satz3, 'Z-004', positiv={})
        self.assertEqual(e['funde'], [])
        self.assertFalse(e['zugelassen'])
        self.assertEqual(e['grund'], 'an Z-004 gebunden, Z-004 ist offen')

    def test_gegenprobe_satz_3_ohne_bindung_faellt(self):
        self.assertFalse(self.pruefe(self.fall['saetze'][2]['satz'], None)['zugelassen'])

    def test_gegenprobe_satz_3_mit_verbotenem_wort_faellt_trotz_positiver_zeile(self):
        e = self.pruefe(self.fall['saetze'][2]['satz'].replace('fest und', 'revisionssicher fest und'), 'Z-004')
        self.assertTrue(e['gebunden_an_positive_zeile'])
        self.assertFalse(e['zugelassen'])
        self.assertEqual(e['funde'], ['revisionssicher'])

    def test_gegenprobe_satz_1_faellt_auch_an_positiver_zeile(self):
        self.assertFalse(self.pruefe(self.fall['saetze'][0]['satz'], 'Z-004')['zugelassen'])

    def test_gegenprobe_satz_4_geht_erst_durch_wenn_z010_positiv_ist(self):
        satz4 = self.fall['saetze'][3]['satz']
        self.assertFalse(self.pruefe(satz4, 'Z-010')['zugelassen'])
        self.assertTrue(self.pruefe(satz4, 'Z-010', positiv={'Z-010': 'nicht_maschinell_pruefbar'})['zugelassen'])
        self.assertFalse(self.pruefe(satz4, 'Z-010', positiv={'Z-010': 'nicht_zugesagt'})['zugelassen'])

    def test_gegenprobe_die_neutrale_nennung_mit_zusatz_faellt(self):
        neutral = self.fall['saetze'][4]['satz']
        self.assertTrue(self.pruefe(neutral)['zugelassen'])
        for zusatz in ('VoltPilot ist nach ISO 50001 aufgestellt.', 'Ihre Ablage ist auditfest.'):
            with self.subTest(zusatz):
                self.assertFalse(self.pruefe(f'{neutral} {zusatz}')['zugelassen'])
        self.assertFalse(self.pruefe(neutral.replace('nicht ', ''))['zugelassen'])

    def test_gegenprobe_eine_zusage_die_nicht_in_der_bewertung_steht(self):
        e = pb.pruefe_satz({'satz': 'Ein Satz.', 'zusage': 'Z-999'}, pb.Bewertungsstand({'Z-004': 'belegt'}))
        self.assertFalse(e['zugelassen'])
        self.assertEqual(e['grund'], 'an Z-999 gebunden, Z-999 steht nicht in der Bewertung')


class Wortliste(unittest.TestCase):
    """PB2: AP-14 S1, AP-19 SP2, Rechtsaussagen; PB3: Nummern. Proben wie in copy.test.ts."""

    def regeln(self, text):
        return {r for _, r in pb.funde(text)}

    def test_s1_wird_an_behauptungen_rot_und_laesst_die_abgrenzung_zu(self):
        for probe in ('VoltPilot ist ISO-konform.', 'VoltPilot ist zertifiziert nach einer Energiemanagement-Norm.',
                      'VoltPilot arbeitet normkonform.', 'VoltPilot erfüllt ISO 50001.'):
            with self.subTest(probe):
                self.assertIn('S1', self.regeln(probe))
        self.assertEqual(pb.funde(pb.NORMGRENZE), [])
        self.assertEqual(pb.funde(pb.NEUTRALE_ISO_NENNUNG), [])

    def test_sp2_beisst_an_jedem_wort_und_laesst_die_wortgrenzen_heil(self):
        for probe in ('Nichtkonformität', 'Nicht-Konformität', 'Korrekturmaßnahme', 'Aktionsplan', 'Ursachenanalyse',
                      'CAPA', 'konform', 'nicht konform', 'Konformität', 'normkonform', 'zertifiziert',
                      'zertifizierbar', 'Zertifizierungsaudit', 'zertifizierungsreif', 'auditfest', 'audit-sicher',
                      'auditsichere Ablage', 'auditbereit', 'revisionssicher', 'normgerecht', 'EnMS',
                      'Managementsystem', 'Energiemanagementsystem', 'Erfüllungsgrad', 'Reifegrad',
                      'vollständig dokumentiert', 'vollständig erfüllt', 'Ihr Energiemanagement ist vollständig',
                      'alle Nachweise liegen vor', 'bereit für das Audit', 'bereit für die Zertifizierung',
                      'bereit für das externe Audit', 'ISO', 'nach ISO', 'hat gewirkt', 'Einsparung durch'):
            with self.subTest(probe):
                self.assertNotEqual(pb.funde(f'Energiemanagement: {probe}.'), [])
        self.assertEqual(pb.funde('Das interne Audit festhalten, das Audit sicher planen, Fassungen vollständig '
                                  'lesen: Isolierung, Museum, Zertifikat und Transaktionsplanung bleiben normale '
                                  'Wörter.'), [])
        verantwortung = glossar_satz('UEMS_VERANTWORTUNG')
        self.assertEqual(pb.funde(f'{verantwortung} {pb.NORMGRENZE}'), [])

    def test_pb2_rechtsaussagen_fallen_auch_an_der_anmeldung(self):
        for probe in ('Verschlüsselt · Server in Deutschland · DSGVO-konform', 'Encrypted · GDPR compliant',
                      'Ihre Daten liegen rechtssicher in Deutschland.', 'Die Verfügbarkeit ist garantiert.',
                      'Mit Garantie.'):
            with self.subTest(probe):
                self.assertIn('PB2', self.regeln(probe))
        self.assertEqual(pb.funde('Verschlüsselt · Server in Deutschland'), [])
        self.assertEqual(pb.funde('Encrypted · Servers in Germany'), [])

    def test_pb3_keine_norm_nummer_ausser_kennzeichen_daten_und_fassungen(self):
        for probe in ('DIN EN ISO 50001', 'EN 16247-1', '50001', 'nach 50003', 'Kapitel 9.2', 'Abschnitt 10.2',
                      'Ziffer 6.3'):
            with self.subTest(probe):
                self.assertIn('PB3', self.regeln(f'Energiemanagement: {probe}.'))
        for probe in ('AU-2029-0001', 'IH-SG-01, Rev. 4 vom 03.11.2028', '12.02.2029, 14:10', '50 001 kWh',
                      'Stand Nr. 1', 'Fassung 2', 'D-0001'):
            with self.subTest(probe):
                self.assertNotIn('PB3', self.regeln(probe))
        self.assertIsNotNone(pb.ABSCHNITTSNUMMER.search('siehe 7.5.3 und 10.2'))
        self.assertIsNone(pb.ABSCHNITTSNUMMER.search('bis 01.10.2026, 2,5 kWh, Fassung 1.1'))

    def test_grenz_und_verantwortungs_satz_stehen_wort_fuer_wort_wie_im_portal(self):
        # E8 = A: unverändert; eine Quelle im Portal, hier nur gespiegelt.
        self.assertEqual(pb.NORMGRENZE, glossar_satz('UEMS_NORMGRENZE'))
        quelle = json.loads(pb.QUELLE.read_text(encoding='utf-8'))
        self.assertEqual(quelle['verantwortung']['satz'], glossar_satz('UEMS_VERANTWORTUNG'))


class BeschreibungImRepo(unittest.TestCase):

    def setUp(self):
        self.beschreibung = (pb.AUS_PFAD / 'beschreibung.md').read_text(encoding='utf-8')
        self.uebersicht = (pb.AUS_PFAD / 'uebersicht-fuer-pruefende.md').read_text(encoding='utf-8')
        self.daten = json.loads((pb.AUS_PFAD / 'produktbeschreibung.json').read_text(encoding='utf-8'))
        self.quelle = json.loads(pb.QUELLE.read_text(encoding='utf-8'))
        self.bwb = json.loads(pb.juengste_bewertung().read_text(encoding='utf-8'))

    def test_die_dateien_im_repo_sind_der_bau_und_der_waechter_meldet_den_entwurf(self):
        code, out = still(pb.main, ['--check'])
        self.assertEqual(code, 0, out)
        self.assertIn(f'Beschreibung hält: PB-01 beruht auf BWB-2026-01 (gebauter Stand, entwurf) · {ENTWURF}', out)
        self.assertIn('an Z-004 gebunden, Z-004 ist offen', out)

    def test_zweiter_bau_ist_byte_gleich(self):
        self.assertEqual(pb.baue(), pb.baue())

    def test_der_entwurf_traegt_sichtbar_seinen_stand(self):
        self.assertIn(f'> **{ENTWURF}.**', self.beschreibung)
        self.assertIn(f'> **{ENTWURF}.**', self.uebersicht)
        self.assertEqual(self.daten['zustand'], 'entwurf')
        self.assertIsNone(self.daten['freigegeben_von'])
        self.assertEqual(self.daten['bewertung']['sha256'], pb.sha256(pb.juengste_bewertung().read_bytes()))

    def test_vor_der_ausgabe_ist_ein_entwurf_rot(self):
        code, out = still(pb.main, ['--vor-ausgabe'])
        self.assertEqual(code, 1, out)
        self.assertIn(f'rot: {ENTWURF}: keine Ausgabe, keine positive Aussage im Vertrieb (PB5)', out)

    def test_jeder_satz_der_beschreibung_ist_gebunden_und_ein_satz_an_offener_zeile_fehlt(self):
        for f in self.quelle['funktionen']:
            with self.subTest(f['zusage']):
                urteil = next(z['urteil'] for z in self.bwb['zusagen'] if z['kennzeichen'] == f['zusage'])
                self.assertEqual(f['satz'] in self.beschreibung, urteil in pb.POSITIV)
        self.assertIn('*Gebunden an Z-002, belegt in BWB-2026-01.*', self.beschreibung)
        for e in self.daten['waechter']['saetze']:
            with self.subTest(e['satz']):
                self.assertEqual(e['funde'], [])
                self.assertEqual(e['zugelassen'], e['gebunden_an_positive_zeile'])

    def test_kundenaufgaben_und_restpunkte_stehen_dabei(self):
        for k in self.bwb['kundenaufgaben']:
            self.assertIn(f'*({k["kennzeichen"]})*', self.beschreibung)
        self.assertIn('Bei Ihnen bleibt: Warum ein Monat anders war', self.beschreibung)
        self.assertIn('In der Bewertung BWB-2026-01 ist kein Restpunkt angenommen.', self.beschreibung)
        self.assertNotIn(self.quelle['restpunkte'][0]['satz'], self.beschreibung)

    def test_abschnittsnummern_nur_in_der_uebersicht(self):
        self.assertIsNone(pb.ABSCHNITTSNUMMER.search(self.beschreibung))
        enum = nachweismatrix.lade_schema()['$defs']['abschnitt']['enum']
        self.assertEqual(re.findall(r'^\| ((?:\d+\.)+\d+) \|', self.uebersicht, re.MULTILINE), enum)

    def test_die_uebersicht_hat_kopf_stand_datum_grenz_satz_spalten_und_fuss(self):
        for teil in (pb.UEBERSICHT_KOPF, pb.NORMGRENZE, '| ' + ' | '.join(pb.SPALTEN) + ' |',
                     f'| Stand | `{self.bwb["stand"][:9]}` |', '| Datum | 25.09.2026 |',
                     '| Bewertung | BWB-2026-01, gebauter Stand |'):
            self.assertIn(teil, self.uebersicht)
        self.assertTrue(self.uebersicht.rstrip().endswith(pb.NEUTRALE_ISO_NENNUNG))

    def test_nirgends_im_portal_oder_in_einem_bericht_verlinkt(self):
        self.assertEqual(pb.verweise(), [])


class PB5UndGegenproben(unittest.TestCase):
    """Der Bau an veränderten Eingaben; jede Gegenprobe ändert genau eine Stelle."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self._tmp.name)
        self.bwb = json.loads(pb.juengste_bewertung().read_text(encoding='utf-8'))
        self.quelle = json.loads(pb.QUELLE.read_text(encoding='utf-8'))

    def tearDown(self):
        self._tmp.cleanup()

    def schreibe(self, daten, name):
        pfad = self.dir / name
        pfad.write_text(json.dumps(daten, ensure_ascii=False, indent=1), encoding='utf-8')
        return pfad

    def bwb_mit(self, name='BWB-2026-01.json', **aenderung):
        b = copy.deepcopy(self.bwb)
        b.update(aenderung)
        return b, name

    def baue_nach(self, bwb_pfad, aus='aus', quelle=None):
        args = ['--aus', str(self.dir / aus), '--bewertung', str(bwb_pfad)]
        if quelle:
            args += ['--quelle', str(quelle)]
        return still(pb.main, args)

    def urteil(self, b, kz, urteil):
        next(z for z in b['zusagen'] if z['kennzeichen'] == kz)['urteil'] = urteil

    def test_gegenprobe_abgeloest_eine_juengere_bewertung_ist_rot(self):
        pfad = self.schreibe(*self.bwb_mit('BWB-2026-02.json', kennung='BWB-2026-02'))
        code, out = still(pb.main, ['--check', '--bewertung', str(pfad)])
        self.assertEqual(code, 1, out)
        self.assertIn('abgelöst: die Beschreibung beruht auf BWB-2026-01, die jüngste Bewertung ist BWB-2026-02', out)

    def test_gegenprobe_freigegebene_bewertung_verlangt_einen_neuen_bau(self):
        pfad = self.schreibe(*self.bwb_mit(zustand='freigegeben'))
        code, out = still(pb.main, ['--check', '--bewertung', str(pfad)])
        self.assertEqual(code, 1, out)
        self.assertIn('ist nicht mehr die, aus der die Beschreibung entstand', out)
        self.assertEqual(self.baue_nach(pfad)[0], 0)
        aus = self.dir / 'aus'
        self.assertNotIn('Entwurf', (aus / 'beschreibung.md').read_text(encoding='utf-8'))
        self.assertEqual(json.loads((aus / 'produktbeschreibung.json').read_text(encoding='utf-8'))['zustand'],
                         'geprueft')
        code, out = still(pb.main, ['--vor-ausgabe', '--aus', str(aus), '--bewertung', str(pfad)])
        self.assertEqual(code, 0, out)

    def test_gegenprobe_von_hand_geaendert_oder_fremde_datei_ist_rot(self):
        self.assertEqual(self.baue_nach(pb.juengste_bewertung())[0], 0)
        aus = self.dir / 'aus'
        code, out = still(pb.main, ['--check', '--aus', str(aus)])
        self.assertEqual(code, 0, out)
        md = aus / 'beschreibung.md'
        md.write_text(md.read_text(encoding='utf-8').replace('Entwurf — ', ''), encoding='utf-8')
        code, out = still(pb.main, ['--check', '--aus', str(aus)])
        self.assertEqual(code, 1, out)
        self.assertIn('beschreibung.md ist nicht der Bau aus den Quellen', out)
        self.baue_nach(pb.juengste_bewertung())
        (aus / 'vertrieb.md').write_text('x\n', encoding='utf-8')
        code, out = still(pb.main, ['--check', '--aus', str(aus)])
        self.assertEqual(code, 1, out)
        self.assertIn('vertrieb.md gehört nicht zur Beschreibung', out)

    def test_wird_z004_belegt_steht_sein_satz_mit_den_kundenaufgaben_dabei(self):
        b, name = self.bwb_mit()
        self.urteil(b, 'Z-004', 'belegt')
        self.assertEqual(self.baue_nach(self.schreibe(b, name))[0], 0)
        md = (self.dir / 'aus' / 'beschreibung.md').read_text(encoding='utf-8')
        self.assertIn(self.quelle['funktionen'][0]['satz'], md)
        self.assertIn('*Gebunden an Z-004, belegt in BWB-2026-01.*', md)
        self.assertIn('Bei Ihnen bleibt: Entscheidungen der Leitung', md)

    def test_gegenprobe_wird_z002_offen_faellt_sein_satz_heraus(self):
        b, name = self.bwb_mit()
        self.urteil(b, 'Z-002', 'offen')
        self.assertEqual(self.baue_nach(self.schreibe(b, name))[0], 0)
        aus = self.dir / 'aus'
        satz = self.quelle['funktionen'][1]['satz']
        self.assertNotIn(satz, (aus / 'beschreibung.md').read_text(encoding='utf-8'))
        self.assertNotIn(satz, (aus / 'uebersicht-fuer-pruefende.md').read_text(encoding='utf-8'))

    def test_ein_angenommener_restpunkt_steht_mit_seiner_grenze_dabei(self):
        b, name = self.bwb_mit()
        l4 = next(l for l in b['luecken'] if l['kennzeichen'] == 'L-004')
        l4.update(zustand='restpunkt', grenze='Kopie im selben Rechenzentrum', bis='2027-03-31')
        self.assertEqual(self.baue_nach(self.schreibe(b, name))[0], 0)
        md = (self.dir / 'aus' / 'beschreibung.md').read_text(encoding='utf-8')
        self.assertIn('- Eine Kopie der Sicherung außerhalb des Rechenzentrums gibt es derzeit nicht. '
                      'Grenze: Kopie im selben Rechenzentrum, bis 31.03.2027. *(L-004)*', md)

    def test_gegenprobe_ein_restpunkt_ohne_satz_ist_rot(self):
        b, name = self.bwb_mit()
        next(l for l in b['luecken'] if l['kennzeichen'] == 'L-003').update(
            zustand='restpunkt', grenze='kein Alarm', bis='2027-03-31')
        code, out = self.baue_nach(self.schreibe(b, name))
        self.assertEqual(code, 1, out)
        self.assertIn('L-003 ist Restpunkt in BWB-2026-01 und hat keinen Satz in der Quelle (PB4)', out)

    def test_gegenprobe_ein_verbotenes_wort_in_der_quelle_baut_nichts(self):
        q = copy.deepcopy(self.quelle)
        q['funktionen'][1]['satz'] += ' Damit ist Ihr Energiemanagement auditfest.'
        code, out = self.baue_nach(pb.juengste_bewertung(), quelle=self.schreibe(q, 'quelle.json'))
        self.assertEqual(code, 1, out)
        self.assertIn('auditfest', out)
        self.assertFalse((self.dir / 'aus').exists())

    def test_gegenprobe_eine_abschnittsnummer_in_der_beschreibung_ist_rot(self):
        q = copy.deepcopy(self.quelle)
        q['kundenaufgaben'][0]['satz'] += ' Siehe 7.2.'
        code, out = self.baue_nach(pb.juengste_bewertung(), quelle=self.schreibe(q, 'quelle.json'))
        self.assertEqual(code, 1, out)
        self.assertIn('eine Abschnittsnummer steht nur in der Übersicht (PB3)', out)

    def test_gegenprobe_ein_verweis_aus_dem_portal_wird_gefunden(self):
        portal = self.dir / 'portal'
        portal.mkdir()
        (portal / 'Hilfe.tsx').write_text("const a = 'docs/bewertung/produktbeschreibung/beschreibung.md';\n",
                                          encoding='utf-8')
        self.assertEqual(len(pb.verweise([portal])), 1)


if __name__ == '__main__':
    unittest.main()
