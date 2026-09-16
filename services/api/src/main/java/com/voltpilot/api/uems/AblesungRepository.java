package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Der Ablesungs-Eingang derselben Rohwertstrecke; der Trigger hält die Herkunft dauerhaft fest. */
@Repository
public class AblesungRepository {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    public AblesungRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @com.fasterxml.jackson.databind.annotation.JsonNaming(com.fasterxml.jackson.databind.PropertyNamingStrategies.SnakeCaseStrategy.class)
    public record Wert(UUID quelle, Instant zeitpunkt, int fassung, BigDecimal stand, LocalDate monat,
            String woher, JsonNode urheber, String korrektur, Instant eingetragenAm) {}
    public record Zone(ZoneId id, String herkunft) {}

    public void sperren(UUID tenant, UUID messstelle) {
        jdbc.queryForList("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?, 0))", Integer.class,
                "ablesungen:" + tenant + ":" + messstelle);
        jdbc.queryForList("SELECT id FROM messstelle WHERE tenant_id = ? AND id = ? FOR SHARE",
                UUID.class, tenant, messstelle);
    }

    public boolean vierAugen(UUID tenant) {
        List<Boolean> a = jdbc.queryForList("SELECT vieraugen_freigabe FROM unternehmen WHERE tenant_id = ? FOR SHARE",
                Boolean.class, tenant);
        return !a.isEmpty() && Boolean.TRUE.equals(a.get(0));
    }

    public UUID quelle(UUID tenant, UUID messstelle) {
        return jdbc.queryForList("SELECT id FROM messstelle_quelle WHERE tenant_id = ? AND messstelle_id = ? "
                + "AND art = 'ablesung' AND rolle = 'fuehrend' ORDER BY gueltig_ab DESC LIMIT 1",
                UUID.class, tenant, messstelle).stream().findFirst().orElse(null);
    }

    public UUID anlegen(UUID tenant, MessstelleRepository.Messstelle m, Instant zeit, ProtokollAkteur wer, Instant jetzt) {
        var g = m.hauptgroesse();
        return jdbc.queryForObject("INSERT INTO messstelle_quelle (tenant_id,messstelle_id,groesse,richtung,kanal,"
                + "kanal_wertart,herleitung,rolle,gueltig_ab,rueckwirkend,eingetragen_am,actor_sub,actor_name,"
                + "actor_rolle,actor_art,art) VALUES (?,?,?,?,?,'counter','differenzen','fuehrend',?,?,?,?,?,?,?,'ablesung') RETURNING id",
                UUID.class, tenant, m.id(), g.groesse(), g.richtung(), "ablesung:" + g.groesse(),
                Timestamp.from(zeit), zeit.isBefore(jetzt), Timestamp.from(jetzt), wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    public boolean hatKanal(UUID tenant, UUID messstelle) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM messstelle_quelle "
                + "WHERE tenant_id = ? AND messstelle_id = ? AND art IS DISTINCT FROM 'ablesung' AND rolle = 'fuehrend')",
                Boolean.class, tenant, messstelle));
    }

    public List<Wert> werte(UUID tenant, UUID quelle) {
        return jdbc.query("SELECT DISTINCT ON (zeitpunkt) * FROM messstelle_ablesung_fassung "
                + "WHERE tenant_id = ? AND quelle_id = ? ORDER BY zeitpunkt, fassung DESC", (rs, n) -> new Wert(quelle,
                rs.getTimestamp("zeitpunkt").toInstant(), rs.getInt("fassung"), rs.getBigDecimal("stand"),
                rs.getObject("zuordnung_monat", LocalDate.class), rs.getString("woher"), json(rs.getString("urheber")),
                rs.getString("korrektur"), rs.getTimestamp("eingetragen_am").toInstant()), tenant, quelle);
    }

    public List<Wert> fassungen(UUID tenant, UUID quelle) {
        return jdbc.query("SELECT * FROM messstelle_ablesung_fassung WHERE tenant_id = ? AND quelle_id = ? "
                + "ORDER BY zeitpunkt, fassung", (rs, n) -> new Wert(quelle, rs.getTimestamp("zeitpunkt").toInstant(),
                rs.getInt("fassung"), rs.getBigDecimal("stand"), rs.getObject("zuordnung_monat", LocalDate.class),
                rs.getString("woher"), json(rs.getString("urheber")), rs.getString("korrektur"),
                rs.getTimestamp("eingetragen_am").toInstant()), tenant, quelle);
    }

    public void schreiben(UUID tenant, Wert w) {
        jdbc.update("INSERT INTO device_measurement_sample (time,received_at,tenant_id,point_key,raw_numeric,"
                + "decoded_numeric,quality,aggregation_kind,value_kind,role,ablesung_quelle_id,ablesung_fassung,"
                + "ablesung_stand,zuordnung_monat,woher,urheber,ablesung_korrektur) "
                + "VALUES (?,?,?,'ablesung',?,?,'good','counter','counter','fuehrend',?,?,?,?,?,?::jsonb,?)",
                Timestamp.from(w.zeitpunkt()), Timestamp.from(w.eingetragenAm()), tenant, w.stand().doubleValue(),
                w.stand().doubleValue(), w.quelle(), w.fassung(), w.stand(), w.monat(), w.woher(),
                w.urheber().toString(), w.korrektur());
    }

    public Zone zone(UUID tenant, UUID messstelle, Instant zeit) {
        // Standort der zeitgültigen Ortszuordnung, auch über Gebäude/Bereich (keine Anlagen- oder Boxannahme).
        List<String> z = jdbc.queryForList("WITH RECURSIVE orte AS ("
                + "SELECT mo.ort_id id, mo.standort_id FROM messstelle_ort mo WHERE mo.tenant_id = ? "
                + "AND mo.messstelle_id = ? AND mo.aufgehoben_am IS NULL "
                + "AND daterange(mo.gueltig_ab,mo.gueltig_bis,'[]') @> (?::timestamptz AT TIME ZONE 'Europe/Berlin')::date "
                + "UNION SELECT z.eltern_ort_id,z.eltern_standort_id FROM ort_zuordnung z JOIN orte o ON o.id = z.ort_id "
                + "WHERE z.tenant_id = ? AND z.aufgehoben_am IS NULL "
                + "AND daterange(z.gueltig_ab,z.gueltig_bis,'[]') @> (?::timestamptz AT TIME ZONE 'Europe/Berlin')::date) "
                + "SELECT s.zeitzone FROM orte o JOIN standort s ON s.id = o.standort_id AND s.tenant_id = ? LIMIT 1",
                String.class, tenant, messstelle, Timestamp.from(zeit), tenant, Timestamp.from(zeit), tenant);
        if (!z.isEmpty()) return new Zone(ZoneId.of(z.get(0)), "standort");
        z = jdbc.queryForList("SELECT zeitzone FROM unternehmen WHERE tenant_id = ?", String.class, tenant);
        return z.isEmpty() ? new Zone(ZoneId.of(TagRegeln.VORGABE_ZONE), "vorgabe")
                : new Zone(ZoneId.of(z.get(0)), "unternehmen");
    }

    static JsonNode json(String s) {
        try { return JSON.readTree(s); }
        catch (Exception e) { throw new IllegalStateException("Ablesungsherkunft nicht lesbar", e); }
    }
}
