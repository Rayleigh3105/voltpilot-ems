(*
 * VoltPilot-Bibliothek · Baustein WAGO-Bild (Energiekarten)
 *
 * Füllt das "VoltPilot-Registerbild WAGO v1" (Fassung 1.0, docs/contracts/v2/wago-registerbild.md)
 * aus den Werten der 3-Phasen-Leistungsmessklemmen 750-494/-495, die das Anlagenprogramm aus den
 * Karten liest: von außen kommt niemand an die Klemmen, ein Programm muss sie kopieren.
 * Das Abbild aBild liegt auf den Registern des Modbus-TCP-Servers ab der Basisadresse der Anlage;
 * für eine neue Anlage auf einem PFC200 mit VoltPilot sind das die Eingangsregister ab 2000
 * (Funktionscode 4), neben dem Erzeuger-Bild ab 0.
 *
 * Aufruf: einmal je Zyklus in der Task, die das Abbild auch dem Modbus-Server übergibt.
 *
 *   fbWago(udiControllerKennung := 1, uiKartenzahl := 2, astKarte := astKarte,
 *          aBild := GVL_VoltPilot.aWagoBild);
 *
 * Was der Baustein selbst hält:
 *   - Kopf: Signatur "VP" "RB", Fassung 1.0, Längen 12 und 42, der Prüfwert über VP_WagoSetze32;
 *   - Herzschlag: +1 je Sekunde seit Programmstart, 65535 -> 0 (Vertrag §3); bleibt der Aufruf
 *     aus, steht er, und die Box hält die Kartenwerte nach drei gleichen Lesungen für veraltet;
 *   - Gültigkeit: je Karte die Bits aus den Feldern ...Gelesen; ein unbekannter Teil steht als
 *     Typ-Maximum im Bild (Int32 16#7FFFFFFF, sonst 16#FFFF bzw. 16#FFFFFFFF), nie als 0;
 *   - Wörter von Karten über uiKartenzahl hinaus auf 0.
 *
 * Grenzen: höchstens 16 Karten. uiKartenzahl über 16 schreibt der Baustein, wie er sie bekommt,
 * füllt aber nur 16 Blöcke - die Box liest das Bild dann nicht (Kartenzahl weicht vom Soll ab
 * oder die Register fehlen), statt Karten zu erfinden.
 *)
FUNCTION_BLOCK FB_VP_WagoBild
VAR_INPUT
    (* vom Installateur gesetzte Zahl, die das Hardwareblatt erwartet; 0 = nicht gesetzt *)
    udiControllerKennung : UDINT;
    (* Wortfolge der Anlage: FALSE = big (höherwertiges Wort zuerst), TRUE = little *)
    xWortfolgeLittle     : BOOL;
    uiKartenzahl         : UINT;
    astKarte             : ARRAY[1..16] OF ST_VP_WagoKarte;
END_VAR
VAR_IN_OUT
    aBild : T_VP_WagoBild;
END_VAR
VAR
    uiHerzschlag : UINT;
    xGestartet   : BOOL;
    tLetzte      : TIME;
    tJetzt       : TIME;
    udiSekunden  : UDINT;
    n            : UINT;
    uiBasis      : UINT;
    i            : UINT;
    wBits        : WORD;
    dwUngueltig  : DWORD;
END_VAR

(* --- Herzschlag: +1 je Sekunde, beim Programmstart 0, 65535 -> 0 ---------------------------- *)
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

(* --- Kopf (0..11) ------------------------------------------------------------------------- *)
aBild[0] := 16#5650;   (* "VP" *)
aBild[1] := 16#5242;   (* "RB" *)
aBild[2] := 1;         (* Hauptversion *)
aBild[3] := 0;         (* Nebenversion *)
aBild[4] := 12;        (* Kopflänge *)
aBild[5] := 42;        (* Kartenblocklänge *)
aBild[6] := UINT_TO_WORD(uiKartenzahl);
aBild[7] := UINT_TO_WORD(uiHerzschlag);
VP_WagoSetze32(aBild := aBild, uiAdresse := 8, dwWert := 16#01020304, xLittle := xWortfolgeLittle);
VP_WagoSetze32(aBild := aBild, uiAdresse := 10, dwWert := UDINT_TO_DWORD(udiControllerKennung),
    xLittle := xWortfolgeLittle);

(* --- Karten: Block n beginnt bei 12 + (n - 1) * 42 ------------------------------------------ *)
FOR n := 1 TO 16 DO
    uiBasis := 12 + (n - 1) * 42;
    IF n > uiKartenzahl THEN
        FOR i := 0 TO 41 DO
            aBild[uiBasis + i] := 0;
        END_FOR
    ELSE
        aBild[uiBasis] := UINT_TO_WORD(astKarte[n].uiSteckplatz);
        aBild[uiBasis + 1] := UINT_TO_WORD(astKarte[n].uiKartentyp);
        aBild[uiBasis + 2] := UINT_TO_WORD(astKarte[n].uiVariante);
        wBits := 0;
        IF astKarte[n].xKarteGelesen THEN
            wBits := wBits OR 16#0001;
        END_IF
        IF astKarte[n].xKr32Gelesen THEN
            wBits := wBits OR 16#0002;
        END_IF
        IF astKarte[n].xKr35Gelesen THEN
            wBits := wBits OR 16#0004;
        END_IF
        IF astKarte[n].xStatusGelesen THEN
            wBits := wBits OR 16#0008;
        END_IF
        aBild[uiBasis + 3] := wBits;
        IF astKarte[n].xKr32Gelesen THEN
            aBild[uiBasis + 4] := astKarte[n].wKr32;
        ELSE
            aBild[uiBasis + 4] := 16#FFFF;
        END_IF
        IF astKarte[n].xKr35Gelesen THEN
            aBild[uiBasis + 5] := astKarte[n].wKr35;
        ELSE
            aBild[uiBasis + 5] := 16#FFFF;
        END_IF
        FOR i := 0 TO 11 DO
            IF astKarte[n].xStatusGelesen THEN
                aBild[uiBasis + 6 + i] := astKarte[n].awStatus[i];
            ELSE
                aBild[uiBasis + 6 + i] := 16#FFFF;
            END_IF
        END_FOR
        (* Messwerte ab Offset 18, je zwei Wörter, in der Wortfolge der Anlage *)
        FOR i := 1 TO 12 DO
            IF astKarte[n].xKarteGelesen THEN
                VP_WagoSetze32(aBild := aBild, uiAdresse := uiBasis + 16 + 2 * i,
                    dwWert := astKarte[n].adwMesswert[i], xLittle := xWortfolgeLittle);
            ELSE
                (* ungültig ist das Typ-Maximum des Felds: Wirkleistung L1..L3 sind Int32 *)
                IF i >= 3 AND i <= 5 THEN
                    dwUngueltig := 16#7FFFFFFF;
                ELSE
                    dwUngueltig := 16#FFFFFFFF;
                END_IF
                VP_WagoSetze32(aBild := aBild, uiAdresse := uiBasis + 16 + 2 * i,
                    dwWert := dwUngueltig, xLittle := xWortfolgeLittle);
            END_IF
        END_FOR
    END_IF
END_FOR
END_FUNCTION_BLOCK
