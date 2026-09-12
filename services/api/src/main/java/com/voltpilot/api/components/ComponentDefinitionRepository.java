package com.voltpilot.api.components;

import com.voltpilot.api.web.dto.ComponentDefinitionDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.time.Instant;
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
    public record FullDefinition(ComponentDefinitionDto definition, BigDecimal capacityKwp,
            Boolean control, String entityType, String capabilitiesJson, String guardConfigJson,
            String registryUnitId, boolean semanticSnapshotComplete) {}

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

    public Applied applyDefinitionFull(UUID siteId, UUID entityId, int expectedRevision,
            FullDefinition old) {
        ComponentDefinitionDto d = old.definition();
        List<Applied> rows = jdbc.query(
                "UPDATE measurement_point SET role = ?, label = ?, brand = ?, model = ?, family = ?, "
                        + "communication = ?, connection_json = ?::jsonb, source_kind = ?, template_ref = ?, "
                        + "template_version = ?, capacity_kwp = ?, control = ?, entity_type = ?, "
                        + "capabilities = ?::jsonb, guard_config = ?::jsonb, registry_unit_id = ?, "
                        + "definition_version = definition_version + 1 WHERE id = ? AND site_id = ? "
                        + "AND definition_version = ? RETURNING definition_version, label",
                (rs, n) -> new Applied(rs.getInt(1), rs.getString(2)), d.role(), d.label(), d.brand(),
                d.model(), d.family(), d.communication(), d.connection(), d.sourceKind(), d.templateRef(),
                d.templateVersion(), old.capacityKwp(), old.control(), old.entityType(), old.capabilitiesJson(),
                old.guardConfigJson(), old.registryUnitId(), entityId, siteId, expectedRevision);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Revisionierter Bearbeitungsweg. Anders als der Anlege-/Übernahmeweg ist
     * der Name hier eine ausdrückliche Kundeneingabe und darf daher auch
     * entfernt werden. Die Revisionsbedingung sitzt IN demselben UPDATE wie
     * alle neuen Sollwerte: zwischen Lesen und Schreiben kann kein zweiter
     * Tab unbemerkt gewinnen.
     */
    public Applied applyEditDefinition(UUID siteId, UUID entityId, int expectedRevision,
            String role, String entityType, String label, BigDecimal capacityKwp,
            String brand, String model, String family, String communication,
            String connectionJson, String sourceKind, String templateRef,
            Integer templateVersion, String capabilitiesJson, String guardConfigJson) {
        List<Applied> rows = jdbc.query(
                "UPDATE measurement_point SET role = ?, entity_type = COALESCE(?, entity_type), "
                        + "control = CASE WHEN ? = 'battery-hybrid' THEN control ELSE false END, "
                        + "label = NULLIF(?::text, ''), capacity_kwp = ?, brand = ?, model = ?, "
                        + "family = ?, communication = ?, connection_json = ?::jsonb, "
                        + "source_kind = ?, template_ref = ?, template_version = ?, "
                        + "capabilities = COALESCE(?::jsonb, capabilities), "
                        + "guard_config = COALESCE(?::jsonb, guard_config), "
                        + "definition_version = definition_version + 1 "
                        + "WHERE id = ? AND site_id = ? AND definition_version = ? "
                        + "RETURNING definition_version, label",
                (rs, n) -> new Applied(rs.getInt(1), rs.getString(2)),
                role, entityType, entityType, label, capacityKwp, brand, model, family, communication,
                connectionJson, sourceKind, templateRef, templateVersion, capabilitiesJson,
                guardConfigJson, entityId, siteId, expectedRevision);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Nur die VERBINDUNG ändern — der Zählerwechsel (UEMS AP-04 IP-17), wenn das neue Gerät unter
     * einer anderen Geräte-ID antwortet. Alles andere bleibt zeichengleich (Rolle, Typ, Marke,
     * Modell, Familie, Schutzklemmen); die Revisionsbedingung sitzt wie überall IN demselben
     * UPDATE. {@code null} = die Komponente hat inzwischen eine neuere Fassung.
     */
    public Applied applyConnection(UUID siteId, UUID entityId, int expectedRevision,
            String connectionJson) {
        List<Applied> rows = jdbc.query(
                "UPDATE measurement_point SET connection_json = ?::jsonb, "
                        + "definition_version = definition_version + 1 "
                        + "WHERE id = ? AND site_id = ? AND definition_version = ? "
                        + "RETURNING definition_version, label",
                (rs, n) -> new Applied(rs.getInt(1), rs.getString(2)),
                connectionJson, entityId, siteId, expectedRevision);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Die heutige Fassungsnummer der Komponente; {@code null}, wenn es sie (für den Aufrufer) nicht gibt. */
    public Integer definitionVersion(UUID siteId, UUID entityId) {
        return jdbc.query("SELECT definition_version FROM measurement_point WHERE id = ? AND site_id = ?",
                (rs, n) -> rs.getInt(1), entityId, siteId).stream().findFirst().orElse(null);
    }

    /**
     * Legt den TATSAECHLICH angewandten Stand als vollstaendigen Snapshot ab.
     *
     * <p>Der Assistent spricht in Kundenrollen (zum Beispiel {@code inverter}),
     * waehrend die gespeicherte, aus Wechselrichter und Batterie komponierte
     * Entitaet {@code battery-hybrid} sein kann. Deshalb darf kein Aufrufer die
     * Snapshot-Felder ein zweites Mal aus dem Request ableiten. Diese eine
     * Abfrage kopiert Rolle, Typ, Schutzklemmen und Verbindung direkt aus genau
     * der gerade geschriebenen {@code measurement_point}-Fassung.
     */
    public void recordStoredVersion(UUID tenantId, UUID siteId, UUID entityId, int version,
            String createdBy, String note) {
        jdbc.update("INSERT INTO component_definition (entity_id, version, tenant_id, site_id, role, "
                        + "label, brand, model, family, communication, connection_json, source_kind, "
                        + "template_ref, template_version, capacity_kwp, control, entity_type, capabilities, "
                        + "guard_config, registry_unit_id, semantic_snapshot_complete, created_by, note) "
                        + "SELECT m.id, ?, m.tenant_id, m.site_id, m.role, m.label, m.brand, m.model, "
                        + "m.family, m.communication, m.connection_json, m.source_kind, m.template_ref, "
                        + "m.template_version, m.capacity_kwp, m.control, m.entity_type, m.capabilities, "
                        + "m.guard_config, m.registry_unit_id, true, ?, ? FROM measurement_point m "
                        + "WHERE m.id = ? AND m.site_id = ? AND m.tenant_id = ? "
                        + "AND m.definition_version = ? "
                        + "ON CONFLICT (entity_id, version) DO NOTHING",
                version, createdBy, note, entityId, siteId, tenantId, version);
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

    public FullDefinition fullVersion(UUID siteId, UUID entityId, int version) {
        List<FullDefinition> rows = jdbc.query(
                "SELECT " + DEF_COLUMNS + ", capacity_kwp, control, entity_type, "
                        + "capabilities::text AS caps, guard_config::text AS guards, registry_unit_id, semantic_snapshot_complete "
                        + "FROM component_definition WHERE site_id = ? AND entity_id = ? AND version = ?",
                (rs, n) -> new FullDefinition(map(rs, n), rs.getBigDecimal("capacity_kwp"),
                        (Boolean) rs.getObject("control"), rs.getString("entity_type"),
                        rs.getString("caps"), rs.getString("guards"), rs.getString("registry_unit_id"),
                        rs.getBoolean("semantic_snapshot_complete")),
                siteId, entityId, version);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Ereignis-Marker neben der vollständigen Fassungs-Historie. */
    public void recordEvent(UUID tenantId, UUID siteId, UUID entityId, int revision,
            String eventType, Instant effectiveAt, String fromValue, String toValue,
            String createdBy, String note) {
        jdbc.update(
                "INSERT INTO component_change_event (tenant_id, site_id, entity_id, revision, "
                        + "event_type, effective_at, from_value, to_value, created_by, note) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenantId, siteId, entityId, revision, eventType,
                java.sql.Timestamp.from(effectiveAt), fromValue, toValue, createdBy, note);
    }

    public List<com.voltpilot.api.web.dto.ComponentChangeEventDto> events(UUID siteId,
            UUID entityId) {
        return jdbc.query(
                "SELECT revision, event_type, effective_at, from_value, to_value, created_at, "
                        + "created_by, note FROM component_change_event WHERE entity_id = ? "
                        + "ORDER BY effective_at DESC, id DESC",
                (rs, n) -> new com.voltpilot.api.web.dto.ComponentChangeEventDto(
                        rs.getInt("revision"), rs.getString("event_type"),
                        rs.getObject("effective_at", OffsetDateTime.class).toInstant(),
                        rs.getString("from_value"), rs.getString("to_value"),
                        rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                        rs.getString("created_by"), rs.getString("note")),
                entityId);
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
