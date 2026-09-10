# -*- coding: utf-8 -*-
"""Erzeugt `glossar.md`, `beziehungen.md`, `zustaende.md` und `fachmodell.svg` aus `fachmodell.py`.

    python3 docs/fachmodell/tools/build_fachmodell.py            # schreibt die vier Dateien
    python3 docs/fachmodell/tools/build_fachmodell.py --check     # nur prüfen, ob sie aktuell sind

`--check` schreibt nichts und endet mit 1, wenn eine Datei vom Generator abweicht — so fällt
auf, wenn jemand die Markdown-Dateien von Hand geändert hat statt `fachmodell.py`.
Kein Fremdpaket, keine Netzzugriffe, deterministisch.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fachmodell as F  # noqa: E402

OUT = Path(__file__).resolve().parent.parent
KOPF = (
    "<!-- ERZEUGT von docs/fachmodell/tools/build_fachmodell.py aus fachmodell.py — "
    "nicht von Hand ändern. -->\n"
)


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def zelle(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def tabelle(kopf, zeilen):
    p = ["| " + " | ".join(kopf) + " |", "|" + "|".join("---" for _ in kopf) + "|"]
    for z in zeilen:
        p.append("| " + " | ".join(zelle(x) for x in z) + " |")
    return "\n".join(p)


# --------------------------------------------------------------------------------- glossar.md
def glossar_md():
    p = [KOPF, "# Glossar des Unternehmens-Energiemanagements\n"]
    p.append(
        "Alle 23 Begriffs-Einträge aus AP-00 §4.1. **Definition · Erläuterung · Beispiel** sind die "
        "Kundensprache; **Heute im Code** ist die einzige Spalte, in der interne Namen "
        "(`tenant`, `site`, `measurement_point` …) vorkommen dürfen. **Abgrenzung** sagt, was "
        "der Begriff NICHT ist.\n"
    )
    p.append(
        "Belege sind `datei:zeile` am Stand `origin/main` 36f3e7e8 (10.09.2026); `MIG` = "
        "`services/api/src/main/resources/db/migration`, `PORTAL` = `frontend/portal/src`, "
        "`DATA` = die Konzept-Ablage des Programms (nicht in diesem Repo). "
        "`tools/check_belege.sh` prüft die Pfade.\n"
    )
    p.append(
        "Ein Kasten **Verfeinert durch** nennt, was ein späteres Konzeptpaket geschärft, "
        "ergänzt oder mit ⚠ ERSETZT hat — mit Paket und Entscheid. Der Text darüber ist der "
        "AP-00-Stand vom 10.09.2026 und bleibt unverändert stehen.\n"
    )
    sichten = {k: v[0] for k, v in F.SICHTEN.items()}
    p.append("## Inhalt\n")
    for g in F.GLOSSAR:
        p.append(f"- [{g['begriff']}](#{anker(g['begriff'])}) — Sicht {sichten[g['sicht']]}")
    p.append("")
    for g in F.GLOSSAR:
        p.append(f"## {g['begriff']}\n")
        p.append(f"*Sicht: {sichten[g['sicht']]}*\n")
        p.append(f"**{g['kurz']}**\n")
        p.append(g["lang"] + "\n")
        p.append(f"**Beispiel (Referenzunternehmen Ahrenberg).** {g['beispiel']}\n")
        p.append(f"**Heute im Code.** {g['heute']}\n")
        p.append(f"**Abgrenzung.** {g['abgrenzung']}\n")
        for ref, text in F.VERFEINERUNGEN.get(g["id"], []):
            p.append(f"> **Verfeinert durch {ref}:** {text}\n")
    return "\n".join(p).rstrip() + "\n"


def anker(s):
    keep = "".join(c for c in s.lower() if c.isalnum() or c in " -_äöüß")
    return keep.strip().replace(" ", "-")


# ----------------------------------------------------------------------------- beziehungen.md
def beziehungen_md():
    p = [KOPF, "# Fachmodell — Beziehungen, Kardinalität, Zeitgültigkeit\n"]
    p.append(
        "Die Beziehungsliste des Fachmodells. **Zeitgültig = ja** heißt: die Beziehung hat "
        "„gültig ab“ und „gültig bis“ und wird nie überschrieben, sondern beendet und neu "
        "begonnen — ein Bericht liest immer die Zuordnungen seines Zeitraums. "
        "**Zeitgültig = nein** heißt: eine Änderung ist ein NEUES Objekt.\n"
    )
    p.append(
        "Die Spalte **Herkunft** nennt „AP-00“, wo der Stand vom 10.09.2026 unverändert gilt, "
        "und sonst das Paket samt Entscheid, der die Zeile verfeinert oder (⚠ ERSETZT) ersetzt "
        "hat. Die zeitliche Auflösung einer Gültigkeit ist der TAG, wirksam 00:00 Uhr in der "
        "Zeitzone des Standorts (AP-02 E9); einzige Ausnahme ist die Quellenbindung einer "
        "Messstelle, die einen Zeitpunkt auf die Minute trägt (AP-04 E2).\n"
    )
    p.append(
        tabelle(
            ["Von", "Kardinalität", "Nach", "Zeitgültig", "Bemerkung", "Herkunft"],
            F.BEZIEHUNGEN,
        )
    )
    p.append("\n## Das Diagramm\n")
    p.append(
        "![Fachmodell auf einen Blick — Ort (blau), Organisation (grün), elektrisch (orange) "
        "und Erfassung (grau) um die logische Messstelle](fachmodell.svg)\n"
    )
    p.append("## Offene Spannungen aus AP-00\n")
    for w in F.WIDERSPRUECHE:
        p.append(f"### {w['id']} — {w['titel']}\n")
        p.append(f"- **Bisher:** {w['alt']}")
        p.append(f"- **Neu:** {w['neu']}")
        p.append(f"- **Auflösung:** {w['aufloesung']}\n")
    p.append("## Was AP-00 den Nachbarpaketen vorgibt\n")
    p.append(tabelle(["Paket", "Aus AP-00 verbindlich", "Bleibt dort"], F.NACHBARN))
    return "\n".join(p).rstrip() + "\n"


# ------------------------------------------------------------------------------- zustaende.md
def zustaende_md():
    p = [KOPF, "# Zustandsvokabular\n"]
    p.append(
        "Zwei Familien, entschieden in AP-00 E8 (10.09.2026): der **Lebenszyklus**, den der "
        "Kunde setzt (Entwurf → eingerichtet → aktiv → archiviert, dazu angehalten), und die "
        "**Beobachtung**, die nie jemand von Hand setzt (liefert Daten · steuert). Die Wörter "
        "bedeuten bei JEDEM Objekt dasselbe; welche davon ein Objekt haben kann, sagt die "
        "Matrix.\n"
    )
    p.append(
        "AP-01 E8 bildet die drei Wörter des Programm-Plans darauf ab: **sichtbar** = kein "
        "Objekt (ein Angebot auf der Funktions-Karte), **begonnen** = Entwurf (bei „Steuern & "
        "Optimieren“ auch eingerichtet, noch nicht gestartet), **aktiv** = aktiv.\n"
    )
    p.append("## Definitionen\n")
    p.append(tabelle(["Zustand", "Familie", "Bedeutung", "Was der Kunde liest"], F.ZUSTAND_DEFINITIONEN))
    p.append("\n## Matrix je Objekt\n")
    p.append(
        tabelle(
            [
                "Objekt",
                "Entwurf",
                "eingerichtet",
                "aktiv / angehalten / archiviert",
                "liefert Daten",
                "steuert",
                "Was der Kunde sieht",
            ],
            F.ZUSTAND_MATRIX,
        )
    )
    p.append("\n## Übergänge\n")
    p.append(tabelle(["Übergang", "Auslöser", "Regel"], F.ZUSTAND_UEBERGAENGE))
    p.append("\n## Verfeinerungen der Nachbarpakete\n")
    for ref, text in F.VERFEINERUNGEN["zustaende"]:
        p.append(f"- **{ref}:** {text}")
    p.append(
        "\n⚠ Die Ableitung von „liefert Daten“ und „steuert“ wird als Vertrag mit geteilten "
        "Vektoren gebaut (AP-00 IP-3, `docs/contracts/v2/uems-zustand-vectors.json`) — bis "
        "dahin lebt in `services/api` und im Portal noch das harte 5-Minuten-Fenster.\n"
    )
    p.append("## Entscheidungslog\n")
    p.append("### AP-00 (Fachmodell)\n")
    p.append(tabelle(["Datum", "Entscheid", "Wortlaut"], F.ENTSCHEIDUNGSLOG))
    p.append("\n### Nachbarpakete — nur was einen AP-00-Begriff berührt\n")
    p.append(tabelle(["Datum", "Entscheid", "Inhalt"], F.ENTSCHEIDUNGSLOG_NACHBARN))
    return "\n".join(p).rstrip() + "\n"


# ------------------------------------------------------------------------------ fachmodell.svg
def fachmodell_svg():
    ORT, ORG, EL, ERF, BET = "#2563eb", "#15803d", "#ea580c", "#475569", "#7c3aed"

    def box(x, y, w, h, fill, stroke, lines, fs=15, bold_first=True):
        out = [
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1.5"/>'
        ]
        n = len(lines)
        cy = y + h / 2 - (n - 1) * (fs + 3) / 2 + fs * 0.35
        for i, ln in enumerate(lines):
            fw = "700" if (i == 0 and bold_first) else "500"
            col = "#1e293b" if i == 0 else "#475569"
            fsz = fs if i == 0 else fs - 2
            out.append(
                f'<text x="{x + w / 2}" y="{cy + i * (fs + 3)}" text-anchor="middle" '
                f'font-size="{fsz}" font-weight="{fw}" fill="{col}">{esc(ln)}</text>'
            )
        return "".join(out)

    def arrow(pts, color, label=None, lx=None, ly=None, dash=False):
        d = " ".join(f"{a},{b}" for a, b in pts)
        s = (
            f'<polyline points="{d}" fill="none" stroke="{color}" stroke-width="2" '
            f'marker-end="url(#ah-{color[1:]})"'
            + (' stroke-dasharray="6 4"' if dash else "")
            + "/>"
        )
        if label:
            s += (
                f'<text x="{lx}" y="{ly}" font-size="12" fill="{color}" '
                f'font-weight="600">{esc(label)}</text>'
            )
        return s

    W, H = 690, 972
    p = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" '
        f'height="{H}" role="img" aria-label="Fachmodell des Unternehmens-Energiemanagements: '
        'Ortsbaum, Organisation, elektrischer Baum und Erfassungskette um die logische '
        'Messstelle" font-family="system-ui, -apple-system, Segoe UI, sans-serif">',
        "<title>Fachmodell auf einen Blick</title>",
        "<desc>Drei Sichten auf dieselben Messstellen: Ort (blau: Kundenbereich, Unternehmen, "
        "Standort, Gebäude, Bereich), Organisation (grün: Prozess, Kostenstelle) und "
        "elektrisch (orange: Netzanschluss, Anlage). Die graue Erfassungskette Box → "
        "Datenquelle → Gerät → Komponente → Messkanal liefert die führende Quelle; die "
        "logische Messstelle in der Mitte überlebt sie. AP-00 vom 10.09.2026, verfeinert "
        "durch AP-01 bis AP-07.</desc>",
    ]
    p.append(
        "<defs>"
        + "".join(
            f'<marker id="ah-{c[1:]}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" '
            f'markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" '
            f'fill="{c}"/></marker>'
            for c in (ORT, ORG, EL, ERF, BET)
        )
        + "</defs>"
    )
    p.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff"/>')
    # Bänder (Hintergrund)
    p.append(
        '<rect x="8" y="8" width="230" height="380" rx="14" fill="#eff6ff"/>'
        '<text x="20" y="30" font-size="12" font-weight="800" fill="#1e40af" '
        'letter-spacing="1">ORT · Ortsbaum</text>'
    )
    p.append(
        '<rect x="450" y="150" width="232" height="238" rx="14" fill="#fff7ed"/>'
        '<text x="462" y="172" font-size="12" font-weight="800" fill="#9a3412" '
        'letter-spacing="1">ELEKTRISCH</text>'
    )
    p.append(
        '<rect x="8" y="560" width="230" height="150" rx="14" fill="#f0fdf4"/>'
        '<text x="20" y="582" font-size="12" font-weight="800" fill="#166534" '
        'letter-spacing="1">ORGANISATION</text>'
    )
    p.append(
        '<rect x="8" y="740" width="674" height="220" rx="14" fill="#f1f5f9"/>'
        '<text x="20" y="762" font-size="12" font-weight="800" fill="#334155" '
        'letter-spacing="1">ERFASSUNG · technische Kette, die Messstelle überlebt sie</text>'
    )
    # Ort-Spalte
    ort = [
        ("Kundenbereich", "Datenraum · Rechte"),
        ("Unternehmen", "Wurzel beider Bäume"),
        ("Standort", "Adresse · Zeitzone · Rechte"),
        ("Gebäude", "optional · Fläche"),
        ("Bereich", "optional · räumlich"),
    ]
    ys = [44, 110, 176, 242, 308]
    for (t, s), y in zip(ort, ys):
        p.append(box(20, y, 205, 46, "#fff", ORT, [t, s]))
    for i, lab in enumerate(["1 : 1", "1 : 0..n", "1 : 0..n", "0..n"]):
        p.append(arrow([(122, ys[i] + 46), (122, ys[i + 1])], ORT, lab, 130, ys[i] + 60))
    # Elektrisch-Spalte
    p.append(box(460, 176, 212, 46, "#fff", EL, ["Netzanschluss", "Marktlokation · Tarif · Grenze"]))
    p.append(
        box(460, 250, 212, 56, "#fff", EL, ["Anlage", "= elektrisches System", "an genau 1 Standort"])
    )
    p.append(
        box(492, 330, 180, 46, "#fff", BET, ["Betriebsmodell · Regel", "übernommen · an der Anlage"], fs=14)
    )
    p.append(arrow([(225, 199), (460, 199)], EL, "Standort 1 : 0..n Anschluss", 250, 192))
    p.append(arrow([(566, 222), (566, 250)], EL, "1 : 1", 574, 240))
    p.append(arrow([(582, 306), (582, 330)], BET, "1 : 0..1", 590, 324))
    # Messstelle (Zentrum) — AP-04 E1: eine Hauptgröße + 0..n Nebengrößen
    p.append('<rect x="245" y="404" width="210" height="118" rx="12" fill="#1e293b" stroke="#1e293b"/>')
    p.append(
        '<text x="350" y="428" text-anchor="middle" font-size="17" font-weight="800" '
        'fill="#fff">Logische Messstelle</text>'
    )
    for i, ln in enumerate(
        [
            "Kennzeichen · Name",
            "1 Hauptgröße + 0..n Nebengrößen",
            "Medium · Richtung · Wertart",
            "gemessen | berechnet",
        ]
    ):
        p.append(
            f'<text x="350" y="{448 + i * 16}" text-anchor="middle" font-size="11.5" '
            f'fill="#cbd5e1">{esc(ln)}</text>'
        )
    p.append(
        '<text x="350" y="512" text-anchor="middle" font-size="11.5" fill="#fde68a">'
        "bis 100 je Kundenbereich</text>"
    )
    # Ort → Messstelle
    p.append(arrow([(122, 354), (122, 462), (245, 462)], ORT, "Ort: Standort | Gebäude | Bereich", 130, 380))
    p.append(
        '<text x="130" y="394" font-size="12" fill="#2563eb" font-weight="600">'
        "genau einer je Zeitpunkt (zeitgültig)</text>"
    )
    # Elektrisch → Messstelle
    p.append(arrow([(475, 306), (475, 462), (455, 462)], EL, "Anlage + elektrische Stellung", 484, 398))
    p.append(
        '<text x="484" y="412" font-size="11.5" fill="#ea580c" font-weight="600">'
        "Hauptzähler | Unterzähler von …</text>"
    )
    p.append(
        '<text x="484" y="426" font-size="11.5" fill="#ea580c" font-weight="600">'
        "(zeitgültig · Bezug: Messstelle)</text>"
    )
    # Organisation → Messstelle
    p.append(box(20, 596, 205, 46, "#fff", ORG, ["Prozess", "gebäudeübergreifend · Baum"]))
    p.append(box(20, 656, 205, 46, "#fff", ORG, ["Kostenstelle", "flach · feste Anteile Σ 100 %"]))
    p.append(
        arrow(
            [(225, 619), (238, 619), (238, 496), (245, 496)],
            ORG,
            "0..n Prozesse · 0..n Kostenstellen (zeitgültig)",
            20,
            550,
        )
    )
    p.append(f'<polyline points="225,679 238,679 238,619" fill="none" stroke="{ORG}" stroke-width="2"/>')
    # Erfassungskette
    chain = [
        ("Box (Edge)", "Heimat: 1 Anlage"),
        ("Datenquelle", "eigenes Objekt · 1 Box"),
        ("Gerät", "physisch"),
        ("Komponente", "in 1 Anlage"),
        ("Messkanal", "Katalog · Qualität"),
    ]
    labs = ["1 : 0..n", "1 : 1..n", "1 : 1..n", "1 : 1..n"]
    x = 20
    for i, (t, s) in enumerate(chain):
        p.append(box(x, 790, 122, 56, "#fff", ERF, [t, s], fs=14))
        if i < 4:
            p.append(arrow([(x + 122, 818), (x + 136, 818)], ERF))
            p.append(
                f'<text x="{x + 129}" y="782" text-anchor="middle" font-size="11" '
                f'fill="{ERF}" font-weight="600">{labs[i]}</text>'
            )
        x += 136
    # AP-07 E2 (Reihe an der Komponente) und AP-06 E3 (führende Box) als Fußnoten
    fussnoten = [
        "Messreihe = Komponente + Messkanal (AP-07 E2) — Gerät, lesende Box und",
        "Einstellungs-Fassung reisen als Herkunft JE WERT mit.",
        "Mehrere Boxen je Anlage: EINE ist die führende Box (AP-06 E3) — sie bildet",
        "die Anlagen-Summe und empfängt den Fahrplan.",
    ]
    for i, ln in enumerate(fussnoten):
        p.append(
            f'<text x="20" y="{870 + i * 17}" font-size="11.5" fill="#334155" '
            f'font-weight="600">{esc(ln)}</text>'
        )
    p.append(
        '<text x="20" y="948" font-size="11" fill="#64748b">'
        "AP-00 vom 10.09.2026, verfeinert durch AP-01 … AP-07 · erzeugt aus "
        "docs/fachmodell/tools/fachmodell.py</text>"
    )
    # Messkanal → Messstelle (führende Quelle)
    p.append(
        arrow(
            [(605, 790), (605, 575), (350, 575), (350, 522)],
            ERF,
            "führende Quelle 0..1 je Größe (zeitgültig) · Vergleichsquellen 0..n",
            255,
            594,
        )
    )
    # Komponente ↔ Anlage
    p.append(
        arrow(
            [(469, 790), (469, 726), (684, 726), (684, 278), (672, 278)],
            EL,
            "Komponente n : 1 Anlage",
            480,
            720,
            dash=True,
        )
    )
    p.append("</svg>")
    return "\n".join(p) + "\n"


DATEIEN = {
    "glossar.md": glossar_md,
    "beziehungen.md": beziehungen_md,
    "zustaende.md": zustaende_md,
    "fachmodell.svg": fachmodell_svg,
}


def main(argv):
    check = "--check" in argv
    schlecht = []
    for name, fn in DATEIEN.items():
        soll = fn()
        ziel = OUT / name
        ist = ziel.read_text(encoding="utf-8") if ziel.exists() else None
        if check:
            if ist != soll:
                schlecht.append(name)
        elif ist != soll:
            ziel.write_text(soll, encoding="utf-8")
            print(f"geschrieben  {ziel.relative_to(OUT.parent.parent)}")
        else:
            print(f"unverändert  {ziel.relative_to(OUT.parent.parent)}")
    if check:
        if schlecht:
            print("VERALTET: " + ", ".join(schlecht))
            print("→ python3 docs/fachmodell/tools/build_fachmodell.py")
            return 1
        print("aktuell: glossar.md, beziehungen.md, zustaende.md, fachmodell.svg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
