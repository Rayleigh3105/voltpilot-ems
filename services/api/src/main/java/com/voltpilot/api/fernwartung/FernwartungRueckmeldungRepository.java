package com.voltpilot.api.fernwartung;

import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Box;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Fenster;
import com.voltpilot.api.fernwartung.FernwartungRueckmeldung.Geprueft;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Tabellen der Rückmeldung (Migration V20261010203000) an der
 * BYPASSRLS-Rolle {@code voltpilot_admin}. Bewusst ein EIGENES Repository
 * neben {@link FernwartungRepository}: Was der Tunnel-Dienst meldet, ist
 * Anzeige, und der Soll-Stand liest hier nichts.
 *
 * <p>Eine Meldung wird in EINER Transaktion gespeichert, ohne die
 * Advisory-Sperre der Fernwartungs-Schreibvorgänge: Sie vergibt keine Adresse
 * und öffnet kein Fenster, und eine Meldung alle 30 Sekunden soll die Arbeit
 * im Portal nicht anhalten.
 */
@Repository
public class FernwartungRueckmeldungRepository {

    /** Die letzte Meldung eines Dienstkontos. */
    public record DienstStand(String dienst, Instant angenommenAm, Instant gemeldetUm, Instant gestartetUm,
            boolean schluesselausgabe, int boxen, int fenster) {
    }

    /** Was der Dienst zuletzt zu einer Box gemeldet hat; {@code verbundenSeit} null = nicht verbunden. */
    public record BoxStand(UUID boxId, Instant angenommenAm, Instant verbundenSeit, Instant zuletztGefragtUm) {
    }

    /** Was der Dienst zuletzt zu einem Fenster gemeldet hat. */
    public record FensterStand(UUID fensterId, Instant angenommenAm, Instant schluesselAbgeholtUm) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public FernwartungRueckmeldungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            @Qualifier("adminDataSource") DataSource adminDataSource) {
        this.jdbc = adminJdbcTemplate;
        this.tx = new TransactionTemplate(new DataSourceTransactionManager(adminDataSource));
    }

    /** Welche dieser Kennungen gehören zu einer Box der Fernwartung (aktiv oder gesperrt)? */
    public Set<UUID> bekannteBoxen(Collection<UUID> ids) {
        return bekannte("SELECT id FROM fernwartung_zugang WHERE art = 'box' AND id = ANY (?)", ids);
    }

    /** Welche dieser Kennungen gehören zu einem Fenster? */
    public Set<UUID> bekannteFenster(Collection<UUID> ids) {
        return bekannte("SELECT id FROM fernwartung_fenster WHERE id = ANY (?)", ids);
    }

    private Set<UUID> bekannte(String sql, Collection<UUID> ids) {
        if (ids.isEmpty()) {
            return Set.of();
        }
        return new HashSet<>(jdbc.query(con -> mitKennungen(con.prepareStatement(sql), ids),
                (rs, n) -> rs.getObject(1, UUID.class)));
    }

    /**
     * Speichert eine geprüfte Meldung: der letzte Stand je Dienstkonto, Box und
     * Fenster, alle mit derselben Annahmezeit. Scheitert ein Teil, bleibt der
     * vorige Stand ganz stehen.
     */
    public void speichern(String dienst, Instant angenommenAm, Geprueft m) {
        Timestamp am = Timestamp.from(angenommenAm);
        tx.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO fernwartung_rueckmeldung_dienst (dienst, angenommen_am, gemeldet_um, "
                            + "gestartet_um, schluesselausgabe, boxen, fenster) VALUES (?, ?, ?, ?, ?, ?, ?) "
                            + "ON CONFLICT (dienst) DO UPDATE SET angenommen_am = excluded.angenommen_am, "
                            + "gemeldet_um = excluded.gemeldet_um, gestartet_um = excluded.gestartet_um, "
                            + "schluesselausgabe = excluded.schluesselausgabe, boxen = excluded.boxen, "
                            + "fenster = excluded.fenster",
                    dienst, am, Timestamp.from(m.gemeldetUm()), Timestamp.from(m.gestartetUm()),
                    m.schluesselausgabe(), m.boxen().size(), m.fenster().size());
            jdbc.batchUpdate("INSERT INTO fernwartung_rueckmeldung_box (box_id, dienst, angenommen_am, "
                            + "verbunden_seit, zuletzt_gefragt_um) VALUES (?, ?, ?, ?, ?) "
                            + "ON CONFLICT (box_id) DO UPDATE SET dienst = excluded.dienst, "
                            + "angenommen_am = excluded.angenommen_am, verbunden_seit = excluded.verbunden_seit, "
                            + "zuletzt_gefragt_um = excluded.zuletzt_gefragt_um",
                    m.boxen(), 500, (PreparedStatement ps, Box b) -> {
                        ps.setObject(1, b.id());
                        ps.setString(2, dienst);
                        ps.setTimestamp(3, am);
                        ps.setTimestamp(4, zeit(b.verbundenSeit()));
                        ps.setTimestamp(5, zeit(b.zuletztGefragtUm()));
                    });
            jdbc.batchUpdate("INSERT INTO fernwartung_rueckmeldung_fenster (fenster_id, dienst, angenommen_am, "
                            + "schluessel_abgeholt_um) VALUES (?, ?, ?, ?) "
                            + "ON CONFLICT (fenster_id) DO UPDATE SET dienst = excluded.dienst, "
                            + "angenommen_am = excluded.angenommen_am, "
                            + "schluessel_abgeholt_um = excluded.schluessel_abgeholt_um",
                    m.fenster(), 500, (PreparedStatement ps, Fenster f) -> {
                        ps.setObject(1, f.id());
                        ps.setString(2, dienst);
                        ps.setTimestamp(3, am);
                        ps.setTimestamp(4, zeit(f.schluesselAbgeholtUm()));
                    });
        });
    }

    /** Die letzte Meldung je Dienstkonto, neueste zuerst. */
    public List<DienstStand> dienste() {
        return jdbc.query("SELECT dienst, angenommen_am, gemeldet_um, gestartet_um, schluesselausgabe, boxen, "
                        + "fenster FROM fernwartung_rueckmeldung_dienst ORDER BY angenommen_am DESC, dienst",
                (rs, n) -> new DienstStand(rs.getString("dienst"), instant(rs, "angenommen_am"),
                        instant(rs, "gemeldet_um"), instant(rs, "gestartet_um"),
                        rs.getBoolean("schluesselausgabe"), rs.getInt("boxen"), rs.getInt("fenster")));
    }

    /** Der letzte gemeldete Stand je Box, nach Kennung der Box. */
    public Map<UUID, BoxStand> boxen() {
        Map<UUID, BoxStand> m = new HashMap<>();
        jdbc.query("SELECT box_id, angenommen_am, verbunden_seit, zuletzt_gefragt_um "
                + "FROM fernwartung_rueckmeldung_box", rs -> {
            UUID id = rs.getObject("box_id", UUID.class);
            m.put(id, new BoxStand(id, instant(rs, "angenommen_am"), instant(rs, "verbunden_seit"),
                    instant(rs, "zuletzt_gefragt_um")));
        });
        return m;
    }

    /** Der letzte gemeldete Stand zu diesen Fenstern, nach Kennung des Fensters. */
    public Map<UUID, FensterStand> fenster(Collection<UUID> ids) {
        Map<UUID, FensterStand> m = new HashMap<>();
        if (ids.isEmpty()) {
            return m;
        }
        jdbc.query(con -> mitKennungen(con.prepareStatement("SELECT fenster_id, angenommen_am, "
                + "schluessel_abgeholt_um FROM fernwartung_rueckmeldung_fenster WHERE fenster_id = ANY (?)"), ids),
                rs -> {
                    UUID id = rs.getObject("fenster_id", UUID.class);
                    m.put(id, new FensterStand(id, instant(rs, "angenommen_am"),
                            instant(rs, "schluessel_abgeholt_um")));
                });
        return m;
    }

    private static PreparedStatement mitKennungen(PreparedStatement ps, Collection<UUID> ids) throws SQLException {
        Array feld = ps.getConnection().createArrayOf("uuid", ids.toArray());
        ps.setArray(1, feld);
        return ps;
    }

    private static Timestamp zeit(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
