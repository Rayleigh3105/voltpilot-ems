package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
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

    /** Ein gespeicherter Term, in seiner Reihenfolge. */
    public record TermZeile(UUID id, int position, String eingangArt, UUID entityId, String pointKey,
            UUID quellMessstelleId, String vorzeichen, double faktor) {}

    /** Ob eine Formel Terme hat und ob JEDER Term-Eingang eingerichtet ist (fehlt: eingaenge). */
    public record FormelStand(boolean vorhanden, boolean eingerichtet) {}

    public List<TermZeile> derMessstelle(UUID messstelleId) {
        return jdbc.query("SELECT id, position, eingang_art, entity_id, point_key, quell_messstelle_id, "
                + "vorzeichen, faktor FROM messstelle_formel_term WHERE messstelle_id = ? ORDER BY position",
                (rs, n) -> new TermZeile(rs.getObject("id", UUID.class), rs.getInt("position"),
                        rs.getString("eingang_art"), rs.getObject("entity_id", UUID.class),
                        rs.getString("point_key"), rs.getObject("quell_messstelle_id", UUID.class),
                        rs.getString("vorzeichen"), rs.getDouble("faktor")),
                messstelleId);
    }

    /** Legt einen Term an; {@code tenant_id} aus dem {@link TenantContext} (die Policy prüft ihn). */
    public void anlegen(UUID messstelleId, int position, String eingangArt, UUID entityId,
            String pointKey, UUID quellMessstelleId, String vorzeichen, double faktor) {
        jdbc.update("INSERT INTO messstelle_formel_term (tenant_id, messstelle_id, position, "
                + "eingang_art, entity_id, point_key, quell_messstelle_id, vorzeichen, faktor) "
                + "VALUES (?,?,?,?,?,?,?,?,?)",
                TenantContext.get(), messstelleId, position, eingangArt, entityId, pointKey,
                quellMessstelleId, vorzeichen, faktor);
    }

    /**
     * Der Stand der Formel für den Lebenszyklus: {@code vorhanden} = mindestens ein Term;
     * {@code eingerichtet} = jeder Term-Eingang ist noch da — ein Messkanal-Term über eine
     * bekannte Mess-Selektion der Komponente ({@code device_measurement_selection}), ein
     * messstelle-Term über eine noch nicht archivierte Quell-Messstelle. Sonst {@code fehlt:
     * eingaenge} (§2.2 „Komponente/Kanal nicht mehr da"). Alles RLS-scoped.
     */
    public FormelStand stand(UUID messstelleId) {
        Integer gesamt = jdbc.queryForObject(
                "SELECT count(*) FROM messstelle_formel_term WHERE messstelle_id = ?",
                Integer.class, messstelleId);
        if (gesamt == null || gesamt == 0) {
            return new FormelStand(false, false);
        }
        // Terme, deren Eingang NICHT mehr auflösbar ist.
        Integer unaufloesbar = jdbc.queryForObject("""
                SELECT count(*) FROM messstelle_formel_term t
                 WHERE t.messstelle_id = ?
                   AND (
                     (t.eingang_art = 'messkanal' AND NOT EXISTS (
                        SELECT 1 FROM device_measurement_selection s
                         WHERE s.entity_id = t.entity_id AND s.point_key = t.point_key))
                     OR (t.eingang_art = 'messstelle' AND NOT EXISTS (
                        SELECT 1 FROM messstelle q
                         WHERE q.id = t.quell_messstelle_id AND q.archiviert_am IS NULL))
                   )
                """, Integer.class, messstelleId);
        return new FormelStand(true, unaufloesbar == null || unaufloesbar == 0);
    }
}
