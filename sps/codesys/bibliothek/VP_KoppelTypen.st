(*
 * VoltPilot-Bibliothek · Datentypen des Koppelbilds (docs/contracts/v2/koppelbild.md)
 *
 * Das Anlagenprogramm sieht keine Register: es trägt je Stellplatz ein Angebot ein, liest den
 * Wunsch am Ausgang des Bausteins und meldet zurück, was es wirklich anwendet.
 *
 * Codes (Vertrag §7):
 *   Art  0 keiner, 1 limit_w (W), 2 limit_pct (0,1 %), 3 setpoint_w (W, Speicher + lädt),
 *        4 on_off (0/1), 5 mode (1..8), 6 setpoint_c (0,1 °C)
 *   Ziel 1 erzeugung_gesamt, 2 erzeugungseinheit, 3 speicher, 4 verbraucher, 5 netzbezug,
 *        6 einspeisung, 7 probe
 *   Grund 0 keiner, 1 markt, 2 netz, 3 regel, 4 hand, 5 test
 *)

(* Abschnitt W: liegt auf den Halteregistern 0..63 des Modbus-TCP-Servers; nur die Edge schreibt. *)
TYPE T_VP_KoppelWunsch : ARRAY[0..63] OF WORD;
END_TYPE

(* Abschnitt Q: liegt auf den Eingangsregistern 1000..1115; nur der Baustein schreibt. *)
TYPE T_VP_KoppelQuittung : ARRAY[0..115] OF WORD;
END_TYPE

(* Was ein Stellplatz anbietet. uiArt 0 = Platz leer. Band in den Einheiten der Art. *)
TYPE ST_VP_Angebot :
STRUCT
    uiArt           : UINT;
    uiZiel          : UINT;
    uiNr            : UINT;
    diMin           : DINT;
    diMax           : DINT;
    (* der Stellplatz kann jetzt gestellt werden *)
    xBereit         : BOOL;
    (* Gründe für "nicht bereit"; Hand/Ort setzt der Baustein aus xHandOrt selbst *)
    xGrundStoerung  : BOOL;
    xGrundHandOrt   : BOOL;
    xGrundWartung   : BOOL;
    (* eine Stelle mit Vorrang bestimmt gerade (Netzbetreiber, Direktvermarkter, Schutz) *)
    xGrundVorrang   : BOOL;
    xGrundSonstiger : BOOL;
END_STRUCT
END_TYPE

(* Was das Anlagenprogramm für das Ziel eines Stellplatzes gerade anwendet, gleich woher es kommt. *)
TYPE ST_VP_Rueckmeldung :
STRUCT
    diWirksam       : DINT;
    (* FALSE: niemand begrenzt oder stellt gerade - im Bild steht dann das Typ-Maximum *)
    xWirksamBekannt : BOOL;
    (* eine Stelle mit Vorrang bestimmt statt des Wunschs *)
    xUeberstimmt    : BOOL;
END_STRUCT
END_TYPE

(* Der zugelassene Wunsch eines Stellplatzes. Ohne xGilt fährt das Anlagenprogramm mit eigenen Werten. *)
TYPE ST_VP_Wunsch :
STRUCT
    xGilt    : BOOL;
    (* auf das Band des Angebots begrenzt; 0, solange xGilt FALSE ist *)
    diWert   : DINT;
    (* Auskunft, keine Weiche *)
    uiGrund  : UINT;
    (* Urteil wie im Bild (q_urteil): 0 kein_wunsch, 1 angenommen, 2 begrenzt, 3 art_fremd,
       4 wert_ungueltig, 5 nicht_bereit, 6 ueberstimmt, 7 abgelaufen *)
    uiUrteil : UINT;
END_STRUCT
END_TYPE
