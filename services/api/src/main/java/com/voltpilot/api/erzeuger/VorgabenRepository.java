package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Leseseite der Vorgaben (UEMS EZ-7) für die Routen: jede Abfrage geht über {@code site}, eine fremde oder
 * umzäunte Anlage liefert nichts (404 im Dienst). Geschrieben wird nur vom {@link VorgabenLaeufer}.
 */
@Repository
public class VorgabenRepository {

    /** Eine Vorgabe, wie sie in {@code erzeuger_vorgabe} steht. */
    public record Zeile(UUID id, UUID geraetId, Integer teNr, String urheber, String art, Instant beginn,
            boolean beginnGenau, Instant ende, boolean endeGenau, Instant gesehenBis, BigDecimal vorgabeProzent,
            BigDecimal vorgabeW, BigDecimal istMittelW, BigDecimal verfuegbarMittelW, BigDecimal energieKwh,
            String methode, Map<String, BigDecimal> energieJeTag, BigDecimal wertEur, String kanal, String bindung,
            boolean unvollstaendig, boolean neustart, Integer zaehlerBeginn, Integer zaehlerEnde, List<String> gruende,
            Map<String, BigDecimal> rohBeginn, Map<String, BigDecimal> rohEnde, String einheitName) {

        /** Bis wohin sie belegt ist: das Ende, bei einer laufenden die letzte Lesung, in der sie galt. */
        public Instant belegtBis() {
            return ende != null ? ende : gesehenBis;
        }
    }

    /** Eine Lücke mit weiteren Wechseln. */
    public record LueckeZeile(UUID id, UUID geraetId, String urheber, Instant beginn, Instant ende,
            Integer weitereWechsel, boolean neustart, Integer zaehlerVorher, Integer zaehlerNachher) {}

    /** Eine Probe eines Rohsignals. */
    public record Signal(String pointKey, Instant zeit, BigDecimal wert, String qualitaet) {}

    private static final TypeReference<Map<String, BigDecimal>> ZAHLEN = new TypeReference<>() {};

    private static final String VORGABE = "SELECT v.id, v.geraet_id, v.te_nr, v.urheber, v.art, v.beginn, "
            + "v.beginn_genau, v.ende, v.ende_genau, v.gesehen_bis, v.vorgabe_prozent, v.vorgabe_w, v.ist_mittel_w, "
            + "v.verfuegbar_mittel_w, v.energie_kwh, v.methode, v.energie_je_tag::text AS energie_je_tag, v.wert_eur, "
            + "v.kanal, v.bindung, v.unvollstaendig, v.neustart, v.zaehler_beginn, v.zaehler_ende, v.gruende, "
            + "v.roh_beginn::text AS roh_beginn, v.roh_ende::text AS roh_ende, "
            + "(SELECT t.bezeichnung FROM geraet_teil t WHERE t.geraet_id = v.geraet_id "
            + "AND t.teilart = 'erzeugungseinheit' AND t.te_nr = v.te_nr ORDER BY t.eingebaut_am DESC LIMIT 1) "
            + "AS einheit_name "
            + "FROM erzeuger_vorgabe v JOIN site s ON s.id = v.site_id ";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public VorgabenRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /**
     * Hat oder hatte die Anlage eine Anlagensteuerung (EZ-6)? Dann gehören ihre Vorgaben in den Verlauf (EZ-9) -
     * auch nach dem Ausbau, die Vorgaben von damals bleiben.
     */
    public boolean hatSteuerung(UUID siteId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM geraet g "
                + "JOIN site s ON s.id = g.site_id JOIN geraet_komponente k ON k.geraet_id = g.id "
                + "JOIN measurement_point m ON m.id = k.entity_id AND m.entity_type = ? "
                + "WHERE g.site_id = ? AND g.geraeteart = 'controller')", Boolean.class,
                AnlagensteuerungRepository.ENTITY_TYPE, siteId));
    }

    public boolean anlageSichtbar(UUID siteId) {
        return !jdbc.queryForList("SELECT s.id FROM site s WHERE s.id = ?", UUID.class, siteId).isEmpty();
    }

    /**
     * Die Vorgaben, die {@code [von, bis)} berühren — eine laufende bis zu ihrer letzten Lesung — nach Beginn;
     * wahlweise nur eines Urhebers und/oder einer Einheit ({@code teNr} 0 = nur die ganze Anlage).
     */
    public List<Zeile> vorgaben(UUID siteId, Instant von, Instant bis, String urheber, Integer teNr) {
        return jdbc.query(VORGABE + "WHERE v.site_id = ? AND v.beginn < ? "
                + "AND (coalesce(v.ende, v.gesehen_bis) >= ? OR v.beginn >= ?) "
                + "AND (?::text IS NULL OR v.urheber = ?) "
                + "AND (?::integer IS NULL OR (? = 0 AND v.te_nr IS NULL) OR v.te_nr = ?) "
                + "ORDER BY v.beginn, v.urheber, v.art, v.te_nr NULLS FIRST", this::zeile, siteId, Timestamp.from(bis),
                Timestamp.from(von), Timestamp.from(von), urheber, urheber, teNr, teNr, teNr);
    }

    public Optional<Zeile> vorgabe(UUID siteId, UUID id) {
        return jdbc.query(VORGABE + "WHERE v.site_id = ? AND v.id = ?", this::zeile, siteId, id).stream().findFirst();
    }

    /** Die Lücken mit weiteren Wechseln, die {@code [von, bis)} berühren. */
    public List<LueckeZeile> luecken(UUID siteId, Instant von, Instant bis, String urheber) {
        return jdbc.query("SELECT l.id, l.geraet_id, l.urheber, l.beginn, l.ende, l.weitere_wechsel, l.neustart, "
                + "l.zaehler_vorher, l.zaehler_nachher FROM erzeuger_vorgabe_luecke l JOIN site s ON s.id = l.site_id "
                + "WHERE l.site_id = ? AND l.beginn < ? AND l.ende >= ? AND (?::text IS NULL OR l.urheber = ?) "
                + "ORDER BY l.beginn, l.urheber",
                (rs, n) -> new LueckeZeile(rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class),
                        rs.getString("urheber"), rs.getTimestamp("beginn").toInstant(),
                        rs.getTimestamp("ende").toInstant(), (Integer) rs.getObject("weitere_wechsel"),
                        rs.getBoolean("neustart"), (Integer) rs.getObject("zaehler_vorher"),
                        (Integer) rs.getObject("zaehler_nachher")),
                siteId, Timestamp.from(bis), Timestamp.from(von), urheber, urheber);
    }

    /** Bis wohin der Läufer die Anlage verarbeitet hat (die älteste ihrer Steuerungen); leer = noch nie. */
    public Optional<Instant> verarbeitetBis(UUID siteId) {
        Timestamp t = jdbc.queryForObject("SELECT min(l.verarbeitet_bis) FROM erzeuger_vorgabe_lauf l "
                + "JOIN site s ON s.id = l.site_id WHERE l.site_id = ?", Timestamp.class, siteId);
        return Optional.ofNullable(t).map(Timestamp::toInstant);
    }

    /** Die Komponente der Steuerung, über die ihre Werte laufen (die jüngste Bindung). */
    public Optional<UUID> komponente(UUID geraetId) {
        return jdbc.queryForList("SELECT k.entity_id FROM geraet_komponente k JOIN geraet g ON g.id = k.geraet_id "
                + "JOIN site s ON s.id = g.site_id WHERE k.geraet_id = ? ORDER BY k.gueltig_ab DESC LIMIT 1",
                UUID.class, geraetId).stream().findFirst();
    }

    /** Die Proben der Rohsignale einer Vorgabe in {@code [von, bis]}, höchstens {@code grenze} Stück. */
    public List<Signal> signale(UUID siteId, UUID entityId, List<String> punkte, Instant von, Instant bis,
            int grenze) {
        return jdbc.query("SELECT d.point_key, d.time, coalesce(d.decoded_numeric, d.raw_numeric) AS wert, d.quality "
                + "FROM device_measurement_sample d JOIN site s ON s.id = d.site_id "
                + "WHERE d.site_id = ? AND d.entity_id = ? AND d.point_key = ANY(?) AND d.time >= ? AND d.time <= ? "
                + "AND d.role IS DISTINCT FROM 'spiegel' ORDER BY d.time, d.point_key LIMIT ?",
                (rs, n) -> new Signal(rs.getString("point_key"), rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("wert"), rs.getString("quality")),
                siteId, entityId, punkte.toArray(String[]::new), Timestamp.from(von), Timestamp.from(bis), grenze);
    }

    private Zeile zeile(ResultSet rs, int n) throws SQLException {
        Timestamp ende = rs.getTimestamp("ende");
        Array gruende = rs.getArray("gruende");
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class),
                (Integer) rs.getObject("te_nr"), rs.getString("urheber"), rs.getString("art"),
                rs.getTimestamp("beginn").toInstant(), rs.getBoolean("beginn_genau"),
                ende == null ? null : ende.toInstant(), rs.getBoolean("ende_genau"),
                rs.getTimestamp("gesehen_bis").toInstant(), rs.getBigDecimal("vorgabe_prozent"),
                rs.getBigDecimal("vorgabe_w"), rs.getBigDecimal("ist_mittel_w"),
                rs.getBigDecimal("verfuegbar_mittel_w"), rs.getBigDecimal("energie_kwh"), rs.getString("methode"),
                zahlen(rs.getString("energie_je_tag")), rs.getBigDecimal("wert_eur"), rs.getString("kanal"),
                rs.getString("bindung"), rs.getBoolean("unvollstaendig"), rs.getBoolean("neustart"),
                (Integer) rs.getObject("zaehler_beginn"), (Integer) rs.getObject("zaehler_ende"),
                gruende == null ? List.of() : Arrays.asList((String[]) gruende.getArray()),
                zahlen(rs.getString("roh_beginn")), zahlen(rs.getString("roh_ende")), rs.getString("einheit_name"));
    }

    private Map<String, BigDecimal> zahlen(String text) {
        try {
            return text == null ? Map.of() : json.readValue(text, ZAHLEN);
        } catch (Exception e) {
            throw new IllegalStateException("JSON einer Vorgabe nicht lesbar", e);
        }
    }
}
