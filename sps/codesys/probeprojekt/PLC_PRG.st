(*
 * VoltPilot-Probeprojekt (Prüfsteine PS-P9, PS-P13): Bibliothek, Modbus-TCP-Server und ein
 * gestelltes Erzeuger-Bild mit drei PV-Wechselrichtern - feste, ausgedachte Werte, keine Anlage.
 * Was die Box davon lesen muss, steht in sps/codesys/probeprojekt/erwartung.json (der Prüfer
 * erzeugt es aus diesem Programm und hält es aktuell).
 *
 * Am Gerät: laden, starten, dann von der Box (oder auf dem Gerät gegen 127.0.0.1:502) lesen:
 * Funktionscode 4, Register 0..67 und 140..219. Der Herzschlag in Register 6 zählt je Sekunde;
 * Betriebsartenschalter auf STOP lässt ihn stehen (PS-P13).
 *
 * Koppelbild (Prüfsteine PS-P10 bis PS-P12): Stellplatz 1 begrenzt die ganze Erzeugung (0 bis
 * 375 000 W), Stellplatz 8 ist die Lampe am Gerät. Die Quittung steht in den Eingangsregistern
 * 1000..1115, die Box schreibt in die Halteregister 0..63. Ein angenommener Wunsch auf Stellplatz 1
 * steht als wirksame Grenze im Erzeuger-Bild (Register 36/37); nach der Frist wieder 265 000 W.
 *)
PROGRAM PLC_PRG
VAR
    fbBild     : FB_VP_ErzeugerBild;
    stAnlage   : ST_VP_ErzeugerAnlage;
    stNb       : ST_VP_ErzeugerNetzbetreiber;
    stDv       : ST_VP_ErzeugerDirektvermarkter;
    stWirkung  : ST_VP_ErzeugerWirkung;
    astEinheit : ARRAY[1..10] OF ST_VP_ErzeugerEinheit;
    n          : INT;
    xEinmal    : BOOL;
    fbKoppel   : FB_VP_Koppelbild;
    aAngebot   : ARRAY[1..8] OF ST_VP_Angebot;
    aRueck     : ARRAY[1..8] OF ST_VP_Rueckmeldung;
END_VAR
IF NOT xEinmal THEN
    xEinmal := TRUE;
    stAnlage.xNetzpunktGueltig := TRUE;
    stAnlage.xErzeugungGueltig := TRUE;
    stAnlage.uiAlterS := 1;
    (* Einspeisung am Netzpunkt ist negativ: prüft das Zweierkomplement auf dem Gerät *)
    stAnlage.diPNetzpunktW := -1200;
    stAnlage.diPErzeugungW := 182700;
    stAnlage.uiZustand := 2;
    stAnlage.uiInstalliertKw := 265;
    stNb.uiKanal := 3;
    stNb.xVorgabeGueltig := TRUE;
    stNb.xVerbindungSteht := TRUE;
    stNb.xCosPhiVorgabe := TRUE;
    stNb.uiPZehntelProzent := 1000;
    stNb.iCosPhiTausendstel := -950;
    stNb.uiSeitS := 60;
    stNb.uiZaehler := 1;
    stDv.uiKanal := 0;
    stWirkung.xGueltig := TRUE;
    stWirkung.xAnlageFolgt := TRUE;
    stWirkung.uiQuelle := 0;
    stWirkung.udiGrenzeW := 265000;
    FOR n := 1 TO 3 DO
        astEinheit[n].xWerteGueltig := TRUE;
        astEinheit[n].xSollwertGueltig := TRUE;
        astEinheit[n].uiZustand := 2;
        astEinheit[n].uiArt := 1;
        astEinheit[n].uiNennKw := 125;
        astEinheit[n].diPIstW := 60800 + n * 100;
        astEinheit[n].udiPSollW := 125000;
        astEinheit[n].udiEZehntelKwh := 1000000 + INT_TO_UDINT(n);
    END_FOR
    astEinheit[1].sTyp := 'Probe-Wechselrichter 1';
    astEinheit[2].sTyp := 'Probe-Wechselrichter 2';
    astEinheit[3].sTyp := 'Probe-Wechselrichter 3 (Grün)';
    aAngebot[1].uiArt := 1;    (* limit_w *)
    aAngebot[1].uiZiel := 1;   (* erzeugung_gesamt *)
    aAngebot[1].diMin := 0;
    aAngebot[1].diMax := 375000;
    aAngebot[1].xBereit := TRUE;
    aAngebot[8].uiArt := 4;    (* on_off *)
    aAngebot[8].uiZiel := 7;   (* probe *)
    aAngebot[8].diMin := 0;
    aAngebot[8].diMax := 1;
    aAngebot[8].xBereit := TRUE;
END_IF
fbKoppel(udiSteuerungId := 1, xFernsteuerungFrei := TRUE, xHandOrt := FALSE, aAngebot := aAngebot,
    aRueckmeldung := aRueck, aWunschRegister := GVL_VoltPilot.aKoppelWunsch,
    aQuittungRegister := GVL_VoltPilot.aKoppelQuittung);
stWirkung.udiGrenzeW := 265000;
aRueck[1].xWirksamBekannt := FALSE;
IF fbKoppel.aWunsch[1].xGilt THEN
    stWirkung.udiGrenzeW := MIN(DINT_TO_UDINT(fbKoppel.aWunsch[1].diWert), 265000);
    aRueck[1].diWirksam := UDINT_TO_DINT(stWirkung.udiGrenzeW);
    aRueck[1].xWirksamBekannt := TRUE;
END_IF
GVL_VoltPilot.xProbeLampe := fbKoppel.aWunsch[8].xGilt AND fbKoppel.aWunsch[8].diWert = 1;
aRueck[8].diWirksam := BOOL_TO_DINT(GVL_VoltPilot.xProbeLampe);
aRueck[8].xWirksamBekannt := TRUE;
fbBild(udiSteuerungId := 1, uiProgrammstand := 2611, uiAnlagenart := 1, uiTeAnzahl := 3,
    stAnlage := stAnlage, stNetzbetreiber := stNb, stDirektvermarkter := stDv, stWirkung := stWirkung,
    astEinheit := astEinheit, xMitNamen := TRUE, sNetzbetreiber := 'Netzbetreiber Probe',
    sDirektvermarkter := '', aBild := GVL_VoltPilot.aErzeugerBild);
END_PROGRAM
