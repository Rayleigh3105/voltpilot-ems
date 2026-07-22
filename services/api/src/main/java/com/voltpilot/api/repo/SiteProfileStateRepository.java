package com.voltpilot.api.repo;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The per-Anlage Modus-Profil INTENT (Portal v3 M3, migration
 * V20260723000000): which profiles the customer switched on / off. Exactly two
 * states, {@code an} and {@code aus} - there is no "angefragt" (the owner
 * decided every profile is a direct customer toggle).
 *
 * <p>Only the INTENT lives here; the derivation stays the single truth. No row
 * for a profile means "derived default", which is why an untouched plant
 * behaves byte-identically to before M3.
 *
 * <p>RLS-scoped through the {@code @Primary} tenant-aware {@link JdbcTemplate}
 * like every customer repo - never the BYPASSRLS admin template.
 */
@Repository
public class SiteProfileStateRepository {

    public static final String STATE_AN = "an";
    public static final String STATE_AUS = "aus";

    private final JdbcTemplate jdbc;

    public SiteProfileStateRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The stored states of a site, keyed by profile id (empty = all derived). */
    public Map<String, String> findBySite(UUID siteId) {
        Map<String, String> states = new LinkedHashMap<>();
        jdbc.query("SELECT profile, state FROM site_profile_state WHERE site_id = ? "
                + "ORDER BY profile", rs -> {
                    states.put(rs.getString("profile"), rs.getString("state"));
                }, siteId);
        return states;
    }

    /**
     * Persist the customer's intent for one profile. The RLS {@code WITH CHECK}
     * guarantees the row lands in the caller's tenant; the primary key makes it
     * an upsert.
     */
    public void upsert(UUID tenantId, UUID siteId, String profile, String state) {
        jdbc.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id) "
                + "VALUES (?, ?, ?, ?) "
                + "ON CONFLICT (site_id, profile) DO UPDATE SET state = EXCLUDED.state, "
                + "updated_at = now()", siteId, profile, state, tenantId);
    }

    /** Drop the stored intent so the profile falls back to the derived default. */
    public void clear(UUID siteId, String profile) {
        jdbc.update("DELETE FROM site_profile_state WHERE site_id = ? AND profile = ?", siteId,
                profile);
    }
}
