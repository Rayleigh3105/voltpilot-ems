package com.voltpilot.api.werkstatt;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Aufträge und Ergebnisse des Fernlaufs ({@code werkstatt_fernlauf}, {@code werkstatt_fernlauf_ergebnis}, Migration
 * V20261118200000) an der BYPASSRLS-Rolle {@code voltpilot_admin}, dasselbe Muster wie {@link WerkstattRepository}.
 *
 * <p>Jeder Schreibweg ist eine Anweisung mit seiner Bedingung: Annehmen nur einmal und nur in der Abholfrist,
 * Schritte nur angenommen und ohne Ergebnis, ein Ergebnis je Auftrag ({@code ON CONFLICT DO NOTHING}; die Tabelle
 * nimmt nur Zeilen an).
 */
@Repository
public class FernlaufRepository {

    private static final String SPALTEN = "f.id, f.edge_ref, f.art, f.fassung_vorher, f.fassung_ziel, f.release_seq, "
            + "f.quelle, f.programm_sha256, f.skripte_sha256, f.fenster_id, f.akteur_sub, f.akteur_name, "
            + "f.erteilt_am, f.begonnen_am, f.schritt, f.schritt_seit, "
            + "f.schritte::text AS schritte, f.gemeldet_am, "
            + "LEAST(fe.ende, COALESCE(fe.geschlossen_am, fe.ende)) AS fenster_ende, e.ergebnis, e.grund, "
            + "e.schritt AS e_schritt, e.fassung_nachher, e.belege::text AS belege, e.quelle AS e_quelle, e.erfasst_am ";
    private static final String VON = "FROM werkstatt_fernlauf f "
            + "JOIN fernwartung_fenster fe ON fe.id = f.fenster_id "
            + "LEFT JOIN werkstatt_fernlauf_ergebnis e ON e.fernlauf_id = f.id ";

    /** Das Ergebnis eines Auftrags (eine Zeile, nur angehängt). */
    public record Ergebnis(String ergebnis, String grund, String schritt, String fassungNachher, String belegeJson,
            String quelle, Instant erfasstAm) {
    }

    /**
     * Ein Auftrag mit dem Ende seines Fensters (geschlossen oder abgelaufen, was früher war) und seinem Ergebnis
     * ({@code null}, solange keins geschrieben ist).
     */
    public record Fernlauf(UUID id, String edgeRef, String art, String fassungVorher, String fassungZiel,
            long releaseSeq, String quelle, String programmSha256, String skripteSha256, UUID fensterId,
            String akteurSub, String akteurName, Instant erteiltAm,
            Instant begonnenAm, String schritt, Instant schrittSeit, String schritteJson, Instant gemeldetAm,
            Instant fensterEnde, Ergebnis ergebnis) {

        public String zustand(Instant jetzt) {
            return FernlaufRegel.zustand(erteiltAm, begonnenAm, fensterEnde,
                    ergebnis == null ? null : ergebnis.ergebnis(), jetzt);
        }
    }

    private final JdbcTemplate jdbc;

    public FernlaufRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public void anlegen(UUID id, String edgeRef, String art, String fassungVorher, WerkstattRegel.Soll ziel,
            UUID fensterId, String akteurSub, String akteurName, Instant erteiltAm) {
        jdbc.update("INSERT INTO werkstatt_fernlauf (id, edge_ref, art, fassung_vorher, fassung_ziel, release_seq, "
                        + "quelle, programm_sha256, skripte_sha256, fenster_id, akteur_sub, akteur_name, erteilt_am) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, edgeRef, art, fassungVorher, ziel.edgeLight().fassung(), ziel.releaseSeq(),
                ziel.edgeLight().quelle(), ziel.edgeLight().programmSha256(), ziel.edgeLight().skripteSha256(), fensterId, akteurSub, akteurName,
                Timestamp.from(erteiltAm));
    }

    public Optional<Fernlauf> mitId(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE f.id = ?", FernlaufRepository::zeile, id).stream()
                .findFirst();
    }

    /** Die letzten Aufträge einer Box, neueste zuerst. */
    public List<Fernlauf> letzte(String edgeRef, int limit) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE f.edge_ref = ? ORDER BY f.erteilt_am DESC, f.id LIMIT ?",
                FernlaufRepository::zeile, edgeRef, Math.max(1, Math.min(limit, 50)));
    }

    /** Aufträge, die der Dienst noch annehmen kann: nicht angenommen, in der Abholfrist, ohne Ergebnis. */
    public List<Fernlauf> abholbar(Instant seit) {
        return jdbc.query("SELECT " + SPALTEN + VON + "WHERE f.begonnen_am IS NULL AND f.erteilt_am > ? "
                        + "AND e.fernlauf_id IS NULL ORDER BY f.erteilt_am, f.id",
                FernlaufRepository::zeile, Timestamp.from(seit));
    }

    /** Der Dienst nimmt den Auftrag an: nur einmal, nur in der Abholfrist, nur ohne Ergebnis. */
    public boolean beginnen(UUID id, Instant jetzt, Instant seit) {
        return jdbc.update("UPDATE werkstatt_fernlauf f SET begonnen_am = ?, gemeldet_am = ? WHERE f.id = ? "
                        + "AND f.begonnen_am IS NULL AND f.erteilt_am > ? "
                        + "AND NOT EXISTS (SELECT 1 FROM werkstatt_fernlauf_ergebnis e WHERE e.fernlauf_id = f.id)",
                Timestamp.from(jetzt), Timestamp.from(jetzt), id, Timestamp.from(seit)) == 1;
    }

    /**
     * Ein Schritt: {@code schritt} ist der laufende (oder zuletzt gemeldete) Schritt; {@code eintragJson} ein
     * Element für die Liste {@code schritte} oder {@code null} (nur der Beginn eines Schritts).
     */
    public boolean schritt(UUID id, String schritt, Instant seit, String eintragJson, Instant jetzt) {
        return jdbc.update("UPDATE werkstatt_fernlauf f SET schritt = ?, schritt_seit = ?, gemeldet_am = ?, "
                        + "schritte = CASE WHEN ?::jsonb IS NULL THEN f.schritte "
                        + "ELSE f.schritte || jsonb_build_array(?::jsonb) END "
                        + "WHERE f.id = ? AND f.begonnen_am IS NOT NULL "
                        + "AND NOT EXISTS (SELECT 1 FROM werkstatt_fernlauf_ergebnis e WHERE e.fernlauf_id = f.id)",
                schritt, Timestamp.from(seit), Timestamp.from(jetzt), eintragJson, eintragJson, id) == 1;
    }

    /** Schreibt das Ergebnis, wenn es noch keins gibt; {@code false}: es gab schon eins. */
    public boolean ergebnis(UUID id, String edgeRef, String ergebnis, String grund, String schritt,
            String fassungVorher, String fassungNachher, String belegeJson, String quelle, Instant jetzt) {
        return jdbc.update("INSERT INTO werkstatt_fernlauf_ergebnis (fernlauf_id, edge_ref, ergebnis, grund, schritt, "
                        + "fassung_vorher, fassung_nachher, belege, quelle, erfasst_am) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT (fernlauf_id) DO NOTHING",
                id, edgeRef, ergebnis, grund, schritt, fassungVorher, fassungNachher,
                belegeJson == null ? "{}" : belegeJson, quelle, Timestamp.from(jetzt)) == 1;
    }

    private static Fernlauf zeile(ResultSet rs, int n) throws SQLException {
        Ergebnis e = rs.getString("ergebnis") == null ? null : new Ergebnis(rs.getString("ergebnis"),
                rs.getString("grund"), rs.getString("e_schritt"), rs.getString("fassung_nachher"),
                rs.getString("belege"), rs.getString("e_quelle"), zeit(rs, "erfasst_am"));
        return new Fernlauf(rs.getObject("id", UUID.class), rs.getString("edge_ref"), rs.getString("art"),
                rs.getString("fassung_vorher"), rs.getString("fassung_ziel"), rs.getLong("release_seq"),
                rs.getString("quelle"), rs.getString("programm_sha256"), rs.getString("skripte_sha256"),
                rs.getObject("fenster_id", UUID.class), rs.getString("akteur_sub"), rs.getString("akteur_name"),
                zeit(rs, "erteilt_am"), zeit(rs, "begonnen_am"), rs.getString("schritt"), zeit(rs, "schritt_seit"),
                rs.getString("schritte"), zeit(rs, "gemeldet_am"), zeit(rs, "fenster_ende"), e);
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
