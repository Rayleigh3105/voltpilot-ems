package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das IST des Box-Appliers ({@code device_component_apply}, Einheitsmodell
 * Stufe 1): welche Push-Revision die Box wirklich angewandt hat - und was sie
 * gegebenenfalls NICHT anwenden konnte.
 *
 * <p>RLS-Pfad wie jede mandantenbezogene Tabelle; geschrieben vom
 * Status-Zuhörer unter dem Topic-Mandanten, gelesen von der Kunden-Route.
 */
@Repository
public class ComponentApplyRepository {

    /**
     * Was die Box zuletzt gemeldet hat.
     *
     * <p>Die DREI Antworten auf „was ist mit der neuesten Revision passiert?"
     * stehen NEBENEINANDER, nie übereinander: {@code appliedRevision} ist, was
     * wirklich läuft, {@code refusedRevision} was die Box nicht KONNTE, und
     * {@code heldRevision} was sie gesehen und bewusst nicht angewandt hat
     * (Befund L1). {@code null} heißt überall „nicht gemeldet".
     *
     * <p>{@code rejected} sind die Geräte, die die Box beim Anwenden
     * ÜBERSPRUNGEN hat (Kennung der Komponente → deutscher Grund): sie kann
     * ihnen keine Rolle zuordnen und hat den Rest des Pushs trotzdem angewandt.
     * Leer heißt „nichts übersprungen" oder „eine ältere Box meldet das nicht".
     */
    public record ApplyState(String authority, String appliedRevision, Instant appliedAt,
            String refusedRevision, String refusedReason, String heldRevision,
            String heldReason, Instant reportedAt, Map<String, String> rejected) {

        public ApplyState {
            rejected = rejected == null ? Map.of() : Map.copyOf(rejected);
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;

    public ComponentApplyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Ersetzt die Zeile dieses Geräts (der Herzschlag trägt den vollen Stand).
     *
     * @param rejectedComponentsJson die übersprungenen Geräte als JSON-Feld
     *     {@code [{"entity_id": ..., "reason": ...}]}, oder {@code null} für keines
     */
    public void upsert(UUID deviceId, UUID tenantId, UUID siteId, String authority,
            String appliedRevision, Instant appliedAt, String refusedRevision,
            String refusedReason, String heldRevision, String heldReason, Instant reportedAt,
            String rejectedComponentsJson) {
        jdbc.update(
                "INSERT INTO device_component_apply (device_id, tenant_id, site_id, authority, "
                        + "applied_revision, applied_at, refused_revision, refused_reason, "
                        + "held_revision, held_reason, reported_at, rejected_components) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS jsonb)) "
                        + "ON CONFLICT (device_id) DO UPDATE SET authority = EXCLUDED.authority, "
                        + "applied_revision = EXCLUDED.applied_revision, "
                        + "applied_at = EXCLUDED.applied_at, "
                        + "refused_revision = EXCLUDED.refused_revision, "
                        + "refused_reason = EXCLUDED.refused_reason, "
                        + "held_revision = EXCLUDED.held_revision, "
                        + "held_reason = EXCLUDED.held_reason, "
                        + "reported_at = EXCLUDED.reported_at, "
                        + "rejected_components = EXCLUDED.rejected_components",
                deviceId, tenantId, siteId, authority, appliedRevision,
                appliedAt == null ? null : OffsetDateTime.ofInstant(appliedAt, java.time.ZoneOffset.UTC),
                refusedRevision, refusedReason, heldRevision, heldReason,
                OffsetDateTime.ofInstant(reportedAt, java.time.ZoneOffset.UTC),
                rejectedComponentsJson);
    }

    /**
     * Der zuletzt gemeldete Stand dieser Anlage. Meldet KEIN Gerät etwas, ist
     * das Ergebnis {@code null} - „unbekannt", nie ein erfundener Zustand.
     *
     * <p>Bei mehreren Geräten gewinnt der jüngste Bericht: die Geräte-Konfiguration
     * ist eine Aussage über die ANLAGE, und ein zweites Gerät (heute nicht der
     * Fall, aber strukturell möglich) darf keinen älteren Stand vortäuschen.
     */
    public ApplyState forSite(UUID siteId) {
        List<ApplyState> rows = jdbc.query(
                "SELECT authority, applied_revision, applied_at, refused_revision, refused_reason, "
                        + "held_revision, held_reason, reported_at, rejected_components::text AS rejected "
                        + "FROM device_component_apply "
                        + "WHERE site_id = ? AND EXISTS (SELECT 1 FROM device d "
                        + "  WHERE d.id = device_component_apply.device_id AND d.ausgebaut_am IS NULL) "
                        + "ORDER BY reported_at DESC LIMIT 1",
                (rs, n) -> new ApplyState(rs.getString("authority"),
                        rs.getString("applied_revision"), instant(rs.getObject("applied_at",
                                OffsetDateTime.class)),
                        rs.getString("refused_revision"), rs.getString("refused_reason"),
                        rs.getString("held_revision"), rs.getString("held_reason"),
                        instant(rs.getObject("reported_at", OffsetDateTime.class)),
                        rejected(rs.getString("rejected"))),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Liest die gespeicherte Liste als Kennung → Grund. Ein Eintrag ohne
     * Kennung oder ohne Grund wird übergangen, nie erfunden.
     */
    static Map<String, String> rejected(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        Map<String, String> out = new LinkedHashMap<>();
        try {
            for (JsonNode e : JSON.readTree(json)) {
                String id = e.path("entity_id").asText("");
                String reason = e.path("reason").asText("");
                if (!id.isBlank() && !reason.isBlank()) {
                    out.putIfAbsent(id, reason);
                }
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            return Map.of();
        }
        return out;
    }

    private static Instant instant(OffsetDateTime v) {
        return v == null ? null : v.toInstant();
    }
}
