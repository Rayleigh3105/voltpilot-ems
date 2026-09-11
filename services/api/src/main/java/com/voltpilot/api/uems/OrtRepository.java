package com.voltpilot.api.uems;

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
 * Die Gebäude und Bereiche des Kundenbereichs ({@code ort}, Migration
 * V20260911110000) — unter RLS: ein fremder Ort ist hier schlicht nicht da, die
 * Route macht daraus 404, nie 403 (AP-02 A14).
 *
 * <p>Nur der Unterbau. Woran ein Ort hängt, steht je Tag in
 * {@link OrtZuordnungRepository}; die Regeln des Anlegens — Kurzzeichen-Vergabe
 * G-1 … / B-1 …, Name eindeutig je Elternknoten, Protokolleintrag — gehören den
 * Schreibrouten (IP-5). Die Datenbank hält trotzdem, was eine Zeile allein
 * entscheidet (Art, Vokabular, Namensregel, Kurzzeichen eindeutig je
 * Kundenbereich, Baujahr nur am Gebäude). Ein Ort wird archiviert, nie
 * gelöscht, und seine Art ändert sich nie: deshalb gibt es hier weder DELETE
 * noch ein Umschreiben der Art. Die Schreibroute ist {@link OrtService}.
 */
@Repository
public class OrtRepository {

    private static final String SPALTEN =
            "id, art, name, kurzzeichen, nutzung, baujahr, notiz, zustand, archiviert_am";

    private final JdbcTemplate jdbc;

    public OrtRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Ein neuer Ort, alle Werte so, wie sie gespeichert werden: Art, Nutzung und
     * Zustand als CODES ({@code gebaeude}, {@code buero}, {@code aktiv}), nie als
     * Kundenwort; {@code baujahr} nur am Gebäude.
     */
    public record NeuerOrt(UUID tenantId, String art, String name, String kurzzeichen,
            List<String> nutzung, Integer baujahr, String notiz, String zustand,
            String createdBy) {}

    /** {@code nutzung} ist {@code null}, wenn nichts gewählt ist; die erste ist die Hauptnutzung. */
    public record Ort(UUID id, String art, String name, String kurzzeichen, List<String> nutzung,
            Integer baujahr, String notiz, String zustand, Instant archiviertAm) {}

    public UUID anlegen(NeuerOrt o) {
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement("INSERT INTO ort (tenant_id, art, name, "
                    + "kurzzeichen, nutzung, baujahr, notiz, zustand, created_by) "
                    + "VALUES (?,?,?,?,?,?,?,?,?) RETURNING id");
            ps.setObject(1, o.tenantId());
            ps.setString(2, o.art());
            ps.setString(3, o.name());
            ps.setString(4, o.kurzzeichen());
            if (o.nutzung() == null) {
                ps.setNull(5, Types.ARRAY);
            } else {
                ps.setArray(5, con.createArrayOf("text", o.nutzung().toArray(String[]::new)));
            }
            ps.setObject(6, o.baujahr(), Types.INTEGER);
            ps.setString(7, o.notiz());
            ps.setString(8, o.zustand());
            ps.setString(9, o.createdBy());
            return ps;
        }, rs -> {
            rs.next();
            return rs.getObject(1, UUID.class);
        });
    }

    /**
     * Archiviert zum Zeitpunkt {@code am} — der Weg, auf dem ein leeres Kind mit
     * seinem Standort archiviert wird (E12); {@code false}: schon archiviert oder
     * nicht da. Seine Intervalle beendet der Schreibweg ({@link OrtZuordnungRepository}).
     */
    public boolean archivieren(UUID id, Instant am, String von) {
        return jdbc.update("UPDATE ort SET zustand = 'archiviert', archiviert_am = ?, "
                + "archiviert_von = ? WHERE id = ? AND archiviert_am IS NULL",
                Timestamp.from(am), von, id) == 1;
    }

    /** Der Ort im Zaun — leer, wenn es ihn nicht gibt ODER er einem anderen Mandanten gehört. */
    public Optional<Ort> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM ort WHERE id = ?", OrtRepository::map, id)
                .stream().findFirst();
    }

    /** Alle Orte des Mandanten, archivierte eingeschlossen, in der Reihenfolge des Anlegens. */
    public List<Ort> alle() {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM ort ORDER BY created_at, id",
                OrtRepository::map));
    }

    /**
     * Schreibt die einfachen Felder (§4.3: ohne Gültigkeit) — nie an einem archivierten
     * Ort; {@code false}, wenn es ihn (im Zaun) nicht gibt oder er archiviert ist.
     */
    public boolean bearbeiten(UUID id, String name, String kurzzeichen, List<String> nutzung,
            Integer baujahr, String notiz) {
        return jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement("UPDATE ort SET name = ?, kurzzeichen = ?, "
                    + "nutzung = ?, baujahr = ?, notiz = ? WHERE id = ? AND archiviert_am IS NULL");
            ps.setString(1, name);
            ps.setString(2, kurzzeichen);
            if (nutzung == null) {
                ps.setNull(3, Types.ARRAY);
            } else {
                ps.setArray(3, con.createArrayOf("text", nutzung.toArray(String[]::new)));
            }
            ps.setObject(4, baujahr, Types.INTEGER);
            ps.setString(5, notiz);
            ps.setObject(6, id);
            return ps;
        }) == 1;
    }

    private static Ort map(ResultSet rs, int n) throws SQLException {
        Array nutzung = rs.getArray("nutzung");
        Timestamp archiviert = rs.getTimestamp("archiviert_am");
        return new Ort(
                rs.getObject("id", UUID.class),
                rs.getString("art"),
                rs.getString("name"),
                rs.getString("kurzzeichen"),
                nutzung == null ? null : List.of((String[]) nutzung.getArray()),
                rs.getObject("baujahr", Integer.class),
                rs.getString("notiz"),
                rs.getString("zustand"),
                archiviert == null ? null : archiviert.toInstant());
    }
}
