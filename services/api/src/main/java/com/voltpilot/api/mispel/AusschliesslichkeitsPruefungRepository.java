package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;
import com.voltpilot.api.mispel.AusschliesslichkeitsPruefer.Viertelstunde;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * MiSpeL MP-2: die Lesequellen des Ausschließlichkeits-Prüfers — CROSS-TENANT, nur lesend.
 *
 * <p>Dieselbe RLS-Umgehung wie {@link com.voltpilot.api.repo.AdminFleetRepository}: die dedizierte
 * {@code adminJdbcTemplate}-Verbindung (BYPASSRLS-Rolle {@code voltpilot_admin}), erreichbar ausschließlich aus
 * {@code AdminMispelController} ({@code @PreAuthorize("hasRole('platform-admin')")}). Kein Schreibpfad.
 *
 * <p>Die Viertelstunden kommen aus {@code telemetry_rollup_15m}: Netzbezug und Netzeinspeisung am Netzanschluss
 * ({@code grid_import_kwh}, {@code grid_export_kwh}) als Z1NB¼ und Z1NE¼, Laden und Entladen des Speichers
 * ({@code battery_charge_kwh}, {@code battery_discharge_kwh}) als Z2V¼ und Z2E¼. Das sind Gerätewerte der Box, keine
 * Werte des Messstellenbetreibers; {@code NULL} bleibt {@code null} (unbekannt).
 */
@Repository
public class AusschliesslichkeitsPruefungRepository {

    private final JdbcTemplate jdbc;

    public AusschliesslichkeitsPruefungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * Stammdaten einer Anlage für die Auswertung.
     *
     * @param speicherErfasst die Anlage hat ein Asset {@code battery}; ohne Speicher ist Laden/Entladen in der
     *     Verdichtung nur der Rest der Leistungsbilanz
     * @param netzladenErlaubt Netzladen ist für die Anlage freigegeben — dann ist sie bewusst kein reiner
     *     EE-Speicher
     */
    @JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Anlage(UUID siteId, String name, UUID tenantId, String tenantName, boolean speicherErfasst,
            boolean netzladenErlaubt) {}

    private static final String ANLAGE = "SELECT s.id, s.name, s.tenant_id, t.name AS tenant_name, s.netzladen_erlaubt,"
            + " EXISTS (SELECT 1 FROM asset a WHERE a.site_id = s.id AND a.type = 'battery') AS speicher"
            + " FROM site s JOIN tenant t ON t.id = s.tenant_id ";

    public Optional<Anlage> anlage(UUID siteId) {
        return jdbc.query(ANLAGE + "WHERE s.id = ?", (rs, n) -> anlage(rs), siteId).stream().findFirst();
    }

    /** Alle Anlagen mit erfasstem Speicher, nach Mandant und Name. */
    public List<Anlage> anlagenMitSpeicher() {
        return jdbc.query(ANLAGE + "WHERE EXISTS (SELECT 1 FROM asset a WHERE a.site_id = s.id AND a.type = 'battery')"
                + " ORDER BY t.name, s.name, s.id", (rs, n) -> anlage(rs));
    }

    private static Anlage anlage(ResultSet rs) throws SQLException {
        return new Anlage(rs.getObject("id", UUID.class), rs.getString("name"), rs.getObject("tenant_id", UUID.class),
                rs.getString("tenant_name"), rs.getBoolean("speicher"), rs.getBoolean("netzladen_erlaubt"));
    }

    /** Die verdichteten Viertelstunden einer Anlage in [von, bis), aufsteigend. */
    public List<Viertelstunde> viertelstunden(UUID siteId, Instant von, Instant bis) {
        return jdbc.query("SELECT r.bucket, r.grid_import_kwh, r.grid_export_kwh, r.battery_charge_kwh,"
                        + " r.battery_discharge_kwh"
                        + " FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id"
                        + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ? ORDER BY r.bucket",
                (rs, n) -> new Viertelstunde(rs.getTimestamp("bucket").toInstant(),
                        rs.getBigDecimal("grid_import_kwh"), rs.getBigDecimal("grid_export_kwh"),
                        rs.getBigDecimal("battery_charge_kwh"), rs.getBigDecimal("battery_discharge_kwh")),
                siteId, Timestamp.from(von), Timestamp.from(bis));
    }
}
