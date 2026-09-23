# -*- coding: utf-8 -*-
"""Erzeugt `docs/contracts/v2/rechte-matrix.md` aus `rechte-matrix.json` (UEMS AP-03 IP-1) und
spiegelt die JSON-Datei byte-gleich nach `frontend/portal/src/rechte-matrix.json`.

    python3 docs/contracts/v2/tools/rechte_matrix.py            # schreibt .md und Portal-Kopie
    python3 docs/contracts/v2/tools/rechte_matrix.py --check    # nur prüfen, ob beide aktuell sind

`--check` schreibt nichts und endet mit 1, wenn die Markdown-Datei vom Generator abweicht — so
fällt auf, wenn jemand die Tabelle von Hand geändert hat statt `rechte-matrix.json` — oder wenn die
Portal-Kopie nicht mehr byte-gleich ist. Die Kopie gibt es, weil das Portal-Image mit dem
Build-Kontext `frontend/portal` gebaut wird (`.forgejo/workflows/deploy*.yaml`) und `docs/` dort
fehlt; `rechteMatrix.sync.test.ts` hält sie im Portal-Test fest. Die Tabelle
unter „Matrix“ entsteht aus den Zeilen OHNE `nachtrag` und ist zeichengleich zur Konzept-Tabelle
AP-03 §4.3 (dieselben Spalten, dieselben Gruppenzeilen) — ihr SHA-256 steht in
`konzept_tabelle.sha256`, und beide Aufrufe enden mit 1, wenn er nicht mehr stimmt. Die Zeilen MIT
`nachtrag` (Rechte-Abschnitte von AP-04, AP-06, AP-07) stehen in einer zweiten Tabelle darunter,
dazu jede Handlung dieser Abschnitte mit ihrer Kennung. Der Java-Test `RechteAbleitungVectorsTest`
liest beide Tabellen zurück und hält sie zeilengleich an die JSON-Datei. Kein Fremdpaket, kein
Netz, deterministisch.
"""
import hashlib
import json
import sys
from pathlib import Path

V2 = Path(__file__).resolve().parent.parent
QUELLE = V2 / "rechte-matrix.json"
ZIEL = V2 / "rechte-matrix.md"
PORTAL_KOPIE = V2.parents[2] / "frontend" / "portal" / "src" / "rechte-matrix.json"
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
ZUORDNUNG = {"neu": "neue Zeile", "zugeordnet": "bestehende Zeile"}


def zelle(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def tabelle(kopf, zeilen):
    out = ["| " + " | ".join(zelle(h) for h in kopf) + " |", "|" + "---|" * len(kopf)]
    for z in zeilen:
        out.append("| " + " | ".join(zelle(c) for c in z) + " |")
    return "\n".join(out)


def matrix_tabelle(m, aktionen):
    rollen = m["rollen"]
    titel = {g["kennung"]: g["titel"] for g in m["gruppen"]}
    kopf = ["Aktion", "Herkunft"] + [r["kundenwort"] for r in rollen] + ["Anmerkung"]
    zeilen = []
    gruppe = None
    for a in aktionen:
        if a["gruppe"] != gruppe:
            gruppe = a["gruppe"]
            zeilen.append([f"**{titel[gruppe]}**"] + [""] * (len(kopf) - 1))
        zeilen.append([a["kundenwort"], a["herkunft"]]
                      + [a["zellen"][r["kennung"]] for r in rollen]
                      + [a["anmerkung"] or ""])
    return tabelle(kopf, zeilen)


def konzept_tabelle(m):
    """Die Tabelle der Zeilen OHNE `nachtrag` — und ob sie noch die des Konzepts ist."""
    t = matrix_tabelle(m, [a for a in m["aktionen"] if "nachtrag" not in a])
    k = m["konzept_tabelle"]
    ist = hashlib.sha256((t + "\n").encode("utf-8")).hexdigest()
    if ist != k["sha256"]:
        raise SystemExit(
            f"ABWEICHUNG: die Zeilen ohne `nachtrag` sind nicht mehr die Tabelle {k['abschnitt']} "
            f"(SHA-256 {ist}, erwartet {k['sha256']}). Eine Konzept-Zeile ändert nur ein benannter "
            "Widerspruch in rechte-vectors.json — und dann auch `konzept_tabelle`."
        )
    return t


def markdown(m):
    rollen = m["rollen"]
    titel = {g["kennung"]: g["titel"] for g in m["gruppen"]}
    codes = " · ".join(f"**{c['code']}** {c['bedeutung']}" for c in m["codes"])
    konzept = [a for a in m["aktionen"] if "nachtrag" not in a]
    nach = [a for a in m["aktionen"] if "nachtrag" in a]

    rollen_tab = tabelle(
        ["Rolle", "Kennung", "Kürzel", "Geltungsbereich", "Achsen"],
        [[r["kundenwort"], f"`{r['kennung']}`", r["kuerzel"], GELTUNG[r["geltungsbereich"]],
          r["achsen"]] for r in rollen],
    )
    umfang_tab = tabelle(
        ["Umfang", "Kennung", "Code"],
        [[u["kundenwort"], f"`{u['kennung']}`", u["code"]] for u in m["umfaenge"]],
    )
    handlung_tab = tabelle(
        ["Abschnitt", "Handlung", "Wer (Wortlaut des Abschnitts)", "Recht (Abschnitt)", "Kennung",
         "Zuordnung", "Anmerkung"],
        [[n["abschnitt"], h["handlung"], h["wer"], h["recht"] or "—",
          " · ".join(f"`{k}`" for k in h["kennungen"]), ZUORDNUNG[h["zuordnung"]],
          h["anmerkung"] or ""]
         for n in m["nachtraege"] for h in n["handlungen"]],
    )
    regel_tab = tabelle(
        ["Abschnitt", "Wortlaut", "Wo es gilt"],
        [[n["abschnitt"], r["wortlaut"], r["wo"]] for n in m["nachtraege"] for r in n["regeln"]],
    )
    quellen = " · ".join(f"{n['abschnitt']} ({n['konzept']})" for n in m["nachtraege"])
    kennung_tab = tabelle(
        ["Kennung", "Gruppe", "Aktion", "Quelle"],
        [[f"`{a['kennung']}`", titel[a["gruppe"]], a["kundenwort"],
          a.get("nachtrag", m["konzept_tabelle"]["abschnitt"])] for a in m["aktionen"]],
    )

    return (
        KOPF
        + "\n# Rechte-Matrix (UEMS AP-03 §4.3 und Nachträge)\n\n"
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
        f"{len(konzept)} Aktionen × {len(rollen)} Rollen — zeichengleich zur Tabelle im "
        f"AP-03-Konzept §4.3 (SHA-256 `{m['konzept_tabelle']['sha256']}`).\n\n"
        + konzept_tabelle(m) + "\n\n"
        "## Nachträge der später konzipierten Pakete\n\n"
        "AP-03 wurde vor AP-04 … AP-07 konzipiert; deren Rechte-Abschnitte hat der Captain mit dem "
        f"jeweiligen Paket abgenommen: {quellen}. "
        f"Die {len(nach)} Zeilen darunter entstehen dort; ihre Zellen sind die des Abschnitts "
        "(„wie Zeile X“ = die Zellen von X). Widersprüche zu einer Konzept-Zeile stehen benannt in "
        "[`rechte-vectors.json`](./rechte-vectors.json) (`widersprueche`), samt Fällen.\n\n"
        + matrix_tabelle(m, nach) + "\n\n"
        "### Jede Handlung der Rechte-Abschnitte\n\n"
        "Welche Kennung jede Handlung trägt: eine **neue Zeile** (oben) oder eine **bestehende "
        "Zeile**, die sie schon regelt.\n\n"
        + handlung_tab + "\n\n"
        "### Regeln ohne eigene Zeile\n\n"
        "Sätze der Abschnitte, die keine Handlung sind — und wo sie gelten.\n\n"
        + regel_tab + "\n\n"
        "## Kennungen\n\n"
        "Jede Zeile hat eine stabile Kennung; eine Route, eine Fläche und ein Vektor verweisen "
        "über sie (`@Recht(\"messstelle.bearbeiten\")`), nie über den Wortlaut. Jede Kennung, die "
        "ein Routen-Kommentar in `services/api` nennt, steht hier (`RechteKennungenDerRoutenTest`).\n\n"
        + kennung_tab + "\n"
    )


def main(argv):
    quelle = QUELLE.read_text(encoding="utf-8")
    soll = markdown(json.loads(quelle))
    ist = ZIEL.read_text(encoding="utf-8") if ZIEL.exists() else None
    kopie = PORTAL_KOPIE.read_text(encoding="utf-8") if PORTAL_KOPIE.exists() else None
    if "--check" in argv:
        rc = 0
        if ist != soll:
            print("VERALTET: rechte-matrix.md")
            rc = 1
        if kopie != quelle:
            print("VERALTET: frontend/portal/src/rechte-matrix.json")
            rc = 1
        if rc:
            print("→ python3 docs/contracts/v2/tools/rechte_matrix.py")
            return rc
        print("aktuell: rechte-matrix.md, frontend/portal/src/rechte-matrix.json")
        return 0
    if ist != soll:
        ZIEL.write_text(soll, encoding="utf-8")
        print("geschrieben  docs/contracts/v2/rechte-matrix.md")
    else:
        print("unverändert  docs/contracts/v2/rechte-matrix.md")
    if kopie != quelle:
        PORTAL_KOPIE.write_text(quelle, encoding="utf-8")
        print("geschrieben  frontend/portal/src/rechte-matrix.json")
    else:
        print("unverändert  frontend/portal/src/rechte-matrix.json")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
