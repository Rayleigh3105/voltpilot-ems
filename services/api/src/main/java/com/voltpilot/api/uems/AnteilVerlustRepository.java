package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Anteils-Verlust je Box und Tag (UEMS AP-15 IP-22, E1 = A, R2; {@code steuerungsverbund_anteil_verlust},
 * V20260922050000). Geschrieben nur vom {@link AnteilVerlustAusHerzschlag} unter dem {@code TenantContext} des
 * Herzschlags, gelesen von der Auskunft {@code GET …/gemeinsame-steuerung} je Mitglied.
 */
@Repository
public class AnteilVerlustRepository {

    /** Summe über die gemeldeten Tage: kWh (Untergrenze), Sekunden, in denen der Anteil band, und wie viele Tage. */
    public record Summe(BigDecimal kwh, long gebundenS, int tage) {}

    private final JdbcTemplate jdbc;

    public AnteilVerlustRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Der Stand eines Tages. Der Zähler der Box wächst innerhalb des Tages nur — darum gilt das Größere, eine
     * verspätete oder doppelt zugestellte Nachricht senkt nichts.
     */
    public void melde(UUID tenantId, UUID siteId, UUID deviceId, LocalDate tag, BigDecimal kwh, int gebundenS) {
        jdbc.update("INSERT INTO steuerungsverbund_anteil_verlust (tenant_id, site_id, device_id, tag, verlust_kwh, "
                + "gebunden_s) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, tag) DO UPDATE SET "
                + "verlust_kwh = GREATEST(steuerungsverbund_anteil_verlust.verlust_kwh, EXCLUDED.verlust_kwh), "
                + "gebunden_s = GREATEST(steuerungsverbund_anteil_verlust.gebunden_s, EXCLUDED.gebunden_s), "
                + "gemeldet_am = now()", tenantId, siteId, deviceId, tag, kwh, gebundenS);
    }

    /** Die Summe der Box an der Anlage über {@code [von, bis]} (Tage der Anlage); leer, wenn kein Tag gemeldet ist. */
    public Optional<Summe> summe(UUID siteId, UUID deviceId, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT sum(verlust_kwh) AS kwh, sum(gebunden_s) AS s, count(*) AS n "
                        + "FROM steuerungsverbund_anteil_verlust WHERE site_id = ? AND device_id = ? "
                        + "AND tag BETWEEN ? AND ?",
                rs -> {
                    if (!rs.next() || rs.getInt("n") == 0) {
                        return Optional.<Summe>empty();
                    }
                    return Optional.of(new Summe(rs.getBigDecimal("kwh"), rs.getLong("s"), rs.getInt("n")));
                }, siteId, deviceId, von, bis);
    }
}
