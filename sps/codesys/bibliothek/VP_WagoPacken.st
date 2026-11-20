(*
 * VoltPilot-Bibliothek · Packfunktion des WAGO-Bilds
 *
 * Jeder 32-bit-Wert geht über VP_WagoSetze32 ins Bild - auch der Prüfwert 16#01020304 (Vertrag §3):
 * er bestätigt der Box die Wortfolge nur, wenn er durch dieselbe Routine geht wie die Messwerte.
 *
 * Wortfolge (Parameter je Anlage, Vertrag §2): FALSE = höherwertiges Wort zuerst ("big"),
 * TRUE = niederwertiges zuerst ("little"). Innerhalb eines Worts gilt die Modbus-Byte-Reihenfolge.
 *)

FUNCTION VP_WagoSetze32 : BOOL
VAR_IN_OUT
    aBild : T_VP_WagoBild;
END_VAR
VAR_INPUT
    uiAdresse : UINT;
    dwWert    : DWORD;
    xLittle   : BOOL;
END_VAR
IF xLittle THEN
    aBild[uiAdresse] := DWORD_TO_WORD(dwWert AND 16#FFFF);
    aBild[uiAdresse + 1] := DWORD_TO_WORD(SHR(dwWert, 16));
ELSE
    aBild[uiAdresse] := DWORD_TO_WORD(SHR(dwWert, 16));
    aBild[uiAdresse + 1] := DWORD_TO_WORD(dwWert AND 16#FFFF);
END_IF
VP_WagoSetze32 := TRUE;
END_FUNCTION
