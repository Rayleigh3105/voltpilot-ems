"""Ein kleiner Interpreter fuer genau die Teilmenge von Structured Text (IEC 61131-3), die die
VoltPilot-Bibliothek benutzt - damit der Pruefer den Quelltext selbst gegen die Vertragsvektoren
laufen laesst und nicht eine Nachbildung davon.

Er ersetzt weder den Uebersetzer von CODESYS noch das Geraet: er kennt keine Typpruefung ueber
das hinaus, was beim Speichern ins Ziel faellt, keine Zeiger, keine Methoden, keine Aufgaben.
Was er pruefen soll, ist die Rechnung: welche Woerter der Baustein aus welchen Werten macht.
Zahlen rechnet er wie CODESYS beim Speichern: ein Ergebnis wird auf den Typ des Ziels
abgeschnitten (Zweierkomplement, kein Saettigen), Umwandlungen X_TO_Y behalten das Bitmuster.

Nur Standardbibliothek; Python 3.9 oder neuer.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- Lexer

KEYWORDS = {
    "TYPE", "END_TYPE", "STRUCT", "END_STRUCT", "ARRAY", "OF", "STRING",
    "FUNCTION", "END_FUNCTION", "FUNCTION_BLOCK", "END_FUNCTION_BLOCK", "PROGRAM", "END_PROGRAM",
    "VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_GLOBAL", "VAR_TEMP", "END_VAR", "CONSTANT",
    "IF", "THEN", "ELSIF", "ELSE", "END_IF", "FOR", "TO", "BY", "DO", "END_FOR", "RETURN",
    "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE",
}

_TOKEN = re.compile(r"""
    (?P<ws>\s+)
  | (?P<blockcomment>\(\*.*?\*\))
  | (?P<linecomment>//[^\n]*)
  | (?P<time>(?:T|TIME)\#[0-9A-Za-z_.]+)
  | (?P<typed>[A-Za-z_][A-Za-z0-9_]*\#[0-9A-Fa-f_]+(?:\#[0-9A-Fa-f_]+)?)
  | (?P<based>(?:2|8|16)\#[0-9A-Fa-f_]+)
  | (?P<number>[0-9][0-9_]*)
  | (?P<string>'(?:\$.|[^'$])*')
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<op>:=|=>|<>|<=|>=|\.\.|[-+*/=<>()\[\],;:.])
""", re.VERBOSE | re.DOTALL)


@dataclass
class Tok:
    kind: str
    text: str
    line: int
    pos: int = 0
    ende: int = 0


class StFehler(Exception):
    """Ein Fehler im Quelltext oder beim Ausfuehren - mit Zeile, wo bekannt."""


def _zeit_ms(text: str) -> int:
    rumpf = text.split("#", 1)[1].upper().replace("_", "")
    ms = 0
    for zahl, einheit in re.findall(r"([0-9.]+)(MS|D|H|M|S)", rumpf):
        faktor = {"D": 86400000, "H": 3600000, "M": 60000, "S": 1000, "MS": 1}[einheit]
        ms += int(float(zahl) * faktor)
    return ms


def lexer(text: str) -> list[Tok]:
    toks: list[Tok] = []
    pos, line = 0, 1
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise StFehler(f"Zeile {line}: unbekanntes Zeichen {text[pos]!r}")
        kind = m.lastgroup
        wert = m.group()
        if kind not in ("ws", "blockcomment", "linecomment"):
            if kind == "ident" and wert.upper() in KEYWORDS:
                kind, wert = "kw", wert.upper()
            toks.append(Tok(kind, wert, line, pos, m.end()))
        line += wert.count("\n") if kind != "kw" else 0
        pos = m.end()
    toks.append(Tok("eof", "", line, len(text), len(text)))
    return toks


def _zahl(text: str) -> int:
    text = text.replace("_", "")
    if "#" in text:
        basis, ziffern = text.split("#", 1)
        return int(ziffern, int(basis))
    return int(text)


def _string(text: str) -> bytes:
    rumpf = text[1:-1]
    out = bytearray()
    i = 0
    while i < len(rumpf):
        c = rumpf[i]
        if c == "$":
            n = rumpf[i + 1]
            if n in "$'":
                out += n.encode("latin-1")
                i += 2
                continue
            if n.upper() in "NLRT":
                out += {"N": b"\n", "L": b"\n", "R": b"\r", "T": b"\t"}[n.upper()]
                i += 2
                continue
            out.append(int(rumpf[i + 1:i + 3], 16))
            i += 3
            continue
        # ISO 8859-1 wie CODESYS STRING: ein Byte je Zeichen
        out += c.encode("latin-1")
        i += 1
    return bytes(out)


# ---------------------------------------------------------------- Typen

BREITE = {
    "BOOL": None, "BYTE": (8, False), "USINT": (8, False), "SINT": (8, True),
    "WORD": (16, False), "UINT": (16, False), "INT": (16, True),
    "DWORD": (32, False), "UDINT": (32, False), "DINT": (32, True), "TIME": (32, False),
}


@dataclass
class Typ:
    art: str                      # elem, string, array, struct, fb
    name: str = ""
    laenge: int = 80              # string
    lo: int = 0                   # array
    hi: int = 0
    element: "Typ | None" = None
    felder: list = field(default_factory=list)  # struct: [(name, Typ, init-Ausdruck)]
    quelltext: str = ""                         # wie der Typ im Quelltext steht (Strukturglied)


def schneide(typ: Typ, wert):
    """Ein Wert, gespeichert in einem Ziel dieses Typs (wie CODESYS: abschneiden, nicht saettigen)."""
    if typ.art == "elem":
        if typ.name == "BOOL":
            if not isinstance(wert, (bool, int)):
                raise StFehler(f"BOOL erwartet, nicht {wert!r}")
            return bool(wert)
        bits, vorzeichen = BREITE[typ.name]
        if isinstance(wert, bool):
            wert = int(wert)
        if not isinstance(wert, int):
            raise StFehler(f"{typ.name} erwartet, nicht {wert!r}")
        wert &= (1 << bits) - 1
        if vorzeichen and wert >= 1 << (bits - 1):
            wert -= 1 << bits
        return wert
    if typ.art == "string":
        if not isinstance(wert, (bytes, bytearray)):
            raise StFehler(f"STRING erwartet, nicht {wert!r}")
        wert = bytes(wert)
        if 0 in wert:
            wert = wert[: wert.index(0)]
        return wert[: typ.laenge]
    return wert


# ---------------------------------------------------------------- Parser

@dataclass
class Var:
    name: str
    typ: Typ
    init: object = None           # Ausdruck oder None
    klasse: str = "VAR"
    init_text: str = ""           # der Anfangswert, wie er im Quelltext steht
    typ_text: str = ""            # der Typ, wie er im Quelltext steht


@dataclass
class Pou:
    art: str                      # FUNCTION, FUNCTION_BLOCK, PROGRAM
    name: str
    rueck: Typ | None
    vars: list
    rumpf: list
    quelle: str
    rumpf_text: str = ""          # die Anweisungen, wie sie im Quelltext stehen
    doc: str = ""                 # der Kommentar vor der Deklaration


class Parser:
    def __init__(self, toks: list[Tok], quelle: str, text: str = ""):
        self.t = toks
        self.i = 0
        self.quelle = quelle
        self.text = text
        self.reihenfolge: list[tuple[str, str]] = []   # (art, name) in der Reihenfolge der Datei
        self.typ_docs: dict[str, str] = {}

    def doc_vor(self, tok: Tok) -> str:
        """Der Kommentar zwischen dem vorigen Token und tok - die Beschreibung einer Deklaration."""
        vorher = self.t[self.i - 1].ende if self.i > 0 else 0
        roh = self.text[vorher:tok.pos]
        teile = re.findall(r"\(\*(.*?)\*\)", roh, re.S)
        zeilen = []
        for teil in teile:
            for z in teil.splitlines():
                z = re.sub(r"^\s*\*\s?", "", z).rstrip()
                zeilen.append(z)
        return "\n".join(zeilen).strip("\n")

    def peek(self, k: int = 0) -> Tok:
        return self.t[self.i + k]

    def nimm(self, text: str | None = None, kind: str | None = None) -> Tok:
        tok = self.t[self.i]
        if text is not None and tok.text.upper() != text.upper():
            raise StFehler(f"{self.quelle} Zeile {tok.line}: {text!r} erwartet, nicht {tok.text!r}")
        if kind is not None and tok.kind != kind:
            raise StFehler(f"{self.quelle} Zeile {tok.line}: {kind} erwartet, nicht {tok.text!r}")
        self.i += 1
        return tok

    def ist(self, *texte: str) -> bool:
        return self.peek().text.upper() in {x.upper() for x in texte}

    def optional(self, text: str) -> bool:
        if self.ist(text):
            self.i += 1
            return True
        return False

    # --- Deklarationen
    def typ(self) -> Typ:
        if self.optional("STRING"):
            laenge = 80
            if self.optional("("):
                laenge = _zahl(self.nimm(kind="number").text)
                self.nimm(")")
            return Typ("string", "STRING", laenge=laenge)
        if self.optional("ARRAY"):
            self.nimm("[")
            lo = self.vorzeichenzahl()
            self.nimm("..")
            hi = self.vorzeichenzahl()
            self.nimm("]")
            self.nimm("OF")
            return Typ("array", lo=lo, hi=hi, element=self.typ())
        name = self.nimm(kind="ident").text
        if name.upper() in BREITE:
            return Typ("elem", name.upper())
        return Typ("ref", name)

    def vorzeichenzahl(self) -> int:
        neg = self.optional("-")
        n = _zahl(self.nimm().text)
        return -n if neg else n

    def varblock(self) -> list[Var]:
        klasse = self.nimm().text
        self.optional("CONSTANT")
        out = []
        while not self.ist("END_VAR"):
            namen = [self.nimm(kind="ident").text]
            while self.optional(","):
                namen.append(self.nimm(kind="ident").text)
            self.nimm(":")
            von = self.peek().pos
            typ = self.typ()
            typ_text = self.text[von:self.t[self.i - 1].ende]
            init, init_text = None, ""
            if self.optional(":="):
                von = self.peek().pos
                init = self.ausdruck()
                init_text = self.text[von:self.t[self.i - 1].ende]
            self.nimm(";")
            out += [Var(n, typ, init, klasse, init_text, typ_text) for n in namen]
        self.nimm("END_VAR")
        return out

    def datei(self):
        typen, pous, globale = {}, {}, []
        self.struct_inits: dict[str, dict[str, str]] = {}
        while self.peek().kind != "eof":
            if self.ist("TYPE"):
                doc = self.doc_vor(self.peek())
                self.nimm("TYPE")
                name = self.nimm(kind="ident").text
                self.typ_docs[name] = doc
                self.reihenfolge.append(("TYPE", name))
                self.nimm(":")
                if self.optional("STRUCT"):
                    felder = []
                    while not self.ist("END_STRUCT"):
                        namen = [self.nimm(kind="ident").text]
                        while self.optional(","):
                            namen.append(self.nimm(kind="ident").text)
                        self.nimm(":")
                        von = self.peek().pos
                        t = self.typ()
                        t.quelltext = self.text[von:self.t[self.i - 1].ende]
                        init, init_text = None, ""
                        if self.optional(":="):
                            von = self.peek().pos
                            init = self.ausdruck()
                            init_text = self.text[von:self.t[self.i - 1].ende]
                        self.nimm(";")
                        felder += [(n, t, init) for n in namen]
                        for n in namen:
                            self.struct_inits.setdefault(name, {})[n] = init_text
                    self.nimm("END_STRUCT")
                    self.optional(";")
                    typen[name] = Typ("struct", name, felder=felder)
                else:
                    typen[name] = self.typ()
                    self.optional(";")
                self.nimm("END_TYPE")
            elif self.ist("VAR_GLOBAL"):
                globale += self.varblock()
            elif self.ist("FUNCTION", "FUNCTION_BLOCK", "PROGRAM"):
                doc = self.doc_vor(self.peek())
                art = self.nimm().text
                name = self.nimm(kind="ident").text
                self.reihenfolge.append((art, name))
                rueck = None
                if art == "FUNCTION":
                    self.nimm(":")
                    rueck = self.typ()
                vs = []
                while self.ist("VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP"):
                    vs += self.varblock()
                von = self.t[self.i - 1].ende
                rumpf = self.anweisungen({"END_" + art})
                rumpf_text = self.text[von:self.peek().pos].strip("\n")
                self.nimm("END_" + art)
                pous[name] = Pou(art, name, rueck, vs, rumpf, self.quelle, rumpf_text, doc)
            else:
                tok = self.peek()
                raise StFehler(f"{self.quelle} Zeile {tok.line}: unerwartet {tok.text!r}")
        return typen, pous, globale

    # --- Anweisungen
    def anweisungen(self, ende: set[str]) -> list:
        out = []
        while not self.ist(*ende):
            out.append(self.anweisung())
        return out

    def anweisung(self):
        tok = self.peek()
        if self.optional("IF"):
            zweige = []
            bed = self.ausdruck()
            self.nimm("THEN")
            zweige.append((bed, self.anweisungen({"ELSIF", "ELSE", "END_IF"})))
            sonst = []
            while self.optional("ELSIF"):
                bed = self.ausdruck()
                self.nimm("THEN")
                zweige.append((bed, self.anweisungen({"ELSIF", "ELSE", "END_IF"})))
            if self.optional("ELSE"):
                sonst = self.anweisungen({"END_IF"})
            self.nimm("END_IF")
            self.optional(";")
            return ("if", zweige, sonst, tok.line)
        if self.optional("FOR"):
            var = self.nimm(kind="ident").text
            self.nimm(":=")
            von = self.ausdruck()
            self.nimm("TO")
            bis = self.ausdruck()
            schritt = self.ausdruck() if self.optional("BY") else ("zahl", 1)
            self.nimm("DO")
            rumpf = self.anweisungen({"END_FOR"})
            self.nimm("END_FOR")
            self.optional(";")
            return ("for", var, von, bis, schritt, rumpf, tok.line)
        if self.optional("RETURN"):
            self.nimm(";")
            return ("return", tok.line)
        ziel = self.postfix()
        if self.optional(":="):
            wert = self.ausdruck()
            self.nimm(";")
            return ("zuweisung", ziel, wert, tok.line)
        self.nimm(";")
        if ziel[0] != "aufruf":
            raise StFehler(f"{self.quelle} Zeile {tok.line}: Anweisung ohne Wirkung")
        return ("ausdruck", ziel, tok.line)

    # --- Ausdruecke (Vorrang nach IEC 61131-3)
    def ausdruck(self):
        return self.binaer(0)

    STUFEN = [("OR",), ("XOR",), ("AND",), ("=", "<>"), ("<", ">", "<=", ">="), ("+", "-"), ("*", "/", "MOD")]

    def binaer(self, stufe: int):
        if stufe == len(self.STUFEN):
            return self.unaer()
        links = self.binaer(stufe + 1)
        while self.ist(*self.STUFEN[stufe]):
            op = self.nimm().text.upper()
            links = ("bin", op, links, self.binaer(stufe + 1))
        return links

    def unaer(self):
        if self.optional("NOT"):
            return ("not", self.unaer())
        if self.optional("-"):
            return ("neg", self.unaer())
        return self.postfix()

    def postfix(self):
        tok = self.nimm()
        if tok.kind == "number" or tok.kind == "based":
            knoten = ("zahl", _zahl(tok.text))
        elif tok.kind == "typed":
            typ, rest = tok.text.split("#", 1)
            knoten = ("zahl", _zahl(rest) if "#" in rest else _zahl(rest))
            if typ.upper() not in BREITE:
                raise StFehler(f"{self.quelle} Zeile {tok.line}: unbekannter Typ {typ}")
        elif tok.kind == "time":
            knoten = ("zahl", _zeit_ms(tok.text))
        elif tok.kind == "string":
            knoten = ("text", _string(tok.text))
        elif tok.text in ("TRUE", "FALSE"):
            knoten = ("bool", tok.text == "TRUE")
        elif tok.text == "(":
            knoten = self.ausdruck()
            self.nimm(")")
        elif tok.kind == "ident":
            knoten = ("name", tok.text)
        else:
            raise StFehler(f"{self.quelle} Zeile {tok.line}: unerwartet {tok.text!r}")
        while True:
            if self.optional("."):
                knoten = ("feld", knoten, self.nimm(kind="ident").text)
            elif self.optional("["):
                index = self.ausdruck()
                self.nimm("]")
                knoten = ("index", knoten, index)
            elif self.ist("(") and knoten[0] in ("name", "feld"):
                self.nimm("(")
                args = []
                while not self.ist(")"):
                    if self.peek().kind == "ident" and self.peek(1).text == ":=":
                        name = self.nimm().text
                        self.nimm(":=")
                        args.append((name, self.ausdruck()))
                    else:
                        args.append((None, self.ausdruck()))
                    if not self.optional(","):
                        break
                self.nimm(")")
                knoten = ("aufruf", knoten, args, tok.line)
            else:
                return knoten


# ---------------------------------------------------------------- Laufzeit

class Ruecksprung(Exception):
    pass


class FbInstanz:
    def __init__(self, pou: Pou, werte: dict):
        self.pou = pou
        self.werte = werte


class Feld:
    """Ein Array mit seiner Untergrenze; Zugriffe ausserhalb sind ein Fehler (CODESYS schriebe fremden Speicher)."""

    def __init__(self, typ: Typ, werte: list):
        self.typ = typ
        self.werte = werte

    def stelle(self, index: int) -> int:
        if not (self.typ.lo <= index <= self.typ.hi):
            raise StFehler(f"Index {index} ausserhalb [{self.typ.lo}..{self.typ.hi}]")
        return index - self.typ.lo


class Projekt:
    """Bibliothek, globale Variablen und Programme - geladen aus .st-Dateien."""

    def __init__(self):
        self.typen: dict[str, Typ] = {}
        self.pous: dict[str, Pou] = {}
        self.globale: dict[str, dict] = {}   # Name der Liste -> Variablen
        self.global_typen: dict[str, dict] = {}
        self.uhr_ms = 0
        self.instanzen: dict[str, FbInstanz] = {}
        self.dateien: list = []   # (Pfad, Parser, Typen, POUs, Globale) je geladener Datei

    def lade(self, pfad: Path):
        text = pfad.read_text(encoding="utf-8")
        parser = Parser(lexer(text), pfad.name, text)
        typen, pous, globale = parser.datei()
        self.dateien.append((pfad, parser, typen, pous, globale))
        self.typen.update(typen)
        self.pous.update(pous)
        if globale:
            liste = pfad.stem
            self.global_typen[liste] = {v.name: v.typ for v in globale}
            self.globale[liste] = {v.name: self.anfang(v.typ, v.init, {}) for v in globale}

    # --- Typen und Anfangswerte
    def aufloesen(self, typ: Typ) -> Typ:
        while typ.art == "ref":
            if typ.name in self.typen:
                typ = self.typen[typ.name]
            elif typ.name in self.pous and self.pous[typ.name].art == "FUNCTION_BLOCK":
                return Typ("fb", typ.name)
            else:
                raise StFehler(f"unbekannter Typ {typ.name}")
        if typ.art == "array":
            return Typ("array", lo=typ.lo, hi=typ.hi, element=self.aufloesen(typ.element))
        return typ

    def anfang(self, typ: Typ, init, env: dict):
        typ = self.aufloesen(typ)
        if init is not None:
            return schneide(typ, self.wert(init, env))
        if typ.art == "elem":
            return False if typ.name == "BOOL" else 0
        if typ.art == "string":
            return b""
        if typ.art == "array":
            return Feld(typ, [self.anfang(typ.element, None, env) for _ in range(typ.hi - typ.lo + 1)])
        if typ.art == "struct":
            return {n: self.anfang(t, i, env) for n, t, i in typ.felder}
        if typ.art == "fb":
            return self.neue_instanz(self.pous[typ.name])
        raise StFehler(f"kein Anfangswert fuer {typ}")

    def neue_instanz(self, pou: Pou) -> FbInstanz:
        werte = {}
        for v in pou.vars:
            werte[v.name] = None if v.klasse == "VAR_IN_OUT" else self.anfang(v.typ, v.init, werte)
        return FbInstanz(pou, werte)

    def typ_von(self, pou: Pou, name: str) -> Typ | None:
        if pou.art == "FUNCTION" and name == pou.name:
            return self.aufloesen(pou.rueck)
        for v in pou.vars:
            if v.name == name:
                return self.aufloesen(v.typ)
        return None

    # --- Ausfuehren
    def programm(self, name: str) -> FbInstanz:
        if name not in self.instanzen:
            self.instanzen[name] = self.neue_instanz(self.pous[name])
        return self.instanzen[name]

    def zyklus(self, programm: str = "PLC_PRG"):
        inst = self.programm(programm)
        self.lauf(inst.pou, inst.werte)

    def lauf(self, pou: Pou, env: dict):
        try:
            self.block(pou.rumpf, pou, env)
        except Ruecksprung:
            pass

    def block(self, anweisungen: list, pou: Pou, env: dict):
        for a in anweisungen:
            try:
                self.anweisung(a, pou, env)
            except StFehler as e:
                if "Zeile" in str(e):
                    raise
                raise StFehler(f"{pou.quelle} Zeile {a[-1]}: {e}") from None

    def anweisung(self, a, pou: Pou, env: dict):
        art = a[0]
        if art == "zuweisung":
            self.speichere(a[1], self.wert(a[2], env, pou), env, pou)
        elif art == "ausdruck":
            self.wert(a[1], env, pou)
        elif art == "if":
            for bed, rumpf in a[1]:
                if self.wahr(self.wert(bed, env, pou)):
                    self.block(rumpf, pou, env)
                    return
            self.block(a[2], pou, env)
        elif art == "for":
            _, var, von, bis, schritt, rumpf, _ = a
            typ = self.typ_von(pou, var)
            i = self.wert(von, env, pou)
            ende = self.wert(bis, env, pou)
            s = self.wert(schritt, env, pou)
            env[var] = schneide(typ, i)
            while (env[var] <= ende) if s > 0 else (env[var] >= ende):
                self.block(rumpf, pou, env)
                env[var] = schneide(typ, env[var] + s)
        elif art == "return":
            raise Ruecksprung()

    @staticmethod
    def wahr(w) -> bool:
        if not isinstance(w, bool):
            raise StFehler(f"Bedingung ist kein BOOL: {w!r}")
        return w

    # --- Orte (L-Werte)
    def ort(self, knoten, env: dict, pou: Pou):
        """(Behaelter, Schluessel, Typ) eines Ziels."""
        art = knoten[0]
        if art == "name":
            name = knoten[1]
            if name in env:
                return env, name, self.typ_von(pou, name)
            for liste, werte in self.globale.items():
                if name in werte:
                    return werte, name, self.aufloesen(self.global_typen[liste][name])
            raise StFehler(f"unbekannter Name {name}")
        if art == "feld":
            if knoten[1][0] == "name" and knoten[1][1] in self.globale:
                liste = knoten[1][1]
                return self.globale[liste], knoten[2], self.aufloesen(self.global_typen[liste][knoten[2]])
            beh, schl, typ = self.ort(knoten[1], env, pou)
            obj = beh[schl] if not isinstance(beh, Feld) else beh.werte[schl]
            if typ.art == "struct":
                for n, t, _ in typ.felder:
                    if n == knoten[2]:
                        return obj, n, self.aufloesen(t)
            if typ.art == "fb":
                return obj.werte, knoten[2], self.typ_von(obj.pou, knoten[2])
            raise StFehler(f"kein Feld {knoten[2]}")
        if art == "index":
            beh, schl, typ = self.ort(knoten[1], env, pou)
            obj = beh[schl] if not isinstance(beh, Feld) else beh.werte[schl]
            index = self.wert(knoten[2], env, pou)
            if isinstance(obj, Feld):
                return obj, obj.stelle(index), obj.typ.element
            raise StFehler("Index auf etwas, das kein Feld ist")
        raise StFehler(f"kein Ziel: {art}")

    def speichere(self, ziel, wert, env: dict, pou: Pou):
        beh, schl, typ = self.ort(ziel, env, pou)
        if isinstance(wert, (Feld, dict)):
            wert = copy.deepcopy(wert)
        neu = schneide(typ, wert) if typ is not None else wert
        if isinstance(beh, Feld):
            beh.werte[schl] = neu
        else:
            beh[schl] = neu

    # --- Werte
    def wert(self, knoten, env: dict, pou: Pou | None = None):
        art = knoten[0]
        if art == "zahl":
            return knoten[1]
        if art == "bool":
            return knoten[1]
        if art == "text":
            return knoten[1]
        if art in ("name", "feld"):
            beh, schl, _ = self.ort(knoten, env, pou)
            return beh[schl] if not isinstance(beh, Feld) else beh.werte[schl]
        if art == "index":
            basis = self.wert(knoten[1], env, pou)
            index = self.wert(knoten[2], env, pou)
            if isinstance(basis, (bytes, bytearray)):
                # Zeichen einer Zeichenkette als BYTE, ab 0 gezaehlt
                return basis[index] if 0 <= index < len(basis) else 0
            beh, schl, _ = self.ort(knoten, env, pou)
            return beh.werte[schl]
        if art == "not":
            return not self.wahr(self.wert(knoten[1], env, pou))
        if art == "neg":
            return -self.wert(knoten[1], env, pou)
        if art == "bin":
            return self.binaer(knoten[1], self.wert(knoten[2], env, pou), self.wert(knoten[3], env, pou))
        if art == "aufruf":
            return self.aufruf(knoten, env, pou)
        raise StFehler(f"unbekannter Ausdruck {art}")

    @staticmethod
    def binaer(op: str, a, b):
        if op in ("AND", "OR", "XOR"):
            if isinstance(a, bool) and isinstance(b, bool):
                return {"AND": a and b, "OR": a or b, "XOR": a != b}[op]
            if isinstance(a, bool) or isinstance(b, bool):
                raise StFehler(f"{op} mischt BOOL und Zahl")
            return {"AND": a & b, "OR": a | b, "XOR": a ^ b}[op]
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            if b == 0:
                raise StFehler("Division durch 0")
            q = abs(a) // abs(b)
            return q if (a >= 0) == (b >= 0) else -q
        if op == "MOD":
            return a - b * int(a / b)
        return {"=": a == b, "<>": a != b, "<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b}[op]

    def aufruf(self, knoten, env: dict, pou: Pou):
        _, wer, args, zeile = knoten
        if wer[0] == "name" and wer[1] not in env and wer[1] in self.pous:
            return self.funktion(self.pous[wer[1]], args, env, pou)
        if wer[0] == "name":
            eingebaut = self.eingebaut(wer[1], args, env, pou)
            if eingebaut is not None:
                return eingebaut[0]
        # Aufruf einer FB-Instanz
        inst = self.wert(wer, env, pou)
        if not isinstance(inst, FbInstanz):
            raise StFehler(f"Zeile {zeile}: {wer} ist nicht aufrufbar")
        self.parameter(inst.pou, inst.werte, args, env, pou)
        self.lauf(inst.pou, inst.werte)
        return None

    def parameter(self, ziel: Pou, zenv: dict, args: list, env: dict, pou: Pou):
        eingaenge = [v for v in ziel.vars if v.klasse in ("VAR_INPUT", "VAR_IN_OUT")]
        for k, (name, ausdruck) in enumerate(args):
            v = next((x for x in eingaenge if x.name == name), None) if name else eingaenge[k]
            if v is None:
                raise StFehler(f"{ziel.name} hat keinen Eingang {name}")
            if v.klasse == "VAR_IN_OUT":
                # Ein Durchgangsparameter ist ein Verweis: das Feld selbst, keine Kopie
                zenv[v.name] = self.wert(ausdruck, env, pou)
            else:
                w = self.wert(ausdruck, env, pou)
                if isinstance(w, (Feld, dict)):
                    w = copy.deepcopy(w)
                zenv[v.name] = schneide(self.aufloesen(v.typ), w)

    def funktion(self, f: Pou, args: list, env: dict, pou: Pou):
        fenv = {}
        for v in f.vars:
            fenv[v.name] = None if v.klasse == "VAR_IN_OUT" else self.anfang(v.typ, v.init, fenv)
        fenv[f.name] = self.anfang(f.rueck, None, fenv)
        self.parameter(f, fenv, args, env, pou)
        self.lauf(f, fenv)
        return fenv[f.name]

    UMWANDLUNG = re.compile(r"^([A-Z]+)_TO_([A-Z]+)$")

    def eingebaut(self, name: str, args: list, env: dict, pou: Pou):
        werte = lambda: [self.wert(a, env, pou) for _, a in args]  # noqa: E731
        n = name.upper()
        m = self.UMWANDLUNG.match(n)
        if m and m.group(2) in BREITE:
            (w,) = werte()
            if isinstance(w, bool):
                w = int(w)
            return (schneide(Typ("elem", m.group(2)), w),)
        if n == "SHL":
            a, b = werte()
            return (a << b,)
        if n == "SHR":
            a, b = werte()
            return (a >> b,)
        if n == "LEN":
            (s,) = werte()
            return (len(s),)
        if n == "SEL":
            g, a, b = werte()
            return (b if self.wahr(g) else a,)
        if n == "TIME" and not args:
            return (self.uhr_ms & 0xFFFFFFFF,)
        return None
