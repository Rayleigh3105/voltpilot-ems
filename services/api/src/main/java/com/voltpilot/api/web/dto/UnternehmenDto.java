package com.voltpilot.api.web.dto;

import com.voltpilot.api.uems.StandortLesemodell.Adresse;

/**
 * Die Anfrage von {@code PUT /api/v1/unternehmen} (UEMS AP-02 IP-4). Die Antwort ist das
 * Unternehmen in der Form von {@code GET /api/v1/unternehmen}.
 */
public final class UnternehmenDto {
    private UnternehmenDto() {}

    /**
     * Die ganze Menge der bearbeitbaren Stammdaten (§4.1): Name (Pflicht, 1–120), Kurzname
     * (≤ 24, leer = keiner), Zeitzonen-Vorgabe (Pflicht), Sitz (optional, jedes Feld
     * einzeln; eine PLZ braucht ihr Land) und Rechtsform (≤ 40). Ein fehlendes Feld ist leer.
     */
    public record Bearbeiten(
            String name,
            String kurzname,
            String zeitzone,
            Adresse sitz,
            String rechtsform) {}
}
