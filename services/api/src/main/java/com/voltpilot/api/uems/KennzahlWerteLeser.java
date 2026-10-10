package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

/**
 * Liest, was der Rechenlauf und die Kaskade von einer Kennzahl gespeichert haben (UEMS AP-11 IP-7): jede Zeile von
 * {@code kennzahl_wert} mit der NUMMER ihrer Definitions-Fassung, und was eine Zeile von jedem Eingang las
 * ({@code kennzahl_wert_eingang}). Nur lesen, unter der RLS der Anwendungsrolle; welche Zeile ein Schritt zeigt,
 * entscheidet {@link KennzahlWerteService}.
 */
public class KennzahlWerteLeser {

    /**
     * Eine gespeicherte Zeile. Werte sind append-only: eine vorläufige Version zieht als weitere Zeile derselben Nummer
     * nach — die aktuelle ist die mit der höchsten Version, dann dem jüngsten {@code berechnet_am}.
     */
    public record Zeile(UUID id, LocalDate periodeVon, LocalDate periodeBis, ZoneId zone, Integer version,
            BigDecimal wert, BigDecimal zaehler, BigDecimal nenner, String mengeZustand, List<String> kennzeichen,
            BigDecimal abdeckungProzent, String richtung, String grund, String zustand, Instant endgueltigAb,
            int definitionFassung, Instant berechnetAm, String anlassArt, String anlassKennung) {}

    /** Was eine Zeile von einem Eingang las — der Wert, die Version bzw. Fassung und seine Kennzeichen beim Bilden. */
    public record Eingang(int position, String rolle, String art, String objekt, BigDecimal wert, BigDecimal zaehler,
            BigDecimal nenner, String einheit, String mengeZustand, BigDecimal abdeckungProzent, Integer version,
            Integer fassung, List<String> kennzeichen) {}

    private final JdbcTemplate jdbc;

    public KennzahlWerteLeser(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Jede Zeile der Perioden einer Art, deren erster Tag in {@code [von, bis]} liegt — je Periode in der Folge ihrer
     * Bildung: noch ohne Version zuerst, dann nach Version und {@code berechnet_am}. Die letzte Zeile einer Periode ist
     * damit ihre aktuelle.
     */
    public List<Zeile> zeilen(UUID kennzahl, String periodeArt, LocalDate von, LocalDate bis) {
        return jdbc.query("SELECT w.id, w.periode_von, w.periode_bis, w.zeitzone, w.version, w.wert, w.zaehler, "
                + "w.nenner, w.menge_zustand, w.kennzeichen::text AS kennzeichen, w.abdeckung_prozent, w.richtung, "
                + "w.grund, w.zustand, w.endgueltig_ab, f.nummer AS definition_fassung, w.berechnet_am, w.anlass_art, "
                + "w.anlass_kennung FROM kennzahl_wert w JOIN kennzahl_fassung f ON f.id = w.definition_fassung_id "
                + "WHERE w.kennzahl_id = ? AND w.periode_art = ? AND w.periode_von BETWEEN ? AND ? "
                + "ORDER BY w.periode_von, w.version NULLS FIRST, w.berechnet_am",
                (rs, i) -> zeile(rs), kennzahl, periodeArt, Date.valueOf(von), Date.valueOf(bis));
    }

    /** Die Eingänge der genannten Zeilen, je Zeile nach Position; eine Zeile ohne Eingang fehlt in der Antwort. */
    public Map<UUID, List<Eingang>> eingaenge(Collection<UUID> werte) {
        Map<UUID, List<Eingang>> aus = new LinkedHashMap<>();
        if (werte.isEmpty()) {
            return aus;
        }
        jdbc.query("SELECT wert_id, position, rolle, art, objekt, wert, zaehler, nenner, einheit, menge_zustand, "
                + "abdeckung_prozent, version, fassung, kennzeichen::text AS kennzeichen FROM kennzahl_wert_eingang "
                + "WHERE wert_id = ANY (?::uuid[]) ORDER BY wert_id, position",
                (RowCallbackHandler) rs -> aus.computeIfAbsent(rs.getObject("wert_id", UUID.class), k -> new ArrayList<>())
                        .add(new Eingang(rs.getInt("position"), rs.getString("rolle"), rs.getString("art"),
                                rs.getString("objekt"), rs.getBigDecimal("wert"), rs.getBigDecimal("zaehler"),
                                rs.getBigDecimal("nenner"), rs.getString("einheit"), rs.getString("menge_zustand"),
                                rs.getBigDecimal("abdeckung_prozent"), rs.getObject("version", Integer.class),
                                rs.getObject("fassung", Integer.class),
                                KennzahlRepository.saetze(rs.getString("kennzeichen")))),
                (Object) werte.stream().map(UUID::toString).toArray(String[]::new));
        return aus;
    }

    private static Zeile zeile(ResultSet rs) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getDate("periode_von").toLocalDate(),
                rs.getDate("periode_bis").toLocalDate(), ZoneId.of(rs.getString("zeitzone")),
                rs.getObject("version", Integer.class), rs.getBigDecimal("wert"), rs.getBigDecimal("zaehler"),
                rs.getBigDecimal("nenner"), rs.getString("menge_zustand"),
                KennzahlRepository.saetze(rs.getString("kennzeichen")), rs.getBigDecimal("abdeckung_prozent"),
                rs.getString("richtung"), rs.getString("grund"), rs.getString("zustand"), zeit(rs, "endgueltig_ab"),
                rs.getInt("definition_fassung"), zeit(rs, "berechnet_am"), rs.getString("anlass_art"),
                rs.getString("anlass_kennung"));
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
