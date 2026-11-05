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
    static final long SPERRE = 0x76705f7773L; // "vp_ws"

    private static final String BOX_SPALTEN = "b.id, b.edge_ref, b.box_art, b.lan_netz, b.schritte::text AS schritte, "
            + "b.notiz, b.angelegt_am, b.angelegt_von, b.angelegt_von_name, b.geaendert_am ";

    private static final String ABNAHME_SPALTEN = "a.id, a.box_id, a.edge_ref, a.host_schluessel, a.fassung, "
            + "host(a.tunnel_adresse) AS tunnel_adresse, a.lan_netz, a.pruefungen::text AS pruefungen, "
            + "a.probe::text AS probe, a.notiz, a.erfasst_am, a.erfasst_von, a.erfasst_von_name, a.quelle, "
            + "a.belege::text AS belege, a.freigabe_id, a.einloesung_id, a.passwort_age ";

    /** Eine Zeile des Registers; {@code schritteJson} ist das JSON-Objekt als Text. */
    public record Box(UUID id, String edgeRef, String boxArt, String lanNetz, String schritteJson, String notiz,
            Instant angelegtAm, String angelegtVon, String angelegtVonName, Instant geaendertAm) {
    }

    /**
     * Ein Abnahmeprotokoll; {@code pruefungenJson}, {@code probeJson} und
     * {@code belegeJson} als Text. {@code quelle}: {@code hand} (Haken im
     * Portal) oder {@code dienst} (Belege, Freigabe, Einlösung und das
     * verschlüsselte Passwort des Werkstatt-Dienstes, sonst null).
     */
    public record Abnahme(UUID id, UUID boxId, String edgeRef, String hostSchluessel, String fassung,
            String tunnelAdresse, String lanNetz, String pruefungenJson, String probeJson, String notiz,
            Instant erfasstAm, String erfasstVon, String erfasstVonName, String quelle, String belegeJson,
            UUID freigabeId, UUID einloesungId, String passwortAge) {
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

    /**
     * Wo die Referenz schon in Gebrauch ist, in Worten (leer = nirgends). Die
     * Reihenfolge ist die der Nachricht: was der Werkstatt am nächsten liegt
     * zuerst. Ein Lauf zählt, sobald er die Box kennt ({@code stand.box},
     * Vertrag werkstatt-ansicht-v1).
     */
    public List<String> inGebrauch(UUID boxId, String edgeRef) {
        return jdbc.query("SELECT grund FROM ("
                        + "SELECT 1 AS n, 'sie ist abgenommen' AS grund "
                        + "WHERE EXISTS (SELECT 1 FROM werkstatt_abnahme WHERE box_id = ?) "
                        + "UNION ALL SELECT 2, 'der Werkstatt-Dienst hatte einen Lauf mit ihr' "
                        + "WHERE EXISTS (SELECT 1 FROM werkstatt_lauf WHERE stand->>'box' = ?) "
                        + "UNION ALL SELECT 3, 'der Werkstatt-Dienst hat ihr einen Code ausgegeben' "
                        + "WHERE EXISTS (SELECT 1 FROM werkstatt_code WHERE edge_ref = ?) "
                        + "UNION ALL SELECT 4, 'sie hat sich in der Werkstatt angemeldet' "
                        + "WHERE EXISTS (SELECT 1 FROM werkstatt_einloesung WHERE edge_ref = ?) "
                        + "OR EXISTS (SELECT 1 FROM werkstatt_geraeteschluessel WHERE edge_ref = ?) "
                        + "UNION ALL SELECT 5, 'für sie ist ein Tunnel-Schlüssel hinterlegt' "
                        + "WHERE EXISTS (SELECT 1 FROM fernwartung_zugang WHERE art = 'box' AND edge_ref = ?) "
                        + "UNION ALL SELECT 6, 'sie hat eine Zertifikatsanfrage geschickt (Kopplung)' "
                        + "WHERE EXISTS (SELECT 1 FROM device_enrollment WHERE external_ref = ?) "
                        + "UNION ALL SELECT 7, 'ein Gerät oder eine Anlage nutzt die Referenz' "
                        + "WHERE EXISTS (SELECT 1 FROM device WHERE external_ref = ?) "
                        + "OR EXISTS (SELECT 1 FROM provisioned_device WHERE external_ref = ?)"
                        + ") g ORDER BY n",
                (rs, n) -> rs.getString("grund"),
                boxId, edgeRef, edgeRef, edgeRef, edgeRef, edgeRef, edgeRef, edgeRef, edgeRef);
    }

    /** Die Zeile mit wer/wann in {@code werkstatt_box_entfernt} festhalten, dann löschen. */
    public void boxEntfernen(UUID id, String akteur, String akteurName) {
        jdbc.update("INSERT INTO werkstatt_box_entfernt (box_id, edge_ref, box_art, lan_netz, schritte, notiz, "
                        + "angelegt_am, angelegt_von, angelegt_von_name, entfernt_von, entfernt_von_name) "
                        + "SELECT id, edge_ref, box_art, lan_netz, schritte, notiz, angelegt_am, angelegt_von, "
                        + "angelegt_von_name, ?, ? FROM werkstatt_box WHERE id = ?",
                akteur, akteurName, id);
        jdbc.update("DELETE FROM werkstatt_box WHERE id = ?", id);
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

    /** Die Abnahme des Werkstatt-Dienstes: dazu Belege, Freigabe, Einlösung und das verschlüsselte Passwort. */
    public UUID abnahmeDesDienstesAnlegen(UUID boxId, String edgeRef, String hostSchluessel, String fassung,
            String tunnelAdresse, String lanNetz, String pruefungenJson, String probeJson, String belegeJson,
            UUID freigabeId, UUID einloesungId, String passwortAge, String notiz, String akteur, String akteurName) {
        UUID id = jdbc.queryForObject("INSERT INTO werkstatt_abnahme (box_id, edge_ref, host_schluessel, fassung, "
                        + "tunnel_adresse, lan_netz, pruefungen, probe, notiz, erfasst_von, erfasst_von_name, quelle, "
                        + "belege, freigabe_id, einloesung_id, passwort_age) "
                        + "VALUES (?, ?, ?, ?, ?::inet, ?, ?::jsonb, ?::jsonb, ?, ?, ?, 'dienst', ?::jsonb, ?, ?, ?) "
                        + "RETURNING id",
                UUID.class, boxId, edgeRef, hostSchluessel, fassung, tunnelAdresse + "/32", lanNetz, pruefungenJson,
                probeJson, notiz, akteur, akteurName, belegeJson, freigabeId, einloesungId, passwortAge);
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
                rs.getString("erfasst_von_name"),
                rs.getString("quelle"),
                rs.getString("belege"),
                rs.getObject("freigabe_id", UUID.class),
                rs.getObject("einloesung_id", UUID.class),
                rs.getString("passwort_age"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
