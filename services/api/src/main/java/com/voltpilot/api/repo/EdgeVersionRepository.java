package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der von der Edge gemeldete Software-Stand je Gerät. Der aktuelle Core-Build
 * kommt bevorzugt aus {@code device_update_status}: dieses Top-Level-Feld reist
 * in jedem modernen Herzschlag, auch wenn auf der Box noch nie ein Flow
 * ausgerollt wurde. {@code device_edge_version} bleibt die Quelle der separat
 * gemeldeten Palette-Version und der Fallback für ältere Boxen.
 *
 * <p>Genau EINE Zeile je Gerät: der Herzschlag trägt den vollständigen Ist, ein
 * Upsert ist deshalb richtig (kein Merge, keine Historie - „welche Version läuft
 * JETZT" ist die einzige Frage).
 *
 * <p>Der Lesepfad hat bewusst KEIN Mandanten-Prädikat: RLS ist der Zaun, genau
 * wie bei {@link OverviewRepository}. Ein Portal-Admin liest den Stand eines
 * Mandanten über den {@code X-Tenant-Id}-Umschalter - denselben Weg, den jede
 * andere Kundendaten-Ansicht nimmt.
 */
@Repository
public class EdgeVersionRepository {

    private final JdbcTemplate jdbc;

    public EdgeVersionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Der Stand EINES Geräts. {@code coreVersion}/{@code paletteVersion} können
     * einzeln null sein (die Edge lässt ein leeres Feld weg) - dann bleibt das
     * jeweilige Feld leer, nie eine geratene Version.
     */
    public record EdgeVersion(UUID deviceId, UUID siteId, String coreVersion,
            String paletteVersion, Instant reportedAt, List<String> supports) {
        public EdgeVersion(UUID deviceId, UUID siteId, String coreVersion, String paletteVersion, Instant reportedAt) {
            this(deviceId, siteId, coreVersion, paletteVersion, reportedAt, null);
        }
    }

    /**
     * Den gemeldeten Stand eines Geräts festhalten. {@code tenant_id} kommt aus
     * der RLS-Sitzung, nie aus dem Aufruf - eine fremde Mandanten-Id wäre damit
     * schon vom {@code WITH CHECK} der Policy abgewiesen.
     */
    public void record(UUID deviceId, UUID siteId, String coreVersion, String paletteVersion,
            Instant reportedAt) {
        jdbc.update(
                "INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, "
                        + "palette_version, reported_at) VALUES (?, "
                        + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?) "
                        + "ON CONFLICT (device_id) DO UPDATE SET site_id = EXCLUDED.site_id, "
                        + "core_version = EXCLUDED.core_version, "
                        + "palette_version = EXCLUDED.palette_version, "
                        + "reported_at = EXCLUDED.reported_at",
                deviceId, siteId, coreVersion, paletteVersion, Timestamp.from(reportedAt));
    }

    /**
     * Ein Eintrag des Release-Registers, auf die zwei Felder reduziert, die der
     * Kunden-Lesepfad braucht: den NAMEN und die ORDNUNG.
     */
    public record RegisterEntry(String version, long releaseSeq) {
    }

    /**
     * Das Release-Register, neueste zuerst - der MASSSTAB, ohne den „veraltet"
     * keine Aussage ist (OTA Stufe 0).
     *
     * <p><b>Bewusst auf der App-Rolle</b> und nicht über
     * {@link EdgeReleaseRepository} (BYPASSRLS): {@code edge_release} ist
     * mandantenfrei und die App-Rolle darf es LESEN (Migration
     * V20260803020000 {@code GRANT SELECT}) - die BYPASSRLS-Rolle ist dort die
     * SCHREIB-Berechtigung, und die bleibt hinter {@code /api/v1/admin/**}.
     *
     * <p>Gelesen werden nur Name und Sequenz; das Register selbst verlässt das
     * Haus nie über diesen Pfad (die Kunden-Antwort trägt ausschließlich das
     * URTEIL und den Namen des Soll-Stands).
     */
    public List<RegisterEntry> releases() {
        return jdbc.query("SELECT version, release_seq FROM edge_release "
                        + "ORDER BY release_seq DESC",
                (rs, n) -> new RegisterEntry(rs.getString("version"), rs.getLong("release_seq")));
    }

    /**
     * Jeder gemeldete Gerätestand des aufrufenden Mandanten (RLS-gefenced).
     *
     * <p><b>Die Top-Level-Version gewinnt.</b> Der historische
     * {@code flows.core_version}-Pfad ist an ein Flow-Deployment gekoppelt und
     * kann deshalb fehlen oder älter sein. {@code update.version} ist der
     * laufende Build, den jede aktuelle Box unabhängig davon meldet. Ein
     * vorhandenes {@code update.current_version} ist der kompatible zweite
     * Fallback, bevor der alte Flow-Beleg herangezogen wird.
     */
    public List<EdgeVersion> findAll() {
        return jdbc.query(
                "SELECT d.id AS device_id, d.site_id, "
                        + "COALESCE(NULLIF(u.version, ''), NULLIF(u.current_version, ''), "
                        + "e.core_version) AS core_version, e.palette_version, d.supports, "
                        + "CASE WHEN COALESCE(NULLIF(u.version, ''), "
                        + "NULLIF(u.current_version, '')) IS NOT NULL "
                        + "THEN u.reported_at ELSE coalesce(e.reported_at, d.supports_reported_at) END AS reported_at "
                        + "FROM device d "
                        + "LEFT JOIN device_update_status u ON u.device_id = d.id "
                        + "LEFT JOIN device_edge_version e ON e.device_id = d.id "
                        + "WHERE d.ausgebaut_am IS NULL AND (d.supports IS NOT NULL OR COALESCE(NULLIF(u.version, ''), NULLIF(u.current_version, ''), "
                        + "e.core_version, e.palette_version) IS NOT NULL) "
                        + "ORDER BY reported_at DESC",
                (rs, i) -> new EdgeVersion(
                        rs.getObject("device_id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("core_version"),
                        rs.getString("palette_version"),
                        rs.getTimestamp("reported_at").toInstant(),
                        com.voltpilot.api.uems.EdgeSupports.fromJson(rs.getString("supports"))));
    }
}
