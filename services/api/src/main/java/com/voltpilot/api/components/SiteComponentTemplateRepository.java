package com.voltpilot.api.components;

import com.voltpilot.api.web.dto.SiteComponentTemplateDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die PRIVATEN Geräte-Vorlagen einer Anlage (Tabelle
 * {@code site_component_template}, Migration V20260818000000) - „Duplizieren"
 * aus dem Konzept vp-modbus-baukasten-k6 (Captain-Scope 4: Vorlagen NUR je
 * Anlage, privat, kein Katalog, kein Teilen).
 *
 * <p><b>Eine Verbindung, nicht zwei.</b> Anders als
 * {@link com.voltpilot.api.templates.ComponentTemplateRepository} läuft hier
 * ALLES über die normale, mandantengebundene App-Rolle: das sind Kundendaten,
 * der Zaun ist die RLS-Policy der Migration, und es gibt bewusst keinen
 * BYPASSRLS-Pfad - eine private Vorlage hat keinen plattformweiten Leser.
 *
 * <p>Deshalb ist eine fremde Anlage hier nicht „verboten", sondern schlicht
 * LEER: RLS blendet sie aus, bevor irgendeine Abfrage sie sieht.
 */
@Repository
public class SiteComponentTemplateRepository {

    private static final String COLUMNS =
            "id, site_id, template_ref, version, label, communication, connection, channels, "
                    + "note, created_at, updated_at";

    private final JdbcTemplate jdbc;

    public SiteComponentTemplateRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbcTemplate;
    }

    /** Die privaten Vorlagen EINER Anlage, alphabetisch. */
    public List<SiteComponentTemplateDto> forSite(UUID siteId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM site_component_template "
                + "WHERE site_id = ? ORDER BY label, template_ref",
                SiteComponentTemplateRepository::map, siteId);
    }

    /** EINE Vorlage dieser Anlage, oder {@code null}. */
    public SiteComponentTemplateDto find(UUID siteId, String templateRef) {
        List<SiteComponentTemplateDto> rows = jdbc.query("SELECT " + COLUMNS
                + " FROM site_component_template WHERE site_id = ? AND template_ref = ? "
                + "ORDER BY version DESC LIMIT 1",
                SiteComponentTemplateRepository::map, siteId, templateRef);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Legt eine private Vorlage an.
     *
     * <p>Der {@code tenant_id} kommt vom Aufrufer, aber die RLS-{@code WITH
     * CHECK} der Migration prüft ihn noch einmal gegen die Sitzung - ein
     * fremder Mandant im Aufruf kann also nie eine Zeile erzeugen.
     */
    public UUID create(UUID tenantId, UUID siteId, String templateRef, String label,
            String communication, String connectionJson, String channelsJson, String note,
            String createdBy) {
        return jdbc.queryForObject(
                "INSERT INTO site_component_template (tenant_id, site_id, template_ref, version, "
                        + "label, communication, connection, channels, note, created_by) "
                        + "VALUES (?, ?, ?, 1, ?, ?, ?::jsonb, ?::jsonb, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, templateRef, label, communication, connectionJson,
                channelsJson, note, createdBy);
    }

    /** Entfernt eine private Vorlage. */
    public int delete(UUID siteId, String templateRef) {
        return jdbc.update("DELETE FROM site_component_template WHERE site_id = ? "
                + "AND template_ref = ?", siteId, templateRef);
    }

    private static SiteComponentTemplateDto map(ResultSet rs, int rowNum) throws SQLException {
        return new SiteComponentTemplateDto(
                rs.getString("template_ref"),
                rs.getInt("version"),
                rs.getString("label"),
                rs.getString("communication"),
                rs.getString("connection"),
                rs.getString("channels"),
                rs.getString("note"),
                instant(rs, "created_at"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime v = rs.getObject(column, OffsetDateTime.class);
        return v == null ? null : v.toInstant();
    }
}
