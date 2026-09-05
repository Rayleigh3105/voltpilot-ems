#!/usr/bin/env python3
"""Zerlegt die grossen AGENTS.md in einen schlanken Wegweiser + docs/agents/<bereich>/.

Warum: Claude Code laedt `CLAUDE.md` -> `AGENTS.md` bei JEDEM Sitzungsstart in den
Kontext. Die drei Dateien waren zu Projekt-Chroniken angewachsen (1,17 MB / 765 KB /
356 KB) und haben Worker binnen Minuten an der Kontextgrenze sterben lassen.

Das Skript ist die WIEDERHOLBARE Hälfte des Umbaus: nach einem Rebase auf einen
neueren origin/main laeuft es erneut und erzeugt denselben Zustand, statt einen
Handarbeit-Merge zu verlangen.

Regeln, die es umsetzt:
  * Einheit der Auslagerung ist der H2-Abschnitt (`## `).
  * Ein BLOCK ueber `COLLECTION_BYTES` (bzw. die Praeambel vor dem ersten H2) ist in
    Wahrheit eine SAMMLUNG: seine Top-Level-Aufzaehlungspunkte werden je eine Datei
    in einem eigenen Verzeichnis mit `README.md` als Index.
  * Der Abschnittstext reist BYTE-VERBATIM; die Zieldatei traegt darueber genau drei
    erzeugte Zeilen (H1, Herkunft, Leerzeile). `--verify` beweist das fuer ALLE.
  * Der KERN des Wegweisers wird NICHT erzeugt, er steht in `tools/agents-md-kern/`.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAMP = "05.09.2026"
COLLECTION_BYTES = 100_000
PREAMBLE_COLLECTION_BYTES = 4_000

# datei, bereich, kappe fuer die Kurzfassung im Index, Abschnitte die VERBATIM
# im Wegweiser bleiben (Praefix-Vergleich auf der Ueberschrift)
AREAS = [
    ("AGENTS.md", "root", 42, ()),
    ("frontend/portal/AGENTS.md", "portal", 56, ("Bewegung",)),
    ("edge-app/AGENTS.md", "edge", 60, ()),
]

UMLAUT = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"}


def slugify(text: str, taken: set[str]) -> str:
    s = text
    for k, v in UMLAUT.items():
        s = s.replace(k, v)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    s = re.sub(r"-{2,}", "-", s)[:40].strip("-") or "abschnitt"
    base, n = s, 2
    while s in taken:
        s = f"{base}-{n}"
        n += 1
    taken.add(s)
    return s


def strip_markup(text: str) -> str:
    t = re.sub(r"\*\*|\*|`", "", text)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


PROVENANCE = re.compile(
    r"^(konzept|scout|report|captain|owner|live-fall|order|erste[rns]?\b|zweite[rns]?\b|"
    r"dritte[rns]?\b|vierte[rns]?\b|fuenfte|f\u00fcnfte|letzte|die (erste|zweite|dritte|vierte|"
    r"f\u00fcnfte|sechste|siebte|letzte|n\u00e4chste)|der (erste|zweite|dritte|kern|abschluss)|"
    r"das (erste|zweite|dritte)|the (first|second|third)|"
    r"\S*captain-|\S*-entscheid|\S*-order)", re.I)


def sentences(text: str) -> list[str]:
    out, buf = [], ""
    for part in re.split(r"(?<=[a-z\xe4\xf6\xfc\xdf0-9\)\"\'\u00bb])([.:;] )(?=[A-Z\u00c4\u00d6\u00dc\u201e(])", text):
        buf += part
        if part in (". ", ": ", "; "):
            out.append(buf.strip()[:-1].strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return [s for s in out if s]


def lead(title: str, body: list[str], cap: int) -> str:
    """Ein Satz Kern - mechanisch aus dem Abschnittstext, nie erfunden.

    Ueberspringt den HERKUNFTS-Vorsatz ("Konzept ...", "Captain-Order ...", "Die zweite
    Stufe des ..."), weil er in fast jedem Abschnitt steht und nichts unterscheidet.
    """
    cands: list[str] = []
    for line in body:
        s = line.strip()
        if not s or s.startswith(("#", "|", "```", "---")):
            continue
        s = re.sub(r"^[-*]\s+", "", s)
        s = strip_markup(s)
        if len(s) < 12:
            continue
        cands += sentences(s) or [s]
        if len(cands) >= 4:
            break
    if cands:
        pick = next((c for c in cands if not PROVENANCE.match(c) and len(c) >= 20), cands[0])
        if len(pick) > cap:
            cut = pick.rfind(" ", 0, cap)
            pick = pick[: cut if cut > cap * 0.6 else cap].rstrip(" ,;:-\u2014") + " \u2026"
        return pick
    return ""


class Unit:
    def __init__(self, title: str, body: list[str], kind: str, index: int):
        self.title = title
        self.body = body          # Zeilen OHNE die Ueberschriftszeile
        self.kind = kind          # "section" | "bullet"
        self.index = index
        self.slug = ""
        self.rel = ""             # Pfad relativ zu docs/agents/
        self.verbatim = False     # bleibt im Wegweiser


def parse(path: pathlib.Path):
    lines = path.read_text(encoding="utf-8").split("\n")
    fence = False
    heads = []
    for i, l in enumerate(lines):
        if l.startswith("```"):
            fence = not fence
        elif l.startswith("## ") and not fence:
            heads.append(i)
    first = heads[0] if heads else len(lines)
    preamble = lines[:first]
    blocks = []
    for k, i in enumerate(heads):
        end = heads[k + 1] if k + 1 < len(heads) else len(lines)
        blocks.append((lines[i][3:].strip(), lines[i + 1:end]))
    return preamble, blocks


def split_bullets(body: list[str]):
    """Top-Level-Aufzaehlungspunkte eines Sammel-Blocks als eigene Einheiten."""
    out, cur, head = [], None, []
    for l in body:
        if l.startswith("- "):
            if cur is not None:
                out.append(cur)
            cur = [l]
        elif cur is None:
            head.append(l)
        else:
            cur.append(l)
    if cur is not None:
        out.append(cur)
    return head, out


def bullet_title(chunk: list[str]) -> str:
    first = chunk[0][2:]
    m = re.match(r"\*\*(.+?)\*\*", first)
    raw = m.group(1) if m else first
    raw = strip_markup(raw)
    raw = re.split(r"(?<=[a-zäöüß0-9\)\"'»])[.:] (?=[A-ZÄÖÜ„(])", raw)[0]
    return raw[:120].rstrip(" ,;:-")


MARKER = "## Themen-Index (der ausgelagerte Bestand)"


def build(area, cap, verbatim_titles, dry: bool):
    src = ROOT / area[0]
    bereich = area[1]
    if MARKER in src.read_text(encoding="utf-8"):
        # Schutz gegen den zweiten Lauf: ein Wegweiser ist keine Quelle. Nach einem
        # Rebase zuerst `git checkout origin/main -- <datei>`, dann dieses Skript.
        print(f"{area[0]}: ist bereits ein Wegweiser - uebersprungen "
              f"(erst `git checkout origin/main -- {area[0]}`, dann erneut).")
        return None
    preamble, blocks = parse(src)
    units: list[Unit] = []
    taken: set[str] = set()

    pre_bytes = len("\n".join(preamble).encode())
    if pre_bytes > PREAMBLE_COLLECTION_BYTES:
        blocks.insert(0, (f"Notizen vor dem ersten Abschnitt ({src.name})", preamble[1:]))

    for n, (title, body) in enumerate(blocks, 1):
        u = Unit(title, body, "section", n)
        u.verbatim = any(title.startswith(v) for v in verbatim_titles)
        units.append(u)

    written = []
    for u in units:
        if u.verbatim:
            continue
        u.slug = slugify(u.title, taken)
        size = len(("## " + u.title + "\n" + "\n".join(u.body)).encode())
        if size > COLLECTION_BYTES:
            head, chunks = split_bullets(u.body)
            if len(chunks) >= 8:
                u.kind = "collection"
                u.rel = f"{bereich}/{u.slug}/README.md"
                sub_taken: set[str] = set()
                subs = []
                for i, ch in enumerate(chunks, 1):
                    t = bullet_title(ch)
                    s = slugify(t, sub_taken)
                    subs.append((f"{i:03d}-{s}", t, ch))
                u.subs = subs
                u.head = head
                written.append(u)
                continue
        u.rel = f"{bereich}/{u.slug}.md"
        written.append(u)

    out_root = ROOT / "docs" / "agents"
    files = 0
    body_bytes = 0
    if not dry:
        for u in written:
            if u.kind == "collection":
                d = out_root / bereich / u.slug
                d.mkdir(parents=True, exist_ok=True)
                idx = [
                    f"# {u.title}",
                    "",
                    f"Ausgelagert aus `{area[0]}` am {STAMP} (Abschnitt Nr. {u.index}).",
                    "Sammlung: je Aufzaehlungspunkt eine Datei, Text byte-verbatim.",
                    "",
                ]
                idx += [l for l in u.head if l.strip()]
                if any(l.strip() for l in u.head):
                    idx.append("")
                for name, t, ch in u.subs:
                    (d / f"{name}.md").write_text(
                        f"# {t}\n\nAusgelagert aus `{area[0]}` am {STAMP} "
                        f"(Abschnitt Nr. {u.index}, Punkt {name.split('-')[0]}).\n\n"
                        + "\n".join(ch)
                        + "\n",
                        encoding="utf-8",
                    )
                    files += 1
                    body_bytes += len("\n".join(ch).encode())
                    idx.append(f"- [{t}]({name}.md)")
                idx.append("")
                (d / "README.md").write_text("\n".join(idx), encoding="utf-8")
                files += 1
            else:
                p = out_root / u.rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(
                    f"# {u.title}\n\nAusgelagert aus `{area[0]}` am {STAMP} "
                    f"(Abschnitt Nr. {u.index}).\n\n" + "\n".join(u.body) + "\n",
                    encoding="utf-8",
                )
                files += 1
                body_bytes += len("\n".join(u.body).encode())

    # --- Wegweiser ---
    kern = (ROOT / "tools" / "agents-md-kern" / f"{bereich}.md").read_text(encoding="utf-8").rstrip("\n")
    up = "../" * (len(pathlib.Path(area[0]).parts) - 1)
    base = f"{up}docs/agents/{bereich}/"
    out = [kern, "", "## Themen-Index (der ausgelagerte Bestand)", "",
           "Jede Zeile ist ein frueherer Abschnitt DIESER Datei. Der Text ist unveraendert, er",
           f"wohnt nur woanders. **Alle Pfade unten sind relativ zu `{base}`.**",
           "**Nicht ganze Dateien in den Kontext lesen - greppen.** Inhaltsverzeichnis aller",
           "Bereiche: `" + up + "docs/agents/README.md`.", ""]
    for u in units:
        if u.verbatim:
            continue
        s = lead(u.title, u.body, cap)
        short = u.rel.split("/", 1)[1]
        line = f"- **{u.title}** — " + (f"{s} · " if s else "") + f"`{short}`"
        out.append(line)
    out.append("")
    tail = ROOT / "tools" / "agents-md-kern" / f"{bereich}-tail.md"
    if tail.is_file():
        out.append(tail.read_text(encoding="utf-8").rstrip("\n"))
        out.append("")
    for u in units:
        if u.verbatim:
            out += ["## " + u.title] + u.body
    text = "\n".join(out).rstrip("\n") + "\n"
    if not dry:
        src.write_text(text, encoding="utf-8")
    return {
        "area": area[0], "bereich": bereich, "units": len(units),
        "written": len(written), "files": files, "body_bytes": body_bytes,
        "new_bytes": len(text.encode()),
    }


def verify():
    """Beweist fuer JEDEN Abschnitt: Zieldatei ohne die 3 erzeugten Kopfzeilen == Original."""
    import subprocess

    bad = 0
    total = 0
    for area, bereich, cap, verb in AREAS:
        old = subprocess.run(
            ["git", "show", f"origin/main:{area}"], cwd=ROOT,
            capture_output=True, text=True, check=True).stdout
        lines = old.split("\n")
        fence = False
        heads = []
        for i, l in enumerate(lines):
            if l.startswith("```"):
                fence = not fence
            elif l.startswith("## ") and not fence:
                heads.append(i)
        first = heads[0] if heads else len(lines)
        blocks = []
        pre = lines[:first]
        if len("\n".join(pre).encode()) > PREAMBLE_COLLECTION_BYTES:
            blocks.append((f"Notizen vor dem ersten Abschnitt ({pathlib.Path(area).name})", pre[1:]))
        for k, i in enumerate(heads):
            end = heads[k + 1] if k + 1 < len(heads) else len(lines)
            blocks.append((lines[i][3:].strip(), lines[i + 1:end]))
        taken: set[str] = set()
        for title, body in blocks:
            if any(title.startswith(v) for v in verb):
                continue
            slug = slugify(title, taken)
            size = len(("## " + title + "\n" + "\n".join(body)).encode())
            d = ROOT / "docs" / "agents" / bereich / slug
            if size > COLLECTION_BYTES and d.is_dir():
                head, chunks = split_bullets(body)
                sub_taken: set[str] = set()
                for i, ch in enumerate(chunks, 1):
                    total += 1
                    name = f"{i:03d}-{slugify(bullet_title(ch), sub_taken)}.md"
                    got = (d / name).read_text(encoding="utf-8").split("\n", 4)[4]
                    if got.rstrip("\n") != "\n".join(ch).rstrip("\n"):
                        print("ABWEICHUNG:", bereich, slug, name)
                        bad += 1
            else:
                total += 1
                p = ROOT / "docs" / "agents" / bereich / f"{slug}.md"
                got = p.read_text(encoding="utf-8").split("\n", 4)[4]
                if got.rstrip("\n") != "\n".join(body).rstrip("\n"):
                    print("ABWEICHUNG:", bereich, slug)
                    bad += 1
    print(f"Verbatim-Pruefung: {total} Einheiten, {bad} Abweichungen")
    return 1 if bad else 0


def write_toc():
    lines = ["# `docs/agents/` — der ausgelagerte Bestand der drei AGENTS.md", "",
             "Hier wohnt der Detail-Text, der frueher in `AGENTS.md`, `frontend/portal/AGENTS.md`",
             "und `edge-app/AGENTS.md` stand. **Byte-verbatim ausgelagert am " + STAMP + ", nichts",
             "geloescht.** Die drei AGENTS.md sind seither Wegweiser mit einem Themen-Index.", "",
             "**Nicht ganze Dateien in den Kontext lesen — greppen.** Diese Sammlung ist die",
             "Projekt-Chronik; einzelne Dateien sind gross.", ""]
    for area, bereich, cap, verb in AREAS:
        d = ROOT / "docs" / "agents" / bereich
        if not d.is_dir():
            continue
        items = []
        for p in sorted(d.iterdir()):
            if p.is_dir():
                t = p.joinpath("README.md").read_text(encoding="utf-8").split("\n")[0][2:]
                items.append((t, f"{bereich}/{p.name}/README.md", len(list(p.glob('*.md'))) - 1))
            elif p.suffix == ".md":
                t = p.read_text(encoding="utf-8").split("\n")[0][2:]
                items.append((t, f"{bereich}/{p.name}", 0))
        lines.append(f"## `{bereich}/` — aus `{area}` ({len(items)} Einträge)")
        lines.append("")
        for t, rel, n in items:
            extra = f" *(Sammlung, {n} Punkte)*" if n else ""
            lines.append(f"- [{t}]({rel}){extra}")
        lines.append("")
    (ROOT / "docs" / "agents" / "README.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args()
    if a.verify:
        sys.exit(verify())
    done = 0
    for area in AREAS:
        before = len((ROOT / area[0]).read_bytes())
        r = build(area, area[2], area[3], a.dry_run)
        if r is None:
            continue
        done += 1
        print(f"{r['area']}: {before} -> {r['new_bytes']} B | {r['units']} Abschnitte, "
              f"{r['files']} Zieldateien, {r['body_bytes']} B ausgelagert")
    if not a.dry_run and done:
        write_toc()


if __name__ == "__main__":
    main()
