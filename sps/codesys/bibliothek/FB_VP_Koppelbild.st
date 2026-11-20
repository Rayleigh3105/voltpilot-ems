(*
 * VoltPilot-Bibliothek · Baustein Koppelbild
 *
 * Die SPS-Seite des "VoltPilot-Koppelbild v1" (docs/contracts/v2/koppelbild.md): die Edge schreibt
 * Wünsche in die Halteregister 0..63, der Baustein prüft sie, begrenzt jeden auf das Angebot und
 * reicht ihn dem Anlagenprogramm; die Quittung steht in den Eingangsregistern 1000..1115.
 * Die SPS entscheidet immer selbst: ein Wunsch ist nie ein Befehl.
 *
 * Aufruf: einmal je Zyklus in der Task, die die Abbilder auch dem Modbus-Server übergibt.
 *
 *   fbKoppel(udiSteuerungId := 1042, xFernsteuerungFrei := xSchluesselFern, xHandOrt := xHand,
 *            aAngebot := aAngebot, aRueckmeldung := aRueck,
 *            aWunschRegister := GVL_VoltPilot.aKoppelWunsch,
 *            aQuittungRegister := GVL_VoltPilot.aKoppelQuittung);
 *   IF fbKoppel.aWunsch[1].xGilt THEN diGrenze := MIN(diGrenze, fbKoppel.aWunsch[1].diWert); END_IF
 *
 * Was der Baustein selbst hält:
 *   - jeder Wunsch läuft von selbst ab: höchstens frist_s ab Empfang, nie länger als tHoechsteFrist
 *     (Vorgabe 60 s); fällt die Edge aus, fährt die Anlage danach mit eigenen Werten;
 *   - Lebenszeichen: Herzschlag +1 je Sekunde (wie im Erzeuger-Bild), edge_lebt aus dem letzten
 *     gültigen Telegramm;
 *   - geprüft wird nur ein Telegramm, dessen Wörter sich geändert haben, in der Reihenfolge von
 *     Vertrag §5; ein abgelehntes bewirkt nichts, das vorige gilt bis zu seiner Frist;
 *   - Hand/Ort nimmt jedem Stellplatz die Bereitschaft; ohne Fernsteuerung gilt kein Wunsch.
 *
 * Was beim ersten Aufruf in den Halteregistern steht, ist kein Telegramm, nur der Vergleichsstand.
 *)
FUNCTION_BLOCK FB_VP_Koppelbild
VAR_INPUT
    (* von VoltPilot vergeben, gleich der im Erzeuger-Bild; 0 = Grundprogramm ohne Anlage *)
    udiSteuerungId     : UDINT;
    (* die Anlage lässt Wünsche zu (Schlüsselschalter, Betriebsart) *)
    xFernsteuerungFrei : BOOL;
    (* die Anlage steht vor Ort auf Hand *)
    xHandOrt           : BOOL;
    aAngebot           : ARRAY[1..8] OF ST_VP_Angebot;
    aRueckmeldung      : ARRAY[1..8] OF ST_VP_Rueckmeldung;
    (* längste Frist eines Telegramms, gleich was die Edge verlangt *)
    tHoechsteFrist     : TIME := T#60S;
    (* Fassung dieser Bibliothek, 16#HHNN *)
    uiBibliothek       : UINT := 16#0100;
END_VAR
VAR_OUTPUT
    aWunsch      : ARRAY[1..8] OF ST_VP_Wunsch;
    xEdgeLebt    : BOOL;
    (* kopf_urteil wie im Bild: 0 keins, 1 angenommen, 2 signatur_fremd, 3 version_fremd,
       4 wortfolge_falsch, 5 siegel_falsch, 6 steuerung_fremd, 7 kopf_ungueltig, 8 abgelaufen, 9 gesperrt *)
    uiKopfUrteil : UINT;
    uiRestS      : UINT;
END_VAR
VAR_IN_OUT
    aWunschRegister   : T_VP_KoppelWunsch;
    aQuittungRegister : T_VP_KoppelQuittung;
END_VAR
VAR
    uiHerzschlag  : UINT;
    xGestartet    : BOOL;
    tLetzte       : TIME;
    tJetzt        : TIME;
    udiSekunden   : UDINT;
    xErster       : BOOL := TRUE;
    aLetzte       : T_VP_KoppelWunsch;
    aGilt         : T_VP_KoppelWunsch;
    xHatTelegramm : BOOL;
    xFristLaeuft  : BOOL;
    (* warum keine Frist läuft: 0 nie eine, 1 abgelaufen, 2 gesperrt *)
    uiOhneFrist   : UINT;
    tAnnahme      : TIME;
    udiFristMs    : UDINT;
    udiSeitMs     : UDINT;
    xLebt         : BOOL;
    uiQSitzung    : UINT;
    uiQHerzschlag : UINT;
    uiAngenommen  : UINT;
    uiAbgelehnt   : UINT;
    xGeaendert    : BOOL;
    uiGrund       : UINT;
    udiFrist      : UDINT;
    i             : UINT;
    n             : UINT;
    uiW           : UINT;
    uiQ           : UINT;
    uiAnzahl      : UINT;
    xLeer         : BOOL;
    xBereit       : BOOL;
    uiArtW        : UINT;
    diW           : DINT;
    diWert        : DINT;
    uiUrteil      : UINT;
END_VAR

(* --- Herzschlag: +1 je Sekunde seit Programmstart, 65535 -> 0 ------------------------------ *)
tJetzt := TIME();
IF NOT xGestartet THEN
    tLetzte := tJetzt;
    xGestartet := TRUE;
END_IF
udiSekunden := TIME_TO_UDINT(tJetzt - tLetzte) / 1000;
IF udiSekunden > 0 THEN
    uiHerzschlag := uiHerzschlag + UDINT_TO_UINT(udiSekunden AND 16#FFFF);
    tLetzte := tLetzte + UDINT_TO_TIME(udiSekunden * 1000);
END_IF

(* --- Telegramm prüfen, wenn sich ein Wort geändert hat (Vertrag §5) ------------------------- *)
IF xErster THEN
    aLetzte := aWunschRegister;
    xErster := FALSE;
ELSE
    xGeaendert := FALSE;
    FOR i := 0 TO 63 DO
        IF aWunschRegister[i] <> aLetzte[i] THEN
            xGeaendert := TRUE;
        END_IF
    END_FOR
    IF xGeaendert THEN
        aLetzte := aWunschRegister;
        udiFrist := WORD_TO_UDINT(aWunschRegister[10]);
        uiGrund := 0;
        IF aWunschRegister[0] <> 16#5650 OR aWunschRegister[1] <> 16#4B57 THEN
            uiGrund := 2;
        ELSIF SHR(aWunschRegister[4], 8) <> 1 THEN
            uiGrund := 3;
        ELSIF aWunschRegister[2] <> 16#0102 OR aWunschRegister[3] <> 16#0304 THEN
            uiGrund := 4;
        ELSIF VP_KoppelSiegelW(aW := aWunschRegister) <> aWunschRegister[15] THEN
            uiGrund := 5;
        ELSIF VP_KoppelLiesU32(aW := aWunschRegister, uiAdresse := 8) <> udiSteuerungId THEN
            uiGrund := 6;
        ELSIF udiFrist < 5 OR udiFrist > 600 OR aWunschRegister[6] = 0 OR aWunschRegister[6] = 16#FFFF
                OR aWunschRegister[5] <> 8 THEN
            uiGrund := 7;
        END_IF
        IF uiGrund <> 0 THEN
            (* dieses Telegramm bewirkt nichts; das vorige gilt bis zu seiner Frist *)
            uiAbgelehnt := uiAbgelehnt + 1;
            uiKopfUrteil := uiGrund;
        ELSE
            aGilt := aWunschRegister;
            xHatTelegramm := TRUE;
            uiQSitzung := WORD_TO_UINT(aWunschRegister[6]);
            uiQHerzschlag := WORD_TO_UINT(aWunschRegister[7]);
            uiAngenommen := uiAngenommen + 1;
            tAnnahme := tJetzt;
            xLebt := TRUE;
            IF xFernsteuerungFrei THEN
                udiFristMs := MIN(udiFrist * 1000, TIME_TO_UDINT(tHoechsteFrist));
                xFristLaeuft := TRUE;
                uiKopfUrteil := 1;
            ELSE
                xFristLaeuft := FALSE;
                uiOhneFrist := 2;
                uiKopfUrteil := 9;
            END_IF
        END_IF
    END_IF
END_IF

(* --- Fernsteuerung entzogen: alle Wünsche fallen sofort ------------------------------------ *)
IF NOT xFernsteuerungFrei AND xFristLaeuft THEN
    xFristLaeuft := FALSE;
    uiOhneFrist := 2;
    uiKopfUrteil := 9;
END_IF

(* --- Frist: läuft von selbst ab ------------------------------------------------------------ *)
udiSeitMs := TIME_TO_UDINT(tJetzt - tAnnahme);
IF xFristLaeuft AND udiSeitMs >= udiFristMs THEN
    xFristLaeuft := FALSE;
    uiOhneFrist := 1;
    uiKopfUrteil := 8;
END_IF
IF xFristLaeuft THEN
    uiRestS := UDINT_TO_UINT((udiFristMs - udiSeitMs + 999) / 1000);
ELSE
    uiRestS := 0;
END_IF
(* einmal still, bleibt still: auch wenn TIME() nach 49 Tagen überläuft *)
IF xLebt AND udiSeitMs >= 15000 THEN
    xLebt := FALSE;
END_IF
xEdgeLebt := xLebt;

(* --- Kopf der Quittung (1000..1019, hier 0..19) -------------------------------------------- *)
aQuittungRegister[0] := 16#5650;   (* "VP" *)
aQuittungRegister[1] := 16#4B51;   (* "KQ" *)
VP_KoppelSetzeU32(aQ := aQuittungRegister, uiAdresse := 2, udiWert := 16#01020304);
aQuittungRegister[4] := 16#0100;   (* Fassung 1.0 *)
aQuittungRegister[6] := UINT_TO_WORD(uiHerzschlag);
aQuittungRegister[7] := UINT_TO_WORD(uiBibliothek);
VP_KoppelSetzeU32(aQ := aQuittungRegister, uiAdresse := 8, udiWert := udiSteuerungId);
aQuittungRegister[10] := UINT_TO_WORD(uiKopfUrteil);
aQuittungRegister[11] := UINT_TO_WORD(uiQSitzung);
aQuittungRegister[12] := UINT_TO_WORD(uiQHerzschlag);
aQuittungRegister[13] := UINT_TO_WORD(uiRestS);
aQuittungRegister[14] := VP_Bit(xGesetzt := xFernsteuerungFrei, uiBit := 0)
    OR VP_Bit(xGesetzt := xLebt, uiBit := 1) OR VP_Bit(xGesetzt := xHandOrt, uiBit := 2);
aQuittungRegister[15] := UINT_TO_WORD(uiAngenommen);
aQuittungRegister[16] := UINT_TO_WORD(uiAbgelehnt);
aQuittungRegister[17] := 0;
aQuittungRegister[18] := 0;

(* --- je Stellplatz: Angebot, Urteil, zugelassener Wert, wirksam (Vertrag §5) ---------------- *)
uiAnzahl := 0;
FOR n := 1 TO 8 DO
    uiW := 16 + (n - 1) * 6;
    uiQ := 20 + (n - 1) * 12;
    xLeer := aAngebot[n].uiArt = 0;
    xBereit := NOT xLeer AND aAngebot[n].xBereit AND NOT xHandOrt;
    uiUrteil := 0;
    diWert := 0;
    aWunsch[n].xGilt := FALSE;
    aWunsch[n].uiGrund := 0;
    IF NOT xLeer THEN
        uiAnzahl := uiAnzahl + 1;
    END_IF
    IF xHatTelegramm THEN
        uiArtW := WORD_TO_UINT(aGilt[uiW]);
        diW := UDINT_TO_DINT(SHL(WORD_TO_UDINT(aGilt[uiW + 2]), 16) OR WORD_TO_UDINT(aGilt[uiW + 3]));
        IF NOT xFristLaeuft THEN
            IF uiArtW <> 0 AND uiOhneFrist = 1 THEN
                uiUrteil := 7;
            ELSIF uiArtW <> 0 AND uiOhneFrist = 2 THEN
                uiUrteil := 5;
            END_IF
        ELSIF uiArtW = 0 THEN
            uiUrteil := 0;
        ELSIF xLeer OR uiArtW <> aAngebot[n].uiArt THEN
            uiUrteil := 3;
        ELSIF diW = 16#7FFFFFFF THEN
            uiUrteil := 4;
        ELSIF NOT xBereit THEN
            uiUrteil := 5;
        ELSE
            diWert := LIMIT(aAngebot[n].diMin, diW, aAngebot[n].diMax);
            IF aRueckmeldung[n].xUeberstimmt THEN
                uiUrteil := 6;
            ELSIF diWert <> diW THEN
                uiUrteil := 2;
            ELSE
                uiUrteil := 1;
            END_IF
            aWunsch[n].xGilt := TRUE;
            aWunsch[n].uiGrund := WORD_TO_UINT(aGilt[uiW + 1]);
        END_IF
        aQuittungRegister[uiQ + 9] := aGilt[uiW + 4];
    ELSE
        aQuittungRegister[uiQ + 9] := 0;
    END_IF
    aWunsch[n].diWert := diWert;
    aWunsch[n].uiUrteil := uiUrteil;
    aQuittungRegister[uiQ] := UINT_TO_WORD(aAngebot[n].uiArt);
    IF xLeer THEN
        aQuittungRegister[uiQ + 1] := 0;
        aQuittungRegister[uiQ + 2] := 0;
        aQuittungRegister[uiQ + 3] := 0;
    ELSE
        aQuittungRegister[uiQ + 1] := UINT_TO_WORD(aAngebot[n].uiZiel);
        aQuittungRegister[uiQ + 2] := UINT_TO_WORD(aAngebot[n].uiNr);
        aQuittungRegister[uiQ + 3] := VP_Bit(xGesetzt := xBereit, uiBit := 0)
            OR VP_Bit(xGesetzt := aAngebot[n].xGrundStoerung, uiBit := 1)
            OR VP_Bit(xGesetzt := aAngebot[n].xGrundHandOrt OR xHandOrt, uiBit := 2)
            OR VP_Bit(xGesetzt := aAngebot[n].xGrundWartung, uiBit := 3)
            OR VP_Bit(xGesetzt := aAngebot[n].xGrundVorrang, uiBit := 4)
            OR VP_Bit(xGesetzt := aAngebot[n].xGrundSonstiger, uiBit := 5);
    END_IF
    VP_KoppelSetzeS32(aQ := aQuittungRegister, uiAdresse := uiQ + 4, diWert := aAngebot[n].diMin, xBekannt := NOT xLeer);
    VP_KoppelSetzeS32(aQ := aQuittungRegister, uiAdresse := uiQ + 6, diWert := aAngebot[n].diMax, xBekannt := NOT xLeer);
    aQuittungRegister[uiQ + 8] := UINT_TO_WORD(uiUrteil);
    VP_KoppelSetzeS32(aQ := aQuittungRegister, uiAdresse := uiQ + 10, diWert := aRueckmeldung[n].diWirksam,
        xBekannt := aRueckmeldung[n].xWirksamBekannt);
END_FOR
aQuittungRegister[5] := UINT_TO_WORD(uiAnzahl);
aQuittungRegister[19] := VP_KoppelSiegelQ(aQ := aQuittungRegister);
END_FUNCTION_BLOCK
