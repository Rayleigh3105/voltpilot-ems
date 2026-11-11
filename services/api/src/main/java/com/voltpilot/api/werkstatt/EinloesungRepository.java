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
 * Einmal-Codes, Einlösungen und festgehaltene Geräteschlüssel (Migration
 * V20261102150000) an der BYPASSRLS-Rolle {@code voltpilot_admin}, unter
 * derselben Advisory-Sperre wie Register und Freigabe.
 */
@Repository
public class EinloesungRepository {

    /** Ein Code; der Klartext steht nirgends. */
    public record Code(UUID id, UUID freigabeId, String edgeRef, boolean tausch, Instant ausgegebenAm,
            Instant gueltigBis, String ausgegebenVon, Instant ersetztAm, Instant eingeloestAm) {

        public boolean offen(Instant jetzt) {
            return ersetztAm == null && eingeloestAm == null && jetzt.isBefore(gueltigBis);
        }
    }

    /** Eine Einlösung, wie sie war. */
    public record Einloesung(UUID id, UUID codeId, UUID freigabeId, String edgeRef, String fassung,
            String geraeteSchluessel, String geraeteSchluesselSha256, String wireguardSchluessel,
            String hostSchluessel, String tunnelAdresse, UUID fensterId, boolean tausch, Instant eingeloestAm) {
    }

    /** Der festgehaltene Geräteschlüssel einer Referenz (D2). */
    public record Festgehalten(String edgeRef, String geraeteSchluessel, String geraeteSchluesselSha256,
            UUID einloesungId, Instant festgehaltenAm) {
    }

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;

    public EinloesungRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate,
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

    // ── Codes ─────────────────────────────────────────────────────────────

    private static final String CODE_SPALTEN = "id, freigabe_id, edge_ref, tausch, ausgegeben_am, gueltig_bis, "
            + "ausgegeben_von, ersetzt_am, eingeloest_am ";

    /** Ersetzt die offenen Codes einer Referenz; gibt zurück, wie viele es waren. */
    public int offeneErsetzen(String edgeRef) {
        return jdbc.update("UPDATE werkstatt_code SET ersetzt_am = now() WHERE edge_ref = ? AND ersetzt_am IS NULL "
                + "AND eingeloest_am IS NULL", edgeRef);
    }

    /** Beginn und Ende kommen von DERSELBEN Uhr (der des Dienstes), sonst kippt der CHECK an einer Uhrabweichung. */
    public UUID codeAnlegen(UUID freigabeId, String edgeRef, String codeSha256, boolean tausch, Instant ausgegebenAm,
            Instant gueltigBis, String von) {
        return jdbc.queryForObject("INSERT INTO werkstatt_code (freigabe_id, edge_ref, code_sha256, tausch, "
                        + "ausgegeben_am, gueltig_bis, ausgegeben_von) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, freigabeId, edgeRef, codeSha256, tausch, Timestamp.from(ausgegebenAm),
                Timestamp.from(gueltigBis), von);
    }

    public Optional<Code> codeMitHash(String codeSha256) {
        return jdbc.query("SELECT " + CODE_SPALTEN + "FROM werkstatt_code WHERE code_sha256 = ?",
                EinloesungRepository::code, codeSha256).stream().findFirst();
    }

    /** Markiert den Code als eingelöst; false, wenn er zu {@code jetzt} nicht mehr offen war. */
    public boolean codeEinloesen(UUID id, Instant jetzt) {
        return jdbc.update("UPDATE werkstatt_code SET eingeloest_am = ? WHERE id = ? AND ersetzt_am IS NULL "
                + "AND eingeloest_am IS NULL AND gueltig_bis > ?", Timestamp.from(jetzt), id,
                Timestamp.from(jetzt)) == 1;
    }

    // ── Einlösungen ───────────────────────────────────────────────────────

    private static final String EINLOESUNG_SPALTEN = "id, code_id, freigabe_id, edge_ref, fassung, geraete_schluessel, "
            + "geraete_schluessel_sha256, wireguard_schluessel, host_schluessel, tunnel_adresse, fenster_id, tausch, "
            + "eingeloest_am ";

    public UUID einloesungAnlegen(UUID codeId, UUID freigabeId, String edgeRef, String fassung,
            String geraeteSchluessel, String geraeteSchluesselSha256, String wireguardSchluessel,
            String hostSchluessel, String tunnelAdresse, UUID fensterId, boolean tausch) {
        return jdbc.queryForObject("INSERT INTO werkstatt_einloesung (code_id, freigabe_id, edge_ref, fassung, "
                        + "geraete_schluessel, geraete_schluessel_sha256, wireguard_schluessel, host_schluessel, "
                        + "tunnel_adresse, fenster_id, tausch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, codeId, freigabeId, edgeRef, fassung, geraeteSchluessel, geraeteSchluesselSha256,
                wireguardSchluessel, hostSchluessel, tunnelAdresse, fensterId, tausch);
    }

    /** Die Einlösungen einer Referenz, neueste zuerst. */
    public List<Einloesung> einloesungen(String edgeRef) {
        return jdbc.query("SELECT " + EINLOESUNG_SPALTEN + "FROM werkstatt_einloesung WHERE edge_ref = ? "
                + "ORDER BY eingeloest_am DESC, id", EinloesungRepository::einloesung, edgeRef);
    }

    public Optional<Einloesung> einloesungMitFenster(UUID fensterId) {
        return jdbc.query("SELECT " + EINLOESUNG_SPALTEN + "FROM werkstatt_einloesung WHERE fenster_id = ?",
                EinloesungRepository::einloesung, fensterId).stream().findFirst();
    }

    /** Wie viele verschiedene Boxen unter einer Freigabe eingelöst haben, und ob {@code edgeRef} darunter ist. */
    public int boxenUnter(UUID freigabeId) {
        Integer n = jdbc.queryForObject("SELECT count(DISTINCT edge_ref) FROM werkstatt_einloesung "
                + "WHERE freigabe_id = ?", Integer.class, freigabeId);
        return n == null ? 0 : n;
    }

    public boolean schonUnter(UUID freigabeId, String edgeRef) {
        Boolean da = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM werkstatt_einloesung WHERE freigabe_id = ? "
                + "AND edge_ref = ?)", Boolean.class, freigabeId, edgeRef);
        return Boolean.TRUE.equals(da);
    }

    // ── Festgehaltene Geräteschlüssel (D2) ────────────────────────────────

    public Optional<Festgehalten> festgehalten(String edgeRef) {
        return jdbc.query("SELECT edge_ref, geraete_schluessel, geraete_schluessel_sha256, einloesung_id, "
                        + "festgehalten_am FROM werkstatt_geraeteschluessel WHERE edge_ref = ?",
                (rs, n) -> new Festgehalten(rs.getString("edge_ref"), rs.getString("geraete_schluessel"),
                        rs.getString("geraete_schluessel_sha256"), rs.getObject("einloesung_id", UUID.class),
                        instant(rs, "festgehalten_am")), edgeRef).stream().findFirst();
    }

    /** Hält den Schlüssel fest oder ersetzt ihn (Tausch; der Aufrufer prüft, dass er es darf). */
    public void festhalten(String edgeRef, String geraeteSchluessel, String sha256, UUID einloesungId) {
        jdbc.update("INSERT INTO werkstatt_geraeteschluessel (edge_ref, geraete_schluessel, geraete_schluessel_sha256, "
                        + "einloesung_id) VALUES (?, ?, ?, ?) ON CONFLICT (edge_ref) DO UPDATE SET "
                        + "geraete_schluessel = EXCLUDED.geraete_schluessel, "
                        + "geraete_schluessel_sha256 = EXCLUDED.geraete_schluessel_sha256, "
                        + "einloesung_id = EXCLUDED.einloesung_id, festgehalten_am = now()",
                edgeRef, geraeteSchluessel, sha256, einloesungId);
    }

    // ── intern ────────────────────────────────────────────────────────────

    private static Code code(ResultSet rs, int n) throws SQLException {
        return new Code(rs.getObject("id", UUID.class), rs.getObject("freigabe_id", UUID.class),
                rs.getString("edge_ref"), rs.getBoolean("tausch"), instant(rs, "ausgegeben_am"),
                instant(rs, "gueltig_bis"), rs.getString("ausgegeben_von"), instant(rs, "ersetzt_am"),
                instant(rs, "eingeloest_am"));
    }

    private static Einloesung einloesung(ResultSet rs, int n) throws SQLException {
        return new Einloesung(rs.getObject("id", UUID.class), rs.getObject("code_id", UUID.class),
                rs.getObject("freigabe_id", UUID.class), rs.getString("edge_ref"), rs.getString("fassung"),
                rs.getString("geraete_schluessel"), rs.getString("geraete_schluessel_sha256"),
                rs.getString("wireguard_schluessel"), rs.getString("host_schluessel"),
                rs.getString("tunnel_adresse"), rs.getObject("fenster_id", UUID.class), rs.getBoolean("tausch"),
                instant(rs, "eingeloest_am"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
