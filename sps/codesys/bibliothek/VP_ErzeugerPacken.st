(*
 * VoltPilot-Bibliothek · Packfunktionen des Erzeuger-Bilds
 *
 * Jede Zahl geht über genau eine dieser Funktionen ins Bild - auch der Prüfwert 16#01020304
 * (Vertrag §1, Lesart 9): schriebe das Programm ihn als zwei Konstanten, prüfte er seine
 * Packfunktion nicht, und ein falsch packendes Programm sähe gesund aus (Fall E5).
 *
 * Wortfolge: höherwertiges Wort zuerst. Ungültig: das Typ-Maximum, nie 0.
 *)

FUNCTION VP_SetzeU16 : BOOL
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    uiWert    : UINT;
    xBekannt  : BOOL;
END_VAR
IF xBekannt THEN
    aBild[uiAdresse] := UINT_TO_WORD(uiWert);
ELSE
    aBild[uiAdresse] := 16#FFFF;
END_IF
VP_SetzeU16 := xBekannt;
END_FUNCTION

FUNCTION VP_SetzeS16 : BOOL
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    iWert     : INT;
    xBekannt  : BOOL;
END_VAR
IF xBekannt THEN
    (* Zweierkomplement: INT_TO_WORD behält das Bitmuster *)
    aBild[uiAdresse] := INT_TO_WORD(iWert);
ELSE
    aBild[uiAdresse] := 16#7FFF;
END_IF
VP_SetzeS16 := xBekannt;
END_FUNCTION

FUNCTION VP_SetzeU32 : BOOL
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    udiWert   : UDINT;
    xBekannt  : BOOL;
END_VAR
IF xBekannt THEN
    aBild[uiAdresse] := UDINT_TO_WORD(SHR(udiWert, 16));
    aBild[uiAdresse + 1] := UDINT_TO_WORD(udiWert AND 16#FFFF);
ELSE
    aBild[uiAdresse] := 16#FFFF;
    aBild[uiAdresse + 1] := 16#FFFF;
END_IF
VP_SetzeU32 := xBekannt;
END_FUNCTION

FUNCTION VP_SetzeS32 : BOOL
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    diWert    : DINT;
    xBekannt  : BOOL;
END_VAR
IF xBekannt THEN
    (* Zweierkomplement über dieselbe Routine wie jeder 32-bit-Wert: DINT_TO_UDINT behält das Bitmuster *)
    VP_SetzeU32(aBild := aBild, uiAdresse := uiAdresse, udiWert := DINT_TO_UDINT(diWert), xBekannt := TRUE);
ELSE
    aBild[uiAdresse] := 16#7FFF;
    aBild[uiAdresse + 1] := 16#FFFF;
END_IF
VP_SetzeS32 := xBekannt;
END_FUNCTION

(* Ein Name: 16 Wörter = 32 Zeichen ISO 8859-1, höherwertiges Byte zuerst, mit 0 aufgefüllt (Vertrag §6). *)
FUNCTION VP_SetzeText : BOOL
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    sText     : STRING(32);
END_VAR
VAR
    iLaenge : INT;
    i       : INT;
    bHoch   : BYTE;
    bNieder : BYTE;
END_VAR
iLaenge := LEN(sText);
FOR i := 0 TO 15 DO
    bHoch := 0;
    bNieder := 0;
    (* Hinter dem Ende des Texts steht 0, nie ein Rest aus dem Speicher der Zeichenkette *)
    IF 2 * i < iLaenge THEN
        bHoch := sText[2 * i];
    END_IF
    IF 2 * i + 1 < iLaenge THEN
        bNieder := sText[2 * i + 1];
    END_IF
    aBild[uiAdresse + INT_TO_UINT(i)] := SHL(BYTE_TO_WORD(bHoch), 8) OR BYTE_TO_WORD(bNieder);
END_FOR
VP_SetzeText := iLaenge > 0;
END_FUNCTION

(* Ein Bit eines Bitfelds. *)
FUNCTION VP_Bit : WORD
VAR_INPUT
    xGesetzt : BOOL;
    uiBit    : UINT;
END_VAR
IF xGesetzt THEN
    VP_Bit := SHL(WORD#1, uiBit);
ELSE
    VP_Bit := 0;
END_IF
END_FUNCTION
