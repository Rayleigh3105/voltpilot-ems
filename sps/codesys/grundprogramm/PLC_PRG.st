(*
 * VoltPilot-Grundprogramm (PFC200-Konzept Abschnitt 4.4): das kleinste lauffähige Projekt mit der
 * VoltPilot-Bibliothek. Es trägt noch keine Anlage: das Bild hat 0 Einheiten, die Box liest darum
 * keine Werte (te_anzahl_ungueltig), sieht aber Signatur, Fassung und den laufenden Herzschlag -
 * so meldet sich ein PFC200 nach der Werkstatt, bevor das Anlagenprogramm kommt.
 *
 * Den Probe-Stellplatz auf der Lampe am Gerät bringt das Koppelbild (Stufe 4), nicht dieses Bild.
 *)
PROGRAM PLC_PRG
VAR
    fbBild : FB_VP_ErzeugerBild;
END_VAR
fbBild(uiProgrammstand := 2611, uiTeAnzahl := 0, xMitNamen := FALSE, aBild := GVL_VoltPilot.aErzeugerBild);
END_PROGRAM
