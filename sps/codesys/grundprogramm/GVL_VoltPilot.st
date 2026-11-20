(*
 * Die Abbilder, die der Modbus-TCP-Server des Geräts ausliefert und annimmt. Im CODESYS-Projekt
 * liegt diese Liste unter der Applikation; das Gerät "Modbus TCP Server" bildet ab (README,
 * Abschnitt "Was nur in der IDE geht"):
 *   - Eingangsregister 0..331 auf aErzeugerBild (Funktionscode 4),
 *   - Eingangsregister 1000..1115 auf aKoppelQuittung (Funktionscode 4),
 *   - Eingangsregister 2000..2683 auf aWagoBild (Funktionscode 4), wo das Anlagenprogramm
 *     Energiekarten kopiert (FB_VP_WagoBild),
 *   - Halteregister 0..63 auf aKoppelWunsch (Funktionscode 16, nur die Edge schreibt).
 * xProbeLampe liegt auf dem Ausgang mit der Lampe am Gerät (Probe-Stellplatz 8).
 *)
VAR_GLOBAL
    aErzeugerBild   : T_VP_ErzeugerBild;
    aKoppelQuittung : T_VP_KoppelQuittung;
    aKoppelWunsch   : T_VP_KoppelWunsch;
    aWagoBild       : T_VP_WagoBild;
    xProbeLampe     : BOOL;
END_VAR
