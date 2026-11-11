package com.voltpilot.api.geraete;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der RLS-gezäunte Teil von „Endgültig löschen" (vp-box-endgueltig-loeschen): das Protokoll, mit
 * GESETZTEM {@link com.voltpilot.api.tenant.TenantContext} über die normale App-Rolle geschrieben -
 * Mandantentrennung wie {@link BoxLoesenRepository}, nie über die BYPASSRLS-Rolle. Der Befund davor
 * (über jeden Mandanten) kommt aus {@link AdminBoxEndgueltigRepository}.
 */
@Repository
public class BoxEndgueltigRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BoxEndgueltigRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Was ins Protokoll kommt: Kennung, Kunde/Anlage zum Zeitpunkt, wer, wann (Spec Punkt 3). */
    public record Eintrag(UUID tenantId, String tenantName, UUID siteId, String siteName, UUID deviceId,
            String externalRef, Instant verbundenAm, Instant ausgebautAm, String geloeschtVonSub,
            String geloeschtVonName, List<String> geprueft) {
    }

    public Instant protokollieren(Eintrag e) {
        return jdbc.queryForObject("INSERT INTO box_endgueltig_geloescht_protokoll "
                        + "(tenant_id, tenant_name, site_id, site_name, device_id, external_ref, "
                        + "verbunden_am, ausgebaut_am, geloescht_von_sub, geloescht_von_name, befund) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING geloescht_am",
                (rs, n) -> rs.getTimestamp(1).toInstant(),
                e.tenantId(), e.tenantName(), e.siteId(), e.siteName(), e.deviceId(), e.externalRef(),
                Timestamp.from(e.verbundenAm()), Timestamp.from(e.ausgebautAm()),
                e.geloeschtVonSub(), e.geloeschtVonName(), befundJson(e.geprueft()));
    }

    private String befundJson(List<String> geprueft) {
        try {
            return json.writeValueAsString(java.util.Map.of(
                    "keineDatenIn", geprueft,
                    "regel", "BoxDatenBestand"));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
