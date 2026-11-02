package com.voltpilot.api.werkstatt;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Freigaben der Werkstatt (Migration V20261102120000) an der BYPASSRLS-Rolle
 * {@code voltpilot_admin}, dasselbe Muster wie {@link WerkstattRepository} und
 * unter DERSELBEN Advisory-Sperre: Freigabe und Register schreiben nie
 * gleichzeitig.
 */
@Repository
public class FreigabeRepository {

    private static final String SPALTEN = "id, kennung, box_art, gueltig_ab, gueltig_bis, obergrenze, "
            + "openwrt_fassung, openwrt_datei, openwrt_sha256, openwrt_quelle, edge_fassung, edge_quelle, "
            + "edge_programm_sha256, edge_skripte_sha256, notiz, erteilt_am, erteilt_von, erteilt_von_name, "
            + "beendet_am, beendet_von, beendet_von_name ";

    /** Das OpenWrt-Abbild einer Freigabe. */
    public record Abbild(String fassung, String datei, String sha256, String quelle) {
    }

    /** Die Edge-Light-Fassung einer Freigabe: Programm (Bauart der Box) und Skriptstand. */
    public record Programm(String fassung, String quelle, String programmSha256, String skripteSha256) {
    }

    /** Eine Zeile. */
    public record Freigabe(UUID id, String kennung, String boxArt, Instant gueltigAb, Instant gueltigBis,
            int obergrenze, Abbild openwrt, Programm edgeLight, String notiz, Instant erteiltAm, String erteiltVon,
            String erteiltVonName, Instant beendetAm, String beendetVon, String beendetVonName) {

        /** Läuft jetzt: begonnen, nicht abgelaufen, nicht beendet. */
        public boolean laufend(Instant jetzt) {
            return beendetAm == null && !jetzt.isBefore(gueltigAb) && jetzt.isBefore(gueltigBis);
        }
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public FreigabeRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            @Qualifier("adminDataSource") DataSource adminDataSource) {
        this.jdbc = adminJdbcTemplate;
        this.tx = new TransactionTemplate(new DataSourceTransactionManager(adminDataSource));
    }

    /** Führt {@code arbeit} in EINER Transaktion nach der Sperre der Werkstatt aus. */
    public <T> T schreibend(Supplier<T> arbeit) {
        return tx.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(?)", rs -> null, WerkstattRepository.SPERRE);
            return arbeit.get();
        });
    }

    /** Alle Freigaben, neueste zuerst. */
    public List<Freigabe> alle() {
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe ORDER BY gueltig_ab DESC, kennung",
                FreigabeRepository::freigabe);
    }

    public Optional<Freigabe> mitKennung(String kennung) {
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe WHERE kennung = ?",
                FreigabeRepository::freigabe, kennung).stream().findFirst();
    }

    /** Die Freigaben einer Box-Art, die zu {@code jetzt} laufen (höchstens eine, das hält der Dienst). */
    public List<Freigabe> laufend(String boxArt, Instant jetzt) {
        Timestamp t = Timestamp.from(jetzt);
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe WHERE box_art = ? AND beendet_am IS NULL "
                        + "AND gueltig_ab <= ? AND gueltig_bis > ? ORDER BY gueltig_ab DESC",
                FreigabeRepository::freigabe, boxArt, t, t);
    }

    /** Die Kennungen eines Präfixes (für die nächste freie Nummer). */
    public List<String> kennungenMit(String praefix) {
        return jdbc.queryForList("SELECT kennung FROM werkstatt_freigabe WHERE kennung LIKE ?", String.class,
                praefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
    }

    public UUID anlegen(String kennung, String boxArt, Instant gueltigAb, Instant gueltigBis, int obergrenze,
            Abbild o, Programm e, String notiz, String akteur, String akteurName) {
        return jdbc.queryForObject("INSERT INTO werkstatt_freigabe (kennung, box_art, gueltig_ab, gueltig_bis, "
                        + "obergrenze, openwrt_fassung, openwrt_datei, openwrt_sha256, openwrt_quelle, edge_fassung, "
                        + "edge_quelle, edge_programm_sha256, edge_skripte_sha256, notiz, erteilt_von, erteilt_von_name) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, kennung, boxArt, Timestamp.from(gueltigAb), Timestamp.from(gueltigBis), obergrenze,
                o.fassung(), o.datei(), o.sha256(), o.quelle(), e.fassung(), e.quelle(), e.programmSha256(),
                e.skripteSha256(), notiz, akteur, akteurName);
    }

    /** Setzt das Ende; false, wenn es schon gesetzt war. */
    public boolean beenden(UUID id, String akteur, String akteurName) {
        return jdbc.update("UPDATE werkstatt_freigabe SET beendet_am = now(), beendet_von = ?, beendet_von_name = ? "
                + "WHERE id = ? AND beendet_am IS NULL", akteur, akteurName, id) == 1;
    }

    private static Freigabe freigabe(ResultSet rs, int n) throws SQLException {
        return new Freigabe(
                rs.getObject("id", UUID.class),
                rs.getString("kennung"),
                rs.getString("box_art"),
                instant(rs, "gueltig_ab"),
                instant(rs, "gueltig_bis"),
                rs.getInt("obergrenze"),
                new Abbild(rs.getString("openwrt_fassung"), rs.getString("openwrt_datei"),
                        rs.getString("openwrt_sha256"), rs.getString("openwrt_quelle")),
                new Programm(rs.getString("edge_fassung"), rs.getString("edge_quelle"),
                        rs.getString("edge_programm_sha256"), rs.getString("edge_skripte_sha256")),
                rs.getString("notiz"),
                instant(rs, "erteilt_am"),
                rs.getString("erteilt_von"),
                rs.getString("erteilt_von_name"),
                instant(rs, "beendet_am"),
                rs.getString("beendet_von"),
                rs.getString("beendet_von_name"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
