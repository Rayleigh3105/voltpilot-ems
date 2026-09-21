package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.GeraeteRueckfall;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Der am Gerät hinterlegte Rückfall je Komponente und Richtung (UEMS AP-15 IP-6, {@code V20260921150000}). Unter RLS —
 * die App-Rolle sieht nur ihren Kundenbereich. Eine Angabe wird aufgehoben, nie geändert; die aufgehobenen Zeilen
 * sind das Protokoll (wer/wann).
 */
@Repository
public class GeraeteRueckfallRepository {

    /** Eine Angabe mit wer/wann; {@code aufgehobenAm} fehlt bei der wirksamen. */
    public record Zeile(UUID id, UUID komponente, String richtung, GeraeteRueckfall rueckfall, BigDecimal rueckfallKw,
            Integer nachS, String hinweis, String eingetragenVon, Instant eingetragenAm, Instant aufgehobenAm) {

        public GeraeteRueckfallRegel.Angabe angabe() {
            return new GeraeteRueckfallRegel.Angabe(rueckfall, rueckfallKw, nachS);
        }
    }

    private static final String SPALTEN = "id, entity_id, richtung, rueckfall, rueckfall_kw, nach_s, hinweis, "
            + "created_by, created_at, aufgehoben_am";

    private static final RowMapper<Zeile> ZEILE = (rs, n) -> new Zeile(
            rs.getObject("id", UUID.class),
            rs.getObject("entity_id", UUID.class),
            rs.getString("richtung"),
            wort(rs.getString("rueckfall")),
            ohneNullen(rs.getBigDecimal("rueckfall_kw")),
            (Integer) rs.getObject("nach_s"),
            rs.getString("hinweis"),
            rs.getString("created_by"),
            rs.getTimestamp("created_at").toInstant(),
            rs.getTimestamp("aufgehoben_am") == null ? null : rs.getTimestamp("aufgehoben_am").toInstant());

    private final JdbcTemplate jdbc;

    public GeraeteRueckfallRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die wirksame Angabe einer Komponente in einer Richtung, oder {@code null}. */
    public Zeile wirksam(UUID komponente, String richtung) {
        List<Zeile> zeilen = jdbc.query("SELECT " + SPALTEN + " FROM komponente_geraete_rueckfall "
                + "WHERE entity_id = ? AND richtung = ? AND aufgehoben_am IS NULL", ZEILE, komponente, richtung);
        return zeilen.isEmpty() ? null : zeilen.get(0);
    }

    /** Alle Angaben einer Komponente, auch die aufgehobenen — neueste zuerst (das Protokoll). */
    public List<Zeile> verlauf(UUID komponente) {
        return jdbc.query("SELECT " + SPALTEN + " FROM komponente_geraete_rueckfall WHERE entity_id = ? "
                + "ORDER BY created_at DESC, id", ZEILE, komponente);
    }

    /** Hält die Komponente bis zum Ende der Transaktion: zwei Angaben derselben Richtung laufen nacheinander. */
    public void sperren(UUID komponente) {
        jdbc.queryForList("SELECT id FROM measurement_point WHERE id = ? FOR UPDATE", UUID.class, komponente);
    }

    public void aufheben(UUID id, Instant jetzt) {
        jdbc.update("UPDATE komponente_geraete_rueckfall SET aufgehoben_am = ? WHERE id = ?", Timestamp.from(jetzt),
                id);
    }

    public UUID eintragen(UUID tenant, UUID komponente, String richtung, GeraeteRueckfallRegel.Angabe angabe,
            String hinweis, String wer) {
        return jdbc.queryForObject("INSERT INTO komponente_geraete_rueckfall (tenant_id, entity_id, richtung, "
                + "rueckfall, rueckfall_kw, nach_s, hinweis, created_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class, tenant, komponente, richtung, angabe.rueckfall().code(), angabe.rueckfallKw(),
                angabe.nachS(), hinweis, wer);
    }

    private static GeraeteRueckfall wort(String code) {
        return Arrays.stream(GeraeteRueckfall.values()).filter(w -> w.code().equals(code)).findFirst()
                .orElseThrow(() -> new IllegalStateException("unbekanntes Wort: " + code));
    }

    /** {@code 40.000} aus NUMERIC(12,3) wird {@code 40} — die Zahl, die eingetragen wurde. */
    private static BigDecimal ohneNullen(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal kurz = wert.stripTrailingZeros();
        return kurz.scale() < 0 ? kurz.setScale(0) : kurz;
    }
}
