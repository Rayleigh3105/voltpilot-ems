(*
 * Das Abbild, das der Modbus-TCP-Server des Geräts als Eingangsregister ab Adresse 0 ausliefert
 * (Funktionscode 4). Im CODESYS-Projekt liegt diese Liste unter der Applikation; das Gerät
 * "Modbus TCP Server" bildet seine Eingangsregister 0..331 auf aErzeugerBild ab (README,
 * Abschnitt "Was nur in der IDE geht").
 *)
VAR_GLOBAL
    aErzeugerBild : T_VP_ErzeugerBild;
END_VAR
