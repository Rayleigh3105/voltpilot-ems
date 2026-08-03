package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.EdgeReleaseDto;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Release-Register (Tabelle {@code edge_release}, Migration
 * V20260803020000): welche Edge-Stände es GIBT und in welcher REIHENFOLGE - der
 * Maßstab, ohne den „veraltet" keine Aussage ist.
 *
 * <p>Die RLS-Umgehung folgt exakt dem Muster von {@link TenantRepository} /
 * {@link AdminProvisionedDeviceRepository}: dieselbe dedizierte
 * {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Das Register
 * selbst ist ohnehin mandantenfrei (globale Betriebsdaten wie
 * {@code provisioned_device}) - die Rolle ist hier die SCHREIB-Berechtigung,
 * die die App-Rolle bewusst nicht hat.
 */
@Repository
public class EdgeReleaseRepository {

    private static final String SELECT =
            "SELECT release_seq, version, target_commit, notes, created_at, created_by "
                    + "FROM edge_release ";

    private final JdbcTemplate jdbc;

    public EdgeReleaseRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Alle Releases, NEUESTE zuerst - die Ordnung ist {@code release_seq}. */
    public List<EdgeReleaseDto> findAll() {
        return jdbc.query(SELECT + "ORDER BY release_seq DESC", EdgeReleaseRepository::map);
    }

    public Optional<EdgeReleaseDto> findByVersion(String version) {
        return jdbc.query(SELECT + "WHERE version = ?", EdgeReleaseRepository::map, version)
                .stream().findFirst();
    }

    /**
     * Die höchste vergebene Sequenznummer, {@code null} bei leerem Register.
     * Sie ist zugleich die Untergrenze für eine neue: das Register ist
     * append-only gemeint, und „monoton" ist die ganze Zusage, auf der die
     * Ordnung ruht.
     */
    public Long maxSeq() {
        return jdbc.queryForObject("SELECT max(release_seq) FROM edge_release", Long.class);
    }

    /** Ein neues Release eintragen. Der Aufrufer hat Version + Seq geprüft. */
    public EdgeReleaseDto insert(long releaseSeq, String version, String targetCommit,
            String notes, String createdBy) {
        return jdbc.queryForObject(
                "INSERT INTO edge_release (release_seq, version, target_commit, notes, created_by) "
                        + "VALUES (?, ?, ?, ?, ?) "
                        + "RETURNING release_seq, version, target_commit, notes, created_at, "
                        + "created_by",
                EdgeReleaseRepository::map, releaseSeq, version, targetCommit, notes, createdBy);
    }

    private static EdgeReleaseDto map(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        return new EdgeReleaseDto(
                rs.getLong("release_seq"),
                rs.getString("version"),
                rs.getString("target_commit"),
                rs.getString("notes"),
                rs.getTimestamp("created_at").toInstant(),
                rs.getString("created_by"));
    }
}
