(*
 * VoltPilot-Bibliothek · Baustein Erzeuger-Bild
 *
 * Füllt das "VoltPilot-Registerbild Erzeuger v1" (schlanke Fassung 1.0,
 * docs/contracts/v2/erzeuger-registerbild.md) aus den getippten Werten des Anlagenprogramms.
 * Das Abbild aBild liegt auf den Eingangsregistern des Modbus-TCP-Servers ab Adresse 0
 * (Funktionscode 4); die Box liest es alle 5 s, auf einem PFC200 mit VoltPilot über 127.0.0.1.
 *
 * Aufruf: einmal je Zyklus in der Task, die das Abbild auch dem Modbus-Server übergibt.
 *
 *   fbBild(uiProgrammstand := 2611, uiAnlagenart := 1, uiTeAnzahl := 3,
 *          stAnlage := stAnlage, stNetzbetreiber := stNb, stDirektvermarkter := stDv,
 *          stWirkung := stWirkung, astEinheit := astEinheit, xMitNamen := TRUE,
 *          sNetzbetreiber := 'Netzbetreiber', sDirektvermarkter := '',
 *          aBild := GVL_VoltPilot.aErzeugerBild);
 *
 * Was der Baustein selbst hält:
 *   - Kopf: Signatur, Prüfwert, Fassung 1.0 - feste Werte, der Prüfwert über VP_SetzeU32;
 *   - Herzschlag: +1 je Sekunde seit Programmstart, 65535 -> 0 (Vertrag §8); bleibt der
 *     Aufruf aus, steht er, und die Box hält alle Werte nach drei gleichen Lesungen für veraltet;
 *   - Typ-Maximum für jeden gedeckten Wert, dessen Gültigkeitsbit fehlt;
 *   - Wörter von Einheiten über uiTeAnzahl hinaus und ohne Namen den Namenbereich auf 0.
 *
 * Grenzen: höchstens 10 Einheiten; uiTeAnzahl 0 oder über 10 schreibt der Baustein, wie er sie
 * bekommt - die Box liest das Bild dann nicht (te_anzahl_ungueltig), sieht aber Kopf und
 * Herzschlag (so meldet sich das Grundprogramm ohne Anlage).
 *)
FUNCTION_BLOCK FB_VP_ErzeugerBild
VAR_INPUT
    (* Kennung der Steuerung, von VoltPilot vergeben; ohne Kennung bleibt das Typ-Maximum *)
    udiSteuerungId     : UDINT := 16#FFFFFFFF;
    (* Stand des eingespielten Programms, JJMM; 16#FFFF = nicht gesetzt *)
    uiProgrammstand    : UINT := 16#FFFF;
    (* 1 PV, 2 BHKW, 3 gemischt; 16#FFFF = nicht gesetzt *)
    uiAnlagenart       : UINT := 16#FFFF;
    uiTeAnzahl         : UINT;
    stAnlage           : ST_VP_ErzeugerAnlage;
    stNetzbetreiber    : ST_VP_ErzeugerNetzbetreiber;
    stDirektvermarkter : ST_VP_ErzeugerDirektvermarkter;
    stWirkung          : ST_VP_ErzeugerWirkung;
    astEinheit         : ARRAY[1..10] OF ST_VP_ErzeugerEinheit;
    (* Namen ab Register 140; FALSE = keine Namen im Bild, man trägt sie im Portal ein *)
    xMitNamen          : BOOL;
    sNetzbetreiber     : STRING(32);
    sDirektvermarkter  : STRING(32);
END_VAR
VAR_IN_OUT
    aBild : T_VP_ErzeugerBild;
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
aBild[1] := 16#455A;   (* "EZ" *)
VP_SetzeU32(aBild := aBild, uiAdresse := 2, udiWert := 16#01020304, xBekannt := TRUE);
aBild[4] := 16#0100;   (* Fassung 1.0 *)
aBild[5] := UINT_TO_WORD(uiTeAnzahl);
aBild[6] := UINT_TO_WORD(uiHerzschlag);
aBild[7] := UINT_TO_WORD(uiProgrammstand);
VP_SetzeU32(aBild := aBild, uiAdresse := 8, udiWert := udiSteuerungId, xBekannt := TRUE);
aBild[10] := UINT_TO_WORD(uiAnlagenart);
IF xMitNamen THEN
    aBild[11] := 140;
ELSE
    aBild[11] := 0;
END_IF

(* --- A: Anlage und Netzpunkt (12..21) ------------------------------------------------------ *)
wBits := VP_Bit(stAnlage.xNetzpunktGueltig, 0) OR VP_Bit(stAnlage.xNetzpunktBerechnet, 1)
    OR VP_Bit(stAnlage.xNetzpunktTot, 2) OR VP_Bit(stAnlage.xErzeugungGueltig, 3)
    OR VP_Bit(stAnlage.xGasspeicherGueltig, 4);
VP_SetzeU16(aBild := aBild, uiAdresse := 12, uiWert := WORD_TO_UINT(wBits), xBekannt := stAnlage.xGueltigBekannt);
VP_SetzeU16(aBild := aBild, uiAdresse := 13, uiWert := stAnlage.uiAlterS, xBekannt := stAnlage.xAlterBekannt);
VP_SetzeS32(aBild := aBild, uiAdresse := 14, diWert := stAnlage.diPNetzpunktW,
    xBekannt := stAnlage.xGueltigBekannt AND stAnlage.xNetzpunktGueltig);
VP_SetzeS32(aBild := aBild, uiAdresse := 16, diWert := stAnlage.diPErzeugungW,
    xBekannt := stAnlage.xGueltigBekannt AND stAnlage.xErzeugungGueltig);
VP_SetzeU16(aBild := aBild, uiAdresse := 18, uiWert := stAnlage.uiZustand, xBekannt := stAnlage.xZustandBekannt);
wBits := VP_Bit(stAnlage.xNotAus, 0) OR VP_Bit(stAnlage.xNaSchutz, 1) OR VP_Bit(stAnlage.xSammelstoerung, 2)
    OR VP_Bit(stAnlage.xHandOrt, 3) OR VP_Bit(stAnlage.xWartung, 4);
VP_SetzeU16(aBild := aBild, uiAdresse := 19, uiWert := WORD_TO_UINT(wBits), xBekannt := stAnlage.xBitsBekannt);
VP_SetzeU16(aBild := aBild, uiAdresse := 20, uiWert := stAnlage.uiSpeicherZehntelProzent,
    xBekannt := stAnlage.xGueltigBekannt AND stAnlage.xGasspeicherGueltig);
VP_SetzeU16(aBild := aBild, uiAdresse := 21, uiWert := stAnlage.uiInstalliertKw, xBekannt := stAnlage.xInstalliertBekannt);

(* --- N: Netzbetreiber (22..27) ------------------------------------------------------------- *)
VP_SetzeU16(aBild := aBild, uiAdresse := 22, uiWert := stNetzbetreiber.uiKanal, xBekannt := stNetzbetreiber.xKanalBekannt);
wBits := VP_Bit(stNetzbetreiber.xVorgabeGueltig, 0) OR VP_Bit(stNetzbetreiber.xVerbindungSteht, 1)
    OR VP_Bit(stNetzbetreiber.xWirkleistungBegrenzt, 2) OR VP_Bit(stNetzbetreiber.xNotAus, 3)
    OR VP_Bit(stNetzbetreiber.xCosPhiVorgabe, 4) OR VP_Bit(stNetzbetreiber.xKennlinie, 5);
VP_SetzeU16(aBild := aBild, uiAdresse := 23, uiWert := WORD_TO_UINT(wBits), xBekannt := stNetzbetreiber.xBitsBekannt);
(* Wort 24 ohne gültige Vorgabe: der wirksame Ersatzwert, nicht das Typ-Maximum (Vertrag §3) *)
VP_SetzeU16(aBild := aBild, uiAdresse := 24, uiWert := stNetzbetreiber.uiPZehntelProzent, xBekannt := stNetzbetreiber.xPBekannt);
VP_SetzeS16(aBild := aBild, uiAdresse := 25, iWert := stNetzbetreiber.iCosPhiTausendstel,
    xBekannt := stNetzbetreiber.xBitsBekannt AND stNetzbetreiber.xVorgabeGueltig);
VP_SetzeU16(aBild := aBild, uiAdresse := 26, uiWert := stNetzbetreiber.uiSeitS, xBekannt := stNetzbetreiber.xSeitBekannt);
aBild[27] := UINT_TO_WORD(stNetzbetreiber.uiZaehler);

(* --- D: Direktvermarkter (28..33) ---------------------------------------------------------- *)
VP_SetzeU16(aBild := aBild, uiAdresse := 28, uiWert := stDirektvermarkter.uiKanal, xBekannt := stDirektvermarkter.xKanalBekannt);
wBits := VP_Bit(stDirektvermarkter.xAbschnittGueltig, 0) OR VP_Bit(stDirektvermarkter.xAktivierung, 1)
    OR VP_Bit(stDirektvermarkter.xStopp, 2) OR VP_Bit(stDirektvermarkter.xBereitGemeldet, 3)
    OR VP_Bit(stDirektvermarkter.xAktivGemeldet, 4);
VP_SetzeU16(aBild := aBild, uiAdresse := 29, uiWert := WORD_TO_UINT(wBits), xBekannt := stDirektvermarkter.xBitsBekannt);
VP_SetzeU32(aBild := aBild, uiAdresse := 30, udiWert := stDirektvermarkter.udiSollW,
    xBekannt := stDirektvermarkter.xBitsBekannt AND stDirektvermarkter.xAbschnittGueltig);
VP_SetzeU16(aBild := aBild, uiAdresse := 32, uiWert := stDirektvermarkter.uiSeitS,
    xBekannt := stDirektvermarkter.xBitsBekannt AND stDirektvermarkter.xAbschnittGueltig);
(* d_zaehler hat keinen Ungültig-Wert; ohne gültigen Abschnitt liest ihn die Box nicht *)
aBild[33] := UINT_TO_WORD(stDirektvermarkter.uiZaehler);

(* --- S: Wirkung (34..37) ------------------------------------------------------------------- *)
VP_SetzeU16(aBild := aBild, uiAdresse := 34, uiWert := stWirkung.uiQuelle,
    xBekannt := stWirkung.xBitsBekannt AND stWirkung.xGueltig);
wBits := VP_Bit(stWirkung.xGueltig, 0) OR VP_Bit(stWirkung.xAnlageFolgt, 1);
VP_SetzeU16(aBild := aBild, uiAdresse := 35, uiWert := WORD_TO_UINT(wBits), xBekannt := stWirkung.xBitsBekannt);
VP_SetzeU32(aBild := aBild, uiAdresse := 36, udiWert := stWirkung.udiGrenzeW,
    xBekannt := stWirkung.xBitsBekannt AND stWirkung.xGueltig);

(* --- T: je Einheit 10 Wörter ab 38 + (n - 1) * 10 ------------------------------------------ *)
FOR n := 1 TO 10 DO
    uiBasis := 38 + (n - 1) * 10;
    IF n <= uiTeAnzahl THEN
        VP_SetzeU16(aBild := aBild, uiAdresse := uiBasis, uiWert := astEinheit[n].uiZustand,
            xBekannt := astEinheit[n].xBitsBekannt AND astEinheit[n].xWerteGueltig);
        wBits := VP_Bit(astEinheit[n].xWerteGueltig, 0) OR VP_Bit(astEinheit[n].xSollwertGueltig, 1)
            OR VP_Bit(astEinheit[n].xDvBereit, 2) OR VP_Bit(astEinheit[n].xDvAktiv, 3)
            OR VP_Bit(astEinheit[n].xGrundStoerung, 4) OR VP_Bit(astEinheit[n].xGrundNetzbetreiber, 5)
            OR VP_Bit(astEinheit[n].xGrundHandOrt, 6) OR VP_Bit(astEinheit[n].xGrundWartung, 7)
            OR VP_Bit(astEinheit[n].xGrundGasspeicherLeer, 8) OR VP_Bit(astEinheit[n].xGrundSonstiger, 9);
        VP_SetzeU16(aBild := aBild, uiAdresse := uiBasis + 1, uiWert := WORD_TO_UINT(wBits),
            xBekannt := astEinheit[n].xBitsBekannt);
        VP_SetzeU16(aBild := aBild, uiAdresse := uiBasis + 2, uiWert := astEinheit[n].uiArt,
            xBekannt := astEinheit[n].xArtBekannt);
        VP_SetzeU16(aBild := aBild, uiAdresse := uiBasis + 3, uiWert := astEinheit[n].uiNennKw,
            xBekannt := astEinheit[n].xNennBekannt);
        VP_SetzeS32(aBild := aBild, uiAdresse := uiBasis + 4, diWert := astEinheit[n].diPIstW,
            xBekannt := astEinheit[n].xBitsBekannt AND astEinheit[n].xWerteGueltig);
        VP_SetzeU32(aBild := aBild, uiAdresse := uiBasis + 6, udiWert := astEinheit[n].udiPSollW,
            xBekannt := astEinheit[n].xBitsBekannt AND astEinheit[n].xSollwertGueltig);
        VP_SetzeU32(aBild := aBild, uiAdresse := uiBasis + 8, udiWert := astEinheit[n].udiEZehntelKwh,
            xBekannt := astEinheit[n].xBitsBekannt AND astEinheit[n].xWerteGueltig);
    ELSE
        (* frei: nichts Altes aus einer früheren Zahl der Einheiten bleibt stehen *)
        FOR i := uiBasis TO uiBasis + 9 DO
            aBild[i] := 0;
        END_FOR
    END_IF
END_FOR
FOR i := 138 TO 139 DO
    aBild[i] := 0;
END_FOR

(* --- Namen ab 140: Netzbetreiber +0, Direktvermarkter +16, Typ der Einheit n +32 + (n - 1) * 16 *)
IF xMitNamen THEN
    VP_SetzeText(aBild := aBild, uiAdresse := 140, sText := sNetzbetreiber);
    VP_SetzeText(aBild := aBild, uiAdresse := 156, sText := sDirektvermarkter);
    FOR n := 1 TO 10 DO
        IF n <= uiTeAnzahl THEN
            VP_SetzeText(aBild := aBild, uiAdresse := 172 + (n - 1) * 16, sText := astEinheit[n].sTyp);
        ELSE
            VP_SetzeText(aBild := aBild, uiAdresse := 172 + (n - 1) * 16, sText := '');
        END_IF
    END_FOR
ELSE
    FOR i := 140 TO 331 DO
        aBild[i] := 0;
    END_FOR
END_IF
END_FUNCTION_BLOCK
