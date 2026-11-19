"""Das Erzeuger-Registerbild aus Sicht des Vertrags, gelesen aus der Vektor-Datei selbst.

Zwei Richtungen, beide nur aus der Feldtabelle von erzeuger-registerbild-vectors.json:

- lies(woerter): ein Leser nach Vertrag §7 - Kopf, je Feld Wert oder Grund (gueltigkeit, ungueltig,
  fremd), je Einheit dasselbe, die Namen. Dieselbe Form wie die Erwartung der Vektor-Faelle.
- eingaenge(woerter, namen): die getippten Eingaenge von FB_VP_ErzeugerBild, mit denen ein
  Programm genau diese Woerter erzeugen soll.

Er ist ein vierter, unabhaengiger Leser neben Palette, Go-Zwilling und Portal-Test: der Pruefer
vergleicht die Woerter des SPS-Bausteins mit den Woertern der Vektoren UND liest sie wie der
Vertrag.
"""

from __future__ import annotations

import json
from pathlib import Path

WURZEL = Path(__file__).resolve().parents[3]
VEKTOREN = WURZEL / "docs" / "contracts" / "v2" / "erzeuger-registerbild-vectors.json"

UNGUELTIG = {"U16": 0xFFFF, "S16": 0x7FFF, "U32": 0xFFFFFFFF, "S32": 0x7FFFFFFF}


def lade_vektoren() -> dict:
    return json.loads(VEKTOREN.read_text(encoding="utf-8"))


V = lade_vektoren()
FELDER = {f["feld"]: f for f in V["felder"]}
FESTER_TEIL = V["einheit"]["basis"]
EINHEIT_LAENGE = V["einheit"]["laenge"]
NAMEN_AB = V["namen"]["vorgabe_ab"]


def roh(woerter: list[int], adresse: int, typ: str) -> int:
    if typ in ("U32", "S32"):
        return (woerter[adresse] << 16) | woerter[adresse + 1]
    return woerter[adresse]


def mit_vorzeichen(r: int, typ: str) -> int:
    if typ == "S16" and r >= 0x8000:
        return r - 0x10000
    if typ == "S32" and r >= 0x80000000:
        return r - 0x100000000
    return r


def bit_von(feld: dict, name: str) -> int:
    return next(b["bit"] for b in feld["bits"] if b["name"] == name)


def name_aus(woerter: list[int], start: int) -> str | None:
    text = bytearray()
    for w in woerter[start:start + 16]:
        for b in (w >> 8, w & 0xFF):
            if b == 0:
                return text.decode("latin-1") or None
            text.append(b)
    return text.decode("latin-1") or None


def felder_anlage():
    return [f for f in V["felder"] if f["abschnitt"] not in ("K", "T")]


def felder_einheit():
    return [f for f in V["felder"] if f["abschnitt"] == "T"]


def _deute(f: dict, woerter: list[int], basis: int):
    """(wert, grund) eines Felds nach Vertrag §7."""
    adresse = basis + f["adresse"] - (FESTER_TEIL if f["abschnitt"] == "T" else 0)
    r = roh(woerter, adresse, f["typ"])
    deckung = f.get("gedeckt_von")
    if deckung:
        dfeld = FELDER[deckung["feld"]]
        dadr = basis + dfeld["adresse"] - (FESTER_TEIL if dfeld["abschnitt"] == "T" else 0)
        bits = roh(woerter, dadr, dfeld["typ"])
        if bits == UNGUELTIG[dfeld["typ"]] or not bits & (1 << bit_von(dfeld, deckung["bit"])):
            return None, "gueltigkeit"
    if f["ungueltig"] is not None and r == f["ungueltig"]:
        return None, "ungueltig"
    zahl = mit_vorzeichen(r, f["typ"])
    if "vokabular" in f and zahl not in [c["code"] for c in f["vokabular"]]:
        return None, "fremd"
    return zahl, None


def lies(woerter: list[int]) -> dict:
    """Ein Bild lesen wie der Vertrag: Kopf in der Pruefreihenfolge §7, dann jeden Wert."""
    if len(woerter) < 12:
        return {"ergebnis": "nicht_lesbar", "grund": "zu_wenig_woerter"}
    if woerter[0] != 0x5650 or woerter[1] != 0x455A:
        return {"ergebnis": "nicht_lesbar", "grund": "signatur_fremd"}
    if woerter[4] >> 8 != 1:
        return {"ergebnis": "nicht_lesbar", "grund": "version_fremd"}
    if roh(woerter, 2, "U32") != 0x01020304:
        return {"ergebnis": "nicht_lesbar", "grund": "wortfolge_falsch"}
    kopf = {
        "version_haupt": woerter[4] >> 8, "version_neben": woerter[4] & 0xFF,
        "te_anzahl": woerter[5], "herzschlag": woerter[6],
        "programmstand": None if woerter[7] == 0xFFFF else woerter[7],
        "steuerung_id": None if roh(woerter, 8, "U32") == 0xFFFFFFFF else roh(woerter, 8, "U32"),
        "anlagenart": woerter[10] if woerter[10] in (1, 2, 3) else None,
        "beschreibung_ab": woerter[11],
    }
    if not 1 <= kopf["te_anzahl"] <= 10:
        return {"ergebnis": "nicht_lesbar", "grund": "te_anzahl_ungueltig", "kopf": kopf}
    if len(woerter) < FESTER_TEIL + EINHEIT_LAENGE * kopf["te_anzahl"]:
        return {"ergebnis": "nicht_lesbar", "grund": "zu_wenig_woerter", "kopf": kopf}
    werte, leer = {}, {}
    for f in felder_anlage():
        w, g = _deute(f, woerter, 0)
        werte[f["feld"]] = w
        if g:
            leer[f["feld"]] = g
    for name in ("programmstand", "steuerung_id", "anlagenart"):
        w, g = _deute(FELDER[name], woerter, 0)
        if g:
            leer[name] = g
    einheiten = []
    for n in range(1, kopf["te_anzahl"] + 1):
        basis = FESTER_TEIL + (n - 1) * EINHEIT_LAENGE
        ew, el = {}, {}
        for f in felder_einheit():
            w, g = _deute(f, woerter, basis)
            ew[f["feld"]] = w
            if g:
                el[f["feld"]] = g
        einheiten.append({"n": n, "adresse": basis, "werte": ew, "leer": el})
    return {"ergebnis": "lesbar", "grund": None, "kopf": kopf, "werte": werte, "leer": leer,
            "einheiten": einheiten}


def namen(woerter: list[int], kopf: dict) -> dict:
    """Die Namen nach Vertrag §6 aus einem Bild, das ab Adresse 0 bis hinter die Namen reicht."""
    ab, te = kopf["beschreibung_ab"], kopf["te_anzahl"]
    if ab in (0, 0xFFFF):
        return {"ergebnis": "keine_namen"}
    if ab < FESTER_TEIL + EINHEIT_LAENGE * te or ab + 32 + 16 * te > 65536:
        return {"ergebnis": "bereich_ungueltig"}
    return {"ergebnis": "gelesen", "netzbetreiber_name": name_aus(woerter, ab),
            "direktvermarkter_name": name_aus(woerter, ab + 16),
            "t_typ_name": [name_aus(woerter, ab + 32 + 16 * (n - 1)) for n in range(1, te + 1)]}


# ---------------------------------------------------------------- Eingaenge des Bausteins

# Feld des Vertrags -> (Struktur, Glied fuer den Wert, Glied fuer "bekannt" oder None)
WERTE = {
    "a_alter_s": ("stAnlage", "uiAlterS", "xAlterBekannt"),
    "p_nvp_w": ("stAnlage", "diPNetzpunktW", None),
    "p_erzeugung_w": ("stAnlage", "diPErzeugungW", None),
    "anlage_zustand": ("stAnlage", "uiZustand", "xZustandBekannt"),
    "speicher_fuellstand": ("stAnlage", "uiSpeicherZehntelProzent", None),
    "p_installiert_kw": ("stAnlage", "uiInstalliertKw", "xInstalliertBekannt"),
    "n_kanal": ("stNetzbetreiber", "uiKanal", "xKanalBekannt"),
    "n_p_prozent": ("stNetzbetreiber", "uiPZehntelProzent", "xPBekannt"),
    "n_cosphi": ("stNetzbetreiber", "iCosPhiTausendstel", None),
    "n_seit_s": ("stNetzbetreiber", "uiSeitS", "xSeitBekannt"),
    "n_zaehler": ("stNetzbetreiber", "uiZaehler", None),
    "d_kanal": ("stDirektvermarkter", "uiKanal", "xKanalBekannt"),
    "d_soll_w": ("stDirektvermarkter", "udiSollW", None),
    "d_seit_s": ("stDirektvermarkter", "uiSeitS", None),
    "d_zaehler": ("stDirektvermarkter", "uiZaehler", None),
    "quelle_p": ("stWirkung", "uiQuelle", None),
    "p_grenze_w": ("stWirkung", "udiGrenzeW", None),
    "t_zustand": (None, "uiZustand", None),
    "t_art": (None, "uiArt", "xArtBekannt"),
    "t_nenn_kw": (None, "uiNennKw", "xNennBekannt"),
    "t_p_ist_w": (None, "diPIstW", None),
    "t_p_soll_w": (None, "udiPSollW", None),
    "t_e": (None, "udiEZehntelKwh", None),
}

# Bitfeld -> (Struktur, Glied "bekannt", {Bitname: Glied})
BITS = {
    "a_gueltig": ("stAnlage", "xGueltigBekannt", {
        "netzpunkt_gueltig": "xNetzpunktGueltig", "netzpunkt_berechnet": "xNetzpunktBerechnet",
        "netzpunkt_tot": "xNetzpunktTot", "erzeugung_gueltig": "xErzeugungGueltig",
        "gasspeicher_gueltig": "xGasspeicherGueltig"}),
    "a_bits": ("stAnlage", "xBitsBekannt", {
        "not_aus": "xNotAus", "na_schutz": "xNaSchutz", "sammelstoerung": "xSammelstoerung",
        "hand_ort": "xHandOrt", "wartung": "xWartung"}),
    "n_bits": ("stNetzbetreiber", "xBitsBekannt", {
        "vorgabe_gueltig": "xVorgabeGueltig", "verbindung_steht": "xVerbindungSteht",
        "wirkleistung_begrenzt": "xWirkleistungBegrenzt", "not_aus": "xNotAus",
        "cosphi_vorgabe": "xCosPhiVorgabe", "kennlinie": "xKennlinie"}),
    "d_bits": ("stDirektvermarkter", "xBitsBekannt", {
        "abschnitt_gueltig": "xAbschnittGueltig", "aktivierung": "xAktivierung", "stopp": "xStopp",
        "bereit_gemeldet": "xBereitGemeldet", "aktiv_gemeldet": "xAktivGemeldet"}),
    "s_bits": ("stWirkung", "xBitsBekannt", {"gueltig": "xGueltig", "anlage_folgt": "xAnlageFolgt"}),
    "t_bits": (None, "xBitsBekannt", {
        "werte_gueltig": "xWerteGueltig", "sollwert_gueltig": "xSollwertGueltig", "dv_bereit": "xDvBereit",
        "dv_aktiv": "xDvAktiv", "grund_stoerung": "xGrundStoerung", "grund_netzbetreiber": "xGrundNetzbetreiber",
        "grund_hand_ort": "xGrundHandOrt", "grund_wartung": "xGrundWartung",
        "grund_gasspeicher_leer": "xGrundGasspeicherLeer", "grund_sonstiger": "xGrundSonstiger"}),
}


class NichtDarstellbar(Exception):
    """Woerter, die ein Programm der Fassung 1.0 mit diesem Baustein nicht erzeugt (mit Grund)."""


def eingaenge(woerter: list[int], namen_woerter: list[int] | None, namen_ab: int | None) -> dict:
    """Die Eingaenge, aus denen FB_VP_ErzeugerBild genau dieses Bild machen soll."""
    if woerter[4] != 0x0100:
        raise NichtDarstellbar(f"Bildfassung {woerter[4] >> 8}.{woerter[4] & 0xFF}: der Baustein schreibt 1.0")
    te = woerter[5]
    ab = woerter[11]
    if ab not in (0, NAMEN_AB):
        raise NichtDarstellbar(f"beschreibung_ab {ab}: der Baustein legt die Namen immer ab {NAMEN_AB}")
    e = {"udiSteuerungId": roh(woerter, 8, "U32"), "uiProgrammstand": woerter[7], "uiAnlagenart": woerter[10],
         "uiTeAnzahl": te, "stAnlage": {}, "stNetzbetreiber": {}, "stDirektvermarkter": {}, "stWirkung": {},
         "astEinheit": {n: {} for n in range(1, 11)}, "xMitNamen": ab == NAMEN_AB,
         "sNetzbetreiber": b"", "sDirektvermarkter": b"", "herzschlag": woerter[6]}

    def setze(struktur, n, glied, wert):
        ziel = e["astEinheit"][n] if struktur is None else e[struktur]
        ziel[glied] = wert

    def abschnitt(felder, basis, n):
        for f in felder:
            adresse = basis + f["adresse"] - (FESTER_TEIL if f["abschnitt"] == "T" else 0)
            r = roh(woerter, adresse, f["typ"])
            if f["art"] == "bitfeld":
                struktur, bekannt, namen_ = BITS[f["feld"]]
                if r == 0xFFFF:
                    setze(struktur, n, bekannt, False)
                    continue
                frei = r >> f["frei_ab_bit"]
                if frei:
                    raise NichtDarstellbar(f"{f['feld']}: Bits ab {f['frei_ab_bit']} gesetzt (Fassung 1.x)")
                for b in f["bits"]:
                    setze(struktur, n, namen_[b["name"]], bool(r & (1 << b["bit"])))
                continue
            struktur, glied, bekannt = WERTE[f["feld"]]
            if bekannt and f["ungueltig"] is not None and r == f["ungueltig"]:
                setze(struktur, n, bekannt, False)
                continue
            setze(struktur, n, glied, mit_vorzeichen(r, f["typ"]))

    abschnitt(felder_anlage(), 0, 0)
    for n in range(1, min(te, 10) + 1):
        abschnitt(felder_einheit(), FESTER_TEIL + (n - 1) * EINHEIT_LAENGE, n)
    if e["xMitNamen"] and namen_woerter is not None and namen_ab == ab:
        text = lambda start: (name_aus(namen_woerter, start) or "").encode("latin-1")  # noqa: E731
        e["sNetzbetreiber"] = text(0)
        e["sDirektvermarkter"] = text(16)
        for n in range(1, te + 1):
            e["astEinheit"][n]["sTyp"] = text(32 + 16 * (n - 1))
    return e


def gelesen_vom_leser(woerter: list[int], f: dict, basis: int) -> bool:
    """Liest der Vertrag die Woerter dieses Felds? Ein gedecktes Feld mit Bit 0 liest er nicht -
    ausser Wort 24, das ohne gueltige Vorgabe den wirksamen Ersatzwert traegt (Vertrag §3)."""
    _, grund = _deute(f, woerter, basis)
    return grund != "gueltigkeit" or f["feld"] == "n_p_prozent"
