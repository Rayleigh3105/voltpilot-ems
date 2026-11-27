package com.voltpilot.api.uems;

import java.sql.Date;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Trägt EINEN Auftrag „Wetter nachholen" je Anlage ein (vp-standort-konzept §6.6, B3; §7, E1 = B):
 * der Wetter-Collector (Python, {@code services/forecast}) liest die Tabelle als Mandanten-Backend
 * und erledigt sie — reiner Outbox-Eintrag, die api liest ihn nie zurück.
 */
@Repository
public class OrtWetterNachholungRepository {

    private final JdbcTemplate jdbc;

    public OrtWetterNachholungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** „Ort berichtigen" (B3): verwirft weiter ALLES gespeicherte Wetter, kein {@code ab_tag}. */
    public void anfordern(UUID tenantId, UUID siteId) {
        anfordern(tenantId, siteId, null);
    }

    /**
     * {@code abTag} gesetzt heißt Umzug (§7, E1 = B): der Nachholer behält das Wetter VOR diesem
     * Tag (am alten Punkt gelernt) und ersetzt nur ab dann durch das neue am neuen Punkt.
     */
    public void anfordern(UUID tenantId, UUID siteId, LocalDate abTag) {
        jdbc.update("INSERT INTO ort_wetter_nachholung (tenant_id, site_id, ab_tag) VALUES (?, ?, ?)",
                tenantId, siteId, abTag == null ? null : Date.valueOf(abTag));
    }
}
