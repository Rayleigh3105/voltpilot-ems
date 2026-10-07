package com.voltpilot.api.uems;

import java.util.HashMap;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Konzept Nachweisen n1, Befund 4: wer etwas eingetragen oder entschieden hat, heißt wie die Person im Kundenbereich
 * ({@code benutzer.anzeigename}, „Ines Kaltenbach“), nicht wie ihr Anmeldename („ines“), den ältere Einträge gespeichert
 * haben. Ein freigegebener Stand oder eine Fassung wird dafür nie geändert; aufgelöst wird beim Lesen über die Kennung
 * der Person.
 *
 * <p>Keine Quelle von Einträgen: das Verzeichnis liest seine Zeilen weiter über die Dienste mit ihrem Zaun und fragt
 * hier nur nach dem Namen zu einer Kennung, die eine sichtbare Zeile schon trägt. Gelesen mit RLS des Aufrufers.
 */
@Component
public class PersonenNamen {

    private final JdbcTemplate jdbc;

    public PersonenNamen(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Kennung (Subject) → Name der Person im Kundenbereich; Personen ohne Namen fehlen. */
    public Map<String, String> jeKennung() {
        Map<String, String> aus = new HashMap<>();
        jdbc.query("SELECT sub, btrim(anzeigename) AS name FROM benutzer WHERE nullif(btrim(anzeigename), '') IS NOT NULL",
                rs -> {
                    aus.put(rs.getString("sub"), rs.getString("name"));
                });
        return aus;
    }

    /** Wer eine Kennzahl-Fassung eingetragen hat: {@code <kennzahl_id>/<nummer>} → Kennung. */
    public Map<String, String> kennzahlFassungen() {
        Map<String, String> aus = new HashMap<>();
        jdbc.query("SELECT kennzahl_id, nummer, actor_sub FROM kennzahl_fassung", rs -> {
            aus.put(rs.getString("kennzahl_id") + "/" + rs.getInt("nummer"), rs.getString("actor_sub"));
        });
        return aus;
    }

    /** Wer eine Bezugsbasis-Fassung freigegeben und entschieden hat: {@code <bezugsbasis_id>/<fassung>} → Kennungen. */
    public Map<String, String[]> bezugsbasisFassungen() {
        Map<String, String[]> aus = new HashMap<>();
        jdbc.query("SELECT bezugsbasis_id, fassung, freigabe_sub, entscheidung_sub FROM bezugsbasis_fassung", rs -> {
            aus.put(rs.getString("bezugsbasis_id") + "/" + rs.getInt("fassung"),
                    new String[] {rs.getString("freigabe_sub"), rs.getString("entscheidung_sub")});
        });
        return aus;
    }

    /** Der Name der Person zu ihrer Kennung, sonst der gespeicherte. */
    public static String name(String sub, String gespeichert, Map<String, String> namen) {
        return sub == null ? gespeichert : namen.getOrDefault(sub, gespeichert);
    }
}
