package com.voltpilot.api.uems;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Trägt EINEN Auftrag „Wetter nachholen" je Anlage ein (vp-standort-konzept §6.6, B3): der
 * Wetter-Collector (Python, {@code services/forecast}) liest die Tabelle als Mandanten-Backend
 * und erledigt sie — reiner Outbox-Eintrag, die api liest ihn nie zurück.
 */
@Repository
public class OrtWetterNachholungRepository {

    private final JdbcTemplate jdbc;

    public OrtWetterNachholungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void anfordern(UUID tenantId, UUID siteId) {
        jdbc.update("INSERT INTO ort_wetter_nachholung (tenant_id, site_id) VALUES (?, ?)", tenantId, siteId);
    }
}
