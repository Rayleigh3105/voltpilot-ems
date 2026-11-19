(*
 * VoltPilot-Vorlage PV (Entscheid E3 = A): Anlagenprogramm einer PV-Anlage mit bis zu 10
 * Wechselrichtern, das den Wunsch der Box annimmt. Der Fachbetrieb passt die mit ANPASSEN markierten
 * Zeilen an: Eingänge der Anlage, Vorgabe des Netzbetreibers, Ausgabe an die Wechselrichter.
 *
 * Stellplatz 1: limit_w auf die ganze Erzeugung, Band 0 W bis Nennleistung.
 * Vorrang bleibt im Anlagenprogramm: wirksam ist das Kleinste aus Nennleistung, Grenze des
 * Netzbetreibers und gültigem Wunsch. Bestimmt der Netzbetreiber statt des Wunschs, meldet die
 * Rückmeldung "überstimmt" und das Angebot grund_vorrang. Ohne gültigen Wunsch (Box aus, Frist
 * vorbei, Schlüsselschalter auf Ort) fährt die Anlage mit ihren eigenen Werten.
 * Die wirksame Grenze steht im Erzeuger-Bild (p_grenze_w); bestimmt der Wunsch sie, nennt quelle_p
 * keine Stelle (0) - wer stellt, sagt die Quittung des Koppelbilds (Erzeuger-Bild bleibt 1.0).
 *)
PROGRAM PLC_PRG
VAR
    (* ANPASSEN: von VoltPilot vergeben, gleich im Erzeuger-Bild und im Koppelbild *)
    udiSteuerungId : UDINT := 1;
    (* ANPASSEN: Stand dieses Programms, JJMM *)
    uiProgrammstand : UINT := 2611;
    (* ANPASSEN: Zahl und Nennleistung der Wechselrichter *)
    uiTeAnzahl     : UINT := 3;
    auiNennKw      : ARRAY[1..10] OF UINT;
    (* ANPASSEN: Eingänge der Anlage *)
    xSchluesselFern : BOOL := TRUE;
    xHandOrt       : BOOL;
    xStoerung      : BOOL;
    (* ANPASSEN: Vorgabe des Netzbetreibers in 0,1 % der Nennleistung, aus der Fernwirktechnik *)
    xNbVorgabe     : BOOL;
    uiNbZehntelProzent : UINT := 1000;
    (* Ausgabe an die Wechselrichter: Wirkleistungsgrenze je Einheit in W - ANPASSEN an den Feldbus *)
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
    diNenn     : DINT;
    diNb       : DINT;
    diGrenze   : DINT;
    n          : UINT;
END_VAR

(* --- Nennleistung -------------------------------------------------------------------------- *)
udiNennW := 0;
FOR n := 1 TO uiTeAnzahl DO
    udiNennW := udiNennW + UINT_TO_UDINT(auiNennKw[n]) * 1000;
END_FOR
diNenn := UDINT_TO_DINT(udiNennW);

(* --- Angebot: Stellplatz 1 begrenzt die ganze Erzeugung ------------------------------------ *)
aAngebot[1].uiArt := 1;    (* limit_w *)
aAngebot[1].uiZiel := 1;   (* erzeugung_gesamt *)
aAngebot[1].diMin := 0;
aAngebot[1].diMax := diNenn;
aAngebot[1].xBereit := NOT xStoerung;
aAngebot[1].xGrundStoerung := xStoerung;

fbKoppel(udiSteuerungId := udiSteuerungId, xFernsteuerungFrei := xSchluesselFern, xHandOrt := xHandOrt,
    aAngebot := aAngebot, aRueckmeldung := aRueck, aWunschRegister := GVL_VoltPilot.aKoppelWunsch,
    aQuittungRegister := GVL_VoltPilot.aKoppelQuittung);

(* --- Vorrang: zuerst der Netzbetreiber, dann der Wunsch ------------------------------------ *)
diNb := diNenn;
IF xNbVorgabe THEN
    diNb := MIN(diNenn, UDINT_TO_DINT(udiNennW * UINT_TO_UDINT(uiNbZehntelProzent) / 1000));
END_IF
diGrenze := diNb;
IF fbKoppel.aWunsch[1].xGilt THEN
    diGrenze := MIN(diGrenze, fbKoppel.aWunsch[1].diWert);
END_IF
aRueck[1].diWirksam := diGrenze;
aRueck[1].xWirksamBekannt := diGrenze < diNenn;
aRueck[1].xUeberstimmt := fbKoppel.aWunsch[1].xGilt AND diNb < fbKoppel.aWunsch[1].diWert;
aAngebot[1].xGrundVorrang := diNb < diNenn;

(* --- Ausgabe: die Grenze nach Nennleistung auf die Wechselrichter ------------------------- *)
FOR n := 1 TO uiTeAnzahl DO
    IF udiNennW > 0 THEN
        audiSollW[n] := DINT_TO_UDINT(diGrenze) / 1000 * UINT_TO_UDINT(auiNennKw[n]) * 1000 / (udiNennW / 1000);
    END_IF
    astEinheit[n].xSollwertGueltig := TRUE;
    astEinheit[n].udiPSollW := audiSollW[n];
    astEinheit[n].uiArt := 1;
    astEinheit[n].uiNennKw := auiNennKw[n];
END_FOR

(* --- Erzeuger-Bild: was gilt und wer es bestimmt ------------------------------------------- *)
stAnlage.uiInstalliertKw := UDINT_TO_UINT(udiNennW / 1000);
stAnlage.xHandOrt := xHandOrt;
stAnlage.xSammelstoerung := xStoerung;
stNb.uiKanal := 3;
stNb.xVorgabeGueltig := xNbVorgabe;
stNb.uiPZehntelProzent := uiNbZehntelProzent;
stWirkung.xGueltig := TRUE;
stWirkung.udiGrenzeW := DINT_TO_UDINT(diGrenze);
IF diNb < diNenn AND diNb <= diGrenze THEN
    stWirkung.uiQuelle := 1;   (* netzbetreiber *)
ELSE
    stWirkung.uiQuelle := 0;   (* keine Stelle des Erzeuger-Bilds; der Wunsch steht in der Quittung *)
END_IF
fbBild(udiSteuerungId := udiSteuerungId, uiProgrammstand := uiProgrammstand, uiAnlagenart := 1,
    uiTeAnzahl := uiTeAnzahl, stAnlage := stAnlage, stNetzbetreiber := stNb, stDirektvermarkter := stDv,
    stWirkung := stWirkung, astEinheit := astEinheit, xMitNamen := FALSE, aBild := GVL_VoltPilot.aErzeugerBild);
END_PROGRAM
