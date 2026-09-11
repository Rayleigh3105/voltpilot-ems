package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.voltpilot.api.uems.StandortLesemodell.StandortBezug;

/**
 * {@code GET /api/v1/sites/{siteId}}: genau die Felder von {@link SiteDto} —
 * flach, in derselben Reihenfolge, zeichengleich zu Liste und {@code PUT} —
 * plus, additiv am Ende, der {@code standort} der Anlage heute (UEMS AP-02
 * IP-3): {@code {id, name, kurzzeichen, gueltigAb}} oder {@code null}, solange
 * sie keinem Standort zugeordnet ist (heute jede Bestandsanlage — die
 * Zuordnung legt erst die Bestandsübernahme IP-9 an).
 */
public record SiteDetailDto(@JsonUnwrapped SiteDto site, StandortBezug standort) {
}
