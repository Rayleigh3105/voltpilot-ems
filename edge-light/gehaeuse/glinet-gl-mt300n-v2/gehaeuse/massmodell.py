"""Maßmodell der Mango-Platine (GL.iNet GL-MT300N-V2) als Daten.

Jede Zahl trägt ihre Herkunft. Gemessene Werte stammen vom Betreiber
(09.10.2026, an einer geöffneten Mango, Nummern des Messblatts); alles andere
ist aus Fotos geschätzt oder ein übliches Bauteilmaß (Quellen und Verfahren:
``docs/massmodell.md``). Wo ein Messwert die Schätzung ersetzt hat, steht die alte
Schätzung als ``alt`` daneben.

Am selben Tag hat der Betreiber Schablone, Steckerwand und Fensterstufen
gedruckt und mit der Platine geprüft. Was dabei gepasst hat oder berichtigt
wurde, trägt die Herkunft "am Probedruck bestätigt"; ein berichtigter Wert
nennt den alten als ``alt``. Bestätigt heißt: passt in den gedruckten
Ausschnitt (je Seite 0,3 bis 0,5 mm Luft), nicht: auf ein Zehntel gemessen.

Am Abend des 09.10.2026 kam die Rückmeldung zur Schachtprobe: bestanden. Beide
Nasen lagen an der Wand an, alle drei Fenster leuchteten klar, das
Nachbarfenster blieb dunkel, die Füße standen auf freier Platine, die
Stiftleiste hat drei Stifte. Gemessen wurde dabei nichts ("kein Messschieber
zur Hand"): Der Abstand der Stiftleiste zur LED-Kante bleibt abgeleitet.
Am 10.10.2026 hat der Betreiber das ganze Gehäuse v0.1 gedruckt; in Zahlen hat
er dazu nichts gesagt ("LEDs leuchten stark zur Seite aufgrund eines Spaltes").
Am Abend des 10.10.2026, nach der neuen Schachtprobe und dem Deckel
v0.2 gefragt, schrieb er: "das gehäuse passt jetzt so" (PASST_10_10). Das ist sein Satz,
keine Messung: Ob er die Schachtprobe, den Deckel v0.2 oder beides gedruckt hat
und ob das seitliche Licht weg ist, hat er nicht gesagt. Kein Maß dieses
Moduls ist dadurch bestätigt oder geändert.
Am 11.10.2026 hat er acht Fragen zum Stand v0.3 beantwortet
(ANTWORTEN_11_10). Seitdem steht fest: Er hat das ganze Gehäuse v0.2 gedruckt,
es sitzt, das Licht stimmt (GEHAEUSE_11_10), und WAN und LAN stehen an der
richtigen Buchse. Das bestätigt das Gehäuse als Ganzes, keine einzelne Zahl:
Was damit belegt ist und was nicht, steht in BESTAETIGT_11_10 und
NICHT_EINZELN_11_10. Die Herkunft "am Probedruck bestätigt" tragen weiter nur
die Maße, die er am 09.10.2026 einzeln gemeldet hat.

Bezug: Blick auf die Bestückungsseite, Netzwerkbuchsen oben. Ursprung ist die
linke untere Platinenecke, x nach rechts, y nach oben, z = 0 auf der
Platinenoberseite, z nach oben.

    Netzwerk-Kante  y = PLATINE_Y   Doppel-RJ45, Micro-USB (Strom)
    USB-Kante       x = 0           USB-A, Reset-Taster, Schiebeschalter
    LED-Kante       y = 0           drei LEDs, UART-Stifte, beide Antennen
    freie Kante     x = PLATINE_X   unbestückte Lochreihe
"""
from dataclasses import dataclass

GEMESSEN = "gemessen vom Betreiber, 09.10.2026"
PROBEDRUCK = "am Probedruck bestätigt, Betreiber 09.10.2026"
FOTO = "Schätzung aus dem Herstellerfoto, 10.10.2026"
SCHAETZUNG = "Schätzung aus Fotos"
UNGEPRUEFT = "übliches Bauteilmaß, ungeprüft"
# Der Betreiber am 10.10.2026, 20:22 Uhr, zum Stand v0.2, wörtlich. Nur dieser
# Satz; welche Teile er dafür gedruckt hat, ist nicht gesagt.
PASST_10_10 = "das gehäuse passt jetzt so"
# Der Betreiber am 11.10.2026, 17:39 Uhr, zu acht Fragen zum Stand v0.3,
# wörtlich. Die Fragen: 1 WAN und LAN an der richtigen Buchse, und heißen sie
# so? 2 Strom: 5V, PWR oder nur das Dreieck? 3 USB beschriften? 4 Reset
# beschriften? 5 LEDs: Ziffern, nichts oder Wörter? 6 Schalter verdeckt und ohne
# Wort? 7 Größe und Ausführung der Schrift? 8 Deckel v0.2 gedruckt, Licht zur
# Seite weg?
ANTWORTEN_11_10 = ("gedruckt - 1. ja, 2. 5V, 3. mit USB, 4. nein, 5. nicht beschriften, 6. richtig so, "
                   "7. wenns geht lieber kleiner und schwarz ist gut, 8. ich habe das komplette gehäuse v0.2 "
                   "gedruckt und es sitzt perfekt. Licht passt auch.")
GEHAEUSE_11_10 = "ich habe das komplette gehäuse v0.2 gedruckt und es sitzt perfekt. Licht passt auch."
# Was dieser Satz und die Antwort 1 belegen: (was, worauf es sich stützt)
BESTAETIGT_11_10 = (
    ("Das ganze Gehäuse v0.2 ist gedruckt und sitzt: Unterteil und Deckel mit dem langen Lichtschacht.",
     "„ich habe das komplette gehäuse v0.2 gedruckt und es sitzt perfekt“"),
    ("Der Lichtschacht, der auf der Platine steht, lässt den Deckel sitzen, und das Licht stimmt.",
     "„sitzt perfekt. Licht passt auch“; gefragt war, ob das Licht zur Seite weg ist"),
    ("WAN ist die Netzwerkbuchse an der freien Kante, LAN die neben dem Micro-USB; die Wörter heißen so.",
     "Antwort „1. ja“ auf die Frage, ob das stimmt und ob die Wörter so heißen sollen"),
)
# Was er dazu nicht einzeln gesagt hat. Daraus, dass das Gehäuse sitzt, folgt es
# nicht für jeden Punkt; es bleibt als nicht einzeln bestätigt stehen.
NICHT_EINZELN_11_10 = (
    "Reset-Loch: ob die Büroklammer den Taster trifft",
    "Stecker: ob Micro-USB, USB-A und Netzwerkstecker im ganzen Gehäuse einrasten (an der Steckerwand am "
    "09.10.2026 bestätigt)",
    "Wandmontage: ob das Gehäuse an zwei Schrauben hängt und die Bohrlehre stimmt",
    "Deckel: Falz, Rastwulst und die vier Schrauben im Einzelnen",
    "Höhen der Bauteile unter dem Schacht (LEDs, Sockel der Stiftleiste, kleine Bauteile): keine Zahl; "
    "die Rückwand des Schachts stört den Sitz des Deckels nicht",
    "Farben, Logo und Lesbarkeit der Fenster",
    "ob die Schriftprobe von v0.3 gedruckt ist („gedruckt“ steht ohne Gegenstand am Anfang der Antwort)",
)


class Mass(float):
    """Eine Zahl in Millimetern mit Herkunft; rechnet wie ein float."""

    def __new__(cls, wert, herkunft, nr=None, alt=None, notiz=""):
        m = super().__new__(cls, wert)
        m.herkunft, m.nr, m.alt, m.notiz = herkunft, nr, alt, notiz
        return m

    def __getnewargs__(self):   # damit copy und pickle die Herkunft mitnehmen
        return (float(self), self.herkunft, self.nr, self.alt, self.notiz)

    @property
    def gemessen(self):
        """Am Gerät belegt: mit dem Messschieber oder am Probedruck."""
        return self.herkunft in (GEMESSEN, PROBEDRUCK)

    @property
    def am_druck_bestaetigt(self):
        return self.herkunft == PROBEDRUCK


def M(wert, nr, alt=None, notiz=""):
    return Mass(wert, GEMESSEN, nr, alt, notiz)


def P(wert, nr=None, alt=None, notiz=""):
    """Am Probedruck bestätigt oder berichtigt (dann steht der alte Wert in ``alt``)."""
    return Mass(wert, PROBEDRUCK, nr, alt, notiz)


def S(wert, notiz="", nr=None):
    return Mass(wert, SCHAETZUNG, nr, None, notiz)


def U(wert, notiz=""):
    return Mass(wert, UNGEPRUEFT, None, None, notiz)


def F(wert, notiz=""):
    """Am 10.10.2026 aus dem Herstellerfoto (docs/massmodell.md, Quelle H2) abgelesen:
    Maßstab aus dem Abstand der drei gemessenen LEDs, ±0,15 mm. Das Foto zeigt
    ein Seriengerät, nicht die Platine des Betreibers."""
    return Mass(wert, FOTO, None, None, notiz)


# ---- Platine --------------------------------------------------------------
PLATINE_X = P(50.75, 1, alt="50,4", notiz="Breite entlang der LED-Kante; gemessen, Schablone passt")
PLATINE_Y = P(50.75, 2, alt="50,4", notiz="Länge entlang der USB-Kante; gemessen, Schablone passt")
PLATINE_DICKE = M(1.0, 3, alt="1,0 bis 1,6")
PLATINE_ECKRADIUS = S(1.5, "±0,5")
UNTERSEITE_TIEFE = M(3.0, 6, alt="2 bis 2,5",
                     notiz="tiefster Punkt unter der Platine; Abweichung: 0,5 bis 1 mm mehr als geschätzt")
LOCH_D = P(2.0, 7, alt="2,2", notiz="Loch für den Haltestift; gemessen, Stift sitzt")
LOCH_X = P(15.7, 8, alt="15,6", notiz="Lochmitte bis USB-Kante; gemessen, Stift sitzt")
LOCH_Y = P(9.3, 9, alt="9,1", notiz="Lochmitte bis LED-Kante; gemessen, Stift sitzt")

# ---- Doppel-RJ45 an der Netzwerk-Kante ------------------------------------
RJ45_HOEHE = P(13.0, 5, alt="13,5", notiz="Oberkante über der Platinenoberseite; gemessen, "
               "Höhe stimmt an der Steckerwand")
RJ45_UEBERSTAND = P(2.7, 10, alt="2,8", notiz="über die Netzwerk-Kante; gemessen, an der Schablone "
                    "bündig mit der Außenfläche")
RJ45_BREITE = P(30.3, 11, alt="30,7", notiz="gemessen, sitzt mittig im Ausschnitt")
RJ45_ABSTAND_FREIE_KANTE = P(2.1, 11, notiz="nicht gemessen (zweiter Wert von Messung 11 fehlt); der "
                             "Block sitzt mittig im Ausschnitt der Schablone")
RJ45_TIEFE = S(20.5, "Vorderkante bis Rückseite des Blocks")
# Welche der beiden Buchsen welche ist, steht im Herstellerbild der Platine
# (docs/massmodell.md, Quelle H2, "PINOUT"): "WAN port0" an der freien Kante, "LAN port1"
# neben dem Micro-USB. Der Betreiber hat es am 11.10.2026 bestätigt (Antwort
# "1. ja" auf die Frage, ob WAN an der freien Seite und LAN neben dem Strom
# stimmt und ob die Wörter so heißen sollen).
NETZWERKBUCHSEN = ("LAN", "WAN")   # von der USB-Kante zur freien Kante (x aufsteigend)
# So nennt der Hersteller die Teile im selben Bild; der Flyer-Entwurf von
# VoltPilot (07.10.2026) schreibt Buchse "WAN", Buchse "LAN", Strombuchse
# (Micro-USB), Reset-Taste, "die mittlere Leuchte".
NAMEN_HERSTELLER = {"rj45": "WAN port0 / LAN port1", "microusb": "Power input", "usba": "USB2.0",
                    "reset": "RESET", "schalter": "SWITCH", "leds": ("POWER", "WAN", "WLED")}

# ---- Micro-USB (Strom) an der Netzwerk-Kante ------------------------------
MICROUSB_MITTE_X = P(7.45, 12, alt="7,1", notiz="Mitte bis USB-Kante; gemessen, sitzt mittig im "
                     "Ausschnitt")
# Zum Überstand von Micro-USB und USB-A sagt der Probedruck nur: "stecker und
# netzwerkblock sind bündig, das kann so bleiben". Bündig womit (Platinenkante
# oder Außenfläche), ist für die beiden Buchsen nicht gesagt; Zahlen fehlen
# weiter. Die Stecker rasten an der Steckerwand ein, das Gehäuse hängt daran nicht.
MICROUSB_UEBERSTAND = S(1.4, "±0,4; zweiter Wert von Messung 12 fehlt; am Probedruck \"bündig\" ohne "
                        "Zahl und Bezug", nr=12)
MICROUSB_BREITE = S(7.2)
MICROUSB_TIEFE = S(5.5)
MICROUSB_HOEHE = U(3.0, "2,5 bis 3")

# ---- USB-A, hochkant, an der USB-Kante ------------------------------------
USBA_HOEHE = P(14.0, 4, alt="13,5 bis 14,5", notiz="Oberkante über der Platinenoberseite; gemessen, "
               "Höhe stimmt an der Steckerwand")
USBA_ABSTAND_NETZKANTE = P(8.15, 13, alt="8,4", notiz="obere Flanke bis Netzwerk-Kante; gemessen, "
                           "sitzt mittig im Ausschnitt")
USBA_BREITE = P(5.5, 13, notiz="nicht gemessen (zweiter Wert von Messung 13 fehlt); sitzt mittig im "
                "Ausschnitt von 6,5 mm")
USBA_LAENGE = S(13.0, "von der USB-Kante in die Platine")
USBA_MUENDUNG = S(0.0, "±1; Messung 14 nicht genommen; am Probedruck \"bündig\" ohne Zahl und Bezug. "
                  "+ heißt: ragt über die Kante", nr=14)

# ---- Reset-Taster, seitlich betätigt --------------------------------------
RESET_Y = P(31.5, 15, alt="31,5", notiz="Stößelmitte bis LED-Kante; gemessen, an der Steckerwand "
            "seitlich richtig")
RESET_Z = P(1.0, 15, alt="0,5", notiz="Stößel über der Platinenoberseite; berichtigt: Die Öffnung der "
            "Steckerwand saß 0,5 mm zu tief")
RESET_UEBERSTAND = S(0.3, "0,2 bis 0,4")
RESET_STOESSEL_BREITE = S(1.8)
RESET_KOERPER = S(4.4, "Länge entlang der Kante; 2,9 tief, 1,5 hoch")

# ---- Schiebeschalter ------------------------------------------------------
# Messung 16 lautete "22/0,5/2,5 richtung led kante" und ließ zwei Lesarten zu.
# Der Probedruck klärt die Stellungen: Die Schablone trug Kerben bei 22,0 und
# bei 19,5; "genau zwischen den kerben ist eine schalterstellung und bei der
# rechten kerbe ist die zweite". Eine Stellung liegt also bei 20,75, die
# zweite an einer Kerbe. Als diese Kerbe ist 22,0 genommen: Dort hat der
# Betreiber die Knopfmitte gemessen, und 20,75 trifft die alte Schätzung aus
# dem Foto (20,6). Welche Kerbe "die rechte" ist, hängt von der Blickrichtung
# ab und ist nicht gesagt; läge die zweite Stellung bei 19,5, hätte der Knopf
# im Kanal des Gehäuses trotzdem Platz (parameter.py, schalter_luft_*).
SCHALTER_Y = P(22.0, 16, alt="20,6", notiz="Knopfmitte bis LED-Kante, Stellung näher an der "
               "Netzwerk-Kante; gemessen, am Probedruck an der Kerbe")
SCHALTER_HUB = P(1.25, 16, alt="0,5 oder 2,5", notiz="zweite Stellung bei 20,75, genau zwischen den "
                 "Kerben der Schablone (22,0 und 19,5)")
SCHALTER_HOEHE = S(2.5, "Knopfmitte über der Platine: 0,5 oder 2,5 (Messung 16); am Probedruck nicht "
                   "unterschieden, der Knopf hat im Kanal Platz", nr=16)
SCHALTER_KNOPF_BREITE = S(1.3)
SCHALTER_UEBERSTAND = S(0.9, "0,7 bis 0,9")
SCHALTER_KOERPER = S(8.7, "Länge entlang der Kante, y 16,2 bis 24,9; 2,4 tief, 1,4 hoch")

# ---- LEDs, strahlen nach oben ---------------------------------------------
LED_Y = P(2.1, 17, alt="2,1", notiz="Abstand zur LED-Kante; gemessen, die Fenster der Schachtprobe "
          "sitzen über den LEDs (alle drei leuchten klar)")
LED_X = (P(19.6, 17, alt="19,6", notiz="Power, grün; gemessen, Kerbe der Schablone passt"),
         P(25.6, 17, alt="25,6", notiz="WAN, grün; gemessen, Kerbe der Schablone passt"),
         P(31.7, 17, alt="31,7", notiz="WLAN, rot; gemessen, Kerbe der Schablone passt"))
LED_HOEHE = U(0.8, "0,6 bis 0,8; am Gehäuse v0.2 (11.10.2026, \"sitzt perfekt\") stört die Rückwand des "
              "Schachts 1,0 mm über der Platine nicht; keine Zahl")
LED_LOETFLAECHE = F(2.65, "Länge über beide Lötflächen samt Lot, entlang der Kante; der Körper allein "
                    "misst 2,0")

# ---- Sonstiges auf der Oberseite ------------------------------------------
UART_X = (S(25.2), S(27.7), S(30.2))
UART_Y = S(4.6)
UART_HOEHE = U(8.5, "Stiftspitzen")
# Die Stiftleiste steht den LEDs näher, als die Stifte allein es zeigen: Sie
# hat einen Kunststoffsockel. Gemessen ist seine Vorderkante nicht. Am
# Probedruck passte der Lichtschacht der Fensterstufen (3,68 mm tief)
# "ziemlich genau zwischen die stifte und dem Gehäuse", saß dann aber nicht
# mehr über der LED. Mit der Wand der Schablone 0,5 mm vor der Platinenkante
# liegt die Vorderkante damit bei rund 3,2 mm; ein üblicher Sockel von
# 2,54 mm um die geschätzte Stiftreihe (y = 4,6) beginnt bei 3,3 mm. Liegt die
# Platine in der Schablone ganz an der LED-Wand an, sind es mindestens 2,9 mm.
#
# Schachtprobe (09.10.2026): Schachtwände, die bis 2,675 mm hinter die LED-Kante
# reichen, klemmen nicht an der Leiste. Eine engere Schranke ist das nicht:
# Die Platine hat in der Schablone 0,3 bis 0,5 mm Luft. Gemessen hat der
# Betreiber den Abstand nicht. Das Herstellerfoto zeigt den Aufdruck des Sockels
# ab 3,15 mm und die Lochreihe bei 4,5 mm (Sockel dann ab 3,25).
UART_STIFTE = 3   # gezählt vom Betreiber an der Platine, 09.10.2026 (Rückmeldung zur Schachtprobe)
UART_FREI_BIS = P(2.675, notiz="so weit hinter die LED-Kante reichten die Wände der Schachtprobe, ohne "
                  "an der Stiftleiste zu klemmen")
UART_SOCKEL_VORN = S(3.2, "Vorderkante des Sockels bis LED-Kante: aus dem Probedruck abgeleitet "
                     "(mindestens 2,9), nicht gemessen; Schachtprobe bestanden, Herstellerfoto 3,15 bis 3,25")
UART_SOCKEL_BREITE = U(2.54, "Sockel einer Stiftleiste im Raster 2,54")
UART_SOCKEL_HOEHE = U(2.5, "Sockel einer Stiftleiste im Raster 2,54; am Gehäuse v0.2 (11.10.2026, \"sitzt "
                      "perfekt\") stört die Rückwand des Schachts 3,0 mm über der Platine nicht; keine Zahl")
UFL = ((S(4.9), S(9.2)), (S(39.1), S(4.8)))
UFL_HOEHE = U(2.5, "mit gestecktem Kabel; Buchse allein 1,25")
FLACHTEILE_HOEHE = U(1.2, "Prozessor, Speicher: unter 1 mm, mit Zugabe")

# ---- Rund um die LEDs: was dort auf der Platine sitzt ----------------------
# Der Lichtschacht steht seit v0.2 auf der Platine. Wo sie dort frei ist, sagt
# zweierlei: die Füße der Schachtprobe ("stehen auf freier Platine") und das
# Herstellerfoto. Hinter der Power-LED und neben der Stiftleiste sitzen zwei
# Gruppen kleiner Widerstände und Kondensatoren (Aufdruck R206/R207 und
# C609/R89/R87/R95); angegeben ist der Rahmen ihres Aufdrucks.
KLEINTEILE_HOEHE = U(0.6, "Bauform 0402 und 0603: 0,35 bis 0,55; am Gehäuse v0.2 (11.10.2026, \"sitzt "
                     "perfekt\") stört die Rückwand des Schachts 1,0 mm über der Platine nicht; keine Zahl")
KLEINTEILE = {  # Name -> (x0, y0, x1, y1), jede Zahl aus dem Herstellerfoto
    "kleinteile_power": (F(18.65), F(3.0), F(20.7), F(4.85)),
    "kleinteile_wlan": (F(32.0), F(3.15), F(33.95), F(6.9)),
}
# Zwischen LED-Kante und dieser Linie liegen im Foto nur die drei LEDs, dazu
# Leiterbahnen, Durchkontaktierungen und Aufdruck, alles flach.
FREI_NACH_FOTO = (F(16.5), F(0.0), F(34.6), F(2.9))

# ---- Unterseite: einzelne Bauteile (Lage geschätzt, Höhe ungeprüft) -------
# Gemessen ist nur der tiefste Punkt (UNTERSEITE_TIEFE), nicht wo er liegt.
FLASH = (37.0, 24.0, 42.5, 29.5)
SPULEN = ((10.9, 33.0), (23.5, 12.9))

# ---- Antennen: kupferfreie Zonen, kein Metall in der Nähe -----------------
ANTENNE_BREITE_FREIE_KANTE = S(7.4)


@dataclass(frozen=True)
class Quader:
    """Achsparalleler Hüllkörper eines Bauteils in Platinenkoordinaten."""
    name: str
    x0: float
    y0: float
    x1: float
    y1: float
    z0: float
    z1: float
    farbe: str = "#c9ced6"

    @property
    def mitte(self):
        return ((self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2, (self.z0 + self.z1) / 2)

    @property
    def groesse(self):
        return (self.x1 - self.x0, self.y1 - self.y0, self.z1 - self.z0)


def rj45():
    x1 = PLATINE_X - RJ45_ABSTAND_FREIE_KANTE
    y1 = PLATINE_Y + RJ45_UEBERSTAND
    return Quader("rj45", x1 - RJ45_BREITE, y1 - RJ45_TIEFE, x1, y1, 0.0, RJ45_HOEHE, "#d9dde2")


def netzwerkbuchsen():
    """Mitte jeder Buchse des Doppelblocks entlang der Netzwerk-Kante: {"LAN": x, "WAN": x}."""
    r = rj45()
    teil = (r.x1 - r.x0) / len(NETZWERKBUCHSEN)
    return {name: r.x0 + (i + 0.5) * teil for i, name in enumerate(NETZWERKBUCHSEN)}


def microusb():
    y1 = PLATINE_Y + MICROUSB_UEBERSTAND
    return Quader("microusb", MICROUSB_MITTE_X - MICROUSB_BREITE / 2, y1 - MICROUSB_TIEFE,
                  MICROUSB_MITTE_X + MICROUSB_BREITE / 2, y1, 0.0, MICROUSB_HOEHE)


def usba():
    y1 = PLATINE_Y - USBA_ABSTAND_NETZKANTE
    return Quader("usba", -USBA_MUENDUNG, y1 - USBA_BREITE, USBA_LAENGE, y1, 0.0, USBA_HOEHE)


def reset():
    return Quader("reset", 0.4, RESET_Y - RESET_KOERPER / 2, 3.3, RESET_Y + RESET_KOERPER / 2,
                  0.0, 1.5, "#b9bfc8")


def reset_stoessel():
    h = RESET_STOESSEL_BREITE / 2
    return Quader("reset_stoessel", -RESET_UEBERSTAND, RESET_Y - h, 0.4, RESET_Y + h,
                  RESET_Z - 0.4, RESET_Z + 0.4, "#1a1a1a")


def schalter():
    return Quader("schalter", 0.3, 16.2, 2.7, 16.2 + SCHALTER_KOERPER, 0.0, 1.4, "#b9bfc8")


def schalter_stellungen():
    """y der Knopfmitte in beiden Stellungen (am Probedruck geklärt)."""
    return [SCHALTER_Y - SCHALTER_HUB, float(SCHALTER_Y)]


def schalter_knopf():
    """Raum, den der Knopf in beiden Stellungen einnimmt."""
    y = schalter_stellungen()
    h = SCHALTER_KNOPF_BREITE / 2
    hoch = SCHALTER_HOEHE + 0.7
    return Quader("schalter_knopf", -SCHALTER_UEBERSTAND, y[0] - h, 0.3, y[-1] + h, 0.0, hoch,
                  "#1a1a1a")


def leds():
    return [Quader(f"led{i}", x - 1.0, LED_Y - 0.425, x + 1.0, LED_Y + 0.425, 0.0, LED_HOEHE,
                   "#22a34a") for i, x in enumerate(LED_X)]


def uart():
    return Quader("uart", UART_X[0] - 0.4, UART_Y - 0.4, UART_X[-1] + 0.4, UART_Y + 0.4,
                  0.0, UART_HOEHE, "#1a1a1a")


def uart_sockel():
    """Kunststoffsockel der Stiftleiste; in x so lang wie die drei bestückten
    Stifte (drei gezählt vom Betreiber, ihre Lage geschätzt)."""
    assert len(UART_X) == UART_STIFTE
    h = UART_SOCKEL_BREITE / 2
    return Quader("uart_sockel", UART_X[0] - h, float(UART_SOCKEL_VORN), UART_X[-1] + h,
                  UART_SOCKEL_VORN + UART_SOCKEL_BREITE, 0.0, UART_SOCKEL_HOEHE, "#2b2c30")


def ufl():
    return [Quader(f"ufl{i}", x - 1.5, y - 1.5, x + 1.5, y + 1.5, 0.0, UFL_HOEHE, "#e7c873")
            for i, (x, y) in enumerate(UFL)]


def flachteile():
    return [Quader("prozessor", 22.0, 16.0, 33.7, 27.8, 0.0, FLACHTEILE_HOEHE, "#3a3f47"),
            Quader("speicher", 5.5, 18.4, 18.0, 26.5, 0.0, FLACHTEILE_HOEHE, "#3a3f47")]


def kleinteile():
    """Die beiden Gruppen kleiner Bauteile hinter und neben den LEDs."""
    return [Quader(name, *(float(v) for v in r[:2]), *(float(v) for v in r[2:]), 0.0, KLEINTEILE_HOEHE,
                   "#6b6257") for name, r in KLEINTEILE.items()]


def led_loetflaechen():
    """Grundfläche jeder LED samt Lötflächen (x0, y0, x1, y1): Hier darf keine
    Schachtwand stehen."""
    h = LED_LOETFLAECHE / 2
    return [(x - h, q.y0, x + h, q.y1) for x, q in zip(LED_X, leds())]


def schachtprobe_fuesse(wand=0.84, oeffnung=(3.0, 2.0), hinten=None):
    """Wo die Füße der Schachtprobe vom 09.10.2026 standen (x0, y0, x1, y1):
    "stehen auf freier Platine". Die Maße sind die der gedruckten Probe."""
    bx, by = oeffnung
    hinten = float(UART_FREI_BIS) if hinten is None else hinten
    x0, x1 = LED_X[0] - bx / 2 - wand, LED_X[-1] + bx / 2 + wand
    yv0, yv1 = LED_Y - by / 2 - wand, LED_Y - by / 2
    return [(x0, yv0, x0 + wand, hinten), (x1 - wand, yv0, x1, hinten),
            (x0, yv0, LED_X[0] + bx / 2 + wand, yv1), (LED_X[-1] - bx / 2 - wand, yv0, x1, yv1)]


def oberseite():
    """Alle Bauteile der Oberseite als Hüllkörper."""
    return [rj45(), microusb(), usba(), reset(), reset_stoessel(), schalter(), schalter_knopf(),
            *leds(), uart(), uart_sockel(), *ufl(), *flachteile(), *kleinteile()]


def unterseite():
    """Bekannte Bauteile der Unterseite. Die Liste ist unvollständig: Die
    Unterseite ist durchgehend bestückt, Lötspitzen der Stecker fehlen hier."""
    u = -PLATINE_DICKE
    teile = [Quader("flash", *FLASH[:2], *FLASH[2:], u - 2.2, u, "#3a3f47")]
    teile += [Quader(f"spule{i}", x - 2.0, y - 2.0, x + 2.0, y + 2.0, u - 2.0, u, "#8a8f98")
              for i, (x, y) in enumerate(SPULEN)]
    return teile


def antennen():
    """Kupferfreie Zonen (x0, y0, x1, y1): kein Metall in der Nähe."""
    return [(0.0, 0.0, 18.2, 8.4),
            (PLATINE_X - ANTENNE_BREITE_FREIE_KANTE, 0.0, float(PLATINE_X), 19.6)]


def alle_masse():
    """Name -> Mass für jede einzelne Zahl dieses Moduls."""
    aus = {}
    for name, wert in globals().items():
        if isinstance(wert, Mass):
            aus[name] = wert
        elif isinstance(wert, tuple) and wert and all(isinstance(w, Mass) for w in wert):
            aus.update({f"{name}[{i}]": w for i, w in enumerate(wert)})
        elif isinstance(wert, dict) and wert and all(isinstance(w, tuple) for w in wert.values()):
            aus.update({f"{name}[{k}][{i}]": w for k, t in wert.items() for i, w in enumerate(t)
                        if isinstance(w, Mass)})
    return aus


def zahl(wert):
    """Deutsche Schreibweise ohne überflüssige Nullen."""
    return f"{wert:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def tabelle_md():
    """Alle Zahlen mit Herkunft als Markdown-Tabelle; Messwerte zuerst."""
    zeilen = ["| Größe | Wert (mm) | Herkunft | Messung Nr. | vorher geschätzt | Bemerkung |",
              "|---|---|---|---|---|---|"]
    rang = {PROBEDRUCK: 0, GEMESSEN: 1}
    masse = sorted(alle_masse().items(), key=lambda e: (rang.get(e[1].herkunft, 2), e[1].nr or 99))
    for name, m in masse:
        zeilen.append(f"| `{name}` | {zahl(m)} | {m.herkunft} | {m.nr or ''} | {m.alt or ''} "
                      f"| {m.notiz} |")
    return "\n".join(zeilen)


if __name__ == "__main__":
    print(tabelle_md())
