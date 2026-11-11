"""Was eine Box auf die Unterseite bekommt: ihre Referenz in Klarschrift und den QR-Code mit dem Direktlink.

Entscheid 8 des Betreibers vom 26.10.2026: Referenz und QR-Code werden mit dem Gehäuse gedruckt, kein
Aufkleber. Die Quelle des Inhalts ist das Portal: ``beschriftung()`` in ``frontend/portal/src/werkstatt.ts``
(Klarschrift = Referenz in Großbuchstaben, Link = ``https://portal.voltpilot.de/k/<referenz>``) und der
QR-Kodierer ``frontend/portal/src/qrCode.ts`` (Byte-Modus, Fehlerkorrektur M, kleinste Fassung, Maske nach
den Strafpunkten des Standards). Hier steht derselbe Inhalt für das Gehäuse-Programm, gebaut mit ``qrcode``
(Python) und der Maske, die das Portal wählt.

Dass beide Seiten dasselbe liefern, prüfen beide gegen denselben Vektor:
``docs/contracts/werkstatt-beschriftung.json`` (das Portal in ``werkstatt.test.ts``, das Gehäuse im Schritt
``pruefung``). Je Referenz müssen Klarschrift, Link, Fassung, Maske und jedes Modul gleich sein. Die
Prüfung der Referenz selbst folgt ``edgeRef.ts`` (``kennungGueltig``) und liest
``docs/contracts/edge-ref-vectors.json``.
"""
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
VEKTOR = REPO / "docs" / "contracts" / "werkstatt-beschriftung.json"
REF_VEKTOR = REPO / "docs" / "contracts" / "edge-ref-vectors.json"

PORTAL_ADRESSE = "https://portal.voltpilot.de"   # koppelLink.ts: PORTAL_ADRESSE
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"     # edgeRef.ts: KENNUNG_ALPHABET
PRAEFIX = "edge-"
KOERPER = 6
KORREKTUR = "M"                                  # qrCode.ts: Vorgabe der Fehlerkorrektur


def pruefzeichen(koerper):
    """Wie ``pruefzeichen`` in edgeRef.ts: positionsgewichtete Summe mod 31."""
    return ALPHABET[sum((i + 1) * ALPHABET.index(z) for i, z in enumerate(koerper)) % len(ALPHABET)]


def gueltig(ref):
    """Wie ``kennungGueltig`` in edgeRef.ts: "edge-" + sechs Zeichen + passendes Prüfzeichen, kanonisch
    (klein, ohne Leerzeichen). Nur so eine Referenz bekommt ein Gehäuse: Der Direktlink nimmt nur sie an
    (``parseKoppelHash``)."""
    if not isinstance(ref, str) or not ref.startswith(PRAEFIX):
        return False
    rest = ref[len(PRAEFIX):]
    return (len(rest) == KOERPER + 1 and all(z in ALPHABET for z in rest)
            and rest[KOERPER] == pruefzeichen(rest[:KOERPER]))


def beschriftung(ref):
    """Wie ``beschriftung()`` in werkstatt.ts: {"klartext", "link"}."""
    return {"klartext": ref.upper(), "link": f"{PORTAL_ADRESSE.rstrip('/')}/k/{ref}"}


def _strafe(m):
    """Strafpunkte einer Matrix (Liste von Listen bool) wie ``strafe()`` in qrCode.ts, Abschnitt 7.8.3 des
    Standards. ``qrcode`` rechnet sie anders und wählt dann bisweilen eine andere Maske; gelesen wird beides,
    gleich aussehen soll aber, was das Portal zeigt und was gedruckt wird."""
    g = len(m)
    summe = 0

    def linie(wert):
        nonlocal summe
        for i in range(g):
            lauf = 1
            for j in range(1, g + 1):
                if j < g and wert(i, j) == wert(i, j - 1):
                    lauf += 1
                else:
                    if lauf >= 5:
                        summe += 3 + (lauf - 5)
                    lauf = 1
            reihe = [False] * 4 + [wert(i, j) for j in range(g)] + [False] * 4
            for j in range(len(reihe) - 10):
                s = "".join("1" if b else "0" for b in reihe[j:j + 11])
                if s == "10111010000" and (j == 0 or not reihe[j - 1]):
                    summe += 40
                if s == "00001011101" and (j + 11 == len(reihe) or not reihe[j + 11]):
                    summe += 40

    linie(lambda y, x: m[y][x])
    linie(lambda x, y: m[y][x])
    for y in range(g - 1):
        for x in range(g - 1):
            c = m[y][x]
            if c == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                summe += 3
    dunkel = sum(sum(r) for r in m)
    gesamt = g * g
    k = -(-abs(dunkel * 20 - gesamt * 10) // gesamt) - 1
    return summe + k * 10


def qr(text):
    """Der QR-Code wie ``qrCode(text)`` im Portal: {"fassung", "korrektur", "maske", "module"}; ``module``
    Zeile für Zeile von oben, "1" = dunkel, ohne Ruhezone."""
    import qrcode
    from qrcode.util import MODE_8BIT_BYTE, QRData

    def baue(maske):
        q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=0, mask_pattern=maske)
        q.add_data(QRData(text.encode("utf-8"), mode=MODE_8BIT_BYTE))
        q.make(fit=True)
        return q

    kandidaten = {i: baue(i) for i in range(8)}
    strafen = {i: _strafe(q.get_matrix()) for i, q in kandidaten.items()}
    maske = min(range(8), key=lambda i: (strafen[i], i))   # bei Gleichstand die kleinste, wie im Portal
    q = kandidaten[maske]
    return {"fassung": q.version, "korrektur": KORREKTUR, "maske": maske,
            "module": ["".join("1" if b else "0" for b in reihe) for reihe in q.get_matrix()]}


def inhalt(ref):
    """Alles, was auf die Unterseite kommt: Referenz, Klarschrift, Link und der QR-Code."""
    if not gueltig(ref):
        raise ValueError(f"Keine gültige Referenz: {ref!r} (erwartet edge- und sieben Zeichen mit Prüfzeichen, "
                         "klein geschrieben, wie in der Werkstatt-Liste)")
    return {"referenz": ref, **beschriftung(ref), **qr(beschriftung(ref)["link"])}


def vektor():
    return json.loads(VEKTOR.read_text(encoding="utf-8"))


def probe_referenz():
    """Die erfundene Referenz, mit der jeder Bau die Unterseite mit Kennung baut und prüft."""
    return vektor()["faelle"][0]["referenz"]


def pruefe_vektoren():
    """Gleicht Python mit dem Portal ab: die Fälle von werkstatt-beschriftung.json und die Referenzen von
    edge-ref-vectors.json. Rückgabe (Zeilen, Fehler)."""
    zeilen, fehler = [], []
    for f in vektor()["faelle"]:
        ist = inhalt(f["referenz"])
        abweichend = [k for k in ("klartext", "link", "fassung", "korrektur", "maske", "module") if ist[k] != f[k]]
        zeilen.append({"referenz": f["referenz"], "link": f["link"], "fassung": f["fassung"], "maske": f["maske"],
                       "gleich": not abweichend, "abweichend": abweichend})
        if abweichend:
            fehler.append(f"Beschriftung {f['referenz']}: weicht vom Portal ab ({', '.join(abweichend)})")
    refs = json.loads(REF_VEKTOR.read_text(encoding="utf-8"))
    for r in refs["gueltig"]:
        if not gueltig(r):
            fehler.append(f"Referenz {r} gilt im Portal als gültig, hier nicht")
    for r in refs["ungueltig"]:
        if gueltig(r["kennung"]):
            fehler.append(f"Referenz {r['kennung']} gilt im Portal als ungültig ({r['grund']}), hier als gültig")
    return zeilen, fehler
