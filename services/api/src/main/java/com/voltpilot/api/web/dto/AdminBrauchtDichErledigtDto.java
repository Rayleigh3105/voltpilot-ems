package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * „Braucht dich" einzeln auf erledigt setzen (Plattform-Übersicht, Scheibe
 * S4): die erledigten Einträge, serverseitig und plattformweit abgelegt.
 */
public record AdminBrauchtDichErledigtDto(List<Eintrag> erledigt) {

    public record Eintrag(String schluessel, String stand, Instant erledigtAm, String erledigtVon) {
    }

    /** Eine oder mehrere Zeilen in einem Aufruf erledigen (z. B. „alle dieser Art"). */
    public record ErledigenRequest(List<Zeile> eintraege) {
        public record Zeile(String schluessel, String stand) {
        }
    }
}
