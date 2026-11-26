package com.voltpilot.api.repo;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die CROSS-TENANT Lesequelle der Direktvermarktung-Übersicht (Plattform › Übersicht, Geräteakte ›
 * Verbindung; Konzept vp-direktvermarktung-konzept d2 §7.7). Dasselbe Muster wie
 * {@link AdminFleetRepository}: eine eigene {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Read-only - jede Änderung läuft über die
 * mandantengefenzten Kundenrouten.
 */
@Repository
public class AdminDirektvermarktungRepository {

    /** Eine Zeile der Plattform-Liste: Anlage, Mandant, Partner, Zustand, wie lange schon. */
    public record Zeile(UUID siteId, String siteName, UUID tenantId, String tenantName, String partner,
            String zustand, LocalDate startdatum, LocalDate ende, Instant aktualisiertAm,
            Instant letzteAbfrageAm, Instant lebenszeichenAm) {}

    private final JdbcTemplate jdbc;

    public AdminDirektvermarktungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Jede Anlage mit einem nicht beendeten Anschluss, plattformweit. */
    public List<Zeile> aktive() {
        return jdbc.query("""
                SELECT dv.site_id, s.name AS site_name, dv.tenant_id, t.name AS tenant_name, dv.partner,
                       dv.zustand, dv.startdatum, dv.ende, dv.aktualisiert_am,
                       dvs.letzte_abfrage_am, dvs.lebenszeichen_am
                FROM direktvermarktung dv
                JOIN site s ON s.id = dv.site_id
                JOIN tenant t ON t.id = dv.tenant_id
                LEFT JOIN direktvermarktung_stand dvs ON dvs.site_id = dv.site_id
                WHERE dv.zustand <> 'beendet'
                ORDER BY t.name, s.name
                """, AdminDirektvermarktungRepository::mapZeile);
    }

    private static Zeile mapZeile(ResultSet rs, int i) throws SQLException {
        Date startdatum = rs.getDate("startdatum");
        Date ende = rs.getDate("ende");
        return new Zeile(rs.getObject("site_id", UUID.class), rs.getString("site_name"),
                rs.getObject("tenant_id", UUID.class), rs.getString("tenant_name"), rs.getString("partner"),
                rs.getString("zustand"), startdatum == null ? null : startdatum.toLocalDate(),
                ende == null ? null : ende.toLocalDate(), ts(rs, "aktualisiert_am"), ts(rs, "letzte_abfrage_am"),
                ts(rs, "lebenszeichen_am"));
    }

    private static Instant ts(ResultSet rs, String spalte) throws SQLException {
        var t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
