package com.voltpilot.ingest.provisioning;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;
import java.util.UUID;

/**
 * Plain-JDBC {@link DeviceDirectory} against the core {@code device} table.
 *
 * <p>Deliberately NOT a pooled Spring datasource: provisioning lookups happen at
 * device-boot rate (rare), and keeping the DB out of Spring's auto-configuration
 * means the ingest service still starts, stays healthy and keeps streaming
 * telemetry when the database is briefly unavailable - a failed lookup is just
 * logged by the caller and the device retries its hello.
 *
 * <p>Connects with the trusted backend credentials (compose passes the Postgres
 * superuser, the same pattern as the collectors): the lookup must be
 * cross-tenant because a hello carries no tenant, so the RLS-scoped app role
 * (default-deny without a tenant) cannot serve it.
 */
public class JdbcDeviceDirectory implements DeviceDirectory {

    private final String jdbcUrl;
    private final String username;
    private final String password;

    public JdbcDeviceDirectory(String jdbcUrl, String username, String password) {
        this.jdbcUrl = jdbcUrl;
        this.username = username;
        this.password = password;
    }

    @Override
    public Optional<DeviceIdentity> findByRef(String externalRef) {
        // An ausgebaut box (api migration V20260913150000) keeps its row and ref as the
        // provenance of its recordings; only the box that is not ausgebaut answers a hello.
        String sql = "SELECT tenant_id, site_id, id FROM device WHERE external_ref = ? AND ausgebaut_am IS NULL";
        try (Connection conn = DriverManager.getConnection(jdbcUrl, username, password);
                PreparedStatement stmt = conn.prepareStatement(sql)) {
            stmt.setString(1, externalRef);
            try (ResultSet rs = stmt.executeQuery()) {
                if (!rs.next()) {
                    return Optional.empty();
                }
                return Optional.of(new DeviceIdentity(
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getObject("id", UUID.class)));
            }
        } catch (SQLException e) {
            throw new IllegalStateException("device lookup failed: " + e.getMessage(), e);
        }
    }
}
