#!/usr/bin/env python3
"""Zusatzlauf „kurzer Verbraucher": das Urteil.

Gelesen wird allein das Protokoll des Szenario-Simulators
(kurzer-verbraucher-sim.js): je Sekunde die physikalische Wahrheit des Modells
und daneben jeder Sollwert, den die Box geschrieben hat. Vorzeichen wie im
Simulator des Tags: batt + = laden, netz + = Bezug.

Die zwei Zahlen sind die des Prueflaufs im Tag
(edge-app/core/internal/agent/surplus_short_consumer_scenario_test.go):
  * „aus dem Speicher eingespeist" - je Sekunde das Kleinere aus Entladung und
    Einspeisung;
  * die Entlade-Befehle der Box (Sollwert < 0) im Fenster.

Fall `laden` (die Viertelstunde plant ein Laden): gruen heisst beides null, UND
die Box hat im Fenster wirklich geladen, UND in jedem Ueberschuss-Abschnitt
liefen Verbraucher - sonst haette der Lauf nichts bewiesen.

Fall `ruhe` (die Viertelstunde plant nichts): die Box DARF das Defizit decken;
hier gibt es kein gruen oder rot, nur die gemessenen Zahlen - wie lange der
Speicher nach dem Ende des Verbrauchers noch einspeist und wann der
Entlade-Befehl zurueckgenommen wird.
"""
import argparse, json, re

ZEILE = re.compile(r"\[szenario\] t=(?P<t>[-\d.]+) pv=(?P<pv>[-\d.]+) last=(?P<last>[-\d.]+) "
                   r"batt=(?P<batt>[-\d.]+) netz=(?P<netz>[-\d.]+) soc=(?P<soc>[-\d.]+) "
                   r"ueberschuss=(?P<ue>[-\d.]+) verbraucher=(?P<v>[01])")
SCHREIBEN = re.compile(r"\[szenario\] schreiben t=(?P<t>[-\d.]+) sollwert=(?P<kw>[-\d.]+)")
FREIGABE = re.compile(r"\[szenario\] freigabe t=(?P<t>[-\d.]+) ems=(?P<ems>[01])")
# Dieselbe Schwelle wie im Prueflauf des Tags (storageExportS: > 0,1 kW je Seite).
SCHWELLE_KW = 0.1
MIN_VERBRAUCHER = 4
MIN_JE_ABSCHNITT = 2


def urteile(text, von_s, bis_s, fall="laden"):
    sekunden, schreiben, entzogen = [], [], 0
    for z in text.splitlines():
        m = ZEILE.search(z)
        if m:
            sekunden.append({k: float(v) for k, v in m.groupdict().items()})
            continue
        m = SCHREIBEN.search(z)
        if m:
            schreiben.append((float(m["t"]), float(m["kw"])))
            continue
        m = FREIGABE.search(z)
        if m and m["ems"] == "0" and von_s <= float(m["t"]) < bis_s:
            entzogen += 1
    fenster = [s for s in sekunden if von_s <= s["t"] < bis_s]
    r = {"fall": fall, "fenster_von_s": von_s, "fenster_bis_s": bis_s, "sekunden": len(fenster),
         "verbraucher": 0, "verbraucher_je_ueberschuss_kw": {},
         "aus_dem_speicher_eingespeist_kwh": 0.0, "aus_dem_speicher_eingespeist_s": 0,
         "laengste_einspeisung_aus_dem_speicher_s": 0,
         "geladen_kwh": 0.0, "entladen_kwh": 0.0, "bezug_kwh": 0.0, "einspeisung_kwh": 0.0,
         "ueberschuss_angeboten_kwh": 0.0, "groesste_entladung_kw": 0.0}
    an, vorher, strecke, enden = False, None, 0.0, []
    for s in fenster:
        # Die Zeilen kommen im Sekundentakt; die echte Schrittweite zaehlt, damit
        # ein verspaeteter Takt des Containers die Energie nicht verfaelscht.
        dt = 1.0 if vorher is None else max(0.0, min(5.0, s["t"] - vorher))
        vorher = s["t"]
        laden, entladen = max(s["batt"], 0.0), max(-s["batt"], 0.0)
        bezug, einsp = max(s["netz"], 0.0), max(-s["netz"], 0.0)
        r["aus_dem_speicher_eingespeist_kwh"] += min(entladen, einsp) * dt / 3600
        if entladen > SCHWELLE_KW and einsp > SCHWELLE_KW:
            r["aus_dem_speicher_eingespeist_s"] += dt
            strecke += dt
            r["laengste_einspeisung_aus_dem_speicher_s"] = max(
                r["laengste_einspeisung_aus_dem_speicher_s"], strecke)
        else:
            strecke = 0.0
        r["geladen_kwh"] += laden * dt / 3600
        r["entladen_kwh"] += entladen * dt / 3600
        r["bezug_kwh"] += bezug * dt / 3600
        r["einspeisung_kwh"] += einsp * dt / 3600
        r["ueberschuss_angeboten_kwh"] += max(s["pv"] - s["last"], 0.0) * dt / 3600
        r["groesste_entladung_kw"] = max(r["groesste_entladung_kw"], entladen)
        if s["v"] == 1 and not an:
            r["verbraucher"] += 1
            ue = f"{s['ue']:g}"
            r["verbraucher_je_ueberschuss_kw"][ue] = r["verbraucher_je_ueberschuss_kw"].get(ue, 0) + 1
        if s["v"] == 0 and an:
            enden.append(s["t"])
        an = s["v"] == 1
    r["aus_dem_speicher_eingespeist_s"] = round(r["aus_dem_speicher_eingespeist_s"])
    r["laengste_einspeisung_aus_dem_speicher_s"] = round(r["laengste_einspeisung_aus_dem_speicher_s"])
    im_fenster = [(t, kw) for t, kw in schreiben if von_s <= t < bis_s]
    r["sollwerte_geschrieben"] = len(im_fenster)
    r["entlade_befehle"] = sum(1 for _, kw in im_fenster if kw < 0)
    r["kleinster_sollwert_kw"] = min((kw for _, kw in im_fenster), default=None)
    r["groesster_sollwert_kw"] = max((kw for _, kw in im_fenster), default=None)
    r["entlade_befehle_im_einzelnen"] = [{"t_s": t, "sollwert_kw": kw}
                                        for t, kw in im_fenster if kw < 0][:20]
    # Wie lange nach dem ENDE eines Verbrauchers stand der Entlade-Befehl noch?
    # Gezaehlt wird nur, wo am Ende ueberhaupt einer stand.
    ruecknahmen = []
    for ende in enden:
        stand = [kw for t, kw in schreiben if t <= ende]
        if not stand or stand[-1] >= 0:
            continue
        danach = [t for t, kw in schreiben if t > ende and kw >= 0]
        ruecknahmen.append(round(danach[0] - ende, 1) if danach else None)
    r["entlade_befehl_stand_nach_verbraucher_ende_s"] = ruecknahmen
    # 0 heisst: die Box hat im ganzen Fenster selbst geregelt („Geraet regelt“,
    # Register 41 = 0, kam nicht vor) - der gedaempfte Folger ist der gepruefte Weg.
    r["ems_freigabe_entzogen"] = entzogen
    for k, v in list(r.items()):
        if isinstance(v, float):
            r[k] = round(v, 4)

    zu_wenig = [ue for ue, n in r["verbraucher_je_ueberschuss_kw"].items() if n < MIN_JE_ABSCHNITT]
    if r["sekunden"] < 0.9 * (bis_s - von_s):
        r["urteil"], r["satz"] = "nicht_gefahren", (
            f"nur {r['sekunden']} von {bis_s - von_s:.0f} Sekunden protokolliert - "
            "der Lauf wurde unterbrochen")
    elif r["verbraucher"] < MIN_VERBRAUCHER or zu_wenig:
        r["urteil"], r["satz"] = "nicht_gefahren", (
            f"nur {r['verbraucher']} Verbraucher im Fenster "
            f"(je Ueberschuss {r['verbraucher_je_ueberschuss_kw']}) - der Lauf wuerde nichts beweisen")
    elif fall == "ruhe":
        r["urteil"], r["satz"] = "gemessen", (
            f"{r['verbraucher']} kurze Verbraucher in einer Viertelstunde ohne geplantes Laden: "
            f"{r['entlade_befehle']} Entlade-Befehle, aus dem Speicher eingespeist "
            f"{r['aus_dem_speicher_eingespeist_kwh'] * 1000:.1f} Wh in "
            f"{r['aus_dem_speicher_eingespeist_s']} s (laengste Strecke "
            f"{r['laengste_einspeisung_aus_dem_speicher_s']} s)")
    elif r["geladen_kwh"] <= 0 or not r["sollwerte_geschrieben"]:
        r["urteil"], r["satz"] = "nicht_gefahren", (
            "die Box hat im Fenster nie geladen - die Lade-Viertelstunde lief nicht")
    elif (r["aus_dem_speicher_eingespeist_kwh"] > 1e-6 or r["aus_dem_speicher_eingespeist_s"] > 0
          or r["entlade_befehle"] > 0):
        r["urteil"], r["satz"] = "rot", (
            f"{r['entlade_befehle']} Entlade-Befehle (kleinster Sollwert "
            f"{r['kleinster_sollwert_kw']} kW), aus dem Speicher eingespeist "
            f"{r['aus_dem_speicher_eingespeist_kwh'] * 1000:.1f} Wh in "
            f"{r['aus_dem_speicher_eingespeist_s']} s bei {r['verbraucher']} kurzen Verbrauchern")
    else:
        r["urteil"], r["satz"] = "gruen", (
            f"{r['verbraucher']} kurze Verbraucher, kein Entlade-Befehl (kleinster Sollwert "
            f"{r['kleinster_sollwert_kw']} kW), aus dem Speicher eingespeist 0 Wh, geladen "
            f"{r['geladen_kwh'] * 1000:.0f} Wh von {r['ueberschuss_angeboten_kwh'] * 1000:.0f} Wh "
            "angebotenem Ueberschuss")
    return r


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--protokoll", required=True, help="docker logs des Szenario-Simulators")
    p.add_argument("--von", type=float, required=True, help="Fensterbeginn, Sekunden seit Simulatorstart")
    p.add_argument("--bis", type=float, required=True)
    p.add_argument("--fall", choices=("laden", "ruhe"), default="laden")
    a = p.parse_args()
    with open(a.protokoll, encoding="utf-8", errors="replace") as f:
        print(json.dumps(urteile(f.read(), a.von, a.bis, a.fall), ensure_ascii=False, indent=1))
