package com.voltpilot.api.components;

import com.voltpilot.api.web.dto.ComponentDefinitionDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Komponenten-Definitionen einer Anlage (Einheitsmodell Stufe 1): die
 * geltende Anbindung auf {@code measurement_point} plus ihre Fassungs-Historie
 * in {@code component_definition}.
 *
 * <p>Der {@code @Primary}, mandantenbezogene {@link JdbcTemplate} - also der
 * RLS-Pfad. Es gibt hier bewusst KEINE BYPASSRLS-Verbindung: das ist eine
 * Kunden-Fläche, und der Mandanten-Zaun ist die Datenbank, nicht ein Prädikat,
 * das jemand vergessen kann.
 *
 * <p><b>Die Historie ist append-only.</b> Ein Rollback SCHREIBT eine neue
 * Fassung mit dem alten Inhalt; er löscht nie eine - „was lief letzte Woche"
 * muss auch nach dem Zurückdrehen beantwortbar bleiben (das
 * Flow-Versions-Muster).
 */
@Repository
public class ComponentDefinitionRepository {

    private static final String DEF_COLUMNS =
            "entity_id, version, role, label, brand, model, family, communication, "
                    + "connection_json::text AS conn, source_kind, template_ref, template_version, "
                    + "created_at, created_by, note";

    private final JdbcTemplate jdbc;

    public ComponentDefinitionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Der Autoritäts-Zustand dieser Anlage, oder {@code null} wenn RLS sie verbirgt. */
    public String componentAuthority(UUID siteId) {
        List<String> rows = jdbc.query("SELECT component_authority FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Wann diese Anlage automatisch vom Gerät übernommen wurde, oder
     * {@code null} (Einheitsmodell Stufe 2). {@code null} heißt „nie
     * übernommen" - NICHT „box-verwaltet"; die Autorität ist eine eigene Spalte.
     */
    public java.time.Instant componentsAdoptedAt(UUID siteId) {
        List<java.sql.Timestamp> rows = jdbc.query(
                "SELECT components_adopted_at FROM site WHERE id = ?",
                (rs, n) -> rs.getTimestamp(1), siteId);
        return rows.isEmpty() || rows.get(0) == null ? null : rows.get(0).toInstant();
    }

    /**
     * Was nach einem {@link #applyDefinition} gilt: die neue Fassungsnummer und
     * der NAME, den die Komponente danach trägt. Der Name kommt aus der
     * Datenbank zurück, damit die Historie exakt das festhält, was gespeichert
     * wurde - eine zweite Ableitung im Aufrufer wäre eine zweite Wahrheit.
     */
    public record Applied(int version, String label) {}

    /**
     * Schreibt die geltende Anbindung auf den Messpunkt und hebt seine Fassung.
     * Der {@code site_id}-Vergleich ist kein Mandanten-Zaun (den macht RLS) -
     * er verhindert, dass eine Komponente einer ANDEREN Anlage desselben Kunden
     * getroffen wird.
     *
     * <p><b>⚠ Der NAME wird nur GEFÜLLT, nie überschrieben</b> (Alias-Kontinuität,
     * Live-Fall Herzogau 20.08.2026: „beim neu hinzufügen sind die Aliase jetzt
     * weg"). Seit der Label-Hygiene (V20260812000000) heißt {@code label != NULL}
     * „von einem Menschen vergeben" - ein abgeleiteter Name (das Modell aus der
     * Vorlage, der von der Box gemeldete Quellenname) darf einen solchen niemals
     * ersetzen. {@code null}/leer behält den gespeicherten Namen; gelöscht wird
     * ein Name ausschließlich über die Umbenennen-Route des Kunden.
     *
     * @return {@link Applied}, oder {@code null} wenn die Komponente nicht existiert
     */
    public Applied applyDefinition(UUID siteId, UUID entityId, String label, String brand,
            String model, String family, String communication, String connectionJson,
            String sourceKind, String templateRef, Integer templateVersion) {
        List<Applied> rows = jdbc.query(
                "UPDATE measurement_point SET label = COALESCE(NULLIF(?::text, \'\'), label), "
                        + "brand = ?, model = ?, family = ?, "
                        + "communication = ?, connection_json = ?::jsonb, source_kind = ?, "
                        + "template_ref = ?, template_version = ?, "
                        + "definition_version = definition_version + 1 "
                        + "WHERE id = ? AND site_id = ? RETURNING definition_version, label",
                (rs, n) -> new Applied(rs.getInt(1), rs.getString(2)),
                label, brand, model, family, communication, connectionJson, sourceKind,
                templateRef, templateVersion, entityId, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Legt die Fassung in der Historie ab. */
    public void recordVersion(UUID tenantId, UUID siteId, UUID entityId, int version, String role,
            String label, String brand, String model, String family, String communication,
            String connectionJson, String sourceKind, String templateRef, Integer templateVersion,
            String createdBy, String note) {
        jdbc.update(
                "INSERT INTO component_definition (entity_id, version, tenant_id, site_id, role, "
                        + "label, brand, model, family, communication, connection_json, source_kind, "
                        + "template_ref, template_version, created_by, note) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (entity_id, version) DO NOTHING",
                entityId, version, tenantId, siteId, role, label, brand, model, family,
                communication, connectionJson, sourceKind, templateRef, templateVersion,
                createdBy, note);
    }

    /** Alle Fassungen einer Komponente, neueste zuerst. */
    public List<ComponentDefinitionDto> versions(UUID siteId, UUID entityId) {
        return jdbc.query(
                "SELECT " + DEF_COLUMNS + " FROM component_definition "
                        + "WHERE site_id = ? AND entity_id = ? ORDER BY version DESC",
                ComponentDefinitionRepository::map, siteId, entityId);
    }

    /** EINE Fassung, oder {@code null}. */
    public ComponentDefinitionDto version(UUID siteId, UUID entityId, int version) {
        List<ComponentDefinitionDto> rows = jdbc.query(
                "SELECT " + DEF_COLUMNS + " FROM component_definition "
                        + "WHERE site_id = ? AND entity_id = ? AND version = ?",
                ComponentDefinitionRepository::map, siteId, entityId, version);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static ComponentDefinitionDto map(ResultSet rs, int rowNum) throws SQLException {
        OffsetDateTime created = rs.getObject("created_at", OffsetDateTime.class);
        Integer tv = (Integer) rs.getObject("template_version");
        return new ComponentDefinitionDto(
                rs.getObject("entity_id", UUID.class),
                rs.getInt("version"),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                rs.getString("family"),
                rs.getString("communication"),
                rs.getString("conn"),
                rs.getString("source_kind"),
                rs.getString("template_ref"),
                tv,
                created == null ? null : created.toInstant(),
                rs.getString("created_by"),
                rs.getString("note"));
    }
}
