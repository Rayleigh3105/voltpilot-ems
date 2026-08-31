package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

/**
 * Die KOMPONENTEN-WELT der ganzen Flotte, server-seitig aggregiert
 * (Einheitsmodell Stufe 6, Betriebs-/Support-Sicht).
 *
 * <p><b>Read-only, kein einziger Schreibpfad.</b> Die RLS-Umgehung steckt
 * ausschließlich hier an der dedizierten BYPASSRLS-Rolle
 * {@code voltpilot_admin} - dieselbe Disziplin wie {@link AdminFleetRepository}
 * und {@code ControlCertificationRepository}; der {@code @Primary}
 * mandantenbezogene Pfad bleibt unberührt.
 *
 * <p><b>⚠ Jede Abfrage ist ein gruppiertes Aggregat oder ein
 * {@code DISTINCT ON} je Anlage, nie eine Schleife.</b> Der Aufrufer holt
 * platt­formweite {@code Map<UUID, X>} und näht die Zeilen in Java zusammen -
 * das N+1-Muster von {@code AdminFleetController.fleet()}.
 *
 * <p><b>⚠ Eine Anlage ohne Zeile FEHLT in der Map.</b> „Nicht gemessen" ist
 * weder {@code null} noch {@code 0}; die Oberfläche sagt dann „unbekannt".
 */
@Repository
public class AdminComponentFleetRepository {

    /** Die Anlage selbst samt Autoritäts-Zustand und Übernahme-Beleg. */
    public record SiteRow(UUID siteId, String siteName, UUID tenantId, String tenantName,
            String componentAuthority, Instant componentsAdoptedAt, String componentsAdoptedBy) {}

    /**
     * Die Komponenten einer Anlage nach HERKUNFT ihrer Anbindung.
     *
     * <p>{@code unknown} ist der ehrliche Rest: Zeilen, die entstanden, bevor
     * es Vorlagen gab ({@code source_kind IS NULL}) - keine erfundene
     * Herkunft.
     */
    public record ComponentCounts(int total, int builtin, int certified, int custom, int composed,
            int unknown, int control) {}

    /**
     * Soll gegen Ist der Geräte-Konfiguration (die Stufe-1-Felder).
     *
     * <p>{@code heldRevision} ist die dritte Antwort (Befund L1): gesehen und
     * bewusst nichts angewandt. Sie reist mit, weil die Flotten-Sicht dieselbe
     * {@code syncStatus}-Ableitung fährt wie die Kunden-Fläche - ohne sie
     * behaupteten die zwei über dieselbe Anlage Verschiedenes.
     *
     * <p>{@code authority} ist aus demselben Grund dabei (Befund L8): meldet die
     * Box, dass sie ihre Geräte wieder selbst pflegt, ist jede Revisions-Aussage
     * hinfällig - und eine Flotten-Zeile, die dann „unterwegs" sagt, während die
     * Anlagen-Fläche „wird auf der Box gepflegt" sagt, wären zwei Antworten auf
     * eine Frage.
     */
    public record ApplyRow(String authority, String appliedRevision, String refusedRevision,
            String refusedReason, String heldRevision, Instant reportedAt) {}

    /** Was das Gerät über seine Steuer-Freigabe meldet. */
    public record ControlRow(String certSource, String platformCertVerdict,
            String platformCertModel, Instant checkedAt) {}

    private final JdbcTemplate jdbc;

    public AdminComponentFleetRepository(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Jede Anlage der Plattform, nach Mandant und Name sortiert. */
    public List<SiteRow> sites() {
        return jdbc.query("SELECT s.id, s.name, s.tenant_id, t.name AS tenant_name, "
                + "s.component_authority, s.components_adopted_at, s.components_adopted_by "
                + "FROM site s JOIN tenant t ON t.id = s.tenant_id "
                + "ORDER BY t.name, s.name",
                (rs, n) -> new SiteRow(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"),
                        rs.getString("component_authority"),
                        instant(rs, "components_adopted_at"),
                        rs.getString("components_adopted_by")));
    }

    /**
     * Komponenten je Anlage nach Herkunft.
     *
     * <p>Gezählt werden nur echte v2-Komponenten ({@code entity_type IS NOT
     * NULL}) - eine reine v1-Messpunkt-Zeile ist keine Komponente des
     * Anlagen-Modells und würde die Zahlen aufblähen.
     */
    public Map<UUID, ComponentCounts> componentsPerSite() {
        Map<UUID, ComponentCounts> out = new HashMap<>();
        each(rs -> out.put(rs.getObject("site_id", UUID.class),
                new ComponentCounts(rs.getInt("total"), rs.getInt("builtin"),
                        rs.getInt("certified"), rs.getInt("custom"), rs.getInt("composed"),
                        rs.getInt("unknown"), rs.getInt("control"))),
                "SELECT site_id, count(*) AS total, "
                + "count(*) FILTER (WHERE source_kind = 'builtin')   AS builtin, "
                + "count(*) FILTER (WHERE source_kind = 'certified') AS certified, "
                + "count(*) FILTER (WHERE source_kind = 'custom')    AS custom, "
                + "count(*) FILTER (WHERE source_kind = 'composed')  AS composed, "
                + "count(*) FILTER (WHERE source_kind IS NULL)       AS unknown, "
                + "count(*) FILTER (WHERE control)                   AS control "
                + "FROM measurement_point WHERE entity_type IS NOT NULL GROUP BY site_id");
        return out;
    }

    /** Das SOLL: die zuletzt komponierte Push-Revision je Anlage. */
    public Map<UUID, String> registryRevisionPerSite() {
        Map<UUID, String> out = new HashMap<>();
        each(rs -> out.put(rs.getObject("site_id", UUID.class),
                rs.getString("revision")), "SELECT site_id, revision FROM entity_registry_state");
        return out;
    }

    /**
     * Das IST: was die Box zuletzt angewandt (oder abgelehnt) hat.
     *
     * <p>Bei mehreren Geräten gewinnt der jüngste Bericht - wortgleich die
     * Regel von {@code ComponentApplyRepository.forSite}, damit Flotten-Sicht
     * und Anlagen-Fläche nie Verschiedenes behaupten.
     */
    public Map<UUID, ApplyRow> applyPerSite() {
        Map<UUID, ApplyRow> out = new HashMap<>();
        each(rs -> out.put(rs.getObject("site_id", UUID.class),
                new ApplyRow(rs.getString("authority"), rs.getString("applied_revision"),
                        rs.getString("refused_revision"), rs.getString("refused_reason"),
                        rs.getString("held_revision"), instant(rs, "reported_at"))),
                "SELECT DISTINCT ON (site_id) site_id, authority, applied_revision, "
                        + "refused_revision, refused_reason, held_revision, reported_at "
                        + "FROM device_component_apply ORDER BY site_id, reported_at DESC");
        return out;
    }

    /** Die vom Gerät gemeldete Steuer-Herkunft je Anlage (jüngster Bericht). */
    public Map<UUID, ControlRow> controlPerSite() {
        Map<UUID, ControlRow> out = new HashMap<>();
        each(rs -> out.put(rs.getObject("site_id", UUID.class),
                new ControlRow(rs.getString("cert_source"), rs.getString("platform_cert_verdict"),
                        rs.getString("platform_cert_model"), instant(rs, "checked_at"))),
                "SELECT DISTINCT ON (site_id) site_id, cert_source, platform_cert_verdict, "
                        + "platform_cert_model, checked_at FROM device_control_status "
                        + "ORDER BY site_id, checked_at DESC");
        return out;
    }

    /**
     * Wie viele Geräte einer Anlage plattform-scharfgeschaltet sind
     * ({@code device_control_activation} - die ANWESENHEIT der Zeile IST die
     * Freigabe, es gibt bewusst kein Flag).
     */
    public Map<UUID, Integer> activationsPerSite() {
        Map<UUID, Integer> out = new HashMap<>();
        each(countHandler(out), "SELECT d.site_id, count(*) AS n "
                + "FROM device_control_activation a JOIN device d ON d.id = a.device_id "
                + "GROUP BY d.site_id");
        return out;
    }

    /**
     * Komponenten, deren VORLAGE eine Schreib-Definition trägt - die zweite
     * Vertrauens-Stufe („Vorlage geprüft", Konzept §3.3.2).
     *
     * <p>Verbunden wird über Schlüssel UND Fassung: eine spätere Fassung der
     * Vorlage darf nicht rückwirkend behaupten, diese Komponente könne
     * schreiben.
     */
    public Map<UUID, Integer> templateWritesPerSite() {
        Map<UUID, Integer> out = new HashMap<>();
        each(countHandler(out), "SELECT m.site_id, count(*) AS n FROM measurement_point m "
                + "JOIN component_template c ON c.template_ref = m.template_ref "
                + "  AND c.version = m.template_version "
                + "WHERE c.writes IS NOT NULL GROUP BY m.site_id");
        return out;
    }

    /** Private (selbst gebaute) Vorlagen je Anlage - der Support-Blick auf den Long Tail. */
    public Map<UUID, Integer> privateTemplatesPerSite() {
        Map<UUID, Integer> out = new HashMap<>();
        each(countHandler(out),
                "SELECT site_id, count(*) AS n FROM site_component_template GROUP BY site_id");
        return out;
    }

    /**
     * {@code jdbc.query(sql, handler)} mit umgedrehten Argumenten - der Lambda
     * zuerst, damit der Compiler ihn eindeutig als {@link RowCallbackHandler}
     * liest. Ohne diese Naht ist {@code query(String, <lambda>)} mehrdeutig
     * (ein {@code ResultSetExtractor} passt formal genauso).
     */
    private void each(RowCallbackHandler handler, String sql) {
        jdbc.query(sql, handler);
    }

    /** Ein Zaehler je Anlage - dieselbe Form dreimal, also einmal beschrieben. */
    private static RowCallbackHandler countHandler(Map<UUID, Integer> out) {
        return rs -> out.put(rs.getObject("site_id", UUID.class), rs.getInt("n"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        java.sql.Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
