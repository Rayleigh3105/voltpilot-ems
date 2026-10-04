package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * MiSpeL MP-33e: die Messlatte „nur laden“ je Ladepunkt und Viertelstunde ({@code ladepunkt_messlatte},
 * V20261004173000, Vertrag {@code docs/contracts/v2/mispel-messlatte-nur-laden.md} § 3), unter RLS. Hier wird nur
 * gelesen; abgelegt wird vom Optimierer mit jedem Plan ({@code persistence.messlatte_rows}).
 */
@Repository
public class LadepunktMesslatteRepository {

    private final JdbcTemplate jdbc;

    public LadepunktMesslatteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Summen eines Ladepunkts über ein Fenster und wie viele Viertelstunden sie tragen. */
    public record Summe(long viertelstunden, BigDecimal wenigerGekauftEur, BigDecimal wenigerGekauftKwh,
            BigDecimal mehrGeladenEur, BigDecimal mehrGeladenKwh, BigDecimal insNetzVerkauftEur,
            BigDecimal insNetzVerkauftKwh, BigDecimal akkuVerschleissEur, BigDecimal rueckgespeistKwh) {}

    /** Je Ladepunkt der Anlage die Summen über {@code [von, bis)}; ein Ladepunkt ohne Zeile fehlt. */
    public Map<UUID, Summe> summen(UUID siteId, Instant von, Instant bis) {
        Map<UUID, Summe> raus = new LinkedHashMap<>();
        jdbc.query("SELECT komponente_id, count(*) AS n, sum(weniger_gekauft_eur) AS wg_eur, "
                + "sum(weniger_gekauft_kwh) AS wg_kwh, sum(mehr_geladen_eur) AS mg_eur, "
                + "sum(mehr_geladen_kwh) AS mg_kwh, sum(ins_netz_verkauft_eur) AS nv_eur, "
                + "sum(ins_netz_verkauft_kwh) AS nv_kwh, sum(akku_verschleiss_eur) AS av_eur, "
                + "sum(rueckgespeist_kwh) AS rs_kwh FROM ladepunkt_messlatte "
                + "WHERE site_id = ? AND zeit >= ? AND zeit < ? GROUP BY komponente_id ORDER BY komponente_id",
                rs -> {
                    raus.put(rs.getObject("komponente_id", UUID.class), new Summe(rs.getLong("n"),
                            rs.getBigDecimal("wg_eur"), rs.getBigDecimal("wg_kwh"), rs.getBigDecimal("mg_eur"),
                            rs.getBigDecimal("mg_kwh"), rs.getBigDecimal("nv_eur"), rs.getBigDecimal("nv_kwh"),
                            rs.getBigDecimal("av_eur"), rs.getBigDecimal("rs_kwh")));
                },
                siteId, Timestamp.from(von), Timestamp.from(bis));
        return raus;
    }
}
