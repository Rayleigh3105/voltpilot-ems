package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Kostenstelle, Prozess und Messstelle → Prozess (UEMS AP-10 IP-7, {@code V20260913160000}). Jede
 * Abfrage läuft unter RLS: ein fremdes Objekt ist nicht da.
 */
@Repository
public class KostenstelleProzessRepository {

    /** Die zwei Objekt-Tabellen — Kostenstelle flach, Prozess mit höchstens einem Elternteil. */
    public enum Art {
        KOSTENSTELLE("kostenstelle"),
        PROZESS("prozess");

        private final String tabelle;

        Art(String tabelle) {
            this.tabelle = tabelle;
        }

        public String tabelle() {
            return tabelle;
        }
    }

    /** Eine Kostenstelle oder ein Prozess; {@code elternId}/{@code elternKennzeichen} nur beim Prozess. */
    public record Objekt(UUID id, String kennzeichen, String name, UUID elternId, String elternKennzeichen,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant angelegtAm) {

        /** Besteht das Objekt an JEDEM Tag von {@code ab} bis {@code bis} ({@code null} = offen)? */
        public boolean deckt(LocalDate ab, LocalDate bis) {
            boolean anfang = !ab.isBefore(gueltigAb);
            boolean ende = gueltigBis == null || (bis != null && !bis.isAfter(gueltigBis));
            return anfang && ende;
        }
    }

    /** Ein wirksames Intervall Messstelle → Prozess, mit dem Prozess, wie er heute steht. */
    public record Zuordnung(UUID id, UUID prozessId, String prozessKennzeichen, String prozessName,
            LocalDate prozessBis, LocalDate gueltigAb, LocalDate gueltigBis) {}

    /** Eine Zuordnung, die über die geplanten Tage eines Ziels hinaus gälte ({@code uems_zuordnungen_ausserhalb}). */
    public record Ausserhalb(String tabelle, UUID zeileId, String kennzeichen, LocalDate gueltigAb, LocalDate gueltigBis) {}

    private final JdbcTemplate jdbc;

    public KostenstelleProzessRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final RowMapper<Objekt> OBJEKT = (rs, n) -> new Objekt(
            rs.getObject("id", UUID.class),
            rs.getString("kennzeichen"),
            rs.getString("name"),
            rs.getObject("eltern_id", UUID.class),
            rs.getString("eltern_kennzeichen"),
            rs.getObject("gueltig_ab", LocalDate.class),
            rs.getObject("gueltig_bis", LocalDate.class),
            instant(rs, "created_at"));

    private static String spalten(Art art) {
        return art == Art.PROZESS
                ? "SELECT o.id, o.kennzeichen, o.name, o.eltern_id, e.kennzeichen AS eltern_kennzeichen, o.gueltig_ab, "
                        + "o.gueltig_bis, o.created_at FROM prozess o "
                        + "LEFT JOIN prozess e ON e.id = o.eltern_id AND e.tenant_id = o.tenant_id "
                : "SELECT o.id, o.kennzeichen, o.name, NULL::uuid AS eltern_id, NULL::text AS eltern_kennzeichen, "
                        + "o.gueltig_ab, o.gueltig_bis, o.created_at FROM kostenstelle o ";
    }

    /** Alle Objekte der Art, beendete eingeschlossen, nach Kennzeichen. */
    public List<Objekt> alle(Art art) {
        return jdbc.query(spalten(art) + "ORDER BY o.kennzeichen, o.id", OBJEKT);
    }

    public Optional<Objekt> finde(Art art, UUID id) {
        return jdbc.query(spalten(art) + "WHERE o.id = ?", OBJEKT, id).stream().findFirst();
    }

    public boolean kennzeichenBelegt(Art art, String kennzeichen) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM " + art.tabelle() + " WHERE kennzeichen = ?)", Boolean.class, kennzeichen));
    }

    public UUID anlegen(Art art, UUID tenant, UUID unternehmen, String kennzeichen, String name, UUID eltern,
            LocalDate ab, LocalDate bis, String wer) {
        if (art == Art.PROZESS) {
            return jdbc.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, eltern_id, "
                    + "gueltig_ab, gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?,?) RETURNING id", UUID.class,
                    tenant, unternehmen, kennzeichen, name, eltern, ab, bis, wer);
        }
        return jdbc.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "gueltig_bis, created_by) VALUES (?,?,?,?,?,?,?) RETURNING id", UUID.class,
                tenant, unternehmen, kennzeichen, name, ab, bis, wer);
    }

    public void umbenennen(Art art, UUID id, String name) {
        jdbc.update("UPDATE " + art.tabelle() + " SET name = ?, updated_at = now() WHERE id = ?", name, id);
    }

    public void beenden(Art art, UUID id, LocalDate bis) {
        jdbc.update("UPDATE " + art.tabelle() + " SET gueltig_bis = ?, updated_at = now() WHERE id = ?", bis, id);
    }

    /**
     * Was über die Tage [ab, bis] des Ziels hinaus gälte — dieselbe Funktion, die der Trigger am Ziel
     * fragt. Das Kennzeichen nennt, WAS dort hängt: bei einer Messstellen-Zuordnung die Messstelle, bei
     * einem Unterprozess der Unterprozess; bei einer Tabelle, die erst ein späteres Paket anhängt, keins.
     */
    public List<Ausserhalb> ausserhalb(Art art, UUID tenant, UUID id, LocalDate ab, LocalDate bis) {
        return jdbc.query("SELECT a.tabelle, a.zeile_id, a.gueltig_ab, a.gueltig_bis, "
                + "CASE a.tabelle "
                + "  WHEN 'messstelle_prozess' THEN (SELECT m.kennzeichen FROM messstelle_prozess z "
                + "       JOIN messstelle m ON m.id = z.messstelle_id AND m.tenant_id = z.tenant_id WHERE z.id = a.zeile_id) "
                + "  WHEN 'prozess' THEN (SELECT p.kennzeichen FROM prozess p WHERE p.id = a.zeile_id) "
                + "END AS kennzeichen "
                + "FROM uems_zuordnungen_ausserhalb(?, ?, ?, ?, ?) a",
                (rs, n) -> new Ausserhalb(rs.getString("tabelle"), rs.getObject("zeile_id", UUID.class),
                        rs.getString("kennzeichen"), rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class)),
                art.tabelle(), tenant, id, ab, bis);
    }

    // ------------------------------------------------------------- Messstelle → Prozess

    /** Die wirksamen (nicht aufgehobenen) Intervalle einer Messstelle, nach Beginn und Kennzeichen. */
    public List<Zuordnung> zuordnungen(UUID messstelle) {
        return jdbc.query("SELECT z.id, z.prozess_id, p.kennzeichen, p.name, p.gueltig_bis AS prozess_bis, z.gueltig_ab, "
                + "z.gueltig_bis FROM messstelle_prozess z JOIN prozess p ON p.id = z.prozess_id AND p.tenant_id = z.tenant_id "
                + "WHERE z.messstelle_id = ? AND z.aufgehoben_am IS NULL ORDER BY z.gueltig_ab, p.kennzeichen, z.id",
                (rs, n) -> new Zuordnung(rs.getObject("id", UUID.class), rs.getObject("prozess_id", UUID.class),
                        rs.getString("kennzeichen"), rs.getString("name"),
                        rs.getObject("prozess_bis", LocalDate.class), rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class)),
                messstelle);
    }

    public void zuordnungAufheben(UUID id, Instant jetzt) {
        jdbc.update("UPDATE messstelle_prozess SET aufgehoben_am = ? WHERE id = ?", Timestamp.from(jetzt), id);
    }

    public void zuordnungBeenden(UUID id, LocalDate bis) {
        jdbc.update("UPDATE messstelle_prozess SET gueltig_bis = ? WHERE id = ?", bis, id);
    }

    public void zuordnungEintragen(UUID tenant, UUID messstelle, UUID prozess, LocalDate ab, LocalDate bis, String wer) {
        jdbc.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab, gueltig_bis, "
                + "created_by) VALUES (?,?,?,?,?,?)", tenant, messstelle, prozess, ab, bis, wer);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
