# -*- coding: utf-8 -*-
"""Erzeugt `docs/contracts/v2/rechte-matrix.md` aus `rechte-matrix.json` (UEMS AP-03 IP-1).

    python3 docs/contracts/v2/tools/rechte_matrix.py            # schreibt rechte-matrix.md
    python3 docs/contracts/v2/tools/rechte_matrix.py --check    # nur prüfen, ob sie aktuell ist

`--check` schreibt nichts und endet mit 1, wenn die Markdown-Datei vom Generator abweicht — so
fällt auf, wenn jemand die Tabelle von Hand geändert hat statt `rechte-matrix.json`. Die Tabelle
unter „Matrix“ ist zeichengleich zur Konzept-Tabelle AP-03 §4.3 (dieselben Spalten, dieselben
Gruppenzeilen); der Java-Test `RechteAbleitungVectorsTest` liest sie zurück und hält sie
zeilengleich an die JSON-Datei. Kein Fremdpaket, kein Netz, deterministisch.
"""
import json
import sys
from pathlib import Path

V2 = Path(__file__).resolve().parent.parent
QUELLE = V2 / "rechte-matrix.json"
ZIEL = V2 / "rechte-matrix.md"
KOPF = (
    "<!-- ERZEUGT von docs/contracts/v2/tools/rechte_matrix.py aus rechte-matrix.json — "
    "nicht von Hand ändern. -->\n"
)
GELTUNG = {
    "unternehmen": "Unternehmen",
    "standort": "je Standort",
    "standort_befristet": "je Standort · befristet",
    "plattform": "Plattform",
}


def zelle(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def tabelle(kopf, zeilen):
    out = ["| " + " | ".join(zelle(h) for h in kopf) + " |", "|" + "---|" * len(kopf)]
    for z in zeilen:
        out.append("| " + " | ".join(zelle(c) for c in z) + " |")
    return "\n".join(out)


def markdown(m):
    rollen = m["rollen"]
    titel = {g["kennung"]: g["titel"] for g in m["gruppen"]}
    codes = " · ".join(f"**{c['code']}** {c['bedeutung']}" for c in m["codes"])

    rollen_tab = tabelle(
        ["Rolle", "Kennung", "Kürzel", "Geltungsbereich", "Achsen"],
        [[r["kundenwort"], f"`{r['kennung']}`", r["kuerzel"], GELTUNG[r["geltungsbereich"]],
          r["achsen"]] for r in rollen],
    )
    umfang_tab = tabelle(
        ["Umfang", "Kennung", "Code"],
        [[u["kundenwort"], f"`{u['kennung']}`", u["code"]] for u in m["umfaenge"]],
    )

    kopf = ["Aktion", "Herkunft"] + [r["kundenwort"] for r in rollen] + ["Anmerkung"]
    zeilen = []
    gruppe = None
    for a in m["aktionen"]:
        if a["gruppe"] != gruppe:
            gruppe = a["gruppe"]
            zeilen.append([f"**{titel[gruppe]}**"] + [""] * (len(kopf) - 1))
        zeilen.append([a["kundenwort"], a["herkunft"]]
                      + [a["zellen"][r["kennung"]] for r in rollen]
                      + [a["anmerkung"] or ""])
    matrix_tab = tabelle(kopf, zeilen)

    kennung_tab = tabelle(
        ["Kennung", "Gruppe", "Aktion"],
        [[f"`{a['kennung']}`", titel[a["gruppe"]], a["kundenwort"]] for a in m["aktionen"]],
    )

    return (
        KOPF
        + "\n# Rechte-Matrix (UEMS AP-03 §4.3)\n\n"
        "Die Quelle ist [`rechte-matrix.json`](./rechte-matrix.json); diese Datei wird aus ihr "
        "erzeugt (`python3 docs/contracts/v2/tools/rechte_matrix.py`, `--check` prüft). Wie aus "
        "Matrix und Zuweisungen ein Ja oder Nein wird — Geltungsbereich vor Aktion, "
        "Unterstützer-Umfang, OCPP-Stufe, Teilansicht, Entzug —, pinnen "
        "[`rechte-vectors.json`](./rechte-vectors.json) und die Zwillinge Java "
        "`services/api/.../uems/RechteAbleitung` ⟷ TS `frontend/portal/src/rechte.ts`.\n\n"
        f"Zeilen = konkrete Kundenaktionen, Spalten = Rollen, Zellen = eindeutiger "
        f"Geltungsbereich. Codes: {codes}.\n\n"
        "## Rollen\n\n" + rollen_tab + "\n\n"
        "## Unterstützer-Umfang (E9)\n\n" + umfang_tab + "\n\n"
        "## Matrix\n\n"
        f"{len(m['aktionen'])} Aktionen × {len(rollen)} Rollen — zeichengleich zur Tabelle im "
        "AP-03-Konzept §4.3.\n\n" + matrix_tab + "\n\n"
        "## Kennungen\n\n"
        "Jede Zeile hat eine stabile Kennung; eine Route, eine Fläche und ein Vektor verweisen "
        "über sie (`@Recht(\"messstelle.bearbeiten\")`), nie über den Wortlaut.\n\n"
        + kennung_tab + "\n"
    )


def main(argv):
    soll = markdown(json.loads(QUELLE.read_text(encoding="utf-8")))
    ist = ZIEL.read_text(encoding="utf-8") if ZIEL.exists() else None
    if "--check" in argv:
        if ist != soll:
            print("VERALTET: rechte-matrix.md")
            print("→ python3 docs/contracts/v2/tools/rechte_matrix.py")
            return 1
        print("aktuell: rechte-matrix.md")
        return 0
    if ist != soll:
        ZIEL.write_text(soll, encoding="utf-8")
        print("geschrieben  docs/contracts/v2/rechte-matrix.md")
    else:
        print("unverändert  docs/contracts/v2/rechte-matrix.md")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
