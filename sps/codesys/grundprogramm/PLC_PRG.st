(*
 * VoltPilot-Grundprogramm (PFC200-Konzept Abschnitt 4.4): das kleinste lauffähige Projekt mit der
 * VoltPilot-Bibliothek. Es trägt noch keine Anlage: das Erzeuger-Bild hat 0 Einheiten, die Box
 * liest darum keine Werte (te_anzahl_ungueltig), sieht aber Signatur, Fassung und den laufenden
 * Herzschlag - so meldet sich ein PFC200 nach der Werkstatt, bevor das Anlagenprogramm kommt.
 *
 * Das Koppelbild bietet genau einen Stellplatz an: Stellplatz 8, Ein/Aus der Lampe am Gerät
 * (Ziel probe), immer bereit. Ein Wunsch "ein" der Werkstatt schaltet die Lampe, läuft nach seiner
 * Frist von selbst ab, und die Lampe geht aus (Vertrag Fall K20). Steuerung 0 = ohne Anlage.
 *)
PROGRAM PLC_PRG
VAR
    fbBild   : FB_VP_ErzeugerBild;
    fbKoppel : FB_VP_Koppelbild;
    aAngebot : ARRAY[1..8] OF ST_VP_Angebot;
    aRueck   : ARRAY[1..8] OF ST_VP_Rueckmeldung;
END_VAR
fbBild(udiSteuerungId := 0, uiProgrammstand := 2611, uiTeAnzahl := 0, xMitNamen := FALSE,
    aBild := GVL_VoltPilot.aErzeugerBild);

aAngebot[8].uiArt := 4;   (* on_off *)
aAngebot[8].uiZiel := 7;  (* probe *)
aAngebot[8].diMin := 0;
aAngebot[8].diMax := 1;
aAngebot[8].xBereit := TRUE;
fbKoppel(udiSteuerungId := 0, xFernsteuerungFrei := TRUE, xHandOrt := FALSE, aAngebot := aAngebot,
    aRueckmeldung := aRueck, aWunschRegister := GVL_VoltPilot.aKoppelWunsch,
    aQuittungRegister := GVL_VoltPilot.aKoppelQuittung);

(* Ohne gültigen Wunsch ist die Lampe aus: die SPS fährt mit ihrem eigenen Wert *)
GVL_VoltPilot.xProbeLampe := fbKoppel.aWunsch[8].xGilt AND fbKoppel.aWunsch[8].diWert = 1;
aRueck[8].diWirksam := BOOL_TO_DINT(GVL_VoltPilot.xProbeLampe);
aRueck[8].xWirksamBekannt := TRUE;
END_PROGRAM
