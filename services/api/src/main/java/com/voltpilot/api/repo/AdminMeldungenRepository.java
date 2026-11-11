package com.voltpilot.api.repo;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Meldungen (Alarme) PLATTFORMWEIT, über alle Mandanten (Lücke L5,
 * Adminview-Konzept Abschnitt 3.4/4.3 "Braucht dich"). {@code MeldungenController}
 * bleibt UNANGETASTET: dort liest die mandantenbezogene {@code @Primary}-Quelle
 * weiter unter {@code TenantContext}, der Standort-Zaun ({@code site_scope} auf
 * {@code alarm}) filtert genauso wie vorher - diese Klasse ist ein ZWEITER,
 * eigener Pfad.
 *
 * <p><b>Die RLS-Umgehung folgt exakt dem Muster von {@link AdminFleetRepository}
 * und {@link AdminSiteRepository}:</b> dieselbe dedizierte
 * {@code adminJdbcTemplate}-Verbindung als BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar AUSSCHLIESSLICH aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt
 * ({@code AdminMeldungenController}). Die Kunden-RLS-Politik auf {@code alarm}
 * ({@code alarm_tenant_isolation}, {@code site_scope}, beide
 * {@code FORCE ROW LEVEL SECURITY}) wird dabei nicht gelockert - sie gilt
 * unverändert für jede Verbindung außer dieser einen, admin-geschützten Rolle.
 * Read-only: keine einzige schreibende Abfrage.
 */
@Repository
public class AdminMeldungenRepository {

    private final JdbcTemplate jdbc;

    public AdminMeldungenRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Eine Meldung plattformweit, mit Mandant - dieselben Spalten wie {@code MeldungenController.dto}. */
    public record AdminMeldungZeile(UUID id, String kennzeichen, UUID tenantId, String tenantName,
            UUID standortId, String bezugKennung, String wertart, String schwere, Instant ausgeloestAm,
            String zustand, Instant wiederNormalAm, String gesehenVon, Instant gesehenAm,
            Instant erledigtAm) {
    }

    private static final String SPALTEN = "a.id, a.kennzeichen, a.tenant_id, t.name AS tenant_name, "
            + "a.standort_id, a.bezug_kennung, a.wertart, a.schwere, a.ausgeloest_am, a.zustand, "
            + "a.wieder_normal_am, a.gesehen_von, a.gesehen_am, a.erledigt_am";

    /** Jetzt = nicht erledigt; Verlauf = erledigt - höchstens {@code limit}, jüngste zuerst. */
    public List<AdminMeldungZeile> liste(boolean erledigt, int limit) {
        return jdbc.query(
                "SELECT " + SPALTEN + " FROM alarm a JOIN tenant t ON t.id = a.tenant_id "
                        + "WHERE (a.zustand = 'erledigt') = ? ORDER BY a.ausgeloest_am DESC LIMIT ?",
                AdminMeldungenRepository::map, erledigt, limit);
    }

    /** Für "Braucht dich" der neuen Übersicht: offene, ungesehene Meldungen über die ganze Flotte. */
    public long ungeseheneZahl() {
        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM alarm WHERE zustand <> 'erledigt' AND gesehen_von IS NULL",
                Long.class);
        return n == null ? 0 : n;
    }

    private static AdminMeldungZeile map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        java.sql.Timestamp ausgeloestAm = rs.getTimestamp("ausgeloest_am");
        java.sql.Timestamp wiederNormalAm = rs.getTimestamp("wieder_normal_am");
        java.sql.Timestamp gesehenAm = rs.getTimestamp("gesehen_am");
        java.sql.Timestamp erledigtAm = rs.getTimestamp("erledigt_am");
        return new AdminMeldungZeile(
                rs.getObject("id", UUID.class),
                rs.getString("kennzeichen"),
                rs.getObject("tenant_id", UUID.class),
                rs.getString("tenant_name"),
                rs.getObject("standort_id", UUID.class),
                rs.getString("bezug_kennung"),
                rs.getString("wertart"),
                rs.getString("schwere"),
                ausgeloestAm.toInstant(),
                rs.getString("zustand"),
                wiederNormalAm == null ? null : wiederNormalAm.toInstant(),
                rs.getString("gesehen_von"),
                gesehenAm == null ? null : gesehenAm.toInstant(),
                erledigtAm == null ? null : erledigtAm.toInstant());
    }
}
