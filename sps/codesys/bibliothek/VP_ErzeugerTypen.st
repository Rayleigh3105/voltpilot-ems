(*
 * VoltPilot-Bibliothek · Datentypen des Bausteins Erzeuger-Bild
 *
 * Das Anlagenprogramm füllt diese Strukturen in den Einheiten der Felder des Vertrags
 * docs/contracts/v2/erzeuger-registerbild.md (W, kW, 0,1 %, 0,001, 0,1 kWh, s) und rechnet
 * keine Register: das tut FB_VP_ErzeugerBild.
 *
 * Ein Wert ohne deckendes Gültigkeitsbit hat ein eigenes Feld ...Bekannt: FALSE heißt
 * "kein Wert", der Baustein schreibt dann das Typ-Maximum (Vertrag §1: ungültig ist nie 0).
 * Ein gedeckter Wert braucht keines: ist sein Gültigkeitsbit FALSE, schreibt der Baustein das
 * Typ-Maximum selbst. Ausnahme ist uiPZehntelProzent (Vertrag §3, Wort 24): ohne gültige
 * Vorgabe steht dort der wirksame Ersatzwert.
 *)

(* Das Eingangsregister-Abbild: Bild 0..137, Namen ab 140 (höchstens 140 + 32 + 16 * 10 = 332 Wörter). *)
TYPE T_VP_ErzeugerBild : ARRAY[0..331] OF WORD;
END_TYPE

(* Abschnitt A: Anlage und Netzpunkt (Register 12..21). *)
TYPE ST_VP_ErzeugerAnlage :
STRUCT
    (* a_gueltig *)
    xNetzpunktGueltig   : BOOL;
    xNetzpunktBerechnet : BOOL;
    xNetzpunktTot       : BOOL;
    xErzeugungGueltig   : BOOL;
    xGasspeicherGueltig : BOOL;
    xGueltigBekannt     : BOOL := TRUE;
    (* a_alter_s: Alter der Netzpunkt-Messung in s *)
    uiAlterS            : UINT;
    xAlterBekannt       : BOOL := TRUE;
    (* p_nvp_w: W, + Bezug / - Einspeisung; gedeckt von xNetzpunktGueltig *)
    diPNetzpunktW       : DINT;
    (* p_erzeugung_w: W, + Erzeugung, Summe der Einheiten; gedeckt von xErzeugungGueltig *)
    diPErzeugungW       : DINT;
    (* anlage_zustand: 0 aus, 1 bereit, 2 läuft, 3 läuft begrenzt, 4 Störung, 5 Hand/Wartung, 6 Not-Aus *)
    uiZustand           : UINT;
    xZustandBekannt     : BOOL := TRUE;
    (* a_bits *)
    xNotAus             : BOOL;
    xNaSchutz           : BOOL;
    xSammelstoerung     : BOOL;
    xHandOrt            : BOOL;
    xWartung            : BOOL;
    xBitsBekannt        : BOOL := TRUE;
    (* speicher_fuellstand: 0,1 %; gedeckt von xGasspeicherGueltig *)
    uiSpeicherZehntelProzent : UINT;
    (* p_installiert_kw: installierte Leistung in kW *)
    uiInstalliertKw     : UINT;
    xInstalliertBekannt : BOOL := TRUE;
END_STRUCT
END_TYPE

(* Abschnitt N: Netzbetreiber (Register 22..27). *)
TYPE ST_VP_ErzeugerNetzbetreiber :
STRUCT
    (* n_kanal: 0 keiner, 1 feste Grenze, 2 Stufen, 3 Fernwirktechnik *)
    uiKanal               : UINT;
    xKanalBekannt         : BOOL := TRUE;
    (* n_bits *)
    xVorgabeGueltig       : BOOL;
    xVerbindungSteht      : BOOL;
    xWirkleistungBegrenzt : BOOL;
    xNotAus               : BOOL;
    xCosPhiVorgabe        : BOOL;
    xKennlinie            : BOOL;
    xBitsBekannt          : BOOL := TRUE;
    (* n_p_prozent: 0,1 %; ohne gültige Vorgabe der wirksame Ersatzwert (Vertrag §3) *)
    uiPZehntelProzent     : UINT;
    xPBekannt             : BOOL := TRUE;
    (* n_cosphi: 0,001, + übererregt / - untererregt; gedeckt von xVorgabeGueltig *)
    iCosPhiTausendstel    : INT;
    (* n_seit_s: s seit der letzten Vorgabe, höchstens 65534 *)
    uiSeitS               : UINT;
    xSeitBekannt          : BOOL := TRUE;
    (* n_zaehler: Vorgaben seit Programmstart, 65535 -> 0, kein Ungültig-Wert *)
    uiZaehler             : UINT;
END_STRUCT
END_TYPE

(* Abschnitt D: Direktvermarkter (Register 28..33). *)
TYPE ST_VP_ErzeugerDirektvermarkter :
STRUCT
    (* d_kanal: 0 keiner, 1 Relais und mA, 2 Modbus *)
    uiKanal           : UINT;
    xKanalBekannt     : BOOL := TRUE;
    (* d_bits *)
    xAbschnittGueltig : BOOL;
    xAktivierung      : BOOL;
    xStopp            : BOOL;
    xBereitGemeldet   : BOOL;
    xAktivGemeldet    : BOOL;
    xBitsBekannt      : BOOL := TRUE;
    (* d_soll_w, d_seit_s, d_zaehler: gedeckt von xAbschnittGueltig *)
    udiSollW          : UDINT;
    uiSeitS           : UINT;
    uiZaehler         : UINT;
END_STRUCT
END_TYPE

(* Abschnitt S: Wirkung (Register 34..37). *)
TYPE ST_VP_ErzeugerWirkung :
STRUCT
    (* s_bits *)
    xGueltig      : BOOL;
    xAnlageFolgt  : BOOL;
    xBitsBekannt  : BOOL := TRUE;
    (* quelle_p: 0 keine Grenze, 1 Netzbetreiber, 2 Direktvermarkter, 3 Netzpunkt-Regelung,
       4 Hand, 5 Not-Aus, 6 Ersatzwert; gedeckt von xGueltig *)
    uiQuelle      : UINT;
    (* p_grenze_w: wirksame Grenze in W; gedeckt von xGueltig *)
    udiGrenzeW    : UDINT;
END_STRUCT
END_TYPE

(* Abschnitt T: eine Einheit (Wechselrichter oder BHKW-Motor), 10 Wörter ab 38 + (n - 1) * 10. *)
TYPE ST_VP_ErzeugerEinheit :
STRUCT
    (* t_bits *)
    xWerteGueltig         : BOOL;
    xSollwertGueltig      : BOOL;
    xDvBereit             : BOOL;
    xDvAktiv              : BOOL;
    xGrundStoerung        : BOOL;
    xGrundNetzbetreiber   : BOOL;
    xGrundHandOrt         : BOOL;
    xGrundWartung         : BOOL;
    xGrundGasspeicherLeer : BOOL;
    xGrundSonstiger       : BOOL;
    xBitsBekannt          : BOOL := TRUE;
    (* t_zustand: Vokabular wie anlage_zustand; gedeckt von xWerteGueltig *)
    uiZustand             : UINT;
    (* t_art: 1 PV-Wechselrichter, 2 BHKW-Motor *)
    uiArt                 : UINT;
    xArtBekannt           : BOOL := TRUE;
    (* t_nenn_kw *)
    uiNennKw              : UINT;
    xNennBekannt          : BOOL := TRUE;
    (* t_p_ist_w: W, + Erzeugung; gedeckt von xWerteGueltig *)
    diPIstW               : DINT;
    (* t_p_soll_w: W; gedeckt von xSollwertGueltig *)
    udiPSollW             : UDINT;
    (* t_e: Zählerstand Erzeugung in 0,1 kWh; gedeckt von xWerteGueltig *)
    udiEZehntelKwh        : UDINT;
    (* t_typ_name: Hersteller und Typ, höchstens 32 Zeichen ISO 8859-1 *)
    sTyp                  : STRING(32);
END_STRUCT
END_TYPE
