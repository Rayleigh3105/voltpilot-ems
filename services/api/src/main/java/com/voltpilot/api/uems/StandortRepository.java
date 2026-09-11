package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Standorte des Kundenbereichs ({@code standort}, Migration V20260911100000)
 * — unter RLS: ein fremder Standort ist hier schlicht nicht da, die Route macht
 * daraus 404, nie 403 (AP-02 A14).
 *
 * <p>Nur der Unterbau. Die Regeln des Anlegens — Kurzzeichen-Vergabe ST-1 …,
 * Eindeutigkeit mit Verweis, Protokolleintrag — gehören den Schreibrouten
 * (IP-4), das Lesen zum Stichtag dem Read-Model (IP-3). Die Datenbank hält
 * die Invarianten trotzdem selbst (Vokabulare, Namensregel, Kurzzeichen
 * eindeutig je Kundenbereich). Ein Standort wird archiviert, nie gelöscht:
 * deshalb gibt es hier kein DELETE, und die App-Rolle hat keines.
 */
@Repository
public class StandortRepository {

    private static final String SPALTEN = "id, unternehmen_id, name, kurzzeichen, strasse, plz, "
            + "ort, land, zeitzone, nutzung, notiz, lage_breitengrad, lage_laengengrad, zustand, "
            + "archiviert_am, created_at";

    private final JdbcTemplate jdbc;

    public StandortRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Ein neuer Standort, alle Werte so, wie sie gespeichert werden: Nutzung,
     * Land, Zeitzone und Zustand als CODES ({@code buero}, {@code DE},
     * {@code Europe/Berlin}, {@code aktiv}), nie als Kundenwort.
     */
    public record NeuerStandort(UUID tenantId, UUID unternehmenId, String name, String kurzzeichen,
            String strasse, String plz, String ort, String land, String zeitzone,
            List<String> nutzung, String notiz, BigDecimal lageBreitengrad,
            BigDecimal lageLaengengrad, String zustand, String createdBy) {}

    /**
     * {@code nutzung} ist {@code null}, wenn nichts gewählt ist; die erste ist die
     * Hauptnutzung. {@code createdAt} ist der Zeitpunkt des Anlegens — zusammen
     * mit {@code archiviertAm} das Bestehen des Standorts (er hat kein eigenes
     * Intervall, V20260911110000); das Lesemodell leitet daraus die Tage ab.
     */
    public record Standort(UUID id, UUID unternehmenId, String name, String kurzzeichen,
            String strasse, String plz, String ort, String land, String zeitzone,
            List<String> nutzung, String notiz, BigDecimal lageBreitengrad,
            BigDecimal lageLaengengrad, String zustand, Instant archiviertAm, Instant createdAt) {}

    public UUID anlegen(NeuerStandort s) {
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement("INSERT INTO standort (tenant_id, "
                    + "unternehmen_id, name, kurzzeichen, strasse, plz, ort, land, zeitzone, "
                    + "nutzung, notiz, lage_breitengrad, lage_laengengrad, zustand, created_by) "
                    + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id");
            ps.setObject(1, s.tenantId());
            ps.setObject(2, s.unternehmenId());
            ps.setString(3, s.name());
            ps.setString(4, s.kurzzeichen());
            ps.setString(5, s.strasse());
            ps.setString(6, s.plz());
            ps.setString(7, s.ort());
            ps.setString(8, s.land());
            ps.setString(9, s.zeitzone());
            if (s.nutzung() == null) {
                ps.setNull(10, Types.ARRAY);
            } else {
                ps.setArray(10, con.createArrayOf("text", s.nutzung().toArray(String[]::new)));
            }
            ps.setString(11, s.notiz());
            ps.setBigDecimal(12, s.lageBreitengrad());
            ps.setBigDecimal(13, s.lageLaengengrad());
            ps.setString(14, s.zustand());
            ps.setString(15, s.createdBy());
            return ps;
        }, rs -> {
            rs.next();
            return rs.getObject(1, UUID.class);
        });
    }

    /** Der Standort im Zaun — leer, wenn es ihn nicht gibt ODER er einem anderen Mandanten gehört. */
    public Optional<Standort> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM standort WHERE id = ?",
                StandortRepository::map, id).stream().findFirst();
    }

    /** Alle Standorte des Mandanten, archivierte eingeschlossen, in der Reihenfolge des Anlegens. */
    public List<Standort> alle() {
        return List.copyOf(jdbc.query(
                "SELECT " + SPALTEN + " FROM standort ORDER BY created_at, id",
                StandortRepository::map));
    }

    private static Standort map(ResultSet rs, int n) throws SQLException {
        Array nutzung = rs.getArray("nutzung");
        Timestamp archiviert = rs.getTimestamp("archiviert_am");
        return new Standort(
                rs.getObject("id", UUID.class),
                rs.getObject("unternehmen_id", UUID.class),
                rs.getString("name"),
                rs.getString("kurzzeichen"),
                rs.getString("strasse"),
                rs.getString("plz"),
                rs.getString("ort"),
                rs.getString("land"),
                rs.getString("zeitzone"),
                nutzung == null ? null : List.of((String[]) nutzung.getArray()),
                rs.getString("notiz"),
                rs.getBigDecimal("lage_breitengrad"),
                rs.getBigDecimal("lage_laengengrad"),
                rs.getString("zustand"),
                archiviert == null ? null : archiviert.toInstant(),
                rs.getTimestamp("created_at").toInstant());
    }
}
