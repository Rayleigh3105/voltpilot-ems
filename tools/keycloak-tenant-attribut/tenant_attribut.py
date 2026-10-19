#!/usr/bin/env python3
"""Auswertung zu tenant-attribut.sh (VoltPilot, Keycloak-Attribut tenant_id).

Liest nur Dateien, die tenant-attribut.sh vorher geholt hat; spricht selbst weder mit Keycloak
noch mit der Datenbank. Nur Python-Standardbibliothek (der Keycloak-Pod hat kein jq, der
Betriebsrechner braucht nur python3).

Unterbefehle (Aufruf durch tenant-attribut.sh):
  profil-pruefen DIR            Urteil zu User-Profil und Token-Mapper; Exit 0 gut, 1 Fehler, 3 kritisch
  profil-angleichen DIR         schreibt DIR/profil-neu.json und zeigt die Abweichung zu DIR/profil.json
  auswerten DIR                 Befund (befund.txt, befund.csv) und Reparaturplan (plan.csv)
  plan-lesen PLAN               prüft den Plan und gibt "id;username;ziel;quelle" je Zeile aus
  konto-pruefen USER TOKEN ZIEL Urteil zu einer Planzeile vor/nach dem Setzen (eine Zeile, Exit-Code)
  token-zeigen TOKEN            Rollen und tenant_id eines Beispiel-Tokens
  json-feld DATEI PFAD          ein Feld aus einer JSON-Datei (z. B. 0.id)
"""
import csv
import datetime as dt
import difflib
import json
import os
import re
import sys

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
PLATTFORM = "platform-admin"
PARTNER = "partner"
ALT_KUNDENROLLEN = ("operator", "admin", "site-admin")
FRONTEND = "voltpilot-frontend"
API = "voltpilot-api"
# Die Deklaration genau wie im Import infra/prod/keycloak/voltpilot-realm.json (components).
SOLL_TENANT_ATTRIBUT = {
    "name": "tenant_id",
    "displayName": "Tenant ID",
    "permissions": {"view": ["admin", "user"], "edit": ["admin"]},
    "multivalued": False,
}
SOLL_POLICY = "ADMIN_EDIT"


def lade(pfad, vorgabe=None):
    try:
        with open(pfad, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return vorgabe
    text = text.strip()
    if not text:
        return vorgabe
    # kcadm kann vor dem JSON eine Zeile wie "Picked up JAVA_TOOL_OPTIONS" schreiben.
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start < 0:
        return vorgabe
    return json.loads(text[start:])


def zeit(ms):
    if ms in (None, "", 0):
        return "-"
    return dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def jetzt():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db_zeit(text):
    """psql-Zeitstempel ('2026-10-10 08:12:00.12+00') -> datetime (UTC) oder None."""
    if not text:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::?(\d{2}))?$", text.strip())
    if not m:
        return None
    frac = (m.group(3) or "0")[:6].ljust(6, "0")
    tz = f"{m.group(4)}:{m.group(5) or '00'}"
    return dt.datetime.fromisoformat(f"{m.group(1)}T{m.group(2)}.{frac}{tz}").astimezone(dt.timezone.utc)


def ist_uuid(s):
    return bool(s) and bool(UUID_RE.match(str(s).strip()))


# ----------------------------------------------------------------------------------- Profil und Mapper

def profil_urteil(d):
    """Liste (stufe, text) mit stufe in OK, WARN, FEHLER, KRITISCH."""
    profil = lade(os.path.join(d, "profil.json"))
    out = []
    if not isinstance(profil, dict) or "attributes" not in profil:
        return [("FEHLER", "User-Profil nicht lesbar (profil.json fehlt oder ist leer)")]
    policy = profil.get("unmanagedAttributePolicy")
    attr = next((a for a in profil["attributes"] if a.get("name") == "tenant_id"), None)
    if attr is None:
        if policy in ("ADMIN_EDIT",):
            out.append(("WARN", "tenant_id ist NICHT deklariert, lebt aber als unverwaltetes Attribut "
                                "(unmanagedAttributePolicy=ADMIN_EDIT). Funktioniert, weicht aber vom Import ab."))
        elif policy == "ENABLED":
            out.append(("KRITISCH", "tenant_id ist NICHT deklariert und unmanagedAttributePolicy=ENABLED: "
                                    "ein Kunde kann sein tenant_id über die Kontoseite selbst ändern "
                                    "(im Labor belegt) und so einen fremden Kundenbereich sehen."))
        elif policy == "ADMIN_VIEW":
            out.append(("FEHLER", "tenant_id ist NICHT deklariert und unmanagedAttributePolicy=ADMIN_VIEW: "
                                  "Admin-API und API-Anlage können tenant_id nicht schreiben."))
        else:
            out.append(("FEHLER", "tenant_id ist NICHT deklariert und unverwaltete Attribute sind abgeschaltet "
                                  "(unmanagedAttributePolicy fehlt): jedes NEU angelegte Kundenkonto verliert "
                                  "tenant_id still bei der Anlage, und die Admin-API zeigt vorhandene Werte nicht an."))
    else:
        perms = attr.get("permissions") or {}
        edit = sorted(perms.get("edit") or [])
        view = sorted(perms.get("view") or [])
        if "user" in edit:
            out.append(("KRITISCH", "tenant_id ist für den Benutzer selbst bearbeitbar (permissions.edit enthält "
                                    "'user'): ein Kunde kann über die Kontoseite den Kundenbereich wechseln "
                                    "(im Labor belegt)."))
        elif edit != ["admin"]:
            out.append(("FEHLER", "tenant_id ist deklariert, aber nicht für 'admin' bearbeitbar "
                                  f"(permissions.edit={edit}): Admin-API und API-Anlage können es nicht schreiben."))
        else:
            out.append(("OK", "tenant_id ist deklariert, nur 'admin' darf schreiben."))
        if "admin" not in view:
            out.append(("WARN", f"tenant_id: permissions.view={view} ohne 'admin' - die Admin-API zeigt den Wert nicht."))
        if attr.get("required"):
            out.append(("WARN", "tenant_id ist als Pflichtfeld markiert: ein Konto ohne Wert bekommt beim Anmelden "
                                "die Profil-Seite und kann das Feld nicht selbst füllen."))
        if policy == "ENABLED":
            out.append(("WARN", "unmanagedAttributePolicy=ENABLED: Kunden dürfen andere unverwaltete Attribute selbst "
                                "ändern. Import: ADMIN_EDIT."))
        elif policy != SOLL_POLICY:
            out.append(("WARN", f"unmanagedAttributePolicy={policy or 'fehlt (abgeschaltet)'}; Import: ADMIN_EDIT."))
        else:
            out.append(("OK", "unmanagedAttributePolicy=ADMIN_EDIT wie im Import."))
    for client in (FRONTEND, API):
        mapper = lade(os.path.join(d, f"mapper-{client}.json"), None)
        if mapper is None:
            out.append(("FEHLER", f"Client {client}: Mapper nicht lesbar (mapper-{client}.json fehlt)."))
            continue
        treffer = [m for m in mapper if m.get("protocolMapper") == "oidc-usermodel-attribute-mapper"
                   and (m.get("config") or {}).get("user.attribute") == "tenant_id"]
        gut = [m for m in treffer if (m.get("config") or {}).get("claim.name") == "tenant_id"
               and (m.get("config") or {}).get("access.token.claim") == "true"]
        if gut:
            out.append(("OK", f"Client {client}: Mapper tenant_id -> Claim tenant_id im Zugriffstoken."))
        elif treffer:
            out.append(("FEHLER", f"Client {client}: Mapper für tenant_id vorhanden, aber Claim-Name oder "
                                  "access.token.claim weicht ab - der Claim fehlt dann in JEDEM Token."))
        else:
            out.append(("FEHLER", f"Client {client}: kein Mapper für tenant_id - der Claim fehlt dann in JEDEM Token."))
    return out


def cmd_profil_pruefen(d):
    urteil = profil_urteil(d)
    for stufe, text in urteil:
        print(f"  {stufe:8s} {text}")
    stufen = {s for s, _ in urteil}
    if "KRITISCH" in stufen:
        return 3
    if "FEHLER" in stufen:
        return 1
    return 0


def kanonisch(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True).splitlines()


def cmd_profil_angleichen(d):
    profil = lade(os.path.join(d, "profil.json"))
    if not isinstance(profil, dict) or "attributes" not in profil:
        print("FEHLER: profil.json fehlt oder ist kein User-Profil; nichts geschrieben.", file=sys.stderr)
        return 2
    neu = json.loads(json.dumps(profil))
    attr = next((a for a in neu["attributes"] if a.get("name") == "tenant_id"), None)
    if attr is None:
        neu["attributes"].append(json.loads(json.dumps(SOLL_TENANT_ATTRIBUT)))
    else:
        perms = attr.setdefault("permissions", {})
        perms["edit"] = ["admin"]
        view = perms.get("view") or []
        if "admin" not in view:
            perms["view"] = sorted(set(view) | {"admin"})
    neu["unmanagedAttributePolicy"] = SOLL_POLICY
    with open(os.path.join(d, "profil-neu.json"), "w", encoding="utf-8") as f:
        json.dump(neu, f, ensure_ascii=False, indent=2)
    diff = list(difflib.unified_diff(kanonisch(profil), kanonisch(neu), "profil.json (live)",
                                     "profil-neu.json", lineterm="", n=2))
    if not diff:
        print("Keine Änderung nötig: das Profil trägt tenant_id (nur admin schreibt) und ADMIN_EDIT.")
        return 10
    print("\n".join(diff))
    return 0


# ----------------------------------------------------------------------------------- Token und Konten

def token_info(tok):
    if not isinstance(tok, dict):
        return None
    rollen = ((tok.get("realm_access") or {}).get("roles")) or []
    return {"rollen": sorted(rollen), "tenant_id": tok.get("tenant_id"), "sub": tok.get("sub"),
            "username": tok.get("preferred_username")}


def attr_tenant(user):
    werte = ((user.get("attributes") or {}).get("tenant_id")) or []
    return werte


def ist_dienstkonto(user):
    return bool(user.get("serviceAccountClientId")) or str(user.get("username", "")).startswith("service-account-")


def lies_db(d):
    pfad = os.path.join(d, "db.csv")
    if not os.path.exists(pfad):
        return None
    with open(pfad, encoding="utf-8") as f:
        zeilen = f.read().splitlines()
    # psql kann Statuszeilen (BEGIN, SET) vor die Kopfzeile schreiben: ab der Kopfzeile lesen.
    start = next((i for i, z in enumerate(zeilen) if z.startswith("art,")), None)
    if start is None:
        raise SystemExit("db.csv hat keine Kopfzeile 'art,...' - ist es die Ausgabe von db-wahrheit.sql mit --csv?")
    rows = [r for r in csv.DictReader(zeilen[start:]) if r.get("art") in ("konto", "kundenbereich")]
    konten = [r for r in rows if r["art"] == "konto"]
    bereiche = {r["tenant_id"]: r for r in rows if r["art"] == "kundenbereich"}
    return konten, bereiche


def kurzrollen(rollen):
    weg = {"offline_access", "uma_authorization"}
    return " ".join(r for r in rollen if r not in weg and not r.startswith("default-roles-")) or "-"


def lade_ereignisse(d):
    clients = {c.get("id"): c.get("clientId") for c in (lade(os.path.join(d, "clients.json"), []) or [])}
    clients.update({c.get("id"): "master/" + str(c.get("clientId"))
                    for c in (lade(os.path.join(d, "clients-master.json"), []) or [])})
    namen = {u.get("id"): u.get("username") for u in (lade(os.path.join(d, "users.json"), []) or [])}
    namen.update({u.get("id"): "master/" + str(u.get("username"))
                  for u in (lade(os.path.join(d, "users-master.json"), []) or [])})

    def wer(e):
        """Wer hat geändert: security-admin-console = Administration im Browser, admin-cli = kcadm,
        voltpilot-api = die API (Servicekonto)."""
        a = e.get("authDetails") or {}
        cid = a.get("clientId")
        client = clients.get(cid) or (("Client " + str(cid)[:8]) if cid else "?")
        person = namen.get(a.get("userId")) or (a.get("userId") or "?")[:8]
        return f"{client} / {person}"

    profil = lade(os.path.join(d, "admin-ereignisse-profil.json"), []) or []
    konto = lade(os.path.join(d, "admin-ereignisse-konten.json"), []) or []
    anmeld = lade(os.path.join(d, "anmeldungen.json"), []) or []
    je_konto = {}
    for e in konto:
        pfad = e.get("resourcePath", "")
        if pfad.startswith("users/"):
            uid = pfad.split("/")[1]
            je_konto.setdefault(uid, []).append(e)
    letzte = {}
    for e in anmeld:
        uid = e.get("userId")
        if uid and (uid not in letzte or e.get("time", 0) > letzte[uid]):
            letzte[uid] = e.get("time", 0)
    return profil, je_konto, letzte, wer


def cmd_auswerten(d):
    users = lade(os.path.join(d, "users.json"), []) or []
    db = lies_db(d)
    konten_db, bereiche = db if db else ([], {})
    je_sub = {}
    for r in konten_db:
        je_sub.setdefault(r["sub"], []).append(r)
    je_mail = {}
    for r in konten_db:
        if r.get("konto") == "benutzer" and r.get("email"):
            je_mail.setdefault(r["email"].strip().lower(), []).append(r)
    profil_ev, ev_je_konto, letzte_anmeldung, wer = lade_ereignisse(d)
    stichtage = [db_zeit(b.get("stichtag")) for b in bereiche.values() if b.get("stichtag_herkunft") == "bestandslauf"]
    stichtage = [t for t in stichtage if t]
    uems_start = min(stichtage) if stichtage else None
    urteil = profil_urteil(d)

    ergebnis = []
    for u in users:
        uid = u.get("id")
        tok = token_info(lade(os.path.join(d, "token", f"{uid}.json")))
        attr = attr_tenant(u)
        r = {
            "id": uid, "username": u.get("username"), "email": (u.get("email") or ""),
            "aktiv": "ja" if u.get("enabled", True) else "nein",
            "erstellt": zeit(u.get("createdTimestamp")),
            "rollen": kurzrollen(tok["rollen"]) if tok else "?",
            "attribut": ",".join(attr) if attr else "",
            "claim": (tok or {}).get("tenant_id") or "",
            "spiegel": "", "spiegel_seit": "", "zuweisungen": "", "stichtag": "",
            "ziel": "", "quelle": "", "klasse": "", "grund": "",
            "letzte_anmeldung": zeit(letzte_anmeldung.get(uid)),
            "admin_ereignisse": "; ".join(
                f"{zeit(e.get('time'))} {e.get('operationType')} ({wer(e)})"
                for e in sorted(ev_je_konto.get(uid, []), key=lambda e: e.get("time", 0))[-4:]),
        }
        rows = [x for x in je_sub.get(uid, []) if x.get("konto") == "benutzer"]
        if rows:
            x = rows[0]
            r["spiegel"] = f"{x['kundenbereich']} ({x['tenant_id']}) zustand={x['zustand']}" + (
                f" [+{len(rows) - 1} weitere]" if len(rows) > 1 else "")
            r["spiegel_seit"] = x.get("spiegel_seit", "")
            r["zuweisungen"] = f"{x.get('zuweisungen_wirksam') or 0} wirksam / {x.get('zuweisungen_je') or 0} je " + (
                f"({x.get('rollen_wirksam')})" if x.get("rollen_wirksam") else "")
            r["stichtag"] = f"{x.get('stichtag') or '-'} konten={x.get('stichtag_konten') or '-'}"
        rollen = tok["rollen"] if tok else []
        claim = r["claim"]
        if ist_dienstkonto(u):
            r["klasse"], r["grund"] = "by-design-ohne", "Dienstkonto (client_credentials)"
            if claim:
                r["klasse"], r["grund"] = "auffaellig", "Dienstkonto trägt tenant_id"
        elif tok is None:
            r["klasse"], r["grund"] = "unklar", "Beispiel-Token nicht lesbar - Konto von Hand prüfen (Befehl: token)"
        elif PLATTFORM in rollen:
            r["klasse"], r["grund"] = "by-design-ohne", "Plattform-Konto (platform-admin)"
            if claim:
                r["klasse"], r["grund"] = "auffaellig", "Plattform-Konto trägt tenant_id (wird ignoriert, gehört nicht hin)"
        elif PARTNER in rollen:
            r["klasse"], r["grund"] = "by-design-ohne", "Partner-Konto (partner)"
            if claim:
                r["klasse"], r["grund"] = "auffaellig", "Partner-Konto trägt tenant_id (TenantFilter ignoriert es)"
        elif claim:
            if not ist_uuid(claim):
                r["klasse"], r["grund"] = "auffaellig", "tenant_id ist keine UUID - Konto sieht nichts"
            elif len(attr) > 1:
                r["klasse"], r["grund"] = "auffaellig", "tenant_id hat mehrere Werte"
            elif db and claim not in bereiche:
                r["klasse"], r["grund"] = "auffaellig", "tenant_id zeigt auf keinen Kundenbereich der Datenbank"
            elif rows and rows[0]["tenant_id"] != claim:
                r["klasse"], r["grund"] = "auffaellig", "tenant_id weicht vom Spiegel in der Datenbank ab"
            else:
                r["klasse"] = "gesund"
                if db and not rows:
                    r["grund"] = ("ohne Spiegel: der nächste api-Start übernimmt das Konto, und ohne je eine "
                                  "Zuweisung wird es Kundenadministrator (ZugriffBestand)")
                elif db and bereiche.get(claim, {}).get("kundenbereich_beendet"):
                    r["grund"] = "Kundenbereich beendet"
                elif not attr:
                    r["grund"] = "Admin-API zeigt das Attribut nicht (Profil), Token trägt es"
        else:
            r["klasse"] = "betroffen"
            if attr:
                r["grund"] = "Attribut vorhanden, aber KEIN Claim im Token - Mapper prüfen (profil)"
            elif not db:
                r["grund"] = "DB-Teil fehlt: Ziel-Kundenbereich unbekannt"
            elif rows:
                x = rows[0]
                if len({y["tenant_id"] for y in rows}) > 1:
                    r["grund"] = "Spiegel in mehreren Kundenbereichen - von Hand entscheiden"
                elif x.get("zustand") == "entfernt":
                    r["grund"] = "Spiegel 'entfernt' (Kundenadministrator hat das Konto beendet) - von Hand entscheiden"
                elif x.get("kundenbereich_beendet"):
                    r["grund"] = "Kundenbereich beendet - von Hand entscheiden"
                else:
                    r["ziel"], r["quelle"] = x["tenant_id"], "spiegel-sub"
                    r["grund"] = "reparierbar: Spiegel in der Datenbank mit derselben Keycloak-Kennung"
            else:
                mail = je_mail.get(r["email"].strip().lower()) if r["email"] else None
                if mail:
                    r["grund"] = ("kein Spiegel für diese Kennung, aber dieselbe E-Mail im Spiegel unter anderer "
                                  f"Kennung {mail[0]['sub']} ({mail[0]['kundenbereich']}): Konto neu angelegt? "
                                  "Rechte hängen an der alten Kennung - von Hand entscheiden")
                else:
                    r["grund"] = ("kein Spiegel in der Datenbank: hatte beim UEMS-Start (Bestandslauf) kein tenant_id "
                                  "oder entstand danach ohne - Ziel von Hand bestimmen")
            if kurzrollen(rollen) == "-":
                r["grund"] += "; Konto ohne eigene Realm-Rolle: ohne tenant_id ist es keine Kontoart"
        r["zeitlinie"] = ""
        if r["klasse"] == "betroffen" and db:
            erstellt = (dt.datetime.fromtimestamp(int(u["createdTimestamp"]) / 1000, dt.timezone.utc)
                        if u.get("createdTimestamp") else None)
            anlage = [e for e in ev_je_konto.get(uid, []) if e.get("operationType") == "CREATE"]
            weg = f" (Anlage: {wer(anlage[0])})" if anlage else ""
            if rows:
                r["zeitlinie"] = (f"hatte tenant_id, als die API das Konto spiegelte ({r['spiegel_seit']}); "
                                  "verloren DANACH - Admin-Ereignisse und Tages-Dumps eingrenzen")
            elif uems_start and erstellt and erstellt > uems_start:
                r["zeitlinie"] = (f"nach dem ersten Bestandslauf ({uems_start:%Y-%m-%d %H:%M} UTC) OHNE tenant_id "
                                  f"angelegt{weg}")
            elif uems_start and erstellt:
                r["zeitlinie"] = (f"bestand vor dem ersten Bestandslauf ({uems_start:%Y-%m-%d %H:%M} UTC), wurde aber "
                                  "nicht gespiegelt: hatte damals schon kein tenant_id (oder Bestandslauf lief nie "
                                  "vollständig) - Tages-Dumps von davor prüfen")
        ergebnis.append(r)

    # Kundenbereiche ohne erreichbares Konto (nur mit DB-Teil)
    erreichbar = {r["claim"] for r in ergebnis if r["klasse"] == "gesund"}
    ohne_konto = [b for t, b in bereiche.items() if t not in erreichbar and not b.get("kundenbereich_beendet")]

    reihen = ["betroffen", "unklar", "auffaellig", "gesund", "by-design-ohne"]
    ergebnis.sort(key=lambda r: (reihen.index(r["klasse"]), r["username"] or ""))
    felder = ["klasse", "username", "email", "id", "aktiv", "rollen", "attribut", "claim", "erstellt",
              "letzte_anmeldung", "spiegel", "spiegel_seit", "zuweisungen", "stichtag", "ziel", "quelle", "grund",
              "zeitlinie", "admin_ereignisse"]
    with open(os.path.join(d, "befund.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=felder)
        w.writeheader()
        for r in ergebnis:
            w.writerow({k: r[k] for k in felder})
    plan = [r for r in ergebnis if r["klasse"] == "betroffen" and r["ziel"]]
    with open(os.path.join(d, "plan.csv"), "w", newline="", encoding="utf-8") as f:
        f.write(f"# erstellt {jetzt()} von tenant-attribut.sh sweep; Quelle: {os.path.abspath(d)}\n")
        f.write("# Nur Zeilen mit eindeutigem Spiegel in der Datenbank. Weitere Zeilen von Hand mit quelle=betreiber\n")
        f.write("# ergänzen, erst nachdem der Kundenbereich geklärt ist. Eine Zeile mit '#' am Anfang gilt nicht.\n")
        w = csv.writer(f)
        w.writerow(["id", "username", "ziel_tenant", "quelle"])
        for r in plan:
            w.writerow([r["id"], r["username"], r["ziel"], r["quelle"]])

    zaehl = {k: sum(1 for r in ergebnis if r["klasse"] == k) for k in reihen}
    L = []
    L.append(f"tenant_id-Befund Realm voltpilot, erstellt {jetzt()}")
    L.append("Enthält Benutzernamen und E-Mail-Adressen: bleibt beim Betreiber. Teilbar sind nur die Zählungen.")
    L.append("")
    L.append("1. User-Profil und Token-Mapper")
    for s, t in urteil:
        L.append(f"   {s:8s} {t}")
    L.append("")
    L.append("2. Zählung")
    L.append(f"   Konten gesamt {len(ergebnis)}: betroffen {zaehl['betroffen']} (davon reparierbar aus der DB "
             f"{len(plan)}), unklar {zaehl['unklar']}, auffällig {zaehl['auffaellig']}, gesund {zaehl['gesund']}, "
             f"by-design-ohne {zaehl['by-design-ohne']}")
    if not db:
        L.append("   DB-Teil fehlt: ohne db.csv gibt es keinen Reparaturplan (Ziel-Kundenbereich unbekannt).")
    titel = {"betroffen": "3. BETROFFEN - Kundenkonto ohne tenant_id im Token",
             "unklar": "4. UNKLAR - Token nicht lesbar",
             "auffaellig": "5. AUFFÄLLIG",
             "gesund": "6. GESUND",
             "by-design-ohne": "7. BY-DESIGN OHNE tenant_id"}
    for k in reihen:
        L.append("")
        L.append(f"{titel[k]} ({zaehl[k]})")
        for r in [x for x in ergebnis if x["klasse"] == k]:
            if k in ("gesund", "by-design-ohne"):
                L.append(f"   {r['username']:<28s} {r['rollen']:<22s} {r['claim'] or '-':<38s} {r['grund']}")
                continue
            L.append(f"   {r['username']}  <{r['email'] or '-'}>  id={r['id']}  aktiv={r['aktiv']}")
            L.append(f"      Rollen: {r['rollen']} | Attribut: {r['attribut'] or '-'} | Claim: {r['claim'] or '-'}")
            L.append(f"      Keycloak-Konto seit: {r['erstellt']} | letzte Anmeldung (Ereignisse): {r['letzte_anmeldung']}")
            L.append(f"      DB-Spiegel: {r['spiegel'] or '-'} | Spiegel seit: {r['spiegel_seit'] or '-'} | "
                     f"Zuweisungen: {r['zuweisungen'] or '-'} | Stichtag: {r['stichtag'] or '-'}")
            if r["admin_ereignisse"]:
                L.append(f"      Admin-Ereignisse (letzte 4): {r['admin_ereignisse']}")
            if r.get("zeitlinie"):
                L.append(f"      Zeitlinie: {r['zeitlinie']}")
            L.append(f"      => {r['grund']}" + (f" | Ziel {r['ziel']} ({r['quelle']})" if r["ziel"] else ""))
    L.append("")
    L.append(f"8. Kundenbereiche ohne ein einziges gesundes Konto ({len(ohne_konto)})" if db else
             "8. Kundenbereiche ohne gesundes Konto: DB-Teil fehlt")
    for b in sorted(ohne_konto, key=lambda b: b.get("kundenbereich") or ""):
        L.append(f"   {b.get('kundenbereich')} ({b.get('tenant_id')}) seit {b.get('kundenbereich_seit')} | "
                 f"Stichtag {b.get('stichtag') or '-'} konten={b.get('stichtag_konten') or '-'}")
    L.append("")
    L.append(f"9. Zeitlinie: Änderungen am User-Profil (Admin-Ereignisse USER_PROFILE, {len(profil_ev)})")
    if not profil_ev:
        L.append("   keine - entweder nie geändert oder Admin-Ereignisse aus/abgelaufen (siehe realm.txt)")
    pev = sorted(profil_ev, key=lambda e: e.get("time", 0))
    zeigen = pev if len(pev) <= 30 else pev[:5] + [None] + pev[-20:]
    for e in zeigen:
        if e is None:
            L.append(f"   ... {len(pev) - 25} weitere ...")
            continue
        L.append(f"   {zeit(e.get('time'))} {e.get('operationType')} {e.get('resourcePath')} ({wer(e)})")
    L.append("")
    L.append("10. Nächste Schritte")
    L.append("   a) Profil-Urteil oben nicht OK: erst 'tenant-attribut.sh profil-angleichen', sonst verwirft Keycloak")
    L.append("      das gesetzte Attribut still (im Labor belegt: kcadm meldet Erfolg, der Wert fehlt).")
    L.append("   b) plan.csv prüfen und von Hand ergänzen, dann 'tenant-attribut.sh reparatur plan.csv' (Trockenlauf),")
    L.append("      danach mit --ausfuehren.")
    L.append("   c) Betroffene ohne DB-Spiegel bekommen ihre Rechte erst beim nächsten api-Start (Bestandslauf ->")
    L.append("      Kundenadministrator, wenn nie eine Zuweisung bestand).")
    text = "\n".join(L) + "\n"
    with open(os.path.join(d, "befund.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    print(text)
    return 0


# ----------------------------------------------------------------------------------- Reparatur-Helfer

def cmd_plan_lesen(pfad):
    fehler = 0
    gesehen = set()
    with open(pfad, encoding="utf-8") as f:
        zeilen = [z for z in f.read().splitlines() if z.strip() and not z.lstrip().startswith("#")]
    if not zeilen:
        print("FEHLER: Plan ohne Zeilen.", file=sys.stderr)
        return 2
    kopf = next(csv.reader([zeilen[0]]))
    if kopf[:3] != ["id", "username", "ziel_tenant"]:
        print(f"FEHLER: Kopfzeile muss mit id,username,ziel_tenant beginnen, ist {kopf}", file=sys.stderr)
        return 2
    for nr, z in enumerate(csv.reader(zeilen[1:]), start=2):
        if len(z) < 3:
            print(f"FEHLER: Zeile {nr}: zu wenige Spalten", file=sys.stderr)
            fehler += 1
            continue
        uid, name, ziel = z[0].strip(), z[1].strip(), z[2].strip()
        quelle = z[3].strip() if len(z) > 3 else "betreiber"
        if not ist_uuid(uid) or not ist_uuid(ziel) or not name:
            print(f"FEHLER: Zeile {nr}: id und ziel_tenant müssen UUIDs sein, username nicht leer", file=sys.stderr)
            fehler += 1
            continue
        if uid in gesehen:
            print(f"FEHLER: Zeile {nr}: Konto {uid} doppelt im Plan", file=sys.stderr)
            fehler += 1
            continue
        gesehen.add(uid)
        print(f"{uid};{name};{ziel.lower()};{quelle}")
    return 2 if fehler else 0


def cmd_konto_pruefen(user_pfad, token_pfad, ziel, erwartet_name):
    """Gibt 'URTEIL text' aus. Urteile: SETZEN, SCHON, KONFLIKT, VERBOTEN, FEHLT, NAME, TOKENFEHLER."""
    u = lade(user_pfad)
    if not isinstance(u, dict) or not u.get("id"):
        print("FEHLT Konto in Keycloak nicht gefunden")
        return 4
    if u.get("username") != erwartet_name:
        print(f"NAME Benutzername ist '{u.get('username')}', Plan sagt '{erwartet_name}'")
        return 4
    if ist_dienstkonto(u):
        print("VERBOTEN Dienstkonto - bekommt nie tenant_id")
        return 4
    tok = token_info(lade(token_pfad))
    if tok is None:
        print("TOKENFEHLER Beispiel-Token nicht lesbar")
        return 4
    if PLATTFORM in tok["rollen"] or PARTNER in tok["rollen"]:
        print(f"VERBOTEN Konto mit Rolle {PLATTFORM if PLATTFORM in tok['rollen'] else PARTNER} - bekommt nie tenant_id")
        return 4
    attr = attr_tenant(u)
    if [str(w).lower() for w in attr] == [ziel.lower()] and not tok["tenant_id"]:
        print("MAPPER Attribut steht, aber der Claim fehlt im Token - Mapper prüfen (Befehl: profil)")
        return 4
    vorhanden = [w for w in attr if w] + ([tok["tenant_id"]] if tok["tenant_id"] else [])
    if vorhanden and all(str(w).lower() == ziel.lower() for w in vorhanden) and tok["tenant_id"]:
        print(f"SCHON tenant_id={ziel} steht im Attribut und im Token")
        return 0
    if vorhanden and any(str(w).lower() != ziel.lower() for w in vorhanden):
        print(f"KONFLIKT Konto trägt schon tenant_id={','.join(sorted(set(map(str, vorhanden))))} - nie überschreiben")
        return 4
    print(f"SETZEN tenant_id fehlt (Rollen: {kurzrollen(tok['rollen'])}, aktiv={'ja' if u.get('enabled', True) else 'nein'})")
    return 0


def cmd_token_zeigen(pfad):
    tok = token_info(lade(pfad))
    if tok is None:
        print("Beispiel-Token nicht lesbar")
        return 4
    print(f"  Benutzer: {tok['username']}  sub={tok['sub']}")
    print(f"  Rollen:   {kurzrollen(tok['rollen'])}")
    print(f"  tenant_id im Zugriffstoken: {tok['tenant_id'] or '<KEIN CLAIM>'}")
    return 0 if tok["tenant_id"] else 1


def cmd_json_feld(pfad, feldpfad):
    obj = lade(pfad)
    for teil in feldpfad.split("."):
        if obj is None:
            break
        obj = obj[int(teil)] if isinstance(obj, list) and teil.isdigit() and int(teil) < len(obj) else (
            obj.get(teil) if isinstance(obj, dict) else None)
    if obj is None:
        return 1
    print(obj if not isinstance(obj, (dict, list)) else json.dumps(obj))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cmd, args = argv[1], argv[2:]
    if cmd == "profil-pruefen":
        return cmd_profil_pruefen(*args)
    if cmd == "profil-angleichen":
        return cmd_profil_angleichen(*args)
    if cmd == "auswerten":
        return cmd_auswerten(*args)
    if cmd == "plan-lesen":
        return cmd_plan_lesen(*args)
    if cmd == "konto-pruefen":
        return cmd_konto_pruefen(*args)
    if cmd == "token-zeigen":
        return cmd_token_zeigen(*args)
    if cmd == "json-feld":
        return cmd_json_feld(*args)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
