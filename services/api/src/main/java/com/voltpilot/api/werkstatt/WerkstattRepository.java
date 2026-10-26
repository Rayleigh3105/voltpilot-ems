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
 * Die Tabellen der Werkstatt (Migration V20261026200000) an der
 * BYPASSRLS-Rolle {@code voltpilot_admin}, dasselbe Muster wie
 * {@code FernwartungRepository}: erreichbar nur aus platform-admin-Routen,
 * Transaktionen über einen eigenen Transaktionsmanager auf genau der
 * Admin-DataSource, jede schreibende Transaktion nach einer Advisory-Sperre.
 *
 * <p>JSON-Spalten gehen als Text hinein und heraus; Form und Inhalt prüft der
 * {@link WerkstattService}.
 */
@Repository
public class WerkstattRepository {

    /** Fester Schlüssel der Advisory-Sperre aller Werkstatt-Schreibvorgänge. */
    private static final long SPERRE = 0x76705f7773L; // "vp_ws"

    private static final String BOX_SPALTEN = "b.id, b.edge_ref, b.box_art, b.lan_netz, b.schritte::text AS schritte, "
            + "b.notiz, b.angelegt_am, b.angelegt_von, b.angelegt_von_name, b.geaendert_am ";

    private static final String ABNAHME_SPALTEN = "a.id, a.box_id, a.edge_ref, a.host_schluessel, a.fassung, "
            + "host(a.tunnel_adresse) AS tunnel_adresse, a.lan_netz, a.pruefungen::text AS pruefungen, "
            + "a.probe::text AS probe, a.notiz, a.erfasst_am, a.erfasst_von, a.erfasst_von_name ";

    /** Eine Zeile des Registers; {@code schritteJson} ist das JSON-Objekt als Text. */
    public record Box(UUID id, String edgeRef, String boxArt, String lanNetz, String schritteJson, String notiz,
            Instant angelegtAm, String angelegtVon, String angelegtVonName, Instant geaendertAm) {
    }

    /** Ein Abnahmeprotokoll; {@code pruefungenJson} und {@code probeJson} als Text. */
    public record Abnahme(UUID id, UUID boxId, String edgeRef, String hostSchluessel, String fassung,
            String tunnelAdresse, String lanNetz, String pruefungenJson, String probeJson, String notiz,
            Instant erfasstAm, String erfasstVon, String erfasstVonName) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public WerkstattRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
            @Qualifier("adminDataSource") DataSource adminDataSource) {
        this.jdbc = adminJdbcTemplate;
        this.tx = new TransactionTemplate(new DataSourceTransactionManager(adminDataSource));
    }

    /** Führt {@code arbeit} in EINER Transaktion auf der Admin-Verbindung aus, nach der Advisory-Sperre. */
    public <T> T schreibend(Supplier<T> arbeit) {
        return tx.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(?)", rs -> null, SPERRE);
            return arbeit.get();
        });
    }

    // ── Register ──────────────────────────────────────────────────────────

    /** Das ganze Register, zuletzt geänderte zuerst. */
    public List<Box> boxen() {
        return jdbc.query("SELECT " + BOX_SPALTEN + "FROM werkstatt_box b ORDER BY b.geaendert_am DESC, b.edge_ref",
                WerkstattRepository::box);
    }

    public Optional<Box> box(String edgeRef) {
        return jdbc.query("SELECT " + BOX_SPALTEN + "FROM werkstatt_box b WHERE b.edge_ref = ?",
                WerkstattRepository::box, edgeRef).stream().findFirst();
    }

    public UUID boxAnlegen(String edgeRef, String boxArt, String schritteJson, String notiz, String akteur,
            String akteurName) {
        return jdbc.queryForObject("INSERT INTO werkstatt_box (edge_ref, box_art, schritte, notiz, angelegt_von, "
                        + "angelegt_von_name, geaendert_von) VALUES (?, ?, ?::jsonb, ?, ?, ?, ?) RETURNING id",
                UUID.class, edgeRef, boxArt, schritteJson, notiz, akteur, akteurName, akteur);
    }

    /** Hakt einen Schritt ab: {@code {"am": now(), "von": name}} unter seiner Kennung. */
    public void schrittSetzen(UUID id, String schritt, String von, String akteur) {
        jdbc.update("UPDATE werkstatt_box SET schritte = schritte || jsonb_build_object(?::text, "
                        + "jsonb_build_object('am', to_char(now() AT TIME ZONE 'UTC', "
                        + "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'von', ?::text)), "
                        + "geaendert_am = now(), geaendert_von = ? WHERE id = ?",
                schritt, von, akteur, id);
    }

    public void schrittEntfernen(UUID id, String schritt, String akteur) {
        jdbc.update("UPDATE werkstatt_box SET schritte = schritte - ?::text, geaendert_am = now(), "
                + "geaendert_von = ? WHERE id = ?", schritt, akteur, id);
    }

    public void lanNetzSetzen(UUID id, String lanNetz, String akteur) {
        jdbc.update("UPDATE werkstatt_box SET lan_netz = ?, geaendert_am = now(), geaendert_von = ? WHERE id = ?",
                lanNetz, akteur, id);
    }

    // ── Abnahme ───────────────────────────────────────────────────────────

    public UUID abnahmeAnlegen(UUID boxId, String edgeRef, String hostSchluessel, String fassung,
            String tunnelAdresse, String lanNetz, String pruefungenJson, String probeJson, String notiz,
            String akteur, String akteurName) {
        UUID id = jdbc.queryForObject("INSERT INTO werkstatt_abnahme (box_id, edge_ref, host_schluessel, fassung, "
                        + "tunnel_adresse, lan_netz, pruefungen, probe, notiz, erfasst_von, erfasst_von_name) "
                        + "VALUES (?, ?, ?, ?, ?::inet, ?, ?::jsonb, ?::jsonb, ?, ?, ?) RETURNING id",
                UUID.class, boxId, edgeRef, hostSchluessel, fassung, tunnelAdresse + "/32", lanNetz, pruefungenJson,
                probeJson, notiz, akteur, akteurName);
        jdbc.update("UPDATE werkstatt_box SET geaendert_am = now(), geaendert_von = ? WHERE id = ?", akteur, boxId);
        return id;
    }

    /** Alle Abnahmen, neueste zuerst; {@code boxId} null = aller Boxen. */
    public List<Abnahme> abnahmen(UUID boxId) {
        return jdbc.query("SELECT " + ABNAHME_SPALTEN + "FROM werkstatt_abnahme a "
                        + "WHERE (?::uuid IS NULL OR a.box_id = ?::uuid) ORDER BY a.erfasst_am DESC, a.id",
                WerkstattRepository::abnahme, boxId, boxId);
    }

    public Optional<Abnahme> abnahme(UUID id) {
        return jdbc.query("SELECT " + ABNAHME_SPALTEN + "FROM werkstatt_abnahme a WHERE a.id = ?",
                WerkstattRepository::abnahme, id).stream().findFirst();
    }

    // ── Abbildung ─────────────────────────────────────────────────────────

    private static Box box(ResultSet rs, int n) throws SQLException {
        return new Box(
                rs.getObject("id", UUID.class),
                rs.getString("edge_ref"),
                rs.getString("box_art"),
                rs.getString("lan_netz"),
                rs.getString("schritte"),
                rs.getString("notiz"),
                instant(rs, "angelegt_am"),
                rs.getString("angelegt_von"),
                rs.getString("angelegt_von_name"),
                instant(rs, "geaendert_am"));
    }

    private static Abnahme abnahme(ResultSet rs, int n) throws SQLException {
        return new Abnahme(
                rs.getObject("id", UUID.class),
                rs.getObject("box_id", UUID.class),
                rs.getString("edge_ref"),
                rs.getString("host_schluessel"),
                rs.getString("fassung"),
                rs.getString("tunnel_adresse"),
                rs.getString("lan_netz"),
                rs.getString("pruefungen"),
                rs.getString("probe"),
                rs.getString("notiz"),
                instant(rs, "erfasst_am"),
                rs.getString("erfasst_von"),
                rs.getString("erfasst_von_name"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
