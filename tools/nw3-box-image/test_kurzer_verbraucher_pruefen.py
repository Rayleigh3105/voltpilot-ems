#!/usr/bin/env python3
"""Zusatzlauf „kurzer Verbraucher" (Lade- und Ruhe-Viertelstunde): wann das Urteil gruen ist.

Gruen verlangt drei Dinge zugleich - kein Entlade-Befehl, nichts aus dem Speicher
eingespeist, und einen Lauf, der ueberhaupt etwas beweist (geladen, genug
Verbraucher, lueckenlos protokolliert). Aufruf:
    python3 -m unittest tools/nw3-box-image/test_kurzer_verbraucher_pruefen.py
"""
import importlib.util, pathlib, unittest

_spec = importlib.util.spec_from_file_location(
    "kurzer_verbraucher_pruefen",
    pathlib.Path(__file__).with_name("kurzer_verbraucher_pruefen.py"))
pruefen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pruefen)

PV, VERBRAUCHER = 5.0, 2.62


def protokoll(sekunden, batt_bei, verbraucher_ab=(20, 80, 140, 200), schreiben=(),
              ueberschuss=lambda t: 0.76):
    """Ein Simulator-Protokoll: batt_bei(t, verbraucher_laeuft) liefert die Batterieleistung."""
    zeilen = []
    for t in range(sekunden):
        an = any(ab <= t < ab + 12 for ab in verbraucher_ab)
        ue = ueberschuss(t)
        last = PV - ue + (VERBRAUCHER if an else 0)
        batt = batt_bei(t, an)
        zeilen.append(f"[szenario] t={t}.0 pv={PV:.3f} last={last:.3f} batt={batt:.3f} "
                      f"netz={last + batt - PV:.3f} soc=37.00 ueberschuss={ue} "
                      f"verbraucher={1 if an else 0}")
    for t, kw in schreiben:
        zeilen.append(f"[szenario] schreiben t={t}.0 sollwert={kw:.3f}")
    return "\n".join(zeilen)


class Urteil(unittest.TestCase):
    def test_laden_bleibt_und_nichts_wird_entladen_ist_gruen(self):
        text = protokoll(240, lambda t, an: 0.0 if an else 0.26,
                         schreiben=[(10, 0.26), (30, 0.0), (40, 0.26)])
        r = pruefen.urteile(text, 0, 240)
        self.assertEqual(r["urteil"], "gruen", r["satz"])
        self.assertEqual(r["verbraucher"], 4)
        self.assertEqual(r["verbraucher_je_ueberschuss_kw"], {"0.76": 4})
        self.assertEqual(r["entlade_befehle"], 0)
        self.assertEqual(r["aus_dem_speicher_eingespeist_kwh"], 0)

    def test_entladung_nach_dem_verbraucher_ist_rot(self):
        # Der Fehler von Herzogau: der Entlade-Befehl wirkt, wenn der Verbraucher schon aus ist.
        def batt(t, an):
            return -1.86 if any(ab + 12 <= t < ab + 24 for ab in (20, 80, 140, 200)) else 0.26
        text = protokoll(240, batt, schreiben=[(10, 0.26), (30, -1.86), (45, 0.26)])
        r = pruefen.urteile(text, 0, 240)
        self.assertEqual(r["urteil"], "rot", r["satz"])
        self.assertEqual(r["entlade_befehle"], 1)
        self.assertEqual(r["aus_dem_speicher_eingespeist_s"], 48)
        self.assertEqual(r["laengste_einspeisung_aus_dem_speicher_s"], 12)
        self.assertGreater(r["aus_dem_speicher_eingespeist_kwh"], 0.02)
        # Der Verbraucher endete bei 32 s, der Befehl stand bis 45 s.
        self.assertEqual(r["entlade_befehl_stand_nach_verbraucher_ende_s"], [13.0])

    def test_ein_entlade_befehl_allein_ist_schon_rot(self):
        text = protokoll(240, lambda t, an: 0.0 if an else 0.26,
                         schreiben=[(10, 0.26), (30, -0.5), (31, 0.0)])
        self.assertEqual(pruefen.urteile(text, 0, 240)["urteil"], "rot")

    def test_zu_wenige_verbraucher_beweisen_nichts(self):
        text = protokoll(240, lambda t, an: 0.26, verbraucher_ab=(20,), schreiben=[(10, 0.26)])
        self.assertEqual(pruefen.urteile(text, 0, 240)["urteil"], "nicht_gefahren")

    def test_ein_abschnitt_mit_nur_einem_verbraucher_beweist_nichts(self):
        # Vier Verbraucher insgesamt, aber im zweiten Ueberschuss-Abschnitt nur einer.
        text = protokoll(240, lambda t, an: 0.0 if an else 0.26,
                         schreiben=[(10, 0.26)], ueberschuss=lambda t: 0.76 if t < 190 else 0.5)
        r = pruefen.urteile(text, 0, 240)
        self.assertEqual(r["verbraucher_je_ueberschuss_kw"], {"0.76": 3, "0.5": 1})
        self.assertEqual(r["urteil"], "nicht_gefahren")

    def test_eine_box_die_nie_laedt_beweist_nichts(self):
        text = protokoll(240, lambda t, an: 0.0, schreiben=[(10, 0.0)])
        self.assertEqual(pruefen.urteile(text, 0, 240)["urteil"], "nicht_gefahren")

    def test_ein_unterbrochenes_protokoll_ist_kein_urteil(self):
        text = protokoll(120, lambda t, an: 0.26, schreiben=[(10, 0.26)])
        self.assertEqual(pruefen.urteile(text, 0, 240)["urteil"], "nicht_gefahren")

    def test_nur_das_fenster_zaehlt(self):
        # Ein Entlade-Befehl VOR dem Fenster (Anlauf) faerbt das Urteil nicht.
        text = protokoll(300, lambda t, an: 0.0 if an else 0.26,
                         verbraucher_ab=(70, 120, 180, 240),
                         schreiben=[(5, -1.0), (65, 0.26)])
        self.assertEqual(pruefen.urteile(text, 60, 300)["urteil"], "gruen")

    def test_ohne_geplantes_laden_ist_eine_entladung_nach_dem_verbraucher_rot(self):
        # Fall ruhe, Stand bis edge-2026.10.1: die Box deckte sofort, der Speicher
        # speiste nach dem Ende des Verbrauchers ein. Seit dem Entscheid A vom
        # 13.10.2026 gilt die Haltezeit auch hier - das ist rot, mit den Zahlen.
        def batt(t, an):
            return -1.36 if any(ab + 6 <= t < ab + 40 for ab in (20, 80, 140, 200)) else 0.0
        text = protokoll(260, batt, schreiben=[(26, -1.36), (60, 0.0)])
        r = pruefen.urteile(text, 0, 260, fall="ruhe")
        self.assertEqual(r["urteil"], "rot", r["satz"])
        self.assertEqual(r["laengste_einspeisung_aus_dem_speicher_s"], 28)
        self.assertEqual(r["entlade_befehl_stand_nach_verbraucher_ende_s"], [28.0])

    def test_ohne_geplantes_laden_ruht_der_speicher_durch_kurze_verbraucher_ist_gruen(self):
        # Fall ruhe mit Haltezeit: kein Entlade-Befehl, der Speicher ruht. Dass
        # nie geladen wurde, ist hier kein Mangel - die Viertelstunde plant keins.
        text = protokoll(260, lambda t, an: 0.0, schreiben=[(5, 0.0)])
        r = pruefen.urteile(text, 0, 260, fall="ruhe")
        self.assertEqual(r["urteil"], "gruen", r["satz"])
        self.assertEqual(r["entlade_befehle"], 0)
        self.assertEqual(r["geladen_kwh"], 0.0)

    def test_ohne_geplantes_laden_ist_ein_entlade_befehl_allein_schon_rot(self):
        text = protokoll(260, lambda t, an: 0.0, schreiben=[(26, -1.36), (40, 0.0)])
        self.assertEqual(pruefen.urteile(text, 0, 260, fall="ruhe")["urteil"], "rot")

    def test_ohne_geplantes_laden_beweisen_zu_wenige_verbraucher_auch_nichts(self):
        text = protokoll(260, lambda t, an: 0.0, verbraucher_ab=(20, 80))
        self.assertEqual(pruefen.urteile(text, 0, 260, fall="ruhe")["urteil"], "nicht_gefahren")


if __name__ == "__main__":
    unittest.main()
