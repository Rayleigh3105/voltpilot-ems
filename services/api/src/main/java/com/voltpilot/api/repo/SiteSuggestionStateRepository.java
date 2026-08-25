package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das GEDÄCHTNIS der Vorschläge (Steuerung Stufe 6, Migration
 * V20260846000000): welche Vorschläge der Kunde gerade nicht sehen will.
 *
 * <p><b>Der Vorschlag selbst steht hier NIE</b> - er ist eine Ableitung
 * (Konzept §4). Gespeichert wird ausschliesslich die Haltung des Kunden zu
 * einem abgeleiteten Schlüssel.
 *
 * <p>RLS-gefenced über den {@code @Primary} mandantenbezogenen
 * {@link JdbcTemplate} wie jedes Kunden-Repository - nie die BYPASSRLS-Vorlage.
 */
@Repository
public class SiteSuggestionStateRepository {

    /** Eine gespeicherte Haltung, so wie die Fläche sie liest. */
    public record Row(String key, String state, Instant mutedUntil, Instant updatedAt) {}

    private final JdbcTemplate jdbc;

    public SiteSuggestionStateRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Haltungen einer Anlage, die JETZT noch gelten. Eine abgelaufene Zeile
     * wird gar nicht erst ausgeliefert - sie ist keine Aussage mehr, und die
     * Fläche soll den Vorschlag wieder zeigen.
     */
    public List<Row> findLive(UUID siteId, Instant now) {
        List<Row> rows = new ArrayList<>();
        jdbc.query("SELECT suggestion_key, state, muted_until, updated_at "
                + "FROM site_suggestion_state WHERE site_id = ? AND muted_until > ? "
                + "ORDER BY suggestion_key", rs -> {
                    rows.add(new Row(rs.getString("suggestion_key"), rs.getString("state"),
                            instant(rs.getTimestamp("muted_until")),
                            instant(rs.getTimestamp("updated_at"))));
                }, siteId, Timestamp.from(now));
        return rows;
    }

    /**
     * Die Haltung setzen (oder erneuern). {@code tenant_id} kommt aus der
     * RLS-SITZUNG, NIE aus dem Aufruf (das {@code device_override}-Muster) -
     * die Policy prüft ihn zusätzlich mit ihrem {@code WITH CHECK}, ein
     * fremder Mandant ist also strukturell unschreibbar.
     */
    public void upsert(UUID siteId, String key, String state, Instant mutedUntil, String by) {
        jdbc.update("INSERT INTO site_suggestion_state "
                + "(site_id, suggestion_key, state, muted_until, tenant_id, updated_by, updated_at) "
                + "VALUES (?, ?, ?, ?, "
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, now()) "
                + "ON CONFLICT (site_id, suggestion_key) DO UPDATE SET "
                + "state = EXCLUDED.state, muted_until = EXCLUDED.muted_until, "
                + "updated_by = EXCLUDED.updated_by, updated_at = now()",
                siteId, key, state, Timestamp.from(mutedUntil), by);
    }

    /**
     * Abgelaufene Zeilen der Anlage wegräumen. Opportunistisch im Schreibpfad
     * (das `rule_event`-Muster) statt über einen neuen {@code @Scheduled}-Job:
     * es sind wenige Zeilen je Anlage, und ein Takt bräuchte ein weiteres, per
     * Vorgabe ausgeschaltetes Flag im gitops-Repo (die dokumentierte Falle).
     */
    public int pruneExpired(UUID siteId, Instant now) {
        return jdbc.update("DELETE FROM site_suggestion_state "
                + "WHERE site_id = ? AND muted_until <= ?", siteId, Timestamp.from(now));
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
