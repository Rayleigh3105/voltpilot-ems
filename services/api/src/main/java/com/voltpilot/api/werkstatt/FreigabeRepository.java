package com.voltpilot.api.werkstatt;

import com.fasterxml.jackson.annotation.JsonInclude;
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
            + "beendet_am, beendet_von, beendet_von_name, quelle, edge_release_seq, edge_wartung_sha256 ";

    /** Eine Zeile von Hand (bis 16.11.2026, „Werkstatt freigeben“). */
    public static final String VON_HAND = "formular";
    /** Eine Zeile, die die Regel „neueste Fassung“ selbst angelegt hat ({@link WerkstattRegel}). */
    public static final String REGEL = "regel";

    /** Das OpenWrt-Abbild einer Freigabe. */
    public record Abbild(String fassung, String datei, String sha256, String quelle) {
    }

    /**
     * Die Fassung der Box-Software einer Freigabe: Programm (Bauart der Box) und
     * Skriptstand - Edge Light für die Mango, Edge Industrie für den PFC200.
     * {@code wartungSha256}: das Tunnel-Programm {@code vp-wartung}, nur beim
     * PFC200 (die Mango richtet ihren Tunnel mit Skripten ein; dort {@code null}
     * und nicht in der Antwort).
     */
    public record Programm(String fassung, String quelle, String programmSha256, String skripteSha256,
            @JsonInclude(JsonInclude.Include.NON_NULL) String wartungSha256) {

        /** Eine Edge-Light-Fassung (ohne Tunnel-Programm). */
        public Programm(String fassung, String quelle, String programmSha256, String skripteSha256) {
            this(fassung, quelle, programmSha256, skripteSha256, null);
        }
    }

    /**
     * Eine Zeile. {@code boxArt}: das Gerät ({@code mango} oder {@code pfc200});
     * {@code openwrt} ist beim PFC200 {@code null} (kein Abbild: die Firmware
     * des Geräts fasst die Werkstatt nicht an), {@code edgeLight} trägt dann die
     * Edge-Industrie-Fassung. {@code quelle}: {@link #VON_HAND} oder {@link #REGEL};
     * {@code edgeReleaseSeq} das Release im Register, aus dessen signiertem
     * Manifest die Regel Edge Light genommen hat (von Hand: {@code null}).
     */
    public record Freigabe(UUID id, String kennung, String boxArt, Instant gueltigAb, Instant gueltigBis,
            int obergrenze, Abbild openwrt, Programm edgeLight, String notiz, Instant erteiltAm, String erteiltVon,
            String erteiltVonName, Instant beendetAm, String beendetVon, String beendetVonName, String quelle,
            Long edgeReleaseSeq) {

        public boolean vonDerRegel() {
            return REGEL.equals(quelle);
        }

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

    public Optional<Freigabe> mitId(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe WHERE id = ?",
                FreigabeRepository::freigabe, id).stream().findFirst();
    }

    /** Die Freigaben einer Box-Art, die zu {@code jetzt} laufen (höchstens eine, das hält der Dienst). */
    public List<Freigabe> laufend(String boxArt, Instant jetzt) {
        Timestamp t = Timestamp.from(jetzt);
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe WHERE box_art = ? AND beendet_am IS NULL "
                        + "AND gueltig_ab <= ? AND gueltig_bis > ? ORDER BY gueltig_ab DESC",
                FreigabeRepository::freigabe, boxArt, t, t);
    }

    /** Die Zeilen der Regel einer Box-Art, angelegt ab {@code seit}, nicht beendet; neueste zuerst. */
    public List<Freigabe> regelSeit(String boxArt, Instant seit) {
        return jdbc.query("SELECT " + SPALTEN + "FROM werkstatt_freigabe WHERE box_art = ? AND quelle = '"
                        + REGEL + "' AND beendet_am IS NULL AND gueltig_ab >= ? ORDER BY gueltig_ab DESC",
                FreigabeRepository::freigabe, boxArt, Timestamp.from(seit));
    }

    /** Die Kennungen eines Präfixes (für die nächste freie Nummer). */
    public List<String> kennungenMit(String praefix) {
        return jdbc.queryForList("SELECT kennung FROM werkstatt_freigabe WHERE kennung LIKE ?", String.class,
                praefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
    }

    /**
     * Eine Zeile der Regel anlegen ({@link #REGEL}); erteilt am {@code gueltigAb}.
     * {@code o} ist beim PFC200 {@code null}.
     */
    public UUID anlegen(String kennung, String boxArt, Instant gueltigAb, Instant gueltigBis, int obergrenze,
            Abbild o, Programm e, long edgeReleaseSeq, String notiz, String akteur, String akteurName) {
        return jdbc.queryForObject("INSERT INTO werkstatt_freigabe (kennung, box_art, gueltig_ab, gueltig_bis, "
                        + "obergrenze, openwrt_fassung, openwrt_datei, openwrt_sha256, openwrt_quelle, edge_fassung, "
                        + "edge_quelle, edge_programm_sha256, edge_skripte_sha256, notiz, erteilt_am, erteilt_von, "
                        + "erteilt_von_name, quelle, edge_release_seq, edge_wartung_sha256) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '" + REGEL + "', ?, ?) RETURNING id",
                UUID.class, kennung, boxArt, Timestamp.from(gueltigAb), Timestamp.from(gueltigBis), obergrenze,
                o == null ? null : o.fassung(), o == null ? null : o.datei(), o == null ? null : o.sha256(),
                o == null ? null : o.quelle(), e.fassung(), e.quelle(), e.programmSha256(),
                e.skripteSha256(), notiz, Timestamp.from(gueltigAb), akteur, akteurName, edgeReleaseSeq,
                e.wartungSha256());
    }

    // ── Anhalten und Fortsetzen (werkstatt_betrieb, nur anhängen) ─────────

    /** Ein Eintrag im Protokoll: angehalten oder fortgesetzt, von wem, wann, warum. */
    public record Betrieb(UUID id, String boxArt, boolean angehalten, String grund, Instant am, String von,
            String vonName) {
    }

    /** Die letzten {@code anzahl} Einträge einer Box-Art, neueste zuerst. */
    public List<Betrieb> betrieb(String boxArt, int anzahl) {
        return jdbc.query("SELECT id, box_art, angehalten, grund, am, von, von_name FROM werkstatt_betrieb "
                        + "WHERE box_art = ? ORDER BY am DESC, id LIMIT ?",
                (rs, n) -> new Betrieb(rs.getObject("id", UUID.class), rs.getString("box_art"),
                        rs.getBoolean("angehalten"), rs.getString("grund"), instant(rs, "am"), rs.getString("von"),
                        rs.getString("von_name")),
                boxArt, anzahl);
    }

    public void betriebEintragen(String boxArt, boolean angehalten, String grund, Instant am, String von,
            String vonName) {
        jdbc.update("INSERT INTO werkstatt_betrieb (box_art, angehalten, grund, am, von, von_name) "
                + "VALUES (?, ?, ?, ?, ?, ?)", boxArt, angehalten, grund, Timestamp.from(am), von, vonName);
    }

    private static Freigabe freigabe(ResultSet rs, int n) throws SQLException {
        return new Freigabe(
                rs.getObject("id", UUID.class),
                rs.getString("kennung"),
                rs.getString("box_art"),
                instant(rs, "gueltig_ab"),
                instant(rs, "gueltig_bis"),
                rs.getInt("obergrenze"),
                rs.getString("openwrt_fassung") == null ? null
                        : new Abbild(rs.getString("openwrt_fassung"), rs.getString("openwrt_datei"),
                                rs.getString("openwrt_sha256"), rs.getString("openwrt_quelle")),
                new Programm(rs.getString("edge_fassung"), rs.getString("edge_quelle"),
                        rs.getString("edge_programm_sha256"), rs.getString("edge_skripte_sha256"),
                        rs.getString("edge_wartung_sha256")),
                rs.getString("notiz"),
                instant(rs, "erteilt_am"),
                rs.getString("erteilt_von"),
                rs.getString("erteilt_von_name"),
                instant(rs, "beendet_am"),
                rs.getString("beendet_von"),
                rs.getString("beendet_von_name"),
                rs.getString("quelle"),
                rs.getObject("edge_release_seq", Long.class));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
