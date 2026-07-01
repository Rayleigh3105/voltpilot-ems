package com.voltpilot.api.repo;

import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Read-side of the provisioned-device registry for the customer claim path.
 * The registry holds the manufactured sticker Geräte-IDs (global, no tenant,
 * no RLS - ownership is established later by the claim); the app role has
 * SELECT only, writes go through {@link AdminProvisionedDeviceRepository}.
 */
@Repository
public class ProvisionedDeviceRepository {

    private final JdbcTemplate jdbc;

    public ProvisionedDeviceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The provisioned kind for this sticker ID, or empty when the ID is unknown. */
    public Optional<String> findKind(String externalRef) {
        return jdbc.query(
                "SELECT kind FROM provisioned_device WHERE external_ref = ?",
                (rs, rowNum) -> rs.getString("kind"),
                externalRef).stream().findFirst();
    }
}
