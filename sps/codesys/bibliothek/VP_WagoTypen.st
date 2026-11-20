(*
 * VoltPilot-Bibliothek · Datentypen des Bausteins WAGO-Bild (Energiekarten)
 *
 * Das Anlagenprogramm kopiert je 3-Phasen-Leistungsmessklemme 750-494/-495 („Energiekarte“) die
 * Werte, die es aus der Karte gelesen hat, in eine ST_VP_WagoKarte - unverändert, in der
 * Skalierung der Karte (docs/contracts/v2/wago-registerbild.md §4). Umgerechnet wird nichts:
 * Einheit, Faktor und Vorzeichen kommen aus dem Katalog und dem Hardwareblatt der Anlage.
 *
 * Jeder Teil hat sein Feld ...Gelesen: FALSE heißt "dieser Teil ist unbekannt", der Baustein
 * löscht dann das Gültigkeitsbit und schreibt das Typ-Maximum - nie 0, nie einen alten Wert.
 *)

(* Das Abbild: Kopf 12 Wörter und höchstens 16 Karten zu je 42 Wörtern (12 + 16 * 42 = 684). *)
TYPE T_VP_WagoBild : ARRAY[0..683] OF WORD;
END_TYPE

(* Eine Energiekarte (Vertrag §4). *)
TYPE ST_VP_WagoKarte :
STRUCT
    (* Position am Klemmenbus; 1 = erste Klemme rechts neben der Steuerung *)
    uiSteckplatz   : UINT;
    (* 494 oder 495 (Artikelnummer ohne "750-") *)
    uiKartentyp    : UINT;
    (* Teil 1 * 1000 + Teil 2: /000-001 -> 1, /025-001 -> 25001, ohne Variante -> 0 *)
    uiVariante     : UINT;
    (* Messwerte und Statuswörter stammen aus einem vollständigen Lesesatz der Karte;
       FALSE bei gezogener Karte oder Klemmenbusfehler *)
    xKarteGelesen  : BOOL;
    (* Kartenregister 32 (Rohwert, Bit 12..15 Anwenderskalierung) *)
    xKr32Gelesen   : BOOL;
    wKr32          : WORD;
    (* Kartenregister 35 (Rohwert, 0..6, Werkseinstellung 4) *)
    xKr35Gelesen   : BOOL;
    wKr35          : WORD;
    (* je Gruppe Statuswort 1 und erweiterte Statuswörter 1..3: Gruppe 1 = 0..3, 2 = 4..7, 3 = 8..11;
       Wort = Byte(2k) * 256 + Byte(2k+1) *)
    xStatusGelesen : BOOL;
    awStatus       : ARRAY[0..11] OF WORD;
    (* die zwölf Werte des Standardsatzes als Bitmuster der Karte (Vertrag §4.3, Nr. 1..12):
       1 Bezug, 2 Lieferung, 3..5 Wirkleistung L1..L3 (Int32), 6..8 Spannung, 9..11 Strom,
       12 Frequenz; ein Int32 steht im Zweierkomplement (DINT_TO_DWORD), ungültig ist das
       Typ-Maximum der Karte *)
    adwMesswert    : ARRAY[1..12] OF DWORD;
END_STRUCT
END_TYPE
