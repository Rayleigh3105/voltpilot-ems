package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Das Grenzblatt am Netzanschluss (UEMS AP-15 IP-3, {@code V20260921120000}): die wirksamen Fassungen je Anschluss.
 * Unter RLS — die App-Rolle sieht nur ihren Kundenbereich. Eine Fassung wird aufgehoben, nie geändert.
 */
@Repository
public class NetzanschlussGrenzeRepository {

    /** Eine wirksame (nicht aufgehobene) Fassung mit ihrer Eintragszeit. */
    public record Zeile(UUID id, LocalDate gueltigAb, BigDecimal einspeisegrenzeKw, BigDecimal bezugsgrenzeKw,
            Instant eingetragenAm) {

        public GrenzeAufloesung.Fassung fassung() {
            return new GrenzeAufloesung.Fassung(gueltigAb, einspeisegrenzeKw, bezugsgrenzeKw);
        }

        public OffsetDateTime eingetragen() {
            return eingetragenAm.atOffset(ZoneOffset.UTC);
        }
    }

    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class),
            rs.getObject("gueltig_ab", LocalDate.class),
            ohneNullen(rs.getBigDecimal("einspeisegrenze_kw")),
            ohneNullen(rs.getBigDecimal("bezugsgrenze_kw")),
            rs.getTimestamp("created_at").toInstant());

    private final JdbcTemplate jdbc;

    public NetzanschlussGrenzeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die wirksamen Fassungen eines Anschlusses, nach erstem Tag. */
    public List<Zeile> fassungen(UUID netzanschluss) {
        return jdbc.query("SELECT id, gueltig_ab, einspeisegrenze_kw, bezugsgrenze_kw, created_at "
                + "FROM netzanschluss_grenze WHERE netzanschluss_id = ? AND aufgehoben_am IS NULL "
                + "ORDER BY gueltig_ab, id", ZEILE, netzanschluss);
    }

    /** Hält den Anschluss bis zum Ende der Transaktion: zwei Fassungen desselben Tages laufen nacheinander. */
    public void sperren(UUID netzanschluss) {
        jdbc.queryForList("SELECT id FROM netzanschluss WHERE id = ? FOR UPDATE", UUID.class, netzanschluss);
    }

    public void aufheben(UUID id, Instant jetzt) {
        jdbc.update("UPDATE netzanschluss_grenze SET aufgehoben_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    public UUID eintragen(UUID tenant, UUID netzanschluss, LocalDate ab, BigDecimal einspeisung, BigDecimal bezug,
            String wer) {
        return jdbc.queryForObject("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, "
                + "einspeisegrenze_kw, bezugsgrenze_kw, created_by) VALUES (?,?,?,?,?,?) RETURNING id", UUID.class,
                tenant, netzanschluss, ab, einspeisung, bezug, wer);
    }

    /** {@code 100.000} aus NUMERIC(12,3) wird {@code 100} — die Zahl, die eingetragen wurde. */
    private static BigDecimal ohneNullen(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal kurz = wert.stripTrailingZeros();
        return kurz.scale() < 0 ? kurz.setScale(0) : kurz;
    }
}
