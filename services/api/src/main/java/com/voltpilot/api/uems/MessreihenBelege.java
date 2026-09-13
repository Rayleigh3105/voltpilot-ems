package com.voltpilot.api.uems;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Welche Messstellen hängen an den Messwerten einer Anlage oder einer Box? (UEMS AP-07 E8, IP-11)
 *
 * <p>Eine Messreihe (Mandant + Komponente + Kanal, E2) ist ein <b>Beleg</b>, sobald sie JE an eine
 * Messstelle gebunden war — laufende oder beendete Quellenbindung, das Protokoll
 * {@code quelle_gebunden} (es überlebt die Bindungs-Zeile, wenn deren Komponente per Kaskade ging)
 * oder ein Messkanal-Term einer berechneten Messstelle. Die Regel steht EINMAL, in der
 * Datenbank-Funktion {@code uems_messreihen_belege} (V20260913150000); dieselbe Funktion sperrt
 * {@code uems_messwerte_der_anlage_entfernen} für jede Rolle.
 *
 * <p>Die Antwort ist die LISTE der Messstellen, nie ein Ja/Nein: eine Ablehnung ohne Liste ist eine
 * Sackgasse. Unter RLS: es zählen nur die Messstellen des eigenen Kundenbereichs.
 */
@Repository
public class MessreihenBelege {

    /** Eine Messstelle, deren Werte im Weg stehen. */
    public record Beleg(UUID id, String kennzeichen, String name) {
    }

    private static final String ABFRAGE =
            "SELECT id, kennzeichen, name FROM uems_messreihen_belege(?::uuid, ?::uuid)";

    private final JdbcTemplate jdbc;

    public MessreihenBelege(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Messstellen, deren Belege an der Anlage hängen — leer: die Anlage trägt keinen Beleg. */
    public List<Beleg> derAnlage(UUID siteId) {
        return jdbc.query(ABFRAGE, MessreihenBelege::beleg, siteId, null);
    }

    /** Die Messstellen, deren Belege die Box gelesen hat — leer: die Box trägt keinen Beleg. */
    public List<Beleg> derBox(UUID deviceId) {
        return jdbc.query(ABFRAGE, MessreihenBelege::beleg, null, deviceId);
    }

    private static Beleg beleg(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Beleg(rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getString("name"));
    }
}
