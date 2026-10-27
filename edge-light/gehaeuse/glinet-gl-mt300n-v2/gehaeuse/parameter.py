"""Stellgrößen des Gehäuses und der Passproben.

Alles, was die Rückmeldung aus den Passproben ändern kann, steht hier als
Zahl. Stand v0.4: Grundform ohne Schraublaschen, liegend oder an der Wand; der
Lichtschacht des Deckels steht auf der Platine, die Anschlüsse sind auf dem
Deckel beschriftet, seit v0.4 in kleinerer Schrift. Die Maße der Platine stehen in
``massmodell.py``; hier steht, wie das Gehäuse darum gebaut wird. Herkunft der Regeln:
``docs/regeln.md`` (Bahnbreite 0,42 mm, Schichthöhe 0,20 mm, Bambu Lab P1S).

Koordinaten wie im Maßmodell: Ursprung linke untere Platinenecke, z = 0 auf
der Platinenoberseite.
"""
from dataclasses import dataclass, replace

from . import massmodell as m

BAHN = 0.42      # Bahnbreite der 0,4-mm-Düse
SCHICHT = 0.20   # Schichthöhe


@dataclass(frozen=True)
class Material:
    """Was sich mit dem Filament ändert.

    schwund: Anteil, um den das Teil beim Abkühlen kleiner wird (0.005 = 0,5 %).
    Die Druckdateien werden um diesen Anteil vergrößert geschrieben. Solange
    die Probe-Platte (Soll 60,00 mm) nicht gedruckt und nachgemessen ist,
    steht hier 0: Die Dateien haben dann genau die Nennmaße.
    """
    name: str
    schwund: float
    spiel: float      # gedrucktes Teil in gedrucktem Teil, je Seite
    notiz: str


MATERIALIEN = {
    "asa": Material("ASA (Zeichen in ABS Azure)", 0.0, 0.25,
                    "Schwund laut anderen Herstellern 0,4 bis 0,9 %; für Bambu ASA auf dem P1S "
                    "noch nicht gemessen"),
    "petg": Material("PETG", 0.0, 0.25, "Schwund noch nicht gemessen; HDT nur 62 bis 69 °C"),
}

FARBEN = {  # Teilname -> Anzeigefarbe; die Reihenfolge ist der Filamentplatz 1, 2, 3
    "gehaeuse_weiss": "#FFFFFF",
    "schrift_schwarz": "#101010",
    "zeichen_hellblau": "#95B9FF",
}


@dataclass(frozen=True)
class Parameter:
    material: str = "asa"

    # ---- Wände und Luft (docs/regeln.md) ----------------------------------
    wand: float = 2.0
    boden: float = 2.0
    deckel: float = 2.0
    eckradius: float = 3.5           # senkrechte Gehäuseecken außen
    fase: float = 0.5                # 45°-Fase an Kanten auf der Druckplatte
    luft_led: float = 0.5            # Platinenkante bis Innenwand, LED-Kante
    luft_frei: float = 0.5           # ... freie Kante
    luft_usb: float = 0.3            # ... USB-Kante: Bezugsseite, knapper
    luft_unten: float = 0.5          # unter dem tiefsten Punkt der Unterseite
    luft_oben: float = 1.0           # über dem USB-A bis zur Deckelunterseite
    rj45_versatz: float = 0.0        # Vorderkante des Netzwerkblocks hinter (+) der Außenfläche
    anschlag_luft: float = 0.3       # Rippen an der Netzwerk-Seite bis zur Platinenkante

    # ---- Öffnungen (docs/regeln.md: Luft um Stecker) ----------------------
    oeffnung_luft: float = 0.5       # um den Körper einer Buchse, je Seite
    senkung_rest: float = 0.84       # Wand, die in einer Griffsenkung stehen bleibt (zwei Bahnen)
    microusb_griff: tuple = (13.0, 8.0)     # Senkung für die Umspritzung des Steckers (Breite, Höhe)
    usba_griff: tuple = (10.0, 17.5)        # ... USB-A, hochkant (Breite, Höhe)
    reset_loch: float = 2.0          # Büroklammer, in der Achse des Stößels
    reset_luft: float = 0.5          # um den Stößel des Tasters, im Kanal der Innenwand
    # Kanal für den Schalterknopf, wie an Schablone und Steckerwand gedruckt und
    # bestätigt ("der kopf hat platz"). Zur LED-Kante hin bleibt mehr Luft: Dort
    # läge der Knopf, falls die zweite Stellung doch bei 19,5 liegt (massmodell.py).
    schalter_luft_led: float = 2.25
    schalter_luft_netz: float = 1.5

    # ---- Aufnahme der Platine ---------------------------------------------
    stift_d: float = 1.6             # Haltestift im Loch (Loch 2,0 gemessen)
    stift_ueber: float = 1.2         # Stift über der Platinenoberseite
    nabe_d: float = 4.6              # Säule unter dem Loch
    auflage_ecke: float = 2.5        # Auflagen in den Ecken, Kantenlänge unter der Platine
    auflage_leiste: float = 1.0      # Leisten unter der freien Kante, Tiefe unter der Platine
    niederhalter_luft: float = 0.2   # Niederhalter des Deckels bis zum Teil darunter

    # ---- Verschluss (docs/regeln.md) --------------------------------------
    falz: float = 1.5                # umlaufender Falz am Deckel, Dicke
    falz_tiefe: float = 3.0
    schraube_d: float = 2.5          # selbstfurchend für Kunststoff, Senkkopf, 2,5 x 10
    schraube_kopf_d: float = 4.9     # Senkung im Deckel (Kopf 4,7)
    schraube_laenge: float = 10.0
    schraube_tiefe: float = 10.0     # Kernloch im Dom, ab Oberkante Wand
    dom_versatz: float = 0.0         # Dommitte außerhalb der Wandaußenfläche
    # Je eine Säule an USB- und freier Seite; Metall bleibt bei y > 25. Die
    # hintere Säule schließt bündig mit der Netzwerk-Seite ab und steht damit
    # 1,7 mm neben der Griffsenkung des USB-A (v0: 47,8, in der Senkung).
    schrauben_y: tuple = (26.6, 50.0)
    rastwulst: float = 0.25          # Wulst am Falz der LED-Seite; 0 = keiner

    # ---- Logo (docs/regeln.md) --------------------------------------------
    einlage: float = 0.6             # Tiefe der Farbeinlage = 3 Schichten
    logo_breite: float = 48.0
    logo_drehung: float = 180.0      # 180: lesbar, wenn die Netzwerk-Kante unten liegt
    logo_mitte_y: float = 17.0       # hängend im oberen Drittel, zwischen LEDs und Schrauben

    # ---- Stellgrößen, die der Betreiber entscheidet -----------------------
    # Einbauort seit 09.10.2026: an der Wand oder liegend, nicht im Verteiler.
    # Lüftung und LED-Anzeige bleiben Schalter.
    lueftung: bool = True            # Schlitze an LED- und Netzwerk-Seite (hängend oben und unten)
    schlitz: float = 2.0             # unter 2,5 mm: kein Draht dieser Stärke passt hindurch
    schlitz_steg: float = 1.26       # drei Bahnen
    schlitz_ab_boden: float = 3.0    # Unterkante der Schlitze über der Bodenaußenfläche
    schlitz_rand: float = 13.5       # Schlitzfeld der LED-Seite: Abstand zu beiden Außenflächen (mittig)
    led_anzeige: str = "fenster"     # "fenster" (dünne Wand), "offen" (Loch) oder "keine"
    led_fenster: float = 0.2         # Restdicke über der LED: eine Schicht (Fensterstufen, 09.10.2026)
    led_schacht: bool = True         # Schacht um jede LED gegen Mitleuchten
    led_oeffnung: tuple = (3.0, 2.0)    # lichte Weite von Schacht und Fenster (x, y)
    # Hinter den LEDs steht die Stiftleiste. Bis über die Stiftspitzen ist der
    # Schacht deshalb nach hinten offen und endet knapp hinter der LED; das
    # Fenster bleibt mittig über der LED.
    led_schacht_hinter_led: float = 0.15  # Schachtwände reichen so weit hinter die Hinterkante der LED
    led_schacht_ueber_stiften: float = 1.0   # erst so weit über den Stiftspitzen ist der Schacht ein voller Block
    # Seit v0.2 (Rückmeldung zum ganzen Gehäuse, 10.10.2026: "so lang machen dass
    # er auf der platine aufliegt"): Vorderwand, Seitenwände und die Wände
    # zwischen den LEDs reichen bis auf die Platine. Am Fuß sind die Öffnungen
    # je Seite eine Bahn weiter: Luft zu den Lötflächen der LEDs. Die
    # Seitenwände sind dafür drei Bahnen dick; kein Teil des Fußes ist
    # schmaler als zwei Bahnen (eine einzelne Bahn druckt Bambu Studio in der
    # Voreinstellung nicht verlässlich). Hinter den LEDs schließt eine
    # Rückwand, so weit Stiftleiste und die kleinen Bauteile es zulassen.
    # False baut den Schacht von v0.1.
    led_schacht_bis_platine: bool = True
    led_schacht_luft: float = 0.0          # Fuß bis Platinenoberseite; 0 = liegt im Nennmaß auf
    led_schacht_fuss: float = 0.6          # so hoch sind die Öffnungen am Fuß weiter: drei Schichten
    led_schacht_rueckwand: float = 2 * BAHN   # Rückwand zwischen LEDs und Stiften
    led_schacht_luft_sockel: float = 0.5   # Rückwand über dem Sockel der Stiftleiste
    led_schacht_luft_neben_sockel: float = 1.0   # ... und seitlich neben ihm (Lage der Stifte geschätzt)
    led_schacht_luft_kleinteile: float = 0.4     # Rückwand über den kleinen Bauteilen hinter den LEDs

    # ---- Beschriftung der Anschlüsse auf dem Deckel (seit v0.3) -------------
    # Auftrag des Betreibers vom 10.10.2026: "auf der seite auf der das VoltPilot
    # Logo aufgedruckt ist auch die anschlüsse beschriften". Die Wörter stehen
    # hier und nur hier; ein leerer Text lässt die Beschriftung weg. Erlaubt
    # sind A bis Z, 0 bis 9, Leerzeichen und - + / . (schrift.py). Passt ein
    # Wort nicht neben Logo, Fenster, Schrauben oder das Nachbarwort, meldet die
    # Prüfung das als Fehler.
    # Die vier Wörter hat der Betreiber am 11.10.2026 bestätigt (massmodell.
    # ANTWORTEN_11_10): WAN und LAN stehen an der richtigen Buchse und heißen
    # so, der Strom heißt "5V", der USB-A-Anschluss bleibt beschriftet.
    text_wan: str = "WAN"
    text_lan: str = "LAN"
    text_strom: str = "5V"
    text_usb: str = "USB"
    # Reset-Loch und LEDs: nicht beschriften (Betreiber, 11.10.2026: "4. nein,
    # 5. nicht beschriften"). Die Schalter bleiben, leer; MIT_RESET_UND_LEDS
    # baut die abgewählte Fassung von v0.3.
    text_reset: str = ""
    # Texte unter den drei LED-Fenstern in der Reihenfolge von massmodell.LED_X
    text_leds: tuple = ("", "", "")
    # Der Schiebeschalter hat keinen Text: Das Gehäuse verdeckt ihn (Kanal in
    # der Innenwand, keine Öffnung). Bestätigt am 11.10.2026: "6. richtig so".
    beschriftung: str = "eingelegt"  # "eingelegt" (Farbe bündig, wie das Logo), "vertieft", "erhaben", "keine"
    beschriftung_farbe: str = "schrift_schwarz"   # Teil und Filamentplatz der eingelegten Schrift
    beschriftung_tiefe: float = 0.4  # vertieft oder erhaben: zwei Schichten; eingelegt gilt ``einlage``
    # Schrift aus Strichen fester Breite (schrift.py). Seit v0.4 kleiner
    # (Betreiber, 11.10.2026: "wenns geht lieber kleiner und schwarz ist gut").
    # Woran die Größe hängt:
    #   Strich   Bambu Studio fährt in der Voreinstellung (Wände "klassisch")
    #            um jeden Strich eine Schleife: zwei Bahnen. Schmaler als zwei
    #            Bahnen (0,84 mm) legt es dieselben zwei Bahnen in den
    #            schmaleren Strich (bei 0,5 mm die anderthalbfache Menge) oder
    #            lässt ihn in der ersten Schicht weg. Eine einzelne Bahn fährt
    #            nur der Wandgenerator "Arachne" (``wandgenerator``).
    #   Höhe     Drei Querstriche übereinander (B, S, 5) brauchen zweimal
    #            ``schrift_abstand`` Weiß dazwischen: mindestens
    #            3 x Strich + 2 x 0,6 mm (schrift.kleinste_hoehe), mit zwei
    #            Bahnen also 3,72 mm, mit einer Bahn von 0,5 mm 2,7 mm.
    # Vorgabe ist die kleinste Schrift, die mit dem Slicer in der Voreinstellung druckt,
    # wie er ist: 3,8 mm, Strich zwei Bahnen, Formen "offen". Lücken unter
    # ``schrift_abstand`` laufen zu (docs/regeln.md: Abstand mindestens 0,6 mm).
    # Die Schrift von v0.3: SCHRIFT_V03; die feine mit einer Bahn: SCHRIFT_FEIN.
    schrift_hoehe: float = 3.8       # Höhe der Großbuchstaben
    schrift_strich: float = 2 * BAHN
    schrift_form: str = "offen"      # Zeichenformen aus schrift.FORMEN: "offen" oder "v03"
    schrift_luft: float = 2 * BAHN   # Weiß zwischen zwei Buchstaben
    schrift_abstand: float = 0.6     # schmalere Lücken zwischen Strichen laufen zu
    # Wandgenerator, mit dem der Deckel zu slicen ist. "klassisch" ist die
    # Voreinstellung von Bambu Studio; die Druckdatei trägt dann keine
    # Einstellung. "arachne" schreibt die Einstellung als Objekteinstellung in
    # die 3MF (mehrfarb_3mf.py); nötig für Striche unter zwei Bahnen.
    wandgenerator: str = "klassisch"
    insel_min: float = 1.8           # kleinste schwarze Insel in mm²: das Dreieck von v0.3
    zeiger: tuple = (2.4, 1.6)       # Dreieck, das vom Wort auf den Anschluss zeigt (Breite, Länge)
    zeiger_rand: float = 1.0         # Spitze des Dreiecks bis zur Fase der Deckelkante
    zeiger_luft: float = 0.9         # Dreieck bis Schrift
    led_text_luft: float = 1.2       # LED-Fenster bis Schrift
    beschriftung_frei: float = 1.0   # Schrift bis Logo, Fenster, Schraubenkopf, Etikettfeld, Nachbarwort, Rand

    # ---- Etikett (Format noch offen) --------------------------------------
    etikett: str = "unterseite"      # "unterseite", "deckel", "seite" (freie Seite) oder "keins"
    etikett_groesse: tuple = (40.0, 14.0)
    etikett_tiefe: float = 0.2       # auf Deckel und Unterseite eine Schicht; an der Seite 0,3

    # ---- Kennung auf der Unterseite (Entscheid 8 vom 26.10.2026) ----------
    # "ich würde gerne die beschriftung und qr code per 3d-Drucker aufs gehäuse
    # drucken keinen aufkleber mehr zu brauchen": Referenz in Klarschrift und
    # QR-Code mit dem Direktlink als schwarze Einlage in den ersten drei
    # Schichten der Standfläche, wie Logo und Schrift des Deckels. Gebaut je Box
    # (./bauen.sh --referenz edge-…); das Etikettfeld entfällt dort. Der Inhalt
    # kommt aus gehaeuse/kennung.py, gleich dem Portal (werkstatt.ts).
    # Modul zwei Bahnen wie jeder farbige Strich: Der Code (Fassung 3, 29 x 29
    # Module) misst dann 24,36 mm. Er sitzt zwischen den Mulden der LED-Seite,
    # so weit wie möglich vom Rand und von den Schlüssellöchern.
    qr_modul: float = 2 * BAHN
    # Ruhezone: helles Material um den Code bis zu einem Loch, einer Mulde (dort
    # klebt ein dunkler Fuß) oder dem Rand des Teils, in Modulen. ISO/IEC 18004
    # verlangt 4; zwischen Mulden und Schlüssellöchern bleiben bei 0,84 mm je
    # Modul rund 3,7. Ob das reicht, sagt die Lesbarkeitsprüfung mit der
    # echten Umgebung aus dem G-Code (bambu.py), nicht diese Zahl.
    qr_ruhe_min: float = 3.0
    # Klarschrift in der Schrift des Deckels, zwei Zeilen: "EDGE-" zwischen den
    # Schlüssellöchern, darunter der Rest an der Netzwerk-Seite. In einer Zeile
    # wäre sie rund 42 mm breit; frei sind zwischen den Mulden 33,5 mm.
    kennung_zeilenabstand: float = 1.5

    # ---- Außenform --------------------------------------------------------
    fase_unten: float = 1.5          # Fase um die Standfläche (v0: 0,5)

    # ---- Wandmontage: zwei Schlüssellöcher in der Unterseite --------------
    # Das Gerät hängt mit der Netzwerk-Seite nach unten und wird von vorn auf
    # zwei Schrauben gesetzt und nach unten in die Rast geschoben. Die Köpfe
    # sitzen in geschlossenen Taschen im Sockel, nicht im Raum der Platine.
    wandmontage: bool = True         # False: kein Sockel, das Gehäuse ist um ihn niedriger
    wand_abstand: float = 30.0       # Abstand der beiden Schrauben, waagerecht
    wand_y: float = 29.5             # Schraubenmitte in der Rast; der Kopf bleibt bei y > 25
    wand_hub: float = 8.5            # Weg vom Einsetzen bis in die Rast
    wand_schaft: float = 4.0         # Schrauben 3,5 bis 4 mm
    wand_kopf_d: float = 8.0         # größter Kopf
    wand_kopf_hoehe: float = 2.6     # höchster Kopf (Senkkopf 4 mm: 2,4; Linsenkopf 3,5 mm: 2,6)
    wand_luft: float = 0.5           # Schlitz weiter als der Schaft, Tasche weiter als der Kopf, je Seite 0,25
    wand_einstieg_luft: float = 1.0  # Einsetzöffnung weiter als der Kopf
    wand_kopf_luft: float = 0.4      # Tasche höher als der Kopf
    wand_lehre_luft: float = 0.3     # Bohrlehre dicker als die Lippe: Spiel des Kopfes in der Tasche
    wand_lippe: float = 2.0          # Kunststoff zwischen Schraubenkopf und Wand
    wand_decke: float = 1.0          # geschlossener Boden zwischen Tasche und Innenraum

    # ---- Standfläche: Mulden für Klebefüße --------------------------------
    fuesse: bool = True
    fuss_d: float = 8.5              # Mulde für Klebefüße bis 8 mm Durchmesser
    fuss_tiefe: float = 0.6          # drei Schichten; ein Fuß von 2 mm steht 1,4 mm vor
    fuss_rand: float = 1.0           # Mulde bis zur Fase der Standfläche

    # ---- Schraublaschen (docs/regeln.md): Form v0, nur noch als Schalter --
    laschen: bool = False
    lasche_breite: float = 20.0
    lasche_laenge: float = 14.0
    lasche_loch_abstand: float = 7.0   # Lochmitte bis Wand
    lasche_dicke: float = 3.0
    lasche_loch: float = 4.5         # für 4-mm-Schrauben, Senkkopf
    lasche_langloch: float = 2.0     # Zugabe in Längsrichtung
    lasche_senkung_d: float = 8.6

    # ---- Hutschienen-Clip (docs/regeln.md): Zubehör -----------------------
    # Der Clip wird von hinten mit zwei Gehäuseschrauben in die beiden
    # mittleren Schraubsäulen geschraubt (Bohrungen von unten).
    clip_bohrungen: bool = True      # Kernlöcher von unten in den mittleren Säulen
    clip_loch_tiefe: float = 7.5     # ab Standfläche; Schraube 2,5 x 10 durch 3 mm Platte
    clip_steg: float = 9.0           # Breite des Querstegs, der zu den Säulen reicht
    clip_platte: float = 3.0
    clip_breite: float = 34.0
    schiene_breite: float = 35.0     # TH 35
    schiene_kante: float = 1.0       # 1,0 mm (TH 35-7,5); 1,5 mm bei TH 35-15
    schiene_kante_max: float = 1.5
    schiene_tiefe: float = 7.5
    haken_hinterschnitt: float = 2.0
    riegel_eingriff: float = 1.2
    riegel_vorspannung: float = 0.3
    feder_dicke: float = 1.6
    feder_laenge: float = 26.0
    feder_tiefe: float = 8.0
    feder_weg: float = 2.6

    def mit(self, **aenderungen):
        return replace(self, **aenderungen)

    @property
    def stoff(self):
        return MATERIALIEN[self.material]

    @property
    def spiel(self):
        return self.stoff.spiel

    # ---- Abgeleitete Maße: Außenkanten und Ebenen -------------------------
    @property
    def xi0(self):
        """Innenwand an der USB-Seite."""
        return -self.luft_usb

    @property
    def xi1(self):
        return m.PLATINE_X + self.luft_frei

    @property
    def yi0(self):
        return -self.luft_led

    @property
    def ya1(self):
        """Außenfläche an der Netzwerk-Seite: bündig mit dem Netzwerkblock."""
        return m.PLATINE_Y + m.RJ45_UEBERSTAND + self.rj45_versatz

    @property
    def yi1(self):
        return self.ya1 - self.wand

    @property
    def xa0(self):
        return self.xi0 - self.wand

    @property
    def xa1(self):
        return self.xi1 + self.wand

    @property
    def ya0(self):
        return self.yi0 - self.wand

    @property
    def mitte(self):
        return ((self.xa0 + self.xa1) / 2, (self.ya0 + self.ya1) / 2)

    @property
    def z_auflage(self):
        """Unterseite der Platine: Oberkante der Auflagen."""
        return -m.PLATINE_DICKE

    @property
    def z_boden_innen(self):
        return -(m.PLATINE_DICKE + m.UNTERSEITE_TIEFE + self.luft_unten)

    @property
    def z_boden(self):
        """Außenfläche des Bodens der Wanne. Darunter liegt der Sockel."""
        return self.z_boden_innen - self.boden

    @property
    def wand_tasche(self):
        """Höhe der Tasche für den Schraubenkopf."""
        return self.wand_kopf_hoehe + self.wand_kopf_luft

    @property
    def sockel(self):
        """Dicke des Sockels unter dem Boden: Lippe und Tasche der
        Schlüssellöcher, soweit sie nicht im Boden selbst Platz finden."""
        if not self.wandmontage:
            return 0.0
        return self.wand_lippe + self.wand_tasche - (self.boden - self.wand_decke)

    @property
    def z_rueck(self):
        """Standfläche = Rückseite des Gehäuses: liegt auf dem Tisch oder an der Wand."""
        return self.z_boden - self.sockel

    @property
    def wand_schlitz(self):
        return self.wand_schaft + self.wand_luft

    @property
    def wand_tasche_breite(self):
        return self.wand_kopf_d + self.wand_luft

    @property
    def wand_einstieg_d(self):
        return self.wand_kopf_d + self.wand_einstieg_luft

    @property
    def wandschrauben(self):
        """Mitten der beiden Wandschrauben in der Rast (x, y)."""
        cx, h = self.mitte[0], self.wand_abstand / 2
        return [(cx - h, self.wand_y), (cx + h, self.wand_y)]

    @property
    def fussmulden(self):
        """Mitten der vier Mulden für Klebefüße (x, y)."""
        e = self.fase_unten + self.fuss_rand + self.fuss_d / 2
        return [(x, y) for y in (self.ya0 + e, self.ya1 - e) for x in (self.xa0 + e, self.xa1 - e)]

    @property
    def z_wand(self):
        """Oberkante der Wand = Unterseite des Deckels."""
        return max(m.USBA_HOEHE, m.RJ45_HOEHE) + self.luft_oben

    @property
    def z_deckel(self):
        """Sichtfläche des Deckels."""
        return self.z_wand + self.deckel

    @property
    def aussen(self):
        """Außenmaße ohne Schraubsäulen und Laschen (x, y, z)."""
        return (self.xa1 - self.xa0, self.ya1 - self.ya0, self.z_deckel - self.z_rueck)

    @property
    def dome(self):
        """Mitten der Schraubdome (x, y)."""
        return [(x, y) for y in self.schrauben_y
                for x in (self.xa0 - self.dom_versatz, self.xa1 + self.dom_versatz)]

    @property
    def dom_radius(self):
        # mindestens 2 x Schraubendurchmesser, und 1 mm Rand um die Kopfsenkung im Deckel
        return max(self.schraube_d, self.schraube_kopf_d / 2 + 1.0)

    @property
    def laschenloecher(self):
        """Lochmitten der beiden Schraublaschen (x, y), LED-Seite zuerst."""
        cx, ab = self.mitte[0], self.lasche_loch_abstand
        return [(cx, self.ya0 - ab), (cx, self.ya1 + ab)]

    @property
    def clip_schrauben(self):
        """Mitten der beiden Säulen, in die der Hutschienen-Clip geschraubt wird (x, y)."""
        y = min(self.schrauben_y)
        return [d for d in self.dome if d[1] == y]


# Der Deckel v0.2: langer Lichtschacht, keine Beschriftung. Der Betreiber hat ihn
# mit dem ganzen Gehäuse v0.2 gedruckt (11.10.2026: "sitzt perfekt. Licht passt
# auch"); sein weißer Körper steht im festgehaltenen Stand (passproben.py).
DECKEL_V02 = dict(beschriftung="keine")

# Der Deckel v0.1, wie ihn der Betreiber am 10.10.2026 gedruckt hat: Der Schacht
# endet über den LEDs und ist hinten bis über die Stiftspitzen offen.
SCHACHT_V01 = dict(led_schacht_bis_platine=False, **DECKEL_V02)

# Die Schrift des Deckels v0.3 (10.10.2026 zum Drucken bereitgestellt, auch
# Zeile 3 der ersten Schriftprobe): 4,5 mm hoch, die Zeichenformen von damals.
SCHRIFT_V03 = dict(schrift_hoehe=4.5, schrift_form="v03")

# Die feinste Schrift, die im Probeslicen sauber fährt: jeder Strich eine
# einzelne Bahn von 0,5 mm (so breit wie die Bahn der ersten Schicht), 3,0 mm
# hoch. Sie druckt nur mit dem Wandgenerator "Arachne"; "klassisch" fährt den
# Strich doppelt. Ob die Einstellung aus der 3MF in der Oberfläche von Bambu
# Studio ankommt, zeigt die Schriftprobe.
SCHRIFT_FEIN = dict(schrift_hoehe=3.0, schrift_strich=0.5, wandgenerator="arachne")

# Die Schriftgrößen, die zur Wahl standen, von der Schrift von v0.3 zur
# kleinsten: Kennung (Teil der Dateinamen) -> geänderte Stellgrößen. Gewählt
# ist am 12.10.2026 nach der Schriftprobe die Vorgabe ("wir nehmen 3,8"); die
# beiden anderen bleiben baubar.
SCHRIFTGROESSEN = {"4-5": SCHRIFT_V03, "3-8": {}, "3-0": SCHRIFT_FEIN}

# Vorschlag von v0.3, am 11.10.2026 abgewählt ("4. nein, 5. nicht beschriften"):
# auch das Reset-Loch und die drei LEDs beschriften. Die LEDs sind von links
# nach rechts gezählt, wie man sie liest (Netzwerk-Seite unten);
# massmodell.LED_X läuft andersherum. Bleibt als Schalter baubar, in der
# Schrift von damals, ohne Druckdatei.
MIT_RESET_UND_LEDS = dict(text_reset="RESET", text_leds=("3", "2", "1"), **SCHRIFT_V03)

# Das Etikettfeld auf dem Deckel (40 x 14 mm) liegt dort, wo USB und Reset
# beschriftet sind: Beides zusammen geht nicht. Mit dem Etikett auf dem Deckel
# entfällt deshalb die Beschriftung an der USB-Seite.
ETIKETT_DECKEL = dict(etikett="deckel", text_usb="", text_reset="")

# Die Form v0 (Schraublaschen, runde Dome, kein Sockel, Etikett auf dem Deckel)
# bleibt als Satz von Schaltern baubar.
FORM_V0 = dict(laschen=True, wandmontage=False, fuesse=False, etikett="deckel",
               fase_unten=0.5, clip_bohrungen=False, schrauben_y=(26.6, 47.8), **SCHACHT_V01)


STANDARD = Parameter()
