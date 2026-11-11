# Maßmodell: alle Zahlen mit Herkunft

Erzeugt aus `gehaeuse/massmodell.py`; nicht von Hand ändern, sondern dort, und dann
`.venv/bin/python -m gehaeuse.abgleich uebernehmen`. Was die Spalten bedeuten und woher die
Zahlen stammen: [Maßmodell](massmodell.md). Alle Werte in Millimetern, Koordinaten ab der
linken unteren Platinenecke.

| Größe | Wert (mm) | Herkunft | Messung Nr. | vorher geschätzt | Bemerkung |
|---|---|---|---|---|---|
| `PLATINE_X` | 50,75 | am Probedruck bestätigt, Betreiber 09.10.2026 | 1 | 50,4 | Breite entlang der LED-Kante; gemessen, Schablone passt |
| `PLATINE_Y` | 50,75 | am Probedruck bestätigt, Betreiber 09.10.2026 | 2 | 50,4 | Länge entlang der USB-Kante; gemessen, Schablone passt |
| `USBA_HOEHE` | 14 | am Probedruck bestätigt, Betreiber 09.10.2026 | 4 | 13,5 bis 14,5 | Oberkante über der Platinenoberseite; gemessen, Höhe stimmt an der Steckerwand |
| `RJ45_HOEHE` | 13 | am Probedruck bestätigt, Betreiber 09.10.2026 | 5 | 13,5 | Oberkante über der Platinenoberseite; gemessen, Höhe stimmt an der Steckerwand |
| `LOCH_D` | 2 | am Probedruck bestätigt, Betreiber 09.10.2026 | 7 | 2,2 | Loch für den Haltestift; gemessen, Stift sitzt |
| `LOCH_X` | 15,7 | am Probedruck bestätigt, Betreiber 09.10.2026 | 8 | 15,6 | Lochmitte bis USB-Kante; gemessen, Stift sitzt |
| `LOCH_Y` | 9,3 | am Probedruck bestätigt, Betreiber 09.10.2026 | 9 | 9,1 | Lochmitte bis LED-Kante; gemessen, Stift sitzt |
| `RJ45_UEBERSTAND` | 2,7 | am Probedruck bestätigt, Betreiber 09.10.2026 | 10 | 2,8 | über die Netzwerk-Kante; gemessen, an der Schablone bündig mit der Außenfläche |
| `RJ45_BREITE` | 30,3 | am Probedruck bestätigt, Betreiber 09.10.2026 | 11 | 30,7 | gemessen, sitzt mittig im Ausschnitt |
| `RJ45_ABSTAND_FREIE_KANTE` | 2,1 | am Probedruck bestätigt, Betreiber 09.10.2026 | 11 |  | nicht gemessen (zweiter Wert von Messung 11 fehlt); der Block sitzt mittig im Ausschnitt der Schablone |
| `MICROUSB_MITTE_X` | 7,45 | am Probedruck bestätigt, Betreiber 09.10.2026 | 12 | 7,1 | Mitte bis USB-Kante; gemessen, sitzt mittig im Ausschnitt |
| `USBA_ABSTAND_NETZKANTE` | 8,15 | am Probedruck bestätigt, Betreiber 09.10.2026 | 13 | 8,4 | obere Flanke bis Netzwerk-Kante; gemessen, sitzt mittig im Ausschnitt |
| `USBA_BREITE` | 5,5 | am Probedruck bestätigt, Betreiber 09.10.2026 | 13 |  | nicht gemessen (zweiter Wert von Messung 13 fehlt); sitzt mittig im Ausschnitt von 6,5 mm |
| `RESET_Y` | 31,5 | am Probedruck bestätigt, Betreiber 09.10.2026 | 15 | 31,5 | Stößelmitte bis LED-Kante; gemessen, an der Steckerwand seitlich richtig |
| `RESET_Z` | 1 | am Probedruck bestätigt, Betreiber 09.10.2026 | 15 | 0,5 | Stößel über der Platinenoberseite; berichtigt: Die Öffnung der Steckerwand saß 0,5 mm zu tief |
| `SCHALTER_Y` | 22 | am Probedruck bestätigt, Betreiber 09.10.2026 | 16 | 20,6 | Knopfmitte bis LED-Kante, Stellung näher an der Netzwerk-Kante; gemessen, am Probedruck an der Kerbe |
| `SCHALTER_HUB` | 1,25 | am Probedruck bestätigt, Betreiber 09.10.2026 | 16 | 0,5 oder 2,5 | zweite Stellung bei 20,75, genau zwischen den Kerben der Schablone (22,0 und 19,5) |
| `LED_Y` | 2,1 | am Probedruck bestätigt, Betreiber 09.10.2026 | 17 | 2,1 | Abstand zur LED-Kante; gemessen, die Fenster der Schachtprobe sitzen über den LEDs (alle drei leuchten klar) |
| `LED_X[0]` | 19,6 | am Probedruck bestätigt, Betreiber 09.10.2026 | 17 | 19,6 | Power, grün; gemessen, Kerbe der Schablone passt |
| `LED_X[1]` | 25,6 | am Probedruck bestätigt, Betreiber 09.10.2026 | 17 | 25,6 | WAN, grün; gemessen, Kerbe der Schablone passt |
| `LED_X[2]` | 31,7 | am Probedruck bestätigt, Betreiber 09.10.2026 | 17 | 31,7 | WLAN, rot; gemessen, Kerbe der Schablone passt |
| `UART_FREI_BIS` | 2,67 | am Probedruck bestätigt, Betreiber 09.10.2026 |  |  | so weit hinter die LED-Kante reichten die Wände der Schachtprobe, ohne an der Stiftleiste zu klemmen |
| `PLATINE_DICKE` | 1 | gemessen vom Betreiber, 09.10.2026 | 3 | 1,0 bis 1,6 |  |
| `UNTERSEITE_TIEFE` | 3 | gemessen vom Betreiber, 09.10.2026 | 6 | 2 bis 2,5 | tiefster Punkt unter der Platine; Abweichung: 0,5 bis 1 mm mehr als geschätzt |
| `MICROUSB_UEBERSTAND` | 1,4 | Schätzung aus Fotos | 12 |  | ±0,4; zweiter Wert von Messung 12 fehlt; am Probedruck "bündig" ohne Zahl und Bezug |
| `USBA_MUENDUNG` | 0 | Schätzung aus Fotos | 14 |  | ±1; Messung 14 nicht genommen; am Probedruck "bündig" ohne Zahl und Bezug. + heißt: ragt über die Kante |
| `SCHALTER_HOEHE` | 2,5 | Schätzung aus Fotos | 16 |  | Knopfmitte über der Platine: 0,5 oder 2,5 (Messung 16); am Probedruck nicht unterschieden, der Knopf hat im Kanal Platz |
| `PLATINE_ECKRADIUS` | 1,5 | Schätzung aus Fotos |  |  | ±0,5 |
| `RJ45_TIEFE` | 20,5 | Schätzung aus Fotos |  |  | Vorderkante bis Rückseite des Blocks |
| `MICROUSB_BREITE` | 7,2 | Schätzung aus Fotos |  |  |  |
| `MICROUSB_TIEFE` | 5,5 | Schätzung aus Fotos |  |  |  |
| `MICROUSB_HOEHE` | 3 | übliches Bauteilmaß, ungeprüft |  |  | 2,5 bis 3 |
| `USBA_LAENGE` | 13 | Schätzung aus Fotos |  |  | von der USB-Kante in die Platine |
| `RESET_UEBERSTAND` | 0,3 | Schätzung aus Fotos |  |  | 0,2 bis 0,4 |
| `RESET_STOESSEL_BREITE` | 1,8 | Schätzung aus Fotos |  |  |  |
| `RESET_KOERPER` | 4,4 | Schätzung aus Fotos |  |  | Länge entlang der Kante; 2,9 tief, 1,5 hoch |
| `SCHALTER_KNOPF_BREITE` | 1,3 | Schätzung aus Fotos |  |  |  |
| `SCHALTER_UEBERSTAND` | 0,9 | Schätzung aus Fotos |  |  | 0,7 bis 0,9 |
| `SCHALTER_KOERPER` | 8,7 | Schätzung aus Fotos |  |  | Länge entlang der Kante, y 16,2 bis 24,9; 2,4 tief, 1,4 hoch |
| `LED_HOEHE` | 0,8 | übliches Bauteilmaß, ungeprüft |  |  | 0,6 bis 0,8; am Gehäuse v0.2 (11.10.2026, "sitzt perfekt") stört die Rückwand des Schachts 1,0 mm über der Platine nicht; keine Zahl |
| `LED_LOETFLAECHE` | 2,65 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  | Länge über beide Lötflächen samt Lot, entlang der Kante; der Körper allein misst 2,0 |
| `UART_X[0]` | 25,2 | Schätzung aus Fotos |  |  |  |
| `UART_X[1]` | 27,7 | Schätzung aus Fotos |  |  |  |
| `UART_X[2]` | 30,2 | Schätzung aus Fotos |  |  |  |
| `UART_Y` | 4,6 | Schätzung aus Fotos |  |  |  |
| `UART_HOEHE` | 8,5 | übliches Bauteilmaß, ungeprüft |  |  | Stiftspitzen |
| `UART_SOCKEL_VORN` | 3,2 | Schätzung aus Fotos |  |  | Vorderkante des Sockels bis LED-Kante: aus dem Probedruck abgeleitet (mindestens 2,9), nicht gemessen; Schachtprobe bestanden, Herstellerfoto 3,15 bis 3,25 |
| `UART_SOCKEL_BREITE` | 2,54 | übliches Bauteilmaß, ungeprüft |  |  | Sockel einer Stiftleiste im Raster 2,54 |
| `UART_SOCKEL_HOEHE` | 2,5 | übliches Bauteilmaß, ungeprüft |  |  | Sockel einer Stiftleiste im Raster 2,54; am Gehäuse v0.2 (11.10.2026, "sitzt perfekt") stört die Rückwand des Schachts 3,0 mm über der Platine nicht; keine Zahl |
| `UFL_HOEHE` | 2,5 | übliches Bauteilmaß, ungeprüft |  |  | mit gestecktem Kabel; Buchse allein 1,25 |
| `FLACHTEILE_HOEHE` | 1,2 | übliches Bauteilmaß, ungeprüft |  |  | Prozessor, Speicher: unter 1 mm, mit Zugabe |
| `KLEINTEILE_HOEHE` | 0,6 | übliches Bauteilmaß, ungeprüft |  |  | Bauform 0402 und 0603: 0,35 bis 0,55; am Gehäuse v0.2 (11.10.2026, "sitzt perfekt") stört die Rückwand des Schachts 1,0 mm über der Platine nicht; keine Zahl |
| `KLEINTEILE[kleinteile_power][0]` | 18,65 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_power][1]` | 3 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_power][2]` | 20,7 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_power][3]` | 4,85 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_wlan][0]` | 32 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_wlan][1]` | 3,15 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_wlan][2]` | 33,95 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `KLEINTEILE[kleinteile_wlan][3]` | 6,9 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `FREI_NACH_FOTO[0]` | 16,5 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `FREI_NACH_FOTO[1]` | 0 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `FREI_NACH_FOTO[2]` | 34,6 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `FREI_NACH_FOTO[3]` | 2,9 | Schätzung aus dem Herstellerfoto, 10.10.2026 |  |  |  |
| `ANTENNE_BREITE_FREIE_KANTE` | 7,4 | Schätzung aus Fotos |  |  |  |
