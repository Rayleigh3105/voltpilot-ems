#!/usr/bin/env python3
"""Das Protokoll als Artefakt: nur technische Angaben, keine Kennungen."""
import argparse, json, datetime

p = argparse.ArgumentParser()
for n in ("befunde aus repo-stand paar core-ref palette-ref tag-sha stempel "
          "kern-stempel palette-stempel palette-marke palette-pruefung "
          "gemeldeter-stand strecke").split():
    p.add_argument("--" + n, default="")
a = p.parse_args()

befunde = [json.loads(z) for z in open(a.befunde, encoding="utf-8") if z.strip()]
gruen = sum(1 for b in befunde if b["urteil"] == "gruen")
rot = sum(1 for b in befunde if b["urteil"] == "rot")
offen = sum(1 for b in befunde if b["urteil"] == "nicht_gefahren")
befund = sum(1 for b in befunde if b["urteil"] == "befund")

d = {
    "nachweis": "NW-3 — ausgeliefertes Box-Image gegen die neue Cloud (AP-14 IP-6)",
    "gefahren_am": datetime.datetime.now(datetime.timezone.utc)
                   .strftime("%Y-%m-%dT%H:%M:%SZ"),
    "neue_cloud": {"repo_stand": a.repo_stand},
    "paar": {
        "name": a.paar,
        "core_ref": a.core_ref,
        "palette_ref": a.palette_ref,
        "herkunft": "aus dem Release-Tag gebaut, NICHT das Release-Artefakt",
        "grund": ("Das Release-Artefakt ist ein Container-Image-Paar in der privaten "
                  "Registry git.tecmaxx.de; anonym HTTP 401. Es wurde keine "
                  "Zugangsdaten angefragt und kein Login probiert."),
        "tag_commit": a.tag_sha,
        "versionsstempel_der_ci": a.stempel,
    },
    "was_sich_am_paar_pruefen_laesst": {
        "core_binary_stempel": a.kern_stempel,
        "palette_oci_label": a.palette_stempel,
        "palette_inhaltsmarke": a.palette_marke,
        "package_edge_runtime_check_des_tags": a.palette_pruefung,
        "stand_den_die_box_selbst_meldet": a.gemeldeter_stand,
    },
    "glieder": {
        "echte_prozesse": ["Go-Core (aus dem Tag)", "Node-RED-Palette (aus dem Tag)",
                           "SunSpec-Simulator (aus dem Tag)", "MQTT-Broker (Mosquitto)"],
        "cloud_seite": ("kein api-Prozess: die festgenagelten Nutzlasten des Standes "
                        "(docs/contracts/v2/examples/*) werden ueber den echten Broker "
                        "zugestellt"),
        "strecke_ingest_writer": "gefahren" if a.strecke == "1" else "nicht gefahren",
    },
    "punkte": befunde,
    "zusammenfassung": f"{gruen} gruen, {rot} rot, {befund} Befund, {offen} nicht gefahren",
}
json.dump(d, open(a.aus, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
