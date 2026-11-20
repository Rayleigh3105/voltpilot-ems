"""PLCopen XML (TC6 0201) aus den .st-Quellen - fuer den Import in CODESYS V3.5
(Projekt > PLCopenXML importieren), damit niemand Deklaration und Rumpf von Hand kopiert.

    python3 sps/codesys/pruefer/plcopen.py            # sps/codesys/plcopen/*.xml neu schreiben
    python3 sps/codesys/pruefer/plcopen.py --pruefe   # Exit 1, wenn eine Datei veraltet ist

Die Dateien sind ERZEUGT und werden nicht von Hand geaendert. Ob CODESYS sie ohne Rueckfrage
annimmt, zeigt erst der Import in der IDE (sps/codesys/README.md, "Was nur in der IDE geht").
"""

from __future__ import annotations

import sys
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

HIER = Path(__file__).resolve().parent
sys.path.insert(0, str(HIER))

import st  # noqa: E402

CODESYS = HIER.parent
AUSGABE = CODESYS / "plcopen"
STAND = "2026-11-20T00:00:00"
XHTML = "http://www.w3.org/1999/xhtml"

BIBLIOTHEK = sorted((CODESYS / "bibliothek").glob("*.st"))
GVL = CODESYS / "grundprogramm" / "GVL_VoltPilot.st"

VORLAGEN = CODESYS / "vorlagen"

DATEIEN = {
    "VoltPilot_Bibliothek.xml": ("VoltPilot-Bibliothek Erzeuger-Bild, Koppelbild und WAGO-Bild", BIBLIOTHEK),
    "VoltPilot_Grundprogramm.xml": ("VoltPilot-Grundprogramm", BIBLIOTHEK + [GVL, CODESYS / "grundprogramm" / "PLC_PRG.st"]),
    "VoltPilot_Probeprojekt.xml": ("VoltPilot-Probeprojekt", BIBLIOTHEK + [GVL, CODESYS / "probeprojekt" / "PLC_PRG.st"]),
    "VoltPilot_Vorlage_PV.xml": ("VoltPilot-Vorlage PV", BIBLIOTHEK + [GVL, VORLAGEN / "pv" / "PLC_PRG.st"]),
    "VoltPilot_Vorlage_BHKW.xml": ("VoltPilot-Vorlage BHKW", BIBLIOTHEK + [GVL, VORLAGEN / "bhkw" / "PLC_PRG.st"]),
}

ELEMENTAR = {"BOOL", "BYTE", "WORD", "DWORD", "SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "TIME"}


def typ_xml(t: st.Typ) -> str:
    if t.art == "elem":
        return f"<{t.name}/>"
    if t.art == "string":
        return f'<string length="{t.laenge}"/>'
    if t.art == "array":
        return (f'<array><dimension lower="{t.lo}" upper="{t.hi}"/>'
                f"<baseType>{typ_xml(t.element)}</baseType></array>")
    return f"<derived name={quoteattr(t.name)}/>"


def variable(name: str, t: st.Typ, init_text: str, einzug: str) -> str:
    out = f"{einzug}<variable name={quoteattr(name)}><type>{typ_xml(t)}</type>"
    if init_text:
        out += f"<initialValue><simpleValue value={quoteattr(init_text.strip())}/></initialValue>"
    return out + "</variable>\n"


def doku(text: str, einzug: str) -> str:
    if not text:
        return ""
    return (f'{einzug}<documentation><xhtml xmlns="{XHTML}">{escape(text)}</xhtml></documentation>\n')


def pou_xml(pou: st.Pou) -> str:
    art = {"FUNCTION": "function", "FUNCTION_BLOCK": "functionBlock", "PROGRAM": "program"}[pou.art]
    out = f'        <pou name={quoteattr(pou.name)} pouType="{art}">\n          <interface>\n'
    if pou.rueck is not None:
        out += f"            <returnType>{typ_xml(pou.rueck)}</returnType>\n"
    for klasse, tag in (("VAR_INPUT", "inputVars"), ("VAR_OUTPUT", "outputVars"), ("VAR_IN_OUT", "inOutVars"),
                        ("VAR", "localVars"), ("VAR_TEMP", "tempVars")):
        vs = [v for v in pou.vars if v.klasse == klasse]
        if vs:
            out += f"            <{tag}>\n"
            out += "".join(variable(v.name, v.typ, v.init_text, "              ") for v in vs)
            out += f"            </{tag}>\n"
    out += "          </interface>\n"
    out += (f'          <body><ST><xhtml xmlns="{XHTML}">{escape(pou.rumpf_text)}\n</xhtml></ST></body>\n')
    out += doku(pou.doc, "          ")
    return out + "        </pou>\n"


def datei(titel: str, quellen: list[Path]) -> str:
    projekt = st.Projekt()
    for q in quellen:
        projekt.lade(q)
    typen, pous, globale = [], [], []
    for _pfad, parser, ftypen, fpous, fglobale in projekt.dateien:
        for art, name in parser.reihenfolge:
            if art == "TYPE":
                typen.append((name, ftypen[name], parser.typ_docs.get(name, ""), parser.struct_inits.get(name, {})))
            else:
                pous.append(fpous[name])
        if fglobale:
            globale.append((_pfad.stem, fglobale))
    out = ['<?xml version="1.0" encoding="utf-8"?>\n',
           '<project xmlns="http://www.plcopen.org/xml/tc6_0201">\n',
           f'  <fileHeader companyName="VoltPilot" productName="VoltPilot EMS" productVersion="1.0" '
           f'creationDateTime="{STAND}"/>\n',
           f"  <contentHeader name={quoteattr(titel)}>\n",
           '    <coordinateInfo><fbd><scaling x="1" y="1"/></fbd><ld><scaling x="1" y="1"/></ld>'
           '<sfc><scaling x="1" y="1"/></sfc></coordinateInfo>\n',
           "  </contentHeader>\n  <types>\n    <dataTypes>\n"]
    for name, t, doc, inits in typen:
        out.append(f"      <dataType name={quoteattr(name)}>\n        <baseType>")
        if t.art == "struct":
            out.append("<struct>\n")
            for fname, ftyp, _ in t.felder:
                out.append(variable(fname, ftyp, inits.get(fname, ""), "          "))
            out.append("        </struct>")
        else:
            out.append(typ_xml(t))
        out.append("</baseType>\n")
        out.append(doku(doc, "        "))
        out.append("      </dataType>\n")
    out.append("    </dataTypes>\n    <pous>\n")
    out += [pou_xml(p) for p in pous]
    out.append("    </pous>\n  </types>\n  <instances>\n    <configurations/>\n  </instances>\n")
    if globale:
        out.append('  <addData>\n    <data name="http://www.3s-software.com/plcopenxml/globalvars" '
                   'handleUnknown="implementation">\n')
        for liste, vs in globale:
            out.append(f"      <globalVars name={quoteattr(liste)}>\n")
            out += [variable(v.name, v.typ, v.init_text, "        ") for v in vs]
            out.append("      </globalVars>\n")
        out.append("    </data>\n  </addData>\n")
    out.append("</project>\n")
    return "".join(out)


def alle() -> dict[str, str]:
    return {name: datei(titel, quellen) for name, (titel, quellen) in DATEIEN.items()}


def main(argv: list[str]) -> int:
    veraltet = []
    for name, text in alle().items():
        ziel = AUSGABE / name
        if "--pruefe" in argv:
            if not ziel.exists() or ziel.read_text(encoding="utf-8") != text:
                veraltet.append(name)
        else:
            AUSGABE.mkdir(exist_ok=True)
            ziel.write_text(text, encoding="utf-8")
    if veraltet:
        print("veraltet (plcopen.py ausfuehren und committen):", ", ".join(veraltet))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
