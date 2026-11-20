(*
 * VoltPilot-Bibliothek · Packen, Lesen und Siegel des Koppelbilds
 *
 * Wortfolge wie im Erzeuger-Bild: höherwertiges Wort zuerst; ungültig ist das Typ-Maximum.
 * Auch der Prüfwert 16#01020304 der Quittung geht über VP_KoppelSetzeU32 (Vertrag §1).
 *)

FUNCTION VP_KoppelSetzeU32 : BOOL
VAR_IN_OUT
    aQ : T_VP_KoppelQuittung;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    udiWert   : UDINT;
END_VAR
aQ[uiAdresse] := UDINT_TO_WORD(SHR(udiWert, 16));
aQ[uiAdresse + 1] := UDINT_TO_WORD(udiWert AND 16#FFFF);
VP_KoppelSetzeU32 := TRUE;
END_FUNCTION

FUNCTION VP_KoppelSetzeS32 : BOOL
VAR_IN_OUT
    aQ : T_VP_KoppelQuittung;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    diWert    : DINT;
    xBekannt  : BOOL;
END_VAR
IF xBekannt THEN
    (* Zweierkomplement: DINT_TO_UDINT behält das Bitmuster *)
    VP_KoppelSetzeU32(aQ := aQ, uiAdresse := uiAdresse, udiWert := DINT_TO_UDINT(diWert));
ELSE
    aQ[uiAdresse] := 16#7FFF;
    aQ[uiAdresse + 1] := 16#FFFF;
END_IF
VP_KoppelSetzeS32 := xBekannt;
END_FUNCTION

(* Ein 32-bit-Wert aus zwei Wörtern des Wunschs, höherwertiges Wort zuerst. *)
FUNCTION VP_KoppelLiesU32 : UDINT
VAR_IN_OUT
    aW : T_VP_KoppelWunsch;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
END_VAR
VP_KoppelLiesU32 := SHL(WORD_TO_UDINT(aW[uiAdresse]), 16) OR WORD_TO_UDINT(aW[uiAdresse + 1]);
END_FUNCTION

(* Ein Wort in die CRC-16/MODBUS (Polynom 16#A001 gespiegelt): erst das höherwertige Byte. *)
FUNCTION VP_KoppelCrcWort : WORD
VAR_INPUT
    wCrc  : WORD;
    wWort : WORD;
END_VAR
VAR
    wC    : WORD;
    wByte : WORD;
    k     : INT;
    i     : INT;
END_VAR
wC := wCrc;
FOR k := 0 TO 1 DO
    IF k = 0 THEN
        wByte := SHR(wWort, 8);
    ELSE
        wByte := wWort AND 16#00FF;
    END_IF
    wC := wC XOR wByte;
    FOR i := 1 TO 8 DO
        IF (wC AND 16#0001) <> 0 THEN
            wC := SHR(wC, 1) XOR 16#A001;
        ELSE
            wC := SHR(wC, 1);
        END_IF
    END_FOR
END_FOR
VP_KoppelCrcWort := wC;
END_FUNCTION

(* Siegel des Wunschs: über die Wörter 0..14 und 16..63 (Vertrag §8). *)
FUNCTION VP_KoppelSiegelW : WORD
VAR_IN_OUT
    aW : T_VP_KoppelWunsch;
END_VAR
VAR
    wC : WORD;
    i  : UINT;
END_VAR
wC := 16#FFFF;
FOR i := 0 TO 63 DO
    IF i <> 15 THEN
        wC := VP_KoppelCrcWort(wCrc := wC, wWort := aW[i]);
    END_IF
END_FOR
VP_KoppelSiegelW := wC;
END_FUNCTION

(* Siegel der Quittung: über die Wörter 1000..1018 und 1020..1115, hier 0..18 und 20..115. *)
FUNCTION VP_KoppelSiegelQ : WORD
VAR_IN_OUT
    aQ : T_VP_KoppelQuittung;
END_VAR
VAR
    wC : WORD;
    i  : UINT;
END_VAR
wC := 16#FFFF;
FOR i := 0 TO 115 DO
    IF i <> 19 THEN
        wC := VP_KoppelCrcWort(wCrc := wC, wWort := aQ[i]);
    END_IF
END_FOR
VP_KoppelSiegelQ := wC;
END_FUNCTION
