(*
 * VoltPilot-Vorlage BHKW (Entscheid E3 = A): Anlagenprogramm einer Biogas-Anlage mit bis zu 10
 * Motoren, das den Wunsch der Box annimmt. Der Fachbetrieb passt die mit ANPASSEN markierten Zeilen
 * an: Eingänge der Anlage, Vorgaben von Netzbetreiber und Direktvermarkter, Ausgabe an die Motoren.
 *
 * Stellplatz 1: limit_w auf die ganze Erzeugung, Band 0 W bis Summe der Nennleistungen.
 * Stellplatz 2: on_off auf Motor 1 (Ziel erzeugungseinheit, Nummer 1).
 * Vorrang bleibt im Anlagenprogramm: der Direktvermarkter (Sollwert) und der Netzbetreiber gehen vor
 * jedem Wunsch; läuft ein Abruf des Direktvermarkters, bleibt Motor 1 an, und ein Wunsch "aus" ist
 * überstimmt. Ohne gültigen Wunsch fährt die Anlage mit ihren eigenen Werten.
 *)
PROGRAM PLC_PRG
VAR
    (* ANPASSEN: von VoltPilot vergeben *)
    udiSteuerungId : UDINT := 2;
    uiProgrammstand : UINT := 2611;
    (* ANPASSEN: Motoren *)
    uiTeAnzahl     : UINT := 2;
    auiNennKw      : ARRAY[1..10] OF UINT;
    (* ANPASSEN: Eingänge der Anlage *)
    xSchluesselFern : BOOL := TRUE;
    xHandOrt       : BOOL;
    axStoerung     : ARRAY[1..10] OF BOOL;
    (* ANPASSEN: Netzbetreiber, 0,1 % der Nennleistung *)
    xNbVorgabe     : BOOL;
    uiNbZehntelProzent : UINT := 1000;
    (* ANPASSEN: Direktvermarkter, Sollwert in W *)
    xDvAbruf       : BOOL;
    udiDvSollW     : UDINT;
    (* Ausgabe an die Motoren - ANPASSEN an den Feldbus *)
    axMotorEin     : ARRAY[1..10] OF BOOL;
    audiSollW      : ARRAY[1..10] OF UDINT;

    fbBild     : FB_VP_ErzeugerBild;
    fbKoppel   : FB_VP_Koppelbild;
    stAnlage   : ST_VP_ErzeugerAnlage;
    stNb       : ST_VP_ErzeugerNetzbetreiber;
    stDv       : ST_VP_ErzeugerDirektvermarkter;
    stWirkung  : ST_VP_ErzeugerWirkung;
    astEinheit : ARRAY[1..10] OF ST_VP_ErzeugerEinheit;
    aAngebot   : ARRAY[1..8] OF ST_VP_Angebot;
    aRueck     : ARRAY[1..8] OF ST_VP_Rueckmeldung;
    udiNennW   : UDINT;
    udiLaufW   : UDINT;
    diNenn     : DINT;
    diVorrang  : DINT;
    diGrenze   : DINT;
    xWunschAus : BOOL;
    n          : UINT;
END_VAR

udiNennW := 0;
FOR n := 1 TO uiTeAnzahl DO
    udiNennW := udiNennW + UINT_TO_UDINT(auiNennKw[n]) * 1000;
END_FOR
diNenn := UDINT_TO_DINT(udiNennW);

(* --- Angebot ------------------------------------------------------------------------------- *)
aAngebot[1].uiArt := 1;    (* limit_w *)
aAngebot[1].uiZiel := 1;   (* erzeugung_gesamt *)
aAngebot[1].diMin := 0;
aAngebot[1].diMax := diNenn;
aAngebot[1].xBereit := TRUE;
aAngebot[2].uiArt := 4;    (* on_off *)
aAngebot[2].uiZiel := 2;   (* erzeugungseinheit *)
aAngebot[2].uiNr := 1;
aAngebot[2].diMin := 0;
aAngebot[2].diMax := 1;
aAngebot[2].xBereit := NOT axStoerung[1];
aAngebot[2].xGrundStoerung := axStoerung[1];

fbKoppel(udiSteuerungId := udiSteuerungId, xFernsteuerungFrei := xSchluesselFern, xHandOrt := xHandOrt,
    aAngebot := aAngebot, aRueckmeldung := aRueck, aWunschRegister := GVL_VoltPilot.aKoppelWunsch,
    aQuittungRegister := GVL_VoltPilot.aKoppelQuittung);

(* --- Vorrang: Netzbetreiber, Direktvermarkter, dann der Wunsch ----------------------------- *)
diVorrang := diNenn;
IF xNbVorgabe THEN
    diVorrang := MIN(diVorrang, UDINT_TO_DINT(udiNennW * UINT_TO_UDINT(uiNbZehntelProzent) / 1000));
END_IF
IF xDvAbruf THEN
    diVorrang := MIN(diVorrang, UDINT_TO_DINT(udiDvSollW));
END_IF
diGrenze := diVorrang;
IF fbKoppel.aWunsch[1].xGilt THEN
    diGrenze := MIN(diGrenze, fbKoppel.aWunsch[1].diWert);
END_IF
aRueck[1].diWirksam := diGrenze;
aRueck[1].xWirksamBekannt := diGrenze < diNenn;
aRueck[1].xUeberstimmt := fbKoppel.aWunsch[1].xGilt AND diVorrang < fbKoppel.aWunsch[1].diWert;
aAngebot[1].xGrundVorrang := diVorrang < diNenn;

(* Motor 1: aus nur auf Wunsch und nie gegen einen Abruf des Direktvermarkters *)
xWunschAus := fbKoppel.aWunsch[2].xGilt AND fbKoppel.aWunsch[2].diWert = 0;
axMotorEin[1] := NOT axStoerung[1] AND (NOT xWunschAus OR xDvAbruf);
aRueck[2].diWirksam := BOOL_TO_DINT(axMotorEin[1]);
aRueck[2].xWirksamBekannt := TRUE;
aRueck[2].xUeberstimmt := xWunschAus AND xDvAbruf;
aAngebot[2].xGrundVorrang := xDvAbruf;
FOR n := 2 TO uiTeAnzahl DO
    axMotorEin[n] := NOT axStoerung[n];
END_FOR

(* --- Ausgabe: die Grenze auf die laufenden Motoren, nach Nennleistung ---------------------- *)
udiLaufW := 0;
FOR n := 1 TO uiTeAnzahl DO
    IF axMotorEin[n] THEN
        udiLaufW := udiLaufW + UINT_TO_UDINT(auiNennKw[n]) * 1000;
    END_IF
END_FOR
FOR n := 1 TO uiTeAnzahl DO
    audiSollW[n] := 0;
    IF axMotorEin[n] AND udiLaufW > 0 THEN
        audiSollW[n] := MIN(DINT_TO_UDINT(diGrenze), udiLaufW) / 1000 * UINT_TO_UDINT(auiNennKw[n]) * 1000 / (udiLaufW / 1000);
    END_IF
    astEinheit[n].xSollwertGueltig := TRUE;
    astEinheit[n].udiPSollW := audiSollW[n];
    astEinheit[n].uiArt := 2;
    astEinheit[n].uiNennKw := auiNennKw[n];
    astEinheit[n].xDvAktiv := xDvAbruf;
END_FOR

stAnlage.uiInstalliertKw := UDINT_TO_UINT(udiNennW / 1000);
stAnlage.xHandOrt := xHandOrt;
stNb.uiKanal := 1;
stNb.xVorgabeGueltig := xNbVorgabe;
stNb.uiPZehntelProzent := uiNbZehntelProzent;
stDv.uiKanal := 1;
stDv.udiSollW := udiDvSollW;
stWirkung.xGueltig := TRUE;
stWirkung.udiGrenzeW := DINT_TO_UDINT(diGrenze);
IF diVorrang < diNenn AND diVorrang <= diGrenze THEN
    IF xDvAbruf AND UDINT_TO_DINT(udiDvSollW) = diVorrang THEN
        stWirkung.uiQuelle := 2;   (* direktvermarkter *)
    ELSE
        stWirkung.uiQuelle := 1;   (* netzbetreiber *)
    END_IF
ELSE
    stWirkung.uiQuelle := 0;
END_IF
fbBild(udiSteuerungId := udiSteuerungId, uiProgrammstand := uiProgrammstand, uiAnlagenart := 2,
    uiTeAnzahl := uiTeAnzahl, stAnlage := stAnlage, stNetzbetreiber := stNb, stDirektvermarkter := stDv,
    stWirkung := stWirkung, astEinheit := astEinheit, xMitNamen := FALSE, aBild := GVL_VoltPilot.aErzeugerBild);
END_PROGRAM
