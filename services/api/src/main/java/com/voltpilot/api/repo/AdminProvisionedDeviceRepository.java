package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ProvisionedDeviceDto;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Write/list side of the provisioned-device registry for the platform-admin
 * API. Uses the {@code adminJdbcTemplate} ({@code voltpilot_admin}, BYPASSRLS)
 * like {@link TenantRepository}: the registry itself is global, but the claim
 * state joins the RLS-protected {@code device}/{@code tenant} tables across
 * all tenants - an operator-only view, reached solely from
 * {@code @PreAuthorize("hasRole('platform-admin')")} endpoints.
 */
@Repository
public class AdminProvisionedDeviceRepository {

    private static final String SELECT =
            "SELECT p.external_ref, p.kind, p.note, p.provisioned_at, t.name AS claimed_by "
                    + "FROM provisioned_device p "
                    + "LEFT JOIN device d ON d.external_ref = p.external_ref AND d.ausgebaut_am IS NULL "
                    + "LEFT JOIN tenant t ON t.id = d.tenant_id ";

    private final JdbcTemplate jdbc;

    public AdminProvisionedDeviceRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<ProvisionedDeviceDto> findAll() {
        return jdbc.query(SELECT + "ORDER BY p.provisioned_at DESC, p.external_ref",
                AdminProvisionedDeviceRepository::map);
    }

    public Optional<ProvisionedDeviceDto> find(String externalRef) {
        return jdbc.query(SELECT + "WHERE p.external_ref = ?",
                AdminProvisionedDeviceRepository::map, externalRef).stream().findFirst();
    }

    /**
     * Register a manufactured ID; a re-run of the same manufacturing batch is a
     * no-op (empty result), never an error - the caller answers 200 with the
     * existing entry.
     */
    public Optional<ProvisionedDeviceDto> insertIfAbsent(String externalRef, String kind, String note) {
        return jdbc.query(
                "INSERT INTO provisioned_device (external_ref, kind, note) VALUES (?, ?, ?) "
                        + "ON CONFLICT (external_ref) DO NOTHING "
                        + "RETURNING external_ref, kind, note, provisioned_at, NULL::text AS claimed_by",
                AdminProvisionedDeviceRepository::map,
                externalRef, kind, note).stream().findFirst();
    }

    /**
     * Remove a wrongly registered sticker ID from the registry. The caller has
     * already verified it is not claimed (a claimed entry answers 409 - the
     * device row would otherwise reference a gone registry entry).
     */
    public boolean delete(String externalRef) {
        return jdbc.update("DELETE FROM provisioned_device WHERE external_ref = ?", externalRef) > 0;
    }

    private static ProvisionedDeviceDto map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        String claimedBy = rs.getString("claimed_by");
        return new ProvisionedDeviceDto(
                rs.getString("external_ref"),
                rs.getString("kind"),
                rs.getString("note"),
                rs.getTimestamp("provisioned_at").toInstant(),
                claimedBy != null,
                claimedBy);
    }
}
