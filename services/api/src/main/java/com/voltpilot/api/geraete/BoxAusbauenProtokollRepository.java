package com.voltpilot.api.geraete;

import java.time.Instant;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Protokoll "Box ausbauen" des Plattform-Admins (vp-admin-box-ausbauen, Migration
 * V20261111200000). Schreibt mit GESETZTEM {@code TenantContext} über die RLS-gezäunte App-Rolle
 * (Mandantentrennung, Muster {@code BoxLoesenService}/{@code BoxEndgueltigLoeschenService}) - nie
 * über die BYPASSRLS-Rolle.
 */
@Repository
public class BoxAusbauenProtokollRepository {

    private final JdbcTemplate jdbc;

    public BoxAusbauenProtokollRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Eintrag(UUID tenantId, String tenantName, UUID siteId, String siteName, UUID deviceId,
            String externalRef, Instant verbundenAm, String ausgebautVonSub, String ausgebautVonName,
            String anlass, String anlassText) {
    }

    /** Idempotenz: dieselbe Geräte-ID wird nie zweimal protokolliert (uq_box_ausbauen_protokoll_device). */
    public record Protokolliert(UUID deviceId, Instant ausgebautAm, String anlass) {
    }

    public Protokolliert protokollieren(Eintrag e) {
        return jdbc.queryForObject(
                "INSERT INTO box_ausbauen_protokoll (tenant_id, tenant_name, site_id, site_name, device_id, "
                        + "external_ref, verbunden_am, ausgebaut_von_sub, ausgebaut_von_name, anlass, anlass_text) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "RETURNING device_id, ausgebaut_am, anlass",
                BoxAusbauenProtokollRepository::zeile,
                e.tenantId(), e.tenantName(), e.siteId(), e.siteName(), e.deviceId(), e.externalRef(),
                java.sql.Timestamp.from(e.verbundenAm()), e.ausgebautVonSub(), e.ausgebautVonName(), e.anlass(),
                e.anlassText());
    }

    private static Protokolliert zeile(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Protokolliert(rs.getObject("device_id", UUID.class), rs.getTimestamp("ausgebaut_am").toInstant(),
                rs.getString("anlass"));
    }
}
