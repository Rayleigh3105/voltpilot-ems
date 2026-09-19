#!/usr/bin/env python3
"""NW-3 Punkt 4b: was die Box GESENDET hat gegen das, was die Strecke GESCHRIEBEN hat.

Beide Seiten werden am Draht bzw. in der Datenbank gemessen, nicht in einem Log:

* gesendet  = die Sample-Umschlaege am Broker (Mitschnitt `mosquitto_sub -v`),
* geschrieben = die Rohzeilen in `device_measurement_sample`.

Verglichen werden nicht nur die ZAHLEN, sondern die MESSZEITEN als Menge - eine
gleiche Zahl bei verschobenen Zeiten waere kein Beweis. Zusaetzlich geprueft:
die Vertragsversion jedes Umschlags und die Identitaet Topic == Nutzlast
(x-identity-rule des Vertrags: die drei Segmente MUESSEN byte-gleich sein).
"""
import argparse, datetime, json

p = argparse.ArgumentParser()
p.add_argument("--mitschnitt", required=True)
p.add_argument("--zeilen", required=True)
p.add_argument("--basis", required=True)   # ems/<tenant>/<site>/<device>
p.add_argument("--punkt", required=True)
a = p.parse_args()

def ms(zeit):
    """Messzeit als Millisekunden seit Epoche.

    Die zwei Seiten schreiben dieselbe Zeit verschieden auf: die Box kuerzt
    abschliessende Nullen im Sekundenbruch (``…:54.37Z``), Postgres schreibt
    immer drei Stellen (``…:54.370Z``). Ein Zeichenvergleich waere hier ein
    Befund am PRUEFSTAND, nicht an der Strecke - darum wird gerechnet.
    """
    if not zeit:
        return None
    return int(datetime.datetime.fromisoformat(
        str(zeit).replace("Z", "+00:00")).timestamp() * 1000)


thema = a.basis + "/v2/measurement-samples"
tenant, site, device = a.basis.split("/")[1:4]

umschlaege, fehler, zeiten_draht = [], [], set()
for zeile in open(a.mitschnitt, encoding="utf-8", errors="replace"):
    if not zeile.startswith(thema + " "):
        continue
    try:
        d = json.loads(zeile[len(thema) + 1:])
    except Exception:
        fehler.append("unlesbarer Umschlag am Draht")
        continue
    proben = [s for s in d.get("samples", []) if s.get("point_key") == a.punkt]
    if not proben:
        continue
    umschlaege.append(d)
    if d.get("schema_version") != "2.0":
        fehler.append("Umschlag mit schema_version %r" % d.get("schema_version"))
    if (d.get("tenant_id"), d.get("site_id"), d.get("device_id")) != (tenant, site, device):
        fehler.append("Topic-Identitaet != Umschlag-Identitaet")
    for s in proben:
        zeiten_draht.add(ms(s.get("observed_at") or d.get("observed_at")))

def lesbar(millis):
    return datetime.datetime.fromtimestamp(
        millis / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") \
        + f"{millis % 1000:03d}Z"


zeiten_db, zeilen = set(), []
for zeile in open(a.zeilen, encoding="utf-8"):
    zeile = zeile.strip()
    if not zeile:
        continue
    zeilen.append(zeile)
    zeiten_db.add(ms(zeile.split(" ")[0]))

# Die zwei Schnappschuesse entstehen nacheinander: ERST die Datenbankzeilen, DANN
# der Mitschnitt. Der Draht ist damit die spaetere und also die GROESSERE Seite -
# ein Umschlag aus genau diesem Spalt ist gesendet, aber noch nicht geschrieben.
# Beurteilt wird darum: bis zur juengsten geschriebenen Messzeit (der
# Wasserstand) muessen beide Mengen GLEICH sein; was danach am Draht liegt, ist
# noch unterwegs und kein Verlust.
wasserstand = max(zeiten_db, default=None)
unterwegs = sorted(t for t in zeiten_draht if wasserstand is not None and t > wasserstand)
verglichen = sorted(t for t in zeiten_draht if wasserstand is not None and t <= wasserstand)
fehlend = [t for t in verglichen if t not in zeiten_db]
zuviel = sorted(t for t in zeiten_db if t not in zeiten_draht)

grund = ""
if not umschlaege:
    grund = "die Box hat keinen Sample-Umschlag gesendet"
elif not zeilen:
    grund = "kein Umschlag ist als Rohzeile angekommen"
elif fehler:
    grund = "; ".join(sorted(set(fehler)))
elif fehlend:
    grund = "Messzeiten am Draht ohne Rohzeile: " + ", ".join(lesbar(t) for t in fehlend)
elif zuviel:
    grund = "Rohzeilen ohne Umschlag am Draht: " + ", ".join(lesbar(t) for t in zuviel)

print(json.dumps({
    "ok": not grund,
    "grund": grund,
    "gesendet": len(umschlaege),
    "geschrieben": len(zeilen),
    "verglichen": len(verglichen),
    "messzeiten_am_draht": [lesbar(t) for t in sorted(zeiten_draht)],
    "messzeiten_in_der_db": [lesbar(t) for t in sorted(zeiten_db)],
    "noch_unterwegs": [lesbar(t) for t in unterwegs],
    "erste_zeile": zeilen[0] if zeilen else None,
    "letzte_zeile": zeilen[-1] if zeilen else None,
}, ensure_ascii=False))
