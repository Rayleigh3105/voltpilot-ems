package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
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

    /**
     * Der gespeicherte Wille samt dem Zeitpunkt seiner letzten ÄNDERUNG
     * (Steuerung Stufe 5: „läuft seit …").
     *
     * <p>{@code seit} ist {@code updated_at} — und das trägt nur deshalb eine
     * Aussage, weil {@link #upsert} den Stempel ausschließlich bei einem
     * ECHTEN Zustandswechsel neu setzt (das {@code rollout_device.since}-Muster).
     */
    public record StoredState(String state, Instant seit) {}

    /** The stored states of a site, keyed by profile id (empty = all derived). */
    public Map<String, StoredState> findBySite(UUID siteId) {
        Map<String, StoredState> states = new LinkedHashMap<>();
        jdbc.query("SELECT profile, state, updated_at FROM site_profile_state "
                + "WHERE site_id = ? ORDER BY profile", rs -> {
                    Timestamp ts = rs.getTimestamp("updated_at");
                    states.put(rs.getString("profile"), new StoredState(rs.getString("state"),
                            ts == null ? null : ts.toInstant()));
                }, siteId);
        return states;
    }

    /**
     * Der gespeicherte Wille ALLER Anlagen des Mandanten, je Anlage nach
     * Anwendungs-Id (Anwendungs-Programm Stufe 4). Eine Anlage ohne Zeile ist
     * ABWESEND — „alles abgeleitet", der Zustand jeder Bestandsanlage.
     *
     * <p>EINE Abfrage für die ganze Flotte statt einer je Anlage: die Übersicht
     * ist die Landeseite und wird alle 30 s abgerufen. RLS ist der Zaun wie
     * überall hier — es gibt kein Mandanten-Prädikat, und genau deshalb kann
     * die Antwort nie über den Mandanten des Aufrufers hinausreichen.
     */
    public Map<UUID, Map<String, String>> findAllForTenant() {
        Map<UUID, Map<String, String>> states = new LinkedHashMap<>();
        jdbc.query("SELECT site_id, profile, state FROM site_profile_state "
                + "ORDER BY site_id, profile", rs -> {
                    states.computeIfAbsent(rs.getObject("site_id", UUID.class),
                            k -> new LinkedHashMap<>())
                            .put(rs.getString("profile"), rs.getString("state"));
                });
        return states;
    }

    /**
     * Persist the customer's intent for one profile. The RLS {@code WITH CHECK}
     * guarantees the row lands in the caller's tenant; the primary key makes it
     * an upsert.
     */
    public void upsert(UUID tenantId, UUID siteId, String profile, String state) {
        // ⚠ Der Stempel wird NUR bei einem echten Zustandswechsel neu gesetzt
        // (`WHERE ... IS DISTINCT FROM`). Ohne das Prädikat setzte jedes
        // erneute Speichern desselben Zustands - ein Doppelklick, ein
        // Wizard-Durchlauf, ein Wechsel, der dieses Modell gar nicht betrifft -
        // die Uhr zurück, und „läuft seit ..." wäre eine Falschaussage über
        // eine laufende Anlage. Dasselbe Muster wie `rollout_device.since`.
        jdbc.update("INSERT INTO site_profile_state (site_id, profile, state, tenant_id) "
                + "VALUES (?, ?, ?, ?) "
                + "ON CONFLICT (site_id, profile) DO UPDATE SET state = EXCLUDED.state, "
                + "updated_at = now() "
                + "WHERE site_profile_state.state IS DISTINCT FROM EXCLUDED.state",
                siteId, profile, state, tenantId);
    }

    /** Drop the stored intent so the profile falls back to the derived default. */
    public void clear(UUID siteId, String profile) {
        jdbc.update("DELETE FROM site_profile_state WHERE site_id = ? AND profile = ?", siteId,
                profile);
    }
}
