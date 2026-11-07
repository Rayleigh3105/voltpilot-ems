#!/usr/bin/env python3
"""Die Tore der tenant_id-Reparatur gegen Fixtures - ohne Keycloak, ohne Datenbank, ohne Betreiberdaten.

    python3 -m unittest discover -s tools/keycloak-tenant-attribut -p 'test_*.py'

tenant-attribut.sh schreibt ein tenant_id nur für eine Zeile aus plan.csv (auswerten), die
plan-lesen annimmt und für die konto-pruefen unmittelbar davor SETZEN sagt. Ein falsches Ja an
einer dieser Stellen gibt einem Konto einen fremden Kundenbereich; diese Fälle halten fest, wann
die Auswertung Nein sagt.
"""

import contextlib
import csv
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import tenant_attribut as ta  # noqa: E402

KUNDE_A = "aaaaaaaa-0000-4000-8000-00000000000a"
KUNDE_B = "bbbbbbbb-0000-4000-8000-00000000000b"
DB_SPALTEN = ["art", "tenant_id", "kundenbereich", "segment", "kundenbereich_seit", "kundenbereich_beendet",
              "sub", "konto", "email", "anzeigename", "zustand", "spiegel_seit", "zuweisungen_wirksam",
              "zuweisungen_je", "rollen_wirksam", "stichtag", "stichtag_herkunft", "stichtag_konten"]


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def konto(n, name, email=None, **extra):
    return {"id": uid(n), "username": name, "email": email or f"{name}@example.test", "enabled": True,
            "createdTimestamp": 1760000000000, **extra}


def token(rollen, tenant_id=None, sub=None, name=None):
    t = {"realm_access": {"roles": list(rollen)}, "sub": sub, "preferred_username": name}
    if tenant_id:
        t["tenant_id"] = tenant_id
    return t


def spiegel(n, tenant_id, email=None, zustand="aktiv", konto_art="benutzer", beendet=""):
    return {"art": "konto", "tenant_id": tenant_id, "kundenbereich": f"Bereich {tenant_id[:1].upper()}",
            "kundenbereich_seit": "2026-01-01 00:00:00+00", "kundenbereich_beendet": beendet,
            "sub": uid(n), "konto": konto_art, "email": email or "", "zustand": zustand,
            "spiegel_seit": "2026-10-10 08:00:00+00"}


def bereich(tenant_id, beendet=""):
    return {"art": "kundenbereich", "tenant_id": tenant_id, "kundenbereich": f"Bereich {tenant_id[:1].upper()}",
            "kundenbereich_beendet": beendet}


class Sweep:
    """Ein Sweep-Verzeichnis, wie tenant-attribut.sh es vor `auswerten` füllt."""

    def __init__(self, d):
        self.d = d
        self.users = []
        os.makedirs(os.path.join(d, "token"))

    def konto(self, user, tok):
        self.users.append(user)
        if tok is not None:
            with open(os.path.join(self.d, "token", f"{user['id']}.json"), "w", encoding="utf-8") as f:
                json.dump(tok, f)

    def db(self, zeilen, vorspann=""):
        with open(os.path.join(self.d, "db.csv"), "w", newline="", encoding="utf-8") as f:
            f.write(vorspann)
            w = csv.DictWriter(f, fieldnames=DB_SPALTEN, restval="")
            w.writeheader()
            for z in zeilen:
                w.writerow(z)

    def auswerten(self):
        with open(os.path.join(self.d, "users.json"), "w", encoding="utf-8") as f:
            json.dump(self.users, f)
        with contextlib.redirect_stdout(io.StringIO()):
            self.rc = ta.cmd_auswerten(self.d)
        with open(os.path.join(self.d, "befund.csv"), encoding="utf-8") as f:
            self.befund = {r["username"]: r for r in csv.DictReader(f)}
        with open(os.path.join(self.d, "plan.csv"), encoding="utf-8") as f:
            zeilen = [z for z in f.read().splitlines() if not z.startswith("#")]
        self.plan = {r["username"]: r for r in csv.DictReader(zeilen)}
        return self


class AuswertenTest(unittest.TestCase):
    """plan.csv nimmt nur ein Kundenkonto ohne Claim mit EINEM lebenden Spiegel unter derselben Kennung."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.sweep = Sweep(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_eindeutiger_spiegel_derselben_kennung_wird_reparierbar(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"]))
        self.sweep.db([spiegel(1, KUNDE_A), bereich(KUNDE_A)])
        s = self.sweep.auswerten()
        self.assertEqual(s.rc, 0)
        self.assertEqual(s.befund["anna"]["klasse"], "betroffen")
        self.assertEqual(s.plan["anna"]["id"], uid(1))
        self.assertEqual(s.plan["anna"]["ziel_tenant"], KUNDE_A)
        self.assertEqual(s.plan["anna"]["quelle"], "spiegel-sub")

    def test_psql_statuszeilen_vor_der_kopfzeile_aendern_nichts(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"]))
        self.sweep.db([spiegel(1, KUNDE_A), bereich(KUNDE_A)], vorspann="BEGIN\nSET\nSET\n")
        self.assertEqual(self.sweep.auswerten().plan["anna"]["ziel_tenant"], KUNDE_A)

    def test_nie_ueber_die_email_einer_anderen_kennung(self):
        # Dieselbe Adresse unter einer anderen Keycloak-Kennung ist ein neu angelegtes Konto oder ein
        # fremdes - die Rechte hängen an der alten Kennung. Das Ziel bestimmt der Betreiber.
        self.sweep.konto(konto(1, "anna", email="anna@example.test"), token(["operator"]))
        self.sweep.db([spiegel(9, KUNDE_A, email="anna@example.test"), bereich(KUNDE_A)])
        s = self.sweep.auswerten()
        self.assertNotIn("anna", s.plan)
        self.assertEqual(s.befund["anna"]["klasse"], "betroffen")
        self.assertIn(uid(9), s.befund["anna"]["grund"])

    def test_spiegel_in_zwei_kundenbereichen_entscheidet_der_betreiber(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"]))
        self.sweep.db([spiegel(1, KUNDE_A), spiegel(1, KUNDE_B), bereich(KUNDE_A), bereich(KUNDE_B)])
        s = self.sweep.auswerten()
        self.assertNotIn("anna", s.plan)
        self.assertIn("mehreren Kundenbereichen", s.befund["anna"]["grund"])

    def test_ein_entferntes_konto_und_ein_beendeter_kundenbereich_entscheidet_der_betreiber(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"]))
        self.sweep.konto(konto(2, "bert"), token(["operator"]))
        self.sweep.db([spiegel(1, KUNDE_A, zustand="entfernt"), bereich(KUNDE_A),
                       spiegel(2, KUNDE_B, beendet="2026-10-01 00:00:00+00"),
                       bereich(KUNDE_B, beendet="2026-10-01 00:00:00+00")])
        s = self.sweep.auswerten()
        self.assertEqual(s.plan, {})
        self.assertIn("entfernt", s.befund["anna"]["grund"])
        self.assertIn("beendet", s.befund["bert"]["grund"])

    def test_plattform_partner_und_dienstkonten_bekommen_nie_ein_ziel(self):
        # Ein Spiegel unter derselben Kennung macht sie trotzdem nicht zu Kundenkonten.
        self.sweep.konto(konto(1, "plattform"), token(["platform-admin"]))
        self.sweep.konto(konto(2, "partner"), token(["partner"]))
        self.sweep.konto(konto(3, "service-account-voltpilot-api"), token([]))
        self.sweep.db([spiegel(1, KUNDE_A), spiegel(2, KUNDE_A), spiegel(3, KUNDE_A), bereich(KUNDE_A)])
        s = self.sweep.auswerten()
        self.assertEqual(s.plan, {})
        for name in ("plattform", "partner", "service-account-voltpilot-api"):
            self.assertEqual(s.befund[name]["klasse"], "by-design-ohne", name)

    def test_ohne_lesbares_token_ist_ein_konto_unklar_statt_reparierbar(self):
        self.sweep.konto(konto(1, "anna"), None)
        self.sweep.db([spiegel(1, KUNDE_A), bereich(KUNDE_A)])
        s = self.sweep.auswerten()
        self.assertEqual(s.befund["anna"]["klasse"], "unklar")
        self.assertEqual(s.plan, {})

    def test_ohne_db_teil_gibt_es_keinen_plan(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"]))
        s = self.sweep.auswerten()
        self.assertEqual(s.befund["anna"]["klasse"], "betroffen")
        self.assertEqual(s.plan, {})

    def test_ein_claim_neben_dem_spiegel_oder_ohne_kundenbereich_ist_auffaellig(self):
        self.sweep.konto(konto(1, "anna"), token(["operator"], tenant_id=KUNDE_B))
        self.sweep.konto(konto(2, "bert"), token(["operator"], tenant_id="cccccccc-0000-4000-8000-00000000000c"))
        self.sweep.konto(konto(3, "carl"), token(["operator"], tenant_id=KUNDE_A))
        self.sweep.db([spiegel(1, KUNDE_A), spiegel(3, KUNDE_A), bereich(KUNDE_A), bereich(KUNDE_B)])
        s = self.sweep.auswerten()
        self.assertEqual(s.befund["anna"]["klasse"], "auffaellig")
        self.assertIn("weicht vom Spiegel", s.befund["anna"]["grund"])
        self.assertEqual(s.befund["bert"]["klasse"], "auffaellig")
        self.assertIn("keinen Kundenbereich", s.befund["bert"]["grund"])
        self.assertEqual(s.befund["carl"]["klasse"], "gesund")
        self.assertEqual(s.plan, {})


class KontoPruefenTest(unittest.TestCase):
    """Das letzte Tor vor `kcadm update`: geschrieben wird nur bei SETZEN (Exit 0)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.d = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def pruefen(self, user, tok, ziel=KUNDE_A, name=None):
        up, tp = os.path.join(self.d, "u.json"), os.path.join(self.d, "t.json")
        for pfad, inhalt in ((up, user), (tp, tok)):
            with open(pfad, "w", encoding="utf-8") as f:
                f.write("" if inhalt is None else json.dumps(inhalt))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = ta.cmd_konto_pruefen(up, tp, ziel, name if name is not None else (user or {}).get("username"))
        return out.getvalue().split(" ", 1)[0], rc

    def test_ein_kundenkonto_ohne_tenant_id_wird_gesetzt(self):
        self.assertEqual(self.pruefen(konto(1, "anna"), token(["operator"])), ("SETZEN", 0))

    def test_ein_vorhandener_anderer_wert_wird_nie_ueberschrieben(self):
        mit_attribut = konto(1, "anna", attributes={"tenant_id": [KUNDE_B]})
        self.assertEqual(self.pruefen(mit_attribut, token(["operator"])), ("KONFLIKT", 4))
        # Auch wenn die Admin-API das Attribut nicht zeigt, der Token aber einen anderen Claim trägt.
        self.assertEqual(self.pruefen(konto(1, "anna"), token(["operator"], tenant_id=KUNDE_B)), ("KONFLIKT", 4))

    def test_derselbe_wert_ist_schon_gesetzt_auch_in_anderer_schreibweise(self):
        mit_attribut = konto(1, "anna", attributes={"tenant_id": [KUNDE_A.upper()]})
        self.assertEqual(self.pruefen(mit_attribut, token(["operator"], tenant_id=KUNDE_A)), ("SCHON", 0))

    def test_attribut_ohne_claim_ist_ein_mapper_fehler_kein_neues_setzen(self):
        mit_attribut = konto(1, "anna", attributes={"tenant_id": [KUNDE_A]})
        self.assertEqual(self.pruefen(mit_attribut, token(["operator"])), ("MAPPER", 4))

    def test_plattform_partner_und_dienstkonto_sind_verboten(self):
        self.assertEqual(self.pruefen(konto(1, "p"), token(["platform-admin"])), ("VERBOTEN", 4))
        self.assertEqual(self.pruefen(konto(2, "q"), token(["partner"])), ("VERBOTEN", 4))
        dienst = konto(3, "service-account-voltpilot-api", serviceAccountClientId="voltpilot-api")
        self.assertEqual(self.pruefen(dienst, token([])), ("VERBOTEN", 4))

    def test_ein_anderer_benutzername_als_im_plan_haelt_an(self):
        # Die Planzeile nennt Kennung UND Namen: passt der Name nicht, ist die Kennung verwechselt.
        self.assertEqual(self.pruefen(konto(1, "anna"), token(["operator"]), name="bert"), ("NAME", 4))

    def test_fehlendes_konto_oder_token_halten_an(self):
        self.assertEqual(self.pruefen(None, token(["operator"]), name="anna"), ("FEHLT", 4))
        self.assertEqual(self.pruefen(konto(1, "anna"), None), ("TOKENFEHLER", 4))


class PlanLesenTest(unittest.TestCase):
    """plan-lesen reicht nur UUIDs an `kcadm -s attributes.tenant_id=[...]` weiter."""

    def lesen(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as f:
            f.write(text)
        out, err = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = ta.cmd_plan_lesen(f.name)
        finally:
            os.unlink(f.name)
        return rc, out.getvalue().splitlines(), err.getvalue()

    def test_gueltiger_plan_ohne_kommentare_und_mit_kleingeschriebenem_ziel(self):
        rc, zeilen, _ = self.lesen("# erstellt ...\nid,username,ziel_tenant,quelle\n"
                                   f"{uid(1)},anna,{KUNDE_A.upper()},spiegel-sub\n"
                                   f"# {uid(2)},bert,{KUNDE_B},betreiber\n"
                                   f"{uid(3)},carl,{KUNDE_B}\n")
        self.assertEqual(rc, 0)
        self.assertEqual(zeilen, [f"{uid(1)};anna;{KUNDE_A};spiegel-sub", f"{uid(3)};carl;{KUNDE_B};betreiber"])

    def test_kein_ziel_ausser_einer_uuid(self):
        rc, zeilen, err = self.lesen("id,username,ziel_tenant\n"
                                     f'{uid(1)},anna,"{KUNDE_A}""],enabled=[false"\n')
        self.assertEqual(rc, 2)
        self.assertEqual(zeilen, [])
        self.assertIn("UUIDs", err)

    def test_ein_konto_doppelt_oder_eine_falsche_kopfzeile_lehnt_den_plan_ab(self):
        rc, _, err = self.lesen(f"id,username,ziel_tenant\n{uid(1)},anna,{KUNDE_A}\n{uid(1)},anna,{KUNDE_B}\n")
        self.assertEqual(rc, 2)
        self.assertIn("doppelt", err)
        rc, zeilen, err = self.lesen(f"username,id,ziel_tenant\nanna,{uid(1)},{KUNDE_A}\n")
        self.assertEqual(rc, 2)
        self.assertEqual(zeilen, [])
        self.assertIn("Kopfzeile", err)


if __name__ == "__main__":
    unittest.main()
