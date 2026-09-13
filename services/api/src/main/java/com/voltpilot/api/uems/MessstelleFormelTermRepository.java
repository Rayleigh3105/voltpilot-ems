package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Terme einer berechneten Messstelle ({@code messstelle_formel_term}, UEMS AP-10). Nur die
 * DEFINITION — der Wert wird in {@link MessstelleFormelService} gerechnet. Der Mandant ist die RLS
 * (die App-Rolle sieht nur die eigenen Zeilen); der {@code tenant_id} beim Schreiben kommt aus dem
 * {@link TenantContext}, damit die Policy greift.
 */
@Repository
public class MessstelleFormelTermRepository {

    private final JdbcTemplate jdbc;

    public MessstelleFormelTermRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Ein gespeicherter Term, in seiner Reihenfolge. {@code verteilungZiel} und {@code anteil} kamen
     * mit AP-10 IP-5 (V20260913143000): {@code anteil == null} ist die Vorgabe {@code gesamt}.
     */
    public record TermZeile(UUID id, int position, String eingangArt, UUID entityId, String pointKey,
            UUID quellMessstelleId, String vorzeichen, double faktor, UUID verteilungZiel, String anteil) {}

    /** Ob eine Formel Terme hat und ob JEDER Term-Eingang eingerichtet ist (fehlt: eingaenge). */
    public record FormelStand(boolean vorhanden, boolean eingerichtet) {}

    /** Alle Terme der Messstelle über ALLE ihre Fassungen, nach Fassung und Reihenfolge. */
    public List<TermZeile> derMessstelle(UUID messstelleId) {
        return jdbc.query("SELECT t.id, t.position, t.eingang_art, t.entity_id, t.point_key, "
                + "t.quell_messstelle_id, t.vorzeichen, t.faktor, t.verteilung_ziel, t.anteil "
                + "FROM messstelle_formel_term t "
                + "JOIN messstelle_formel_fassung f ON f.id = t.fassung_id "
                + "WHERE t.messstelle_id = ? ORDER BY f.nummer, t.position",
                TERM, messstelleId);
    }

    /** Die Terme EINER Fassung in Reihenfolge — die Formel eines Tages (AP-10 IP-3). */
    public List<TermZeile> derFassung(UUID fassungId) {
        return jdbc.query("SELECT id, position, eingang_art, entity_id, point_key, quell_messstelle_id, "
                + "vorzeichen, faktor, verteilung_ziel, anteil FROM messstelle_formel_term "
                + "WHERE fassung_id = ? ORDER BY position",
                TERM, fassungId);
    }

    private static final org.springframework.jdbc.core.RowMapper<TermZeile> TERM =
            (rs, n) -> new TermZeile(rs.getObject("id", UUID.class), rs.getInt("position"),
                    rs.getString("eingang_art"), rs.getObject("entity_id", UUID.class),
                    rs.getString("point_key"), rs.getObject("quell_messstelle_id", UUID.class),
                    rs.getString("vorzeichen"), rs.getDouble("faktor"),
                    rs.getObject("verteilung_ziel", UUID.class), rs.getString("anteil"));

    /** Legt einen Term in seiner Fassung an; {@code tenant_id} aus dem {@link TenantContext}. */
    public void anlegen(UUID fassungId, UUID messstelleId, int position, String eingangArt, UUID entityId,
            String pointKey, UUID quellMessstelleId, String vorzeichen, double faktor) {
        anlegen(fassungId, messstelleId, position, eingangArt, entityId, pointKey, quellMessstelleId, vorzeichen,
                faktor, null, null);
    }

    /**
     * Legt einen Term mit Verteilungs-Ziel und Anteil an (AP-10 IP-5); {@code anteil == null} ist
     * {@code gesamt}. Welcher Anteil lesbar ist und darum gespeichert werden darf, entscheidet vorher
     * {@link AnteilLeseweg} — hier wird nur geschrieben.
     */
    public void anlegen(UUID fassungId, UUID messstelleId, int position, String eingangArt, UUID entityId,
            String pointKey, UUID quellMessstelleId, String vorzeichen, double faktor, UUID verteilungZiel,
            String anteil) {
        jdbc.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, fassung_id, position, "
                + "eingang_art, entity_id, point_key, quell_messstelle_id, vorzeichen, faktor, verteilung_ziel, "
                + "anteil) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                TenantContext.get(), messstelleId, fassungId, position, eingangArt, entityId, pointKey,
                quellMessstelleId, vorzeichen, faktor, verteilungZiel, anteil);
    }

    /**
     * Legt einen Term OHNE Fassung an (der Schreibweg von PR #688): die Datenbank legt ihn in die
     * EINZIGE Fassung der Messstelle, gibt es keine, entsteht Fassung 1 ohne ersten Tag
     * (Trigger {@code messstelle_formel_term_zu_fassung}, V20260912210000). Hat die Messstelle
     * mehrere Fassungen, lehnt sie ab — dann {@link #anlegen(UUID, UUID, int, String, UUID, String,
     * UUID, String, double)}.
     */
    public void anlegen(UUID messstelleId, int position, String eingangArt, UUID entityId,
            String pointKey, UUID quellMessstelleId, String vorzeichen, double faktor) {
        anlegen(null, messstelleId, position, eingangArt, entityId, pointKey, quellMessstelleId, vorzeichen,
                faktor);
    }

    /**
     * Der Stand der Formel AN DEM TAG für den Lebenszyklus — gezählt werden nur die Terme der
     * Fassung, die an dem Tag gilt (AP-10 IP-3): {@code vorhanden} = mindestens ein Term;
     * {@code eingerichtet} = jeder Term-Eingang ist noch da — ein Messkanal-Term über eine
     * bekannte Mess-Selektion der Komponente ({@code device_measurement_selection}), ein
     * messstelle- oder verteilung-Term über eine noch nicht archivierte Quell-Messstelle. Sonst {@code fehlt:
     * eingaenge} (§2.2 „Komponente/Kanal nicht mehr da"). Alles RLS-scoped.
     */
    public FormelStand stand(UUID messstelleId, LocalDate tag) {
        Integer gesamt = jdbc.queryForObject(
                "SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ? AND " + FASSUNG_AM,
                Integer.class, messstelleId, tag, tag);
        if (gesamt == null || gesamt == 0) {
            return new FormelStand(false, false);
        }
        // Terme, deren Eingang NICHT mehr auflösbar ist.
        Integer unaufloesbar = jdbc.queryForObject("""
                SELECT count(*) FROM messstelle_formel_term t
                 WHERE t.messstelle_id = ?
                """ + " AND t." + FASSUNG_AM + """
                   AND (
                     (t.eingang_art = 'messkanal' AND NOT EXISTS (
                        SELECT 1 FROM device_measurement_selection s
                         WHERE s.entity_id = t.entity_id AND s.point_key = t.point_key))
                     OR (t.eingang_art IN ('messstelle', 'verteilung') AND NOT EXISTS (
                        SELECT 1 FROM messstelle q
                         WHERE q.id = t.quell_messstelle_id AND q.archiviert_am IS NULL))
                   )
                """, Integer.class, messstelleId, tag, tag);
        return new FormelStand(true, unaufloesbar == null || unaufloesbar == 0);
    }

    /** Der Term gehört zur Fassung, die an dem Tag gilt (zwei Parameter: der Tag, zweimal). */
    private static final String FASSUNG_AM = "fassung_id IN (SELECT f.id FROM messstelle_formel_fassung f "
            + "WHERE f.aufgehoben_am IS NULL AND (f.gueltig_ab IS NULL OR f.gueltig_ab <= ?) "
            + "AND (f.gueltig_bis IS NULL OR f.gueltig_bis >= ?))";
}
